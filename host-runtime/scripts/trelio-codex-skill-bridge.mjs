// The native read and local launch can have different LOCALAPPDATA on Windows.
// Remember where the already admitted read obtained its bridge credential.
// Only the exact native chat and returned skill action can select that store.
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { normalizeRuntimeChatId } from "./trelio-runtime-chat-binding.mjs";

const MAX_AGE_MS = 12 * 60 * 60 * 1_000;
const MAX_RECORD_BYTES = 4_096;

const locator = ({ origin, codexThreadId, runtimeSessionId, companyId, projectId, skillId, releaseId },
  homeDirectory = os.homedir()) => {
  const chat = normalizeRuntimeChatId(codexThreadId);
  const runtime = normalizeRuntimeChatId(runtimeSessionId);
  const company = normalizeRuntimeChatId(companyId);
  const project = projectId == null ? "" : normalizeRuntimeChatId(projectId);
  const release = normalizeRuntimeChatId(releaseId);
  if (!chat || !runtime || !company || project === null || !release || typeof skillId !== "string"
    || skillId.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skillId)) return null;

  // Independent of either MCP registration's LOCALAPPDATA. The existing
  // Windows owner-only file helper protects this directory and every record.
  const key = crypto.createHash("sha256")
    .update(JSON.stringify([new URL(origin).origin, chat, runtime, company, project, skillId, release]))
    .digest("hex");
  return path.join(homeDirectory, "AppData", "Local", "Trelio", "workspace-bridge", "codex-skill-bridges", `${key}.json`);
};

const isBridgeDirectory = value => typeof value === "string" && value.length <= 1_024
  && /^[a-z]:[\\/]/iu.test(value)
  && !value.includes("\0")
  && path.win32.basename(value).toLowerCase() === "workspace-bridge"
  && path.win32.basename(path.win32.dirname(value)).toLowerCase() === "trelio";

/** The locator stores only the directory of the existing DPAPI credential
 * and an expiry. The server compares the original session with the selected
 * credential before returning the signed runtime.
 */
export const rememberCodexSkillBridge = async ({ origin, codexThreadId, proof, result, bridgeDirectory,
  writePrivateJsonFile, homeDirectory, now = Date.now() }) => {
  if (result?.isError || !normalizeRuntimeChatId(proof?.runtimeSessionId) || !isBridgeDirectory(bridgeDirectory)) return;
  const action = result?.structuredContent?.runtimeExecution?.localAction;
  const handoff = action?.arguments;
  const parameters = handoff?.parameters;
  if (action?.tool !== "continue_trelio_workspace_action" || handoff?.schemaVersion !== 1 || handoff?.operation !== "skill_run"
    || parameters?.runtimeSessionId !== proof.runtimeSessionId) return;
  const file = locator({ ...parameters, origin, codexThreadId }, homeDirectory);
  if (!file) return;
  // This recovery aid must not fail a successfully authenticated read on a
  // machine where the sharing directory is unavailable or not private.
  await writePrivateJsonFile(file, { schemaVersion: 1, bridgeDirectory, expiresAt: now + MAX_AGE_MS })
    .catch(() => undefined);
};

const readCodexSkillBridge = async (binding, { readPrivateJsonFile, homeDirectory, now = Date.now() }) => {
  const file = locator(binding, homeDirectory);
  if (!file) return null;
  const record = await readPrivateJsonFile(file, { maximumBytes: MAX_RECORD_BYTES, fatalUtf8: true });
  if (Object.keys(record).length === 0) return null;
  if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.expiresAt) || !isBridgeDirectory(record.bridgeDirectory)) {
    throw new Error("Invalid private Codex skill bridge binding.");
  }
  return record.expiresAt > now ? record.bridgeDirectory : null;
};

export const resolveCodexSkillBridgeToken = async (binding, {
  localBridgeDirectory, readPrivateJsonFile, readProtectedBridgeSession, homeDirectory, now,
}) => {
  const directory = await readCodexSkillBridge(binding, { readPrivateJsonFile, homeDirectory, now });
  if (!directory || path.win32.normalize(directory).toLowerCase() === path.win32.normalize(localBridgeDirectory).toLowerCase()) {
    return null;
  }
  const credentials = await readPrivateJsonFile(path.win32.join(directory, "credentials.json"),
    { maximumBytes: 64 * 1024, fatalUtf8: true });
  const token = await readProtectedBridgeSession(binding.origin, credentials[binding.origin]);
  if (typeof token !== "string" || !token.startsWith("twb_")) throw new Error("Paired bridge unavailable.");
  return token;
};
