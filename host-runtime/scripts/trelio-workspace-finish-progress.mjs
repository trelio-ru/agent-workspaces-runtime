import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

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
export const createWorkspaceFinishOperations = ({ waitMs = 10_000, retentionMs = 30 * 60_000, errorFactory = operationError, toolName = "continue_trelio_workspace_action" } = {}) => {
  const entries = new Map();
  const prune = () => {
    for (const [key, entry] of entries) {
      if (entry.endedAt && Date.now() - entry.endedAt > retentionMs) entries.delete(key);
    }
  };
  const snapshot = (entry) => ({
    schemaVersion: 1,
    operation: "finish",
    state: entry.state,
    operationId: entry.id,
    elapsedMs: Date.now() - entry.startedAt,
    progress: entry.progress,
    nextCall: { tool: toolName, arguments: entry.pollAction },
    instruction: "Сохранение продолжается. Через 10 секунд вызовите nextCall для этой операции; не запускайте новый finish и не меняйте файлы до завершения.",
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
    active(key) { const entry = entries.get(key); return entry?.state === "running" ? snapshot(entry) : null; },
    async start({ key, scope, fingerprint, pollAction, execute, signal }) {
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
      entry.done = Promise.resolve().then(() => execute((progress) => {
        const safe = normalizeFinishProgress(progress);
        if (safe) entry.progress = { ...safe, updatedAt: new Date().toISOString() };
      })).then((result) => {
        entry.state = "completed"; entry.result = result; entry.endedAt = Date.now();
      }, (error) => {
        entry.state = "failed"; entry.error = error; entry.endedAt = Date.now();
      });
      return wait(entry, signal);
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

/** Keep the latest bounded terminal output while reading progress immediately.
 * execFile's maxBuffer kills a long-lived child when logs fill the buffer;
 * progress must never turn a healthy save into an interrupted mutation.
 * The optional stdin is a bounded typed assistant envelope, never a native
 * credential or checkpoint secret transport. Ordinary human finish is unchanged.
 */
export const runWorkspaceFinishProcess = (executable, args, { cwd, signal, onProgress, input }) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { cwd, signal, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  const maximumCharacters = 1024 * 1024;
  let stdout = "", stderr = "", failure = null;
  const parse = createFinishProgressParser(onProgress, (text) => { stderr = (stderr + text).slice(-maximumCharacters); });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-maximumCharacters); });
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
