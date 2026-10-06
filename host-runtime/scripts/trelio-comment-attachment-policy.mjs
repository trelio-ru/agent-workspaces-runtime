// Generated portable comment attachment policy. Do not edit by hand.
/**
 * One portable selection contract for native and encrypted comment proposals.
 * Workspace readability is broader than usefulness as a comment attachment:
 * cumulative context and the Run journal require a direct request for those
 * exact files. This never hides them from Workspace reading or export.
 */
export const COMMENT_ATTACHMENT_GUIDANCE = "Attach only useful final or intermediate deliverables. Exclude WORKSPACE_CONTEXT.md, legacy PROJECT_CONTEXT.md and worklog/** by default. "
    + "Only a direct user request for those exact files permits userExplicitlyRequestedContextAttachments=true; inferred usefulness, Run acceptance and a request to comment do not. Prefer an accessible Workspace link for ongoing context. Publication still requires a separate user action.";
export class CommentAttachmentPolicyError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "CommentAttachmentPolicyError";
    }
}
export const isWorkspaceContextAttachmentPath = (filePath) => {
    // Normalize spelling only for classification. Exact accepted-path lookup
    // still belongs to the caller and must never read a normalized alternative.
    const segments = filePath.replaceAll("\\", "/").toLowerCase()
        .split("/").filter((segment) => segment && segment !== ".");
    const basename = segments.at(-1);
    return basename === "workspace_context.md"
        || basename === "project_context.md"
        || segments[0] === "worklog";
};
export const resolveCommentContextAttachmentPolicy = (filePaths, userExplicitlyRequestedContextAttachments) => {
    if (userExplicitlyRequestedContextAttachments !== undefined
        && userExplicitlyRequestedContextAttachments !== true) {
        throw new CommentAttachmentPolicyError("CONTEXT_ATTACHMENT_REQUEST_INVALID", "userExplicitlyRequestedContextAttachments accepts only literal true after a direct user request for the exact context files.");
    }
    if (userExplicitlyRequestedContextAttachments === true)
        return "user_requested_context";
    if (filePaths.some(isWorkspaceContextAttachmentPath)) {
        // Do not echo paths: the same error is returned by the E2EE provider.
        throw new CommentAttachmentPolicyError("CONTEXT_ATTACHMENT_REQUIRES_USER_REQUEST", "Workspace context and worklog files are excluded from comment attachments by default. Remove them, or set userExplicitlyRequestedContextAttachments=true only after a direct user request for those exact files. An accessible Workspace link is sufficient for ongoing context.");
    }
    return "deliverables_only";
};
