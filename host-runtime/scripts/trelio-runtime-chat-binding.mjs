import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_BYTES = 1024;
export const normalizeRuntimeChatId = value => UUID.test(String(value)) ? value.toLowerCase() : null;

export const runtimeChatBindingPath = ({ configDirectory, runtimeSessionId }) => {
  if (!UUID.test(String(runtimeSessionId))) return null;
  const key = crypto.createHash("sha256")
    .update(runtimeSessionId.toLowerCase()).digest("hex");
  return path.join(configDirectory, "runtime-chat-bindings", `${key}.json`);
};

// The optional UI label below cannot authorize admission, credentials or tasks.
const matchesBinding = (value, { origin, runtimeSessionId, now = Date.now() }) => (
  value?.schemaVersion === 1
  && value.origin === new URL(origin).origin
  && value.runtimeSessionId === runtimeSessionId?.toLowerCase()
  && UUID.test(String(value.codexThreadId))
  && Number.isFinite(Date.parse(value.expiresAt))
  && Date.parse(value.expiresAt) > now
  && Date.parse(value.expiresAt) <= now + 24 * 60 * 60 * 1000
);

/**
 * The current hook event, not the long-lived MCP environment, selects the chat.
 * Keep only its UUID and the original registered expiry in a private exact-ID
 * record. Never copy titles, transcripts, signing keys or proofs into this index.
 * A hook can hydrate an already registered pre-upgrade session without rotating
 * its key/model/expiry. Different model snapshots keep their own runtime IDs.
 */
export const saveRuntimeChatBinding = async (options) => {
  const { clientSessionId, clientFamily, expiresAt, readPrivateJsonFile, writePrivateJsonFile } = options;
  if (clientFamily !== "codex" || !UUID.test(String(clientSessionId))) return false;
  try {
    const file = runtimeChatBindingPath(options);
    if (!file) return false;
    const value = { schemaVersion: 1, origin: new URL(options.origin).origin,
      runtimeSessionId: options.runtimeSessionId.toLowerCase(),
      codexThreadId: clientSessionId.toLowerCase(), expiresAt };
    if (!matchesBinding(value, options)) return false;
    const existing = await readPrivateJsonFile(file, { maximumBytes: MAX_BYTES });
    if (Object.keys(existing).length) return matchesBinding(existing, options)
      && existing.codexThreadId === value.codexThreadId && existing.expiresAt === expiresAt;
    await writePrivateJsonFile(file, value);
    return true;
  } catch {
    // This optional label must not change proof/admission or reveal OS paths.
    // A failed private read never becomes an overwrite or a guessed chat.
    return false;
  }
};

export const readRuntimeChatBinding = async (options) => {
  try {
    const file = runtimeChatBindingPath(options);
    if (!file) return null;
    const value = await options.readPrivateJsonFile(file, { maximumBytes: MAX_BYTES });
    return matchesBinding(value, options) ? value.codexThreadId : null;
  } catch { return null; }
};

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
  return chat && session ? crypto.createHash("sha256").update(JSON.stringify([origin, chat, session])).digest("hex") : null;
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
