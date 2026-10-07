// Generated portable task review completion policy. Do not edit by hand.
/**
 * Pure native/local completion assembler. Only the trusted descriptor supplies
 * targets and CAS fields; the model supplies text, selections and reasons. Keep
 * this module dependency-free: the signed runtime uses its generated copy before
 * encrypting prose. Preparation never publishes, applies or dismisses a card.
 */
export const TASK_REVIEW_COMPLETION_REF_PATTERN = /^tr1_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const TASK_REVIEW_COMPLETION_KINDS = ["comment", "checklist", "status", "control"];
/** Wire plan, shared by the live reader and context-budget fixtures. The nulls
 * are a safe template, not inferred semantic decisions or human approval. */
export const buildTaskReviewCompletionPlan = (input) => {
    const completions = [{ completionRef: input.completionRef,
            decisions: { comment: null, checklist: null, status: null, control: null } }];
    return {
        completionRef: input.completionRef, expiresAt: input.expiresAt, availableKinds: input.availableKinds,
        instruction: "Assess the complete task, dates and evidence before filling this template. Supply all four decisions; null means no justified proposal. Code supplies targets, CAS fields and order. Stale plans require new assessment, never automatic replay. No publish/apply/dismiss authority is granted.",
        nextCall: input.local
            ? { server: "trelio-remote-skills", tool: "render_trelio_local_proposal", arguments: {
                    companySlug: input.companySlug, kind: "bundle", operation: "save", payload: { completions }
                } }
            : { server: "trelio", tool: "render_task_proposals", arguments: { companySlug: input.companySlug, completions } },
    };
};
export class TaskReviewCompletionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const invalid = (message) => { throw new TaskReviewCompletionError("TASK_REVIEW_COMPLETION_INVALID", message); };
const object = (value, keys) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => !keys.includes(key)))
        return invalid("Unknown or malformed completion decision fields.");
    return value;
};
const text = (value, max) => {
    if (typeof value !== "string" || !value.trim() || value.trim().length > max)
        return invalid("Missing or oversized completion decision text.");
    return value.trim();
};
const selected = (value) => {
    if (!Array.isArray(value) || !value.length || value.length > 20)
        return invalid("Choose 1–20 items, or null for no proposal.");
    return value;
};
export const assembleTaskReviewCompletion = (descriptor, rawDecisions) => {
    if (descriptor?.schemaVersion !== 1 || !descriptor.cards || !descriptor.candidates
        || !Array.isArray(descriptor.candidates.checklist) || !Array.isArray(descriptor.candidates.status)
        || !Array.isArray(descriptor.candidates.control))
        return invalid("Invalid completion descriptor.");
    const rawTarget = object(descriptor.target, ["runId", "companySlug", "projectSlug", "taskNumber"]);
    const target = rawTarget.runId !== undefined
        ? (Object.keys(rawTarget).length === 1 ? { runId: text(rawTarget.runId, 64) } : invalid("Ambiguous completion target."))
        : { companySlug: text(rawTarget.companySlug, 120), projectSlug: text(rawTarget.projectSlug, 120), taskNumber: rawTarget.taskNumber };
    if (!("runId" in target) && (target.companySlug !== descriptor.companySlug
        || !["string", "number"].includes(typeof target.taskNumber)))
        return invalid("Invalid completion task binding.");
    const decisions = object(rawDecisions, [...TASK_REVIEW_COMPLETION_KINDS]);
    if (TASK_REVIEW_COMPLETION_KINDS.some((kind) => !Object.hasOwn(decisions, kind))) {
        return invalid("Assess all four decisions explicitly; use null when no proposal is justified or permitted.");
    }
    const blocks = [];
    for (const kind of TASK_REVIEW_COMPLETION_KINDS) {
        const value = decisions[kind];
        if (value === null)
            continue;
        const card = descriptor.cards[kind];
        if (!card)
            return invalid("This review does not permit the selected proposal kind.");
        let semantic;
        if (kind === "comment") {
            const decision = object(value, ["proposalText", "filePaths", "userExplicitlyRequestedContextAttachments"]);
            semantic = { proposalText: text(decision.proposalText, 20_000) };
            if (decision.filePaths !== undefined || decision.userExplicitlyRequestedContextAttachments !== undefined) {
                if (!("runId" in descriptor.target))
                    return invalid("Workspace attachments require a task Run.");
                if (decision.filePaths !== undefined) {
                    if (!Array.isArray(decision.filePaths) || decision.filePaths.length > 10)
                        return invalid("At most ten Run files can be proposed.");
                    semantic.filePaths = decision.filePaths.map((path) => text(path, 2048));
                }
                if (decision.userExplicitlyRequestedContextAttachments !== undefined) {
                    if (decision.userExplicitlyRequestedContextAttachments !== true)
                        return invalid("The context attachment exception requires explicit user authority.");
                    semantic.userExplicitlyRequestedContextAttachments = true;
                }
            }
        }
        else if (kind === "status") {
            const decision = object(value, ["targetStatusCode", "reason"]);
            const code = text(decision.targetStatusCode, 64);
            if (!descriptor.candidates.status.includes(code))
                return invalid("The selected completion status is not transitionable in this review.");
            semantic = { intent: "whole_task_ready", targetStatusCode: code, reason: text(decision.reason, 4000) };
        }
        else {
            const field = kind === "checklist" ? "changes" : "controls";
            const decision = object(value, [field]);
            const seen = new Set();
            semantic = { [field]: selected(decision[field]).map((raw) => {
                    const item = object(raw, kind === "checklist" ? ["itemId", "targetIsCompleted", "reason"] : ["controlId", "reason"]);
                    const idField = kind === "checklist" ? "itemId" : "controlId";
                    const id = text(item[idField], 64);
                    if (seen.has(id))
                        return invalid("Duplicate completion selection.");
                    seen.add(id);
                    if (kind === "checklist") {
                        const candidate = descriptor.candidates.checklist.find((entry) => entry.id === id);
                        if (!candidate || typeof item.targetIsCompleted !== "boolean" || item.targetIsCompleted === candidate.isCompleted) {
                            return invalid("Select a changed state of an ordinary editable checklist item.");
                        }
                    }
                    else if (!descriptor.candidates.control.includes(id))
                        return invalid("Select a visible active control with clear permission.");
                    return { [idField]: id, reason: text(item.reason, 4000),
                        ...(kind === "checklist" ? { targetIsCompleted: item.targetIsCompleted } : {}) };
                }) };
        }
        // Never spread model input: even future fields cannot override the reviewed
        // target, source revision, card kind or completion-only status intent.
        if (!Number.isSafeInteger(card.expectedStateRevision) || card.expectedStateRevision < 0)
            return invalid("Invalid completion revision.");
        const fields = { expectedStateRevision: card.expectedStateRevision };
        if (kind === "comment") {
            if (typeof card.expectedPublicCommentsSnapshotHash !== "string" || !/^[0-9a-f]{64}$/u.test(card.expectedPublicCommentsSnapshotHash))
                return invalid("Invalid completion authoring snapshot.");
            fields.expectedPublicCommentsSnapshotHash = card.expectedPublicCommentsSnapshotHash;
        }
        if (kind === "status")
            fields.expectedStatusId = text(card.expectedStatusId, 64);
        blocks.push({ type: { comment: "commentProposal", checklist: "checklistProposal", status: "statusProposal", control: "controlClearProposal" }[kind],
            ...fields, ...target, ...semantic });
    }
    return blocks;
};
