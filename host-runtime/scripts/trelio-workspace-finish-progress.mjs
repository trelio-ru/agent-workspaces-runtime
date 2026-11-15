import { sliceUtf16CodePoints } from "./trelio-context-search-matching.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { outsideTrelioCallBudget } from "./trelio-hook-private-session.mjs";
import { canonicalJson } from "./trelio-company-encryption.mjs";
import { rememberDiagnosticDetail } from "./trelio-diagnostic-observation.mjs";

const PREFIX = "TRELIO_FINISH_PROGRESS ";
const STAGES = new Set([
  "validating", "heartbeat", "checkpoint", "preparing", "derived", "projection",
  "revision", "publishing", "cleanup", "accepted", "retry_wait",
]);

// Child stderr can contain business data. Only this closed, bounded frame is
// projected while a process is running; ordinary output stays in the existing
// terminal result/error path. Never parse arbitrary log prose as progress.
export const normalizeFinishProgress = (value) => {
  if (!value || !STAGES.has(value.stage)) return null;
  const progress = { stage: value.stage };
  for (const key of ["completedFiles", "totalFiles", "uploadedBytes", "totalBytes", "retryAfterMs"]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) progress[key] = value[key];
  }
  return progress;
};

export const writeFinishProgress = (value, output = process.stderr) => {
  const progress = normalizeFinishProgress(value);
  if (progress) output.write(`${PREFIX}${JSON.stringify(progress)}\n`);
};

export const createFinishProgressParser = (onProgress, onText = () => {}) => {
  let buffered = "", oversized = false;
  const parse = (chunk) => {
    const lines = String(chunk).split("\n");
    for (let index = 0; index < lines.length; index++) {
      const complete = index < lines.length - 1;
      const fragment = lines[index];
      if (oversized || buffered.length + fragment.length > 1024) {
        onText(buffered + fragment + (complete ? "\n" : ""));
        buffered = "";
        oversized = !complete;
        continue;
      }
      buffered += fragment;
      if (!complete) continue;
      let progress = null;
      if (buffered.startsWith(PREFIX)) {
        try { progress = normalizeFinishProgress(JSON.parse(buffered.slice(PREFIX.length))); }
        catch { /* Ordinary stderr remains in the terminal error path. */ }
      }
      if (progress) onProgress(progress);
      else onText(buffered + "\n");
      buffered = "";
    }
  };
  parse.flush = () => { onText(buffered); buffered = ""; };
  return parse;
};

const operationError = (code, message, details) => Object.assign(new Error(message), { code, details });

/**
 * A finish owns its child until completion, independently of any short MCP
 * request. Poll cancellation cancels only that wait. The child still holds the
 * CLI Run lock; losing/restarting this host does not authorize a second writer.
 * This is a host-lifetime registry, not a promise of a restartable job service.
 */
