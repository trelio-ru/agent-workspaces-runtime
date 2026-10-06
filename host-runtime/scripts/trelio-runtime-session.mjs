#!/usr/bin/env node

/**
 * Always-on runtime admission for Codex and Claude Code.
 *
 * The hook observes model/effort once, registers an Ed25519 public key through
 * the paired bridge, and injects a fresh signature after each protected tool
 * call has been authored by the model. The private key never enters chat,
 * tool output, MCP arguments, Workspace or backend storage.
 */
import crypto from "node:crypto";
import {
  readTrelioHookToolInput,
  resolveTrelioHookToolIdentity,
  TrelioHookToolIdentityError,
} from "./trelio-hook-tool-identity.mjs";
export { resolveTrelioMcpToolName } from "./trelio-hook-tool-identity.mjs";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  detectAgentRuntimeAttestation,
  resolveRuntimeClientSessionId,
} from "./trelio-runtime-attestation.mjs";
import {
  RUNTIME_HOOK_EXECUTION_TIMEOUT_MILLISECONDS,
  RUNTIME_PENDING_STATE_MAX_AGE_MILLISECONDS,
  RUNTIME_REGISTRATION_TIMEOUT_MILLISECONDS,
  RUNTIME_STATE_LOCK_STALE_MILLISECONDS,
  RUNTIME_STATE_LOCK_WAIT_MILLISECONDS,
} from "./trelio-runtime-session-limits.mjs";
import {
  LOCAL_PROPOSAL_ROUTE_MARKER_MAX_BYTES,
  isActiveLocalProposalRouteMarker,
  resolveNativeProposalRouteMarkerPaths,
} from "./trelio-proposal-route-guard.mjs";
import { migrateCodexLegacyTrelioMcpForRuntime } from "./trelio-codex-routing.mjs";
import { TRELIO_COMPACTION_RECOVERY_CONTEXT } from "./trelio-context-recovery.mjs";

import {
  assertRuntimeHookBudget, runtimeHookSignal, withRuntimeHookPrivateSession,
} from "./trelio-hook-private-session.mjs";

