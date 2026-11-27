import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { normalizeRuntimeChatId } from "./trelio-runtime-chat-binding.mjs";

// Every native continuation carrying a runtime session uses the bridge that
// registered it. Windows MCP processes may have different LOCALAPPDATA values.
// The owner-only index is independent of both values; the DPAPI record remains
// in the registering process's original directory.
const childBindingVariable = "TRELIO_CODEX_BRIDGE_BINDING";
const bindingKeyPattern = /^[0-9a-f]{64}$/u;
const activeBinding = new AsyncLocalStorage();
const recorded = new Map();
const normalizedDirectory = value => path.win32.normalize(value).toLowerCase();
const isBridgeDirectory = value => typeof value === "string" && value.length <= 1024 && !value.includes("\0")
  && path.win32.parse(value).root.length > 1 && path.win32.basename(value).toLowerCase() === "workspace-bridge"
  && path.win32.basename(path.win32.dirname(value)).toLowerCase() === "trelio";
const bindingKey = (origin, threadId, runtimeSessionId) => {
  const chat = normalizeRuntimeChatId(threadId);
  const session = normalizeRuntimeChatId(runtimeSessionId);
  return chat && session ? createHash("sha256").update(JSON.stringify([origin, chat, session])).digest("hex") : null;
};
const bindingFile = (key, homeDirectory = os.userInfo().homedir) =>
  path.join(homeDirectory, "AppData", "Local", "Trelio", "workspace-bridge", "codex-bridge-sessions", `${key}.json`);

export const saveNativeCodexBridge = async ({ origin, threadId, runtimeSessionId, expiresAt, bridgeDirectory }, {
  writePrivateJsonFile, homeDirectory, now = Date.now(),
}) => {
  const key = bindingKey(origin, threadId, runtimeSessionId);
  const expiry = Date.parse(expiresAt);
  if (!key || !isBridgeDirectory(bridgeDirectory) || !Number.isFinite(expiry) || expiry <= now) return;
  const file = bindingFile(key, homeDirectory);
  if (recorded.get(file) === expiry) return;
  await writePrivateJsonFile(file, { schemaVersion: 1, origin, threadId: threadId.toLowerCase(),
    runtimeSessionId: runtimeSessionId.toLowerCase(), bridgeDirectory, expiresAt: expiry });
  if (recorded.size === 128) recorded.delete(recorded.keys().next().value);
  recorded.set(file, expiry);
};

const invalidBinding = () => new Error("Не удалось открыть исходное подключение Codex для этого действия.");

const readBinding = async (key, { readPrivateJsonFile, homeDirectory, now = Date.now() }) => {
  let record;
  try {
    record = await readPrivateJsonFile(bindingFile(key, homeDirectory), { maximumBytes: 4096, fatalUtf8: true });
  } catch { throw invalidBinding(); } // Private I/O errors can contain user paths.
  if (Object.keys(record ?? {}).length === 0) return null;
  if (record.schemaVersion !== 1 || bindingKey(record.origin, record.threadId, record.runtimeSessionId) !== key
    || !Number.isSafeInteger(record.expiresAt) || !isBridgeDirectory(record.bridgeDirectory)) throw invalidBinding();
  return record.expiresAt > now ? { ...record, key } : null;
};

export const withNativeCodexBridge = async ({ origin, threadId, runtimeSessionId }, run, dependencies) => {
  const key = bindingKey(origin, threadId, runtimeSessionId);
  if (!key) return run();
  const binding = await readBinding(key, dependencies);
  return binding && normalizedDirectory(binding.bridgeDirectory) !== normalizedDirectory(dependencies.localBridgeDirectory)
    ? activeBinding.run(binding, run) : run();
};

export const nativeCodexBridge = () => activeBinding.getStore();

// The trusted bridge child receives an opaque index key solely in its own
// environment. It consumes the key before it can spawn another executable.
// This keeps native stdin available for checkpoint data and Secrets.
export const nativeCodexBridgeChildEnvironment = (environment = process.env) => {
  const binding = nativeCodexBridge();
  return binding ? { ...environment, [childBindingVariable]: binding.key } : environment;
};

export const withNativeCodexBridgeChild = async (run, { environment = process.env, platform = process.platform, ...dependencies }) => {
  const key = environment[childBindingVariable];
  delete environment[childBindingVariable];
  if (platform !== "win32" || key === undefined) return run();
  if (!bindingKeyPattern.test(key)) throw invalidBinding();
  const binding = await readBinding(key, dependencies);
  if (!binding) throw invalidBinding();
  return activeBinding.run(binding, run);
};

export const loadNativeCodexBridgeToken = async (origin, { readPrivateJsonFile, readProtectedSession }) => {
  const binding = nativeCodexBridge();
  if (!binding) return null;
  if (binding.origin !== origin) throw invalidBinding();
  // Within an action, retain the same protected credential across all of its
  // requests. A missing or replaced credential must fail at its original gate.
  binding.token ??= (async () => {
    try {
      const credentials = await readPrivateJsonFile(path.win32.join(binding.bridgeDirectory, "credentials.json"),
        { maximumBytes: 64 * 1024, fatalUtf8: true });
      const token = await readProtectedSession(origin, credentials[origin]);
      if (typeof token === "string" && token.startsWith("twb_")) return token;
    } catch { /* Keep the configured path and the DPAPI exception private. */ }
    throw invalidBinding();
  })();
  return binding.token;
};
