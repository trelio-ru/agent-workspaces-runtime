import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";

import {
  BROWSER_SESSION_API_VERSION,
  BrowserSessionError,
  DEFAULT_LEASE_MS,
  MAX_LEASE_MS,
  PLAYWRIGHT_VERSION,
  assertManualAssistAllowed,
  bootstrapPlaywright,
  browserExecutableCandidates,
  defaultBrowserExecutable,
  inspectBrowserRuntime,
  npmCliCandidates,
  readBrowserSessionBinding,
  resolveNpmInvocation,
  backgroundPersistentLaunchOptions,
  createBackgroundPersistentPage,
  withPersistentBrowserSession,
  browserExecutionOwner, browserExecutionDirectory, browserSnapshotRevision,
  withBrowserAccountState, saveBrowserAccountSnapshot,
  prepareParallelBrowserProfile,
  withSharedAccountService, skillResourcePolicy,
} from "../host-runtime/scripts/trelio-browser-session.mjs";

test('chat ownership separates live control roots while preserving the reusable account root', () => {
  const root = path.resolve(os.tmpdir(), 'synthetic-account');
  const a = { TRELIO_SKILL_RUNTIME_SESSION_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const b = { TRELIO_SKILL_RUNTIME_SESSION_ID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  assert.notEqual(browserExecutionDirectory(root, a), browserExecutionDirectory(root, b));
  assert.equal(browserExecutionDirectory(root, a), browserExecutionDirectory(root, { ...a, CODEX_THREAD_ID: 'foreign' }));
  assert.equal(browserExecutionDirectory(root, {}), root, 'unobserved clients never borrow an inherited chat');
  assert.equal(browserExecutionOwner({ CODEX_THREAD_ID: a.TRELIO_SKILL_RUNTIME_SESSION_ID }), null);
  assert.throws(() => browserExecutionDirectory(root, { TRELIO_SKILL_RUNTIME_SESSION_ID: '../foreign' }), { code: 'BROWSER_SESSION_OWNER_INVALID' });
});

test('concurrent saved-state writers preserve the newer snapshot and retain the losing ciphertext', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trelio-snapshot-race-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let current = 'synthetic-encrypted-base';
  const revision = browserSnapshotRevision(current), retained = [];
  const save = bytes => saveBrowserAccountSnapshot({ accountDirectory: root, revision, bytes,
    read: async () => current, write: async value => { current = value; },
    retain: async value => retained.push(value) });
  const results = await Promise.all([save('synthetic-encrypted-a'), save('synthetic-encrypted-b')]);
  assert.equal(results.filter(result => result.published).length, 1);
  assert.equal(retained.length, 1);
  assert.notEqual(retained[0], current);
  let attempts = 0;
  await assert.rejects(withBrowserAccountState(root, () => { attempts++; throw Error('synthetic-write-failure'); }), /synthetic-write-failure/);
  assert.equal(attempts, 1, 'the queue never retries a failed operation');
});

test('a provider reconciles only independently fenced metadata while preserving newer account state', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trelio-state-reconcile-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let current = 'synthetic-newer-encrypted-state', calls = 0;
  const result = await saveBrowserAccountSnapshot({ accountDirectory: root,
    revision: browserSnapshotRevision('synthetic-old-base'), bytes: 'synthetic-refusal',
    read: async () => current, write: async bytes => { current = bytes; },
    retain: async () => assert.fail('critical metadata is reconciled rather than discarded'),
    reconcile: async (saved, candidate) => {
      calls++; assert.equal(saved, 'synthetic-newer-encrypted-state'); assert.equal(candidate, 'synthetic-refusal');
      return 'synthetic-newer-state-and-refusal';
    },
  });
  assert.equal(result.published, true); assert.equal(calls, 1);
  assert.equal(current, 'synthetic-newer-state-and-refusal');
});

