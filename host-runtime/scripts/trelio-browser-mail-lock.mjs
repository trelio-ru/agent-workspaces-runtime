import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolveWorkspaceBridgeConfigDirectory, readPrivateJsonFile, writePrivateJsonFile } from './trelio-workspace.mjs';
import { prepareVisualPrivateDirectory } from './trelio-visual-bootstrap.mjs';

/** One email account cannot supply codes to two concurrent browser logins.
 * Otherwise a newly arrived code could satisfy the wrong same-service request
 * before a second message reveals the ambiguity. This is coordination only:
 * no password/OTP/session is stored, and the original credential attempt fence
 * remains authoritative after a crash or expired lock reclamation.
 */
export async function acquireBrowserMailLock({ mailSkillId, mailAccountId, browserScope, expiresAt,
  origin = 'https://trelio.ru', directory = resolveWorkspaceBridgeConfigDirectory(), now = Date.now }) {
  const fail = () => { throw Object.assign(new Error('authentication_mail_busy'), { code: 'authentication_mail_busy' }); };
  if (typeof mailSkillId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,119}$/u.test(mailSkillId)
    || !/^[0-9a-f-]{36}$/u.test(mailAccountId) || !/^[0-9a-f]{64}$/u.test(browserScope)
    || !Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt - now() > 120000) fail();
  const root = path.join(directory, 'browser-mail-accounts');
  await prepareVisualPrivateDirectory(root);
  const key = createHash('sha256').update(JSON.stringify([origin, mailSkillId, mailAccountId])).digest('hex');
  const lock = path.join(root, key), file = path.join(lock, 'owner.json');
  const valid = value => value?.version === 1 && /^[0-9a-f]{64}$/u.test(value.nonce || '')
    && /^[0-9a-f]{64}$/u.test(value.browserScope || '') && Number.isSafeInteger(value.expiresAt)
    && Number.isSafeInteger(value.pid) && value.pid > 0;
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await readPrivateJsonFile(file, { maximumBytes: 2048 });
    if (!valid(previous) || previous.expiresAt > now()) fail();
    const recovery = path.join(lock, 'recovery');
    try { await fs.mkdir(recovery, { mode: 0o700 }); }
    catch (error) { if (['EEXIST', 'ENOENT'].includes(error.code)) fail(); throw error; }
    let moved = false;
    try {
      await prepareVisualPrivateDirectory(recovery);
      const current = await readPrivateJsonFile(file, { maximumBytes: 2048 });
      if (current.nonce !== previous.nonce || current.expiresAt > now()
        || (await fs.readdir(lock)).sort().join() !== 'owner.json,recovery') fail();
      const old = `${lock}.${randomUUID()}.closed`;
      await fs.rename(lock, old); moved = true;
      await fs.unlink(path.join(old, 'owner.json'));
      await fs.rmdir(path.join(old, 'recovery')); await fs.rmdir(old);
    } finally { if (!moved) await fs.rmdir(recovery); }
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') fail(); throw error; }
  }
  await prepareVisualPrivateDirectory(lock);
  const record = { version: 1, nonce: randomBytes(32).toString('hex'), browserScope, expiresAt, pid: process.pid };
  await writePrivateJsonFile(file, record);
  let released = false;
  return {
    expiresAt,
    assertActive() { if (released || now() >= expiresAt) fail(); },
    async release() {
      if (released) return;
      const current = await readPrivateJsonFile(file, { maximumBytes: 2048 });
      // A stale owner must not remove a fresh successor after its own expiry.
      if (current.nonce !== record.nonce) { released = true; return; }
      if ((await fs.readdir(lock)).join() !== 'owner.json') fail();
      await fs.unlink(file); await fs.rmdir(lock); released = true;
    },
  };
}
