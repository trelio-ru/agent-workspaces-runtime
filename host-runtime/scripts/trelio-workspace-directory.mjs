import path from "node:path";
import { sameLocalPath } from "./trelio-local-path.mjs";

export const WORKSPACE_DIRECTORY_REQUIRED = "TRELIO_WORKSPACE_DIRECTORY_REQUIRED";
export const WORKSPACE_LOCAL_RECOVERY_REQUIRED = "TRELIO_WORKSPACE_LOCAL_RECOVERY_REQUIRED";
export const WORKSPACE_DRAFT_RECOVERY_REQUIRED = "TRELIO_WORKSPACE_DRAFT_RECOVERY_REQUIRED";
export const WORKSPACE_LAYOUT_MIGRATION_BLOCKED = "TRELIO_WORKSPACE_LAYOUT_MIGRATION_BLOCKED";
export const WORKSPACE_RUN_RECLAIM_REQUIRED = "TRELIO_WORKSPACE_RUN_RECLAIM_REQUIRED";
export const WORKSPACE_ACTIVE_RUN_REQUIRED = "TRELIO_WORKSPACE_ACTIVE_RUN_REQUIRED";
const MAX_CANDIDATES = 10;
const MAX_MIGRATION_BLOCKING_ENTRIES = 20;
const MAX_RECOVERY_CHANGES = 200;
const MAX_DIRECTORY_LENGTH = 4096;
const MAX_CHANGE_LENGTH = 4096;
const MAX_ENTRY_NAME_LENGTH = 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MIGRATION_ENTRY_TYPES = new Set(["file", "directory", "symbolic_link", "special"]);
const MIGRATION_REASON_CODES = new Set([
  "UNRECOGNIZED_ENTRY",
  "LEGACY_RUN_METADATA_NOT_FOUND",
  "SYSTEM_METADATA_NOT_REGULAR_FILE",
  "SYSTEM_METADATA_TOO_LARGE",
]);
const ACTIVE_RUN_REASON_CODES = new Set([
  "READ_ONLY_INSPECTION",
  "RUN_METADATA_NOT_FOUND",
  "RUN_METADATA_INVALID",
  "RUN_ID_MISSING",
]);
const DRAFT_RECOVERY_REASON_CODES = new Set([
  "DIRTY_WORKTREE",
  "DIVERGED_HISTORY",
]);
const GIT_HEAD_PATTERN = /^[0-9a-f]{40,64}$/u;
const MESSAGE = "Для этого Agent Workspace зарегистрировано несколько локальных папок. "
  + "Повторите тот же open, указав выбранный корень в parameters.directory "
  + "(CLI: --dir). workingDirectory задаёт cwd процесса, а не явный выбор корня. "
  + "Список не подтверждает чистоту Git или завершение прежнего Run: open проверит их до записи.";

