import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { inspectBundledPlugin } from '../host-runtime/scripts/trelio-workspace.mjs';

test('Antigravity diagnosis validates the actual native shell without foreign hooks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-antigravity-doctor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'plugin.json'), JSON.stringify({ name: 'trelio-agent-workspaces' }));
  await fs.writeFile(path.join(root, 'PLUGIN_VERSION'), '3.1.0\n');
  const config = { mcpServers: {
    trelio: { serverUrl: 'https://trelio.ru/mcp', oauth: { clientId: 'trelio_antigravity_agent_workspaces_v1' } },
    'trelio-remote-skills': { command: process.execPath, args: [path.join(root, 'scripts/trelio-host-runtime-loader.mjs'), 'mcp'], cwd: root },
  } };
  const configPath = path.join(root, 'mcp_config.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  const options = { pluginDirectory: root, loadedPluginVersion: '3.1.0', clientKind: 'antigravity' };
  const result = await inspectBundledPlugin(options);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.hooks, { status: 'not_applicable' });
  assert.deepEqual(result.manifests, { antigravityVersion: '3.1.0' });
  assert.deepEqual((await inspectBundledPlugin({ ...options, loadedPluginVersion: '3.0.0' })).issues,
    ['ANTIGRAVITY_MANIFEST_VERSION_MISMATCH']);
  config.mcpServers.trelio.oauth.clientId = 'trelio_cursor_agent_workspaces_v1';
  await fs.writeFile(configPath, JSON.stringify(config));
  assert.deepEqual((await inspectBundledPlugin(options)).issues, ['ANTIGRAVITY_MCP_REGISTRATION_INVALID']);
});
