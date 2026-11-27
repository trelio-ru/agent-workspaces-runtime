import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  assistantCarriedAnswerReadOnly, assistantDeliveryMarker, assistantNativePrompt, assistantRetiredCheckpointMaterial,
  assistantWorkStateContext, readAssistantCodexDelivery,
} from '../host-runtime/scripts/trelio-assistant-codex.mjs';
import { nativeRpc } from './fixtures/assistant-native-rpc.mjs';

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

test('a carried answer releases the fence only after the whole original and inspection are read-only', () => {
  const { turn: original, scope, deliveryId, expected } = example();
  const siteOrigin = 'https://mail.google.com';
  const browser = (operation, args, state) => ({
    type: 'mcpToolCall', server: 'trelio-assistant', tool: 'use_assistant_browser', status: 'completed',
    arguments: { taskPass: scope.taskPass, siteOrigin, command: { operation, args } },
    result: { content: [{ type: 'text', text: JSON.stringify({ state, reason: 'none' }) }] },
  });
  const failed = browser('screenshot', {}, 'ready');
  failed.status = 'failed';
  failed.result = { isError: true, structuredContent: { code: 'ASSISTANT_RUNTIME_REQUEST_INVALID_VALUE_FRAME' } };
  original.items.push(browser('navigate', { url: siteOrigin + '/mail/u/0/#chat/home' }, 'preparing'), failed,
    browser('status', {}, 'ready'), browser('close', {}, 'closed'));
  const read = { type: 'mcpToolCall', server: 'trelio-assistant', tool: 'get_task', status: 'completed',
    arguments: { taskPass: scope.taskPass }, result: { structuredContent: { tasks: [] } } };
  const inspection = { status: 'completed', items: [{ type: 'userMessage' }, read] };
  assert.deepEqual(assistantCarriedAnswerReadOnly({ original, inspection }, deliveryId, scope), expected);
  for (const alter of [
    ({original}) => { original.items.pop(); },
    ({original}) => { original.items.at(-2).arguments.command = { operation: 'click', args: {} }; },
    ({original}) => { original.items.at(-4).arguments.command.args.url = siteOrigin + '/mail/u/0/#chat/room'; },
    ({original}) => { original.items.at(-3).result.structuredContent.code = 'UNKNOWN_BROWSER_EFFECT'; },
    ({original}) => { original.items.push({ type: 'commandExecution' }); },
    ({original}) => { original.items.push({ ...read, tool: 'complete_assistant_pass' }); },
    ({inspection}) => { inspection.items.push({ ...read, tool: 'prepare_assistant_workspace_run' }); },
    ({inspection}) => { inspection.items[1].arguments.taskPass.passId = randomUUID(); },
  ]){
    const candidate=structuredClone({original,inspection});
    alter(candidate);
    assert.equal(assistantCarriedAnswerReadOnly(candidate,deliveryId,scope),null);
  }
});

test('carried answer history ends at the exact checkpoint source', async () => {
  const { turn: original, scope, deliveryId, expected } = example();
  const threadId = randomUUID(), retirementReceiptId = randomUUID();
  const inspection = { id: randomUUID(), status: 'completed', items: [
    { type: 'userMessage', content: [{ type: 'text', text: assistantDeliveryMarker(retirementReceiptId) + '\ninspection' }] },
    { type: 'mcpToolCall', server: 'trelio-assistant', tool: 'get_task', status: 'completed',
      arguments: { taskPass: scope.taskPass }, result: { structuredContent: { tasks: [] } } },
  ] };
  const unrelated = () => ({ id: randomUUID(), status: 'completed', items: [] });
  const gap = Array.from({ length: 5 }, unrelated);
  const older = Array.from({ length: 70 }, unrelated);
  // The runtime can afford the bounded prefix even when the whole thread is
  // too long. Summary pages carry roots only. Full pages supply native items.
  const read = (history, { sourceTurnId = original.id, reorderFull = false } = {}) => {
    const reads = [];
    const spawnProcess = nativeRpc(({ method, params }) => {
      assert.equal(params.threadId, threadId);
      if (method === 'thread/read') return { result: { thread: { id: threadId, cwd: process.cwd() } } };
      assert.equal(method, 'thread/turns/list');
      assert.equal(params.limit, 5);
      assert.equal(params.sortDirection, 'desc');
      const offset = Number(params.cursor ?? 0);
      reads.push([params.itemsView, offset]);
      const page = history.slice(offset, offset + params.limit);
      const data = params.itemsView === 'summary'
        ? page.map(turn => ({ ...turn, items: turn.items.filter(item => item.type === 'userMessage') }))
        : reorderFull ? page.reverse() : page;
      const nextCursor = offset + params.limit < history.length ? String(offset + params.limit) : null;
      return { result: { data, nextCursor } };
    });
    return readAssistantCodexDelivery(threadId, deliveryId, { executable: process.execPath, environment: {},
      spawnProcess, carriedAnswer: { ...scope, retirementReceiptId, sourceTurnId } }).then(result => ({ result, reads }));
  };
  const history = [inspection, ...gap, original, ...older];
  assert.deepEqual(await read(history), { result: { state: 'carried_answer_read_only', material: expected },
    reads: [['summary', 0], ['full', 0], ['summary', 5], ['full', 5]] });
  for (const malformed of [
    [original, inspection, ...older],
    [inspection, { ...inspection, id: randomUUID() }, original, ...older],
    [inspection, { ...original, id: randomUUID() }, original, ...older],
    [inspection, ...older, original],
  ]) assert.deepEqual((await read(malformed)).result, { state: 'uncertain' });
  assert.deepEqual((await read(history, { sourceTurnId: randomUUID() })).result, { state: 'uncertain' });
  assert.deepEqual((await read(history, { reorderFull: true })).result, { state: 'uncertain' });
});

