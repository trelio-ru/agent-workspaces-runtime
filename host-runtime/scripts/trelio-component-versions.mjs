const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

// Direct source-tree tests and maintainer commands do not run through the
// stable plugin loader. Give those processes an explicit non-release identity
// instead of reusing an arbitrary historical plugin version. The production
// entrypoint rejects a missing or malformed identity before it starts bridge,
// hook or MCP code.
export const DEVELOPMENT_COMPONENT_VERSION = "0.0.0";

// Harness evaluates engines.dsh with includePrerelease=true. The minimum keeps
// older incompatible APIs out; newer releases need no per-version approval.
// Qualification is test evidence, not a second installation gate. Bundle and
// diagnostics share these values so their compatibility claims cannot drift.
export const DEEPSEEK_HARNESS_VERSION_RANGE = ">=0.2.1-rc.2";
export const DEEPSEEK_HARNESS_QUALIFIED_VERSION = "0.2.1-rc.3";

const normalizeStableVersion = (value) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return STABLE_VERSION_PATTERN.test(normalized) ? normalized : null;
};

export const readTrelioComponentVersions = (environment = process.env) => ({
  pluginVersion: normalizeStableVersion(environment.TRELIO_PLUGIN_VERSION),
  hostRuntimeVersion: normalizeStableVersion(
    environment.TRELIO_HOST_RUNTIME_VERSION,
  ),
});

export const requireTrelioComponentVersions = (environment = process.env) => {
  const versions = readTrelioComponentVersions(environment);
  const invalidVariables = [];

  if (!versions.pluginVersion) invalidVariables.push("TRELIO_PLUGIN_VERSION");
  if (!versions.hostRuntimeVersion) {
    invalidVariables.push("TRELIO_HOST_RUNTIME_VERSION");
  }

  if (invalidVariables.length > 0) {
    throw new Error(
      `Trelio host runtime requires exact stable ${invalidVariables.join(" and ")} values from the plugin loader.`,
    );
  }

  return versions;
};

export const getPluginVersion = (environment = process.env) => (
  readTrelioComponentVersions(environment).pluginVersion
  ?? DEVELOPMENT_COMPONENT_VERSION
);

export const getHostRuntimeVersion = (environment = process.env) => (
  readTrelioComponentVersions(environment).hostRuntimeVersion
  ?? DEVELOPMENT_COMPONENT_VERSION
);

// These exports describe the current process. Production gets exact values
// from the stable loader; source-tree execution is visibly unversioned.
export const PLUGIN_VERSION = getPluginVersion();
export const HOST_RUNTIME_VERSION = getHostRuntimeVersion();

// Value-only client identity shared by launcher, OAuth engine and credential vault.
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