export const createWorkspaceFinishOperations = ({ waitMs = 10_000, retentionMs = 30 * 60_000, errorFactory = operationError, toolName = "continue_trelio_workspace_action",
  operation = "finish", instruction = "Сохранение продолжается. Через 10 секунд вызовите nextCall для этой операции; не запускайте новый finish и не меняйте файлы до завершения." } = {}) => {
  const entries = new Map();
  const prune = () => {
    for (const [key, entry] of entries) {
      if (entry.endedAt && Date.now() - entry.endedAt > retentionMs) entries.delete(key);
    }
  };
  const snapshot = (entry) => ({
    schemaVersion: 1,
    operation,
    state: entry.state,
    operationId: entry.id,
    elapsedMs: Date.now() - entry.startedAt,
    progress: entry.progress,
    nextCall: { tool: toolName, arguments: entry.pollAction },
    instruction,
  });
  const wait = async (entry, signal) => {
    signal?.throwIfAborted();
    let timer;
    let onAbort;
    try {
      await Promise.race([
        entry.done,
        new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
        new Promise((_, reject) => {
          onAbort = () => reject(signal.reason ?? new Error("Poll aborted"));
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (entry.state === "failed") throw entry.error;
    if (entry.state === "completed") return { ...entry.result, state: "completed", operationId: entry.id };
    return snapshot(entry);
  };
  return {
    // A read-only consumer may deliver a terminal value exactly once, after
    // fresh native validation outside this generic registry. Never discard an
    // active operation, an unknown ID or another scope's retained receipt.
    discardTerminal(key, id, scope) {
      const entry=entries.get(key);
      if (!entry || entry.id!==id || entry.scope!==scope || entry.state==='running') return false;
      entries.delete(key);return true;
    },
    async settle(key, id, scope) {
      const entry = entries.get(key);
      if (entry && entry.id === id && entry.scope === scope) await entry.done;
    },
    has(key, id) { return entries.get(key)?.id === id; },
    active(key) { const entry = entries.get(key); return entry?.state === "running" ? snapshot(entry) : null; },
    async start({ key, scope, fingerprint, pollAction, execute, signal, background = false }) {
      signal?.throwIfAborted();
      prune();
      let entry = entries.get(key);
      if (entry && entry.scope !== scope) {
        if (entry.state === "running") throw errorFactory("TRELIO_WORKSPACE_FINISH_IN_PROGRESS", "В этой папке ещё сохраняется другой Run.", snapshot(entry));
        entries.delete(key); entry = null;
      }
      if (entry?.state === "failed") entries.delete(key);
      if (entry && entry.state !== "failed") {
        if (entry.fingerprint !== fingerprint) throw errorFactory(
          "TRELIO_WORKSPACE_FINISH_IN_PROGRESS", "Для этой папки уже запущен finish с другими параметрами. Сначала проверьте его результат.", snapshot(entry),
        );
        return wait(entry, signal);
      }
      // Completed receipts can be re-established from the Run; evict them
      // before refusing new work. Never evict an active child.
      if (entries.size >= 64) {
        for (const [oldKey, oldEntry] of entries) {
          if (oldEntry.endedAt) { entries.delete(oldKey); break; }
        }
      }
      if (entries.size >= 64) throw errorFactory("TRELIO_WORKSPACE_FINISH_CAPACITY", "Слишком много незавершённых или недавних finish; проверьте их результаты.");
      const id = randomUUID();
      entry = { id, scope, fingerprint, state: "running", startedAt: Date.now(), progress: { stage: "validating" },
        pollAction: { ...pollAction, parameters: { finishOperationId: id } } };
      // Register synchronously before the first await: simultaneous finish
      // requests must share one execution even before child spawn completes.
      entries.set(key, entry);
      entry.done = outsideTrelioCallBudget(() => Promise.resolve().then(() => execute((progress) => {
        const safe = normalizeFinishProgress(progress);
        if (safe) entry.progress = { ...safe, updatedAt: new Date().toISOString() };
      })).then((result) => {
        entry.state = "completed"; entry.result = result; entry.endedAt = Date.now();
      }, (error) => {
        entry.state = "failed"; entry.error = error; entry.endedAt = Date.now();
      }));
      // Search can register its bounded replacement before returning the
      // next poll. Finish callers still wait on the same cancellable receipt.
      return background ? snapshot(entry) : wait(entry, signal);
    },
    async poll(key, id, signal, scope) {
      const entry = entries.get(key);
      if (!entry || entry.id !== id || entry.scope !== scope) throw errorFactory(
        "TRELIO_WORKSPACE_FINISH_UNKNOWN", "Локальный host не хранит эту операцию. Проверьте status и состояние exact Run на сервере перед повтором finish; принятый Run повторно не отправляйте.",
      );
      return wait(entry, signal);
    },
  };
};

/** One read-only search owns its preparation and query, rather than spending
 * the caller's minute assembling a large company. Reuse the finish registry's
 * short, cancellable waits, but NEVER its mutation semantics or automatic
 * failed-entry replacement. A poll is an exact retained operation, not replay.
 * Only a bounded answer lives here; the isolated reader owns the corpus. */
export const createCompanySearchOperations = ({ authorize, execute, validate, closeReader = async () => {},
  isValidationConflict = () => false, waitMs = 10_000, timeoutMs = 2 * 60 * 60_000, idleMs = 10 * 60_000,
  retentionMs = 600_000, errorFactory = operationError } = {}) => {
  const operations = createWorkspaceFinishOperations({ waitMs, errorFactory });
  let current = null, closed = false;
  const fail = (code, message) => { throw errorFactory(code, message); };
  const pending = entry => ({ schemaVersion: 1, state: "preparing", readOnly: true,
    operationId: entry.id, elapsedMs: Math.round(performance.now() - entry.startedAt),
    progress: { stage: entry.stage, stageElapsedMs: Math.max(0, Math.round(performance.now() - entry.stageAt)), timings: { ...entry.timings } },
    nextCall: { server: "trelio-remote-skills", tool: "continue_trelio_local_action", arguments: {
      schemaVersion: 1, route: "context", parameters: { companySlug: entry.input.companySlug,
        nativeTool: entry.input.nativeTool, operation: "search_poll", arguments: {}, searchOperationId: entry.id },
    } },
    instruction: "Подготовка и поиск продолжаются. Вызовите nextCall; это продолжение одной операции, а не новый поиск. preparing не является результатом поиска.",
  });
  const discard = (entry) => {
    clearTimeout(entry.deadlineTimer);
    clearTimeout(entry.retentionTimer);
    operations.discardTerminal("search", entry.attempt.id, entry.binding);
    if (current === entry) current = null;
  };
  const retire = (entry) => {
    // Stop delivery immediately. Keep ownership until the child and registry
    // have settled, so a new query cannot join the retiring reader or attempt.
    entry.retiring ??= (async () => {
      entry.controller.abort();
      clearTimeout(entry.retentionTimer);
      try { await closeReader(); }
      finally {
        await operations.settle("search", entry.attempt.id, entry.binding);
        discard(entry);
      }
    })();
    return entry.retiring;
  };
  const setStage = (entry, stage) => {
    const now = performance.now();
    entry.timings[entry.stage] = (entry.timings[entry.stage] ?? 0) + Math.max(0, Math.round(now - entry.stageAt));
    entry.stage = stage;
    entry.stageAt = now;
  };
  const startAttempt = (entry, admission, { signal, refresh = false } = {}) => {
    const attempt = { refresh, settled: false, validations: 0 };
    entry.attempt = attempt;
    const waiting = operations.start({
      key: "search", scope: entry.binding, fingerprint: entry.fingerprint, signal, pollAction: {}, background: refresh,
      execute: async () => {
        const operationSignal = entry.controller.signal;
        const idleTimerForRemainingBudget = () => setTimeout(() => controllerAbort(entry, "idle"),
          Math.max(0, entry.idleUntil - performance.now()));
        let idleTimer = idleTimerForRemainingBudget();
        entry.observerTimer = setTimeout(() => controllerAbort(entry, "unobserved"), idleMs);
        try {
          if (refresh) await closeReader();
          operationSignal.throwIfAborted();
          if (performance.now() >= entry.idleUntil) {
            controllerAbort(entry, "idle");
            operationSignal.throwIfAborted();
          }
          const value = await execute(entry.origin, entry.input, admission, { signal: operationSignal,
            onProgress: stage => {
              // Only verified hydration renews the idle budget. Replacing a
              // stale reader keeps both the original deadline and idle clock.
              if (stage === "hydration_progress") {
                if (entry.stage === "hydrating" && !operationSignal.aborted) {
                  entry.idleUntil = performance.now() + idleMs;
                  clearTimeout(idleTimer);
                  idleTimer = idleTimerForRemainingBudget();
                }
                return;
              }
              setStage(entry, stage);
            } });
          operationSignal.throwIfAborted();
          // Even a malformed child cannot retain a corpus or unbounded response.
          if (!value || typeof value.generation !== "string" || !/^[a-f0-9]{64}$/u.test(value.generation)
            || !value.result || Buffer.byteLength(JSON.stringify(value)) > 512 * 1024)
            fail("LOCAL_CONTEXT_SEARCH_FAILED", "Некорректный результат изолированного поиска.");
          return value;
        } finally {
          clearTimeout(idleTimer);
          clearTimeout(entry.observerTimer);
          entry.observerTimer = null;
          attempt.settled = true;
          if (current === entry && !entry.retiring) {
            entry.retentionTimer = setTimeout(() => discard(entry), retentionMs);
            entry.retentionTimer.unref?.();
          }
        }
      },
    });
    // Register the private attempt ID before a simultaneous poll can join it.
    attempt.id = operations.active("search")?.operationId;
    return waiting;
  };
  return {
    async read(origin, input, { signal, operationId } = {}) {
      signal?.throwIfAborted();
      if (closed) fail("LOCAL_CONTEXT_SEARCH_UNKNOWN", "Поисковый host закрыт. Выполните новый поиск через native Trelio.");
      // A poll obtains fresh provider and recipient admission even when its
      // only effect is to join an already running retry.
      let admission;
      try { admission = await authorize(origin, input, { signal }); }
      catch (error) {
        if (!signal?.aborted && current) await retire(current);
        throw error;
      }
      signal?.throwIfAborted();
      if (admission.nativeProvider) {
        if (current) await retire(current);
        return admission.result;
      }
      if (closed) fail("LOCAL_CONTEXT_SEARCH_UNKNOWN", "Поисковый host закрыт. Выполните новый поиск через native Trelio.");
      const fingerprint = canonicalJson({ origin, input });
      let entry = current;
      const poll = input.operation === "search_poll";
      if (operationId && (!entry || entry.id !== operationId || (poll
        ? entry.input.companySlug !== input.companySlug || entry.input.nativeTool !== input.nativeTool || entry.origin !== origin
        : entry.fingerprint !== fingerprint)))
        fail("LOCAL_CONTEXT_SEARCH_UNKNOWN", "Операция поиска неизвестна этому host. Выполните новый поиск через native Trelio.");
      if (poll && !operationId) fail("LOCAL_CONTEXT_SEARCH_UNKNOWN", "Продолжение поиска требует точный идентификатор операции.");
      if (entry && entry.binding !== admission.binding) {
        await retire(entry);
        fail("LOCAL_CONTEXT_SEARCH_ACCESS_CHANGED", "Доступ к подготовленному поиску изменился. Получите новый native маршрут.");
      }
      if (entry?.retiring) fail("LOCAL_CONTEXT_SEARCH_UNKNOWN", "Операция поиска завершена. Выполните новый поиск через native Trelio.");
      if (!operationId && entry && entry.fingerprint !== fingerprint) {
        if (!entry.attempt.settled || entry.attempt.validations > 0)
          throw errorFactory("LOCAL_CONTEXT_SEARCH_IN_PROGRESS", "Предыдущий поиск ещё готовится. Продолжите его nextCall перед новым запросом.",
            pending(entry));
        discard(entry);
        entry = null;
      }
      let waiting;
      if (!entry) {
        const startedAt = performance.now();
        entry = { id: randomUUID(), origin, input: structuredClone(input), fingerprint, binding: admission.binding,
          controller: new AbortController(), startedAt, idleUntil: startedAt + idleMs,
          stage: "starting", stageAt: startedAt, timings: {} };
        current = entry;
        entry.deadlineTimer = setTimeout(() => controllerAbort(entry, "deadline"), timeoutMs);
        entry.deadlineTimer.unref?.();
        waiting = startAttempt(entry, admission, { signal });
      } else {
        if (!entry.controller.signal.aborted) entry.observerTimer?.refresh();
        waiting = operations.poll("search", entry.attempt.id, signal, entry.binding);
      }
      const attempt = entry.attempt;
      const operationSignal = entry.controller.signal;
      try {
        const value = await waiting;
        signal?.throwIfAborted();
        if (current !== entry || entry.retiring)
          fail("LOCAL_CONTEXT_SEARCH_UNKNOWN", "Операция поиска завершена. Выполните новый поиск через native Trelio.");
        operationSignal.throwIfAborted();
        if (attempt !== entry.attempt || value.state === "running") return pending(entry);
        let valid, validationConflict;
        attempt.validations++;
        try {
          setStage(entry, "validating");
          // A computed answer is undelivered data. Recheck the exact native
          // generation and recipient on this poll, including after recovery.
          valid = await validate(origin, entry.input, value, admission,
            { signal: signal ? AbortSignal.any([signal, operationSignal]) : operationSignal });
        } catch (error) {
          // The manifest can itself fail with a typed optimistic conflict
          // before returning any generation. It shares the same retry budget.
          if (!isValidationConflict(error)) throw error;
          validationConflict = error;
        } finally { attempt.validations--; }
        signal?.throwIfAborted();
        if (current !== entry || entry.retiring)
          fail("LOCAL_CONTEXT_SEARCH_UNKNOWN", "Этот результат поиска уже выдан. Выполните новый native поиск.");
        operationSignal.throwIfAborted();
        if (attempt !== entry.attempt) return pending(entry);
        if (!valid) {
          if (attempt.refresh)
            throw validationConflict ?? rememberDiagnosticDetail(errorFactory("LOCAL_CONTEXT_GENERATION_CHANGED", "Контекст изменился во время поиска. Выполните новый native поиск."),
              { kind: "generation", stage: "search_delivery", reason: "search_generation_changed" });
          // Claim the one read-only retry synchronously. Other polls may
          // finish checking the rejected answer, but cannot publish it or
          // launch another reader. Keep the original public operation ID.
          clearTimeout(entry.retentionTimer);
          operations.discardTerminal("search", attempt.id, entry.binding);
          setStage(entry, "starting");
          await startAttempt(entry, admission, { refresh: true });
          return pending(entry);
        }
        discard(entry);
        return value.result;
      } catch (error) {
        // A cancelled waiter leaves the reader and original deadline intact.
        // A real refusal must erase the retained answer and close the reader.
        if (!signal?.aborted && current === entry && (attempt.settled || entry.retiring))
          await retire(entry);
        throw error;
      }
    },
    async close() {
      closed = true;
      if (current) await retire(current);
      else await closeReader();
    },
  };
  function controllerAbort(entry, reason) {
    const messages = {
      idle: "Поиск остановлен по тайм-ауту без подтверждённого прогресса.",
      unobserved: "Поиск остановлен после длительного отсутствия запросов состояния.",
      deadline: "Поиск достиг общего лимита времени.",
    };
    const message = messages[reason];
    entry.controller.abort(errorFactory("LOCAL_CONTEXT_SEARCH_TIMEOUT", message
      + " Сборка может использовать сохранённые зашифрованные части при следующем поиске.",
    { stage: entry.stage, timings: { ...entry.timings } }));
  }
};

/** Keep the latest bounded terminal output while reading progress immediately.
 * execFile's maxBuffer kills a long-lived child when logs fill the buffer;
 * progress must never turn a healthy save into an interrupted mutation.
 * The optional stdin is a bounded typed assistant envelope, never a native
 * credential or checkpoint secret transport. Ordinary human finish is unchanged.
 */
export const runWorkspaceFinishProcess = (executable, args, { cwd, signal, onProgress, input,
  maximumCharacters = 1024 * 1024 }) => new Promise((resolve, reject) => {
  // Only the trusted skill worker opts into the existing visual envelope's
  // 3 MiB bound. Ordinary finish keeps its 1 MiB tail; no caller can request an
  // unbounded pipe or force large frame truncation into a different JSON value.
  if (![1024 * 1024, 3 * 1024 * 1024].includes(maximumCharacters)) {
    reject(new Error("Invalid Workspace process output bound.")); return;
  }
  const child = spawn(executable, args, { cwd, signal, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", failure = null;
  const parse = createFinishProgressParser(onProgress, (text) => { stderr = sliceUtf16CodePoints(stderr + text, -maximumCharacters); });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = sliceUtf16CodePoints(stdout + chunk, -maximumCharacters); });
  child.stderr.on("data", (chunk) => {
    parse(chunk);
  });
  // Assistant actions carry their bounded typed envelope over stdin, never
  // credentials/content in argv. Human finish retains its existing ignore ABI.
  if (child.stdin) { child.stdin.on("error", error => { failure ??= error; }); child.stdin.end(input); }
  child.on("error", (error) => { failure = error; });
  child.on("close", (code, terminationSignal) => {
    parse.flush();
    if (failure || code !== 0) {
      const error = failure ?? Object.assign(new Error("Workspace finish process failed."), { code, signal: terminationSignal });
      reject(Object.assign(error, { stdout, stderr }));
    } else resolve({ stdout, stderr });
  });
});