const DISCOVERY_TOOLS = new Set([
  "list_knowledge_base_pages", "list_contacts", "list_registries",
  "search_meetings", "list_workspaces", "list_agent_secrets",
  "search_agent_secrets", "search",
  "search_tasks", "search_agent_workspace_files", "list_companies",
  "list_projects", "search_agent_guidance", "list_agent_skills", "list_my_tasks",
  "list_project_tasks", "list_task_connections", "get_project_meta",
  "get_task_create_meta", "get_my_context", "resolve_user",
  "resolve_company_member", "resolve_status", "get_task_move_options",
  "list_notifications",
]);
const RECOVERY_TOOLS = new Set([
  "approve_agent_workspace_bridge_pairing",
  "list_agent_workspace_bridge_sessions",
  "revoke_agent_workspace_bridge_session",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HOOK_REQUIRED_CODE = "TRELIO_RUNTIME_HOOK_REQUIRED";
const HOOK_FAILED_CODE = "TRELIO_RUNTIME_HOOK_FAILED";
const SUPPORTED_HOOK_EVENTS = new Set(["SessionStart", "PreToolUse", "SessionEnd"]);
const HOST_RUNTIME_RECOVERY_CODES = new Set([
  "AGENT_WORKSPACE_HOST_RUNTIME_UPGRADE_REQUIRED",
  "AGENT_SKILL_RUNTIME_HOST_UPGRADE_REQUIRED",
]);
const PLUGIN_UPGRADE_REQUIRED_CODE = "AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED";
const LEGACY_MCP_RESTART_REQUIRED_CODE = "TRELIO_CODEX_LEGACY_MCP_RESTART_REQUIRED";
const LEGACY_MCP_REMOVAL_FAILED_CODE = "TRELIO_CODEX_LEGACY_MCP_REMOVAL_FAILED";
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;
const RUNTIME_END_TIMEOUT_MILLISECONDS = 1_500;
const RUNTIME_STATE_EXPIRY_GRACE_MILLISECONDS = 30_000;
// SessionStart has a ten-second host budget, including cold Node startup and
// private ACL checks. A bounded sweep makes steady progress without letting a
// large or damaged owner-only directory delay the lifecycle hook indefinitely.
const RUNTIME_STATE_CLEANUP_SCAN_LIMIT = 256;
const RUNTIME_STATE_CLEANUP_REMOVE_LIMIT = 64;
let workspaceBridgeModulePromise;

// PreToolUse вызывается и для нетрелиевских инструментов. Большой bridge
// загружаем только после того, как установлено, что действительно нужен
// lifecycle state или защищённый Trelio proof.
const loadWorkspaceBridgeModule = () => {
  workspaceBridgeModulePromise ??= import("./trelio-workspace.mjs");
  return workspaceBridgeModulePromise;
};

const readStdinJson = async () => {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error("Hook input is too large.");
    chunks.push(Buffer.from(chunk));
  }
  // A launched hook with no payload cannot distinguish a protected PreToolUse
  // from an advisory lifecycle event. Returning success here would let Codex
  // call Trelio without updatedInput and obscure the local transport failure.
  if (chunks.length === 0) throw new Error("Hook input is empty.");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

export const isProtectedTrelioToolName = (toolName) => Boolean(
  toolName && !DISCOVERY_TOOLS.has(toolName) && !RECOVERY_TOOLS.has(toolName)
);

const resolveToolInput = readTrelioHookToolInput;

const resolveRuntimeStateDirectory = async (configDirectory = null) => {
  if (configDirectory) return path.join(configDirectory, "runtime-sessions");
  const { resolveWorkspaceBridgeConfigDirectory } = await loadWorkspaceBridgeModule();
  return path.join(resolveWorkspaceBridgeConfigDirectory(), "runtime-sessions");
};

const statePathFor = async (clientSessionId, origin) => {
  const runtimeDirectory = await resolveRuntimeStateDirectory();
  return path.join(
    runtimeDirectory,
    `${crypto.createHash("sha256").update(`${origin}\n${clientSessionId}`).digest("hex")}.json`,
  );
};

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

/**
 * The first two protected calls may be authored almost simultaneously. An
 * atomic private lock ensures they register one server session and then share
 * its local key. Without it, the last writer would orphan the other session
 * and one of the already-created proofs could fail nondeterministically.
 */
const withRuntimeStateLock = async (filePath, operation) => {
  const lockPath = `${filePath}.lock`;
  const { ensurePrivateDirectory } = await loadWorkspaceBridgeModule();
  await ensurePrivateDirectory(path.dirname(filePath));
  const startedAt = Date.now();

  for (;;) {
    // Every retry, including a vanished or recovered stale lock, shares the
    // same deadline. Checking only the live-lock branch previously allowed
    // an undeletable stale directory to spin until the client killed us.
    if (Date.now() - startedAt >= RUNTIME_STATE_LOCK_WAIT_MILLISECONDS) {
      throw new Error("другая runtime-регистрация не завершилась вовремя");
    }
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const metadata = await fs.lstat(lockPath).catch((statError) => {
        // Only disappearance is an ordinary race. Permission/I/O failures
        // must retain their cause instead of looking like an absent lock.
        if (statError.code === "ENOENT") return null;
        throw statError;
      });
      if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) {
        throw new Error("локальная блокировка runtime-сессии имеет небезопасный тип");
      }
      if (metadata && Date.now() - metadata.mtimeMs > RUNTIME_STATE_LOCK_STALE_MILLISECONDS) {
        await fs.rmdir(lockPath).catch((removeError) => {
          if (removeError.code === "ENOENT") return;
          // Never recursively remove someone else's lock contents or reset
          // ACLs. Report a bounded, value-free reason and leave it intact.
          const failure = new Error(
            `не удалось удалить устаревшую блокировку runtime-сессии (${removeError.code || "IO_ERROR"})`,
            { cause: removeError },
          );
          failure.code = "TRELIO_RUNTIME_LOCK_RECOVERY_FAILED";
          throw failure;
        });
      }
      await wait(40);
    }
  }

  try {
    // Once mkdir succeeds we own cleanup even if permission hardening fails.
    if (process.platform !== "win32") await fs.chmod(lockPath, 0o700);
    return await operation();
  } finally {
    await fs.rmdir(lockPath).catch(() => undefined);
  }
};

const readStoredState = async (filePath) => {
  try {
    const { readPrivateJsonFile } = await loadWorkspaceBridgeModule();
    return await readPrivateJsonFile(filePath);
  } catch {
    return {};
  }
};

