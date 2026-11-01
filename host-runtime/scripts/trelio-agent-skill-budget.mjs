// Generated portable agent skill budget. Do not edit by hand.
// Generated from trelio-ru/agent-skills/platform-skills/tools/skill-source-metadata.mjs. Do not edit by hand.
/**
 * SKILL.md keeps discovery prose and human catalog copy separate. Only the
 * explicit metadata.catalog_title/catalog_description pair may update a card;
 * legacy description/H1 can be English routing instructions, never UI copy.
 * This bounded reader accepts simple scalars/folded text, never YAML execution.
 * Unsupported or legacy documents retain the explicit draft/current card.
 * The same pure module is used by the browser and the maintainer publisher.
 */
export const readAgentSkillSourceMetadata = (source, expectedSkillId) => {
  const normalized = String(source || "").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length > 200_000) return null;
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(`${normalized}\n`);
  if (!match) return null;
  const lines = match[1].split("\n");
  const scalar = value => {
    const text = value.trim();
    if (text.startsWith('"')) {
      try { const parsed = JSON.parse(text); return typeof parsed === "string" ? parsed : null; }
      catch { return null; }
    }
    if (text.startsWith("'")) return /^'(?:[^']|'')*'$/u.test(text) ? text.slice(1, -1).replaceAll("''", "'") : null;
    if (!text || /^[!&*[{|>#]/u.test(text) || /^(?:true|false|null|~)$/iu.test(text)) return null;
    return text.replace(/\s+#.*$/u, "");
  };
  const field = (key, scope = lines) => {
    const indexes = scope.flatMap((line, index) => line.startsWith(`${key}:`) ? [index] : []);
    if (indexes.length !== 1) return null;
    const index = indexes[0];
    const value = scope[index].slice(key.length + 1).trim();
    if (/^[>|][-+]?$/u.test(value)) {
      const continuation = [];
      for (let i = index + 1; i < scope.length && /^(?:\s|$)/u.test(scope[i]); i += 1) {
        continuation.push(scope[i].trim());
      }
      return continuation.join(value.startsWith(">") ? " " : "\n").trim();
    }
    return scalar(value);
  };
  const id = field("name");
  const blocks = lines.flatMap((line, index) => line.startsWith("metadata:") ? [index] : []);
  if (blocks.length !== 1 || lines[blocks[0]].trim() !== "metadata:") return null;
  const metadata = [];
  for (let i = blocks[0] + 1; i < lines.length; i += 1) {
    if (lines[i] && !/^\s/u.test(lines[i])) break;
    if (lines[i] && !lines[i].startsWith("  ")) return null;
    metadata.push(lines[i].slice(2));
  }
  // Match the API normalizer before hashing a publication plan. Never fall
  // back to the agent's technical description or a guessed Markdown heading.
  const description = field("catalog_description", metadata)?.trim();
  const title = field("catalog_title", metadata)?.trim();
  if (!id || (expectedSkillId !== undefined && id !== expectedSkillId) || !description || description.length > 10_000 || !title || title.length > 255) return null;
  return { title, description };
};

/** Catalog presentation is not executable/discovery instruction text. Remove
 * only a validated explicit pair, preserving technical description, body and
 * unrelated metadata. Legacy/unsupported sources remain byte-for-byte intact.
 * This projection is shared by publishers, pre-encryption and budget reports. */
export const stripAgentSkillCatalogMetadata = (source) => {
  if (!readAgentSkillSourceMetadata(source)) return source;
  const text = String(source).trim();
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) return source;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const header = match[1].split(/\r?\n/u);
  const start = header.findIndex(line => line === "metadata:");
  let end = start + 1;
  while (end < header.length && (!header[end] || /^\s/u.test(header[end]))) end += 1;
  const retained = [];
  for (let index = start + 1; index < end; index += 1) {
    if (/^  catalog_(?:title|description):/u.test(header[index])) {
      // Folded continuations belong to this field, never the next mapping key.
      while (index + 1 < end && /^(?:    |$)/u.test(header[index + 1])) index += 1;
    } else retained.push(header[index]);
  }
  const keepBlock = retained.some(line => line.trim() && !line.trim().startsWith("#"));
  const nextHeader = [...header.slice(0, start), ...(keepBlock ? ["metadata:", ...retained] : []), ...header.slice(end)];
  return ["---", ...nextHeader, "---"].join(newline)
    + (match[0].endsWith("\n") ? newline : "") + text.slice(match[0].length);
};

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
  const normalized = stripAgentSkillCatalogMetadata(value).trim();
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

/** Publisher-owned discovery prose, shared by server and browser encryption.
 * ASCII English keeps the always-on layer small; searchTerms remain multilingual.
 * This is a capability description, never a replacement for skill authority.
 */
export const AGENT_SKILL_ROUTING_SUMMARY_MAX_CHARS = 180;

/** @param {unknown} value */
export const normalizeAgentSkillRoutingSummary = (value) => {
  if (typeof value !== "string") throw new Error("routingSummary is required.");
  const normalized = value.trim();
  if (normalized.length < 12 || normalized.length > AGENT_SKILL_ROUTING_SUMMARY_MAX_CHARS
    || !/^[\x20-\x7e]+$/u.test(normalized) || /~e1:|https?:\/\//iu.test(normalized)) {
    throw new Error("routingSummary must be one English capability sentence (12–180 ASCII characters), without URLs or markers.");
  }
  return normalized;
};
