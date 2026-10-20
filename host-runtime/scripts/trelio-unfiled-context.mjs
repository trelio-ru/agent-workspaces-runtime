const SLUG = /^[a-z0-9_-]{1,120}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Consume only the backend's fresh, structural single-company contract.
 * No local folder scan, title hydration, stored queue, response text inspection
 * or hook decision. An empty snapshot removes a prior reminder without adding
 * any instruction; failures never manufacture count=0. */
export const validateUnfiledResponseContext = (queue, companySlug) => {
  const context = queue?.responseContext;
  if (!SLUG.test(companySlug ?? "") || queue?.schemaVersion !== 1
    || queue.companySlug !== companySlug || context?.companySlug !== companySlug
    || !Number.isSafeInteger(queue.count) || queue.count < 0 || context.count !== queue.count) {
    throw new Error("UNFILED_CONTEXT_INVALID");
  }
  if (queue.count === 0) {
    if (Object.keys(context).some(key => !["companySlug", "count"].includes(key))) throw new Error("UNFILED_CONTEXT_INVALID");
    return { companySlug, count: 0 };
  }
  const workspace = context.workspace;
  if (!UUID.test(workspace?.id ?? "") || !Number.isFinite(Date.parse(workspace.expiresAt))
    || typeof workspace.workspaceUrl !== "string" || workspace.workspaceUrl.length > 2048
    || typeof context.timeZone !== "string" || context.timeZone.length > 80
    || typeof context.reminder?.instruction !== "string" || context.reminder.instruction.length > 2400
    || context.reminder.count !== queue.count || context.nextCall?.tool !== "get_unfiled_workspaces"
    || context.nextCall.arguments?.companySlug !== companySlug) throw new Error("UNFILED_CONTEXT_INVALID");
  const url = new URL(workspace.workspaceUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== `/${encodeURIComponent(companySlug)}/workspaces/catalog/${workspace.id}/`) throw new Error("UNFILED_CONTEXT_INVALID");
  new Intl.DateTimeFormat("ru-RU", { timeZone: context.timeZone });
  // Copy only the response contract; never reflect extra server/private fields.
  return { companySlug, count: queue.count, timeZone: context.timeZone,
    workspace: { id: workspace.id, workspaceUrl: workspace.workspaceUrl, expiresAt: workspace.expiresAt },
    reminder: { instruction: context.reminder.instruction, count: queue.count },
    nextCall: { tool: "get_unfiled_workspaces", arguments: { companySlug } } };
};

export const readUnfiledResponseContext = async (origin, companySlug, {
  signal, readQueue, bridge,
} = {}) => {
  // A caller must already have an exact company from its successful read/Run.
  // Neither a global account nor a folder mentioned in prose selects a queue.
  if (!SLUG.test(companySlug ?? "")) return undefined;
  const deadline = AbortSignal.timeout(5000);
  const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    let queue;
    if (readQueue) queue = await readQueue(companySlug, readSignal);
    else {
      const runtime = bridge ?? await import("./trelio-workspace.mjs");
      // An assistant has no human unfiled queue or human OAuth fallback. The
      // active trusted transport profile selects this algorithmic omission;
      // a failed queue read must never trigger a human vault lookup.
      if (runtime.currentWorkspaceExecutionProfile?.()?.kind === 'digital_assistant') return undefined;
      const token = await runtime.readExistingBridgeSessionToken(origin, { signal: readSignal });
      if (!token) return undefined; // Never start pairing or repair from an advisory read.
      const response = await runtime.request(origin, token,
        `/api/agent-workspaces/unfiled-queue?${new URLSearchParams({ companySlug })}`,
        { signal: readSignal, maximumErrorResponseBytes: 64 * 1024 });
      queue = JSON.parse((await runtime.readBoundedResponseBuffer(response, 64 * 1024, "Unfiled context")).toString("utf8"));
    }
    return validateUnfiledResponseContext(queue, companySlug);
  } catch {
    // Keep a successful save/read successful. The agent can refresh this exact
    // company without replaying the completed action or erasing its obligation.
    return { companySlug, status: "unavailable",
      nextCall: { tool: "get_unfiled_workspaces", arguments: { companySlug } } };
  }
};
