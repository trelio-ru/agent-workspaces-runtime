import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { withMirrorRetentionLock } from "./trelio-mirror-retention.mjs";
import {
  ensurePrivateDirectory, hardenWindowsPrivatePath, readPrivateJsonFile,
  readRunRegistry, isHumanFacingEncryptedWorkspacePath, resolveWorkspaceBridgeConfigDirectory,
} from "./trelio-workspace.mjs";

export const LOCAL_PROPOSAL_FILES = Symbol("local-proposal-files");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_FILES = 20;
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 512;
// App review grants live for at most thirty days. Keep immutable previews one
// day longer: cleaning a Run must not invalidate a still-readable review card.
const RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const NATIVE_RENDERERS = new Set(["propose_task_comment", "render_task_comment_proposal", "render_task_proposals"]);

export const bindLocalProposalFilePreviews = (proposal, files) => {
  const draft = proposal?.currentDraft;
  if (!draft?.proposalId || !Array.isArray(draft.attachments)) return [];
  return draft.attachments.flatMap((attachment) => {
    const matching = files.filter((file) => file.sourceFileId && file.sourceFileId === attachment.encryptedSourceFileId);
    if (matching.length !== 1) return [];
    const file = matching[0];
    return [{ proposalId: draft.proposalId, attachmentId: attachment.id, sha256: attachment.sha256,
      localPath: file.localPath, expiresAt: file.expiresAt }];
  });
};

/** Expired snapshots alone may be removed; unexpired cards retain their files. */
export const pruneLocalProposalFilePreviews = async (cacheRoot, now = Date.now()) => {
  let entries;
  try { entries = await fs.readdir(cacheRoot, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.slice(0, 512)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const match = /^(\d{13})-([0-9a-f-]{36})$/u.exec(entry.name);
    if (!match || !UUID.test(match[2]) || Number(match[1]) + RETENTION_MS >= now) continue;
    const directory = path.join(cacheRoot, entry.name);
    try {
      await assertRealOwnedPath(directory, "directory");
      const children = await fs.readdir(directory, { withFileTypes: true });
      if (children.length !== 1 || !children[0].isFile() || children[0].isSymbolicLink()) continue;
      const file = path.join(directory, children[0].name);
      await assertRealOwnedPath(file, "file");
      await fs.chmod(directory, 0o700);
      await fs.chmod(file, 0o600);
      await fs.unlink(file);
      await fs.rmdir(directory);
    } catch { /* Cleanup never broadens its scope or blocks proposal preparation. */ }
  }
};

export const localProposalFileProofPayload = (proof, toolName, files) => Buffer.from([
  "trelio-proposal-local-files-v1", proof.runtimeSessionId, toolName, proof.issuedAt, proof.nonce,
  JSON.stringify(files.map(({ sourceRunId, workspaceId, filePath, sha256, sizeBytes, localPath, expiresAt }) =>
    [sourceRunId, workspaceId, filePath, sha256, sizeBytes, localPath, expiresAt])),
].join("\n"), "utf8");

export const selectNativeProposalFiles = (toolName, input) => {
  if (!NATIVE_RENDERERS.has(toolName)) return [];
  const completionMode = toolName === "render_task_proposals" && Array.isArray(input.completions);
  const cards = toolName === "render_task_proposals" ? (input.blocks ?? input.completions ?? []) : [input];
  return cards.flatMap((card) => {
    const runId = card?.runId;
    const filePaths = card?.filePaths ?? card?.decisions?.comment?.filePaths ?? card?.comment?.filePaths;
    if (!Array.isArray(filePaths)) return [];
    if (UUID.test(String(runId))) return filePaths.slice(0, 10).map((filePath) => ({ sourceRunId: runId, filePath }));
    // Completion refs hide their task/Run target from the model. Candidates
    // stay in the explicit company; the backend will select only the exact
    // accepted source of the claimed plan. No candidate grants preview rights.
    if (completionMode && typeof input.companySlug === "string") return filePaths.slice(0, 10)
      .map((filePath) => ({ companySlug: input.companySlug, filePath }));
    return [];
  }).slice(0, MAX_FILES);
};

const safeRelativeFile = (filePath) => typeof filePath === "string" && filePath.length > 0
  && filePath.length <= 2048 && !path.isAbsolute(filePath) && !/[\\\x00-\x1f]/u.test(filePath)
  && filePath.split("/").every((part) => part && part !== "." && part !== "..");

const assertRealOwnedPath = async (entry, kind) => {
  const stat = await fs.lstat(entry);
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())
    || (process.getuid && stat.uid !== process.getuid())) throw new Error("unsafe preview source");
  return stat;
};

