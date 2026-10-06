/**
 * Единый recovery-контракт bridge, hook и MCP. Проверка подписи и выбор пакета
 * остаются в stable shell: этот модуль проверяет только доступность exact
 * загрузчика и переводит его отказ в безопасную диагностику. Он не ищет другую
 * установленную версию, не восстанавливает cache и не повторяет рабочую операцию.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export const HOST_RUNTIME_UPGRADE_REQUIRED_CODES = new Set([
  "AGENT_WORKSPACE_HOST_RUNTIME_UPGRADE_REQUIRED",
  "AGENT_SKILL_RUNTIME_HOST_UPGRADE_REQUIRED",
]);

const FAILURES = {
  loaded_plugin_unavailable: ["TRELIO_PLUGIN_RESTART_REQUIRED", "restart_client",
    "Файлы загруженной оболочки Trelio больше недоступны. Полностью перезапустите Codex/ChatGPT или Claude Code, чтобы загрузить установленный плагин."],
  shell_identity_unavailable: ["TRELIO_HOST_RUNTIME_RECOVERY_FAILED", "check_plugin_launch",
    "Не задан точный каталог оболочки Trelio. Проверьте штатный запуск установленного плагина."],
  loader_access_denied: ["TRELIO_HOST_RUNTIME_RECOVERY_FAILED", "check_local_permissions",
    "Нет доступа к загрузчику Trelio. Проверьте права доступа; повторный вход и обновление плагина не устраняют этот отказ."],
  loader_invalid: ["TRELIO_HOST_RUNTIME_RECOVERY_FAILED", "repair_plugin_installation",
    "Загрузчик Trelio не является обычным файлом. Восстановите целостность установки через штатный менеджер плагинов."],
  loader_inspection_failed: ["TRELIO_HOST_RUNTIME_RECOVERY_FAILED", "check_local_files",
    "Не удалось проверить файлы загрузчика Trelio. Устраните локальную ошибку файловой системы."],
  update_transport_failed: ["TRELIO_HOST_RUNTIME_RECOVERY_FAILED", "retry_runtime_update",
    "Не удалось загрузить подписанное обновление Trelio. Повторите запрос после восстановления связи; OAuth и pairing менять не требуется."],
  update_timeout: ["TRELIO_HOST_RUNTIME_RECOVERY_FAILED", "retry_runtime_update",
    "Истёк срок обновления рантайма Trelio. Исходная операция не запущена; повторите запрос позднее."],
  update_rejected: ["TRELIO_HOST_RUNTIME_RECOVERY_FAILED", "check_runtime_publication",
    "Загрузчик Trelio отклонил обновление. Проверьте публикацию рантайма; автоматический повтор рабочей операции остановлен."],
  update_failed: ["TRELIO_HOST_RUNTIME_RECOVERY_FAILED", "inspect_runtime_update",
    "Не удалось безопасно обновить рантайм Trelio. Требуется диагностика загрузчика; причина не подтверждает необходимость входа или переустановки."],
  handoff_failed: ["TRELIO_HOST_RUNTIME_RECOVERY_FAILED", "inspect_runtime_handoff",
    "Не удалось передать выполнение обновлённому рантайму Trelio. Проверьте результат исходной операции перед повтором."],
};

const projectLoaderDiagnostic = (value) => {
  if (!value || !["metadata_headers", "metadata_body", "package_headers", "package_body", "update_lock"].includes(value.stage)
    || !["network", "timeout", "http", "response_too_large"].includes(value.reason)) return null;
  const diagnostic = { stage: value.stage, reason: value.reason };
  if (value.reason === "http" && Number.isInteger(value.httpStatus)
    && value.httpStatus >= 400 && value.httpStatus <= 599) diagnostic.httpStatus = value.httpStatus;
  return diagnostic;
};

export class HostRuntimeRecoveryError extends Error {
  constructor(reason, details = {}) {
    const [code, requiredAction, message] = FAILURES[reason];
    super(message);
    this.name = "HostRuntimeRecoveryError";
    this.code = code;
    this.details = { reason, requiredAction };
    if (["EACCES", "EPERM"].includes(details.causeCode)) this.details.causeCode = details.causeCode;
    if (HOST_RUNTIME_UPGRADE_REQUIRED_CODES.has(details.originalCode)) this.details.originalCode = details.originalCode;
    if (details.operationOutcome === "unknown") {
      this.details.operationOutcome = "unknown";
      if (reason !== "handoff_failed") this.message += " Перед повтором проверьте результат исходной операции.";
    }
    const diagnostic = projectLoaderDiagnostic(details.loaderDiagnostic);
    if (diagnostic) this.details.loaderDiagnostic = diagnostic;
    // Bridge CLI использует payload, local MCP — details. Оба получают одну
    // закрытую проекцию без OS message, stderr, URL или пути пользователя.
    this.payload = this.details;
  }

  toJSON() { return { code: this.code, message: this.message, details: this.details }; }
}

// На границе дочернего bridge восстанавливаем только известную причину и
// закрытые поля. Даже message из подходящего JSON не является доверенным.
export const parseHostRuntimeRecoveryError = (stderr) => {
  if (typeof stderr !== "string" || Buffer.byteLength(stderr) > 16 * 1024) return null;
  // При потере loader после spawn Node успевает вывести свой stack trace
  // перед завершающей структурированной ошибкой bridge. Читаем только её,
  // отбрасывая предыдущий вывод целиком, а не передавая его в MCP.
  const text = stderr.trim().split(/\r?\n/u).at(-1);
  if (!text.startsWith("Ошибка: {")) return null;
  try {
    const value = JSON.parse(text.slice("Ошибка: ".length));
    const reason = value?.details?.reason;
    if (!Object.hasOwn(FAILURES, reason) || value.code !== FAILURES[reason][0]) return null;
    return new HostRuntimeRecoveryError(reason, value.details);
  } catch { return null; }
};

export const resolveHostRuntimeLoader = async ({ environment = process.env, statFile = fs.lstat, accessFile = fs.access } = {}) => {
  const root = String(environment.TRELIO_PLUGIN_ROOT || "").trim();
  if (!path.isAbsolute(root)) throw new HostRuntimeRecoveryError("shell_identity_unavailable");
  const loaderPath = path.join(root, "scripts", "trelio-host-runtime-loader.mjs");
  let metadata;
  try {
    metadata = await statFile(loaderPath);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      throw new HostRuntimeRecoveryError("loader_invalid");
    }
    await accessFile(loaderPath, constants.R_OK);
  } catch (error) {
    if (error instanceof HostRuntimeRecoveryError) throw error;
    // Только эти два кода доказывают потерю пути. EACCES и произвольный I/O
    // нельзя скрыть как ENOENT и превращать в бесконечный restart/reinstall.
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) {
      throw new HostRuntimeRecoveryError("loaded_plugin_unavailable");
    }
    if (["EACCES", "EPERM"].includes(error?.code)) {
      throw new HostRuntimeRecoveryError("loader_access_denied", { causeCode: error.code });
    }
    throw new HostRuntimeRecoveryError("loader_inspection_failed");
  }
  return loaderPath;
};

const readLoaderDiagnostic = (stderr) => {
  // Разбирается только структурированный ABI stable loader, не текст ошибок
  // Node/ОС. Даже подходящий JSON проецируется полями allowlist, а не целиком.
  const line = stderr.trim().split(/\r?\n/u).at(-1);
  const prefix = "Trelio host runtime loader failed: ";
  if (!line?.startsWith(prefix)) return null;
  try {
    const value = JSON.parse(line.slice(prefix.length));
    return value?.code === "TRELIO_HOST_RUNTIME_UPDATE_FAILED" ? projectLoaderDiagnostic(value) : null;
  } catch { return null; }
};

export const runHostRuntimeUpdater = async (loaderPath, {
  environment = process.env, spawnProcess = spawn, signal, timeoutMs = 180_000,
} = {}) => await new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  let stderr = "";
  let overflow = false;
  const child = spawnProcess(process.execPath, [loaderPath, "__update"], {
    env: { ...environment, TRELIO_HOST_RUNTIME_UPDATE_WAIT_FOR_LOCK: "1" },
    shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
    ...(signal ? { signal } : {}),
  });
  // Дочерний updater получает только version/path metadata. Его stderr не
  // наследуется: неподписанный OS-текст может содержать локальный путь.
  child.stderr?.on("data", (chunk) => {
    if (overflow) return;
    stderr += chunk.toString("utf8");
    if (Buffer.byteLength(stderr) > 16 * 1024) { overflow = true; stderr = ""; }
  });
  const timer = setTimeout(() => {
    child.kill?.();
    reject(new HostRuntimeRecoveryError("update_timeout"));
  }, timeoutMs);
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  // close, а не exit: последний chunk stderr может прийти после завершения
  // процесса. Общий timeout продолжает ограничивать и закрытие pipe.
  child.once("close", (code) => {
    clearTimeout(timer);
    if (code === 0) { resolve(); return; }
    const diagnostic = !overflow && readLoaderDiagnostic(stderr);
    const reason = diagnostic?.reason === "timeout" ? "update_timeout"
      : diagnostic?.reason === "network" || diagnostic?.httpStatus >= 500 ? "update_transport_failed"
        : diagnostic ? "update_rejected" : "update_failed";
    reject(new HostRuntimeRecoveryError(reason, diagnostic ? { loaderDiagnostic: diagnostic } : {}));
  });
});

export const classifyHostRuntimeRecoveryFailure = async (error, options = {}) => {
  if (options.signal?.aborted) return options.signal.reason;
  // Между preflight и spawn клиент мог удалить старый plugin root. Свежая
  // проверка отличает этот race от сетевого отказа или отказа проверки пакета.
  try { await resolveHostRuntimeLoader(options); } catch (inspectionError) { return inspectionError; }
  return error instanceof HostRuntimeRecoveryError ? error
    : new HostRuntimeRecoveryError(options.failureReason ?? "update_failed");
};

export const prepareHostRuntimeUpgrade = async (options = {}) => {
  const loaderPath = await resolveHostRuntimeLoader(options);
  try {
    await (options.runUpdate ?? runHostRuntimeUpdater)(loaderPath, options);
    // Успешный __update ещё не гарантирует существование оболочки для replay.
    return await resolveHostRuntimeLoader(options);
  } catch (error) {
    throw await classifyHostRuntimeRecoveryFailure(error, options);
  }
};
