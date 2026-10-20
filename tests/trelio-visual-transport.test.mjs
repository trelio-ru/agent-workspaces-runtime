import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { crc32, deflateSync } from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { visualFrame, parseVisualSkillOutput, visualStatus, validateVisualResult, normalizeBrowserVisualResult } from '../host-runtime/scripts/trelio-visual-result.mjs';
import { visualSessionBinding, createVisualControlServer, runVisualSession } from '../host-runtime/scripts/trelio-visual-session.mjs';
import { prepareVisualPrivateDirectory, runVisualChild, visualChildEnvironment } from '../host-runtime/scripts/trelio-visual-bootstrap.mjs';
import { writePrivateJsonFile } from '../host-runtime/scripts/trelio-workspace.mjs';
import { handleToolCall } from '../host-runtime/scripts/trelio-remote-mcp.mjs';
import { handleTrelioWorkspaceActionOperation } from '../host-runtime/scripts/trelio-local-context.mjs';

test('headed child retains the X11 authorization-file path while dropping loader and private token environment', () => {
  const previous = Object.fromEntries(['XAUTHORITY', 'NODE_OPTIONS', 'TRELIO_SYNTHETIC_TOKEN'].map(name => [name, process.env[name]]));
  try {
    Object.assign(process.env, { XAUTHORITY: '/synthetic/Xauthority', NODE_OPTIONS: '--synthetic-loader', TRELIO_SYNTHETIC_TOKEN: 'PRIVATE_FIXTURE' });
    const env = visualChildEnvironment();
    assert.equal(env.XAUTHORITY, '/synthetic/Xauthority'); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.TRELIO_SYNTHETIC_TOKEN, undefined);
  } finally { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});

test('full visual payload crosses the real typed action handler as an image, not truncated stdout', async () => {
  // A valid synthetic noisy PNG is larger than the legacy text limit. No
  // website bytes or auth state participate in the transport fixture.
  const chunk = (type, data) => { const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8); out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(320); header.writeUInt32BE(240, 4); header[8] = 8; header[9] = 6;
  const rows = randomBytes((320 * 4 + 1) * 240); for (let y = 0; y < 240; y++) rows[y * (320 * 4 + 1)] = 0;
  const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  const visual = visualFrame({ png: bytes, width: 320, height: 240, sessionId: randomUUID(), scroll: { up: false, down: true, left: false, right: false } });
  const input = { schemaVersion: 1, operation: 'skill_run', parameters: { companyId: randomUUID(), skillId: 'synthetic-visual-fixture', releaseId: randomUUID(), arguments: ['screenshot'] } };
  const result = await handleToolCall('https://example.test', 'continue_trelio_workspace_action', input, {
    workspaceActionOperation: (origin, args) => handleTrelioWorkspaceActionOperation(origin, args, {
      runBridge: async () => ({ stdout: JSON.stringify(visual), stderr: '' }),
    }),
  });
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].data, bytes.toString('base64'));
  assert.doesNotMatch(result.content[0].text, /image|data|stdout|SYNTHETIC_SECRET/);
  assert.throws(() => visualStatus('saved_unverified', 'none', { sessionCookies: [{ value: 'SYNTHETIC_PRIVATE_AUTH' }] }), /VISUAL_RESULT_INVALID/);
  assert.throws(() => parseVisualSkillOutput(JSON.stringify({ ...visual, html: '<script>SYNTHETIC_SECRET</script>' })), /VISUAL_RESULT_INVALID/);
  assert.equal(parseVisualSkillOutput(JSON.stringify({ text: 'Documentation mentions trelio.visual-browser/v1' })), null);
  for (const png of [Buffer.concat([bytes, Buffer.from('SYNTHETIC_SOURCE_CODE')]), bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes.subarray(0, bytes.length - 12), chunk('tEXt', Buffer.from('SYNTHETIC_SOURCE_CODE')), chunk('IEND', Buffer.alloc(0))])]) {
    assert.throws(() => visualFrame({ png, width: 320, height: 240, sessionId: randomUUID(), scroll: visual.scroll }), /VISUAL_RESULT_INVALID/);
  }
});

function colorProfileFixture() {
  const chunk = (type, data) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, 8 + data.length)), 8 + data.length);
    return bytes;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(320); header.writeUInt32BE(240, 4); header[8] = 8; header[9] = 6;
  const head = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header)]);
  const raster = chunk('IDAT', deflateSync(Buffer.alloc((320 * 4 + 1) * 240)));
  const end = chunk('IEND', Buffer.alloc(0));
  // The profile is deliberately opaque. Normalization must discard it without
  // inflating or interpreting any embedded private string or ICC tag content.
  const profileData = Buffer.concat([Buffer.from('Display profile\0\0'), deflateSync(Buffer.from('SYNTHETIC_PRIVATE_COLOR_PROFILE'))]);
  const profile = chunk('iCCP', profileData), plain = Buffer.concat([head, raster, end]);
  const base = visualFrame({ png: plain, width: 320, height: 240, sessionId: randomUUID(), scroll: { up: false, down: false, left: false, right: false } });
  const frame = png => ({ ...base, image: { mimeType: 'image/png', data: png.toString('base64') } });
  return { chunk, head, raster, end, profile, profileData, plain, frame };
}