test('first scheduled file command carries the checkpoint through the signed worker and the read-only inbox', async t => {
  const fs = await import('node:fs/promises'), path = await import('node:path'), os = await import('node:os');
  // The common finish lock resolves the user's bridge directory at import time.
  // A separate process keeps even its synthetic lock inside the disposable home.
  if (!process.env.TRELIO_TEST_SCHEDULED_FILE_HOME) {
    // Keep the Windows profile at a production-like depth. Both Run directories
    // and the SQLite journal add their full managed identity below this home.
    const temporaryBase = process.platform === 'win32' && path.isAbsolute(process.env.RUNNER_TEMP ?? '')
      ? await fs.realpath(process.env.RUNNER_TEMP) : os.tmpdir();
    const home = await fs.realpath(await fs.mkdtemp(path.join(temporaryBase, 'cw-')));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const { execFile } = await import('node:child_process'), { promisify } = await import('node:util');
    const { fileURLToPath } = await import('node:url');
    const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, TRELIO_TEST_SCHEDULED_FILE_HOME: home };
    delete env.NODE_TEST_CONTEXT;
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^first scheduled file command', fileURLToPath(import.meta.url)], { env });
      assert.match(stdout, /scheduled carry checked/);
    } catch (error) {
      // The child writes TAP to stdout. Report a closed error category and
      // test line without echoing its arguments, absolute paths or fixtures.
      const tap = String(error.stdout ?? '').slice(-16000);
      const code = tap.match(/\b(ENAMETOOLONG|ENOENT|EACCES|EPERM|EBUSY|ERR_ASSERTION|ASSISTANT_WORKSPACE_BINDING_CHANGED|ASSISTANT_WORKSPACE_OUTCOME_REVIEW_REQUIRED|ASSISTANT_PRIVATE_UNAVAILABLE|ASSISTANT_CAPABILITY_UNAVAILABLE)\b/u)?.[1];
      const frame = tap.match(/at [^\r\n]*trelio-assistant-checkpoint-material\.test\.mjs:(\d{1,4}):(\d{1,4})/u);
      assert.fail(`Scheduled carry fixture failed (${code ?? 'unclassified'}, test line ${frame ? frame[1] + ':' + frame[2] : 'unknown'})`);
    }
    return;
  }
  const common = await import('../host-runtime/scripts/trelio-workspace.mjs');
  const { createAssistantWorkspaceProfile, assistantTaskStorageDirectory } = await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const { workspaceParallelDirectory } = await import('../host-runtime/scripts/trelio-workspace-directory.mjs');
  const { materializeAssistantWorkspaceFiles } = await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const { createAssistantInbox } = await import('../host-runtime/scripts/trelio-assistant-inbox.mjs');
  const { openAssistantDatabase } = await import('../host-runtime/scripts/trelio-assistant-private.mjs');
  const config = common.resolveWorkspaceBridgeConfigDirectory();
  const identity = { schemaVersion: 1, origin: 'https://assistant.test', assistantId: randomUUID(), deviceId: randomUUID() };
  const taskId = randomUUID(), companyId = randomUUID(), bindingId = randomUUID(), threadId = randomUUID();
  const nativeScope = { assistantUserId: identity.assistantId, deviceId: identity.deviceId, companyId, taskId };
  const workspaceId = randomUUID(), oldRunId = randomUUID(), runIdentity = { workspaceId, runId: randomUUID() };
  const taskRoot = assistantTaskStorageDirectory(config, { ...identity, taskId, companyId });
  const oldRoot = path.join(taskRoot, 'workspaces', workspaceId);
  const newRoot = workspaceParallelDirectory(oldRoot, workspaceId, runIdentity.runId);
  const previous = path.join(oldRoot, 'workspace'), next = path.join(newRoot, 'workspace');
  const relative = `assistants/${identity.assistantId}/WORK.md`, before = 'Accepted work\n', after = 'Verified draft\n';
  const checkpointId = randomUUID(), leaseId = randomUUID(), fencingToken = 2;
  const git = (cwd, ...args) => common.runGit(args, { cwd });
  await common.ensurePrivateDirectory(previous);
  await git(previous, 'init');
  const commit = async () => {
    await git(previous, 'add', '--all');
    await git(previous, '-c', 'user.name=Synthetic', '-c', 'user.email=tests@assistant.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic checkpoint');
    return (await git(previous, 'rev-parse', 'HEAD')).stdout.trim();
  };
  const write = async (directory, value) => {
    const file = path.join(directory, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  };
  // These synthetic Git blobs and the working file deliberately have the same
  // LF bytes even when the runner's system Git enables Windows autocrlf.
  await fs.writeFile(path.join(previous, '.gitattributes'), 'WORK.md text eol=lf\n');
  await write(previous, before);
  const baseHead = await commit();
  await common.ensurePrivateDirectory(newRoot);
  await git(newRoot, 'clone', '--no-hardlinks', previous, next);
  await write(previous, after);
  const draftHead = await commit();
  await write(previous, 'Later unverified change');
  for (const [root, runId, extra] of [
    [oldRoot, oldRunId, { draftHead, materializedHead: draftHead, latestDraftCheckpointId: checkpointId }],
    [newRoot, runIdentity.runId, { materializedHead: baseHead, leaseId, fencingToken }],
  ]) {
    await common.ensurePrivateDirectory(root);
    if (process.platform !== 'win32') await fs.chmod(path.join(root, 'workspace'), 0o700);
    await common.ensurePrivateDirectory(path.join(root, 'workspace'));
    await common.writePrivateJsonFile(path.join(root, '.trelio-run.json'), {
      schemaVersion: 3, scopeType: 'task', company: { id: companyId }, origin: identity.origin, workspaceId, runId,
      workspaceDirectory: path.join(root, 'workspace'), encryption: { enabled: false }, baseHead, ...extra,
    });
  }
  await common.writePrivateJsonFile(path.join(config, 'runs.json'), { roots: [oldRoot, newRoot] });

  // Construct the actual three deliveries through the inbox. The file worker opens
  // this same database independently, read-only, and receives no material in its args.
  const db = await openAssistantDatabase(path.join(config, 'digital-assistants', 'runtime', identity.assistantId, identity.deviceId));
  t.after(() => db.close());
  let clock = Date.now();
  const inbox = createAssistantInbox({ database: db.database, now: () => clock });
  const source = { origin: identity.origin, assistantId: identity.assistantId, companyId,
    provider: 'trelio', accountId: randomUUID(), bindingId: identity.deviceId };
  inbox.register(source);
  inbox.applyTaskState(source, { taskId, state: 'accepted', expectedRevision: 0, authority: { bindingId, revision: 0 } });
  const first = await inbox.claimDelivery({ authorize: async () => true, scheduledTask: { scope: source, taskId } });
  const makePass = deliveryId => ({ schemaVersion: 1, assistantId: identity.assistantId, deviceId: identity.deviceId,
    companyId, taskId, bindingId, bindingRevision: 0, threadId, deliveryId, passId: randomUUID() });
  const retire = (pass, nativeAnswer) => {
    inbox.prepareTaskPass(pass.deliveryId);
    inbox.startDelivery(pass.deliveryId);
    inbox.markDeliveryUncertain(pass.deliveryId);
    clock += 60 * 60000;
    const receipt = { ...pass, state: 'retired', receiptId: randomUUID(), leaseRevision: 1 };
    inbox.recordRetiredTaskWriter(pass, receipt, nativeAnswer);
    inbox.releaseRetiredTaskWriter(pass.deliveryId, receipt);
    return receipt;
  };
  const parent = retire(makePass(first.deliveryId));
  const previousReceiptId = randomUUID(), questionId = randomUUID(), notificationId = randomUUID();
  inbox.commitPage(source, { ...inbox.claimPoll(source), nextCursor: 'next', hasMore: false,
    events: [{ id: notificationId, revision: '1', taskId, wake: true, ownerQuestionId: questionId }] });
  inbox.completeAcknowledgements(source, inbox.claimAcknowledgements(source).token);
  const answer = inbox.claimRetiredAnswer(first.deliveryId, parent.receiptId, {
    workspaceId, acceptedHead: baseHead, pendingOwnerCheck: {
      questionId, priorReceiptId: previousReceiptId, sourceMarkerId: first.deliveryId, sourceTurnId: randomUUID(),
    },
  }, notificationId, { workspaceId, runId: oldRunId, baseHead, anchorHead: baseHead, checkpointId: null });
  const closed = retire(makePass(answer.deliveryId), { writerRetirementReceiptId: parent.receiptId, notificationId });
  const review = { workspaceId, runId: oldRunId, checkpointId, draftHead, dueAt: clock, previousReceiptId,
    sourceMarkerId: answer.deliveryId, sourceTurnId: randomUUID() };
  const job = inbox.claimReconciliation(answer.deliveryId, closed.receiptId, null, null, {
    baseHead, review, path: relative, beforeSha256: digest(before), afterSha256: digest(after),
  });
  inbox.prepareTaskPass(job.deliveryId);
  inbox.startDelivery(job.deliveryId);
  const pass = { ...makePass(job.deliveryId),
    retiredReconcile: { passId: closed.passId, writerRetirementReceiptId: closed.receiptId, expectedLeaseRevision: closed.leaseRevision },
    retiredScheduled: { writerRetirementReceiptId: closed.receiptId, dueAt: clock } };
  const runtimeSessionId = randomUUID(), expiresAt = new Date(Date.now() + 300000).toISOString();
  const { generateKeyPairSync, randomBytes } = await import('node:crypto');
  const device = { assistantId: identity.assistantId, deviceId: identity.deviceId,
    credential: 'tda_' + randomBytes(32).toString('base64url'), expiresAt: 1 };
  const runtime = { schemaVersion: 1, threadId, passId: pass.passId, state: { runtimeSessionId, expiresAt,
    privateKeyPkcs8: generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    observation: { schemaVersion: 1, clientFamily: 'codex', modelId: 'gpt-6.1-sol', effortLevel: 'high',
      evidenceLevel: 'local_observed', source: 'codex_hook' } } };
  const host = { configurationDirectory: config, readIdentity: async () => identity, readActivePass: async () => pass };
  const client = { readTaskPass: async () => ({ ...pass, state: 'leased', leaseExpiresAt: expiresAt }) };
  const store = { get: async ({ kind, id }) => kind === 'runtime' && id === pass.passId ? runtime
    : kind === 'device' && id === identity.assistantId ? device : null };
  const profile = await createAssistantWorkspaceProfile({ identity, host, store, client, workspaceRun: runIdentity,
    lockDirectory: path.join(config, 'locks') });
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    url = new URL(url);
    assert.equal(url.origin, identity.origin);
    assert.equal(options.method ?? 'GET', 'GET');
    assert.equal(options.headers.get('authorization'), 'Bearer ' + device.credential);
    const prefix = '/api/digital-assistants/runtime/workspace';
    if (url.pathname === prefix + '/bridge-routing') {
      assert.equal(url.searchParams.get('workspaceId'), workspaceId);
      return Response.json({ schemaVersion: 1, company: { id: companyId, slug: 'synthetic' }, encryptionState: 'plain' });
    }
    assert.equal(url.pathname, prefix + '/workspaces/' + workspaceId + '/runs/' + runIdentity.runId);
    reads++;
    return Response.json({ run: { id: runIdentity.runId, workspaceId, status: 'running', leaseId,
      leaseExpiresAt: expiresAt, fencingToken } });
  });
  const carry = () => common.withWorkspaceExecutionProfile(profile, () => materializeAssistantWorkspaceFiles({
    result: { structuredContent: { schemaVersion: 1, kind: 'assistant_workspace_files', runIdentity,
      scope: { ...nativeScope, passId: pass.passId }, runtimeSessionId } },
    arguments: { taskPass: { companyId, taskId, passId: pass.passId }, runIdentity, runtimeSessionProof: { runtimeSessionId },
      command: { action: 'carry_forward' } },
  }, { withProfile: action => action({ identity, host, store, prepareWorkspaceRun: profile.prepareWorkspaceRun }) }));
  const result = await carry();
  assert.deepEqual(result.structuredContent, { state: 'carried_forward', sha256: digest(after) });
  assert.ok(reads > 1);
  assert.equal(await fs.readFile(path.join(next, relative), 'utf8'), after);
  assert.equal(await fs.readFile(path.join(previous, relative), 'utf8'), 'Later unverified change');
  assert.equal(inbox.readDelivery(job.deliveryId).state, 'started');
  t.diagnostic('scheduled carry checked');
});