// Ошибка пересекает process boundary bridge → MCP. Передаём только локаторы
// проверенного Workspace, а не metadata целиком: там могут быть runtime keys,
// snapshots и другие данные, которые не нужны для выбора папки.
export class WorkspaceDirectoryRequiredError extends Error {
  constructor(workspaceId, candidates) {
    super(MESSAGE);
    this.code = WORKSPACE_DIRECTORY_REQUIRED;
    const visible = candidates
      .filter(({ directory }) => directory.length <= MAX_DIRECTORY_LENGTH)
      .slice(0, MAX_CANDIDATES)
      .map(({ directory, runId }) => ({ directory, runId }));
    this.details = {
      workspaceId,
      requiredAction: "select_directory",
      parameter: "parameters.directory",
      candidates: visible,
      omittedCandidateCount: candidates.length - visible.length,
    };
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

const LOCAL_RECOVERY_MESSAGE = "Локальная папка содержит несохранённые изменения завершённого Agent Run. "
  + "Bridge не перезапишет и не переместит их автоматически. Откройте целевой Run "
  + "в suggestedDirectory, сравните перечисленную дельту, перенесите только выбранные "
  + "материалы и сразу сохраните их через checkpoint, pause или finish.";

// Terminal Run не может принять новый checkpoint, а молчаливая очистка теряет
// данные. Этот bounded envelope даёт host точный безопасный маршрут в новый
// root, не передавая credentials и закрытые поля локального metadata.
export class WorkspaceLocalRecoveryRequiredError extends Error {
  constructor({
    workspaceId,
    sourceRunId,
    targetRunId,
    sourceRunStatus,
    sourceDirectory,
    sourceWorkspaceDirectory,
    suggestedDirectory,
    lastSavedDraftHead,
    changes,
  }) {
    super(LOCAL_RECOVERY_MESSAGE);
    this.code = WORKSPACE_LOCAL_RECOVERY_REQUIRED;
    const visibleChanges = changes
      .filter((change) => typeof change === "string" && change.length <= MAX_CHANGE_LENGTH)
      .slice(0, MAX_RECOVERY_CHANGES);
    this.details = {
      workspaceId,
      sourceRunId,
      targetRunId: targetRunId || null,
      sourceRunStatus,
      sourceDirectory,
      sourceWorkspaceDirectory,
      suggestedDirectory,
      lastSavedDraftHead: lastSavedDraftHead || null,
      changes: visibleChanges,
      omittedChangeCount: changes.length - visibleChanges.length,
      requiredAction: "open_recovery_directory_and_transfer_selected_changes",
      directoryParameter: "parameters.directory",
      sourceFilesMustRemainUntouched: true,
      nextSaveActions: ["checkpoint", "pause", "finish"],
    };
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

const DRAFT_RECOVERY_MESSAGE = "Локальное состояние активного Agent Run расходится с server draft. "
  + "Bridge не перезапишет её автоматически. Повторите тот же open для exact Run в "
  + "suggestedDirectory, сопоставьте перечисленную локальную дельту с server draft, "
  + "перенесите совместимые изменения и сохраните результат через checkpoint, pause или finish. "
  + "Уточнение у пользователя нужно только при смысловом конфликте.";

// Same-Run divergence is recoverable without mutating the source checkout: a
// second exact open materializes the authoritative server draft in a fresh
// root, while bounded path-level evidence tells the agent what still needs to
// be reconciled. File contents and private Run metadata never cross the bridge
// process boundary in this envelope.
export class WorkspaceDraftRecoveryRequiredError extends Error {
  constructor({
    workspaceId,
    runId,
    reasonCode,
    sourceDirectory,
    sourceWorkspaceDirectory,
    suggestedDirectory,
    baseHead,
    localHead,
    serverDraftHead,
    changes,
  }) {
    super(DRAFT_RECOVERY_MESSAGE);
    this.code = WORKSPACE_DRAFT_RECOVERY_REQUIRED;
    const visibleChanges = changes
      .filter((change) => (
        typeof change === "string"
        && change.length > 0
        && change.length <= MAX_CHANGE_LENGTH
      ))
      .slice(0, MAX_RECOVERY_CHANGES);
    this.details = {
      workspaceId,
      runId,
      reasonCode,
      sourceDirectory,
      sourceWorkspaceDirectory,
      suggestedDirectory,
      baseHead,
      localHead,
      serverDraftHead,
      changes: visibleChanges,
      omittedChangeCount: changes.length - visibleChanges.length,
      requiredAction: "open_server_draft_in_recovery_directory_and_reconcile_local_changes",
      directoryParameter: "parameters.directory",
      sourceFilesMustRemainUntouched: true,
      automaticChangesPerformed: false,
      nextSaveActions: ["checkpoint", "pause", "finish"],
    };
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

const LAYOUT_MIGRATION_MESSAGE = "Старая локальная структура Agent Workspace содержит "
  + "записи, которые bridge не может безопасно перенести автоматически. Проверьте exact "
  + "rootDirectory и blockingEntries; bridge ничего не перемещал и не удалял.";

// Legacy-container preflight выполняется до создания нового Run, поэтому
// model-facing envelope может безопасно назвать exact локальный root и bounded
// top-level entries. Он не включает содержимое файлов или служебные metadata
// прежних Run и не даёт агенту права автоматически очищать каталог.
export class WorkspaceLayoutMigrationBlockedError extends Error {
  constructor({ workspaceId, rootDirectory, blockingEntries }) {
    super(LAYOUT_MIGRATION_MESSAGE);
    this.code = WORKSPACE_LAYOUT_MIGRATION_BLOCKED;
    const visibleEntries = blockingEntries
      .filter((entry) => (
        typeof entry?.name === "string"
        && entry.name.length > 0
        && entry.name.length <= MAX_ENTRY_NAME_LENGTH
        && !entry.name.includes("\0")
        && MIGRATION_ENTRY_TYPES.has(entry.entryType)
        && MIGRATION_REASON_CODES.has(entry.reasonCode)
        && (entry.sizeBytes === undefined
          || (Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0))
      ))
      .slice(0, MAX_MIGRATION_BLOCKING_ENTRIES)
      .map((entry) => ({
        name: entry.name,
        entryType: entry.entryType,
        reasonCode: entry.reasonCode,
        ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
      }));
    this.details = {
      workspaceId,
      rootDirectory,
      operation: "open",
      requiredAction: "inspect_workspace_root_entries",
      automaticChangesPerformed: false,
      blockingEntries: visibleEntries,
      omittedBlockingEntryCount: blockingEntries.length - visibleEntries.length,
    };
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

const RUN_RECLAIM_MESSAGE = "Локальная папка содержит истёкший Agent Run, который ещё нельзя "
  + "считать пустым и безопасно заменить. Подготовьте и откройте этот exact Run через "
  + "prepare_agent_workspace_run(runId), разберите его состояние и только затем продолжайте новый Run.";

// Новый server Run может быть подготовлен раньше локального preflight. Если root
// хранит recoverable expired Run, bridge не угадывает судьбу его данных и не
// подменяет target. Вместо свободного текста возвращается bounded exact locator,
// который уже поддерживается общим lifecycle recovery flow MCP-host.
export class WorkspaceRunReclaimRequiredError extends Error {
  constructor({ workspaceId, sourceRunId, targetRunId }) {
    super(RUN_RECLAIM_MESSAGE);
    this.code = WORKSPACE_RUN_RECLAIM_REQUIRED;
    this.details = {
      requiredAction: "prepare_and_open_existing_run",
      workspaceId,
      runId: sourceRunId,
      targetRunId: targetRunId || null,
      operation: "open",
      reasonCode: "LOCAL_EXPIRED_RUN_REQUIRES_REVIEW",
    };
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

const ACTIVE_RUN_MESSAGE = "Для этого действия нужен открытый активный Trelio Agent Run. "
  + "Подготовьте нужный Workspace через prepare_agent_workspace_run, выполните возвращённый "
  + "open и повторите исходное действие один раз. Отсутствие .trelio-run.json в read-only "
  + "inspection является штатным и само по себе не означает старую локальную структуру.";

// Run-bound actions must fail with a semantic recovery route before they touch
// OAuth, secrets or provider data. The envelope intentionally contains no local
// path or metadata bytes: the caller already owns the target selection and only
// needs to know that a writable Run must be prepared and opened first.
export class WorkspaceActiveRunRequiredError extends Error {
  constructor(reasonCode) {
    super(ACTIVE_RUN_MESSAGE);
    this.code = WORKSPACE_ACTIVE_RUN_REQUIRED;
    this.details = {
      requiredAction: "prepare_and_open_workspace_run",
      reasonCode,
      automaticChangesPerformed: false,
    };
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

// Не распознаём произвольный JSON stdout, чужой код ошибки или provider stderr
// как recovery. Только bounded exact envelope своего open и своего Workspace;
// неизвестные поля не переносим в model-visible ответ.
export const parseWorkspaceDirectoryRequiredError = (stderr, workspaceId) => {
  if (typeof stderr !== "string" || stderr.length > 64 * 1024) return null;
  const text = stderr.trim();
  if (!text.startsWith("Ошибка: {")) return null;
  let payload;
  try { payload = JSON.parse(text.slice("Ошибка: ".length)); }
  catch { return null; }
  const details = payload?.details;
  if (
    payload?.code !== WORKSPACE_DIRECTORY_REQUIRED
    || details?.workspaceId !== workspaceId
    || !UUID_PATTERN.test(workspaceId)
    || details.requiredAction !== "select_directory"
    || details.parameter !== "parameters.directory"
    || !Array.isArray(details.candidates)
    || details.candidates.length > MAX_CANDIDATES
    || !Number.isSafeInteger(details.omittedCandidateCount)
    || details.omittedCandidateCount < 0
    || details.candidates.length + details.omittedCandidateCount < 2
    || details.candidates.some((candidate) => (
      typeof candidate?.directory !== "string"
      || !path.isAbsolute(candidate.directory)
      || candidate.directory.includes("\0")
      || candidate.directory.length > MAX_DIRECTORY_LENGTH
      || typeof candidate.runId !== "string"
      || !UUID_PATTERN.test(candidate.runId)
    ))
  ) return null;
  const result = new WorkspaceDirectoryRequiredError(workspaceId, details.candidates);
  result.details.omittedCandidateCount = details.omittedCandidateCount;
  return result;
};

export const parseWorkspaceLocalRecoveryRequiredError = (
  stderr,
  workspaceId,
  targetRunId = null,
) => {
  if (typeof stderr !== "string" || stderr.length > 256 * 1024) return null;
  const text = stderr.trim();
  if (!text.startsWith("Ошибка: {")) return null;
  let payload;
  try { payload = JSON.parse(text.slice("Ошибка: ".length)); }
  catch { return null; }
  const details = payload?.details;
  const expectedTargetRunId = targetRunId || null;
  if (
    payload?.code !== WORKSPACE_LOCAL_RECOVERY_REQUIRED
    || details?.workspaceId !== workspaceId
    || !UUID_PATTERN.test(workspaceId)
    || !UUID_PATTERN.test(String(details?.sourceRunId || ""))
    || details.targetRunId !== expectedTargetRunId
    || (details.targetRunId !== null && !UUID_PATTERN.test(details.targetRunId))
    || !["accepted", "cancelled"].includes(details.sourceRunStatus)
    || details.requiredAction !== "open_recovery_directory_and_transfer_selected_changes"
    || details.directoryParameter !== "parameters.directory"
    || details.sourceFilesMustRemainUntouched !== true
    || !Array.isArray(details.nextSaveActions)
    || details.nextSaveActions.join("\0") !== "checkpoint\0pause\0finish"
    || ![details.sourceDirectory, details.sourceWorkspaceDirectory, details.suggestedDirectory]
      .every((directory) => (
        typeof directory === "string"
        && path.isAbsolute(directory)
        && !directory.includes("\0")
        && directory.length <= MAX_DIRECTORY_LENGTH
      ))
    || !sameLocalPath(details.sourceWorkspaceDirectory, path.join(details.sourceDirectory, "workspace"))
    || sameLocalPath(details.suggestedDirectory, details.sourceDirectory)
    || !Array.isArray(details.changes)
    || details.changes.length > MAX_RECOVERY_CHANGES
    || details.changes.some((change) => (
      typeof change !== "string"
      || change.length === 0
      || change.length > MAX_CHANGE_LENGTH
    ))
    || !Number.isSafeInteger(details.omittedChangeCount)
    || details.omittedChangeCount < 0
    || (details.lastSavedDraftHead !== null
      && !/^[0-9a-f]{40,64}$/u.test(details.lastSavedDraftHead))
  ) return null;
  const result = new WorkspaceLocalRecoveryRequiredError({
    workspaceId,
    sourceRunId: details.sourceRunId,
    targetRunId: details.targetRunId,
    sourceRunStatus: details.sourceRunStatus,
    sourceDirectory: details.sourceDirectory,
    sourceWorkspaceDirectory: details.sourceWorkspaceDirectory,
    suggestedDirectory: details.suggestedDirectory,
    lastSavedDraftHead: details.lastSavedDraftHead,
    changes: details.changes,
  });
  result.details.omittedChangeCount = details.omittedChangeCount;
  return result;
};

export const parseWorkspaceDraftRecoveryRequiredError = (
  stderr,
  workspaceId,
  runId,
) => {
  if (typeof stderr !== "string" || stderr.length > 256 * 1024) return null;
  const text = stderr.trim();
  if (!text.startsWith("Ошибка: {")) return null;
  let payload;
  try { payload = JSON.parse(text.slice("Ошибка: ".length)); }
  catch { return null; }
  const details = payload?.details;
  if (
    payload?.code !== WORKSPACE_DRAFT_RECOVERY_REQUIRED
    || details?.workspaceId !== workspaceId
    || details?.runId !== runId
    || !UUID_PATTERN.test(String(workspaceId || ""))
    || !UUID_PATTERN.test(String(runId || ""))
    || !DRAFT_RECOVERY_REASON_CODES.has(details.reasonCode)
    || details.requiredAction
      !== "open_server_draft_in_recovery_directory_and_reconcile_local_changes"
    || details.directoryParameter !== "parameters.directory"
    || details.sourceFilesMustRemainUntouched !== true
    || details.automaticChangesPerformed !== false
    || !Array.isArray(details.nextSaveActions)
    || details.nextSaveActions.join("\0") !== "checkpoint\0pause\0finish"
    || ![details.sourceDirectory, details.sourceWorkspaceDirectory, details.suggestedDirectory]
      .every((directory) => (
        typeof directory === "string"
        && path.isAbsolute(directory)
        && !directory.includes("\0")
        && directory.length <= MAX_DIRECTORY_LENGTH
      ))
    || !sameLocalPath(details.sourceWorkspaceDirectory, path.join(details.sourceDirectory, "workspace"))
    || sameLocalPath(details.suggestedDirectory, details.sourceDirectory)
    || ![details.baseHead, details.localHead, details.serverDraftHead]
      .every((head) => typeof head === "string" && GIT_HEAD_PATTERN.test(head))
    || !Array.isArray(details.changes)
    || details.changes.length > MAX_RECOVERY_CHANGES
    || details.changes.some((change) => (
      typeof change !== "string"
      || change.length === 0
      || change.length > MAX_CHANGE_LENGTH
    ))
    || !Number.isSafeInteger(details.omittedChangeCount)
    || details.omittedChangeCount < 0
  ) return null;
  const result = new WorkspaceDraftRecoveryRequiredError({
    workspaceId,
    runId,
    reasonCode: details.reasonCode,
    sourceDirectory: details.sourceDirectory,
    sourceWorkspaceDirectory: details.sourceWorkspaceDirectory,
    suggestedDirectory: details.suggestedDirectory,
    baseHead: details.baseHead,
    localHead: details.localHead,
    serverDraftHead: details.serverDraftHead,
    changes: details.changes,
  });
  result.details.omittedChangeCount = details.omittedChangeCount;
  return result;
};

export const parseWorkspaceLayoutMigrationBlockedError = (stderr, workspaceId) => {
  if (typeof stderr !== "string" || stderr.length > 64 * 1024) return null;
  const text = stderr.trim();
  if (!text.startsWith("Ошибка: {")) return null;
  let payload;
  try { payload = JSON.parse(text.slice("Ошибка: ".length)); }
  catch { return null; }
  const details = payload?.details;
  if (
    payload?.code !== WORKSPACE_LAYOUT_MIGRATION_BLOCKED
    || details?.workspaceId !== workspaceId
    || !UUID_PATTERN.test(workspaceId)
    || typeof details.rootDirectory !== "string"
    || !path.isAbsolute(details.rootDirectory)
    || details.rootDirectory.includes("\0")
    || details.rootDirectory.length > MAX_DIRECTORY_LENGTH
    || details.operation !== "open"
    || details.requiredAction !== "inspect_workspace_root_entries"
    || details.automaticChangesPerformed !== false
    || !Array.isArray(details.blockingEntries)
    || details.blockingEntries.length === 0
    || details.blockingEntries.length > MAX_MIGRATION_BLOCKING_ENTRIES
    || details.blockingEntries.some((entry) => (
      typeof entry?.name !== "string"
      || entry.name.length === 0
      || entry.name.length > MAX_ENTRY_NAME_LENGTH
      || entry.name.includes("\0")
      || path.basename(entry.name) !== entry.name
      || !MIGRATION_ENTRY_TYPES.has(entry.entryType)
      || !MIGRATION_REASON_CODES.has(entry.reasonCode)
      || (entry.sizeBytes !== undefined
        && (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0))
    ))
    || !Number.isSafeInteger(details.omittedBlockingEntryCount)
    || details.omittedBlockingEntryCount < 0
  ) return null;
  const result = new WorkspaceLayoutMigrationBlockedError({
    workspaceId,
    rootDirectory: details.rootDirectory,
    blockingEntries: details.blockingEntries,
  });
  result.details.omittedBlockingEntryCount = details.omittedBlockingEntryCount;
  return result;
};

export const parseWorkspaceRunReclaimRequiredError = (
  stderr,
  workspaceId,
  targetRunId = null,
) => {
  if (typeof stderr !== "string" || stderr.length > 64 * 1024) return null;
  const text = stderr.trim();
  if (!text.startsWith("Ошибка: {")) return null;
  let payload;
  try { payload = JSON.parse(text.slice("Ошибка: ".length)); }
  catch { return null; }
  const details = payload?.details;
  const expectedTargetRunId = targetRunId || null;
  if (
    payload?.code !== WORKSPACE_RUN_RECLAIM_REQUIRED
    || details?.requiredAction !== "prepare_and_open_existing_run"
    || details.workspaceId !== workspaceId
    || !UUID_PATTERN.test(workspaceId)
    || !UUID_PATTERN.test(String(details.runId || ""))
    || details.targetRunId !== expectedTargetRunId
    || (details.targetRunId !== null && !UUID_PATTERN.test(details.targetRunId))
    || details.operation !== "open"
    || details.reasonCode !== "LOCAL_EXPIRED_RUN_REQUIRES_REVIEW"
  ) return null;
  return new WorkspaceRunReclaimRequiredError({
    workspaceId,
    sourceRunId: details.runId,
    targetRunId: details.targetRunId,
  });
};

export const parseWorkspaceActiveRunRequiredError = (stderr, operation) => {
  if (typeof stderr !== "string" || stderr.length > 64 * 1024) return null;
  const text = stderr.trim();
  if (!text.startsWith("Ошибка: {")) return null;
  let payload;
  try { payload = JSON.parse(text.slice("Ошибка: ".length)); }
  catch { return null; }
  const details = payload?.details;
  if (
    payload?.code !== WORKSPACE_ACTIVE_RUN_REQUIRED
    || details?.requiredAction !== "prepare_and_open_workspace_run"
    || !ACTIVE_RUN_REASON_CODES.has(details.reasonCode)
    || details.automaticChangesPerformed !== false
    || typeof operation !== "string"
    || operation.length === 0
    || operation.length > 128
  ) return null;
  const result = new WorkspaceActiveRunRequiredError(details.reasonCode);
  result.details.operation = operation;
  return result;
};
