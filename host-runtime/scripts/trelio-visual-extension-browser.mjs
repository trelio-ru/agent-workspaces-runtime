import { createBrowserRequestPacing, createBrowserTabBudget } from './trelio-browser-policy.mjs';
import { installTextObserver, validateTextResult, TEXT_KIND } from './trelio-browser-text.mjs';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { visualExtensionWorker, visualDocumentResponsePolicy } from './trelio-visual-extension-worker.mjs';
import { visualLinkRouter, visualAttachmentRouter } from './trelio-visual-link-router.mjs';
import { visualCookieState } from './trelio-visual-cookie-state.mjs';
import { installVisualAuthentication, normalizeVisualAuthentication, configureVisualAuthentication, authenticateVisualBrowser, hasVisualAuthenticationCredentials } from './trelio-visual-session.mjs';
import { ensureVisualChromium, prepareVisualPrivateDirectory, visualChildEnvironment } from './trelio-visual-bootstrap.mjs';
import { validVisualArguments, validVisualUploadFiles, visualStatus, normalizeBrowserVisualResult, validateVisualResult, VISUAL_RESULT_KIND, BROWSER_FILE_KIND } from './trelio-visual-result.mjs';
import { visualAttachmentFormat, MAX_ATTACHMENT_BYTES } from './trelio-visual-browser.mjs';
import { assertPrivatePathKind } from './trelio-workspace.mjs';
import { snapshotVisualProfile, restoreVisualProfile, prepareVisualProfileStartup } from './trelio-visual-profile.mjs';
import { ProtectedBrowserMailAttempt } from './trelio-browser-session.mjs';
import { acquireBrowserMailLock } from './trelio-browser-session.mjs';

// A public manifest identity fixes the extension Origin across private
// profiles. This is not a credential/signing secret; the independent random
// transport token is generated per launch and never committed or projected.
const PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwKPrbp7ylW5XVUNtVR2PDaIA2kv25iXiGrP/MmoU5T0j1+cg9wUHghUL9XFTe/XlADHXIQHovydsKcNrUvI2NzWfoQhdmfADfhRrBebR7vOsF551zdKLY5Kc8G9tjmJ5SqXNsiqZthvuoTD9WrjI9sypTG9bCiYPwZJ44PfJpKk7L7/ei4pQgkrO19+5/09ofA90Yn/fA1YAG8peUWcwFHqH5hE0q/U/ktWQJCAuahMXvGv2IloMoJ0zS9lqkfI01fn3lWkA48Hl/qcx6UKzUud5r6SHAUcR9XrCTXs5n/rY9b8SLCGOHz/ltKVhah9M4U1ALm17bvZRzRO8Cl+ESwIDAQAB';
const EXTENSION_ID = [...crypto.createHash('sha256').update(Buffer.from(PUBLIC_KEY, 'base64')).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
const fault = code => Object.assign(new Error(code), { code });

// Loopback belongs to the private transport, never the navigation/content
// policy. Explicit permission also covers Chrome Local Network Access checks;
// CSP restricts connections to the one random-port authenticated host server.
export function visualExtensionManifest(matches, port, observationMode = 'image', attachmentDownloads = false) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fault('invalid_input');
  return { manifest_version: 3, name: 'Trelio Visual Browser', version: '0.1.0', key: PUBLIC_KEY,
    permissions: ['debugger', 'tabs', 'cookies', 'declarativeNetRequest', 'webRequest'], host_permissions: [...new Set([...matches, 'http://127.0.0.1/*'])],
    content_security_policy: { extension_pages: `script-src 'self'; object-src 'self'; connect-src ws://127.0.0.1:${port}` },
    background: { service_worker: 'worker.js' }, content_scripts: [{ matches, js: ['link-router.js', 'authentication.js', ...(observationMode === 'text' ? ['text-observer.js'] : [])], run_at: 'document_start', world: 'ISOLATED' }, ...(attachmentDownloads ? [{ matches, js: ['attachment-router.js'], run_at: 'document_start', world: 'MAIN' }] : [])],
  };
}

export function visualNativeLogEvidence(text) {
  const counts = { osCryptErrors: 0, cookieErrors: 0, sqliteErrors: 0, networkSandboxErrors: 0 };
  for (const line of String(text).slice(-65536).split('\n')) {
    const end = line.indexOf(']'); if (end < 0) continue;
    const header = line.slice(0, end);
    if (!/\bERROR[:\]]/u.test(header)) continue;
    if (/os_crypt/iu.test(header)) counts.osCryptErrors++;
    if (/cookie/iu.test(header)) counts.cookieErrors++;
    if (/sqlite/iu.test(header)) counts.sqliteErrors++;
    if (/network.*sandbox|sandbox.*network/iu.test(header)) counts.networkSandboxErrors++;
  }
  return counts;
}

/** Private bounded delivery, independent of auth snapshots and browser close.
 * No server filename/path, raw HTTP header or URL becomes a local path. Fresh
 * files last 24h, at most 32/200 MiB per personal account; cleanup never follows
 * links, deletes unknown entries, or evicts a fresh file another tool may read.
 */
