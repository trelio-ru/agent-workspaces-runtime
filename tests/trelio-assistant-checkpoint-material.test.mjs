import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  assistantNativePrompt, assistantRetiredCheckpointMaterial, assistantWorkStateContext,
} from '../host-runtime/scripts/trelio-assistant-codex.mjs';

const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');

function example() {
  const scope = { assistantId: randomUUID(), questionId: randomUUID(), workspaceId: randomUUID(), runId: randomUUID(),
    taskPass: { companyId: randomUUID(), taskId: randomUUID(), passId: randomUUID() } };
  const { assistantId, questionId, workspaceId, runId, taskPass } = scope;
  const run = { workspaceId, runId }, operationId = randomUUID(), sourceTurnId = randomUUID(), deliveryId = randomUUID();
  const checkpoint = { ...run, checkpointId: randomUUID(), draftHead: 'b'.repeat(40) };
  const path = 'assistants/' + assistantId + '/WORK.md', old = 'Старая запись\r\n', text = 'Обновление\n';
  const beforeSha256 = digest(old), afterSha256 = digest(text);
  const call = (tool, args, result) => ({ type: 'mcpToolCall', server: 'trelio-assistant', tool,
    status: 'completed', arguments: { taskPass, ...args }, result: { structuredContent: result } });
  const action = (args, result) => call('continue_assistant_workspace_action', { schemaVersion: 1, ...args }, result);
  const file = (command, result) => call('use_assistant_workspace_files', { runIdentity: run, command }, result);
  const taskContext = assistantWorkStateContext({ assistantId, companyId: taskPass.companyId, taskId: taskPass.taskId,
    ownerQuestionIds: [questionId] });
  const root = { type: 'userMessage', content: [{ type: 'text', text: assistantNativePrompt(deliveryId, taskContext, {}) }] };
  const readQuestion = call('get_assistant_owner_question', { questionId }, {
    id: questionId, state: 'answered', taskId: taskPass.taskId, assistantUserId: assistantId });
  const prepare = call('prepare_assistant_workspace_run', { ...run, clientRequestId: randomUUID() }, {
    resumed: true, prepared: true, run: { id: runId }, workspace: { id: workspaceId, scopeType: 'task', ...taskPass },
    bridge: { actions: { open: { arguments: { parameters: run } } } } });
  const open = action({ operation: 'open', parameters: run }, { schemaVersion: 1, state: 'running', operation: 'open', operationId,
    nextCall: { tool: 'continue_assistant_workspace_action', arguments: { schemaVersion: 1, operation: 'status', runIdentity: run,
      parameters: { finishOperationId: operationId } } } });
  const poll = action(open.result.structuredContent.nextCall.arguments, { schemaVersion: 1, state: 'completed', operation: 'open', operationId });
  const read = file({ action: 'read', path }, { sha256: beforeSha256, text: old, nextOffset: null });
  const replace = file({ action: 'replace', expectedSha256: beforeSha256, path, text }, { sha256: afterSha256, state: 'draft_updated' });
  const saved = action({ operation: 'checkpoint', runIdentity: run, parameters: { type: 'draft', summary: 'Тестовый черновик' } },
    { schemaVersion: 1, operation: 'checkpoint', taskDraftCheckpoint: checkpoint });
  const turn = { id: sourceTurnId, status: 'interrupted', items: [root, readQuestion, prepare, open, poll, read, replace, saved] };
  return { turn, scope, deliveryId, expected: { sourceTurnId, ...checkpoint, path, beforeSha256, afterSha256 } };
}

test('resumed own Run links its previous WORK digest, exact replacement and signed draft checkpoint', () => {
  const { turn, scope, deliveryId, expected } = example();
  const failedPoll = structuredClone(turn.items[4]);
  failedPoll.status = 'failed';
  failedPoll.result = { isError: true };
  turn.items.splice(4, 1, failedPoll);
  // Independently fenced browser or skill activity cannot contribute any
  // fields to this byte-level evidence, including a checkpoint-shaped result.
  turn.items.splice(6, 0, { type: 'mcpToolCall', server: 'trelio-assistant', tool: 'use_assistant_browser',
    status: 'failed', arguments: { taskPass: scope.taskPass }, result: { structuredContent: { taskDraftCheckpoint: { runId: randomUUID() } } } });
  assert.deepEqual(assistantRetiredCheckpointMaterial(turn, deliveryId, scope), expected);
});

test('missing authority, ambiguous material or later changes cannot attest the saved bytes', () => {
  for (const invalidate of [
    turn => { turn.items[0].content[0].text += 'extra'; },
    turn => { turn.items[1].result.structuredContent.state = 'pending'; },
    turn => { turn.items[2].arguments = { ...turn.items[2].arguments, runId: undefined }; },
    turn => { turn.items[2].result.structuredContent.resumed = false; },
    turn => { turn.items[3].result.structuredContent.nextCall.arguments.runIdentity = { workspaceId: randomUUID(), runId: randomUUID() }; },
    turn => { turn.items[5].result.structuredContent.sha256 = 'c'.repeat(64); },
    turn => { turn.items[6].arguments.command.path = 'WORK.md'; },
    turn => { turn.items[6].arguments.command.text += '\r'; },
    turn => { turn.items[6].arguments.taskPass = { ...turn.items[6].arguments.taskPass, passId: randomUUID() }; },
    turn => { turn.items[7].result.structuredContent.taskDraftCheckpoint.runId = randomUUID(); },
    turn => { delete turn.items[7].result.structuredContent.taskDraftCheckpoint; },
    turn => { turn.items.push(structuredClone(turn.items[6])); },
    turn => { turn.items.push(structuredClone(turn.items[7])); },
    turn => { const read = structuredClone(turn.items[5]); read.result.structuredContent.sha256 = digest('later'); turn.items.push(read); },
  ]) {
    const { turn, scope, deliveryId } = example();
    invalidate(turn);
    assert.equal(assistantRetiredCheckpointMaterial(turn, deliveryId, scope), null, invalidate.toString());
  }
});