const readRuntimeState = async (filePath) => {
  try {
    const state = await readStoredState(filePath);
    if (
      state.schemaVersion !== 1
      || !UUID_PATTERN.test(String(state.runtimeSessionId || ""))
      || typeof state.privateKeyPkcs8 !== "string"
      || Number.isNaN(Date.parse(String(state.expiresAt || "")))
      || Date.parse(state.expiresAt) <= Date.now() + 30_000
    ) return null;
    crypto.createPrivateKey({
      key: Buffer.from(state.privateKeyPkcs8, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    return state;
  } catch {
    return null;
  }
};

const readPendingObservation = async (filePath) => {
  const state = await readStoredState(filePath);
  return state.schemaVersion === 1
    && state.pending === true
    && state.observation
    && typeof state.observation === "object"
    ? state.observation
    : null;
};

const staleRuntimeStateReason = (state, nowMilliseconds) => {
  if (
    state?.schemaVersion === 1
    && state.pending === true
    && state.observation
    && typeof state.observation === "object"
  ) {
    const createdAtMilliseconds = Date.parse(String(state.createdAt || ""));
    return !Number.isNaN(createdAtMilliseconds)
      && createdAtMilliseconds
        <= nowMilliseconds - RUNTIME_PENDING_STATE_MAX_AGE_MILLISECONDS
      ? "pending"
      : null;
  }
  if (
    state?.schemaVersion === 1
    && UUID_PATTERN.test(String(state.runtimeSessionId || ""))
    && typeof state.privateKeyPkcs8 === "string"
  ) {
    const expiresAtMilliseconds = Date.parse(String(state.expiresAt || ""));
    return !Number.isNaN(expiresAtMilliseconds)
      && expiresAtMilliseconds
        <= nowMilliseconds + RUNTIME_STATE_EXPIRY_GRACE_MILLISECONDS
      ? "expired"
      : null;
  }
  // Unknown or damaged records stay visible to doctor as invalid. Automatic
  // cleanup only removes states whose safe lifecycle expiry can be proved.
  return null;
};

const readRuntimeStateForCleanup = async (filePath) => {
  // Cleanup never uses the record as authorization, but it still reads only a
  // bounded regular file under the already-verified owner-only directory.
  // Avoiding the normal per-file Windows ACL hardening is essential here: one
  // SessionStart may inspect hundreds of old records within a ten-second host
  // budget, while any malformed or widened file is simply preserved.
  const flags = fsConstants.O_RDONLY
    | (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW || 0));
  let handle;
  try {
    handle = await fs.open(filePath, flags);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 64 * 1_024) return null;
    if (process.platform !== "win32") {
      const currentUserId = typeof process.getuid === "function" ? process.getuid() : null;
      if (
        (currentUserId !== null && metadata.uid !== currentUserId)
        || (metadata.mode & 0o777) !== 0o600
      ) return null;
    }
    return JSON.parse(await handle.readFile("utf8"));
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
};

const removeStaleRuntimeLock = async (lockPath, nowMilliseconds) => {
  try {
    const metadata = await fs.lstat(lockPath);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || nowMilliseconds - metadata.mtimeMs <= RUNTIME_STATE_LOCK_STALE_MILLISECONDS
    ) return false;
    // Runtime registration locks are empty by construction. rmdir therefore
    // refuses a replaced or malformed non-empty directory instead of deleting
    // arbitrary contents.
    await fs.rmdir(lockPath);
    return true;
  } catch {
    return false;
  }
};

const removeStaleRuntimeState = async (filePath, nowMilliseconds) => {
  const lockPath = `${filePath}.lock`;
  try {
    // Reuse the registration lock namespace, but never wait during global
    // housekeeping: a live registration owns the state and must win.
    await fs.mkdir(lockPath, { mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(lockPath, 0o700);
  } catch {
    return null;
  }

  try {
    const state = await readRuntimeStateForCleanup(filePath);
    const reason = staleRuntimeStateReason(state, nowMilliseconds);
    if (!reason) return null;
    await fs.rm(filePath, { force: true });
    return reason;
  } catch {
    return null;
  } finally {
    await fs.rmdir(lockPath).catch(() => undefined);
  }
};

/**
 * Recover lifecycle residue left when a client crashes or omits SessionEnd.
 * The sweep is local, bounded and fail-closed: it never contacts the backend,
 * waits for a live lock or removes a record without proving its expiry.
 */
export const cleanupStaleRuntimeSessions = async ({
  configDirectory = null,
  nowMilliseconds = Date.now(),
} = {}) => {
  const runtimeDirectory = await resolveRuntimeStateDirectory(configDirectory);
  const { ensurePrivateDirectory } = await loadWorkspaceBridgeModule();
  // One directory-level ACL verification gives the sweep a private namespace.
  // State used to sign a proof still goes through the stricter per-file reader.
  await ensurePrivateDirectory(runtimeDirectory);
  const entries = await fs.readdir(runtimeDirectory, { withFileTypes: true });

  const staleLockEntries = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".json.lock"))
    .slice(0, RUNTIME_STATE_CLEANUP_SCAN_LIMIT);
  let staleLocksRemoved = 0;
  for (const entry of staleLockEntries) {
    if (staleLocksRemoved >= RUNTIME_STATE_CLEANUP_REMOVE_LIMIT) break;
    if (await removeStaleRuntimeLock(
      path.join(runtimeDirectory, entry.name),
      nowMilliseconds,
    )) staleLocksRemoved += 1;
  }

  const stateEntries = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .slice(0, RUNTIME_STATE_CLEANUP_SCAN_LIMIT);
  let expiredRemoved = 0;
  let pendingRemoved = 0;
  for (const entry of stateEntries) {
    if (expiredRemoved + pendingRemoved >= RUNTIME_STATE_CLEANUP_REMOVE_LIMIT) break;
    const reason = await removeStaleRuntimeState(
      path.join(runtimeDirectory, entry.name),
      nowMilliseconds,
    );
    if (reason === "expired") expiredRemoved += 1;
    if (reason === "pending") pendingRemoved += 1;
  }

  return { expiredRemoved, pendingRemoved, staleLocksRemoved };
};

const isTransientError = (error) => (
  [408, 429, 500, 502, 503, 504].includes(Number(error?.statusCode))
  || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"]
    .includes(String(error?.code || error?.cause?.code || ""))
);

const retryIdempotentRequest = async (operation) => {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (2 ** attempt)));
    }
  }
  throw lastError;
};

