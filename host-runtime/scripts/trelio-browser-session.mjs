/**
 * Shared browser-session runtime for signed Agent Skills.
 *
 * This module owns only provider-neutral process, lease, profile and
 * Playwright mechanics. Provider adapters still own navigation allowlists,
 * selectors, data minimisation, operation binding and mutation confirmation.
 * Keeping that split explicit prevents a convenient browser helper from
 * becoming a generic remote-control surface.
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BROWSER_SESSION_API_VERSION = 1;
export const PLAYWRIGHT_VERSION = "1.60.0";
export const DEFAULT_LEASE_MS = 30 * 60 * 1000;
export const MAX_LEASE_MS = 6 * 60 * 60 * 1000;
const SESSION_CLASSES = new Set([
  "messenger-profile",
  "protected-snapshot",
  "delegated-ephemeral",
]);
const require = createRequire(import.meta.url);

export class BrowserSessionError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "BrowserSessionError";
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details) => {
  throw new BrowserSessionError(code, message, details);
};

const privateDirectory = (directory) => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  return directory;
};

const privateJson = (file, value) => {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
};

export const browserConfigHome = (environment = process.env) => {
  if (environment.TRELIO_CONFIG_HOME) return path.resolve(environment.TRELIO_CONFIG_HOME);
  if (process.platform === "win32") {
    return path.join(environment.LOCALAPPDATA || os.homedir(), "Trelio");
  }
  return path.join(os.homedir(), ".config", "trelio");
};

export const browserCacheHome = (environment = process.env) => {
  if (environment.TRELIO_CACHE_HOME) return path.resolve(environment.TRELIO_CACHE_HOME);
  if (process.platform === "win32") {
    return path.join(environment.LOCALAPPDATA || os.homedir(), "Trelio", "cache");
  }
  return path.join(os.homedir(), ".cache", "trelio");
};

export const browserRuntimeRoot = (environment = process.env) => path.join(
  browserCacheHome(environment),
  "browser-session",
  `playwright-${PLAYWRIGHT_VERSION}`,
);

const exactObjectKeys = (value, expected) => (
  value
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.keys(value).every((key) => expected.has(key))
);

export const readBrowserSessionBinding = ({
  environment = process.env,
  expectedSessionClass = null,
} = {}) => {
  let policy;
  try {
    policy = JSON.parse(String(environment.TRELIO_BROWSER_SESSION_POLICY_JSON || ""));
  } catch {
    fail("BROWSER_SESSION_HOST_BINDING_REQUIRED", "Trusted browser-session policy is missing.");
  }
  if (!exactObjectKeys(policy, new Set([
    "apiVersion",
    "leaseMs",
    "manualAssist",
    "sessionClass",
  ]))) {
    fail("BROWSER_SESSION_POLICY_INVALID", "Browser-session policy contains unsupported fields.");
  }
  if (
    policy.apiVersion !== BROWSER_SESSION_API_VERSION
    || !SESSION_CLASSES.has(policy.sessionClass)
    || !Number.isInteger(policy.leaseMs)
    || policy.leaseMs < 60_000
    || policy.leaseMs > MAX_LEASE_MS
    || typeof policy.manualAssist !== "boolean"
  ) {
    fail("BROWSER_SESSION_POLICY_INVALID", "Browser-session policy is invalid.");
  }
  if (expectedSessionClass && policy.sessionClass !== expectedSessionClass) {
    fail(
      "BROWSER_SESSION_CLASS_MISMATCH",
      `Browser-session class ${policy.sessionClass} cannot be used as ${expectedSessionClass}.`,
    );
  }
  const startedAt = Number(environment.TRELIO_BROWSER_SESSION_STARTED_AT);
  const deadlineAt = Number(environment.TRELIO_BROWSER_SESSION_DEADLINE_AT);
  if (
    !Number.isSafeInteger(startedAt)
    || !Number.isSafeInteger(deadlineAt)
    || deadlineAt !== startedAt + policy.leaseMs
  ) {
    fail("BROWSER_SESSION_HOST_BINDING_REQUIRED", "Browser-session deadline is not host-bound.");
  }
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    fail("BROWSER_SESSION_LEASE_EXPIRED", "Browser-session lease has expired.");
  }
  return Object.freeze({ ...policy, startedAt, deadlineAt, remainingMs });
};

export const assertManualAssistAllowed = (options = {}) => {
  const binding = readBrowserSessionBinding(options);
  if (!binding.manualAssist) {
    fail("BROWSER_SESSION_MANUAL_ASSIST_DISABLED", "This skill does not permit manual browser assist.");
  }
  return binding;
};

const environmentValue = (environment, name) => {
  const exact = environment[name];
  if (exact !== undefined) return exact;
  if (process.platform !== "win32") return undefined;
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
};

export const browserExecutableCandidates = ({
  platform = process.platform,
  environment = process.env,
} = {}) => {
  const pathApi = platform === "win32" ? path.win32 : path;
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (platform === "win32") {
    return [
      pathApi.join(
        environmentValue(environment, "PROGRAMFILES") || "C:\\Program Files",
        "Google", "Chrome", "Application", "chrome.exe",
      ),
      pathApi.join(
        environmentValue(environment, "LOCALAPPDATA") || "",
        "Google", "Chrome", "Application", "chrome.exe",
      ),
      pathApi.join(
        environmentValue(environment, "PROGRAMFILES") || "C:\\Program Files",
        "Microsoft", "Edge", "Application", "msedge.exe",
      ),
      pathApi.join(
        environmentValue(environment, "PROGRAMFILES(X86)") || "C:\\Program Files (x86)",
        "Microsoft", "Edge", "Application", "msedge.exe",
      ),
      pathApi.join(
        environmentValue(environment, "LOCALAPPDATA") || "",
        "Microsoft", "Edge", "Application", "msedge.exe",
      ),
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
};

export const defaultBrowserExecutable = ({
  platform = process.platform,
  environment = process.env,
  exists = fs.existsSync,
} = {}) => {
  const candidates = browserExecutableCandidates({ platform, environment });
  return candidates.find((candidate) => candidate && exists(candidate)) || candidates[0];
};

export const npmCliCandidates = ({
  nodeExecutable = process.execPath,
  environment = process.env,
} = {}) => {
  const executableDirectory = path.dirname(path.resolve(nodeExecutable));
  const pathDirectories = String(environmentValue(environment, "PATH") || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry && path.isAbsolute(entry));
  const homeDirectory = String(environmentValue(environment, "HOME") || os.homedir());
  const npmDirectories = [...new Set([
    ...pathDirectories,
    process.platform !== "win32" && path.isAbsolute(homeDirectory)
      ? path.join(homeDirectory, ".local", "bin")
      : null,
  ].filter(Boolean))];
  const ambient = environmentValue(environment, "npm_execpath");
  return [...new Set([
    ambient && path.isAbsolute(ambient) ? ambient : null,
    path.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ...npmDirectories.flatMap((directory) => [
      path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
      // Desktop hosts may run skills with their own Node executable while the
      // user's standalone Node/npm bin is omitted from the sanitized PATH.
      // Official Unix installers place npm under ../lib and expose an `npm`
      // symlink from bin; resolve both forms to the JavaScript entrypoint so we
      // keep shell:false and never execute npm, npm.cmd or another wrapper.
      path.resolve(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(directory, "npm"),
      path.join(directory, "npm-cli.js"),
    ]),
  ].filter(Boolean))];
};

export const resolveNpmInvocation = ({
  nodeExecutable = process.execPath,
  environment = process.env,
  realpath = fs.realpathSync,
  exists = fs.existsSync,
} = {}) => {
  for (const candidate of npmCliCandidates({ nodeExecutable, environment })) {
    if (!exists(candidate)) continue;
    try {
      const resolved = realpath(candidate);
      if (path.basename(resolved).toLowerCase() === "npm-cli.js") {
        return { executable: nodeExecutable, npmCliPath: resolved };
      }
    } catch {
      // A broken candidate is not authority to execute another shell wrapper.
    }
  }
  fail(
    "BROWSER_SESSION_NPM_REQUIRED",
    "Standalone Node.js with npm-cli.js is required to install the browser runtime.",
  );
};

const safePath = (value) => value ? path.basename(String(value)) : null;
const safeChildCode = (error) => {
  const code = error && typeof error === "object" ? error.code : null;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : null;
};
const replaceAllCaseInsensitive = (value, needle, replacement) => {
  if (!needle) return value;
  const lowerValue = value.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let cursor = 0;
  let result = "";
  while (true) {
    const index = lowerValue.indexOf(lowerNeedle, cursor);
    if (index === -1) return result + value.slice(cursor);
    result += value.slice(cursor, index) + replacement;
    cursor = index + needle.length;
  }
};

const sanitizedOutput = (value) => {
  // npm failures are useful for diagnosis, but its output can contain the
  // local account path, registry basic auth or token-shaped config values.
  // Keep a bounded single-line diagnostic while removing those identities.
  let sanitized = replaceAllCaseInsensitive(
    String(value || "").replaceAll("\u0000", ""),
    os.homedir(),
    "<home>",
  );
  sanitized = sanitized
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/giu, "$1<redacted>@")
    .replace(/((?:_authToken|authToken|password|token)\s*[=:]\s*)[^\s]+/giu, "$1<redacted>")
    .replace(/([?&](?:access_token|auth|password|token)=)[^&\s]+/giu, "$1<redacted>")
    .replace(/[\r\n\t]+/gu, " ");
  return sanitized.slice(0, 2_000);
};

export const bootstrapPlaywright = ({
  root = browserRuntimeRoot(),
  spawn = spawnSync,
  npmInvocation = undefined,
} = {}) => {
  privateDirectory(root);
  try {
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    fail("BROWSER_SESSION_RUNTIME_UNWRITABLE", "Browser runtime directory is not writable.", {
      path: safePath(root),
      errorCode: safeChildCode(error),
    });
  }
  const packageFile = path.join(root, "package.json");
  if (!fs.existsSync(packageFile)) privateJson(packageFile, { private: true, dependencies: {} });
  const invocation = npmInvocation || resolveNpmInvocation();
  const argv = [
    "install", "--prefix", root, "--ignore-scripts", "--no-audit", "--no-fund",
    "--save-exact", `playwright-core@${PLAYWRIGHT_VERSION}`,
  ];
  let result;
  try {
    result = spawn(invocation.executable, [invocation.npmCliPath, ...argv], {
      cwd: root,
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    result = { status: null, signal: null, stdout: "", stderr: "", error };
  }
  if (result.status !== 0) {
    fail("BROWSER_SESSION_BOOTSTRAP_FAILED", "Cannot install the browser runtime: npm failed.", {
      npmExecutable: safePath(invocation.executable),
      npmCliPath: safePath(invocation.npmCliPath),
      errorCode: safeChildCode(result.error),
      signal: result.signal || null,
      status: Number.isInteger(result.status) ? result.status : null,
      stdout: sanitizedOutput(result.stdout),
      stderr: sanitizedOutput(result.stderr),
    });
  }
  const installedPackage = path.join(root, "node_modules", "playwright-core", "package.json");
  let installedVersion = null;
  try {
    installedVersion = JSON.parse(fs.readFileSync(installedPackage, "utf8")).version;
  } catch {
    installedVersion = null;
  }
  if (installedVersion !== PLAYWRIGHT_VERSION) {
    fail(
      "BROWSER_SESSION_BOOTSTRAP_INCOMPLETE",
      "npm completed without the pinned Playwright package.",
      { expectedPlaywrightVersion: PLAYWRIGHT_VERSION, installedPlaywrightVersion: installedVersion },
    );
  }
  return {
    runtimeReady: true,
    runtimeRoot: root,
    playwrightVersion: installedVersion,
    npmExecutable: safePath(invocation.executable),
    npmCliPath: safePath(invocation.npmCliPath),
  };
};

export const loadPlaywright = ({ root = browserRuntimeRoot() } = {}) => {
  try {
    return require(require.resolve("playwright-core", { paths: [root] }));
  } catch {
    fail(
      "BROWSER_SESSION_BOOTSTRAP_REQUIRED",
      "Browser runtime is unavailable. Run the skill bootstrap command first.",
    );
  }
};

/**
 * Return the provider-neutral runtime state used by skill `doctor` commands.
 * A provider must not inspect its former private Playwright tree after
 * bootstrap moved installation into the shared host-owned runtime root.
 */
