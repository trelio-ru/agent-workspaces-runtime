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
/** A continuation is the undelivered remainder of the original order for delivery
 * purposes only. The next native call still performs its ordinary live ACL and
 * rules checks; this payload grants no authority and carries no reuse hints. */
export const buildMcpTaskBatchContinuation = (remaining) => remaining.length === 0 ? undefined : remaining.length === 1
    ? { tool: "get_task", arguments: remaining[0] }
    : { tool: "get_tasks", arguments: { tasks: remaining } };
/** Try complete delivery first, then the longest intact prefix that fits. The
 * callbacks size both the content and its real continuation in the selected
 * transport. The input has already been checked in full, even after a split. */
export const selectMcpTaskReadBatch = (taskCount, buildPage, fits) => {
    for (let count = taskCount; count > 0; count--) {
        const page = buildPage(count);
        if (fits(page))
            return page;
    }
};
/** Only recheck live access to the same Git head on subsequent pages. Order
 * comes from the accepted inventory, never from mutable search-index status.
 * The byte cap keeps short inventories compact and long paths bounded. */
export const buildMcpWorkspaceFilePage = (files, offset) => {
    let end = offset;
    let bytes = 2;
    while (end < files.length && end - offset < 100) {
        const entryBytes = Buffer.byteLength(JSON.stringify(files[end]), "utf8") + 1;
        if (bytes + entryBytes > 64 * 1024)
            break;
        bytes += entryBytes;
        end++;
    }
    if (end === offset && end < files.length)
        return null;
    return { files: files.slice(offset, end), nextOffset: end < files.length ? end : null };
};
export const isMcpWorkspaceFilesPage = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2)
        return false;
    const page = value;
    return typeof page.workspaceHead === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(page.workspaceHead)
        && typeof page.offset === "number" && Number.isInteger(page.offset) && page.offset >= 1 && page.offset <= 100_000;
};
