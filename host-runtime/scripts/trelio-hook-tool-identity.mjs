/**
 * Единственный контракт идентичности инструментов для hook и doctor.
 *
 * Клиентский matcher выбирает handler до запуска runtime. Поэтому строки
 * matcher сохраняют byte-for-byte контракт stable shell, а парсер и self-check
 * используют те же шаблоны. Смена формата клиента должна проходить regression
 * обоих уровней; эвристика по подстроке "trelio" не является границей сервера.
 */
const FORMATS = [
  ["native", "direct", "^(mcp__)?trelio__(?<nativeTool>[a-z0-9_]+)$"],
  ["native", "plugin_qualified", "^mcp__plugin_trelio-agent-workspaces_trelio__(?<nativeTool>[a-z0-9_]+)$"],
  ["native", "separated", "^(mcp[:./-])?trelio[:./-](?<nativeTool>[a-z0-9_]+)$"],
  ["local", "direct", "^(mcp__)?trelio_remote_skills__continue_trelio_local_action$"],
  ["local", "plugin_qualified", "^mcp__plugin_trelio-agent-workspaces_trelio-remote-skills__continue_trelio_local_action$"],
  ["local", "separated", "^(mcp[:./-])?trelio-remote-skills[:./-]continue_trelio_local_action$"],
].map(([kind, spelling, source]) => ({ kind, spelling, source, pattern: new RegExp(source, "iu") }));

// Capture groups нужны только parser-у. Их удаление из exact source сохраняет
// прежние bytes клиентского matcher, а не поддерживает вторую ручную regexp.
export const TRELIO_PRE_TOOL_USE_MATCHER = FORMATS.map(({ source }) => (
  source.replace("(?<nativeTool>[a-z0-9_]+)", "[a-z0-9_]+")
)).join("|");
const NATIVE_TOOL = /^[a-z][a-z0-9_]{0,127}$/u;
const LOCAL_ROUTES = new Set(["context", "action", "proposal_context", "workspace"]);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (reason) => ({ status: "invalid", reason, toolName: null });

// Не отражаем исходный payload в ошибке: в нём могут быть закрытые материалы.
export class TrelioHookToolIdentityError extends Error {
  constructor(reason) {
    super("Hook получил вызов Trelio, но его имя или структура аргументов не соответствуют контракту (" + reason + "). Вызов остановлен до отправки; сохраните этот код и проверьте версию клиента и server-returned action.");
    this.code = "TRELIO_HOOK_TOOL_IDENTITY_INVALID";
  }
}

export const readTrelioHookToolInput = (hookInput) => {
  let input = hookInput?.tool_input ?? hookInput?.toolInput ?? hookInput?.input ?? {};
  if (typeof input === "string") {
    if (input.length > 256 * 1024) throw new TrelioHookToolIdentityError("input_too_large");
    try { input = JSON.parse(input); }
    catch { throw new TrelioHookToolIdentityError("invalid_json"); }
  }
  if (!isRecord(input)) throw new TrelioHookToolIdentityError("input_not_object");
  return input;
};

export const resolveTrelioHookToolIdentity = (hookInput) => {
  const rawName = hookInput?.tool_name ?? hookInput?.toolName;
  if (typeof rawName !== "string" || rawName.length > 512) {
    return { status: "unrelated", toolName: null };
  }
  const format = FORMATS.find(({ pattern }) => pattern.test(rawName));
  if (!format) return { status: "unrelated", toolName: null };
  if (hookInput.tool_name !== undefined && hookInput.toolName !== undefined
    && hookInput.tool_name !== hookInput.toolName) return invalid("conflicting_names");
  const { kind, spelling, pattern } = format;
  if (kind === "native") {
    const toolName = rawName.match(pattern).groups.nativeTool.toLowerCase();
    return NATIVE_TOOL.test(toolName)
      ? { status: "native", spelling, toolName }
      : invalid("invalid_native_name");
  }

  let input;
  try { input = readTrelioHookToolInput(hookInput); }
  catch { return invalid("invalid_local_input"); }
  if (input.schemaVersion !== 1 || !isRecord(input.parameters)
    || !LOCAL_ROUTES.has(input.route)) return invalid("invalid_local_envelope");

  // Proposal templates and Workspace routes can legitimately omit nativeTool:
  // they do not forward a hook proof to a native MCP action. Preserve that ABI.
  // For action, only parameters.nativeTool names the signed method. Neither
  // top-level nativeTool nor parameters.arguments.nativeTool can substitute it.
  const nativeTool = typeof input.parameters.nativeTool === "string"
    ? input.parameters.nativeTool.trim() : input.parameters.nativeTool;
  if (nativeTool === undefined && input.route !== "action") {
    return { status: "local_without_native_tool", spelling, toolName: null };
  }
  if (typeof nativeTool !== "string" || !NATIVE_TOOL.test(nativeTool)) {
    return invalid("invalid_local_native_name");
  }
  return { status: "local", spelling, toolName: nativeTool };
};

// Retain the existing public helper for consumers that only need a nullable
// method name. Execution uses the typed result so malformed Trelio calls never
// silently become unrelated calls and continue without a proof.
export const resolveTrelioMcpToolName = (hookInput) => resolveTrelioHookToolIdentity(hookInput).toolName;

/** Static compatibility evidence, never evidence that a client ran the hook. */
export const inspectTrelioHookToolRouting = (matcher) => {
  // Only evaluate our known anchored pattern. A corrupted plugin regexp must
  // not execute arbitrary expensive matching inside the diagnostic process.
  if (matcher !== TRELIO_PRE_TOOL_USE_MATCHER) return { status: "definition_mismatch" };
  const selected = new RegExp(TRELIO_PRE_TOOL_USE_MATCHER, "u");
  const nativeName = "mcp__trelio__get_agent_instructions";
  const localName = "mcp__trelio_remote_skills__continue_trelio_local_action";
  const native = resolveTrelioHookToolIdentity({ tool_name: nativeName });
  const local = resolveTrelioHookToolIdentity({
    tool_name: localName,
    tool_input: { schemaVersion: 1, route: "action", parameters: { nativeTool: "create_task" } },
  });
  return {
    status: selected.test(nativeName) && selected.test(localName)
      && native.toolName === "get_agent_instructions" && local.toolName === "create_task"
      ? "compatible" : "incompatible",
    evidence: "static_contract_check",
    hookInputField: "tool_name",
    canonicalExample: nativeName,
    dispatchDisplayExample: "mcp__trelioget_agent_instructions",
    dispatchDisplayIsHookIdentity: false,
  };
};
