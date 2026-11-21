// This inventory is selected by the signed launcher, never by MCP input.
// Claude keeps the hook-gated public profile and a separate OS-vault cell.
// Cursor and Antigravity use distinct loopback profiles with their existing
// company policy families. The vendor-managed grants stay in their own stores.
const desktopOAuthProfiles = Object.freeze({
  "claude-code": Object.freeze({
    id: "trelio_agent_workspaces_v1",
    name: "Trelio – Claude Code",
    authRequired: "TRELIO_CLAUDE_AUTH_REQUIRED",
  }),
  cursor: Object.freeze({
    id: "trelio_cursor_local_agent_workspaces_v1",
    name: "Trelio – Cursor Desktop",
    authRequired: "TRELIO_CURSOR_AUTH_REQUIRED",
  }),
  antigravity: Object.freeze({
    id: "trelio_antigravity_local_agent_workspaces_v1",
    name: "Trelio – Antigravity",
    authRequired: "TRELIO_ANTIGRAVITY_AUTH_REQUIRED",
  }),
});

export const getDesktopOAuthProfile = client => Object.hasOwn(desktopOAuthProfiles, client)
  ? desktopOAuthProfiles[client] : null;
export const isDesktopOAuthInvocation = args =>
  args.length === 2 && args[0] === "--desktop-oauth" && Boolean(getDesktopOAuthProfile(args[1]));
