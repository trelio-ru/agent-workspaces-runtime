/**
 * Content-free errors at subprocess boundaries. The bridge's own final error
 * frame preserves the inner failure instead of replacing a skill exit with
 * the exit of the enclosing Node CLI. Protected setup may additionally retain
 * a reviewed fixed provider code; provider prose/arguments never cross here.
 */
const WINDOWS_CODES = [
  "TRELIO_WINDOWS_PRIVATE_PROCESS_START_FAILED",
  "TRELIO_WINDOWS_PRIVATE_PROCESS_START_TIMEOUT",
  "TRELIO_WINDOWS_PRIVATE_PROCESS_REQUEST_TIMEOUT",
  "TRELIO_WINDOWS_PRIVATE_PROCESS_PROTOCOL_INVALID",
  "TRELIO_WINDOWS_PRIVATE_PROCESS_EXITED",
  "TRELIO_WINDOWS_PRIVATE_PROCESS_IO_FAILED",
  "TRELIO_WINDOWS_PRIVATE_ACL_FAILED",
  "TRELIO_WINDOWS_PRIVATE_DPAPI_FAILED",
  "TRELIO_RUNTIME_HOOK_DEADLINE_EXCEEDED",
];
const SKILL_CODES = [
  "TRELIO_SKILL_RUNTIME_START_FAILED",
  "TRELIO_SKILL_RUNTIME_TERMINATED",
  "TRELIO_SKILL_RUNTIME_LEASE_EXPIRED",
  "TRELIO_SKILL_RUNTIME_OUTPUT_LIMIT",
  "TRELIO_SKILL_RUNTIME_OUTPUT_INVALID",
  ...[1, 2, 3, 4, 5, 6].map(value => `TRELIO_SKILL_RUNTIME_EXIT_${value}`),
  "TRELIO_SKILL_RUNTIME_EXIT_OTHER",
];
export const PROCESS_DIAGNOSTIC_CODES = Object.freeze([...WINDOWS_CODES, ...SKILL_CODES]);
const codes = new Set(PROCESS_DIAGNOSTIC_CODES);
// This is an exact setup wire vocabulary, not a general TELEGRAM_* prefix or
// an interpretation of exception text. A foreign provider cannot supply it.
const telegramSetupMessages = Object.freeze({
  TELEGRAM_PASSWORD_INVALID: 'Неверный пароль двухэтапной аутентификации Telegram.',
  TELEGRAM_CODE_INVALID: 'Неверный код входа Telegram.',
  TELEGRAM_CODE_EXPIRED: 'Срок действия кода Telegram истёк.',
  TELEGRAM_CODE_UNAVAILABLE: 'Telegram не смог отправить код входа.',
  TELEGRAM_LOGIN_METHOD_UNAVAILABLE: 'Telegram требует другой способ входа.',
  TELEGRAM_PHONE_INVALID: 'Некорректный номер телефона Telegram.',
  TELEGRAM_PHONE_BANNED: 'Telegram заблокировал номер телефона.',
  TELEGRAM_PHONE_UNREGISTERED: 'Для номера нет аккаунта Telegram.',
  TELEGRAM_RATE_LIMITED: 'Telegram ограничил число попыток.',
  TELEGRAM_QR_EXPIRED: 'Срок действия QR-кода Telegram истёк.',
  TELEGRAM_QR_INVALID: 'Telegram отклонил QR-код входа.',
  TELEGRAM_QR_ALREADY_USED: 'QR-код Telegram уже использован; проверьте состояние входа.',
  TELEGRAM_APP_INVALID: 'Telegram отклонил приложение навыка.',
  TELEGRAM_APP_RESTRICTED: 'Telegram ограничил приложение навыка.',
  TELEGRAM_APP_UPDATE_REQUIRED: 'Telegram требует обновления приложения навыка.',
  TELEGRAM_PASSWORD_CHECK_EXPIRED: 'Проверка пароля Telegram устарела.',
  TELEGRAM_PASSWORD_CHANGED: 'Пароль Telegram изменился во время входа.',
  TELEGRAM_ACCOUNT_DEACTIVATED: 'Аккаунт Telegram деактивирован или заблокирован.',
  TELEGRAM_SERVICE_UNAVAILABLE: 'На стороне Telegram произошла ошибка.',
  TELEGRAM_LOGIN_RESTART_REQUIRED: 'Telegram запросил новый процесс входа.',
  TELEGRAM_LOGIN_EXPIRED: 'Время входа в Telegram истекло.',
  TELEGRAM_LOGIN_CANCELLED: 'Вход в Telegram отменён.',
  TELEGRAM_NETWORK_UNAVAILABLE: 'Не удалось связаться с Telegram.',
  TELEGRAM_SESSION_UNAVAILABLE: 'Авторизация сессии Telegram недоступна.',
  TELEGRAM_ACCESS_DENIED: 'Telegram отказал в доступе.',
  TELEGRAM_PERMISSION_REQUIRED: 'Недостаточно прав в Telegram.',
  TELEGRAM_REQUEST_FAILED: 'Telegram не завершил операцию; причина не установлена.',
  TELEGRAM_WINDOWS_NATIVE_FAILURE: 'Процесс Telegram завершился с native-ошибкой Windows.',
});
const windowsCodes = new Set(WINDOWS_CODES);
const stages = new Set([
  "local_state", "hook_setup", "runtime_state_read", "state_lock",
  "runtime_attestation", "bridge_credentials", "runtime_registration", "runtime_state_write",
]);
const phases = ["worker_startup", "request_dispatch", "path_decode", "identity", "owner_read",
  "owner_write", "dacl_write", "dacl_verify"];
