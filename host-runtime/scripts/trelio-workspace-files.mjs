import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { chunkWorkspaceText } from "./trelio-workspace-text-chunks.mjs";
import { isUtf8 } from "node:buffer";
import {
  request, requireToken, ensureBridgeCompatibility, ensureCompanyEncryptionContext,
  resolveBridgeDataPlaneRouting, hydrateAgentCompanyEncryptedJson,
  ensurePrivateDirectory, hardenWindowsPrivatePath, resolveWorkspaceBridgeConfigDirectory,
} from "./trelio-workspace.mjs";
import { decryptFileFromCompanyContainer, decryptFileFromCompanyContainerBytes } from "./trelio-company-encryption.mjs";
import { materializeLocalAttachment, LOCAL_ATTACHMENT_MAX_BYTES } from "./trelio-local-attachments.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEAD = /^[0-9a-f]{40,64}$/u;
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

export const validateWorkspaceFileLocator = ({ workspaceId, workspaceHead, filePath }) => {
  if (!UUID.test(String(workspaceId)) || !HEAD.test(String(workspaceHead))
    || typeof filePath !== "string" || !filePath || filePath.length > 2048
    || filePath.startsWith("/") || /[\\\x00-\x1f]/u.test(filePath)
    || filePath.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("WORKSPACE_FILE_INVALID_LOCATOR");
  }
  return { workspaceId, workspaceHead, filePath };
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
  const overview = await (await request(input.origin, input.token,
    `/api/agent-workspaces/workspaces/${input.workspaceId}`, { signal: input.signal })).json();
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
    fail("WORKSPACE_BROWSER_PROJECTION_UNAVAILABLE");
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
  const config = resolveWorkspaceBridgeConfigDirectory();
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
export const downloadAcceptedWorkspaceFile = async (origin, rawLocator, { signal } = {}) => {
  const locator = validateWorkspaceFileLocator(rawLocator);
  const token = await requireToken(origin);
  const compatibility = await ensureBridgeCompatibility(origin, token);
  const routing = compatibility?.encryptedDataPlane?.enabled === true
    ? await resolveBridgeDataPlaneRouting({ origin, token, workspaceId: locator.workspaceId })
    : { requestOrigin: origin };
  const requestOrigin = routing.requestOrigin;
  const rawSnapshot = await (await request(requestOrigin, token,
    `/api/agent-workspaces/workspaces/${locator.workspaceId}/read-snapshot`, { signal })).json();
  if (rawSnapshot?.workspace?.id !== locator.workspaceId
    || rawSnapshot.workspace.acceptedHead !== locator.workspaceHead) fail("WORKSPACE_OUTDATED");
  const companyEncryption = await ensureCompanyEncryptionContext({ origin, requestOrigin, token, company: rawSnapshot.company });
  const snapshot = await hydrateAgentCompanyEncryptedJson({ value: rawSnapshot, origin: requestOrigin, token, companyEncryption });
  const input = { ...locator, origin: requestOrigin, token, companyEncryption, signal };
  let bytes;
  let contentType;
  try {
    if (companyEncryption) {
      const files = await readEncryptedWorkspaceFileManifest(input);
      const file = files.find((candidate) => candidate.path === locator.filePath);
      if (!file) fail("WORKSPACE_FILE_NOT_FOUND");
      contentType = file.contentType;
      bytes = await readEncryptedWorkspaceSelectedFile(input, file);
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