export async function saveVisualAttachment(directory, file, sessionId) {
  if (!file || Object.keys(file).sort().join() !== 'dataBase64,mimeType' || typeof file.dataBase64 !== 'string' || file.dataBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || file.dataBase64.length % 4) throw fault('attachment_unsupported');
  const bytes = Buffer.from(file.dataBase64, 'base64');
  try {
    // Canonical round-trip rejects whitespace/invalid alphabet/padding without
    // a quantified regex whose backtracking stack can grow with a 20 MiB file.
    if (bytes.toString('base64') !== file.dataBase64) throw fault('attachment_unsupported');
    const format = visualAttachmentFormat(bytes, file.mimeType);
    const root = path.join(directory, 'attachments');
    await prepareVisualPrivateDirectory(root);
    const entries = await fs.readdir(root);
    if (entries.length > 128) throw fault('attachment_limit_reached');
    let count = 0, total = 0;
    const now = Date.now(), ttl = 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!/^[0-9a-f-]{36}\.(?:pdf|png|jpg|gif|webp|tiff|bmp|doc|xls|ppt|docx|xlsx|pptx|odt|ods|odp|zip|txt|csv|rtf)$/u.test(entry)) throw fault('storage_unavailable');
      const target = path.join(root, entry); await assertPrivatePathKind(target, 'file');
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.nlink !== 1) throw fault('storage_unavailable');
      if (stat.mtimeMs + ttl <= now) await fs.unlink(target);
      else { count++; total += stat.size; }
    }
    if (count >= 32 || total + bytes.length > 200 * 1024 * 1024) throw fault('attachment_limit_reached');
    const filePath = path.join(root, `${crypto.randomUUID()}.${format.extension}`);
    const receipt = validateVisualResult({ kind: BROWSER_FILE_KIND, state: 'ready', reason: 'none', sessionId, filePath, sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mimeType: format.mimeType, expiresAt: now + ttl });
    let created = false;
    try {
      const handle = await fs.open(filePath, 'wx', 0o600); created = true;
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await assertPrivatePathKind(filePath, 'file');
      return receipt;
    } catch (error) { if (created) await fs.unlink(filePath).catch(() => {}); throw error; }
  } finally { bytes.fill(0); }
}

// Outgoing copies share the existing attachment lifecycle and private storage
// helpers. These bounds apply to local staging, never provider file formats.
export const MAX_VISUAL_UPLOAD_BYTES = 1024 ** 3;
export const MAX_VISUAL_UPLOAD_SESSION_BYTES = 2 * 1024 ** 3;

