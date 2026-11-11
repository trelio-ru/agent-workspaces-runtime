import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { chunkWorkspaceText } from "./trelio-workspace-text-chunks.mjs";
import { isUtf8 } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { sameLocalPath } from "./trelio-local-path.mjs";
import {
  request, requireToken, ensureBridgeCompatibility, ensureCompanyEncryptionContext,
  readJsonResponse, currentWorkspaceExecutionProfile, resolveCompanyContextMirrorDirectory,
  resolveBridgeDataPlaneRouting, hydrateAgentCompanyEncryptedJson,
  ensurePrivateDirectory, hardenWindowsPrivatePath, resolveWorkspaceBridgeConfigDirectory,
  withEncryptedAcceptedWorkspaceFiles, readAcceptedWorkspaceBlob,
  isProtectedWorkspaceControlPath,
} from "./trelio-workspace.mjs";
import { decryptFileFromCompanyContainer, decryptFileFromCompanyContainerBytes } from "./trelio-company-encryption.mjs";
import { materializeLocalAttachment, LOCAL_ATTACHMENT_MAX_BYTES } from "./trelio-local-attachments.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEAD = /^[0-9a-f]{40,64}$/u;
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

const RUN_FILE_LIMIT = 512 * 1024;
const RUN_FILE_WRITE_LIMIT = 24 * 1024;
const RUN_AUTHORITY_FILES = new Set(["agent-instructions.md", "user-profile.md", "run-checkpoint.json"]);
const relativeRunPath = (value) => typeof value === "string" && value.length > 0
  && Buffer.byteLength(value) <= 512
  && !isProtectedWorkspaceControlPath(value)
  && value.split("/").every(part => part && !part.startsWith(".") && !/[. ]$/u.test(part)
    && !/[\\:<>"|?*\x00-\x1f\x7f]/u.test(part)
    && !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(part))
  && !["agents.md", "claude.md"].includes(value.toLowerCase());

/** Close the local grammar before requesting a native receipt. The server's
 * command placeholder does not grant an OS path, filesystem option or text
 * payload on the wire. All model-facing coordinates are relative to one root
 * selected by the verified own Run. */
export const parseAssistantRunFileCommand = (input) => {
  const invalid = () => fail("ASSISTANT_WORKSPACE_FILE_INPUT_INVALID");
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) invalid();
  const { action, source = "workspace", path: relative, offset = 0, expectedSha256, text } = input;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > RUN_FILE_LIMIT) invalid();
  const allowed = action === "list" ? ["action", "path", "offset"] : action === "read"
    ? ["action", "source", "path", "offset"] : action === "replace"
      ? ["action", "path", "expectedSha256", "text"] : [];
  if (!allowed.length || Object.keys(input).some(key => !allowed.includes(key))) invalid();
  if (source === "authority" ? action !== "read" || !RUN_AUTHORITY_FILES.has(relative)
    : source !== "workspace" || (action !== "list" || relative !== undefined) && !relativeRunPath(relative)) invalid();
  if (action === "replace") {
    if (expectedSha256 !== null && (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(expectedSha256))) invalid();
    if (typeof text !== "string" || !text.isWellFormed() || text.includes("\0")
      || Buffer.byteLength(text) > RUN_FILE_WRITE_LIMIT) invalid();
    return { action, path: relative, expectedSha256, text };
  }
  return { action, ...(action === "read" ? { source } : {}), path: relative, offset };
};

