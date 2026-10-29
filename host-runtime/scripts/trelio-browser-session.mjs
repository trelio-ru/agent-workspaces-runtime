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
import fsp from "node:fs/promises";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { isDirectModuleInvocation } from "./trelio-local-path.mjs";
export { createDocumentHttpObserver, safeHttpFailure } from "./trelio-browser-http.mjs";

// Lazy loading keeps the standalone browser bootstrap independent of the
// private host/owner store until a signed caller explicitly requests it.
export const prepareBrowserController = async options =>
  (await import('./trelio-browser-controller.mjs')).prepareBrowserController(options);

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

const environmentValue = (environment, name, platform = process.platform) => {
  const exact = environment[name];
  if (exact !== undefined) return exact;
  if (platform !== "win32") return undefined;
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
  platform = process.platform,
  nodeExecutable = process.execPath,
  environment = process.env,
} = {}) => {
  const pathApi = platform === "win32" ? path.win32 : path;
  const executableDirectory = pathApi.dirname(pathApi.resolve(nodeExecutable));
  const pathDirectories = String(environmentValue(environment, "PATH", platform) || "")
    .split(pathApi.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry && pathApi.isAbsolute(entry));
  // A desktop's bundled Node is independent of the official standalone
  // installation. Signed skills deliberately lose arbitrary PATH entries,
  // including Program Files\nodejs, so that PATH must stay sanitized rather
  // than being broadened just to make npm discoverable. Inspect only these
  // fixed installer layouts, including the native 64-bit root of a 32-bit
  // process. OS variable names are case-insensitive; relative roots never
  // become a cwd/workspace-based executable candidate.
  const windowsNodeDirectories = platform === "win32"
    ? [
      environmentValue(environment, "PROGRAMW6432", platform)
        || environmentValue(environment, "PROGRAMFILES", platform) || "C:\\Program Files",
      environmentValue(environment, "PROGRAMFILES", platform) || "C:\\Program Files",
      environmentValue(environment, "PROGRAMFILES(X86)", platform) || "C:\\Program Files (x86)",
    ].filter((root) => pathApi.isAbsolute(root) && /^[A-Za-z]:[\\/]/u.test(root))
      .map((root) => pathApi.join(root, "nodejs"))
    : [];
  const homeDirectory = String(environmentValue(environment, "HOME") || os.homedir());
  const npmDirectories = [...new Set([
    ...pathDirectories,
    platform !== "win32" && path.isAbsolute(homeDirectory)
      ? path.join(homeDirectory, ".local", "bin")
      : null,
  ].filter(Boolean))];
  const ambient = environmentValue(environment, "npm_execpath", platform);
  return [...new Set([
    ambient && pathApi.isAbsolute(ambient) ? ambient : null,
    pathApi.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    pathApi.resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ...npmDirectories.flatMap((directory) => [
      pathApi.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
      // Desktop hosts may run skills with their own Node executable while the
      // user's standalone Node/npm bin is omitted from the sanitized PATH.
      // Official Unix installers place npm under ../lib and expose an `npm`
      // symlink from bin; resolve both forms to the JavaScript entrypoint so we
      // keep shell:false and never execute npm, npm.cmd or another wrapper.
      pathApi.resolve(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      pathApi.join(directory, "npm"),
      pathApi.join(directory, "npm-cli.js"),
    ]),
    // The Windows installer has one npm layout. Do not extend its fixed-root
    // fallback to unrelated lib directories or command-wrapper locations.
    ...windowsNodeDirectories.map((directory) => (
      pathApi.join(directory, "node_modules", "npm", "bin", "npm-cli.js")
    )),
  ].filter(Boolean))];
};

export const resolveNpmInvocation = ({
  platform = process.platform,
  nodeExecutable = process.execPath,
  environment = process.env,
  realpath = fs.realpathSync,
  exists = fs.existsSync,
} = {}) => {
  const pathApi = platform === "win32" ? path.win32 : path;
  for (const candidate of npmCliCandidates({ platform, nodeExecutable, environment })) {
    if (!exists(candidate)) continue;
    try {
      const resolved = realpath(candidate);
      if (pathApi.isAbsolute(resolved) && pathApi.basename(resolved).toLowerCase() === "npm-cli.js") {
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
 * Persistent Playwright normally opens about:blank and waits for that page
 * before returning. Removing just the URL hangs launch; minimizing afterwards
 * has already activated Chrome. Its public ignoreDefaultArgs=true option lets
 * the host start with no window, then create the first target inactive via CDP.
 * Keep this reviewed launch policy here, rather than in each provider. These
 * switches preserve the relevant pinned Playwright 1.60 defaults (no extensions,
 * sync, startup network, background throttling or OS credential prompts). No
 * private Playwright fields, debug TCP endpoint or OS focus restoration is used.
 */
export const backgroundPersistentLaunchOptions = (profileDirectory, launchArguments = []) => {
  if (!Array.isArray(launchArguments) || launchArguments.some((argument) => (
    typeof argument !== "string" || !argument.startsWith("--")
    || /^--(?:user-data-dir|remote-debugging|app|restore-last-session|new-window|headless|start-maximized|start-minimized)(?:[=-]|$)/u.test(argument)
  ))) fail("BROWSER_SESSION_BACKGROUND_ARGUMENT_INVALID", "Background launch cannot override the managed profile, transport or initial window.");
  return {
    ignoreDefaultArgs: true,
    viewport: null,
    args: [
      `--user-data-dir=${profileDirectory}`,
      "--remote-debugging-pipe",
      "--no-startup-window",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--disable-blink-features=AutomationControlled",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-back-forward-cache",
      "--disable-breakpad",
      "--disable-component-update",
      "--disable-component-extensions-with-background-pages",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-dev-shm-usage",
      "--disable-edgeupdater",
      "--edge-skip-compat-layer-relaunch",
      "--disable-search-engine-choice-screen",
      "--disable-features=DestroyProfileOnBrowserClose,HttpsUpgrades,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion",
      "--enable-features=CDPScreenshotNewSurface",
      "--enable-unsafe-swiftshader",
      "--allow-pre-commit-input",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--force-color-profile=srgb",
      "--metrics-recording-only",
      "--password-store=basic",
      "--use-mock-keychain",
      "--no-service-autorun",
      ...launchArguments,
    ],
  };
};

export const createBackgroundPersistentPage = async (context, { initial = false } = {}) => {
  const hasPages = context.pages().some((page) => !page.isClosed());
  if (initial && hasPages) fail("BROWSER_SESSION_BACKGROUND_START_FAILED", "Background browser unexpectedly created a startup page.");
  const session = await context.browser().newBrowserCDPSession();
  let targetId;
  let resolveTarget;
  const target = new Promise((resolve) => { resolveTarget = resolve; });
  const ready = context.waitForEvent("page", { timeout: 10_000, predicate: async (page) => {
    const expected = await target;
    if (!expected || page.isClosed() || page.context() !== context) return false;
    const binding = await context.newCDPSession(page);
    try {
      const { targetInfo } = await binding.send("Target.getTargetInfo");
      // A concurrent provider popup cannot replace the exact host-created page.
      // Chromium can report a non-empty browserContextId for its default
      // persistent context. Public Page.context identity binds the context;
      // absence of that protocol field is not a portable ownership criterion.
      return targetInfo.targetId === expected;
    } finally { await binding.detach(); }
  } });
  ready.catch(() => {});
  try {
    try {
      ({ targetId } = await session.send("Target.createTarget", {
        url: "about:blank", newWindow: !hasPages, background: true, focus: false,
        ...(!hasPages ? { width: 1280, height: 1000 } : {}),
      }));
    } finally { resolveTarget(targetId); }
    // Use the native viewport for the lifetime of this window. Playwright's
    // setViewportSize changes native bounds and can activate macOS Chrome;
    // adapters/snapshots must observe the actual viewport instead of resizing.
    const page = await ready;
    // Old adapters used bringToFront merely to hand out an assist session.
    // Preserve that call's completion without silently overriding the host's
    // background default. A provider explicitly opts into foreground launch
    // with startInBackground=false for a user-requested visible manual step.
    page.bringToFront = async () => {};
    return page;
  } finally { await session.detach(); }
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
  startInBackground = true,
}, callback) => {
  if (typeof startInBackground !== "boolean") fail("BROWSER_SESSION_BACKGROUND_ARGUMENT_INVALID", "startInBackground must be an explicit boolean.");
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
      ...(headed && startInBackground
        ? backgroundPersistentLaunchOptions(profileDirectory, launchArguments) : {}),
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
      const page = headed && startInBackground
        ? await createBackgroundPersistentPage(context, { initial: true })
        : context.pages()[0] || await context.newPage();
      // Subsequent host-owned tabs must follow the same contract as the first.
      // A newPage call must not become a hidden foreground override.
      if (headed && startInBackground) context.newPage = () => createBackgroundPersistentPage(context);
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

// Protected mail authentication shares the generic browser session owner.
// Its pure receipt/actor validation performs no storage IO on module import;
// private relay/coordination load storage lazily and never create a browser.
export const BROWSER_MAIL_AUTH_API = 'trelio.protected-browser-mail-auth/v1';
export const BROWSER_MAIL_REQUEST_KIND = 'trelio.browser-mail-request/v1';
const mailUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const mailDigest = /^[0-9a-f]{64}$/u;
const mailExact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(v, k));
const mailFail = code => { throw Object.assign(new Error(code), { code }); };
const mailText = (v, max = 240) => typeof v === 'string' && v.trim().length > 0
  && v.length <= max && !/[\x00-\x1f\x7f]/u.test(v);

/** Only the signed browser provider declares the mail matcher. It is literal,
 * bounded data, not caller regex, arbitrary mail search or code from a page.
 * Sender/subject/body anchors must be verified by that provider before release.
 * The recipient comes from the explicitly selected mailbox's native identity.
 */
export function normalizeBrowserMailSpec(value) {
  if (!mailExact(value, ['skillId', 'sender', 'subjectIncludes', 'bodyIncludes', 'digits'])
    || !mailText(value.skillId, 120) || !/^[a-z0-9][a-z0-9-]{0,119}$/u.test(value.skillId)
    || !mailText(value.sender) || !/^[^\s<>@"\\]+@[^\s<>@"\\]+\.[^\s<>@"\\]+$/u.test(value.sender)
    || !mailText(value.subjectIncludes) || !mailText(value.bodyIncludes)
    || ![6, 8].includes(value.digits)) mailFail('authentication_mail_invalid');
  return { ...value, sender: value.sender.toLowerCase() };
}

export function parseBrowserMailHandle(value) {
  if (typeof value !== 'string' || value.length !== 101 || !/^[0-9a-f]{64}\.[0-9a-f-]{36}$/u.test(value)) mailFail('authentication_mail_invalid');
  const [scope, requestId] = value.split('.');
  if (!mailUuid.test(requestId)) mailFail('authentication_mail_invalid');
  return { scope, requestId };
}

/** Metadata-only identity supplied by the normal signed skill/account engine.
 * A request handle is a locator, never admission. The mail worker must match
 * the exact company/member, provider and explicitly selected account too.
 */
export function browserMailActor(env = process.env) {
  let account;
  try { account = JSON.parse(env.TRELIO_SKILL_ACCOUNT_JSON || 'null'); } catch { mailFail('authentication_mail_scope'); }
  const value = { origin: new URL(env.TRELIO_ORIGIN || 'https://trelio.ru').origin,
    skillId: env.TRELIO_SKILL_ID, accountId: account?.id,
    companyId: env.TRELIO_SKILL_COMPANY_ID, memberId: env.TRELIO_SKILL_MEMBER_ID };
  if (!value.origin.startsWith('https://') || !mailText(value.skillId, 120) || !mailUuid.test(value.accountId)
    || !mailUuid.test(value.companyId) || !mailUuid.test(value.memberId)
    || !mailDigest.test(account?.companyBinding || '')) mailFail('authentication_mail_scope');
  return value;
}

export function validateBrowserMailReference(value) {
  if (!mailExact(value, ['scope', 'uidValidity', 'uid', 'revision', 'originalSha256'])
    || !mailDigest.test(value.scope) || !mailDigest.test(value.revision) || !mailDigest.test(value.originalSha256)
    || !Number.isSafeInteger(value.uidValidity) || value.uidValidity < 1 || value.uidValidity > 0xffffffff
    || !Number.isSafeInteger(value.uid) || value.uid < 1 || value.uid > 0xffffffff) mailFail('authentication_mail_invalid');
  return { scope: value.scope, uidValidity: value.uidValidity, uid: value.uid,
    revision: value.revision, originalSha256: value.originalSha256 };
}

export function validateBrowserMailJournal(value) {
  if (!mailExact(value, ['requestId', 'requestedAt', 'expiresAt', 'mailAccountId', 'state', 'acknowledgement', 'reference', 'baseline'])
    || !mailUuid.test(value.requestId) || !mailUuid.test(value.mailAccountId)
    || !Number.isSafeInteger(value.requestedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= value.requestedAt || value.expiresAt - value.requestedAt > 120000
    || !['waiting', 'armed', 'code_received', 'authenticated', 'failed'].includes(value.state)
    || !['none', 'pending', 'complete', 'unknown'].includes(value.acknowledgement)) mailFail('authentication_mail_invalid');
  if (value.reference !== null) validateBrowserMailReference(value.reference);
  if (value.baseline !== null) validateBrowserMailBaseline(value.baseline);
  if (['armed', 'code_received', 'authenticated'].includes(value.state) && value.baseline === null) mailFail('authentication_mail_invalid');
  if (['code_received', 'authenticated'].includes(value.state) && value.reference === null) mailFail('authentication_mail_invalid');
  return value;
}

export function validateBrowserMailBaseline(value) {
  if (!mailExact(value, ['scope', 'uidValidity', 'lastUid']) || !mailDigest.test(value.scope)
    || !Number.isSafeInteger(value.uidValidity) || value.uidValidity < 1 || value.uidValidity > 0xffffffff
    || !Number.isSafeInteger(value.lastUid) || value.lastUid < 0 || value.lastUid > 0xffffffff) mailFail('authentication_mail_invalid');
  return { scope: value.scope, uidValidity: value.uidValidity, lastUid: value.lastUid };
}

/** One pending authentication, owned by the SAME browser worker and encrypted
 * credential attempt. This is not a second vault, queue or credential service.
 * The caller persists journal through its existing store before every dispatch.
 * Code bytes live only in RAM/private delivery; journal stores structural refsp.
 * Process loss therefore leaves the original attempt fenced, never resumable
 * by another code submission or a fresh CLI invocation.
 */
export class ProtectedBrowserMailAttempt {
  #resolveCode; #rejectCode; #resolveReady; #rejectReady; #resolveOutcome; #timer; #finished = false;
  constructor({ scope, identity, mailAccountId, spec, journal, persist, active,
    now = Date.now, expiresAt, requestedAt, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.spec = normalizeBrowserMailSpec(spec);
    if (!mailDigest.test(scope) || !mailText(identity?.origin) || !identity.origin.startsWith('https://')
      || !mailUuid.test(identity?.companyId) || !mailUuid.test(identity?.memberId)
      || !mailUuid.test(mailAccountId) || !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(requestedAt)
      || expiresAt <= now() || expiresAt - requestedAt > 120000 || requestedAt > now() + 5000
      || typeof persist !== 'function' || typeof active !== 'function' || !journal
      || Object.keys(journal).length) mailFail('authentication_mail_invalid');
    this.scope = scope; this.identity = { ...identity }; this.mailAccountId = mailAccountId;
    this.journal = journal; this.persist = persist; this.active = active; this.now = now;
    this.clearTimer = clearTimer;
    Object.assign(journal, { requestId: randomUUID(), requestedAt, expiresAt,
      mailAccountId, state: 'waiting', acknowledgement: 'none', reference: null, baseline: null });
    this.handle = `${scope}.${journal.requestId}`;
    this.code = new Promise((resolve, reject) => { this.#resolveCode = resolve; this.#rejectCode = reject; });
    // A failure can precede the authenticator awaiting code. Attach a handler
    // without converting the original rejected promise into successful input.
    this.code.catch(() => {});
    this.ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    this.ready.catch(() => {});
    this.outcome = new Promise(resolve => { this.#resolveOutcome = resolve; });
    this.#timer = setTimer(() => { this.cancel('authentication_mail_expired'); }, expiresAt - now());
    this.#timer?.unref?.();
  }
  async start() { this.active(); await this.persist(); return this.publicStatus(); }
  #authorize(actor, handle, { allowExpired = false } = {}) {
    if (!mailExact(actor, ['origin', 'skillId', 'accountId', 'companyId', 'memberId'])
      || actor.origin !== this.identity.origin
      || actor.skillId !== this.spec.skillId || actor.accountId !== this.mailAccountId
      || actor.companyId !== this.identity.companyId || actor.memberId !== this.identity.memberId
      || handle !== this.handle) mailFail('authentication_mail_scope');
    this.active();
    if (!allowExpired && this.now() >= this.journal.expiresAt) mailFail('authentication_mail_expired');
  }
  publicStatus() {
    // No sender/recipient, message body, code, reference or worker bearer token
    // crosses the ordinary MCP boundary. The handle is useless without actor
    // admission and the current private browser owner.
    return { kind: BROWSER_MAIL_REQUEST_KIND, state: this.#finished ? 'finished' : 'waiting',
      handle: this.handle, expiresAt: this.journal.expiresAt,
      authenticated: this.journal.state === 'authenticated', acknowledgement: this.journal.acknowledgement };
  }
  prepare(actor, handle) {
    this.#authorize(actor, handle);
    if (this.journal.state !== 'waiting') mailFail('authentication_mail_consumed');
    return { api: BROWSER_MAIL_AUTH_API, ...this.spec,
      requestedAt: this.journal.requestedAt, expiresAt: this.journal.expiresAt };
  }
  status(actor, handle) {
    this.#authorize(actor, handle, { allowExpired: true });
    return { authenticated: this.journal.state === 'authenticated',
      state: this.journal.state, finished: this.#finished, acknowledgement: this.journal.acknowledgement,
      reference: this.journal.reference ? { ...this.journal.reference } : null,
      baseline: this.journal.baseline ? { ...this.journal.baseline } : null,
      request: { api: BROWSER_MAIL_AUTH_API, ...this.spec,
        requestedAt: this.journal.requestedAt, expiresAt: this.journal.expiresAt } };
  }
  async begin(actor, handle, baseline) {
    this.#authorize(actor, handle);
    if (this.journal.state !== 'waiting') mailFail('authentication_mail_consumed');
    // Record UIDNEXT-1 BEFORE allowing any password/email-method click that
    // could send a code. A recent but pre-existing message can never qualify.
    this.journal.baseline = validateBrowserMailBaseline(baseline);
    this.journal.state = 'armed';
    await this.persist(); this.active(); this.#resolveReady();
    return { armed: true };
  }
  async deliver(actor, handle, { code, reference }) {
    this.#authorize(actor, handle);
    if (this.journal.state !== 'armed' || typeof code !== 'string'
      || !new RegExp(`^[0-9]{${this.spec.digits}}$`, 'u').test(code)) mailFail('authentication_mail_consumed');
    // Consume synchronously before the first await, so concurrent deliveries
    // cannot both reach the provider. Persist exact source identity BEFORE
    // releasing the code to the existing fenced fill/submit path.
    const ref = validateBrowserMailReference(reference), base = this.journal.baseline;
    if (!base || ref.scope !== base.scope || ref.uidValidity !== base.uidValidity || ref.uid <= base.lastUid) mailFail('authentication_mail_invalid');
    this.journal.reference = ref;
    this.journal.state = 'code_received';
    try { await this.persist(); this.active(); this.#resolveCode(code); }
    catch (error) { this.cancel('authentication_mail_unknown'); throw error; }
    finally { code = ''; }
    return this.outcome;
  }
  async finish(authenticated) {
    if (this.#finished) return;
    this.#finished = true; this.clearTimer(this.#timer);
    // Only the browser's positive signed success selector can call true.
    // Code extraction, a submitted form or saved credentials do not suffice.
    this.journal.state = authenticated && this.journal.state === 'code_received' ? 'authenticated' : 'failed';
    try { await this.persist(); }
    catch (error) {
      this.journal.state = 'failed';
      throw error;
    } finally {
      this.#rejectCode(Object.assign(new Error('authentication_mail_finished'), { code: 'authentication_mail_finished' }));
      this.#rejectReady(Object.assign(new Error('authentication_mail_finished'), { code: 'authentication_mail_finished' }));
      this.#resolveOutcome({ authenticated: this.journal.state === 'authenticated', acknowledgement: this.journal.acknowledgement });
    }
  }
  cancel(code = 'authentication_mail_cancelled') {
    if (this.#finished) return;
    this.#finished = true; this.clearTimer(this.#timer);
    // The parent authenticator retains its persisted pending fence. No input
    // is replayed and no mailbox flag is changed on cancellation or expiry.
    this.#rejectCode(Object.assign(new Error(code), { code }));
    this.#rejectReady(Object.assign(new Error(code), { code }));
    this.#resolveOutcome({ authenticated: false, acknowledgement: 'none' });
  }
  async claimAcknowledgement(actor, handle, reference) {
    this.#authorize(actor, handle, { allowExpired: true });
    const ref = validateBrowserMailReference(reference);
    if (this.journal.state !== 'authenticated' || JSON.stringify(ref) !== JSON.stringify(this.journal.reference)) mailFail('authentication_mail_not_verified');
    if (this.journal.acknowledgement === 'complete') return { action: 'none' };
    // A pending/unknown marker never grants another STORE, even after a
    // lost process response. The mail provider may only read back exact flags.
    if (this.journal.acknowledgement !== 'none') return { action: 'verify_only' };
    if (this.now() >= this.journal.expiresAt) mailFail('authentication_mail_expired');
    this.journal.acknowledgement = 'pending';
    await this.persist(); this.active();
    return { action: 'mark_seen_once' };
  }
  async recordAcknowledgement(actor, handle, { seenVerified, writeAttempted }) {
    this.#authorize(actor, handle, { allowExpired: true });
    if (this.journal.state !== 'authenticated' || this.journal.acknowledgement === 'none'
      || typeof seenVerified !== 'boolean' || typeof writeAttempted !== 'boolean') mailFail('authentication_mail_not_verified');
    this.journal.acknowledgement = seenVerified ? 'complete' : 'unknown';
    await this.persist();
    return { authenticated: true, acknowledgement: this.journal.acknowledgement };
  }
}

/** Process-only bridge for a signed non-JS mail runtime. OTP and private
 * matchers travel on captured stdin/stdout, never argv/env/ordinary MCP.
 * A handle locates exactly one existing browser; it cannot start a browser,
 * choose an executable, reopen a vault, reset a fence or extend its lease.
 */
export async function relayBrowserMail(message, { env = process.env } = {}) {
  // Lazy imports keep pure normalization/result projection free of the host
  // workspace dependency cycle. Private storage loads only for a real call.
  const { resolveWorkspaceBridgeConfigDirectory, readPrivateJsonFile, assertPrivatePathKind } = await import('./trelio-workspace.mjs');
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


/** One email account cannot supply codes to two concurrent browser logins.
 * Otherwise a newly arrived code could satisfy the wrong same-service request
 * before a second message reveals the ambiguity. This is coordination only:
 * no password/OTP/session is stored, and the original credential attempt fence
 * remains authoritative after a crash or expired lock reclamation.
 */
export async function acquireBrowserMailLock({ mailSkillId, mailAccountId, browserScope, expiresAt,
  origin = 'https://trelio.ru', directory, now = Date.now }) {
  const { resolveWorkspaceBridgeConfigDirectory, readPrivateJsonFile, writePrivateJsonFile } = await import('./trelio-workspace.mjs');
  const { prepareVisualPrivateDirectory } = await import('./trelio-visual-bootstrap.mjs');
  directory ??= resolveWorkspaceBridgeConfigDirectory();
  const mailFail = () => { throw Object.assign(new Error('authentication_mail_busy'), { code: 'authentication_mail_busy' }); };
  if (typeof mailSkillId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,119}$/u.test(mailSkillId)
    || !/^[0-9a-f-]{36}$/u.test(mailAccountId) || !/^[0-9a-f]{64}$/u.test(browserScope)
    || !Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt - now() > 120000) mailFail();
  const root = path.join(directory, 'browser-mail-accounts');
  await prepareVisualPrivateDirectory(root);
  const key = createHash('sha256').update(JSON.stringify([origin, mailSkillId, mailAccountId])).digest('hex');
  const lock = path.join(root, key), file = path.join(lock, 'owner.json');
  const valid = value => value?.version === 1 && /^[0-9a-f]{64}$/u.test(value.nonce || '')
    && /^[0-9a-f]{64}$/u.test(value.browserScope || '') && Number.isSafeInteger(value.expiresAt)
    && Number.isSafeInteger(value.pid) && value.pid > 0;
  try { await fsp.mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await readPrivateJsonFile(file, { maximumBytes: 2048 });
    if (!valid(previous) || previous.expiresAt > now()) mailFail();
    const recovery = path.join(lock, 'recovery');
    try { await fsp.mkdir(recovery, { mode: 0o700 }); }
    catch (error) { if (['EEXIST', 'ENOENT'].includes(error.code)) mailFail(); throw error; }
    let moved = false;
    try {
      await prepareVisualPrivateDirectory(recovery);
      const current = await readPrivateJsonFile(file, { maximumBytes: 2048 });
      if (current.nonce !== previous.nonce || current.expiresAt > now()
        || (await fsp.readdir(lock)).sort().join() !== 'owner.json,recovery') mailFail();
      const old = `${lock}.${randomUUID()}.closed`;
      await fsp.rename(lock, old); moved = true;
      await fsp.unlink(path.join(old, 'owner.json'));
      await fsp.rmdir(path.join(old, 'recovery')); await fsp.rmdir(old);
    } finally { if (!moved) await fsp.rmdir(recovery); }
    try { await fsp.mkdir(lock, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') mailFail(); throw error; }
  }
  await prepareVisualPrivateDirectory(lock);
  const record = { version: 1, nonce: randomBytes(32).toString('hex'), browserScope, expiresAt, pid: process.pid };
  await writePrivateJsonFile(file, record);
  let released = false;
  return {
    expiresAt,
    assertActive() { if (released || now() >= expiresAt) mailFail(); },
    async release() {
      if (released) return;
      const current = await readPrivateJsonFile(file, { maximumBytes: 2048 });
      // A stale owner must not remove a fresh successor after its own expiry.
      if (current.nonce !== record.nonce) { released = true; return; }
      if ((await fsp.readdir(lock)).join() !== 'owner.json') mailFail();
      await fsp.unlink(file); await fsp.rmdir(lock); released = true;
    },
  };
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
