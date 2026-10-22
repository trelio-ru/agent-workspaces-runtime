import path from 'node:path';
import { isDirectModuleInvocation } from './trelio-local-path.mjs';
import { resolveWorkspaceBridgeConfigDirectory, readPrivateJsonFile, assertPrivatePathKind } from './trelio-workspace.mjs';
import { browserMailActor, parseBrowserMailHandle } from './trelio-browser-mail-auth.mjs';

/** Process-only bridge for a signed non-JS mail runtime. OTP and private
 * matchers travel on captured stdin/stdout, never argv/env/ordinary MCP.
 * A handle locates exactly one existing browser; it cannot start a browser,
 * choose an executable, reopen a vault, reset a fence or extend its lease.
 */
export async function relayBrowserMail(message, { env = process.env } = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || !['prepare', 'begin', 'deliver', 'claim-ack', 'record-ack', 'status'].includes(message.operation)
    || Object.keys(message).some(k => !['operation', 'handle', 'payload'].includes(k))) throw Error('authentication_mail_invalid');
  const { scope } = parseBrowserMailHandle(message.handle), actor = browserMailActor(env);
  const directory = path.join(resolveWorkspaceBridgeConfigDirectory(), 'visual-browser', scope, 'active');
  await assertPrivatePathKind(directory, 'directory');
  const owner = await readPrivateJsonFile(path.join(directory, 'owner.json'), { maximumBytes: 65536 });
  if (owner.scope !== scope || !/^[0-9a-f]{64}$/u.test(owner.token || '')
    || !Number.isSafeInteger(owner.deadlineAt) || owner.deadlineAt <= Date.now()
    || !Number.isSafeInteger(owner.pid) || owner.pid < 1
    || !Number.isInteger(owner.port) || owner.port < 1 || owner.port > 65535) throw Error('authentication_mail_unavailable');
  process.kill(owner.pid, 0);
  const response = await fetch(`http://127.0.0.1:${owner.port}/authentication-mail`, {
    method: 'POST', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...message, actor }), redirect: 'error',
    signal: AbortSignal.timeout(Math.max(1, Math.min(35000, owner.deadlineAt - Date.now()))),
  });
  if (response.status !== 200 || Number(response.headers.get('content-length') || 0) > 16384) throw Error('authentication_mail_unavailable');
  const body = await response.text();
  if (Buffer.byteLength(body) > 16384) throw Error('authentication_mail_unavailable');
  const value = JSON.parse(body);
  if (!value || value.ok !== true) throw Error('authentication_mail_unavailable');
  return value;
}

if (isDirectModuleInvocation(import.meta.url)) {
  (async () => {
    if (process.argv.length !== 2) throw Error('authentication_mail_invalid');
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length; if (size > 16384) throw Error('authentication_mail_invalid'); chunks.push(chunk);
    }
    const input = Buffer.concat(chunks);
    try { process.stdout.write(JSON.stringify(await relayBrowserMail(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input))))); }
    finally { input.fill(0); for (const chunk of chunks) chunk.fill(0); }
  })().catch(() => { process.stdout.write('{"ok":false,"code":"authentication_mail_unavailable"}'); process.exitCode = 1; });
}