test('persistent browser forks keep native auth stores and isolate two chats without copying history', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trelio-profile-forks-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDirectory = path.join(root, 'state', 'chrome-profile'), lockPath = path.join(root, 'locks', 'browser.lock');
  fs.mkdirSync(path.join(profileDirectory, 'Default', 'LocalStorage'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(profileDirectory, 'Default', 'LocalStorage', 'state'), 'synthetic-base');
  fs.writeFileSync(path.join(profileDirectory, 'Default', 'History'), 'synthetic-history');
  const env = id => ({ ...bindingEnvironment(), TRELIO_SKILL_RUNTIME_SESSION_ID: id });
  const [a, b] = await Promise.all([
    prepareParallelBrowserProfile({ profileDirectory, lockPath, environment: env('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') }),
    prepareParallelBrowserProfile({ profileDirectory, lockPath, environment: env('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') }),
  ]);
  assert.notEqual(a.profileDirectory, b.profileDirectory);
  assert.notEqual(a.lockPath, b.lockPath);
  const state = fork => path.join(fork.profileDirectory, 'Default', 'LocalStorage', 'state');
  assert.equal(fs.readFileSync(state(a), 'utf8'), 'synthetic-base');
  assert.equal(fs.existsSync(path.join(a.profileDirectory, 'Default', 'History')), false);
  fs.writeFileSync(state(a), 'synthetic-new-login');
  fs.writeFileSync(state(b), 'synthetic-late-login');
  await a.publish(); await b.publish();
  const c = await prepareParallelBrowserProfile({ profileDirectory, lockPath,
    environment: env('cccccccc-cccc-4ccc-8ccc-cccccccccccc') });
  assert.equal(fs.readFileSync(state(c), 'utf8'), 'synthetic-new-login');
  await b.initialize();
  assert.equal(fs.readFileSync(state(b), 'utf8'), 'synthetic-late-login', 'a stale publisher retains its own complete profile');
  assert.equal(fs.existsSync(a.profileDirectory), false, 'a stopped saved working copy is disposed');
  assert.equal(fs.readFileSync(state(b), 'utf8'), 'synthetic-late-login', 'disposing one chat never closes/removes its sibling');
});

test('shared protocol service gives chats separate leases, queues requests and never replays a lost final stop', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trelio-shared-device-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serviceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let phase = 'ready', requests = 0, inFlight = 0, stops = 0, starts = 0;
  const start = async () => ({ phase, sessionId: serviceId, expiresAt: Date.now() + 60000, reused: starts++ > 0 });
  const dispatch = async (operation, physical) => {
    assert.equal(physical, serviceId);
    if (operation === 'stop') { stops++; phase = 'closed'; throw Error('synthetic-lost-stop-result'); }
    if (operation === 'request') {
      inFlight++; assert.equal(inFlight, 1, 'one indivisible protocol request at a time');
      await new Promise(resolve => setTimeout(resolve, 20)); requests++; inFlight--;
    }
    return { phase, sessionId: physical };
  };
  const call = (owner, operation, sessionId) => withSharedAccountService({ accountDirectory: root,
    environment: { TRELIO_SKILL_RUNTIME_SESSION_ID: owner }, operation, sessionId, start, dispatch });
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const first = await call(a, 'start'), second = await call(b, 'start');
  assert.notEqual(first.sessionId, second.sessionId);
  await Promise.all([call(a, 'request', first.sessionId), call(b, 'request', second.sessionId)]);
  assert.equal(requests, 2);
  await assert.rejects(call(a, 'stop', second.sessionId), { code: 'BROWSER_SESSION_OWNER_INVALID' });
  assert.equal((await call(a, 'stop', first.sessionId)).phase, 'closed');
  assert.equal(stops, 0, 'a sibling still owns the physical connection');
  assert.equal((await call(b, 'request', second.sessionId)).phase, 'ready');
  await assert.rejects(call(b, 'stop', second.sessionId), /synthetic-lost-stop-result/);
  assert.equal((await call(b, 'stop', second.sessionId)).phase, 'closed');
  assert.equal(stops, 1, 'the retained closing fence permits only status reconciliation');
});