const operations = new Set([
  "local_state", ...phases.map(phase => `windows_acl.${phase}`),
  "windows_dpapi.worker_startup", "windows_dpapi.request_dispatch",
  "windows_dpapi.protect", "windows_dpapi.unprotect", "skill_run",
]);
const causeCodes = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EPIPE",
  "ECONNRESET", "EIO", "EINVAL", "ENOMEM", "EMFILE", "ENFILE", "ABORT_ERR"]);
const signals = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV", "SIGPIPE", "SIGHUP", "SIGBUS"]);
export const processDiagnosticCauseCode = error => causeCodes.has(error?.code) ? error.code : "UNKNOWN";
const publicCodeFor = code => windowsCodes.has(code) ? "TRELIO_RUNTIME_HOOK_FAILED" : code;

// Copy only closed technical fields, never spread an Error, child reply or
// provider object. Numeric exits are local evidence; telemetry uses fixed
// buckets 1..6/OTHER and retains its existing schema/cardinality bound.
const safeDetails = (code, value = {}) => ({
  failureCode: code,
  ...(stages.has(value.hookStage) ? { hookStage: value.hookStage } : {}),
  ...(operations.has(value.operation) ? { operation: value.operation } : {}),
  ...(["hook", "private_process"].includes(value.timeoutKind) ? { timeoutKind: value.timeoutKind } : {}),
  ...(Number.isSafeInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 0xffffffff
    ? { exitCode: value.exitCode } : {}),
  ...(causeCodes.has(value.causeCode) || value.causeCode === "UNKNOWN" ? { causeCode: value.causeCode } : {}),
  ...(signals.has(value.signal) ? { signal: value.signal } : {}),
  ...(code.startsWith('TRELIO_SKILL_RUNTIME_EXIT_') && typeof value.providerCode === 'string' && Object.hasOwn(telegramSetupMessages, value.providerCode) ? { providerCode: value.providerCode } : {}),
  ...(code.startsWith('TRELIO_SKILL_RUNTIME_EXIT_') && value.providerCode === 'TELEGRAM_RATE_LIMITED'
    && Number.isSafeInteger(value.retryAfterSeconds) && value.retryAfterSeconds >= 0 && value.retryAfterSeconds <= 86400 * 365
    ? { retryAfterSeconds: value.retryAfterSeconds } : {}),
});

export class ProcessDiagnosticError extends Error {
  constructor(diagnosticCode, message, details = {}) {
    if (!codes.has(diagnosticCode)) throw new TypeError("Unknown process diagnostic category.");
    super(message);
    this.code = publicCodeFor(diagnosticCode);
    this.diagnosticCode = diagnosticCode;
    this.details = safeDetails(diagnosticCode, details);
    // Hook callers historically read these fields directly. Keep the ABI,
    // including the original TRELIO_RUNTIME_HOOK_FAILED public code.
    for (const key of ["hookStage", "operation", "timeoutKind"]) {
      if (this.details[key] !== undefined) this[key] = this.details[key];
    }
  }
  toJSON() { return { code: this.code, message: this.message, details: this.details }; }
}

export const skillRuntimeExitError = exitCode => new ProcessDiagnosticError(
  Number.isInteger(exitCode) && exitCode >= 1 && exitCode <= 6
    ? `TRELIO_SKILL_RUNTIME_EXIT_${exitCode}` : "TRELIO_SKILL_RUNTIME_EXIT_OTHER",
  `Runtime навыка завершился с кодом ${exitCode}.`,
  { operation: "skill_run", exitCode },
);

/** Inspect only a complete failed protected setup pipe. Keep the real exit
 * bucket for telemetry and add bounded evidence for the human/model. No value,
 * path, message, nextAction or arbitrary provider details are ever reflected.
 * This function grants no retry, reconnect, scope or authentication authority. */
export const skillSetupExitError = (exitCode, { skillId, stderr } = {}) => {
  const fallback = skillRuntimeExitError(exitCode);
  if (skillId !== 'telegram-mtproto' || !Number.isSafeInteger(exitCode) || exitCode < 1) return fallback;
  try {
    const bytes = typeof stderr === 'string' ? Buffer.byteLength(stderr) : Buffer.isBuffer(stderr) ? stderr.length : Infinity;
    if (bytes > 65536) return fallback;
    const raw = JSON.parse(typeof stderr === 'string' ? stderr : new TextDecoder('utf-8', { fatal: true }).decode(stderr));
    if (!raw || Array.isArray(raw) || raw.ok !== false || typeof raw.code !== 'string' || !Object.hasOwn(telegramSetupMessages, raw.code)) return fallback;
    return new ProcessDiagnosticError(fallback.diagnosticCode, telegramSetupMessages[raw.code], {
      operation: 'skill_run', exitCode, providerCode: raw.code,
      retryAfterSeconds: raw.details?.diagnostic?.retryAfterSeconds,
    });
  } catch { return fallback; }
};

export const parseProcessDiagnostic = stderr => {
  if (typeof stderr !== "string" || stderr.length > 64 * 1024
      || Buffer.byteLength(stderr, "utf8") > 64 * 1024) return null;
  // Providers may have written stderr before the bridge's final frame. Only
  // that final complete line is eligible; an earlier lookalike followed by a
  // legacy/plain failure cannot manufacture a structured bridge result.
  const line = stderr.trimEnd().split("\n").at(-1);
  if (!line.startsWith("Ошибка: {") || Buffer.byteLength(line, "utf8") > 8 * 1024) return null;
  try {
    const payload = JSON.parse(line.slice("Ошибка: ".length));
    const code = payload?.details?.failureCode;
    if (!codes.has(code) || payload.code !== publicCodeFor(code)) return null;
    return safeDetails(code, payload.details);
  } catch { return null; }
};
