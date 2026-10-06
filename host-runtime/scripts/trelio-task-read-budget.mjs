// Generated portable task read budget. Do not edit by hand.
/**
 * Service delivery policy, not an MCP protocol limit or a tokenizer estimate.
 * Codex 0.160.0 truncates tool output using ceil(UTF-8 bytes / 4); the supported
 * default model budget is 10,000 output tokens. Do not spend its extra 20%
 * serialization allowance: Code Mode can print the complete MCP envelope under
 * its own 10,000-token limit. Measure that envelope, including JSON escaping,
 * summaries and continuation keys, instead of reserving an arbitrary 1 KiB.
 *
 * This pure policy is generated into the encrypted local runtime. A client
 * configured below this baseline needs a matching output budget; MCP does not
 * negotiate it. Sources and compatibility boundaries: docs/mcp-agent-responses.md.
 */
export const MCP_TASK_READ_OUTPUT_TOKEN_BUDGET = 10_000;
export const MCP_TASK_READ_BYTES_PER_OUTPUT_TOKEN = 4;
export const MCP_TASK_READ_MAX_RESULT_BYTES = MCP_TASK_READ_OUTPUT_TOKEN_BUDGET * MCP_TASK_READ_BYTES_PER_OUTPUT_TOKEN;
export const measureMcpTaskReadResultBytes = (result) => Buffer.byteLength(JSON.stringify(result), "utf8");
export const fitsMcpTaskReadResult = (result) => measureMcpTaskReadResultBytes(result) <= MCP_TASK_READ_MAX_RESULT_BYTES;
/** The local read route uses a text-only MCP envelope; escapes are counted twice. */
export const buildLocalTaskReadToolResult = (payload) => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
});