async function uploadSourceMetadata(file) {
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

const sameUploadFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
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
    const stat = await uploadSourceMetadata(file);
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
        if (!sameUploadFile(metadata[index], opened) || !sameUploadFile(opened, await uploadSourceMetadata(source))) throw fault('upload_file_changed');
        output = await fs.open(target, 'wx', 0o600);
        const hash = crypto.createHash('sha256');
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
        if (copied !== opened.size || !sameUploadFile(opened, await input.stat())
          || !sameUploadFile(opened, await uploadSourceMetadata(source))) throw fault('upload_file_changed');
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

/** Ordinary Chromium startup, with a closed pixels/input extension adapter.
 * There is no listening DevTools endpoint, arbitrary CDP/evaluate command,
 * arbitrary page projection, user-profile import or per-action app activation. */
export class ExtensionVisualBrowser {
  #child; #server; #wss; #socket; #directory; #profile; #pending = new Map();
  #state = 'not_configured'; #manual = false; #saved = false; #closed = false;
  #tail = Promise.resolve(); #deadline; #heartbeat; #terminal; #starting; #finishing;
  #launchAbort = new AbortController(); #extensionReady = false;
  #cookies; #sessionCookies = []; #authHandshake = false; #authSnapshotReady = false;
  #replaceSessionCookies = false;
  #windowsClosed = false;
  #credentialSetup; #setupReason;
  #authenticationTask; #mailAttempt;
  #uploadBytes = 0; #uploadFiles = 0;
  constructor({ dependencies, store, policy, origins, domains = [], lease, observationMode = 'image', attachmentDownloads = false, fileUploads = false, authentication = null, mailIdentity = null, testHeadless = false, testWindowController, testDiagnostics, testNativeLogging = true }) {
    if (!['image', 'text'].includes(observationMode) || typeof attachmentDownloads !== 'boolean' || typeof fileUploads !== 'boolean') throw fault('invalid_input');
    if ((testHeadless || testWindowController || testDiagnostics) && !policy.fixtureOnly) throw fault('invalid_input');
    if (lease.deadlineAt <= Date.now()) throw fault('lease_expired');
    Object.assign(this, { dependencies, store, policy, origins, domains, lease, testHeadless, testWindowController, testDiagnostics, observationMode, attachmentDownloads, fileUploads, mailIdentity });
    this.authentication = normalizeVisualAuthentication(authentication, { origins, fixtureOnly: policy.fixtureOnly });
    this.testNativeLogging = Boolean(testDiagnostics) && testNativeLogging;
    this.sessionId = crypto.randomUUID();
    this.#deadline = setTimeout(() => { void this.close().catch(() => this.abort()); }, lease.deadlineAt - Date.now());
    this.#deadline.unref();
  }
  #status(reason = 'none') {
    if (this.#mailAttempt && !this.#terminal && !this.#closed) return validateVisualResult(this.#mailAttempt.publicStatus());
    return visualStatus(this.#state, this.#terminal || this.#setupReason || reason, { sessionId: this.sessionId, hasStoredSession: this.#saved });
  }
  /** Called only by the separately authenticated host-private mail endpoint.
   * It cannot start an attempt, select a mailbox or submit arbitrary inputs.
   * The same actor/handle/fence is checked for every private transition.
   */
  async mailCall(message) {
    if (!message || Object.keys(message).some(key => !['operation', 'handle', 'actor', 'payload'].includes(key))
      || !this.#mailAttempt || this.#closed || Date.now() >= this.lease.deadlineAt) throw fault('authentication_mail_unavailable');
    const { operation, actor, handle, payload } = message;
    let value;
    if (operation === 'prepare' && payload === undefined) value = this.#mailAttempt.prepare(actor, handle);
    else if (operation === 'begin') value = await this.#mailAttempt.begin(actor, handle, payload);
    else if (operation === 'status' && payload === undefined) value = this.#mailAttempt.status(actor, handle);
    else if (operation === 'deliver' && payload && Object.keys(payload).sort().join() === 'code,reference') value = await this.#mailAttempt.deliver(actor, handle, payload);
    else if (operation === 'claim-ack') value = await this.#mailAttempt.claimAcknowledgement(actor, handle, payload);
    else if (operation === 'record-ack' && payload && Object.keys(payload).sort().join() === 'seenVerified,writeAttempted') value = await this.#mailAttempt.recordAcknowledgement(actor, handle, payload);
    else throw fault('authentication_mail_invalid');
    return { ok: true, ...value };
  }
  async #start(url, manual) {
    if (this.#child) return;
    this.#state = 'preparing'; this.#manual = manual; this.#extensionReady = false; this.#authHandshake = false; this.#authSnapshotReady = false; this.#windowsClosed = false;
    const snapshot = await this.store.read(); await this.store.prepare?.(); this.#saved = Boolean(snapshot);
    this.#cookies = visualCookieState({ origins: this.origins, domains: this.domains });
    this.#sessionCookies = this.#cookies.validate(snapshot?.sessionCookies ?? []);
    this.#replaceSessionCookies = Object.hasOwn(snapshot || {}, 'sessionCookies');
    if (this.#closed || Date.now() >= this.lease.deadlineAt) throw fault('lease_expired');
    this.#directory = await fs.mkdtemp(path.join(this.store.directory, 'extension-session-'));
    await prepareVisualPrivateDirectory(this.#directory);
    this.#profile = path.join(this.#directory, 'profile');
    await restoreVisualProfile(snapshot, this.#profile);
    await prepareVisualProfileStartup(this.#profile);
    const extension = path.join(this.#directory, 'extension'); await prepareVisualPrivateDirectory(extension);
    const token = crypto.randomBytes(32).toString('hex');
    this.#server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    this.#wss = new this.dependencies.WebSocketServer({ noServer: true, maxPayload: (this.attachmentDownloads ? 28 : 3) * 1024 * 1024, handleProtocols: protocols => protocols.has('trelio-visual-v1') ? 'trelio-visual-v1' : false });
    this.#server.on('upgrade', (req, socket, head) => {
      const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(v => v.trim());
      const candidate = protocols.find(value => /^[0-9a-f]{64}$/u.test(value));
      const validToken = candidate && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(candidate));
      if (req.url !== '/extension' || req.headers.origin !== `chrome-extension://${EXTENSION_ID}` || !validToken || this.#socket?.readyState === 1) { socket.destroy(); return; }
      this.#wss.handleUpgrade(req, socket, head, ws => {
        this.#socket = ws;
        ws.on('message', data => {
          let value; try { value = JSON.parse(data.toString()); } catch { ws.close(); return; }
          if (value.kind === 'auth_required' && !this.#authHandshake) {
            this.#authHandshake = true;
            // This local-only initialization never passes through call(), the
            // visual result validator or MCP. A reconnect cannot restore stale
            // auth over a live human session: each worker asks exactly once.
            void this.#send('restore-session-auth', { cookies: this.#sessionCookies, replace: this.#replaceSessionCookies }).catch(() => { this.#terminal ||= 'storage_unavailable'; this.#state = 'error'; });
            return;
          }
          if (value.kind === 'session_auth') {
            try { this.#sessionCookies = this.#cookies.validate(value.cookies); this.#authSnapshotReady = true; }
            catch { this.#terminal = 'storage_unavailable'; this.#state = 'error'; }
            return;
          }
          if (value.kind === 'auth_state_failed') { this.#terminal = 'storage_unavailable'; this.#state = 'error'; return; }
          if (value.kind === 'hello' && value.version === 1) { if (this.#authSnapshotReady) this.#extensionReady = true; else this.#terminal = 'bootstrap_failed'; return; }
          // Only fixed bootstrap stages can leave the extension on failure.
          // Never include native messages, paths, URLs or its transport token.
          if (value.kind === 'bootstrap_failed' && ['policy', 'policy_read', 'policy_write', 'window_inventory', 'auth', 'window'].includes(value.stage)) {
            this.testDiagnostics?.({ stage: value.stage }); this.#terminal = 'bootstrap_failed'; return;
          }
          if (value.kind === 'windows_closed') { this.testDiagnostics?.({ stage: 'windows_closed' }); this.#windowsClosed = true; if (this.#manual && !this.#closed) void this.#finishManual().catch(() => {}); return; }
          if (value.kind !== 'result' || typeof value.id !== 'string') return;
          const pending = this.#pending.get(value.id); if (!pending) return;
          this.#pending.delete(value.id); clearTimeout(pending.timer); pending.resolve(value.result);
        });
        ws.on('close', () => {
          if (this.#socket === ws) this.#socket = undefined;
          for (const [id, pending] of this.#pending) { clearTimeout(pending.timer); pending.reject(fault('operation_failed')); this.#pending.delete(id); }
        });
        ws.on('error', () => {});
      });
    });
    await new Promise(resolve => this.#server.listen(0, '127.0.0.1', resolve));
    const matches = [...this.origins.map(origin => `${origin}/*`), ...this.domains.map(domain => `https://*.${domain}/*`)];
    const config = { endpoint: `ws://127.0.0.1:${this.#server.address().port}/extension`, token, origins: this.origins, domains: this.domains, matches, initialUrl: url, manual, deadlineAt: this.lease.deadlineAt, observationMode: this.observationMode, attachmentDownloads: this.attachmentDownloads, fileUploads: this.fileUploads, authentication: Boolean(this.authentication), fixtureOnly: this.policy.fixtureOnly };
    const manifest = visualExtensionManifest(matches, this.#server.address().port, this.observationMode, this.attachmentDownloads);
    await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    // Only the ephemeral transport token is materialized here. Cookie values
    // stay in host/extension RAM and the AEAD snapshot, never in worker source.
    await fs.writeFile(path.join(extension, 'worker.js'), `(${visualExtensionWorker.toString()})(${JSON.stringify(config)}, (${visualCookieState.toString()})(${JSON.stringify({ origins: this.origins, domains: this.domains })}), ${createBrowserRequestPacing.toString()}, ${createBrowserTabBudget.toString()}, ${visualDocumentResponsePolicy.toString()});`, { mode: 0o600 });
    await fs.writeFile(path.join(extension, 'link-router.js'), `(${visualLinkRouter.toString()})();`, { mode: 0o600 });
    // Only the value-free signed recipe is materialized; credentials never
    // enter extension resources, process environment or command-line arguments.
    await fs.writeFile(path.join(extension, 'authentication.js'), `(${installVisualAuthentication.toString()})(${JSON.stringify(this.authentication)});`, { mode: 0o600 });
    if (this.attachmentDownloads) await fs.writeFile(path.join(extension, 'attachment-router.js'), `(${visualAttachmentRouter.toString()})();`, { mode: 0o600 });
    if (this.observationMode === 'text') await fs.writeFile(path.join(extension, 'text-observer.js'), `(${installTextObserver.toString()})();`, { mode: 0o600 });
    const executable = await ensureVisualChromium(this.dependencies, { signal: this.#launchAbort.signal });
    // A download/native vault wait does not grant a fresh launch budget. Do
    // not open a late window after close or the original signed deadline.
    if (this.#closed || Date.now() >= this.lease.deadlineAt) throw fault('lease_expired');
    // Ordinary startup: do not use Puppeteer.launch, remote-debugging switches,
    // enable-automation, or AutomationControlled feature overrides.
    // Keep the owned renderer responsive while another application is in the
    // foreground. These scheduling switches neither activate the window nor
    // alter navigator.webdriver; mouse-wheel acknowledgements otherwise stall
    // in an occluded headed renderer on macOS.
    // Windows/Linux start an ordinary internal new-tab window instead of relying on the
    // background-only lifetime of an application without an initial window.
    // The extension installs policy before navigating it; the provider URL and
    // private transport token never enter the process command line. Startup
    // may focus this owned window once, as agreed for visible workflows.
    // The extension privately navigates the internal new-tab surface after
    // policy. Private auth overlay separately preserves session-only cookies
    // on platforms where closing the last window ends the browser session.
    this.#child = spawn(executable, [`--user-data-dir=${this.#profile}`, `--load-extension=${extension}`, `--disable-extensions-except=${extension}`, '--silent-debugger-extension-api', '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--restore-last-session', '--window-size=1440,1000', ...(process.platform === 'darwin' ? ['--no-startup-window'] : []), ...(this.testHeadless ? ['--headless=new'] : []), ...(this.testNativeLogging ? ['--enable-logging', `--log-file=${path.join(this.#directory, 'native.log')}`] : [])], { env: visualChildEnvironment(), stdio: ['ignore', 'ignore', this.testNativeLogging ? 'pipe' : 'ignore'], windowsHide: true });
    // Fixture-only classification deliberately discards raw stderr. Even CI
    // must never print a worker resource, private path or loopback credential.
    let diagnosticTail = '', sandboxUnavailable = false, displayUnavailable = false, extensionUnavailable = false;
    this.#child.stderr?.on('data', chunk => {
      diagnosticTail = (diagnosticTail + chunk.toString()).slice(-8192);
      sandboxUnavailable ||= /No usable sandbox|Failed to move to new namespace|Running as root without --no-sandbox|sandbox.*Operation not permitted/iu.test(diagnosticTail);
      displayUnavailable ||= /Missing X server|cannot open display|failed to initialize.*platform/iu.test(diagnosticTail);
      extensionUnavailable ||= /Failed to load extension|Could not load.*manifest|Service worker registration failed/iu.test(diagnosticTail);
    });
    this.#child.once('error', () => { this.#terminal = 'bootstrap_failed'; this.#state = 'error'; });
    this.#child.once('exit', (code, signal) => {
      this.testDiagnostics?.({ stage: 'browser_exit', exitCode: code, signal, sandboxUnavailable, displayUnavailable, extensionUnavailable });
      if (this.#state === 'preparing') { this.#terminal = 'bootstrap_failed'; this.#state = 'error'; return; }
      // A normal human window close may finish auth; a crash/kill must retain
      // the previous durable snapshot and report loss instead of claiming save.
      if (!this.#closed && this.#manual && code === 0 && !signal) void this.#finishManual().catch(() => {});
      else if (!this.#closed && !this.#starting) { this.#terminal = 'browser_process_lost'; this.#state = 'error'; }
    });
    const until = Math.min(Date.now() + 25_000, this.lease.deadlineAt);
    while (!this.#extensionReady && !this.#terminal && !this.#closed && Date.now() < until) await sleep(100);
    if (this.#closed || Date.now() >= this.lease.deadlineAt) throw fault('lease_expired');
    if (!this.#extensionReady || this.#terminal) { await this.#nativeDiagnostics(); this.testDiagnostics?.({ stage: this.#socket ? 'extension_not_ready' : 'extension_not_connected', sandboxUnavailable, displayUnavailable, extensionUnavailable }); throw fault('bootstrap_failed'); }
    this.testWindowController?.({ tabs: () => this.#send('fixture-tab-budget'), running: () => Boolean(this.#child && this.#child.exitCode === null && this.#child.signalCode === null), close: () => this.#send('fixture-close-windows'), crash: () => this.#child?.kill('SIGKILL') });
    this.#heartbeat = setInterval(() => { void this.#send('heartbeat').catch(() => {}); }, 15_000); this.#heartbeat.unref();
    this.#state = manual ? 'manual_input_required' : 'saved_unverified';
  }
  #send(operation, args = {}) {
    if (!this.#socket || this.#socket.readyState !== 1) return Promise.reject(fault('operation_failed'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { this.#pending.delete(id); reject(fault('operation_failed')); }, 40_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, operation, args }));
    });
  }
  async #nativeDiagnostics() {
    if (!this.testNativeLogging || !this.#directory) return;
    let file;
    try {
      // GUI Chromium on Windows does not reliably write to stderr. Read only
      // a bounded tail of this synthetic fixture's private log, reduce it to
      // closed counters and discard every native message/path/token byte.
      file = await fs.open(path.join(this.#directory, 'native.log'), 'r');
      const size = (await file.stat()).size, bytes = Buffer.alloc(Math.min(size, 65536));
      try { await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length)); this.testDiagnostics({ stage: 'native_log', ...visualNativeLogEvidence(bytes.toString()) }); }
      finally { bytes.fill(0); }
    } catch { this.testDiagnostics({ stage: 'native_log_unavailable' }); }
    finally { await file?.close().catch(() => {}); }
  }
  async #stopBrowser() {
    clearInterval(this.#heartbeat);
    const child = this.#child; if (!child) return;
    if (this.#socket && this.#extensionReady && !this.#terminal && !this.#windowsClosed && child.exitCode === null) {
      try {
        const auth = await this.#send('snapshot-session-auth');
        if (auth.state !== 'saved_unverified') throw fault('storage_unavailable');
        this.#sessionCookies = this.#cookies.validate(auth.cookies);
      } catch (error) {
        // A human close may end the socket before this cleanup read. Its
        // already-streamed, frozen jar is authoritative; a crash is not.
        if (!this.#windowsClosed && child.exitCode !== 0) throw error;
      }
    }
    if (!this.#windowsClosed) await this.#send('close-windows').catch(() => {});
    // On macOS closing the last window may leave the ordinary app alive. Ask
    // this exact launched PID to quit through AppKit, without activation.
    if (process.platform === 'darwin' && child.exitCode === null && child.signalCode === null) {
      const script = 'ObjC.import("AppKit"); function run(a) { const app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(a[0])); return app.isNil() ? "not_found" : (app.terminate ? "accepted" : "refused"); }';
      // Closed fixture-only evidence distinguishes an absent LaunchServices
      // entry from an accepted quit which did not exit. No PID/path, stdout,
      // native error or auth bytes enter diagnostics; this is NOT a retry or
      // extra shutdown budget, and an unconfirmed stop still cannot save.
      let quitState = 'helper_failed';
      try {
        const result = await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, String(child.pid)], { env: visualChildEnvironment(), timeout: 5000 });
        const state = String(result.stdout).trim();
        if (['accepted', 'refused', 'not_found'].includes(state)) quitState = state;
      } catch {}
      this.testDiagnostics?.({ stage: 'browser_quit', state: quitState });
    }
    const until = Date.now() + 10_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < until) await sleep(100);
    if (child.exitCode === null && child.signalCode === null) {
      this.testDiagnostics?.({ stage: 'browser_stop_timeout' });
      throw fault('operation_failed');
    }
    await this.#nativeDiagnostics();
    if (child.exitCode !== 0 || child.signalCode) { this.#terminal = 'browser_process_lost'; this.#state = 'error'; }
    this.#child = undefined;
    this.#socket?.close(); this.#socket = undefined;
    this.#wss?.close(); this.#server?.close(); this.#server = undefined;
  }
  async #saveStopped() {
    if (!this.#profile) return;
    // A failed bootstrap, rejected auth state or crash cannot overwrite the
    // last durable session with an incomplete/guest replacement.
    if (this.#terminal) throw fault(this.#terminal);
    if (!this.#authSnapshotReady) throw fault('storage_unavailable');
    const snapshot = await snapshotVisualProfile(this.#profile);
    snapshot.sessionCookies = this.#cookies.validate(this.#sessionCookies);
    await this.store.write(snapshot); this.#saved = true;
    await fs.rm(this.#directory, { recursive: true, force: true }); this.#directory = undefined; this.#profile = undefined;
  }
  #finishManual() {
    if (this.#finishing) return this.#finishing;
    if (!this.#manual) return Promise.resolve(this.#status());
    this.#finishing = (async () => {
      this.#starting = true;
      try { await this.#stopBrowser(); await this.#saveStopped(); this.#manual = false; this.#state = 'saved_unverified'; return this.#status(); }
      catch (error) { this.#state = 'error'; this.#terminal = error.code === 'browser_process_lost' ? error.code : 'storage_unavailable'; throw error; }
      finally { this.#starting = false; this.#finishing = undefined; }
    })();
    return this.#finishing;
  }
  call(operation, args = {}) {
    // The browser API stays closed even when called by another signed provider
    // or an authenticated local client. Private transport commands are never
    // public aliases for model-selected debugger methods.
    if (this.observationMode !== 'text' && ['read-text', 'submit', 'request-ready'].includes(operation)) return Promise.resolve(visualStatus('error', 'invalid_input'));
    if (operation === 'download-attachment' && !this.attachmentDownloads) return Promise.resolve(visualStatus('error', 'invalid_input'));
    if (operation === 'upload-files' && !this.fileUploads) return Promise.resolve(visualStatus('error', 'invalid_input'));
    if (operation === 'submit') {
      const { action, ...input } = args || {};
      if (!['navigate', 'click', 'key'].includes(action) || (action === 'key' && input.key !== 'Enter') || !validVisualArguments(action, input)) return Promise.resolve(visualStatus('error', 'invalid_input'));
    }
    if (!validVisualArguments(operation, args)) return Promise.resolve(visualStatus('error', 'invalid_input'));
    if (operation === 'status') return Promise.resolve(this.#status());
    const result = this.#tail.then(async () => {
      if (this.#closed || Date.now() >= this.lease.deadlineAt) return visualStatus('error', 'lease_expired');
      if (this.#authenticationTask) return this.#status();
      if (this.#terminal) return this.#status();
      if (['credentials-setup', 'credentials-status', 'credentials-forget', 'authenticate'].includes(operation) && !this.authentication) return visualStatus('error', 'invalid_input');
      if (this.#credentialSetup) return this.#status();
      if (operation === 'credentials-setup') {
        this.#state = 'manual_input_required'; this.#setupReason = 'authentication_setup_required';
        // Detached status/wait observes the actual persisted completion. It
        // never needs a mandatory chat acknowledgement or returns secret data.
        this.#credentialSetup = configureVisualAuthentication({ store: this.store, definition: this.authentication, signal: this.#launchAbort.signal, setupTimeoutMs: Math.max(1, this.lease.deadlineAt - Date.now()) })
          .then(() => { this.#state = 'saved_unverified'; this.#setupReason = undefined; })
          .catch(error => {
            this.#state = 'error';
            this.#setupReason = error.code === 'PROTECTED_FORM_CANCELLED' ? 'authentication_cancelled'
              : error.code === 'REMOTE_MCP_CREDENTIAL_SETUP_TIMEOUT' ? 'authentication_timeout'
                : String(error.code || '').startsWith('VISUAL_STORAGE') ? 'storage_unavailable'
                  : 'authentication_setup_failed';
          })
          .finally(() => { this.#credentialSetup = undefined; });
        return this.#status();
      }
      this.#setupReason = undefined;
      if (operation === 'credentials-status') return visualStatus(await hasVisualAuthenticationCredentials(this.store, this.authentication) ? 'saved_unverified' : 'not_configured');
      if (operation === 'credentials-forget') { await this.store.forgetCredentials(); return visualStatus('not_configured'); }
      if (operation === 'authenticate-mail') {
        if (!this.#child || !this.authentication || !this.mailIdentity
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(args.mailAccountId || '')
          || !this.authentication.steps.some(step => step.fields?.emailOtp)) return visualStatus('error', 'invalid_input');
        if (this.#manual) return this.#status('manual_control_active');
        if (this.#mailAttempt) {
          const previous = this.#mailAttempt.publicStatus();
          if (!previous.authenticated || ['pending', 'unknown'].includes(previous.acknowledgement)) return this.#status();
          // A terminal, unambiguous prior login is independent of the next
          // one. Unknown ACKs keep their original journal/handle for read-back.
          this.#mailAttempt = undefined;
        }
        const mailStep = this.authentication.steps.find(step => step.fields?.emailOtp);
        const mailGuard = await acquireBrowserMailLock({ mailSkillId: mailStep.mail.skillId,
          mailAccountId: args.mailAccountId, browserScope: this.mailIdentity.scope,
          origin: this.mailIdentity.origin,
          expiresAt: Math.min(Date.now() + 120000, this.lease.deadlineAt),
          ...(this.policy.fixtureOnly ? { directory: this.store.directory } : {}) });
        this.#state = 'preparing';
        // Like protected setup, the original private attempt continues outside
        // the public command queue. Status returns its value-free mail handle;
        // ordinary browser input stays blocked while the signed mail worker
        // supplies the code through the independent private pipe endpoint.
        this.#authenticationTask = (async () => {
          await this.#send('authentication-start');
          const active = () => {
            if (this.#closed || Date.now() >= this.lease.deadlineAt) throw fault('lease_expired');
            mailGuard.assertActive();
          };
          let result;
          try {
            result = await authenticateVisualBrowser({ store: this.store, definition: this.authentication,
              method: 'email', active, send: (op, input) => this.#send(op, input),
              afterAuthentication: async authenticated => {
                try {
                  await this.#send('authentication-end', { success: authenticated });
                  this.#manual = !authenticated;
                  this.#state = authenticated ? 'saved_unverified' : 'manual_input_required';
                  await this.#mailAttempt?.finish(authenticated);
                } catch (error) {
                  await this.#mailAttempt?.finish(false).catch(() => {});
                  throw error;
                }
              },
              prepareMail: async ({ credentials, requestedAt, expiresAt }) => {
                if (this.#mailAttempt || credentials.attempt.mail) throw fault('authentication_mail_consumed');
                credentials.attempt.mail = {};
                const journal = credentials.attempt.mail, attemptId = credentials.attempt.id,
                  fingerprint = credentials.fingerprint;
                const persist = async () => {
                  // ACK can happen after authenticate() erased its RAM copy.
                  // Reopen the SAME encrypted record under the owned account,
                  // preserve its secrets and require the original attempt CAS.
                  const fresh = await this.store.readCredentials();
                  try {
                    if (!fresh || fresh.fingerprint !== fingerprint || fresh.attempt?.id !== attemptId) throw fault('authentication_mail_scope');
                    fresh.attempt.mail = structuredClone(journal);
                    await this.store.writeCredentials(fresh);
                  } finally {
                    if (fresh) { fresh.login = ''; fresh.password = ''; fresh.totp = ''; }
                  }
                };
                this.#mailAttempt = new ProtectedBrowserMailAttempt({ scope: this.mailIdentity.scope,
                  identity: this.mailIdentity, mailAccountId: args.mailAccountId, spec: mailStep.mail,
                  // Authentication input owns the short mailbox lock, but
                  // post-login ACK/read-back must survive its normal release.
                  // The same browser owner and absolute lease still gate every
                  // private request; the journal independently fences writes.
                  journal, persist, active: () => {
                    if (this.#closed || Date.now() >= this.lease.deadlineAt) throw fault('lease_expired');
                  }, requestedAt,
                  expiresAt: Math.min(expiresAt, this.lease.deadlineAt, mailGuard.expiresAt) });
                await this.#mailAttempt.start();
                return this.#mailAttempt.ready;
              }, requestMailCode: () => this.#mailAttempt.code });
          } catch { result = { state: 'manual_input_required', reason: 'authentication_unknown' }; }
          this.#manual = result.state !== 'saved_unverified';
          this.#state = result.state;
        })().catch(async () => {
          this.#manual = true; this.#state = 'manual_input_required'; this.#setupReason = 'authentication_unknown';
          this.#mailAttempt?.cancel('authentication_mail_unknown');
        }).finally(async () => {
          try { await mailGuard.release(); }
          catch { this.#terminal = 'storage_unavailable'; }
          finally { this.#authenticationTask = undefined; }
        });
        return this.#status();
      }
      if (operation === 'authenticate') {
        if (!this.#child) return visualStatus('error', 'session_closed');
        if (this.#manual) return this.#status('manual_control_active');
        await this.#send('authentication-start');
        let result;
        try {
          result = await authenticateVisualBrowser({ store: this.store, definition: this.authentication, send: (op, input) => this.#send(op, input), active: () => { if (this.#closed || Date.now() >= this.lease.deadlineAt) throw fault('lease_expired'); } });
        } catch (error) {
          result = { state: 'manual_input_required', reason: ['authentication_setup_required', 'lease_expired'].includes(error.code) ? error.code : 'authentication_unknown' };
        }
        // Uncertain input retains the observation gate. Only verified success
        // or an explicit human handoff can release this browser again.
        this.#manual = result.state !== 'saved_unverified';
        await this.#send('authentication-end', { success: !this.#manual });
        this.#state = result.state;
        return visualStatus(result.state, result.reason, { sessionId: this.sessionId, hasStoredSession: this.#saved });
      }
      if (operation === 'ready') return this.#manual ? this.#finishManual() : this.#status();
      if (operation === 'show-login') { if (this.#manual && this.#child) await this.#send('manual'); return this.#status(); }
      if (operation === 'setup' || operation === 'navigate') this.policy.navigate(args.url);
      if (operation === 'setup' && this.#manual) { await this.#send('manual'); return this.#status(); }
      if (operation === 'setup' && this.#child) {
        this.#manual = true; this.#state = 'manual_input_required';
        await this.#send('manual'); return this.#status();
      }
      let fresh = false;
      if (!this.#child) {
        if (!['setup', 'navigate'].includes(operation)) return visualStatus('error', 'session_closed');
        await this.#start(args.url, operation === 'setup');
        fresh = true;
      }
      if (this.#manual) return this.#status(operation === 'setup' ? 'none' : 'manual_control_active');
      if (operation === 'upload-files') {
        if (this.#uploadFiles + args.files.length > 256) throw fault('upload_limit_reached');
        // Freeze complete regular files before clicking a website. Only these
        // owned immutable paths reach the private extension. Keep copies until
        // normal browser cleanup even on an unknown input outcome: File reads
        // can happen asynchronously after the chooser response.
        const frozen = await freezeVisualUploads({ directory: this.#directory, files: args.files,
          deadlineAt: this.lease.deadlineAt, signal: this.#launchAbort.signal,
          remainingBytes: MAX_VISUAL_UPLOAD_SESSION_BYTES - this.#uploadBytes });
        this.#uploadBytes += frozen.sizeBytes; this.#uploadFiles += frozen.files.length;
        args = { ...args, files: frozen.files.map(file => file.filePath) };
      }
      if (fresh) await sleep(500);
      const value = await this.#send(fresh && operation === 'navigate' ? (this.observationMode === 'text' ? 'read-text' : 'screenshot') : operation, args);
      if (value.state === 'error') return visualStatus('error', value.reason, { sessionId: this.sessionId, ...(value.reason === 'http_document_failure' ? { httpStatus: value.httpStatus, origin: value.origin } : {}) });
      if (value.state !== 'ready') throw fault('operation_failed');
      this.#state = 'ready';
      if (operation === 'download-attachment') {
        if (this.#closed || Date.now() >= this.lease.deadlineAt) throw fault('lease_expired');
        if (Object.keys(value).sort().join() !== 'file,state') throw fault('attachment_unsupported');
        return await saveVisualAttachment(this.store.directory, value.file, this.sessionId);
      }
      const response = { kind: value.kind || VISUAL_RESULT_KIND, sessionId: this.sessionId, reason: 'none', ...value };
      return value.kind === TEXT_KIND ? validateTextResult(response) : normalizeBrowserVisualResult(response);
    });
    this.#tail = result.catch(() => {});
    return result.catch(error => {
      const reason = ['invalid_input', 'navigation_blocked', 'bootstrap_failed', 'lease_expired', 'attachment_unsupported', 'attachment_too_large', 'attachment_limit_reached', 'upload_file_invalid', 'upload_file_changed', 'upload_too_large', 'upload_limit_reached', 'upload_timed_out', 'storage_unavailable', 'authentication_setup_required', 'authentication_mail_busy'].includes(error.code) ? error.code : String(error.code || '').startsWith('VISUAL_STORAGE') ? 'storage_unavailable' : 'operation_failed';
      if (this.#state === 'preparing') { this.#state = 'error'; this.#terminal = reason; }
      return visualStatus('error', reason, { sessionId: this.sessionId, hasStoredSession: this.#saved });
    });
  }
  async close() {
    if (this.#closed) return; this.#closed = true; clearTimeout(this.#deadline);
    this.#launchAbort.abort();
    this.#mailAttempt?.cancel();
    this.testDiagnostics?.({ stage: 'close_queue' });
    await this.#tail;
    await this.#credentialSetup;
    await this.#authenticationTask;
    // A window-close completion can have started outside the command queue.
    // Join it before cleanup so expiry/close cannot race a second save/remove.
    this.testDiagnostics?.({ stage: 'close_manual' });
    await this.#finishing?.catch(() => {});
    this.#starting = true;
    try {
      this.testDiagnostics?.({ stage: 'close_browser' });
      await this.#stopBrowser();
      this.testDiagnostics?.({ stage: 'close_snapshot' });
      if (this.#terminal !== 'browser_process_lost') await this.#saveStopped();
    }
    finally {
      // Failure to flush/stop must not leave this session's browser running.
      // Abort owns only our ChildProcess; it neither kills a PID from disk nor
      // overwrites the last durable auth snapshot with a crash replacement.
      if (this.#child && this.#child.exitCode === null && this.#child.signalCode === null) this.abort();
      clearInterval(this.#heartbeat); this.#sessionCookies = []; this.store.close(); this.#state = 'closed';
    }
  }
  abort() {
    this.#closed = true; clearTimeout(this.#deadline); clearInterval(this.#heartbeat);
    this.#launchAbort.abort();
    this.#mailAttempt?.cancel();
    const child = this.#child; if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    this.#socket?.terminate(); this.#wss?.close(); this.#server?.close(); this.#sessionCookies = []; this.store.close();
  }
}
