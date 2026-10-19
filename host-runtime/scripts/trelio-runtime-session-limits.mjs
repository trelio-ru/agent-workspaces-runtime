/**
 * Shared timing contract for the approved hook and value-free diagnostics.
 *
 * Registration's abort clock starts after shell/Node startup, initial ACL
 * checks, any lock wait and local credential load/migration. The host must
 * allow those costs as well: a seven-second Windows cold start plus the
 * eleven-second network deadline already exceeds the former fifteen-second
 * definition.
 */
export const PRE_TOOL_USE_TIMEOUT_SECONDS = 30;
// These limits include bootstrap/imports of the signed runtime as well as
// ACL/credentials/network. The immutable shell/launcher still needs its own
// reserve before the runtime can observe any clock; do not restart this budget
// at runHook or when a signed-runtime upgrade launches a successor process.
export const RUNTIME_HOOK_EXECUTION_TIMEOUT_MILLISECONDS = Object.freeze({
  PreToolUse: 22_000, SessionStart: 8_000, SessionEnd: 2_000,
});
export const RUNTIME_HOOK_START_TIME_ENV = "TRELIO_RUNTIME_HOOK_STARTED_AT";

/**
 * Process uptime includes Node bootstrap, static imports and stdin delivery.
 * A parent signed entrypoint/recovery may supply an earlier start, but never a
 * later one. This is only a local execution bound, not model/session authority.
 * Ordinary entrypoint launches discard inherited stamps from unrelated work;
 * only an exact hook recovery keeps the original invocation's earlier clock.
 */
export const resolveRuntimeHookStartedAt = ({
  environment = process.env, nowMilliseconds = Date.now(),
  uptimeMilliseconds = process.uptime() * 1_000,
} = {}) => {
  const ownStartedAt = Math.floor(nowMilliseconds - Math.max(0, uptimeMilliseconds));
  const inherited = environment[RUNTIME_HOOK_START_TIME_ENV];
  const stamp = typeof inherited === "string" && /^\d{1,16}$/u.test(inherited)
    ? Number(inherited) : NaN;
  return Number.isSafeInteger(stamp) && stamp > 0
    ? Math.min(ownStartedAt, stamp) : ownStartedAt;
};

export const runtimeHookRemainingMilliseconds = (event, {
  startedAt, nowMilliseconds = Date.now(),
}) => Math.max(0, Math.floor(Math.min(
  RUNTIME_HOOK_EXECUTION_TIMEOUT_MILLISECONDS[event],
  startedAt + RUNTIME_HOOK_EXECUTION_TIMEOUT_MILLISECONDS[event] - nowMilliseconds,
)));
export const RUNTIME_REGISTRATION_TIMEOUT_MILLISECONDS = 11_000;
export const RUNTIME_STATE_LOCK_WAIT_MILLISECONDS = 5_000;

// A pending record exists before the first protected call creates a server
// session. Preserve it for the same 24-hour lifecycle as a registered runtime
// session, then let a later SessionStart observe the current client afresh.
export const RUNTIME_PENDING_STATE_MAX_AGE_MILLISECONDS = 24 * 60 * 60 * 1_000;

// A lock can remain live while the hook writes and verifies private state
// after registration. Reclaim it only beyond the complete host allowance,
// with extra room for process teardown; otherwise a second call could
// replace a still-running registration and orphan its signing key.
export const RUNTIME_STATE_LOCK_STALE_MILLISECONDS = 45_000;
