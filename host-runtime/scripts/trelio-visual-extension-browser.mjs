import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { visualExtensionWorker } from './trelio-visual-extension-worker.mjs';
import { visualLinkRouter } from './trelio-visual-link-router.mjs';
import { ensureVisualChromium, prepareVisualPrivateDirectory, visualChildEnvironment } from './trelio-visual-bootstrap.mjs';
import { visualStatus, validateVisualResult, VISUAL_RESULT_KIND } from './trelio-visual-result.mjs';
import { snapshotVisualProfile, restoreVisualProfile, prepareVisualProfileStartup } from './trelio-visual-profile.mjs';

// A public manifest identity fixes the extension Origin across private
// profiles. This is not a credential/signing secret; the independent random
// transport token is generated per launch and never committed or projected.
const PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwKPrbp7ylW5XVUNtVR2PDaIA2kv25iXiGrP/MmoU5T0j1+cg9wUHghUL9XFTe/XlADHXIQHovydsKcNrUvI2NzWfoQhdmfADfhRrBebR7vOsF551zdKLY5Kc8G9tjmJ5SqXNsiqZthvuoTD9WrjI9sypTG9bCiYPwZJ44PfJpKk7L7/ei4pQgkrO19+5/09ofA90Yn/fA1YAG8peUWcwFHqH5hE0q/U/ktWQJCAuahMXvGv2IloMoJ0zS9lqkfI01fn3lWkA48Hl/qcx6UKzUud5r6SHAUcR9XrCTXs5n/rY9b8SLCGOHz/ltKVhah9M4U1ALm17bvZRzRO8Cl+ESwIDAQAB';
const EXTENSION_ID = [...crypto.createHash('sha256').update(Buffer.from(PUBLIC_KEY, 'base64')).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
const fault = code => Object.assign(new Error(code), { code });

// Loopback belongs to the private transport, never the navigation/content
// policy. Explicit permission also covers Chrome Local Network Access checks;
// CSP restricts connections to the one random-port authenticated host server.
export function visualExtensionManifest(matches, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fault('invalid_input');
  return { manifest_version: 3, name: 'Trelio Visual Browser', version: '0.1.0', key: PUBLIC_KEY,
    permissions: ['debugger', 'tabs', 'declarativeNetRequest', 'webRequest'], host_permissions: [...new Set([...matches, 'http://127.0.0.1/*'])],
    content_security_policy: { extension_pages: `script-src 'self'; object-src 'self'; connect-src ws://127.0.0.1:${port}` },
    background: { service_worker: 'worker.js' }, content_scripts: [{ matches, js: ['link-router.js'], run_at: 'document_start', world: 'ISOLATED' }],
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
const fields = { status: [], ready: [], 'show-login': [], screenshot: [], setup: ['url'], navigate: ['url'], click: ['frameId', 'x', 'y'], scroll: ['frameId', 'x', 'y', 'deltaY', 'deltaX'], 'type-text': ['frameId', 'text'], key: ['frameId', 'key'] };
const validArguments = (operation, args) => Object.hasOwn(fields, operation) && args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).every(key => fields[operation].includes(key)) && Buffer.byteLength(JSON.stringify(args)) <= 32_768;

/** Ordinary Chromium startup, with a closed pixels/input extension adapter.
 * There is no listening DevTools endpoint, arbitrary CDP/evaluate command,
 * page text projection, user-profile import or per-action app activation. */
export class ExtensionVisualBrowser {
  #child; #server; #wss; #socket; #directory; #profile; #pending = new Map();
  #state = 'not_configured'; #manual = false; #saved = false; #closed = false;
  #tail = Promise.resolve(); #deadline; #heartbeat; #terminal; #starting; #finishing;
  #launchAbort = new AbortController(); #extensionReady = false;
  constructor({ dependencies, store, policy, origins, domains = [], lease, testHeadless = false, testWindowController, testDiagnostics }) {
    if ((testHeadless || testWindowController || testDiagnostics) && !policy.fixtureOnly) throw fault('invalid_input');
    if (lease.deadlineAt <= Date.now()) throw fault('lease_expired');
    Object.assign(this, { dependencies, store, policy, origins, domains, lease, testHeadless, testWindowController, testDiagnostics });
    this.sessionId = crypto.randomUUID();
    this.#deadline = setTimeout(() => { void this.close().catch(() => this.abort()); }, lease.deadlineAt - Date.now());
    this.#deadline.unref();
  }
  #status(reason = 'none') { return visualStatus(this.#state, this.#terminal || reason, { sessionId: this.sessionId, hasStoredSession: this.#saved }); }
  async #start(url, manual) {
    if (this.#child) return;
    this.#state = 'preparing'; this.#manual = manual; this.#extensionReady = false;
    const snapshot = await this.store.read(); await this.store.prepare?.(); this.#saved = Boolean(snapshot);
    if (this.#closed || Date.now() >= this.lease.deadlineAt) throw fault('lease_expired');
    this.#directory = await fs.mkdtemp(path.join(this.store.directory, 'extension-session-'));
    await prepareVisualPrivateDirectory(this.#directory);
    this.#profile = path.join(this.#directory, 'profile');
    await restoreVisualProfile(snapshot, this.#profile);
    await prepareVisualProfileStartup(this.#profile);
    const extension = path.join(this.#directory, 'extension'); await prepareVisualPrivateDirectory(extension);
    const token = crypto.randomBytes(32).toString('hex');
    this.#server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    this.#wss = new this.dependencies.WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024, handleProtocols: protocols => protocols.has('trelio-visual-v1') ? 'trelio-visual-v1' : false });
    this.#server.on('upgrade', (req, socket, head) => {
      const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(v => v.trim());
      const candidate = protocols.find(value => /^[0-9a-f]{64}$/u.test(value));
      const validToken = candidate && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(candidate));
      if (req.url !== '/extension' || req.headers.origin !== `chrome-extension://${EXTENSION_ID}` || !validToken || this.#socket?.readyState === 1) { socket.destroy(); return; }
      this.#wss.handleUpgrade(req, socket, head, ws => {
        this.#socket = ws;
        ws.on('message', data => {
          let value; try { value = JSON.parse(data.toString()); } catch { ws.close(); return; }
          if (value.kind === 'hello' && value.version === 1) { this.#extensionReady = true; return; }
          // Only fixed bootstrap stages can leave the extension on failure.
          // Never include native messages, paths, URLs or its transport token.
          if (value.kind === 'bootstrap_failed' && ['policy', 'window'].includes(value.stage)) {
            this.testDiagnostics?.({ stage: value.stage }); this.#terminal = 'bootstrap_failed'; return;
          }
          if (value.kind === 'windows_closed') { if (this.#manual && !this.#closed) void this.#finishManual().catch(() => {}); return; }
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
    const config = { endpoint: `ws://127.0.0.1:${this.#server.address().port}/extension`, token, origins: this.origins, domains: this.domains, matches, initialUrl: url, manual, deadlineAt: this.lease.deadlineAt };
    const manifest = visualExtensionManifest(matches, this.#server.address().port);
    await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    await fs.writeFile(path.join(extension, 'worker.js'), `(${visualExtensionWorker.toString()})(${JSON.stringify(config)});`, { mode: 0o600 });
    await fs.writeFile(path.join(extension, 'link-router.js'), `(${visualLinkRouter.toString()})();`, { mode: 0o600 });
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
    // policy. Fresh profile preferences above preserve session cookies even
    // on platforms where closing the last window ends the browser session.
    this.#child = spawn(executable, [`--user-data-dir=${this.#profile}`, `--load-extension=${extension}`, `--disable-extensions-except=${extension}`, '--silent-debugger-extension-api', '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--restore-last-session', '--window-size=1440,1000', ...(process.platform === 'darwin' ? ['--no-startup-window'] : []), ...(this.testHeadless ? ['--headless=new'] : []), ...(this.testDiagnostics ? ['--enable-logging', `--log-file=${path.join(this.#directory, 'native.log')}`] : [])], { env: visualChildEnvironment(), stdio: ['ignore', 'ignore', this.testDiagnostics ? 'pipe' : 'ignore'], windowsHide: true });
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
    this.testWindowController?.({ close: () => this.#send('close-windows'), crash: () => this.#child?.kill('SIGKILL') });
    this.#heartbeat = setInterval(() => { void this.#send('heartbeat').catch(() => {}); }, 15_000); this.#heartbeat.unref();
    this.#state = manual ? 'manual_input_required' : 'saved_unverified';
  }
  #send(operation, args = {}) {
    if (!this.#socket || this.#socket.readyState !== 1) return Promise.reject(fault('operation_failed'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { this.#pending.delete(id); reject(fault('operation_failed')); }, 20_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, operation, args }));
    });
  }
  async #nativeDiagnostics() {
    if (!this.testDiagnostics || !this.#directory) return;
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
    await this.#send('close-windows').catch(() => {});
    // On macOS closing the last window may leave the ordinary app alive. Ask
    // this exact launched PID to quit through AppKit, without activation.
    if (process.platform === 'darwin' && child.exitCode === null && child.signalCode === null) {
      const script = 'ObjC.import("AppKit"); function run(a) { const app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(a[0])); if(app) app.terminate; }';
      await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, String(child.pid)], { env: visualChildEnvironment(), timeout: 5000 }).catch(() => {});
    }
    const until = Date.now() + 10_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < until) await sleep(100);
    if (child.exitCode === null && child.signalCode === null) throw fault('operation_failed');
    await this.#nativeDiagnostics();
    if (child.exitCode !== 0 || child.signalCode) { this.#terminal = 'browser_process_lost'; this.#state = 'error'; }
    this.#child = undefined;
    this.#socket?.close(); this.#socket = undefined;
    this.#wss?.close(); this.#server?.close(); this.#server = undefined;
  }
  async #saveStopped() {
    if (!this.#profile) return;
    if (this.#terminal === 'browser_process_lost') throw fault('browser_process_lost');
    const snapshot = await snapshotVisualProfile(this.#profile); await this.store.write(snapshot); this.#saved = true;
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
    if (!validArguments(operation, args)) return Promise.resolve(visualStatus('error', 'invalid_input'));
    if (operation === 'status') return Promise.resolve(this.#status());
    const result = this.#tail.then(async () => {
      if (this.#closed || Date.now() >= this.lease.deadlineAt) return visualStatus('error', 'lease_expired');
      if (this.#terminal) return this.#status();
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
      if (fresh) await sleep(500);
      const value = await this.#send(fresh && operation === 'navigate' ? 'screenshot' : operation, args);
      if (value.state === 'error') return visualStatus('error', value.reason, { sessionId: this.sessionId, ...(value.reason === 'http_document_failure' ? { httpStatus: value.httpStatus, origin: value.origin } : {}) });
      if (value.state !== 'ready') throw fault('operation_failed');
      this.#state = 'ready';
      return validateVisualResult({ kind: VISUAL_RESULT_KIND, sessionId: this.sessionId, reason: 'none', ...value });
    });
    this.#tail = result.catch(() => {});
    return result.catch(error => {
      const reason = ['invalid_input', 'navigation_blocked', 'bootstrap_failed', 'lease_expired'].includes(error.code) ? error.code : String(error.code || '').startsWith('VISUAL_STORAGE') ? 'storage_unavailable' : 'operation_failed';
      if (this.#state === 'preparing') { this.#state = 'error'; this.#terminal = reason; }
      return visualStatus('error', reason, { sessionId: this.sessionId, hasStoredSession: this.#saved });
    });
  }
  async close() {
    if (this.#closed) return; this.#closed = true; clearTimeout(this.#deadline);
    this.#launchAbort.abort();
    await this.#tail;
    // A window-close completion can have started outside the command queue.
    // Join it before cleanup so expiry/close cannot race a second save/remove.
    await this.#finishing?.catch(() => {});
    this.#starting = true;
    try { await this.#stopBrowser(); if (this.#terminal !== 'browser_process_lost') await this.#saveStopped(); }
    finally { clearInterval(this.#heartbeat); this.store.close(); this.#state = 'closed'; }
  }
  abort() {
    this.#closed = true; clearTimeout(this.#deadline); clearInterval(this.#heartbeat);
    this.#launchAbort.abort();
    const child = this.#child; if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    this.#socket?.terminate(); this.#wss?.close(); this.#server?.close(); this.store.close();
  }
}