test('a shared physical screen invalidates sibling observations before dispatch, including unknown input', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trelio-screen-generation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const physical = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const owners = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  let calls = 0, unknown = false, image = false, starts = 0;
  const call = (owner, operation, sessionId, changesState = false) => withSharedAccountService({
    accountDirectory: root, environment: { TRELIO_SKILL_RUNTIME_SESSION_ID: owner }, operation, sessionId,
    start: async () => ({ sessionId: physical, expiresAt: Date.now() + 60000, phase: 'ready', image: true, reused: starts++ > 0 }),
    dispatch: async () => { calls++; if (unknown) throw Error('synthetic-unknown-input'); return { sessionId: physical, phase: 'ready', image }; },
    changesState, requiresFreshObservation: changesState, observesResult: value => value.image === true,
  });
  const a = await call(owners[0], 'start'), b = await call(owners[1], 'start');
  unknown = true;
  await assert.rejects(call(owners[0], 'request', a.sessionId, true), /synthetic-unknown-input/);
  const before = calls;
  await assert.rejects(call(owners[1], 'request', b.sessionId, true), { code: 'BROWSER_SESSION_OBSERVATION_STALE' });
  assert.equal(calls, before, 'stale input never reaches the provider');
  unknown = false; image = true;
  await call(owners[1], 'request', b.sessionId);
  await call(owners[1], 'request', b.sessionId, true);
  assert.equal(calls, before + 2, 'only a fresh observation permits one next input');
});

test('resource scheduling is declared only by exact signed inventory, with closed scope and schema', () => {
  const parsed = value => ({ capabilities: ['local-session'], files: [{ path: 'trelio-execution-resource.json', mode: 0o644, bytes: Buffer.from(JSON.stringify(value)) }] });
  assert.equal(skillResourcePolicy({ files: [], capabilities: ['local-session'] }), null);
  assert.deepEqual(skillResourcePolicy(parsed({ schemaVersion: 1, scope: 'account' })), { schemaVersion: 1, scope: 'account' });
  assert.equal(skillResourcePolicy(parsed({ schemaVersion: 1, scope: 'device' }), ['guides']), null);
  for (const value of [{ schemaVersion: 2, scope: 'account' }, { schemaVersion: 1, scope: 'chat' },
    { schemaVersion: 1, scope: 'device', bypass: true }]) {
    assert.throws(() => skillResourcePolicy(parsed(value)), { code: 'BROWSER_SESSION_RESOURCE_POLICY_INVALID' });
  }
  const duplicate = parsed({ schemaVersion: 1, scope: 'account' }); duplicate.files.push(duplicate.files[0]);
  assert.throws(() => skillResourcePolicy(duplicate), { code: 'BROWSER_SESSION_RESOURCE_POLICY_INVALID' });
});

test('unregistered native services never become another chats stop authority', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trelio-legacy-service-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let dispatches = 0;
  const options = { accountDirectory: root, environment: { TRELIO_SKILL_RUNTIME_SESSION_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    start: async () => ({ phase: 'ready', sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expiresAt: Date.now() + 60000, reused: true }),
    dispatch: async () => { dispatches++; assert.fail('legacy service must not be stopped'); } };
  await assert.rejects(withSharedAccountService({ ...options, operation: 'start' }), { code: 'BROWSER_SESSION_UNREGISTERED_SERVICE' });
  await assert.rejects(withSharedAccountService({ ...options, operation: 'stop', sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }), { code: 'BROWSER_SESSION_OWNER_INVALID' });
  assert.equal(dispatches, 0);
});

test('cancelling an account-state waiter neither enters its callback nor disturbs the owner', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trelio-cancel-state-wait-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const first = withBrowserAccountState(root, async () => { entered(); await held; return 'owner-finished'; });
  await started;
  const controller = new AbortController();
  const waiting = withBrowserAccountState(root, () => assert.fail('cancelled waiter cannot run'), { signal: controller.signal });
  const refusal = assert.rejects(waiting, { name: 'AbortError' });
  controller.abort(); await refusal;
  release(); assert.equal(await first, 'owner-finished');
});

const bindingEnvironment = (overrides = {}) => {
  const startedAt = Date.now();
  const policy = {
    apiVersion: BROWSER_SESSION_API_VERSION,
    sessionClass: "messenger-profile",
    leaseMs: DEFAULT_LEASE_MS,
    manualAssist: true,
    ...overrides,
  };
  return {
    TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify(policy),
    TRELIO_BROWSER_SESSION_STARTED_AT: String(startedAt),
    TRELIO_BROWSER_SESSION_DEADLINE_AT: String(startedAt + policy.leaseMs),
  };
};