/**
 * Prepare a private read-only snapshot, never a link to the mutable worktree.
 * No network or Git mutation is needed. For native plain cards the backend
 * later compares this digest with its accepted Run; encrypted cards supply
 * the digest from their authenticated, locally decrypted file manifest.
 * Any optional-preview failure leaves the ordinary download path available.
 */
export const prepareLocalProposalFiles = async ({ origin, files, allowEncrypted = false, signal }, {
  readRegistry = readRunRegistry,
  configDirectory = resolveWorkspaceBridgeConfigDirectory(),
  now = Date.now(),
} = {}) => {
  if (!Array.isArray(files) || files.length === 0) return [];
  const roots = [];
  try {
    for (const root of (await readRegistry()).slice(0, 256)) {
      signal?.throwIfAborted();
      try {
        await assertRealOwnedPath(root, "directory");
        const metadata = await readPrivateJsonFile(path.join(root, ".trelio-run.json"), { maximumBytes: 1024 * 1024 });
        if (metadata.origin !== origin || !UUID.test(String(metadata.runId)) || !UUID.test(String(metadata.workspaceId))
          || (allowEncrypted ? !metadata.encryption?.enabled : metadata.encryption?.enabled !== false)
          || path.resolve(metadata.workspaceDirectory || "") !== path.join(path.resolve(root), "workspace")) continue;
        roots.push({ root, metadata });
      } catch { /* Unknown, stale and unsafe registry entries grant no file access. */ }
    }
  } catch { return []; }
  const cacheRoot = path.join(configDirectory, "proposal-file-previews");
  try {
    await ensurePrivateDirectory(configDirectory);
    await fs.mkdir(cacheRoot, { mode: 0o700 }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
    // Use the existing PID-owned private-directory lock so concurrent hooks
    // cannot exceed the quota or clean a snapshot while it is being copied.
    // Contention is optional-preview unavailability, never an admission wait.
    const prepared = await withMirrorRetentionLock(cacheRoot, async () => {
      let cacheBytes = 0, cacheEntries = 0;
      try {
        await ensurePrivateDirectory(configDirectory);
        await ensurePrivateDirectory(cacheRoot);
        await pruneLocalProposalFilePreviews(cacheRoot, now);
        const entries = (await fs.readdir(cacheRoot, { withFileTypes: true }))
          .filter(entry => entry.name !== "retention.lock");
        // Do not evict a snapshot belonging to a live card to make space for a new
        // one. Unknown entries or an exhausted cache simply keep downloads active.
        if (entries.length >= MAX_CACHE_ENTRIES) return [];
        cacheEntries = entries.length;
        for (const entry of entries) {
          signal?.throwIfAborted();
          const directory = path.join(cacheRoot, entry.name);
          await assertRealOwnedPath(directory, "directory");
          const children = await fs.readdir(directory);
          if (children.length !== 1) return [];
          cacheBytes += (await assertRealOwnedPath(path.join(directory, children[0]), "file")).size;
          if (cacheBytes >= MAX_CACHE_BYTES) return [];
        }
      } catch { return []; }
      const result = [];
      let remaining = MAX_BYTES;
      const candidatesByFile = files.flatMap((selected) => selected.sourceRunId ? [selected]
        : roots.filter(({ metadata }) => metadata.company?.slug === selected.companySlug)
          .map(({ metadata }) => ({ ...selected, sourceRunId: metadata.runId, workspaceId: metadata.workspaceId })));
      const seen = new Set();
      for (const selected of candidatesByFile.slice(0, MAX_FILES)) {
        let directory, source, target;
        try {
          signal?.throwIfAborted();
          if (!safeRelativeFile(selected.filePath) || !isHumanFacingEncryptedWorkspacePath(selected.filePath)
            || selected.filePath.split("/").includes(".git")) continue;
          // E2EE must compare with the authenticated decrypted manifest. Native
          // plain previews are compared with accepted server bytes after signing.
          if (allowEncrypted && (!SHA256.test(String(selected.sha256))
            || !Number.isSafeInteger(selected.sizeBytes) || selected.sizeBytes <= 0)) continue;
          const key = `${selected.sourceRunId}:${selected.filePath}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const candidates = roots.filter(({ metadata }) => metadata.runId === selected.sourceRunId
            && (!selected.workspaceId || metadata.workspaceId === selected.workspaceId));
          if (candidates.length !== 1) continue;
          const { metadata } = candidates[0];
          const parts = selected.filePath.split("/");
          let sourcePath = metadata.workspaceDirectory;
          await assertRealOwnedPath(sourcePath, "directory");
          for (const part of parts.slice(0, -1)) {
            sourcePath = path.join(sourcePath, part);
            await assertRealOwnedPath(sourcePath, "directory");
          }
          sourcePath = path.join(sourcePath, parts.at(-1));
          await assertRealOwnedPath(sourcePath, "file");
          source = await fs.open(sourcePath, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
          const stat = await source.stat();
          if (!stat.isFile() || stat.size <= 0 || stat.size > remaining || cacheBytes + stat.size > MAX_CACHE_BYTES
            || cacheEntries >= MAX_CACHE_ENTRIES) continue;
          await ensurePrivateDirectory(configDirectory);
          await ensurePrivateDirectory(cacheRoot);
          directory = path.join(cacheRoot, `${now}-${crypto.randomUUID()}`);
          await fs.mkdir(directory, { mode: 0o700 });
          await ensurePrivateDirectory(directory);
          const localPath = path.join(directory, parts.at(-1));
          target = await fs.open(localPath, "wx", 0o600);
          if (process.platform === "win32") await hardenWindowsPrivatePath(localPath, "file");
          const hash = crypto.createHash("sha256");
          let sizeBytes = 0;
          for await (const bytes of source.createReadStream({ autoClose: false })) {
            signal?.throwIfAborted();
            sizeBytes += bytes.length;
            if (sizeBytes > stat.size || sizeBytes > remaining) throw new Error("preview size changed");
            hash.update(bytes);
            let offset = 0;
            while (offset < bytes.length) offset += (await target.write(bytes, offset)).bytesWritten;
          }
          const sha256 = hash.digest("hex");
          if (sizeBytes !== stat.size || (selected.sha256 && (!SHA256.test(selected.sha256) || sha256 !== selected.sha256))
            || (selected.sizeBytes !== undefined && selected.sizeBytes !== sizeBytes)) throw new Error("preview digest changed");
          await target.sync();
          await target.close(); target = null;
          await fs.chmod(localPath, 0o400);
          // Ordinary editor saves cannot replace the snapshot either. The private
          // parent remains writable solely for bounded runtime cleanup after expiry.
          if (process.platform !== "win32") await fs.chmod(directory, 0o500);
          result.push({ sourceRunId: selected.sourceRunId, workspaceId: metadata.workspaceId,
            filePath: selected.filePath, sha256, sizeBytes, localPath, expiresAt: new Date(now + RETENTION_MS).toISOString(),
            ...(selected.sourceFileId ? { sourceFileId: selected.sourceFileId } : {}) });
          remaining -= sizeBytes;
          cacheBytes += sizeBytes;
          cacheEntries += 1;
          directory = null;
        } catch { /* Preview is optional; neither errors nor source paths enter diagnostics. */ }
        finally {
          await source?.close().catch(() => undefined);
          await target?.close().catch(() => undefined);
          if (directory) {
            await fs.chmod(directory, 0o700).catch(() => undefined);
            await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      }
      return result;
    }, { waitMs: 0 });
    return Array.isArray(prepared) ? prepared : [];
  } catch { return []; }
};
