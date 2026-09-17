import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
