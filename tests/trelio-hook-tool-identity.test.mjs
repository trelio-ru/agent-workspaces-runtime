import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  TRELIO_PRE_TOOL_USE_MATCHER,
  inspectTrelioHookToolRouting,
  readTrelioHookToolInput,
  resolveTrelioHookToolIdentity,
} from "../host-runtime/scripts/trelio-hook-tool-identity.mjs";
import { pluginDirectory } from "./test-layout.mjs";

test("identity contract matches the approved shell and every supported host spelling", async () => {
  const hooks = JSON.parse(await readFile(path.join(pluginDirectory, "hooks", "hooks.json"), "utf8"));
  const matcher = hooks.hooks.PreToolUse[0].matcher;
  assert.equal(TRELIO_PRE_TOOL_USE_MATCHER, matcher, "runtime change must not silently require renewed hook trust");
  const selected = new RegExp(matcher);
  for (const name of [
    "mcp__trelio__get_agent_instructions", "trelio__get_agent_instructions",
    "mcp__plugin_trelio-agent-workspaces_trelio__get_agent_instructions",
    ...[":", ".", "/", "-"].flatMap((separator) => [
      "trelio" + separator + "get_agent_instructions",
      "mcp" + separator + "trelio" + separator + "get_agent_instructions",
    ]),
  ]) {
    assert.ok(selected.test(name), name);
    assert.equal(resolveTrelioHookToolIdentity({ tool_name: name }).toolName, "get_agent_instructions", name);
  }
  for (const name of [
    "mcp__trelio_remote_skills__continue_trelio_local_action",
    "trelio_remote_skills__continue_trelio_local_action",
    "mcp__plugin_trelio-agent-workspaces_trelio-remote-skills__continue_trelio_local_action",
    ...[":", ".", "/", "-"].flatMap((separator) => [
      "trelio-remote-skills" + separator + "continue_trelio_local_action",
      "mcp" + separator + "trelio-remote-skills" + separator + "continue_trelio_local_action",
    ]),
  ]) {
    assert.ok(selected.test(name), name);
    const identity = resolveTrelioHookToolIdentity({ tool_name: name, tool_input: {
      schemaVersion: 1, route: "action",
      nativeTool: "delete_workspace",
      parameters: { nativeTool: "create_task", arguments: { nativeTool: "apply_task_patch" } },
    } });
    assert.equal(identity.status, "local");
    assert.equal(identity.toolName, "create_task");
  }
});

test("Codex dispatch display is not canonical hook identity and cannot widen the server boundary", () => {
  // Source evidence: openai/codex rust-v0.160.0, protocol/src/tool_name.rs
  // Display concatenates namespace/name; core/src/tools/handlers/mcp.rs
  // join_tool_name inserts "__" independently for PreToolUse. The reported
  // display mismatch is reproducible without a hook matcher defect.
  const namespace = "mcp__trelio";
  const method = "get_agent_instructions";
  const displayName = namespace + method;
  const hookName = namespace.replace(/_+$/u, "") + "__" + method.replace(/^_+/u, "");
  assert.equal(resolveTrelioHookToolIdentity({ tool_name: hookName }).toolName, method);
  const rejected = [
    displayName, "mcp__trelio_other__get_task", "mcp__other__trelio__get_task",
    "mcp__plugin_other_trelio__get_task", "mcp__trelio_mcp__get_task",
    "mcp__trelio_remote_skills__doctor_remote_agent_skill",
    "mcp__trelio_remote_skills__continue_trelio_local_action_extra",
    "prefix_mcp__trelio__get_task", "mcp__trelio__get_task/suffix", "exec_command",
  ];
  for (const tool_name of rejected) {
    assert.equal(new RegExp(TRELIO_PRE_TOOL_USE_MATCHER).test(tool_name), false, tool_name);
    assert.equal(resolveTrelioHookToolIdentity({ tool_name, nativeTool: "get_task" }).status, "unrelated", tool_name);
  }
  const report = inspectTrelioHookToolRouting(TRELIO_PRE_TOOL_USE_MATCHER);
  assert.equal(report.status, "compatible");
  assert.equal(report.evidence, "static_contract_check");
  assert.equal(report.dispatchDisplayIsHookIdentity, false);
  assert.equal(report.canonicalExample, hookName);
  assert.equal(report.dispatchDisplayExample, displayName);
  assert.deepEqual(inspectTrelioHookToolRouting("*"), { status: "definition_mismatch" });
});

test("recognized malformed local action has an explicit identity failure while valid templates remain usable", () => {
  const tool_name = "mcp__trelio_remote_skills__continue_trelio_local_action";
  for (const tool_input of [
    "secret-not-json", [], null,
    { schemaVersion: 1, route: "action", parameters: {} },
    { schemaVersion: 1, route: "action", parameters: { nativeTool: "INVALID_TOOL" } },
    { schemaVersion: 1, route: "action", parameters: { nativeTool: "invalid/tool" } },
    { schemaVersion: 1, route: "action", parameters: { nativeTool: "a".repeat(129) } },
    { schemaVersion: 1, route: "action", nativeTool: "get_task", parameters: { arguments: { nativeTool: "get_task" } } },
    { schemaVersion: 2, route: "action", parameters: { nativeTool: "get_task" } },
    { schemaVersion: 1, route: "unknown", parameters: { nativeTool: "get_task" } },
  ]) {
    const result = resolveTrelioHookToolIdentity({ tool_name, tool_input });
    assert.equal(result.status, "invalid");
    assert.equal(result.toolName, null);
    assert.doesNotMatch(JSON.stringify(result), /secret-not-json|INVALID_TOOL|invalid\/tool/u);
  }
  for (const route of ["context", "proposal_context", "workspace"]) {
    const result = resolveTrelioHookToolIdentity({ tool_name, tool_input: {
      schemaVersion: 1, route, parameters: { kind: "comment", arguments: {} },
    } });
    assert.equal(result.status, "local_without_native_tool");
    assert.equal(result.toolName, null);
  }
  assert.equal(resolveTrelioHookToolIdentity({
    tool_name: "mcp__trelio__get_task", toolName: "mcp__other__get_task",
  }).status, "invalid");
  for (const tool_input of ["synthetic-secret", [], 3]) {
    assert.throws(() => readTrelioHookToolInput({ tool_input }), (error) => {
      assert.equal(error.code, "TRELIO_HOOK_TOOL_IDENTITY_INVALID");
      assert.doesNotMatch(error.message, /synthetic-secret/u);
      return true;
    });
  }
});
