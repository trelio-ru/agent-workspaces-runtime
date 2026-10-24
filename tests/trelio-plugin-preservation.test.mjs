import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { runStdioHost } from "../host-runtime/scripts/trelio-remote-mcp.mjs";
import { startLoadedCodexPluginPreservation } from "../host-runtime/scripts/trelio-workspace.mjs";

const execute = promisify(execFile);
const waitUntil = async (predicate) => {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "preservation did not converge in the same live process");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-plugin-preservation-"));
  const plugin = path.join(root, "codex", "plugins", "cache", "trelio-plugins", "trelio-agent-workspaces", "3.2.3");
  for (const directory of [".codex-plugin", "hooks", "scripts", "skills/example"]) {
    await fs.mkdir(path.join(plugin, directory), { recursive: true });
  }
  await fs.writeFile(path.join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({ name: "trelio-agent-workspaces", version: "3.2.3" }));
  await fs.writeFile(path.join(plugin, "hooks/hooks.json"), '{"hooks":{"PreToolUse":[]}}');
  await fs.writeFile(path.join(plugin, "skills/example/SKILL.md"), "exact old instructions\n");
  await fs.writeFile(path.join(plugin, "scripts/hook.mjs"), 'process.stdout.write("exact-old-hook");\n', { mode: 0o755 });
  return { root, plugin, retentionDirectory: path.join(root, "private", "retention"), environment: {
    CODEX_HOME: path.join(root, "codex"), TRELIO_PLUGIN_ROOT: plugin, TRELIO_PLUGIN_VERSION: "3.2.3",
    TRELIO_HOST_RUNTIME_VERSION: "3.18.0",
  } };
};

// This regression uses the production MCP composition, not only the retention
// helper. A signed-runtime refactor must not silently disconnect this lifecycle
// hook again. Everything is synthetic: no user's state, OAuth or remote Trelio.
test("open MCP restores its old hook and skill paths after an external plugin update", async () => {
  const f = await fixture();
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = [];
  let preservation;
  let starts = 0;
  let pending = "";
  output.on("data", chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      frames.push(JSON.parse(pending.slice(0, end)));
      pending = pending.slice(end + 1);
    }
  });
  const host = runStdioHost({
    inputStream: input, outputStream: output, environment: f.environment,
    legacyMcpMigration: async () => ({ status: "not_found" }),
    diagnosticReporter: { record() {}, close() {} },
    handleMessage: async message => ({ jsonrpc: "2.0", id: message.id, result: { method: message.method } }),
    preservePlugin: options => {
      starts++;
      assert.ok(frames.some(frame => frame.id === 1), "initialize must already be written before snapshot starts");
      preservation = startLoadedCodexPluginPreservation({ ...options, retentionDirectory: f.retentionDirectory, checkIntervalMs: 20,
        onError: error => { throw error; } });
      return preservation;
    },
  });
  try {
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await waitUntil(() => preservation !== undefined);
    await preservation.ready;
    const hookBefore = await fs.readFile(path.join(f.plugin, "hooks/hooks.json"));
    // Model an update performed by Codex's own manager, outside our updater:
    // remove the whole old plugin parent, then install a different version.
    const parent = path.dirname(f.plugin);
    await fs.rm(parent, { recursive: true });
    const newer = path.join(parent, "3.2.4");
    await fs.mkdir(newer, { recursive: true });
    await fs.writeFile(path.join(newer, "sentinel"), "new release stays untouched");
    await waitUntil(async () => fs.readFile(path.join(f.plugin, "skills/example/SKILL.md"), "utf8").then(text => text === "exact old instructions\n", () => false));
    assert.deepEqual(await fs.readFile(path.join(f.plugin, "hooks/hooks.json")), hookBefore);
    assert.equal((await execute(process.execPath, [path.join(f.plugin, "scripts/hook.mjs")])).stdout, "exact-old-hook");
    assert.equal(await fs.readFile(path.join(newer, "sentinel"), "utf8"), "new release stays untouched");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    await waitUntil(() => frames.some(frame => frame.id === 2));
    assert.equal(starts, 1, "the same MCP stays alive without a restart or second snapshot owner");
    input.end();
    await host;
    await fs.rm(f.plugin, { recursive: true });
    await new Promise(resolve => setTimeout(resolve, 80));
    await assert.rejects(fs.stat(f.plugin), { code: "ENOENT" }, "closed MCP must not resurrect its former installation");
  } finally {
    input.end();
    await host;
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("slow preservation does not hold initialize or subsequent MCP requests", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let data = "";
  let closed = false;
  output.on("data", chunk => { data += chunk; });
  const host = runStdioHost({ inputStream: input, outputStream: output, environment: {},
    legacyMcpMigration: async () => ({ status: "not_found" }), diagnosticReporter: { record() {}, close() {} },
    handleMessage: async message => ({ jsonrpc: "2.0", id: message.id, result: {} }),
    preservePlugin: () => ({ ready: new Promise(() => {}), close: async () => { closed = true; } }),
  });
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await waitUntil(() => data.includes('"id":2'));
  input.end();
  await host;
  assert.equal(closed, true);
});

test("preservation rejects corrupted retained bytes without replacing the missing shell", async () => {
  const f = await fixture();
  const errors = [];
  const preservation = startLoadedCodexPluginPreservation({ ...f, checkIntervalMs: 20, onError: error => errors.push(error) });
  try {
    const entry = await preservation.ready;
    await fs.writeFile(path.join(entry.pluginDirectory, "scripts/hook.mjs"), 'process.stdout.write("untrusted");');
    await fs.rm(f.plugin, { recursive: true });
    await waitUntil(() => errors.length > 0);
    await assert.rejects(fs.stat(f.plugin), { code: "ENOENT" });
    assert.equal(errors.length, 1, "integrity failure stops repair instead of looping");
  } finally {
    await preservation.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("two open sessions survive repeated external pruning without replacing different bytes", async () => {
  const f = await fixture();
  const errors = [];
  const options = { ...f, checkIntervalMs: 20, onError: error => errors.push(error) };
  const first = startLoadedCodexPluginPreservation(options);
  const second = startLoadedCodexPluginPreservation(options);
  try {
    await Promise.all([first.ready, second.ready]);
    for (let i = 0; i < 3; i++) {
      await fs.rm(f.plugin, { recursive: true });
      await waitUntil(async () => fs.readFile(path.join(f.plugin, "scripts/hook.mjs"), "utf8").then(text => text.includes("exact-old-hook"), () => false));
    }
    assert.deepEqual(errors, []);
    // A present replacement is never overwritten by a background timer.
    await fs.writeFile(path.join(f.plugin, "skills/example/SKILL.md"), "operator-edited bytes");
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await fs.readFile(path.join(f.plugin, "skills/example/SKILL.md"), "utf8"), "operator-edited bytes");
  } finally {
    await Promise.all([first.close(), second.close()]);
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("source and non-Codex shell roots never create a retention store", async () => {
  const f = await fixture();
  try {
    for (const environment of [{}, { ...f.environment, TRELIO_PLUGIN_ROOT: f.root },
      { ...f.environment, CODEX_HOME: path.join(f.root, "different-client") },
      { ...f.environment, TRELIO_PLUGIN_VERSION: "3.2.4" }]) {
      const preservation = startLoadedCodexPluginPreservation({ environment, retentionDirectory: f.retentionDirectory });
      assert.equal(await preservation.ready, null);
      await preservation.close();
    }
    await assert.rejects(fs.stat(f.retentionDirectory), { code: "ENOENT" });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