// Every directory entry is checked before following it. realpath also catches
// Windows junctions/reparse redirections. The Run root is selected and held
// by the private host, not by the model or the opened site's filesystem.
const assertRunFileDirectory = async (directory) => {
  const state = await fs.lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink() || !sameLocalPath(await fs.realpath(directory), directory))
    fail("ASSISTANT_WORKSPACE_FILE_UNSAFE");
};
const resolveRunFileParent = async (base, parts, create = false) => {
  await assertRunFileDirectory(base);
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    if (create) {
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    await assertRunFileDirectory(current);
  }
  return current;
};
const sameEntry = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
const readRunText = async (target) => {
  const before = await fs.lstat(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || !sameLocalPath(await fs.realpath(target), target)) fail("ASSISTANT_WORKSPACE_FILE_UNSAFE");
  if (before.size > BigInt(RUN_FILE_LIMIT)) fail("ASSISTANT_WORKSPACE_FILE_LIMIT");
  const handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameEntry(before, opened)) fail("ASSISTANT_WORKSPACE_FILE_CHANGED");
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    if (read !== Number(opened.size) || !sameEntry(opened, await handle.stat({ bigint: true })))
      fail("ASSISTANT_WORKSPACE_FILE_CHANGED");
    const source = bytes.subarray(0, read);
    if (!isUtf8(source) || source.includes(0)) fail("ASSISTANT_WORKSPACE_FILE_NOT_TEXT");
    return { text: source.toString("utf8"), sha256: createHash("sha256").update(source).digest("hex"), state: opened };
  } finally { await handle.close(); }
};
const noSplitSurrogate = (text, at) => at <= 0 || at >= text.length || !(/[\uDC00-\uDFFF]/u.test(text[at]));

/** Run under the existing finish lock and a fresh native lease check. The
 * bytes stay in the private workspace, and ordinary checkpoint/finish remains
 * the only way to persist them into the accepted history. */