export const inspectBrowserRuntime = ({ root = browserRuntimeRoot() } = {}) => {
  let playwrightPath = null;
  let installedVersion = null;
  try {
    playwrightPath = require.resolve("playwright-core", { paths: [root] });
    installedVersion = JSON.parse(fs.readFileSync(
      path.join(root, "node_modules", "playwright-core", "package.json"),
      "utf8",
    )).version;
  } catch {
    playwrightPath = null;
    installedVersion = null;
  }
  return {
    runtimeReady: Boolean(playwrightPath) && installedVersion === PLAYWRIGHT_VERSION,
    runtimeRoot: root,
    playwrightPath,
    playwrightVersion: installedVersion,
  };
};

const withExclusiveProfileLock = async (lock, label, callback) => {
  privateDirectory(path.dirname(lock));
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
  } catch {
    const pidFile = path.join(lock, "pid");
    const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : 0);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    }
    if (alive) fail("BROWSER_SESSION_PROFILE_BUSY", `${label} profile is already in use.`);
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
  }
  try {
    return await callback();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
};

/**
 * Open one provider-owned persistent profile under the host lease.
 * prepareContext runs before the first page is handed to the adapter, which
 * lets MAX install its WebSocket and manual-control gates before navigation.
 */
export const withPersistentBrowserSession = async ({
  chromeExecutable,
  profileDirectory,
  downloadsDirectory,
  lockPath,
  headed,
  acceptDownloads = true,
  label = "Browser",
  prepareContext = null,
  preparePage = null,
  launchArguments = [],
}, callback) => {
  const binding = readBrowserSessionBinding({ expectedSessionClass: "messenger-profile" });
  return withExclusiveProfileLock(lockPath, label, async () => {
    privateDirectory(profileDirectory);
    privateDirectory(downloadsDirectory);
    const resolvedBrowserExecutable = chromeExecutable || defaultBrowserExecutable();
    if (!fs.existsSync(resolvedBrowserExecutable)) {
      fail(
        "BROWSER_SESSION_EXECUTABLE_MISSING",
        `Chrome, Chromium or Edge was not found: ${resolvedBrowserExecutable}`,
      );
    }
    const { chromium } = loadPlaywright();
    const context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath: resolvedBrowserExecutable,
      headless: !headed,
      viewport: { width: 1280, height: 900 },
      acceptDownloads,
      downloadsPath: downloadsDirectory,
      args: [
        "--no-first-run",
        "--disable-session-crashed-bubble",
        "--disable-blink-features=AutomationControlled",
        ...launchArguments,
      ],
    });
    let closed = false;
    context.once("close", () => { closed = true; });
    const close = () => {
      if (!closed) void context.close().catch(() => undefined);
    };
    // The host also supervises the skill process. This local timer closes the
    // browser first, so a normal deadline does not leave its child process or
    // profile lock behind before the host escalates termination.
    const leaseTimer = setTimeout(close, Math.max(1, binding.deadlineAt - Date.now()));
    leaseTimer.unref?.();
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    try {
      const contextValue = prepareContext ? await prepareContext(context, binding) : undefined;
      const page = context.pages()[0] || await context.newPage();
      if (preparePage) await preparePage(page, contextValue, binding);
      return await callback(page, contextValue, binding);
    } finally {
      clearTimeout(leaseTimer);
      process.removeListener("SIGTERM", close);
      process.removeListener("SIGINT", close);
      if (!closed) await context.close();
    }
  });
};
