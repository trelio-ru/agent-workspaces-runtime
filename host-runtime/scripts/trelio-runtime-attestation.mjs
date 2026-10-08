/**
 * Читает runtime, который наблюдает сам Codex/Claude Code hook. Эти данные не
 * принимаются из tool arguments и не формируются моделью. Transcript читается
 * только потому, что Codex пока не передаёт reasoning effort в документированном
 * общем hook payload. Codex context ищется назад блоками: большой результат
 * инструмента не должен вытеснять единственную запись effort текущего хода.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const AGENT_RUNTIME_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

const THREAD_ID_PATTERN = /^[0-9a-f-]{16,64}$/iu;
const MAX_TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const CODEX_SCAN_BLOCK_BYTES = 256 * 1024;
const CODEX_SCAN_TIMEOUT_MS = 2_000;
const OVERSIZED_RECORD_PREFIX_BYTES = 1_024;
const NON_CONTEXT_RECORD_TYPES = new Set(["session_meta", "response_item", "event_msg", "compacted"]);

// Только внешний заголовок известного Codex JSONL, не текст/JSON внутри tool
// output. Для oversized record нельзя разобрать весь payload без снятия bounds.
// Неизвестный заголовок закрывает поиск: пропуск потенциального turn_context
// мог бы ошибочно разрешить старый, более высокий effort предыдущего хода.
const recordTypeFromPrefix = (bytes) => bytes.toString("utf8").match(
  /^\s*\{\s*(?:"timestamp"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*)?"type"\s*:\s*"([^"\\]*)"\s*[,}]/u,
)?.[1] ?? null;

/**
 * Находим ближайший turn_context, не загружая историю чата в память целиком.
 * Размер журнала не ограничивает поиск фиксированным tail: ограничены размер
 * блока, собираемая JSONL-запись и общее время. Один giant tool output пропускаем
 * по внешнему заголовку; giant/повреждённый context не разрешает fallback к более
 * старому effort. Concurrent append/truncate также требует нового наблюдения.
 * now/timeoutMs – dependency injection для deterministic deadline regressions;
 * production не получает их из hook payload, environment или MCP arguments.
 */
export const readCodexTurnContext = async (filePath, {
  now = () => performance.now(), timeoutMs = CODEX_SCAN_TIMEOUT_MS,
} = {}) => {
  const deadline = now() + timeoutMs;
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const snapshot = await handle.stat();
    if (!snapshot.isFile()) return null;
    let position = snapshot.size;
    let pending = Buffer.alloc(0);
    let oversized = false;
    const block = Buffer.alloc(CODEX_SCAN_BLOCK_BYTES);
    const prepend = (part) => {
      if (oversized || part.length + pending.length > MAX_TRANSCRIPT_TAIL_BYTES) {
        oversized = true;
        pending = Buffer.concat([
          part.subarray(0, OVERSIZED_RECORD_PREFIX_BYTES),
          pending.subarray(0, OVERSIZED_RECORD_PREFIX_BYTES),
        ]).subarray(0, OVERSIZED_RECORD_PREFIX_BYTES);
      } else {
        // Copy before reusing block. Joining bytes before UTF-8 decoding keeps
        // a multibyte character split at a block boundary intact.
        pending = Buffer.concat([part, pending]);
      }
    };
    const inspectRecord = () => {
      if (oversized) {
        return NON_CONTEXT_RECORD_TYPES.has(recordTypeFromPrefix(pending))
          ? { done: false } : { done: true, context: null };
      }
      if (!pending.length || !pending.toString("utf8").trim()) return { done: false };
      try {
        const row = JSON.parse(pending.toString("utf8"));
        return row?.type === "turn_context"
          ? { done: true, context: row.payload ?? null }
          : { done: false };
      } catch {
        // In particular, never pass a partially written newer context and
        // inherit an older turn's valid effort. Another hook may retry later.
        return { done: true, context: null };
      }
    };
    const stableContext = async (context) => {
      const current = await handle.stat();
      return now() < deadline && current.size === snapshot.size
        && current.mtimeMs === snapshot.mtimeMs ? context : null;
    };
    while (position > 0) {
      if (now() >= deadline) return null;
      const length = Math.min(block.length, position);
      position -= length;
      const { bytesRead } = await handle.read(block, 0, length, position);
      if (bytesRead !== length || now() >= deadline) return null;
      let end = bytesRead;
      for (let index = bytesRead - 1; index >= 0; index -= 1) {
        if (block[index] !== 10) continue;
        if (now() >= deadline) return null;
        prepend(block.subarray(index + 1, end));
        const result = inspectRecord();
        if (result.done) return await stableContext(result.context);
        pending = Buffer.alloc(0);
        oversized = false;
        end = index;
      }
      prepend(block.subarray(0, end));
    }
    const result = inspectRecord();
    return result.done ? await stableContext(result.context) : null;
  } catch {
    // Paths and transcript content are private; unreadable evidence is absent
    // evidence, never authority inferred from UI settings or tool arguments.
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/**
 * The host's event identifies this invocation. An app-server process can keep
 * an inherited CODEX_THREAD_ID from a different chat, whereas shell tools get
 * a fresh per-call environment. Never let that inherited value select another
 * chat's private session or model/effort transcript. Environment IDs remain a
 * compatibility fallback only when the event omits its own session identity.
 */
export const resolveRuntimeClientSessionId = (hookInput, environment = process.env) => {
  const value = hookInput.session_id
    ?? (environment.CODEX_THREAD_ID || environment.TRELIO_CLAUDE_SESSION_ID || null);
  return typeof value === "string" && value.trim() && value.length <= 512
    ? value.trim()
    : null;
};

const readFileTail = async (filePath) => {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - MAX_TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
};

const parseJsonLinesFromTail = async (filePath) => {
  try {
    const lines = (await readFileTail(filePath)).split(/\r?\n/u).filter(Boolean);
    const rows = [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        rows.push(JSON.parse(lines[index]));
      } catch {
        // Клиент может дописывать последнюю JSONL-строку параллельно hook.
      }
    }
    return rows;
  } catch {
    return [];
  }
};