const createRuntimeState = async ({
  hookInput,
  clientSessionId,
  origin,
  filePath,
  initialObservation = null,
}) => {
  const currentObservation = await detectAgentRuntimeAttestation({ hookInput });
  assertRuntimeHookBudget();
  // SessionStart reliably supplies the selected model but Codex does not yet
  // document effort in that event. Preserve the initial model/client and fill
  // only missing evidence from the first protected PreToolUse.
  const observation = initialObservation
    ? {
        ...currentObservation,
        clientFamily: initialObservation.clientFamily === "other"
          ? currentObservation.clientFamily
          : initialObservation.clientFamily,
        modelId: initialObservation.modelId || currentObservation.modelId,
        effortLevel: initialObservation.effortLevel || currentObservation.effortLevel,
        source: initialObservation.source === "unknown"
          ? currentObservation.source
          : initialObservation.source,
        evidenceLevel: (initialObservation.modelId || currentObservation.modelId)
          ? "local_observed"
          : "unavailable",
        observedAt: currentObservation.observedAt,
      }
    : currentObservation;
  if (
    (observation.clientFamily === "codex" || observation.clientFamily === "claude-code")
    && (!observation.modelId || observation.evidenceLevel !== "local_observed")
  ) {
    throw new Error(
      "активный клиентский hook не смог определить модель. Повторите запрос; если ошибка сохранится, начните новую задачу",
    );
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeySpki = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const privateKeyPkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url");
  const {
    requireToken,
    registerAgentRuntimeHookSession,
    recoverRejectedBridgeSession,
    writePrivateJsonFile,
  } = await loadWorkspaceBridgeModule();

  // Start the shared network deadline lazily. Windows DPAPI and macOS Keychain
  // work is local but can be slow on a cold user profile; charging that time to
  // the HTTP budget caused a valid first registration to abort before the
  // server replied. The signal getter is first read only by a real conflict
  // probe, pairing request or registration, so divergent credentials still
  // share one bounded deadline with the subsequent session registration.
  let registrationSignal = null;
  // Hook stdout is a single JSON protocol response. A completed pairing must
  // not prepend the CLI login status line before updatedInput.
  const networkOptions = { onStatus: () => undefined };
  Object.defineProperty(networkOptions, "signal", {
    enumerable: true,
    get: () => {
      assertRuntimeHookBudget();
      registrationSignal ??= AbortSignal.any([
        AbortSignal.timeout(RUNTIME_REGISTRATION_TIMEOUT_MILLISECONDS),
        ...(runtimeHookSignal() ? [runtimeHookSignal()] : []),
      ]);
      return registrationSignal;
    },
  });
  let token = await requireToken(origin, networkOptions);
  registrationSignal ??= networkOptions.signal;
  const register = () => retryIdempotentRequest(() => (
    registerAgentRuntimeHookSession({
      origin,
      token,
      clientSessionId,
      observation,
      publicKeySpki,
      signal: registrationSignal,
    })
  ));
  let registration;
  try {
    registration = await register();
  } catch (error) {
    // Registration has not admitted the protected call. Only a separately
    // confirmed device-session 401 enters normal pairing; approval still runs
    // through the user's MCP client. Keep the SessionStart observation and the
    // same deadline, and retry registration at most once with a replacement.
    token = await recoverRejectedBridgeSession(origin, token, error, networkOptions);
    registration = await register();
  }
  const state = {
    schemaVersion: 1,
    runtimeSessionId: registration.runtimeSessionId,
    expiresAt: registration.expiresAt,
    privateKeyPkcs8,
  };
  await writePrivateJsonFile(filePath, state);
  return state;
};

export const buildRuntimeSessionProof = ({ state, toolName, now = new Date() }) => {
  const issuedAt = now.toISOString();
  const nonce = crypto.randomUUID();
  const payload = Buffer.from([
    "trelio-runtime-proof-v1",
    state.runtimeSessionId,
    toolName,
    issuedAt,
    nonce,
  ].join("\n"), "utf8");
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(state.privateKeyPkcs8, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  return {
    schemaVersion: 1,
    runtimeSessionId: state.runtimeSessionId,
    issuedAt,
    nonce,
    signature: crypto.sign(null, payload, privateKey).toString("base64url"),
  };
};

const writeUpdatedInput = (toolInput, proof) => {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        ...toolInput,
        runtimeSessionProof: proof,
      },
    },
  })}\n`);
};

const writeDeniedLocalProposalRenderer = () => {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Bridge уже выбрал local proposal provider для этой цели. Native renderer остановлен до запуска, чтобы хост не смонтировал лишнюю App-карточку. Используй уже полученный continue_trelio_local_action с route=proposal_context или вызови его для exact цели, затем следуй его nextCall к trelio-remote-skills.render_trelio_local_proposal с целью внутри payload.target.",
    },
  })}\n`);
};

