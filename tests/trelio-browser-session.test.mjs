import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

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
  readBrowserSessionBinding,
  resolveNpmInvocation,
  backgroundPersistentLaunchOptions,
  createBackgroundPersistentPage,
  withPersistentBrowserSession,
} from "../host-runtime/scripts/trelio-browser-session.mjs";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-browser-launch-modes-"));
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
