/** Optional local UI context; never an admission, credential or task binding. */
import crypto from "node:crypto";
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
