// Generated portable agent skill budget. Do not edit by hand.
/**
 * One portable policy for publication and final model delivery. UTF-8 bytes,
 * rather than string.length or tokenizer guesses, account for Cyrillic and
 * emoji consistently in Node, browser E2EE and the generated local host copy.
 */
export const AGENT_SKILL_INSTRUCTIONS_MAX_BYTES = 16 * 1024;
export const AGENT_SKILL_MCP_MAX_RESULT_BYTES = 40_000;

/** @param {string} value */
export const agentSkillUtf8Bytes = (value) => new TextEncoder().encode(value).byteLength;

export class AgentSkillInstructionBudgetError extends Error {
  code = "AGENT_SKILL_INSTRUCTIONS_TOO_LARGE";
  /** @param {number} actualBytes */
  constructor(actualBytes) {
    super(`Основная инструкция навыка занимает ${actualBytes} байт; предел – 16384 байта (16 КиБ UTF-8). Вынесите подробные сценарии в доступные документы, сохранив обязательные правила безопасности.`);
    this.actualBytes = actualBytes;
    this.maximumBytes = AGENT_SKILL_INSTRUCTIONS_MAX_BYTES;
  }
}

/** Existing immutable releases are never normalized by this publication guard.
 * @param {string} value
 */
export const normalizeAgentSkillInstructions = (value) => {
  const normalized = value.trim();
  const bytes = agentSkillUtf8Bytes(normalized);
  if (bytes > AGENT_SKILL_INSTRUCTIONS_MAX_BYTES) throw new AgentSkillInstructionBudgetError(bytes);
  return normalized;
};

/** Measure the complete serialized envelope visible to tools, without hidden
 * App metadata. Unknown visible fields and repeated/escaped JSON count too.
 * @param {unknown} result
 */
export const measureAgentSkillMcpResultBytes = (result) => {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const { _meta: _hidden, ...visible } = /** @type {Record<string, unknown>} */ (result);
    return agentSkillUtf8Bytes(JSON.stringify(visible));
  }
  return agentSkillUtf8Bytes(JSON.stringify(result) ?? "null");
};

/** Final read guard: never return a runtime action beside incomplete authority.
 * This also covers old immutable releases, personal rules and future fields.
 * The original result remains untouched; oversized text is not truncated.
 * @param {string} toolName
 * @param {unknown} result
 */
export const enforceAgentSkillMcpBudget = (toolName, result) => {
  if (toolName !== "get_agent_skill" || !result || typeof result !== "object"
    || /** @type {Record<string, unknown>} */ (result).isError === true) return result;
  const actualBytes = measureAgentSkillMcpResultBytes(result);
  if (actualBytes <= AGENT_SKILL_MCP_MAX_RESULT_BYTES) return result;
  const payload = {
    code: "AGENT_SKILL_RESPONSE_TOO_LARGE",
    actualBytes,
    maximumBytes: AGENT_SKILL_MCP_MAX_RESULT_BYTES,
    message: "Полный ответ навыка превышает 40000 байт. Инструкции не обрезаны и исполнение не разрешено этим ответом. Издателю нужно сократить основную инструкцию или служебные данные; подробные сценарии должны оставаться доступными отдельно.",
  };
  return { isError: true, structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
};