test('owned browser ICC normalization preserves raster bytes and crosses the real MCP transport without metadata', async () => {
  const f = colorProfileFixture(), png = Buffer.concat([f.head, f.profile, f.raster, f.end]);
  const original = f.frame(png), normalized = normalizeBrowserVisualResult(original);
  assert.throws(() => validateVisualResult(original), /VISUAL_RESULT_INVALID/, 'ordinary provider/MCP frames cannot admit the profile');
  assert.throws(() => parseVisualSkillOutput(JSON.stringify(original)), /VISUAL_RESULT_INVALID/);
  assert.equal(original.image.data, png.toString('base64'), 'normalization does not mutate a caller-owned packet');
  assert.deepEqual(Buffer.from(normalized.image.data, 'base64'), f.plain, 'only the profile chunk disappears');
  assert.equal(normalizeBrowserVisualResult(normalized), normalized, 'plain raster avoids another replacement');
  const input = { schemaVersion: 1, operation: 'skill_run', parameters: { companyId: randomUUID(), skillId: 'synthetic-visual-fixture', releaseId: randomUUID(), arguments: ['screenshot'] } };
  const result = await handleToolCall('https://example.test', 'continue_trelio_workspace_action', input, {
    workspaceActionOperation: (origin, args) => handleTrelioWorkspaceActionOperation(origin, args, {
      runBridge: async () => ({ stdout: JSON.stringify(normalized), stderr: '' }),
    }),
  });
  assert.equal(result.content[1].type, 'image');
  assert.deepEqual(Buffer.from(result.content[1].data, 'base64'), f.plain);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_COLOR_PROFILE|iCCP|stdout/);
});

test('browser ICC normalization retains strict CRC, framing, size and non-raster metadata rejection', () => {
  const f = colorProfileFixture();
  const corrupt = Buffer.from(f.profile); corrupt[corrupt.length - 1] ^= 1;
  const invalidProfiles = [
    corrupt,
    f.chunk('iCCP', Buffer.from('\0\0payload')),
    f.chunk('iCCP', Buffer.from('name\0\x01payload')),
    f.chunk('iCCP', Buffer.from('name\0\0')),
    f.chunk('iCCP', Buffer.concat([Buffer.from('x'.repeat(80)), Buffer.from('\0\0payload')])),
    f.chunk('iCCP', Buffer.concat([Buffer.from('name\0\0'), Buffer.alloc(64 * 1024)])),
    Buffer.concat([f.profile, f.profile]),
  ];
  for (const profile of invalidProfiles) assert.throws(() => normalizeBrowserVisualResult(f.frame(Buffer.concat([f.head, profile, f.raster, f.end]))), /VISUAL_RESULT_INVALID/);
  for (const type of ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'fOoB']) {
    const metadata = f.chunk(type, Buffer.from('SYNTHETIC_SITE_SOURCE'));
    assert.throws(() => normalizeBrowserVisualResult(f.frame(Buffer.concat([f.head, f.profile, metadata, f.raster, f.end]))), /VISUAL_RESULT_INVALID/);
  }
  for (const png of [
    Buffer.concat([f.head, f.raster, f.profile, f.end]),
    Buffer.concat([f.head, f.chunk('PLTE', Buffer.alloc(3)), f.profile, f.raster, f.end]),
    Buffer.concat([f.head, f.profile, f.raster, f.end, Buffer.from('SYNTHETIC_TRAILING_SOURCE')]),
    Buffer.concat([f.head, f.profile, f.raster, f.end]).subarray(0, -1),
  ]) assert.throws(() => normalizeBrowserVisualResult(f.frame(png)), /VISUAL_RESULT_INVALID/);
});

test('worker binding is verified policy/account data and preserves absolute lease', () => {
  const start = Date.now(), deadline = start + 60_000;
  const env = { TRELIO_SKILL_ID: 'synthetic-visual-fixture', TRELIO_SKILL_COMPANY_ID: randomUUID(), TRELIO_SKILL_MEMBER_ID: randomUUID(), TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: randomUUID() }), TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify({ apiVersion: 1, sessionClass: 'protected-snapshot', manualAssist: true, leaseMs: 60_000 }), TRELIO_BROWSER_SESSION_STARTED_AT: String(start), TRELIO_BROWSER_SESSION_DEADLINE_AT: String(deadline) };
  assert.equal(visualSessionBinding(env).deadlineAt, deadline);
  assert.throws(() => visualSessionBinding({ ...env, TRELIO_SKILL_ACCOUNT_JSON: '{}' }), /VISUAL_IDENTITY_INVALID/);
  assert.throws(() => visualSessionBinding({ ...env, TRELIO_BROWSER_SESSION_POLICY_JSON: '{}' }), /VISUAL_IDENTITY_INVALID/);
  assert.throws(() => visualSessionBinding({ ...env, TRELIO_BROWSER_SESSION_DEADLINE_AT: String(deadline + 1) }), /VISUAL_IDENTITY_INVALID/);
});