export const executeAssistantRunFileCommand = async ({ root, input, assertCurrent }) => {
  const command = parseAssistantRunFileCommand(input);
  await assertCurrent();
  const base = path.join(root, command.source === "authority" ? "context" : "workspace");
  const parts = command.path?.split("/") ?? [];
  if (command.action === "list") {
    const directory = await resolveRunFileParent(base, parts);
    const items = [];
    let visited = 0;
    for await (const entry of await fs.opendir(directory)) {
      if (++visited > 2048) fail("ASSISTANT_WORKSPACE_FILE_LIMIT");
      if (relativeRunPath([...parts, entry.name].join("/")) && (entry.isDirectory() || entry.isFile()))
        items.push({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" });
    }
    items.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    await assertCurrent();
    const end = command.offset + 32;
    return { entries: items.slice(command.offset, end), nextOffset: end < items.length ? end : null };
  }
  const name = parts.pop();
  const directory = await resolveRunFileParent(base, parts, command.action === "replace" && command.expectedSha256 === null);
  const target = path.join(directory, name);
  if (command.action === "read") {
    const { text, sha256 } = await readRunText(target);
    if (command.offset > text.length || !noSplitSurrogate(text, command.offset)) fail("ASSISTANT_WORKSPACE_FILE_INPUT_INVALID");
    let end = Math.min(command.offset + 8000, text.length);
    if (!noSplitSurrogate(text, end)) end--;
    await assertCurrent();
    return { text: text.slice(command.offset, end), sha256, nextOffset: end < text.length ? end : null };
  }

  // Stage beside the private metadata, outside Git's working tree. A killed
  // process cannot accidentally add an uncommitted temporary file to a Run.
  await assertRunFileDirectory(root);
  const temporary = path.join(root, `.trelio-edit-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(command.text, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await assertCurrent();
    await resolveRunFileParent(base, parts);
    let previous = null;
    try { previous = await readRunText(target); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if ((previous?.sha256 ?? null) !== command.expectedSha256) fail("ASSISTANT_WORKSPACE_FILE_CHANGED");
    // Existing destinations use atomic replacement. Creation uses a hard
    // link to the closed temp file so it cannot clobber a newly created name.
    if (previous) {
      if (!sameEntry(previous.state, await fs.lstat(target, { bigint: true }))) fail("ASSISTANT_WORKSPACE_FILE_CHANGED");
      await fs.rename(temporary, target);
    } else {
      try { await fs.link(temporary, target); }
      catch (error) { if (error.code === "EEXIST") fail("ASSISTANT_WORKSPACE_FILE_CHANGED"); throw error; }
    }
    return { sha256: createHash("sha256").update(command.text, "utf8").digest("hex"), state: "draft_updated" };
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
};

export const validateWorkspaceFileLocator = ({ workspaceId, workspaceHead, filePath }) => {
  if (!UUID.test(String(workspaceId)) || !HEAD.test(String(workspaceHead))
    || typeof filePath !== "string" || !filePath || filePath.length > 2048
    || filePath.startsWith("/") || /[\\\x00-\x1f]/u.test(filePath)
    || filePath.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("WORKSPACE_FILE_INVALID_LOCATOR");
  }
  return { workspaceId, workspaceHead, filePath };
};

/** Decode the immutable locator advertised by Workspace search. Both mirror
 * fetch and managed exact-file fetch use this one grammar. Decoding supplies
 * coordinates only: current source ACL, accepted head, encrypted manifest and
 * recipient checks still belong to downloadAcceptedWorkspaceFile. A model can
 * neither choose a URL/local destination nor turn a stale head into a new one. */
export const workspaceFileLocatorFromResultId = (resultId) => {
  if (typeof resultId !== "string" || !resultId.startsWith("workspace-file:")) return null;
  if (resultId.length > 4096) fail("WORKSPACE_FILE_INVALID_LOCATOR");
  const parts = resultId.slice("workspace-file:".length).split(":");
  if (parts.length !== 3) fail("WORKSPACE_FILE_INVALID_LOCATOR");
  let decoded;
  try { decoded = parts.map(value => decodeURIComponent(value)); }
  catch { fail("WORKSPACE_FILE_INVALID_LOCATOR"); }
  const [workspaceId, workspaceHead, filePath] = decoded;
  return validateWorkspaceFileLocator({ workspaceId, workspaceHead, filePath });
};

/** Bound reads before allocating: a hostile/incorrect content-length is not a limit. */
const readBoundedBytes = async (response, maximum, signal) => {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      chunks.push(bytes);
      if (total > maximum) fail("WORKSPACE_FILE_TOO_LARGE");
    }
    return Buffer.concat(chunks);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
};

const openEncryptedFile = async ({ origin, token, companyEncryption, workspaceId, workspaceHead, fileId, kind, maximum, signal }) => {
  const response = await request(origin, token,
    `/api/agent-workspaces/files/${fileId}/encrypted-content`, { signal });
  if (response.headers.get("x-trelio-workspace-id") !== workspaceId
    || response.headers.get("x-trelio-workspace-head") !== workspaceHead) fail("WORKSPACE_OUTDATED");
  const ciphertext = await readBoundedBytes(response, maximum + 2 * 1024 * 1024, signal);
  let opened;
  try {
    opened = await decryptFileFromCompanyContainerBytes({
      bytes: ciphertext,
      scopePrivateKey: companyEncryption.scopePrivateEncryptionKey.privateKey,
      scopePrivateJwk: companyEncryption.scopePrivateEncryptionKey.privateJwk,
      expectedCiphertextSha256: response.headers.get("x-trelio-ciphertext-sha256"),
      maximumPlaintextBytes: maximum,
    });
    const aad = opened.header?.aad;
    if (aad?.companyId !== companyEncryption.runtime.company.id
      || aad?.scopeId !== companyEncryption.runtime.scope.id
      || aad?.scopeEpoch !== companyEncryption.runtime.scope.epoch
      || aad?.entityType !== `agent_workspace_browser_${kind}`
      || aad?.entityId !== fileId || aad?.entityRevision !== 1 || aad?.purpose !== "file") {
      fail("WORKSPACE_FILE_ENCRYPTION_BINDING_INVALID");
    }
    return opened.bytes;
  } catch (error) {
    opened?.bytes.fill(0);
    throw error;
  } finally { ciphertext.fill(0); }
};

/** Names and paths leave this function only on the trusted device. HTTP uses opaque UUIDs. */
export const readEncryptedWorkspaceFileManifest = async (input) => {
  const overview = await readJsonResponse(await request(input.origin, input.token,
    `/api/agent-workspaces/workspaces/${input.workspaceId}`, { signal: input.signal }));
  const projection = overview?.encryption?.browserProjection;
  if (overview?.company?.id !== input.companyEncryption.runtime.company.id) fail("WORKSPACE_FILE_ENCRYPTION_BINDING_INVALID");
  if (overview?.workspace?.acceptedHead && overview.workspace.acceptedHead !== input.workspaceHead) fail("WORKSPACE_OUTDATED");
  if (!projection) {
    // A server-created encrypted initial revision deliberately has no browser
    // projection because it contains only the scaffold and exposes no
    // human-facing files.  The backend distinguishes that legitimate empty
    // state from a damaged/legacy accepted revision.  Trust only the explicit
    // false value: missing or true must remain fail-closed so a protocol drift
    // cannot silently hide accepted Workspace content from local search.
    if (overview?.encryption?.browserProjectionRequired === false) return [];
    const error = new Error("WORKSPACE_BROWSER_PROJECTION_UNAVAILABLE");
    error.code = "WORKSPACE_BROWSER_PROJECTION_UNAVAILABLE";
    // Only an authenticated, explicit requirement permits the caller to read
    // the accepted encrypted bundle instead. A missing/unknown server field
    // remains a protocol failure, never evidence of an empty Workspace.
    error.encryptedBundleReadable = overview?.encryption?.browserProjectionRequired === true
      && overview?.workspace?.acceptedHead === input.workspaceHead;
    throw error;
  }
  if (projection.workspaceHead !== input.workspaceHead) fail("WORKSPACE_OUTDATED");
  if (!UUID.test(String(projection.id)) || !UUID.test(String(projection.manifestFileId))) fail("WORKSPACE_FILE_MANIFEST_INVALID");
  const bytes = await openEncryptedFile({ ...input, fileId: projection.manifestFileId, kind: "manifest", maximum: 16 * 1024 * 1024 });
  try {
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (manifest?.schemaVersion !== 1 || manifest.kind !== "agent-workspace-browser-manifest"
      || manifest.projectionId !== projection.id || manifest.workspaceId !== input.workspaceId
      || manifest.workspaceHead !== input.workspaceHead || !Array.isArray(manifest.files)
      || manifest.files.length !== Number(projection.fileCount)) fail("WORKSPACE_FILE_MANIFEST_INVALID");
    const paths = new Set();
    const ids = new Set();
    for (const file of manifest.files) {
      validateWorkspaceFileLocator({ ...input, filePath: file.path });
      if (!UUID.test(String(file.id)) || ids.has(file.id) || paths.has(file.path)
        || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0
        || typeof file.contentType !== "string" || file.contentType.length > 2048) fail("WORKSPACE_FILE_MANIFEST_INVALID");
      ids.add(file.id); paths.add(file.path);
    }
    return manifest.files;
  } finally { bytes.fill(0); }
};

export const readEncryptedWorkspaceSelectedFile = async (input, file) => {
  if (file.sizeBytes > LOCAL_ATTACHMENT_MAX_BYTES) fail("WORKSPACE_FILE_TOO_LARGE");
  const bytes = await openEncryptedFile({ ...input, fileId: file.id, kind: "file", maximum: Math.min(file.sizeBytes, LOCAL_ATTACHMENT_MAX_BYTES) });
  if (bytes.length !== file.sizeBytes) { bytes.fill(0); fail("WORKSPACE_FILE_SIZE_MISMATCH"); }
  return bytes;
};

/** Stream authenticated bytes into bounded index pieces without writing plaintext. */
export const readEncryptedWorkspaceSearchChunks = async (input, file) => {
  const config = currentWorkspaceExecutionProfile()?.kind === "digital_assistant"
    ? resolveCompanyContextMirrorDirectory() : resolveWorkspaceBridgeConfigDirectory();
  await ensurePrivateDirectory(config);
  const root = path.join(config, "search-staging");
  await ensurePrivateDirectory(root);
  const directory = await fs.mkdtemp(path.join(root, "index-"));
  await ensurePrivateDirectory(directory);
  const sourcePath = path.join(directory, "container");
  let handle;
  try {
    const response = await request(input.origin, input.token,
      `/api/agent-workspaces/files/${file.id}/encrypted-content`, { signal: input.signal });
    if (response.headers.get("x-trelio-workspace-id") !== input.workspaceId
      || response.headers.get("x-trelio-workspace-head") !== input.workspaceHead) {
      await response.body?.cancel();
      fail("WORKSPACE_OUTDATED");
    }
    handle = await fs.open(sourcePath, "wx", 0o600);
    if (process.platform === "win32") await hardenWindowsPrivatePath(sourcePath, "file");
    let size = 0;
    // Bound by the exact manifest file, allowing only framing/tag overhead.
    const maximum = file.sizeBytes + Math.ceil(file.sizeBytes / (4 * 1024 * 1024)) * 16 + 1024 * 1024 + 32;
    for await (const bytes of response.body) {
      input.signal?.throwIfAborted();
      size += bytes.length;
      if (size > maximum) fail("WORKSPACE_FILE_SIZE_MISMATCH");
      let written = 0;
      while (written < bytes.length) written += (await handle.write(bytes, written)).bytesWritten;
    }
    await handle.close(); handle = null;
    const stream = new PassThrough({ highWaterMark: 64 * 1024 });
    const chunks = [];
    let invalidText = false;
    const parsing = (async () => {
      try { for await (const chunk of chunkWorkspaceText(stream.iterator({ destroyOnReturn: false }))) chunks.push(chunk); }
      catch (error) {
        if (error?.code !== "ERR_ENCODING_INVALID_ENCODED_DATA" && error?.message !== "WORKSPACE_TEXT_INVALID") throw error;
        invalidText = true;
        chunks.length = 0;
        // Drain authenticated bytes after a proven non-text sequence. Crypto
        // verification must still succeed before this becomes unsupported text.
        stream.resume();
      }
    })();
    parsing.catch(() => undefined);
    try {
      await decryptFileFromCompanyContainer({ sourcePath,
        scopePrivateKey: input.companyEncryption.scopePrivateEncryptionKey.privateKey,
        scopePrivateJwk: input.companyEncryption.scopePrivateEncryptionKey.privateJwk,
        expectedCiphertextSha256: response.headers.get("x-trelio-ciphertext-sha256"),
        validateHeader: (header) => {
          const aad = header.aad;
          if (header.plaintextSizeBytes !== file.sizeBytes || aad?.companyId !== input.companyEncryption.runtime.company.id
            || aad?.scopeId !== input.companyEncryption.runtime.scope.id || aad?.scopeEpoch !== input.companyEncryption.runtime.scope.epoch
            || aad?.entityType !== "agent_workspace_browser_file" || aad?.entityId !== file.id
            || aad?.entityRevision !== 1 || aad?.purpose !== "file") fail("WORKSPACE_FILE_ENCRYPTION_BINDING_INVALID");
        },
        consumePlaintext: async (bytes) => {
          input.signal?.throwIfAborted();
          if (!invalidText && !stream.write(Buffer.from(bytes))) await once(stream, "drain");
        },
      });
      stream.end();
      await parsing;
      return { chunks, searchCoverage: { status: invalidText ? "unsupported" : "complete",
        indexedBytes: invalidText ? 0 : file.sizeBytes, totalBytes: file.sizeBytes } };
    } catch (error) {
      stream.destroy(error);
      await parsing.catch(() => undefined);
      throw error;
    }
  } finally {
    try { await handle?.close(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
};

/** One exact file; fresh ACL/head and authority are read even for repeated downloads. */
export const downloadAcceptedWorkspaceFile = async (origin, rawLocator, { signal, assertPlainCompanyRead } = {}) => {
  const locator = validateWorkspaceFileLocator(rawLocator);
  const token = await requireToken(origin);
  const compatibility = await ensureBridgeCompatibility(origin, token);
  const routing = compatibility?.encryptedDataPlane?.enabled === true
    ? await resolveBridgeDataPlaneRouting({ origin, token, workspaceId: locator.workspaceId })
    : { requestOrigin: origin };
  const requestOrigin = routing.requestOrigin;
  const rawSnapshot = await readJsonResponse(await request(requestOrigin, token,
    `/api/agent-workspaces/workspaces/${locator.workspaceId}/read-snapshot`, { signal }));
  if (rawSnapshot?.workspace?.id !== locator.workspaceId
    || rawSnapshot.workspace.acceptedHead !== locator.workspaceHead) fail("WORKSPACE_OUTDATED");
  // The trusted managed plain-source wrapper already reads its genuine native
  // company mode/pass before every request. It cannot open an encrypted file:
  // a changed mode refuses instead of falling back to human key discovery.
  // Ordinary human and encrypted callers retain the unchanged crypto path.
  const companyEncryption = typeof assertPlainCompanyRead === 'function'
    ? (await assertPlainCompanyRead(rawSnapshot.company, signal), null)
    : await ensureCompanyEncryptionContext({ origin, requestOrigin, token, company: rawSnapshot.company });
  const snapshot = await hydrateAgentCompanyEncryptedJson({ value: rawSnapshot, origin: requestOrigin, token, companyEncryption });
  const input = { ...locator, origin: requestOrigin, token, companyEncryption, signal };
  let bytes;
  let contentType;
  try {
    if (companyEncryption) {
      try {
        const files = await readEncryptedWorkspaceFileManifest(input);
        const file = files.find((candidate) => candidate.path === locator.filePath);
        if (!file) fail("WORKSPACE_FILE_NOT_FOUND");
        contentType = file.contentType;
        bytes = await readEncryptedWorkspaceSelectedFile(input, file);
      } catch (error) {
        if (error?.code !== "WORKSPACE_BROWSER_PROJECTION_UNAVAILABLE" || error.encryptedBundleReadable !== true) throw error;
        // A search hit from a cutover bundle must remain downloadable. Repeat
        // the same fresh ACL/head/crypto checks; never use mirror plaintext or
        // send a decrypted path to the server. Delivery still has its own cap.
        await withEncryptedAcceptedWorkspaceFiles(input, async ({ workspaceDirectory, files }) => {
          const file = files.find(candidate => candidate.path === locator.filePath);
          if (!file) fail("WORKSPACE_FILE_NOT_FOUND");
          if (file.sizeBytes > LOCAL_ATTACHMENT_MAX_BYTES) fail("WORKSPACE_FILE_TOO_LARGE");
          contentType = file.contentType;
          bytes = await readAcceptedWorkspaceBlob({ ...input, workspaceDirectory, blobId: file.id }, stream => readBoundedBytes({ body: stream }, LOCAL_ATTACHMENT_MAX_BYTES, signal));
          if (bytes.length !== file.sizeBytes) fail("WORKSPACE_FILE_SIZE_MISMATCH");
        });
      }
    } else {
      const query = new URLSearchParams({ path: locator.filePath, head: locator.workspaceHead, download: "1" });
      const response = await request(requestOrigin, token,
        `/api/agent-workspaces/workspaces/${locator.workspaceId}/file?${query}`, { signal });
      if (response.headers.get("x-trelio-accepted-head") !== locator.workspaceHead) fail("WORKSPACE_OUTDATED");
      contentType = response.headers.get("x-trelio-file-content-type")
        || response.headers.get("content-type") || "application/octet-stream";
      bytes = await readBoundedBytes(response, LOCAL_ATTACHMENT_MAX_BYTES, signal);
    }
    const originalName = locator.filePath.split("/").at(-1);
    // A managed company read repeats its original recipient/pass after slow
    // storage/decryption and before publishing a private plaintext receipt.
    // Human delivery stays unchanged; no model boolean creates this callback.
    await currentWorkspaceExecutionProfile()?.assertCompanyContextCurrent?.(signal);
    const file = await materializeLocalAttachment({ bytes, originalName, signal });
    return {
      schemaVersion: 1, delivery: "local-file", ...locator, originalName, contentType, ...file,
      agentInstructionsSnapshot: snapshot.agentInstructionsSnapshot,
      userProfileSnapshot: snapshot.userProfileSnapshot,
    };
  } finally { bytes?.fill(0); }
};

export const workspaceFileSearchText = (bytes) => (
  !bytes.includes(0) && isUtf8(bytes) ? bytes.toString("utf8") : ""
);
