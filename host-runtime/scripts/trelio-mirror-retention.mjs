/**
 * Local encrypted search mirrors are rebuildable caches, not revision history.
 * Cleanup never decrypts a generation or contacts Trelio. Each schema keeps its
 * own current pointer so a previous running host can still read after upgrade.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDirectModuleInvocation } from "./trelio-local-path.mjs";
import {
  assertPrivatePathKind, readPrivateJsonFile,
  resolveWorkspaceBridgeConfigDirectory, writePrivateJsonFile,
} from "./trelio-workspace.mjs";

export const MIRROR_READER_GRACE_MS = 15 * 60 * 1000;
export const MIRROR_HISTORY_MAX_BYTES = 512 * 1024 * 1024;
const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;
const HASH_FILE = /^[a-f0-9]{64}\.json$/u;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const MAX_SCHEMA_VERSION = 8;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const isMissing = error => error?.code === "ENOENT";
const exists = async target => {
  try { await fs.lstat(target); return true; } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
};

// PID ownership, not age, decides whether a lock may be recovered. A paused or
// slow reader must never lose protection merely because its timer did not run.
const deadOwner = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (error) {
    return error.code === "ESRCH";
  }
};
export const withMirrorRetentionLock = async (root, operation, { waitMs = 30_000 } = {}) => {
  await assertPrivatePathKind(root, "directory").catch(error => {
    error.mirrorLockStage = "root_validation";
    throw error;
  });
  const lock = path.join(root, "retention.lock");
  const id = crypto.randomUUID();
  const ownerPath = path.join(lock, `${id}.json`);
  const deadline = Date.now() + waitMs;
  let attempted = false;
  for (;;) {
    if (attempted && Date.now() >= deadline) return { skipped: "busy" };
    attempted = true;
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      await writePrivateJsonFile(ownerPath, { id, pid: process.pid }).catch(error => {
        error.mirrorLockStage = "owner_publication";
        throw error;
      });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let observedLock;
      let observedOwnerPath;
      try {
        observedLock = await fs.lstat(lock);
        await assertPrivatePathKind(lock, "directory");
        const entries = await fs.readdir(lock);
        if (entries.length === 1 && /^[a-f0-9-]{36}\.json$/u.test(entries[0])) {
          const observedPath = path.join(lock, entries[0]);
          observedOwnerPath = observedPath;
          const owner = await readPrivateJsonFile(observedPath, { maximumBytes: 1024 });
          if (deadOwner(owner.pid)) {
            // The filename is this owner's random nonce. Competing recoverers
            // cannot unlink a successor's differently named record (the ABA
            // race of a shared owner.json). Only the successful unlink may rmdir.
            try {
              await fs.unlink(observedPath);
              await fs.rmdir(lock).catch(error => {
                if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
              });
            } catch (error) { if (!isMissing(error)) throw error; }
            continue;
          }
        }
      } catch (inspectionError) {
        // Windows ACL validation runs out of process. The observed owner can
        // release and a successor can already hold the same directory name by
        // the time the failed validation returns. Fresh absence, a different
        // directory identity, or disappearance of the *unique observed nonce*
        // proves that inspection raced release. Retry acquisition, never the
        // operation, and validate the successor again under the same deadline.
        // A missing shared owner.json would not prove this; our nonce cannot
        // belong to the next owner. Existing/unverifiable paths retain refusal.
        const freshLock = await fs.lstat(lock).catch(error => isMissing(error) ? null : undefined);
        if (freshLock === null || (observedLock && freshLock
          && (freshLock.ino !== observedLock.ino || freshLock.birthtimeMs !== observedLock.birthtimeMs))
          || (observedOwnerPath && !await exists(observedOwnerPath).catch(() => true))) continue;
        inspectionError.mirrorLockStage = "contended_inspection";
        throw inspectionError;
      }
      if (Date.now() >= deadline) return { skipped: "busy" };
      await sleep(20);
    }
  }
  try { return await operation(); } finally {
    await fs.unlink(ownerPath);
    await fs.rmdir(lock);
  }
};

const regularPrivateFile = async file => {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
  if (process.platform !== "win32"
    && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600)) return null;
  return stat;
};

// Caller owns sync.lock, the same lock used by older writers. Readers in this
// release hold retention.lock while reading pointer + encrypted bytes. The
// short grace additionally accommodates older readers without this protocol.
export const pruneMirrorSchema = async (root, { now = Date.now(), stillOwnsWriter = async () => true } = {}) =>
  withMirrorRetentionLock(root, async () => {
    const pointer = await readPrivateJsonFile(path.join(root, "current.json"), { maximumBytes: 4096 });
    const version = root.match(/schema-([1-8])$/u)?.[1];
    if (!HASH.test(pointer.generation ?? "")
      || pointer.schemaVersion !== (version ? Number(version) : 1)) return { skipped: "invalid_pointer" };
    const generations = path.join(root, "generations");
    await assertPrivatePathKind(generations, "directory");
    // Never delete historical files if the only advertised current copy is
    // absent/unsafe. Repairing an incomplete cache is a separate read/sync flow.
    const current = await regularPrivateFile(path.join(generations, `${pointer.generation}.json`));
    if (!current) return { skipped: "invalid_current" };
    const entries = await fs.readdir(generations, { withFileTypes: true });
    if (entries.length > 20_000) return { skipped: "inventory_bound" };
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !HASH_FILE.test(entry.name)) continue;
      const file = path.join(generations, entry.name);
      const stat = await regularPrivateFile(file);
      if (stat) files.push({ file, name: entry.name, stat });
    }
    files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.name.localeCompare(b.name));
    const previous = files.find(file => file.name !== `${pointer.generation}.json`);
    let removedFiles = 0;
    let removedBytes = 0;
    for (const item of files) {
      if (item.name === `${pointer.generation}.json`
        || (item === previous && item.stat.size <= MIRROR_HISTORY_MAX_BYTES)
        || now - item.stat.mtimeMs < MIRROR_READER_GRACE_MS) continue;
      // A final inode/size/time check prevents removing a file replaced during
      // inspection; only an exact known regular cache file can be unlinked.
      // A suspended sweeper may have lost the legacy heartbeat lock. Stop
      // before deleting more files; a replacement writer owns publication now.
      if (!await stillOwnsWriter()) return { removedFiles, removedBytes, skipped: "writer_replaced" };
      const fresh = await regularPrivateFile(item.file);
      if (!fresh || fresh.ino !== item.stat.ino || fresh.size !== item.stat.size
        || fresh.mtimeMs !== item.stat.mtimeMs) continue;
      try {
        await fs.unlink(item.file);
        removedFiles += 1;
        removedBytes += fresh.size;
      } catch (error) {
        // Windows can keep a legacy reader's handle exclusively open. Leave it
        // for the next sweep rather than invalidating a successful publication.
        if (!["ENOENT", "EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
      }
    }
    return { removedFiles, removedBytes };
  });

const pruneIdleSchema = async root => {
  await assertPrivatePathKind(root, "directory");
  const lock = path.join(root, "sync.lock");
  // Atomic mkdir interlocks with every old/new writer. Maintenance never steals
  // a lock, even stale: normal sync owns recovery of its heartbeat protocol.
  try { await fs.mkdir(lock, { mode: 0o700 }); } catch (error) {
    if (error.code === "EEXIST") return { skipped: "writer" };
    throw error;
  }
  const lockId = crypto.randomUUID();
  const ownerPath = path.join(lock, "owner.json");
  const heartbeatPath = path.join(lock, `${lockId}.heartbeat.json`);
  let heartbeatIdentity;
  const stillOwnsWriter = async () => {
    // The heartbeat filename is unique to this owner. Metadata is sufficient
    // to fence replacement and avoids reopening the Windows ACL worker for
    // every historical generation. No private content or ACL result is cached.
    try {
      const current = await fs.lstat(heartbeatPath);
      return current.isFile() && current.ino === heartbeatIdentity?.ino;
    } catch (error) { if (isMissing(error)) return false; throw error; }
  };
  let heartbeat;
  try {
    await writePrivateJsonFile(path.join(lock, "owner.json"), {
      schemaVersion: 1, lockId, pid: process.pid, createdAt: new Date().toISOString(),
    });
    await writePrivateJsonFile(heartbeatPath, { schemaVersion: 1, lockId });
    heartbeatIdentity = await fs.lstat(heartbeatPath);
    // Older writers reclaim a lock after ten minutes without a heartbeat. Use
    // their existing nonce-bound protocol, including on a very slow disk.
    heartbeat = setInterval(() => {
      const now = new Date();
      void fs.utimes(heartbeatPath, now, now).catch(() => undefined);
    }, 20_000);
    heartbeat.unref();
    return await pruneMirrorSchema(root, { stillOwnsWriter });
  } finally {
    clearInterval(heartbeat);
    if (await stillOwnsWriter()) {
      await fs.unlink(heartbeatPath).catch(error => { if (!isMissing(error)) throw error; });
      await fs.unlink(ownerPath);
      await fs.rmdir(lock);
    }
  }
};

export const pruneCompanyMirrorCaches = async ({
  directory = path.join(resolveWorkspaceBridgeConfigDirectory(), "company-context-mirrors"),
  force = false,
} = {}) => {
  if (!await exists(directory)) return { removedFiles: 0, removedBytes: 0 };
  await assertPrivatePathKind(directory, "directory");
  return withMirrorRetentionLock(directory, async () => {
    const statePath = path.join(directory, "retention-state.json");
    const state = await readPrivateJsonFile(statePath, { maximumBytes: 4096 });
    if (!force && Date.now() - state.completedAt < MAINTENANCE_INTERVAL_MS) return { skipped: "interval" };
    const result = { removedFiles: 0, removedBytes: 0, skippedSchemas: 0 };
    // Only the fixed origin-hash / company-UUID / known-schema layout belongs
    // to this sweeper. It does not recurse into arbitrary directories or read
    // generations, credentials, workspace files, keys or company plaintext.
    for (const origin of await fs.readdir(directory, { withFileTypes: true })) {
      if (!origin.isDirectory() || !/^[a-f0-9]{32}$/u.test(origin.name)) continue;
      const originRoot = path.join(directory, origin.name);
      await assertPrivatePathKind(originRoot, "directory");
      for (const company of await fs.readdir(originRoot, { withFileTypes: true })) {
        if (!company.isDirectory() || !UUID.test(company.name)) continue;
        const companyRoot = path.join(originRoot, company.name);
        await assertPrivatePathKind(companyRoot, "directory");
        const roots = [companyRoot];
        for (const schema of await fs.readdir(companyRoot, { withFileTypes: true })) {
          if (schema.isDirectory() && /^schema-[1-8]$/u.test(schema.name)
            && Number(schema.name.slice(7)) <= MAX_SCHEMA_VERSION) roots.push(path.join(companyRoot, schema.name));
        }
        for (const root of roots) {
          if (!await exists(path.join(root, "current.json"))) continue;
          try {
            const report = await pruneIdleSchema(root);
            result.removedFiles += report.removedFiles ?? 0;
            result.removedBytes += report.removedBytes ?? 0;
            if (report.skipped) result.skippedSchemas += 1;
          } catch {
            // One malformed or inaccessible company cache must not prevent
            // cleanup of independent caches. No raw paths/content are logged.
            result.skippedSchemas += 1;
          }
        }
      }
    }
    await writePrivateJsonFile(statePath, { completedAt: Date.now(), ...result });
    return result;
  }, { waitMs: 0 });
};

export const startMirrorCacheMaintenance = () => {
  // Entry-point startup must not delay MCP initialize or the bounded hook.
  // The detached owner-private metadata-only sweep has an interprocess lock
  // and cooldown; it needs no credentials or server connection.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: "ignore", detached: true, windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
};

if (isDirectModuleInvocation(import.meta.url)) {
  pruneCompanyMirrorCaches().catch(() => { process.exitCode = 1; });
}
