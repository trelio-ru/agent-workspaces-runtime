/**
 * Prepare one ordinary native read, without executing it from the local MCP.
 * Only the owning client sees its model's direct schemas and can dispatch the
 * normal hook/proof. A successful doctor, cached catalogue or empty ALL_TOOLS
 * cannot replace that evidence. Keeping selection here avoids asking the model
 * to reconstruct tool names/arguments or mistake an untested read for a failure.
 */
export class DiagnosticReadTargetError extends Error {
  constructor() {
    super("readTarget requires exact companySlug, optional projectSlug and a positive taskNumber with projectSlug.");
    this.name = "DiagnosticReadTargetError";
    this.code = "TRELIO_INSTALLATION_DIAGNOSTIC_INVALID_INPUT";
  }
}

export const normalizeDiagnosticReadTarget = (value) => {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["companySlug", "projectSlug", "taskNumber"].includes(key))
    || typeof value.companySlug !== "string" || !/^[a-z0-9_-]{1,120}$/u.test(value.companySlug)
    || (value.projectSlug !== undefined && (typeof value.projectSlug !== "string" || !/^[a-z0-9_-]{1,120}$/u.test(value.projectSlug)))
    || (value.taskNumber !== undefined && (value.projectSlug === undefined
      || !["string", "number"].includes(typeof value.taskNumber)
      || !/^[1-9][0-9]{0,9}$/u.test(String(value.taskNumber))))) {
    throw new DiagnosticReadTargetError();
  }
  return {
    companySlug: value.companySlug,
    ...(value.projectSlug !== undefined ? { projectSlug: value.projectSlug } : {}),
    ...(value.taskNumber !== undefined ? { taskNumber: value.taskNumber } : {}),
  };
};

export const buildDiagnosticReadVerification = ({ clientKind, readTarget, workingFolder, publicService, requiredActions }) => {
  const target = normalizeDiagnosticReadTarget(readTarget ?? workingFolder?.scope);
  const nextCall = target
    ? { toolName: target.taskNumber !== undefined ? "get_task" : "get_agent_instructions", arguments: target }
    : { toolName: "list_companies", arguments: {} };
  // Git is required for Workspace work, not for a remote task/rules read.
  // Conversely an established hook/routing/process blocker must be resolved
  // before a protected read; this plan never bypasses that existing boundary.
  const blockers = requiredActions.filter((action) => action.code !== "INSTALL_STANDALONE_GIT").map(({ code }) => code);
  const state = blockers.length ? "prerequisite_action_required"
    : ["available", "recovered"].includes(publicService?.state) ? "client_read_required" : "public_service_not_confirmed";
  return {
    state,
    readResult: "not_checked",
    invocation: "direct",
    ...(clientKind === "codex" ? { namespace: "mcp__trelio" } : {}),
    targetSource: readTarget ? "request" : target ? "existing_folder_binding" : "company_discovery",
    nextCall: state === "client_read_required" ? nextCall : null,
    ...(blockers.length ? { prerequisiteActions: blockers } : {}),
    insufficientEvidence: ["empty_nested_ALL_TOOLS", "public_service_available", "server_ready", "cli_inventory"],
    instructions: "Выполни nextCall обычным прямым MCP-вызовом в текущем чате, вне functions.exec. Пустой ALL_TOOLS не проверяет direct schema. До фактического ответа или точного отказа клиента чтение остаётся not_checked: не объявляй инструменты недоступными и не повторяй doctor вместо чтения. Если direct schema действительно отсутствует, сообщи именно этот непроверенный клиентский доступ; не выдумывай вызов и не обходи его shell/HTTP/local proxy. После успешного чтения продолжай исходную работу; list_companies проверяет только OAuth и требует затем выбрать exact scope. Обычные ACL/proof/E2EE и отдельный refresh существующей папки сохраняются; исходную mutation не повторяй.",
  };
};