const findCodexRolloutPath = async (threadId, environment) => {
  if (!THREAD_ID_PATTERN.test(String(threadId || ""))) return null;
  const codexRoot = environment.CODEX_HOME
    ? path.resolve(environment.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  try {
    const entries = await fs.readdir(path.join(codexRoot, "sessions"), {
      recursive: true,
      withFileTypes: true,
    });
    const match = entries.find((entry) => (
      entry.isFile()
      && entry.name.endsWith(".jsonl")
      && entry.name.includes(threadId)
    ));
    return match ? path.join(match.parentPath, match.name) : null;
  } catch {
    return null;
  }
};

const readCodexRuntime = async ({ hookInput, environment }) => {
  const transcriptPath = typeof hookInput.transcript_path === "string"
    ? hookInput.transcript_path
    : await findCodexRolloutPath(
        resolveRuntimeClientSessionId(hookInput, environment),
        environment,
      );
  const turnContext = transcriptPath ? await readCodexTurnContext(transcriptPath) : null;
  const modelId = typeof hookInput.model === "string" && hookInput.model.trim()
    ? hookInput.model.trim()
    : typeof turnContext?.model === "string"
      ? turnContext.model.trim()
      : null;
  const effortLevel = AGENT_RUNTIME_EFFORT_LEVELS.includes(turnContext?.effort)
    ? turnContext.effort
    : null;
  return {
    schemaVersion: 1,
    clientFamily: "codex",
    modelId,
    effortLevel,
    evidenceLevel: modelId ? "local_observed" : "unavailable",
    source: "codex_hook",
    observedAt: new Date().toISOString(),
  };
};

const readClaudeRuntime = async ({ hookInput, environment }) => {
  const rows = typeof hookInput.transcript_path === "string"
    ? await parseJsonLinesFromTail(hookInput.transcript_path)
    : [];
  const transcriptModel = rows
    .flatMap((row) => [row?.message?.model, row?.model, row?.payload?.model])
    .find((value) => typeof value === "string" && value.trim());
  const modelId = transcriptModel
    || (typeof hookInput.model === "string" ? hookInput.model.trim() : "")
    || (typeof environment.TRELIO_CLAUDE_MODEL === "string"
      ? environment.TRELIO_CLAUDE_MODEL.trim()
      : "")
    || null;
  const hookEffort = hookInput?.effort?.level;
  const effortLevel = AGENT_RUNTIME_EFFORT_LEVELS.includes(hookEffort)
    ? hookEffort
    : AGENT_RUNTIME_EFFORT_LEVELS.includes(environment.CLAUDE_EFFORT)
      ? environment.CLAUDE_EFFORT
      : null;
  return {
    schemaVersion: 1,
    clientFamily: "claude-code",
    modelId,
    effortLevel,
    evidenceLevel: modelId ? "local_observed" : "unavailable",
    source: "claude_hook",
    observedAt: new Date().toISOString(),
  };
};

export const detectAgentRuntimeAttestation = async ({
  hookInput = {},
  environment = process.env,
} = {}) => {
  const claudeCode = Boolean(
    environment.CLAUDE_CODE_ENTRYPOINT
    || environment.CLAUDE_EFFORT
    || hookInput?.effort,
  );
  if (claudeCode) return readClaudeRuntime({ hookInput, environment });
  if (
    environment.CODEX_THREAD_ID
    || hookInput.session_id
    || typeof hookInput.model === "string"
  ) {
    return readCodexRuntime({ hookInput, environment });
  }
  return {
    schemaVersion: 1,
    clientFamily: "other",
    modelId: null,
    effortLevel: null,
    evidenceLevel: "unavailable",
    source: "unknown",
    observedAt: new Date().toISOString(),
  };
};
