import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

export const TRELIO_CALL_BUDGET_MS = 60_000;
const calls = new AsyncLocalStorage();

/** A deadline is a local observation, never evidence that a remote write failed.
 * Keep the frame content-free and explicitly refuse automatic mutation replay.
 */
export class TrelioCallTimeoutError extends Error {
  constructor() {
    super("Trelio не завершил вызов за 60 секунд. Результат записи может быть неизвестен; перед повтором проверьте состояние на сервере.");
    this.code = "TRELIO_CALL_TIMEOUT";
  }
  toJSON() {
    return { code: this.code, message: this.message,
      details: { timeoutMs: TRELIO_CALL_BUDGET_MS, automaticRetry: false } };
  }
}

/** Accept only the bridge's bounded final diagnostic frame. Never reflect
 * child prose or treat a code-shaped foreign exception as retry authority.
 */
export const parseTrelioCallTimeout = (stderr) => {
  if (typeof stderr !== "string" || Buffer.byteLength(stderr, "utf8") > 64 * 1024) return null;
  const line = stderr.trimEnd().split("\n").at(-1);
  if (!line.startsWith("Ошибка: {") || Buffer.byteLength(line, "utf8") > 8 * 1024) return null;
  try {
    const value = JSON.parse(line.slice("Ошибка: ".length));
    return value?.code === "TRELIO_CALL_TIMEOUT" && value.details?.timeoutMs === TRELIO_CALL_BUDGET_MS
      && value.details?.automaticRetry === false ? new TrelioCallTimeoutError() : null;
  } catch { return null; }
};

export const trelioCallSignal = (signal) => {
  const scope = calls.getStore();
  // Synchronous crypto/filesystem work can delay the timer's event-loop turn.
  // Recheck the monotonic clock before dispatch, not just the abort flag.
  if (scope?.active && performance.now() >= scope.deadline) scope.expire();
  const inherited = scope?.signal;
  return inherited && signal && inherited !== signal ? AbortSignal.any([inherited, signal]) : inherited ?? signal;
};

/** One non-sliding budget covers preparation, HTTP/body reads and retry waits.
 * Racing also releases the MCP caller when a platform dependency ignores abort.
 * Its late continuation retains the ABORTED scope, so it cannot dispatch HTTP
 * or a child after the caller has already received the timeout.
 */
export const withTrelioCallBudget = async (operation, { signal, timeoutMs = TRELIO_CALL_BUDGET_MS } = {}) => {
  const parent = trelioCallSignal(signal);
  parent?.throwIfAborted();
  const controller = new AbortController();
  const scope = { signal: controller.signal, deadline: performance.now() + timeoutMs, active: true,
    expire: () => controller.abort(new TrelioCallTimeoutError()) };
  const forward = () => controller.abort(parent.reason);
  parent?.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(scope.expire, timeoutMs);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await calls.run(scope, () => Promise.race([
      Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(controller.signal); }), aborted,
    ]));
    if (performance.now() >= scope.deadline) scope.expire();
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    scope.active = false;
    clearTimeout(timer);
    parent?.removeEventListener("abort", forward);
    controller.signal.removeEventListener("abort", onAbort);
  }
};

/** Only an already registered background finish may outlive its short poll.
 * This detaches the WAIT budget, not ACL, Run locks or the child's HTTP limits.
 */
export const outsideTrelioCallBudget = (operation) => calls.run(undefined, operation);

export const waitWithinTrelioCall = async (milliseconds) => {
  const signal = trelioCallSignal();
  signal?.throwIfAborted();
  await delay(milliseconds, undefined, { signal });
  signal?.throwIfAborted();
};