const shouldDenyNativeProposalRenderer = async ({ origin, toolName, toolInput }) => {
  const {
    readPrivateJsonFile,
    resolveWorkspaceBridgeConfigDirectory,
  } = await loadWorkspaceBridgeModule();
  const markerPaths = resolveNativeProposalRouteMarkerPaths({
    configDirectory: resolveWorkspaceBridgeConfigDirectory(),
    origin,
    toolName,
    toolInput,
  });

  for (const markerPath of markerPaths) {
    const marker = await readPrivateJsonFile(markerPath, {
      maximumBytes: LOCAL_PROPOSAL_ROUTE_MARKER_MAX_BYTES,
    });
    if (isActiveLocalProposalRouteMarker({ marker, markerPath })) return true;
    if (Object.keys(marker).length > 0) {
      // Expired/unknown marker state has no authority. Removing this exact
      // hashed file prevents stale local routing from affecting later plain
      // company calls after an encryption transition or plugin upgrade.
      await fs.rm(markerPath, { force: true });
    }
  }
  return false;
};

const runPreToolUse = async (hookInput) => {
  const identity = resolveTrelioHookToolIdentity(hookInput);
  if (identity.status === "invalid") throw new TrelioHookToolIdentityError(identity.reason);
  const toolName = identity.toolName;
  if (!isProtectedTrelioToolName(toolName)) return;
  const origin = process.env.TRELIO_WORKSPACE_ORIGIN || "https://trelio.ru";
  const toolInput = resolveToolInput(hookInput);
  if (await shouldDenyNativeProposalRenderer({ origin, toolName, toolInput })) {
    writeDeniedLocalProposalRenderer();
    return;
  }
  const clientSessionId = resolveRuntimeClientSessionId(hookInput);
  if (!clientSessionId) throw new Error("клиент не передал session_id");
  const filePath = await statePathFor(clientSessionId, origin);
  let state = await readRuntimeState(filePath);
  if (!state) {
    state = await withRuntimeStateLock(filePath, async () => {
      // The winner may have completed while this process waited. Always
      // re-read after acquiring the lock before creating a second session.
      const registeredState = await readRuntimeState(filePath);
      if (registeredState) return registeredState;
      const initialObservation = await readPendingObservation(filePath);
      // Keep SessionStart evidence across a pairing/registration failure. The
      // next PreToolUse may not include a model, and asking for a new chat would
      // discard exactly the observation needed to resume this same request.
      // Successful registration atomically replaces the pending record.
      if (!initialObservation) await fs.rm(filePath, { force: true }).catch(() => undefined);
      return createRuntimeState({
        hookInput,
        clientSessionId,
        origin,
        filePath,
        initialObservation,
      });
    });
  }
  assertRuntimeHookBudget();
  writeUpdatedInput(toolInput, buildRuntimeSessionProof({ state, toolName }));
};