test("inactive persistent launch suppresses the initial foreground page without changing the profile", () => {
  const options = backgroundPersistentLaunchOptions("/owned/profile", ["--disable-notifications"]);
  assert.equal(options.ignoreDefaultArgs, true);
  assert.equal(options.viewport, null);
  assert.ok(options.args.includes("--user-data-dir=/owned/profile"));
  assert.ok(options.args.includes("--remote-debugging-pipe"));
  assert.ok(options.args.includes("--no-startup-window"));
  assert.ok(options.args.includes("--disable-notifications"));
  assert.ok(options.args.every((argument) => argument.startsWith("--")));
  for (const argument of ["about:blank", "--user-data-dir=/other", "--remote-debugging-port=9222", "--app=https://example.test", "--restore-last-session", "--headless", "--start-minimized"]) {
    assert.throws(() => backgroundPersistentLaunchOptions("/owned/profile", [argument]),
      (error) => error.code === "BROWSER_SESSION_BACKGROUND_ARGUMENT_INVALID");
  }
});

test("synthetic headed persistent launch and browser actions preserve macOS foreground PID", {
  skip: process.platform !== "darwin" || process.env.TRELIO_BROWSER_BACKGROUND_SMOKE !== "1",
}, async () => {
  // Explicit local GUI smoke: a new disposable profile, synthetic page only,
  // and value-free process inventory. Never activate an app to set up evidence.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-background-smoke-"));
  const prior = new Map();
  for (const [name, value] of Object.entries(bindingEnvironment())) {
    prior.set(name, process.env[name]); process.env[name] = value;
  }
  let browserPid = null;
  let observedForeground = [];
  const frontPid = () => {
    const front = execFileSync("/usr/bin/lsappinfo", ["front"], { encoding: "utf8" }).trim();
    const info = execFileSync("/usr/bin/lsappinfo", ["info", "-only", "pid", front], { encoding: "utf8" });
    const match = info.match(/"pid"=(\d+)/u);
    assert.ok(match); return Number(match[1]);
  };
  const timer = setInterval(() => observedForeground.push(frontPid()), 25);
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      observedForeground = [frontPid()];
      await withPersistentBrowserSession({
        profileDirectory: path.join(root, "profile"), downloadsDirectory: path.join(root, "downloads"),
        lockPath: path.join(root, "browser.lock"), headed: true,
        prepareContext: async (context) => {
          assert.equal(context.pages().length, 0, "guards precede the first page");
          const inventory = execFileSync("/bin/ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8" });
          const candidates = inventory.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u))
            .filter((match) => match && Number(match[2]) === process.pid && /Google Chrome$/u.test(match[3]));
          assert.equal(candidates.length, 1); browserPid = Number(candidates[0][1]);
          await context.route("**/*", (route) => route.abort());
          await context.addInitScript(() => { window.syntheticGuard = true; });
        },
      }, async (page) => {
        assert.equal(await page.evaluate(() => window.syntheticGuard), true);
        await page.setContent('<button onclick="this.textContent=\'Done\'">Test</button>');
        await page.locator("button").click();
        await page.bringToFront();
        assert.equal(await page.locator("button").textContent(), "Done");
        await page.screenshot();
        await page.goto("data:text/html,<h1>Synthetic</h1>");
        const extra = await page.context().newPage();
        await extra.setContent("<p>Second background tab</p>");
        await extra.bringToFront();
        await extra.close();
        const viewport = await page.evaluate(() => [innerWidth, innerHeight]);
        assert.equal(viewport[0], 1280);
        assert.ok(viewport[1] > 700 && viewport[1] <= 1000);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(frontPid() === browserPid, false);
      });
      assert.equal(observedForeground.includes(browserPid), false, "no foreground flash from launch through close");
      assert.equal(fs.existsSync(path.join(root, "browser.lock")), false);
    }
  } finally {
    clearInterval(timer);
    for (const [name, value] of prior) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("background page binds its exact target, ignores another popup and avoids native window resize", async () => {
  const commands = [];
  const page = { isClosed: () => false, id: "owned", context: () => context, once: () => {} };
  const popup = { isClosed: () => false, id: "unrelated", context: () => context };
  let predicate;
  let resolvePage;
  const ready = new Promise((resolve) => { resolvePage = resolve; });
  const session = {
    send: async (method, parameters) => {
      commands.push({ method, parameters });
      if (method === "Target.createTarget") {
        setImmediate(async () => {
          assert.equal(await predicate(popup), false);
          assert.equal(await predicate(page), true);
          resolvePage(page);
        });
        return { targetId: "owned" };
      }
    },
    detach: async () => { commands.push({ method: "detach-browser" }); },
  };
  const context = {
    pages: () => [],
    browser: () => ({ newBrowserCDPSession: async () => session }),
    waitForEvent: (event, options) => { assert.equal(event, "page"); predicate = options.predicate; return ready; },
    newCDPSession: async (targetPage) => ({
      send: async (method, parameters) => {
        commands.push({ method, parameters });
        if (method === "Target.getTargetInfo") return { targetInfo: { targetId: targetPage.id, browserContextId: "default-persistent" } };
      },
      detach: async () => {},
    }),
  };
  assert.equal(await createBackgroundPersistentPage(context), page);
  assert.deepEqual(commands[0], { method: "Target.createTarget", parameters: {
    url: "about:blank", newWindow: true, background: true, focus: false, width: 1280, height: 1000,
  } });
  assert.equal(commands.some(({ method }) => /activateTarget|setWindowBounds|setDeviceMetricsOverride/u.test(method)), false);
  assert.equal(commands.at(-1).method, "detach-browser");
  await assert.rejects(() => createBackgroundPersistentPage({ pages: () => [popup] }, { initial: true }),
    (error) => error.code === "BROWSER_SESSION_BACKGROUND_START_FAILED");
});

test("explicit foreground override and headless launch preserve the original Playwright lifecycle", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trelio-browser-launch-modes-")));
  const environment = { ...bindingEnvironment(), TRELIO_CACHE_HOME: path.join(root, "cache") };
  const prior = new Map(Object.keys(environment).map((name) => [name, process.env[name]]));
  const module = path.join(environment.TRELIO_CACHE_HOME, "browser-session", `playwright-${PLAYWRIGHT_VERSION}`, "node_modules", "playwright-core");
  fs.mkdirSync(module, { recursive: true });
  fs.writeFileSync(path.join(module, "package.json"), JSON.stringify({ version: PLAYWRIGHT_VERSION, main: "index.cjs" }));
  fs.writeFileSync(path.join(module, "index.cjs"), `exports.chromium = { launchPersistentContext: async (profile, options) => {
    const page = { bringToFront: async () => 'foreground-requested' };
    return { pages: () => [page], once: () => {}, close: async () => {}, launchOptions: options };
  } };`);
  try {
    Object.assign(process.env, environment);
    for (const options of [{ headed: true, startInBackground: false }, { headed: false }]) {
      await withPersistentBrowserSession({ ...options, profileDirectory: path.join(root, "profile"),
        downloadsDirectory: path.join(root, "downloads"), lockPath: path.join(root, "lock"),
        prepareContext: (context) => {
          const preferences = JSON.parse(fs.readFileSync(path.join(root, 'profile', 'Default', 'Preferences')));
          assert.equal(preferences.signin.allowed, false);
          assert.equal(preferences.signin.allowed_on_next_startup, false);
          assert.equal(context.launchOptions.headless, !options.headed);
          assert.equal(context.launchOptions.ignoreDefaultArgs, undefined);
          assert.deepEqual(context.launchOptions.viewport, { width: 1280, height: 900 });
        } }, async (page) => {
        assert.equal(await page.bringToFront(), "foreground-requested");
      });
      assert.equal(fs.existsSync(path.join(root, "lock")), false);
    }
    await assert.rejects(() => withPersistentBrowserSession({ startInBackground: "false" }, () => {}),
      (error) => error.code === "BROWSER_SESSION_BACKGROUND_ARGUMENT_INVALID");
  } finally {
    for (const [name, value] of prior) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser-session binding validates class, lease and manual-assist capability", () => {
  const environment = bindingEnvironment();
  const binding = readBrowserSessionBinding({ environment, expectedSessionClass: "messenger-profile" });
  assert.equal(binding.leaseMs, DEFAULT_LEASE_MS);
  assert.equal(assertManualAssistAllowed({ environment }).manualAssist, true);
  assert.equal(MAX_LEASE_MS, 6 * 60 * 60 * 1000);

  assert.throws(
    () => readBrowserSessionBinding({
      environment: bindingEnvironment({ leaseMs: MAX_LEASE_MS + 1 }),
    }),
    BrowserSessionError,
  );
  assert.throws(
    () => assertManualAssistAllowed({
      environment: bindingEnvironment({ manualAssist: false }),
    }),
    /does not permit manual browser assist/u,
  );
});

test("shared Playwright bootstrap is deterministic and shell-free", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-browser-runtime-"));
  try {
    const observed = {};
    const result = bootstrapPlaywright({
      root,
      npmInvocation: { executable: process.execPath, npmCliPath: "/trusted/npm-cli.js" },
      spawn: (executable, argv, options) => {
        observed.executable = executable;
        observed.argv = argv;
        observed.options = options;
        const packageDirectory = path.join(root, "node_modules", "playwright-core");
        fs.mkdirSync(packageDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(packageDirectory, "package.json"),
          `${JSON.stringify({ version: PLAYWRIGHT_VERSION })}\n`,
        );
        fs.writeFileSync(path.join(packageDirectory, "index.js"), "module.exports = {};\n");
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
    });

    assert.equal(observed.executable, process.execPath);
    assert.equal(observed.argv[0], "/trusted/npm-cli.js");
    assert.equal(observed.argv.at(-1), `playwright-core@${PLAYWRIGHT_VERSION}`);
    assert.equal(observed.options.shell, false);
    assert.equal(result.playwrightVersion, PLAYWRIGHT_VERSION);
    const inspected = inspectBrowserRuntime({ root });
    assert.equal(inspected.runtimeReady, true);
    assert.equal(inspected.runtimeRoot, root);
    assert.equal(
      inspected.playwrightPath,
      fs.realpathSync(path.join(root, "node_modules", "playwright-core", "index.js")),
    );
    assert.equal(inspected.playwrightVersion, PLAYWRIGHT_VERSION);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shared Playwright bootstrap returns only sanitized failure diagnostics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-browser-runtime-error-"));
  try {
    assert.throws(
      () => bootstrapPlaywright({
        root,
        npmInvocation: {
          executable: "/trusted/node",
          npmCliPath: "/trusted/npm-cli.js",
        },
        spawn: () => ({
          status: null,
          signal: null,
          error: { code: "EINVAL", message: "must not be exposed" },
          stdout: "",
          stderr: [
            `npm ERR! cache ${path.join(os.homedir(), ".npm", "cache")}`,
            "npm ERR! registry https://user:password@registry.example.test/",
            "npm ERR! //registry.example.test/:_authToken=secret-value",
          ].join("\n"),
        }),
      }),
      (error) => {
        assert.equal(error instanceof BrowserSessionError, true);
        assert.equal(error.code, "BROWSER_SESSION_BOOTSTRAP_FAILED");
        assert.equal(error.details.status, null);
        assert.equal(error.details.errorCode, "EINVAL");
        assert.equal(error.details.npmExecutable, "node");
        assert.equal(error.details.npmCliPath, "npm-cli.js");
        assert.match(error.details.stderr, /<home>/u);
        assert.match(error.details.stderr, /https:\/\/<redacted>@registry\.example\.test\//u);
        assert.match(error.details.stderr, /_authToken=<redacted>/u);
        assert.doesNotMatch(
          JSON.stringify(error.details),
          /secret-value|must not be exposed|user:password/u,
        );
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser bootstrap diagnostic truncation keeps whole emoji", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-browser-unicode-"));
  try {
    assert.throws(() => bootstrapPlaywright({ root,
      npmInvocation: { executable: "/trusted/node", npmCliPath: "/trusted/npm-cli.js" },
      spawn: () => ({ status: 1, stdout: "", stderr: "x".repeat(1999) + "💗tail" }),
    }), error => {
      assert.equal(error.code, "BROWSER_SESSION_BOOTSTRAP_FAILED");
      assert.equal(error.details.stderr, "x".repeat(1999));
      assert.ok(error.details.stderr.isWellFormed());
      return true;
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("shared browser runtime resolves npm-cli.js without a command shell", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-browser-npm-layout-"));
  const fakeNode = path.join(temporary, "node.exe");
  const fakeNpmCli = path.join(temporary, "node_modules", "npm", "bin", "npm-cli.js");
  try {
    fs.mkdirSync(path.dirname(fakeNpmCli), { recursive: true });
    fs.writeFileSync(fakeNode, "test node placeholder\n");
    fs.writeFileSync(fakeNpmCli, "// test npm entrypoint\n");
    assert.deepEqual(resolveNpmInvocation({
      nodeExecutable: fakeNode,
      environment: {
        PATH: temporary,
        npm_execpath: fakeNpmCli,
      },
    }), {
      executable: fakeNode,
      npmCliPath: fs.realpathSync(fakeNpmCli),
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("shared browser runtime finds standalone npm from an absolute PATH layout", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-browser-path-npm-layout-"));
  const hostNode = path.join(temporary, "host-runtime", "bin", "node");
  const systemBin = path.join(temporary, "system-node", "bin");
  const systemNpmCli = path.join(
    temporary,
    "system-node",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  try {
    fs.mkdirSync(path.dirname(hostNode), { recursive: true });
    fs.mkdirSync(path.dirname(systemNpmCli), { recursive: true });
    fs.mkdirSync(systemBin, { recursive: true });
    fs.writeFileSync(hostNode, "test host node placeholder\n");
    fs.writeFileSync(systemNpmCli, "// standalone npm entrypoint\n");

    // The desktop runtime Node intentionally has no bundled npm. Discovery
    // must still use the separate absolute PATH installation without invoking
    // its platform shell wrapper.
    assert.deepEqual(resolveNpmInvocation({
      nodeExecutable: hostNode,
      environment: { PATH: systemBin },
    }), {
      executable: hostNode,
      npmCliPath: fs.realpathSync(systemNpmCli),
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("shared browser runtime finds a user-local npm outside the skill PATH", {
  skip: process.platform === "win32",
}, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-browser-user-npm-layout-"));
  const homeDirectory = path.join(temporary, "owner");
  const hostNode = path.join(temporary, "desktop-host", "bin", "node");
  const userNpmLink = path.join(homeDirectory, ".local", "bin", "npm");
  const userNpmCli = path.join(
    homeDirectory,
    ".standalone-node",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  try {
    fs.mkdirSync(path.dirname(hostNode), { recursive: true });
    fs.mkdirSync(path.dirname(userNpmLink), { recursive: true });
    fs.mkdirSync(path.dirname(userNpmCli), { recursive: true });
    fs.writeFileSync(hostNode, "test desktop host node placeholder\n");
    fs.writeFileSync(userNpmCli, "// user-local standalone npm entrypoint\n");
    fs.symlinkSync(userNpmCli, userNpmLink);

    // The host deliberately removes arbitrary user directories from the skill
    // PATH. Browser bootstrap may inspect only the fixed ~/.local/bin/npm link
    // and accepts it only after realpath proves the target is npm-cli.js.
    assert.deepEqual(resolveNpmInvocation({
      nodeExecutable: hostNode,
      environment: {
        HOME: homeDirectory,
        PATH: path.dirname(hostNode),
      },
    }), {
      executable: hostNode,
      npmCliPath: fs.realpathSync(userNpmCli),
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Windows browser bootstrap discovers standalone npm outside the sanitized skill PATH", () => {
  const hostNode = "C:\\Desktop Host\\node.exe";
  const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const environment = { Path: "C:\\Desktop Host;C:\\Windows\\System32" };
  assert.ok(npmCliCandidates({ platform: "win32", nodeExecutable: hostNode, environment }).includes(npmCli));
  assert.deepEqual(resolveNpmInvocation({
    platform: "win32",
    nodeExecutable: hostNode,
    environment,
    exists: (candidate) => candidate === npmCli,
    realpath: (candidate) => candidate,
  }), { executable: hostNode, npmCliPath: npmCli });
});

test("Windows npm discovery handles case-insensitive installation roots and native Program Files", () => {
  const hostNode = "C:\\Desktop Host\\node.exe";
  const environment = {
    Path: "C:\\Desktop Host;C:\\Windows\\System32",
    ProgramW6432: "D:\\Program Files",
    ProgramFiles: "E:\\Program Files (x86)",
    "ProgramFiles(x86)": "F:\\Program Files (x86)",
  };
  for (const root of [environment.ProgramW6432, environment.ProgramFiles, environment["ProgramFiles(x86)"]]) {
    const npmCli = path.win32.join(root, "nodejs", "node_modules", "npm", "bin", "npm-cli.js");
    assert.deepEqual(resolveNpmInvocation({
      platform: "win32",
      nodeExecutable: hostNode,
      environment,
      exists: (candidate) => candidate === npmCli,
      realpath: (candidate) => candidate,
    }), { executable: hostNode, npmCliPath: npmCli });
  }
});

test("Windows npm discovery rejects relative roots and wrappers without resolving an npm JavaScript entrypoint", () => {
  const hostNode = "C:\\Desktop Host\\node.exe";
  const environment = {
    Path: ".;relative-bin;C:\\Standalone Node",
    ProgramW6432: "relative-install",
    ProgramFiles: ".\\Program Files",
    "ProgramFiles(x86)": "..\\Program Files (x86)",
    npm_execpath: "C:\\Standalone Node\\npm.cmd",
  };
  const candidates = npmCliCandidates({ platform: "win32", nodeExecutable: hostNode, environment });
  assert.ok(candidates.every((candidate) => path.win32.isAbsolute(candidate)));
  assert.ok(candidates.every((candidate) => !candidate.includes("relative")));
  assert.throws(() => resolveNpmInvocation({
    platform: "win32",
    nodeExecutable: hostNode,
    environment,
    exists: () => true,
    realpath: () => "C:\\Standalone Node\\npm.cmd",
  }), (error) => error.code === "BROWSER_SESSION_NPM_REQUIRED");
  const rootsWithoutDrive = npmCliCandidates({
    platform: "win32",
    nodeExecutable: hostNode,
    environment: { ProgramW6432: "\\Program Files", ProgramFiles: "\\Program Files", "ProgramFiles(x86)": "\\Program Files (x86)" },
  });
  assert.ok(rootsWithoutDrive.every((candidate) => !candidate.includes("Program Files")));
});

test("Windows native bootstrap runs discovered npm-cli.js with the desktop Node and a path containing spaces", {
  skip: process.platform !== "win32",
}, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-browser-windows-npm-"));
  const hostNode = path.join(temporary, "Desktop Host", "node.exe");
  const programFiles = path.join(temporary, "Program Files");
  const npmCli = path.join(programFiles, "nodejs", "node_modules", "npm", "bin", "npm-cli.js");
  const root = path.join(temporary, "Browser Runtime");
  try {
    // A separate real Node executable reproduces the desktop host layout:
    // it has no adjacent npm and PATH does not contain the standalone install.
    fs.mkdirSync(path.dirname(hostNode), { recursive: true });
    fs.copyFileSync(process.execPath, hostNode);
    fs.mkdirSync(path.dirname(npmCli), { recursive: true });
    fs.writeFileSync(npmCli, `
      const assert = require("node:assert/strict");
      const fs = require("node:fs");
      const path = require("node:path");
      const argv = process.argv.slice(2);
      assert.equal(argv[0], "install");
      assert.equal(argv[1], "--prefix");
      assert.equal(argv.at(-1), "playwright-core@${PLAYWRIGHT_VERSION}");
      const directory = path.join(argv[2], "node_modules", "playwright-core");
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version: "${PLAYWRIGHT_VERSION}" }));
      fs.writeFileSync(path.join(directory, "index.js"), "module.exports = {};");
    `);
    const invocation = resolveNpmInvocation({
      nodeExecutable: hostNode,
      environment: { Path: path.dirname(hostNode), ProgramFiles: programFiles },
    });
    assert.deepEqual(invocation, { executable: hostNode, npmCliPath: fs.realpathSync(npmCli) });
    const result = bootstrapPlaywright({
      root,
      npmInvocation: invocation,
      spawn: (executable, argv, options) => {
        assert.equal(executable, hostNode);
        assert.equal(argv[0], fs.realpathSync(npmCli));
        assert.equal(options.shell, false);
        assert.equal(options.windowsHide, true);
        return spawnSync(executable, argv, options);
      },
    });
    assert.equal(result.runtimeReady, true);
    assert.equal(inspectBrowserRuntime({ root }).runtimeReady, true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("shared browser runtime discovers Microsoft Edge when Chrome is absent", () => {
  const environment = {
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\Owner\\AppData\\Local",
  };
  const candidates = browserExecutableCandidates({ platform: "win32", environment });
  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  assert.equal(candidates.includes(edge), true);
  assert.equal(defaultBrowserExecutable({
    platform: "win32",
    environment,
    exists: (candidate) => candidate === edge,
  }), edge);
});
