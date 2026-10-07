import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

// The signed runtime must contain the exact hosted binaries corresponding to
// this reviewed source. Missing, stale, symlinked or wrong-architecture inputs
// stop packaging; there is no local compile or PowerShell production fallback.
export const validateWindowsPrivateWorker = async (sourceRoot) => {
  const physicalRoot = await fs.realpath(sourceRoot);
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const read = async relative => {
    const file = path.join(sourceRoot, relative);
    const stat = await fs.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 2_000_000);
    assert.equal(await fs.realpath(file), path.join(physicalRoot, relative));
    return fs.readFile(file);
  };
  const metadata = JSON.parse((await read('bin/metadata.json')).toString('utf8').replace(/^\uFEFF/u, ''));
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.sourceSha256, sha(await read('PrivateProcess.cpp')));
  for (const [arch, machine] of Object.entries({x64:0x8664, ia32:0x14c, arm64:0xaa64})) {
    const bytes = await read(`bin/${arch}/trelio-private-process.exe`);
    assert.equal(bytes.length, metadata.binaries[arch].sizeBytes);
    assert.equal(sha(bytes), metadata.binaries[arch].sha256);
    assert.equal(bytes.readUInt16LE(0), 0x5a4d);
    const pe = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.readUInt32LE(pe), 0x4550);
    assert.equal(bytes.readUInt16LE(pe + 4), machine);
  }
  return metadata;
};