const runSessionStart = async (hookInput) => {
  const clientSessionId = resolveRuntimeClientSessionId(hookInput);
  if (!clientSessionId) return;
  const origin = process.env.TRELIO_WORKSPACE_ORIGIN || "https://trelio.ru";
  const filePath = await statePathFor(clientSessionId, origin);
  const source = typeof hookInput.source === "string" ? hookInput.source : "startup";
  let stateToEnd = null;

  // SessionEnd is best-effort and can be skipped when the desktop client or OS
  // terminates abruptly. Recover unrelated expired residue before establishing
  // the current session; cleanup errors must not block an otherwise valid hook.
  await cleanupStaleRuntimeSessions().catch(() => undefined);

  await withRuntimeStateLock(filePath, async () => {
    const existing = await readRuntimeState(filePath);
    if (source !== "clear" && existing) return;
    if (source !== "clear" && await readPendingObservation(filePath)) return;
    if (source === "clear") stateToEnd = existing;
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    const observation = await detectAgentRuntimeAttestation({ hookInput });
    const { writePrivateJsonFile } = await loadWorkspaceBridgeModule();
    await writePrivateJsonFile(filePath, {
      schemaVersion: 1,
      pending: true,
      observation,
      createdAt: new Date().toISOString(),
    });
  });

  if (stateToEnd) {
    const { endAgentRuntimeHookSession } = await loadWorkspaceBridgeModule();
    await endAgentRuntimeHookSession({
      origin,
      runtimeSessionId: stateToEnd.runtimeSessionId,
      signal: AbortSignal.any([
        AbortSignal.timeout(RUNTIME_END_TIMEOUT_MILLISECONDS),
        ...(runtimeHookSignal() ? [runtimeHookSignal()] : []),
      ]),
    }).catch(() => undefined);
  }
};

const runSessionEnd = async (hookInput) => {
  const clientSessionId = resolveRuntimeClientSessionId(hookInput);
  if (!clientSessionId) return;
  const origin = process.env.TRELIO_WORKSPACE_ORIGIN || "https://trelio.ru";
  const filePath = await statePathFor(clientSessionId, origin);
  const state = await readRuntimeState(filePath);
  // Local key removal is the privacy boundary and must complete before a slow
  // network cleanup can consume Codex's three-second SessionEnd budget. The
  // server session also expires independently if the best-effort request fails.
  await fs.rm(filePath, { force: true }).catch(() => undefined);
  if (state) {
    const { endAgentRuntimeHookSession } = await loadWorkspaceBridgeModule();
    await endAgentRuntimeHookSession({
      origin,
      runtimeSessionId: state.runtimeSessionId,
      // Cleanup remains best effort, but cannot renew the lifecycle deadline
      // after local ACL/credentials have already consumed part of it.
      signal: AbortSignal.any([
        AbortSignal.timeout(RUNTIME_END_TIMEOUT_MILLISECONDS),
        ...(runtimeHookSignal() ? [runtimeHookSignal()] : []),
      ]),
    }).catch(() => undefined);
  }
  // Close a narrow race with a first registration that began just before the
  // end event and completed while the bounded remote request was in flight.
  await fs.rm(filePath, { force: true }).catch(() => undefined);
};