test('loopback control rejects web origins and incorrect tokens before dispatch', async () => {
  let dispatched = 0;
  const server = createVisualControlServer({ token: 'synthetic-token', dispatch: async () => { dispatched++; return { kind: 'trelio.visual-browser/v1', state: 'not_configured', reason: 'none' }; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/command`;
  try {
    for (const headers of [{}, { authorization: 'Bearer synthetic-token', origin: 'https://example.test' }]) {
      assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })).status, 403);
    }
    assert.equal(dispatched, 0);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-token' }, body: JSON.stringify({ operation: 'status', args: {} }) })).status, 200);
    assert.equal(dispatched, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('concurrent dead-worker recovery preserves live bindings and unknown files', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-visual-claim-')));
  const start = Date.now();
  const env = { TRELIO_ORIGIN: 'https://example.test', TRELIO_SKILL_ID: 'synthetic-visual-fixture', TRELIO_SKILL_COMPANY_ID: randomUUID(), TRELIO_SKILL_MEMBER_ID: randomUUID(), TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: randomUUID() }), TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify({ apiVersion: 1, sessionClass: 'protected-snapshot', manualAssist: true, leaseMs: 60_000 }), TRELIO_BROWSER_SESSION_STARTED_AT: String(start), TRELIO_BROWSER_SESSION_DEADLINE_AT: String(start + 60_000) };
  const binding = visualSessionBinding(env);
  const active = path.join(directory, 'visual-browser', binding.scope, 'active');
  const owner = { schemaVersion: 1, scope: binding.scope, bindingHash: '0'.repeat(64), token: 'a'.repeat(64), deadlineAt: start + 60_000, pid: process.pid };
  const call = () => runVisualSession({ origins: ['http://127.0.0.1:32123'], operation: 'status', env, fixture: { directory } });
  try {
    await prepareVisualPrivateDirectory(active);
    await writePrivateJsonFile(path.join(active, 'owner.json'), owner);
    assert.equal((await call()).reason, 'session_busy', 'another live company binding is never adopted');
    await writePrivateJsonFile(path.join(active, 'owner.json'), { ...owner, bindingHash: binding.bindingHash });
    assert.equal((await runVisualSession({ origins: ['http://127.0.0.1:32123'], operation: 'read-text', observationMode: 'text', env, fixture: { directory } })).reason, 'observation_mode_mismatch', 'legacy image worker cannot expose text after a provider upgrade');
    await writePrivateJsonFile(path.join(active, 'owner.json'), owner);
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    await once(child, 'exit'); owner.pid = child.pid;
    await writePrivateJsonFile(path.join(active, 'owner.json'), owner);
    const outcomes = await Promise.all([call(), call()]);
    assert.ok(outcomes.some(value => value.state === 'not_configured'));
    assert.doesNotMatch(JSON.stringify(outcomes), new RegExp(owner.token));
    assert.equal(await fs.stat(active).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false);
    await prepareVisualPrivateDirectory(active);
    await writePrivateJsonFile(path.join(active, 'owner.json'), owner);
    await fs.writeFile(path.join(active, 'unknown.txt'), 'SYNTHETIC_KEEPER');
    assert.equal((await call()).reason, 'session_busy');
    assert.equal(await fs.readFile(path.join(active, 'unknown.txt'), 'utf8'), 'SYNTHETIC_KEEPER');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('bootstrap cancellation waits for its own process exit and keeps native output private', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-visual-cancel-')));
  const marker = path.join(directory, 'started');
  const controller = new AbortController();
  const child = runVisualChild(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],String(process.pid)); console.error("SYNTHETIC_PRIVATE_NATIVE_OUTPUT"); setInterval(()=>{},1000)', marker], { signal: controller.signal });
  // Attach rejection immediately; the expected abort must not become an
  // unhandled rejection while the fixture waits for its launch marker.
  const stopped = assert.rejects(child, error => error.code === 'VISUAL_BOOTSTRAP_FAILED' && !error.message.includes('SYNTHETIC_PRIVATE_NATIVE_OUTPUT'));
  try {
    for (let i = 0; i < 500; i++) {
      if (await fs.stat(marker).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const pid = Number(await fs.readFile(marker, 'utf8'));
    controller.abort(); await stopped;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { controller.abort(); await stopped; await fs.rm(directory, { recursive: true, force: true }); }
});
