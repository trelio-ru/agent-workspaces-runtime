// Generated portable unfiled response policy. Do not edit by hand.
/** Shared native/local delivery policy; no database or company content.
 * Delivery entry points only. Poll deltas, proposal contexts/cards and other
 * domain mutation receipts keep their existing snapshot/idempotency ABI.
 * Exact task reads budget the context separately inside their own builder. */
export const MCP_UNFILED_CONTEXT_RESPONSE_TOOLS = new Set([
    "get_task", "get_tasks", "get_task_instruction_page",
    "get_agent_instructions", "get_project_meta", "get_task_create_meta", "get_workspace",
    "get_agent_workspace", "get_agent_workspace_by_scope", "get_agent_workspace_file", "fetch",
    "prepare_agent_workspace_run", "prepare_agent_workspace_read", "get_task_review_context",
    "create_workspace", "update_workspace", "delete_workspace", "apply_workspace_transfer", "list_workspaces",
]);
/** An unscoped discovery with just one accessible hit still did not select a
 * company. Denied sibling companies cannot turn a mixed request into selection. */
export const isUnfiledResponseScopeSelected = (policyClass, input) => {
    if (Array.isArray(input.companySlugs) && input.companySlugs.length !== 1)
        return false;
    return policyClass !== "discovery" || typeof input.companySlug === "string"
        || Array.isArray(input.companySlugs) && input.companySlugs.length === 1;
};