const executeHookInput = async (hookInput) => {
  if (hookInput.hook_event_name === "SessionStart") {
    await runSessionStart(hookInput);
    // Both automatic and manual compaction arrive through the already approved
    // SessionStart matcher. Do not rotate its observation or read private
    // company files here. The immediate model continuation receives a compact
    // recovery obligation even when runSessionStart reused its existing state.
    if (hookInput.source === "compact") {
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: TRELIO_COMPACTION_RECOVERY_CONTEXT,
        },
      })}\n`);
    }
  } else if (hookInput.hook_event_name === "PreToolUse") {
    await runPreToolUse(hookInput);
  } else if (hookInput.hook_event_name === "SessionEnd") {
    await runSessionEnd(hookInput);
  }
};

const runChildProcess = async ({ arguments: childArguments, environment, input }) => (
  await new Promise((resolve, reject) => {
    assertRuntimeHookBudget();
    const child = spawn(process.execPath, childArguments, {
      env: environment,
      shell: false,
      stdio: ["pipe", "inherit", "inherit"],
      ...(runtimeHookSignal() ? { signal: runtimeHookSignal() } : {}),
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        if (runtimeHookSignal()?.aborted) { reject(new Error("истёк внутренний срок hook")); return; }
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
    child.stdin.end(input);
  })
);

/**
 * A runtime gate may be raised while PreToolUse is registering its protected
 * session, before the bridge command can use its own recovery. Reuse the
 * immutable stable-shell loader for that path as well: update the signed
 * runtime and replay the exact hook payload once. Process-only state guards
 * the replay, so a broken rollout fails closed instead of recursing.
 */
export const recoverHookHostRuntimeUpgrade = async (
  error,
  hookInput,
  {
    environment = process.env,
    statFile = fs.lstat,
    runProcess = runChildProcess,
  } = {},
) => {
  if (
    !HOST_RUNTIME_RECOVERY_CODES.has(error?.code)
    || environment.TRELIO_HOST_RUNTIME_UPDATE_REEXEC === "1"
  ) {
    return null;
  }

  const pluginRoot = String(environment.TRELIO_PLUGIN_ROOT || "").trim();
  if (!path.isAbsolute(pluginRoot)) return null;
  const loaderPath = path.join(pluginRoot, "scripts", "trelio-host-runtime-loader.mjs");
  const loaderMetadata = await statFile(loaderPath).catch(() => null);
  if (!loaderMetadata?.isFile() || loaderMetadata.isSymbolicLink()) return null;

  const recoveryEnvironment = {
    ...environment,
    TRELIO_HOST_RUNTIME_UPDATE_WAIT_FOR_LOCK: "1",
  };
  // A launcher/spawn failure must preserve the original structured gate. The
  // formatter can then give the precise runtime-rollout recovery instead of
  // collapsing an operational update failure into a generic hook error.
  const updateExitCode = await runProcess({
    arguments: [loaderPath, "__update"],
    environment: recoveryEnvironment,
    input: "",
  }).catch(() => null);
  if (updateExitCode !== 0) return null;

  const replayExitCode = await runProcess({
    arguments: [loaderPath, "hook"],
    environment: {
      ...recoveryEnvironment,
      TRELIO_HOST_RUNTIME_DISABLE_AUTO_UPDATE: "1",
      TRELIO_HOST_RUNTIME_UPDATE_REEXEC: "1",
    },
    input: `${JSON.stringify(hookInput)}\n`,
  }).catch(() => null);
  // A failed replay is still an unsuccessful recovery of the original gate.
  // Let runHook deliver that structured denial instead of returning a raw
  // nonzero status which an outer PowerShell could turn into a non-blocking 1.
  return replayExitCode === 0 ? 0 : null;
};

const runHook = async () => {
  const hookInput = await readStdinJson();
  if (
    !hookInput
    || typeof hookInput !== "object"
    || !SUPPORTED_HOOK_EVENTS.has(hookInput.hook_event_name)
  ) {
    throw new Error("Hook event is missing or unsupported.");
  }
  // The approved shell's outer timer includes Windows launcher startup. Keep
  // room for startup, lock cleanup and the explicit JSON decision. Local ACL,
  // DPAPI and network work share this signal; no result is cached across hooks.
  const timeout = RUNTIME_HOOK_EXECUTION_TIMEOUT_MILLISECONDS[hookInput.hook_event_name];
  return withRuntimeHookPrivateSession(timeout, async () => {
    try {
      if (
        hookInput.hook_event_name === "SessionStart"
        || hookInput.hook_event_name === "PreToolUse"
      ) {
        const migration = await migrateCodexLegacyTrelioMcpForRuntime();
        if (migration.status === "removed") {
          const error = new Error(
            "Runtime удалил legacy MCP server trelio-mcp из пользовательского config.toml Codex",
          );
          error.code = LEGACY_MCP_RESTART_REQUIRED_CODE;
          throw error;
        }
        if (migration.status === "blocked") {
          const error = new Error(
            `${migration.error?.message || "Runtime не смог удалить legacy MCP server trelio-mcp"} Выполните codex mcp remove trelio-mcp и затем полностью перезапустите Codex/ChatGPT`,
          );
          error.code = LEGACY_MCP_REMOVAL_FAILED_CODE;
          throw error;
        }
      }
      await executeHookInput(hookInput);
      return 0;
    } catch (error) {
      let failure = error;
      try {
        const recoveryExitCode = await recoverHookHostRuntimeUpgrade(error, hookInput);
        if (recoveryExitCode !== null) return recoveryExitCode;
      } catch (recoveryError) {
        failure = recoveryError;
      }
      if (hookInput.hook_event_name === "PreToolUse") {
        // PowerShell/pwsh -Command can normalize an inner exit code 2 to 1.
        // Codex treats 1 as a non-blocking hook failure and drops the original
        // stderr reason. A successful protocol response with an explicit deny
        // survives every shell and prevents sending the original call without
        // its proof. It contains only the diagnostic, never tool input or keys.
        process.stdout.write(`${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: formatRuntimeHookFailure(failure).trim(),
          },
        })}\n`);
        return 0;
      }
      // Lifecycle and malformed-input errors cannot be represented as a
      // PreToolUse decision; keep their existing stderr/exit-code contract.
      throw failure;
    }
  });
};

/**
 * Ошибка из этой ветки доказывает, что lifecycle hook уже был запущен
 * клиентом. Поэтому нельзя маркировать любой его внутренний отказ как
 * `TRELIO_RUNTIME_HOOK_REQUIRED`: этот код зарезервирован для ответа Trelio,
 * когда proof не пришёл или не прошёл проверку; сам код не доказывает
 * выключенный hook либо отсутствие клиентского одобрения.
 *
 * Структурированные recovery-коды bridge/backend сохраняются, чтобы skill мог
 * выбрать точное действие. Неизвестные и противоречивые коды сворачиваются в
 * отдельный fail-closed `TRELIO_RUNTIME_HOOK_FAILED`.
 */
export const formatRuntimeHookFailure = (error) => {
  const rawCode = typeof error?.code === "string" ? error.code.trim() : "";
  const code = rawCode
    && rawCode !== HOOK_REQUIRED_CODE
    && SAFE_ERROR_CODE_PATTERN.test(rawCode)
    ? rawCode
    : HOOK_FAILED_CODE;
  if (code === "TRELIO_BRIDGE_PAIRING_REQUIRED") {
    // Pairing is a recoverable transport prerequisite, not a generic hook
    // failure. Project only the approved public request identity: serializing
    // error.pairing would expose its local PKCE verifier. Never derive an
    // executable action from an arbitrary exception message or tool input.
    const pairing = error?.pairing;
    const hasApprovalTarget = UUID_PATTERN.test(pairing?.pairingId || "")
      && typeof pairing?.deviceName === "string"
      && pairing.deviceName.trim().length > 0
      && pairing.deviceName.length <= 120;
    const nextCall = hasApprovalTarget
      ? {
          tool: "approve_agent_workspace_bridge_pairing",
          arguments: { pairingId: pairing.pairingId, deviceName: pairing.deviceName },
        }
      : {
          tool: "continue_trelio_workspace_action",
          arguments: { schemaVersion: 1, operation: "login", parameters: {} },
        };
    return `${code}: hook запущен; исходный MCP-вызов остановлен до отправки. `
      + `Для продолжения текущего запроса сразу выполни nextCall=${JSON.stringify(nextCall)}. `
      + "Это штатное восстановление bridge: не заканчивай ответ предложением "
      + "пользователю написать специальный промпт или начать новый чат. "
      + "Сохрани обычное одобрение MCP-клиента; не подтверждай его за пользователя. "
      + "Если login вернёт pairing request, передай его exact pairingId/deviceName "
      + "в approve_agent_workspace_bridge_pairing. После успешного approval повтори "
      + "ровно один раз исходный остановленный MCP-вызов с прежними аргументами "
      + "и clientRequestId, без ручного runtimeSessionProof: hook сам завершит "
      + "обмен и регистрацию. При отказе пользователя, явном запрете подключения "
      + "или повторном сбое остановись с точной причиной. Не сбрасывай OAuth, "
      + "Hooks или session-файлы; не выводи pairing-данные в ответ пользователю.\n";
  }
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = /[.!?]$/u.test(rawMessage.trim())
    ? rawMessage.trim()
    : `${rawMessage.trim()}.`;
  const recovery = HOST_RUNTIME_RECOVERY_CODES.has(code)
    ? (
        "Stable loader не смог автоматически применить подписанный host runtime. "
        + "Повторите этот же запрос в текущей задаче; не обновляйте плагин и не "
        + "перезапускайте Codex. Если gate повторяется, сохраните exact code как "
        + "runtime rollout blocker."
      )
    : code === PLUGIN_UPGRADE_REQUIRED_CODE
      ? (
        "Проверьте установленную версию плагина. Если требуемая версия уже установлена, "
        + "повторите запрос в новой задаче; иначе сначала обновите плагин. Полный "
        + "перезапуск нужен только если новая задача всё ещё видит старую версию."
      )
      : code === LEGACY_MCP_RESTART_REQUIRED_CODE
        ? (
            "Полностью перезапустите Codex/ChatGPT: текущий процесс мог уже загрузить "
            + "mcp__trelio_mcp__* в tool catalog. После restart повторите защищённое "
            + "чтение через штатный mcp__trelio__* в этом же чате."
          )
        : code === LEGACY_MCP_REMOVAL_FAILED_CODE
          ? (
              "Автоматическая миграция не завершилась. Выполните codex mcp remove "
              + "trelio-mcp, полностью перезапустите Codex/ChatGPT и повторите "
              + "защищённое чтение через штатный mcp__trelio__*."
            )
          : "Устраните указанную причину и повторите запрос в текущей задаче.";

  return `${code}: активный hook остановил защищённую работу Trelio. ${message} ${recovery}\n`;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHook()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      // Эта ветка выполняется только после фактического запуска hook клиентом.
      // Поэтому общий совет включить hooks, переустановить plugin или повторить
      // pairing здесь вводил бы пользователя в заблуждение. Конкретная причина
      // выше уже содержит точный recovery, если он действительно требуется.
      process.stderr.write(formatRuntimeHookFailure(error));
      process.exitCode = 2;
    });
}
