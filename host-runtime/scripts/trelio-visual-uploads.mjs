import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Resource bounds apply to private staging, not to a provider's allowed file
// formats. Uploads are streamed in small chunks; no binary enters MCP or argv.
export const MAX_VISUAL_UPLOAD_BYTES = 1024 ** 3;
export const MAX_VISUAL_UPLOAD_SESSION_BYTES = 2 * 1024 ** 3;
export const MAX_VISUAL_UPLOAD_FILES = 32;
const fault = code => Object.assign(new Error(code), { code });

export function validVisualUploadFiles(files) {
  return Array.isArray(files) && files.length >= 1 && files.length <= MAX_VISUAL_UPLOAD_FILES
    && files.every(file => typeof file === 'string' && file.length <= 4096
      && path.isAbsolute(file) && !/[\x00-\x1f]/u.test(file)
      // Never authenticate to an SMB server or open a device/alternate data
      // stream merely because a model supplied something shaped like a path.
      && (process.platform !== 'win32' || /^[a-z]:[\\/]/iu.test(file)
        && !file.slice(2).includes(':')))
    && new Set(files.map(file => path.resolve(file))).size === files.length;
}

async function sourceMetadata(file) {
  const absolute = path.resolve(file), root = path.parse(absolute).root;
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory())) throw fault('upload_file_invalid');
  }
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.nlink !== 1) throw fault('upload_file_invalid');
  if (stat.size > MAX_VISUAL_UPLOAD_BYTES) throw fault('upload_too_large');
  return stat;
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.isFile() && b.nlink === 1;

/** Freeze only explicitly selected regular files before ANY browser input.
 * Sources keep their names/bytes/permissions. A same-user replacement, symlink,
 * hard link, device, directory or mutation during copying cannot redirect the
 * browser to another file. Copies live outside the auth profile, in this owned
 * browser's private directory, and last until its ordinary cleanup. Keeping
 * them after dispatch matters: browsers can read selected files lazily, even
 * after an input response was lost. Nothing here retries a browser operation.
 */
export async function freezeVisualUploads({ directory, files, deadlineAt, signal, remainingBytes = MAX_VISUAL_UPLOAD_SESSION_BYTES }) {
  if (!validVisualUploadFiles(files)) throw fault('invalid_input');
  // Pure command validation is also used by the MCP boundary. Load native
  // private-directory helpers only for an admitted staging operation.
  const { prepareVisualPrivateDirectory } = await import('./trelio-visual-bootstrap.mjs');
  const { assertPrivatePathKind } = await import('./trelio-workspace.mjs');
  // Leave time for the chooser and fresh observation inside the existing
  // 50-second private command deadline; the original browser lease never moves.
  const copyDeadlineAt = Math.min(deadlineAt, Date.now() + 25_000);
  const active = () => {
    if (signal?.aborted || Date.now() >= deadlineAt) throw fault('lease_expired');
    if (Date.now() >= copyDeadlineAt) throw fault('upload_timed_out');
  };
  active();
  const metadata = [];
  let totalBytes = 0;
  for (const file of files) {
    active();
    const stat = await sourceMetadata(file);
    totalBytes += stat.size;
    if (totalBytes > remainingBytes) throw fault('upload_limit_reached');
    metadata.push(stat);
  }
  const staging = await fs.mkdtemp(path.join(directory, 'upload-'));
  await prepareVisualPrivateDirectory(staging);
  const buffer = Buffer.alloc(64 * 1024), results = [];
  try {
    for (const [index, source] of files.entries()) {
      active();
      // Each source gets its own directory, preserving even duplicate basename
      // selections without letting that basename escape its private container.
      const targetDirectory = path.join(staging, String(index));
      await prepareVisualPrivateDirectory(targetDirectory);
      const target = path.join(targetDirectory, path.basename(source));
      let input, output;
      try {
        input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        const opened = await input.stat();
        if (!sameFile(metadata[index], opened) || !sameFile(opened, await sourceMetadata(source))) throw fault('upload_file_changed');
        output = await fs.open(target, 'wx', 0o600);
        const hash = createHash('sha256');
        let copied = 0;
        for (;;) {
          active();
          const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          copied += bytesRead;
          if (copied > opened.size) throw fault('upload_file_changed');
          hash.update(buffer.subarray(0, bytesRead));
          let written = 0;
          while (written < bytesRead) {
            active();
            const result = await output.write(buffer, written, bytesRead - written, null);
            if (!result.bytesWritten) throw fault('storage_unavailable');
            written += result.bytesWritten;
          }
        }
        if (copied !== opened.size || !sameFile(opened, await input.stat())
          || !sameFile(opened, await sourceMetadata(source))) throw fault('upload_file_changed');
        await output.sync();
        await assertPrivatePathKind(target, 'file');
        results.push({ filePath: target, sizeBytes: copied, sha256: hash.digest('hex') });
      } finally { await output?.close(); await input?.close(); }
    }
    active();
    return { directory: staging, files: results, sizeBytes: totalBytes };
  } catch (error) {
    // This function has not sent browser input. Only its newly-created staging
    // container can be discarded; never modify a source or an older upload.
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  } finally { buffer.fill(0); }
}
