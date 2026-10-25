/** Build a small immutable native bundle around the existing signed loader.
 * This does not edit a Harness profile, install npm dependencies, enable a
 * plugin or grant OAuth. Only dsh's own plugin manager owns profile changes.
 * Keep the official shell at a permanent path: every startup re-verifies the
 * selected runtime rather than importing an unverified copy of its code.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { assertPrivatePathKind, ensurePrivateDirectory, hardenWindowsPrivatePath,
  resolveWorkspaceBridgeConfigDirectory } from "./trelio-workspace.mjs";

export const buildDeepseekBundle = ({ pluginRoot }) => {
  if (!path.isAbsolute(pluginRoot) || pluginRoot.includes("\0")) throw new Error("TRELIO_HARNESS_PLUGIN_ROOT_REQUIRED");
  const loader = pathToFileURL(path.join(pluginRoot, "scripts", "trelio-host-runtime-loader.mjs")).href;
  const shell = pathToFileURL(path.join(pluginRoot, "scripts", "trelio-host-runtime-shell.mjs")).href;
  return {
    "package.json": `${JSON.stringify({ name: "@trelio/deepseek-harness", version: "0.1.0",
      private: true, type: "module", main: "./index.mjs", engines: { node: ">=24.9.0", dsh: "0.2.1-rc.2" },
      dsh: { bundle: { patch: "./cordis.patch.yml" } } }, null, 2)}\n`,
    "cordis.patch.yml": "- insert:\n    - id: trelio-deepseek-harness\n      name: ./index.mjs\n",
    "index.mjs": `// Generated native bootstrap. Business code stays in the signed runtime.\nimport { pathToFileURL } from 'node:url';\nimport path from 'node:path';\nimport { selectHostRuntime } from ${JSON.stringify(loader)};\nimport { PLUGIN_VERSION } from ${JSON.stringify(shell)};\nconst selected = await selectHostRuntime();\nif (!selected) throw new Error('TRELIO_HOST_RUNTIME_REQUIRED');\nprocess.env.TRELIO_PLUGIN_ROOT = ${JSON.stringify(pluginRoot)};\nprocess.env.TRELIO_PLUGIN_VERSION = PLUGIN_VERSION;\nprocess.env.TRELIO_HOST_RUNTIME_VERSION = selected.runtimeVersion;\nconst native = await import(pathToFileURL(path.join(selected.runtimeDirectory, 'scripts', 'trelio-deepseek-harness.mjs')).href);\nexport const name = native.name;\nexport const inject = native.inject;\nexport const apply = native.apply;\n`,
  };
};

export const installDeepseekBundle = async ({ pluginRoot = process.env.TRELIO_PLUGIN_ROOT,
  configDirectory = resolveWorkspaceBridgeConfigDirectory() } = {}) => {
  if (!pluginRoot) throw new Error("TRELIO_HARNESS_PLUGIN_ROOT_REQUIRED");
  const root = await fs.realpath(pluginRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
  if (manifest.name !== "trelio-agent-workspaces") throw new Error("TRELIO_HARNESS_PLUGIN_ROOT_REQUIRED");
  const files = buildDeepseekBundle({ pluginRoot: root });
  const digest = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const directory = path.join(configDirectory, "native-clients", "deepseek-harness", "bundles", digest);
  await ensurePrivateDirectory(directory);
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(directory, name);
    let handle;
    try {
      handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.close(); handle = null;
      if (process.platform === "win32") await hardenWindowsPrivatePath(file, "file");
    } catch (error) {
      await handle?.close();
      if (error.code !== "EEXIST") throw error;
      // An immutable bundle may be reused, never overwritten. Preserve user
      // modifications and unsafe entries, including a symlink at a file path.
      await assertPrivatePathKind(file, "file");
      if (await fs.readFile(file, "utf8") !== bytes) throw new Error("TRELIO_HARNESS_BUNDLE_CHANGED");
    }
  }
  return { experimental: true, bundleDirectory: directory, qualifiedHarnessVersion: "0.2.1-rc.2",
    installedInHarness: false, nextAction: "Use dsh plugin --profile <actual-profile> add <bundleDirectory>; reload that profile, then call trelio_connect." };
};
