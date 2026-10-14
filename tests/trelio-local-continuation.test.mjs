import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectLocalContinuationArguments, recoverLocalContinuationArguments,
  validateLocalContinuationArguments } from "../host-runtime/scripts/trelio-local-continuation.mjs";
import { handleToolCall } from "../host-runtime/scripts/trelio-remote-mcp.mjs";

const now = Date.now();
const timestamp = new Date(now - 1000).toISOString();
const input = { schemaVersion: 1, route: "action", parameters: { companySlug: "demo", nativeTool: "create_task",
  arguments: { companySlug: "demo", projectSlug: "project" },
  nativeCallRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  nativeArgumentKeys: ["companySlug", "projectSlug", "title", "clientRequestId"] } };
const original = { companySlug: "demo", projectSlug: "project", title: "PRIVATE-CONTINUATION-CANARY",
  clientRequestId: "same-idempotency-key", runtimeSessionProof: { nonce: "old-proof" } };
const hookInput = { session_id: "session", tool_use_id: "current", transcript_path: "/synthetic/rollout.jsonl" };
const header = { id: "session", cli_version: "0.162.0-alpha.17.2" };
const call = (id, namespace, name, args) => ({ timestamp, type: "response_item", payload: {
  type: "function_call", call_id: id, namespace, name, arguments: JSON.stringify(args) } });
const result = { code: "MCP_LOCAL_CONTEXT_REQUIRED", providerSelection: { automatic: true,
  provider: "local_company_context", server: "trelio-remote-skills", tool: "continue_trelio_local_action",
  companySlug: "demo", nativeTool: "create_task", arguments: input } };
const output = { timestamp, type: "response_item", metadata: { fallback_token_limit_override: 12000 },
  payload: { type: "function_call_output", call_id: "source",
    output: "Wall time: 0.1 seconds\nOutput:\n" + JSON.stringify(result) } };
const rows = [call("source", "mcp__trelio", "create_task", original), output,
  call("current", "mcp__trelio_remote_skills", "continue_trelio_local_action", input)];
const collect = (changes = {}) => collectLocalContinuationArguments({ header, rows, hookInput, input, now, ...changes });

test("exact server continuation recovers original content and preserves idempotency without old proof", async () => {
  assert.deepEqual(collect(), { companySlug: "demo", projectSlug: "project", title: original.title, clientRequestId: original.clientRequestId });
  const recovered = await recoverLocalContinuationArguments({ hookInput, input,
    readTranscript: () => ({ header, rows }) });
  assert.equal(recovered.parameters.nativeCallRef, undefined);
  assert.equal(recovered.parameters.arguments.runtimeSessionProof, undefined);
  let forwarded;
  await handleToolCall("https://trelio.example", "continue_trelio_local_action", recovered, {
    localActionOperation: async (_origin, request) => { forwarded = request; return { content: [] }; },
  });
  assert.deepEqual(forwarded.arguments, collect());
});

test("changed target, operation, current call, session, bounds and context do not recover", () => {
  for (const change of [
    { header: { ...header, id: "other" } }, { header: { ...header, cli_version: "unknown" } },
    { hookInput: { ...hookInput, tool_use_id: "other" } }, { hookInput: { ...hookInput, agent_id: "child" } },
    { now: now + 16 * 60 * 1000 },
    { input: { ...input, route: "context" } },
    { input: { ...input, parameters: { ...input.parameters, companySlug: "other" } } },
    { input: { ...input, parameters: { ...input.parameters, arguments: { companySlug: "demo", projectSlug: "other" } } } },
    { rows: [rows[0], output, { type: "compacted" }, rows[2]] },
    { rows: [rows[0], output, { type: "turn_context" }, rows[2]] },
    { rows: [rows[0], { ...output, metadata: { fallback_token_limit_override: 1 } }, rows[2]] },
    { rows: [rows[0], { ...output, payload: { ...output.payload, success: false } }, rows[2]] },
    { rows: [rows[0], output, rows[0], output, rows[2]] },
  ]) assert.equal(collect(change), null, JSON.stringify(change));
});

test("unresolved input fails before invoking any provider; explicit and old calls remain usable", async () => {
  let calls = 0;
  const options = { localActionOperation: async () => { calls++; return { content: [] }; } };
  await assert.rejects(handleToolCall("https://trelio.example", "continue_trelio_local_action", input, options),
    { code: "LOCAL_CONTEXT_INVALID_INPUT" });
  assert.equal(calls, 0);
  const args = { companySlug: "demo", projectSlug: "project", title: original.title, clientRequestId: original.clientRequestId };
  await handleToolCall("https://trelio.example", "continue_trelio_local_action",
    { ...input, parameters: { ...input.parameters, arguments: args } }, options);
  await handleToolCall("https://trelio.example", "continue_trelio_local_action",
    { schemaVersion: 1, route: "action", parameters: { companySlug: "demo", nativeTool: "create_task", arguments: args } }, options);
  assert.equal(calls, 2);
  assert.throws(() => validateLocalContinuationArguments({ ...input, parameters: {
    ...input.parameters, arguments: { ...args, companySlug: "other" } } }), { code: "LOCAL_CONTEXT_INVALID_INPUT" });
});

test("production bounded worker uses only its exact owner transcript, rejecting symlinks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-continuation-test-"));
  try {
    const transcript = path.join(dir, "rollout.jsonl");
    const hook = { ...hookInput, transcript_path: transcript };
    await fs.writeFile(transcript, [JSON.stringify({ type: "session_meta", payload: header }),
      ...rows.map((row) => JSON.stringify(row))].join("\n") + "\n", { mode: 0o600 });
    const recovered = await recoverLocalContinuationArguments({ hookInput: hook, input });
    assert.equal(recovered.parameters.arguments.title, original.title);
    const linked = path.join(dir, "link.jsonl");
    await fs.symlink(transcript, linked);
    assert.deepEqual(await recoverLocalContinuationArguments({ hookInput: { ...hook, transcript_path: linked }, input }), input);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
