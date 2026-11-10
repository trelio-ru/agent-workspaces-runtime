import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { isDiagnosticObservation, addDiagnosticDetail } from "./trelio-diagnostic-observation.mjs";

const LIMIT = 256, MAX_BYTES = 16384, TTL = 86400_000;
const leafPattern = /^[0-9a-f-]{36}\.json$/u;
export const diagnosticJournalDirectory = origin => path.join(os.tmpdir(),
  "trelio-diagnostics-v2-" + createHash("sha256").update(os.homedir() + "\0" + origin).digest("hex").slice(0, 24));

// This separate journal contains ONLY the closed, content-free observation
// schema. It deliberately never opens the credential store, repairs an ACL or
// starts a helper. On Windows it inherits the user's temporary-directory ACL;
// it is not a secret store or a source of authorization. POSIX uses 0700/0600.
// A hostile/corrupt local record cannot inject paths, messages or provider data.
const openDirectory = async directory => {
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const metadata = await fs.lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (process.platform !== "win32" && (metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o700))) throw new Error("JOURNAL_UNAVAILABLE");
};
const entries = async directory => {
  const result = [];
  const handle = await fs.opendir(directory);
  for await (const entry of handle) {
    result.push(entry);
    if (result.length > LIMIT) break;
  }
  return result;
};
export const writeDiagnosticJournal = async (origin, sample, { directory = diagnosticJournalDirectory(origin) } = {}) => {
  if (!isDiagnosticObservation(sample)) return "journal_invalid";
  const bytes = JSON.stringify(sample);
  if (Buffer.byteLength(bytes) > MAX_BYTES) return "journal_invalid";
  let lock = false;
  try {
    await openDirectory(directory);
    // One non-waiting filesystem lock bounds concurrent hook writers. It never
    // consumes the hook's private-process budget or retries a failed action.
    await fs.mkdir(path.join(directory, "writer.lock")); lock = true;
    if ((await entries(directory)).length >= LIMIT) return "journal_full";
    const temporary = path.join(directory, sample.id + ".tmp");
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, path.join(directory, sample.id + ".json"));
    return "queued";
  } catch { return "journal_full"; }
  finally { if (lock) await fs.rmdir(path.join(directory, "writer.lock")).catch(() => {}); }
};

export const readDiagnosticJournal = async (origin, { directory = diagnosticJournalDirectory(origin), now = Date.now() } = {}) => {
  const samples = [], losses = {}, detailRows = new Map();
  const ageBucket = stat => !stat ? "unknown" : now - stat.mtimeMs < TTL ? "under_24h"
    : now - stat.mtimeMs <= 2 * TTL ? "24h_to_48h" : "over_48h";
  const drop = (reason, stage, cause, stat) => {
    losses[reason] = (losses[reason] || 0) + 1;
    const row = detailRows.get(reason) ?? { reason, count: 0 };
    row.count++; detailRows.set(reason, row);
    addDiagnosticDetail(row, { kind: "journal", stage, reason: cause, ageBucket: ageBucket(stat) },
      { outcomes: [], losses: [...detailRows.values()] });
  };
  try {
    await openDirectory(directory);
    for (const entry of await entries(directory)) {
      const target = path.join(directory, entry.name);
      if (entry.name === "writer.lock") {
        // A crashed writer contains no state. Reclaim only an old empty exact
        // lock; never recursively delete a path supplied by a record.
        const stat = await fs.lstat(target);
        if (stat.isDirectory() && !stat.isSymbolicLink() && now - stat.mtimeMs > 60000) await fs.rmdir(target).catch(() => {});
        continue;
      }
      if (/^[0-9a-f-]{36}\.tmp$/u.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) {
        const stat = await fs.lstat(target);
        if (now - stat.mtimeMs > 60000) { await fs.unlink(target); drop("journal_invalid", "temporary", "temporary_expired", stat); }
        continue;
      }
      if (!leafPattern.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
      let handle, stat, stage = "entry", reason = "io_failed";
      try {
        handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) { drop("journal_invalid", "entry", !stat.isFile() ? "file_type_invalid" : "file_limit", stat); await handle.close(); handle = undefined; await fs.unlink(target).catch(() => {}); continue; }
        if (now - stat.mtimeMs > TTL) { drop("journal_expired", "entry", "entry_ttl_expired", stat); await handle.close(); handle = undefined; await fs.unlink(target); continue; }
        // Recheck the byte bound while reading: stat alone cannot prevent a
        // concurrently growing local file from allocating an unbounded buffer.
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length > MAX_BYTES) { reason = "read_limit"; throw new Error("JOURNAL_INVALID"); }
        stage = "decode"; reason = "json_invalid";
        const sample = JSON.parse(bytes.subarray(0, length).toString("utf8"));
        stage = "validation"; reason = "io_failed";
        if (!isDiagnosticObservation(sample) || entry.name !== sample.id + ".json") { drop("journal_invalid", stage,
          !isDiagnosticObservation(sample) ? "schema_invalid" : "filename_mismatch", stat); await handle.close(); handle = undefined; await fs.unlink(target); continue; }
        samples.push(sample);
      } catch { drop("journal_invalid", stage, reason, stat); await handle?.close(); handle = undefined; await fs.unlink(target).catch(() => {}); }
      finally { await handle?.close(); }
    }
  } catch (error) { if (error.code !== "ENOENT") drop("journal_full", "directory", "directory_unavailable"); }
  return { samples, losses, ...(detailRows.size ? { details: [...detailRows.values()] } : {}) };
};
export const acknowledgeDiagnosticJournal = async (origin, samples, { directory = diagnosticJournalDirectory(origin) } = {}) => {
  // Delete only UUID files whose immutable sample was acknowledged by the
  // backend. Replaying after a crash uses its same idempotency UUID.
  for (const sample of samples) if (isDiagnosticObservation(sample)) {
    await fs.unlink(path.join(directory, sample.id + ".json")).catch(() => {});
  }
};
