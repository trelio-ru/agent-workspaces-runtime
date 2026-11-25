import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAssistantDeviceClient, createAssistantHttp } from '../host-runtime/scripts/trelio-assistant-transport.mjs';

function setup() {
  const id = randomUUID;
  const origin = 'https://assistant.test', assistantId = id(), deviceId = id();
  const companyId = id(), taskId = id(), bindingId = id(), threadId = id();
  const old = { companyId, taskId, passId: id() };
  const current = { companyId, taskId, passId: id() };
  const binding = { bindingId, bindingRevision: 4, threadId, deliveryId: id() };
  const previousBinding = { ...binding, deliveryId: id() };
  const retirement = { schemaVersion: 1, state: 'retired', receiptId: id(), assistantId, deviceId,
    ...old, ...previousBinding, leaseRevision: 2 };
  const review = { workspaceId: id(), runId: id(), checkpointId: id(), draftHead: 'a'.repeat(40),
    sourceMarkerId: previousBinding.deliveryId, sourceTurnId: id(), previousReceiptId: id(), dueAt: 1700000000000 };
  const retiredReconcile = { passId: old.passId, writerRetirementReceiptId: retirement.receiptId, expectedLeaseRevision: 2 };
  const retiredScheduled = { writerRetirementReceiptId: retirement.receiptId, dueAt: review.dueAt };
  const links = { retiredReconcile, retiredScheduled };
  const begin = { companyId, taskId, ...binding, retiredScheduled: { ...retiredReconcile, review } };
  const observedAt = new Date().toISOString();
  const observation = { schemaVersion: 1, clientFamily: 'codex', modelId: 'gpt-6.1-sol', effortLevel: 'high',
    evidenceLevel: 'local_observed', source: 'codex_hook', observedAt };
  const register = { ...current, ...links, clientSessionId: threadId, observation, publicKeySpki: 'k'.repeat(60) };
  const response = { ...binding, passId: current.passId, ...links, leaseRevision: 0, leaseExpiresAt: observedAt,
    workMode: 'task', state: 'leased', execution: { modelId: observation.modelId, effortLevel: 'high', revision: 1 } };
  const registration = { schemaVersion: 1, passId: current.passId, runtimeSessionId: id(), ...links, expiresAt: observedAt,
    conversation: { provider: 'codex', openProtocol: 'codex-thread-v1', conversationId: threadId }, observation, runtimeRefreshSupported: true };
  const store = { async get() { return { assistantId, deviceId, credential: 'tda_' + 'x'.repeat(43), expiresAt: 1 }; } };
  const requests = [];
  let reply;
  const http = createAssistantHttp({ origin, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'POST');
    requests.push({ url, body: JSON.parse(options.body) });
    return Response.json(reply);
  } });
  const client = createAssistantDeviceClient({ origin, assistantId, deviceId, store, http });
  const exchange = (path, body, value) => {
    reply = value;
    const count = requests.length;
    return () => assert.deepEqual(requests.slice(count), [{ url: origin + '/api/digital-assistants/runtime/' + path, body }]);
  };
  return { client, old, current, binding, previousBinding, retirement, review, links, begin, register, response, registration,
    exchange, requests, setReply(value) { reply = value; } };
}

test('closed owner pass review uses its exact original receipt and a separate due-slot witness', async () => {
  const f = setup();
  const request = { ...f.old, ...f.previousBinding, expectedLeaseRevision: 2, writerRetirement: f.retirement, scheduled: f.review };
  const selection = { expectedLeaseRevision: 2, writerRetirementReceiptId: f.retirement.receiptId, scheduled: f.review };
  const projection = { passId: f.old.passId, ...f.previousBinding, state: 'closed', workMode: 'task', businessReady: false, leaseRevision: 2 };
  const context = { schemaVersion: 1, materialBasis: null, draftEvidence: null, operations: { coverage: 'partial', receipts: [], hasMore: false } };
  const eligible = { eligible: true, baseHead: 'b'.repeat(40) };
  for (const scheduled of [eligible, { ...eligible, previousReceiptId: randomUUID() }, null]) {
    const check = f.exchange('task-pass/read', { ...f.old, recoveryContext: selection }, { ...projection, recoveryContext: { ...context, scheduled } });
    assert.deepEqual((await f.client.readTaskRecoveryContext(request)).scheduled, scheduled);
    check();
  }
  for (const scheduled of [undefined, { eligible: true }, { ...eligible, dueAt: 1 }, { ...eligible, baseHead: 'not-a-head' }]) {
    f.setReply({ ...projection, recoveryContext: { ...context, scheduled } });
    await assert.rejects(f.client.readTaskRecoveryContext(request), /INVALID_RESPONSE/);
  }
  const calls = f.requests.length;
  for (const foreign of [{ scheduled: { ...f.review, sourceMarkerId: randomUUID() } }, { reconcile: true }, { notificationId: randomUUID() }]) {
    await assert.rejects(f.client.readTaskRecoveryContext({ ...request, ...foreign }));
  }
  assert.equal(f.requests.length, calls);
});

