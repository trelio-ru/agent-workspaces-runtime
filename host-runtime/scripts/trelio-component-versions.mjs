const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

// Direct source-tree tests and maintainer commands do not run through the
// stable plugin loader. Give those processes an explicit non-release identity
// instead of reusing an arbitrary historical plugin version. The production
// entrypoint rejects a missing or malformed identity before it starts bridge,
// hook or MCP code.
export const DEVELOPMENT_COMPONENT_VERSION = "0.0.0";

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
