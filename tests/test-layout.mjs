import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeRepositoryRoot = path.resolve(testDirectory, "..");

// Cross-repository compatibility tests consume a real plugin checkout. The
// environment variable is mandatory in CI and also lets maintainers test an
// arbitrary plugin branch without copying plugin sources into this repository.
export const pluginDirectory = path.resolve(
  process.env.TRELIO_AGENT_WORKSPACES_PLUGIN_ROOT
    || path.join(
      runtimeRepositoryRoot,
      "..",
      "agent-workspaces",
      "plugins",
      "trelio-agent-workspaces",
    ),
);

export const pluginRepositoryRoot = path.resolve(pluginDirectory, "..", "..");