test('scheduled begin, read, renewal and runtime registration preserve both selectors across JSON', async () => {
  const f = setup();
  const renew = { ...f.current, clientRequestId: randomUUID(), expectedLeaseRevision: 0 };
  const received = value => {
    assert.deepEqual(value.retiredReconcile, f.links.retiredReconcile);
    assert.deepEqual(value.retiredScheduled, f.links.retiredScheduled);
    assert.equal(Object.hasOwn(value, 'notificationId'), false);
  };
  for (const startState of ['created', 'observe']) {
    const check = f.exchange('task-pass/begin', f.begin, { ...f.response, startState });
    received(await f.client.beginTaskPass(f.begin)); check();
  }
  let check = f.exchange('task-pass/read', f.current, f.response);
  received(await f.client.readTaskPass(f.current)); check();
  check = f.exchange('task-pass/renew', renew, { ...f.response, leaseRevision: 1 });
  received(await f.client.renewTaskPass(renew)); check();
  check = f.exchange('session/register', f.register, f.registration);
  received(await f.client.registerRuntime(f.register)); check();

  // A locator-only read can return a pre-existing reconciliation without a
  // due slot. The worker separately compares the resulting pair to its own
  // retained pass. Begin/registration already know both expected selectors.
  for (const change of [{ retiredScheduled: undefined }, { retiredReconcile: undefined },
    { retiredReconcile: { ...f.links.retiredReconcile, passId: randomUUID() } },
    { retiredScheduled: { ...f.links.retiredScheduled, dueAt: f.review.dueAt + 1 } },
    { retiredScheduled: { ...f.links.retiredScheduled, writerRetirementReceiptId: randomUUID() } },
    { notificationId: randomUUID() }]) {
    f.setReply({ ...f.response, startState: 'created', ...change });
    await assert.rejects(f.client.beginTaskPass(f.begin), /INVALID_RESPONSE/);
    f.setReply({ ...f.registration, ...change });
    await assert.rejects(f.client.registerRuntime(f.register), /INVALID_RESPONSE/);
  }
  for (const change of [{ retiredReconcile: undefined }, { notificationId: randomUUID() },
    { retiredScheduled: { ...f.links.retiredScheduled, writerRetirementReceiptId: randomUUID() } }]) {
    f.setReply({ ...f.response, ...change });
    await assert.rejects(f.client.readTaskPass(f.current), /INVALID_RESPONSE/);
    f.setReply({ ...f.response, ...change, leaseRevision: 1 });
    await assert.rejects(f.client.renewTaskPass(renew), /INVALID_RESPONSE/);
  }
});

test('ordinary reconciliation keeps its existing request and response without a calendar slot', async () => {
  const f = setup();
  const { retiredScheduled, ...ordinaryResponse } = f.response;
  const ordinaryBegin = { companyId: f.current.companyId, taskId: f.current.taskId, ...f.binding, retiredReconcile: f.links.retiredReconcile };
  const check = f.exchange('task-pass/begin', ordinaryBegin, { ...ordinaryResponse, startState: 'created' });
  const result = await f.client.beginTaskPass(ordinaryBegin);
  assert.deepEqual(result.retiredReconcile, f.links.retiredReconcile);
  assert.equal(Object.hasOwn(result, 'retiredScheduled'), false);
  check();
});
