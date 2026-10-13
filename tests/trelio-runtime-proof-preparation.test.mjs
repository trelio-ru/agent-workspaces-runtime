import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";
import { buildRuntimeSessionProof } from "../host-runtime/scripts/trelio-runtime-session.mjs";
import { prepareRuntimeProofSubmission, saveRuntimeProofBinding,
  submitPreparedRuntimeProof } from "../host-runtime/scripts/trelio-runtime-proof-preparation.mjs";

const fixture = async (overrides = {}) => {
  let clock = Date.parse("2026-10-13T09:18:29.000Z");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const origin = "https://proof-tests.invalid";
  const nativeTool = "update_task_control";
  const configDirectory = path.resolve("/fixture-private");
  const state = { schemaVersion: 1, runtimeSessionId: crypto.randomUUID(),
    expiresAt: new Date(clock + 24 * 60 * 60 * 1000).toISOString(),
    privateKeyPkcs8: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url") };
  const files = new Map();
  const clientSessionId = crypto.randomUUID();
  await saveRuntimeProofBinding({ configDirectory, origin, clientSessionId,
    runtimeSessionId: state.runtimeSessionId, expiresAt: state.expiresAt,
    writePrivateJsonFile: async (file, value) => files.set(file, value) });
  const stateKey = crypto.createHash("sha256").update(`${origin}\n${clientSessionId}`).digest("hex");
  files.set(path.join(configDirectory, "runtime-sessions", `${stateKey}.json`), state);
  const proof = buildRuntimeSessionProof({ state, toolName: nativeTool, now: new Date(clock) });
  const create = input => prepareRuntimeProofSubmission({ origin, nativeTool, proof,
    configDirectory, readPrivateJsonFile: async file => files.get(file) ?? {},
    now: () => clock, ...overrides, ...input });
  const payload = p => Buffer.from(["trelio-runtime-proof-v1", p.runtimeSessionId,
    nativeTool, p.issuedAt, p.nonce].join("\n"));
  return { create, proof, state, files, advance: ms => { clock += ms; },
    age: p => clock - Date.parse(p.issuedAt),
    verify: p => crypto.verify(null, payload(p), publicKey, Buffer.from(p.signature, "base64url")) };
};

test("four-minute preparation renews the same one-use proof without extending its 120s TTL", async () => {
  const f = await fixture();
  const preparation = await f.create();
  f.advance(245_000);
  assert.equal(f.age(f.proof), 245_000);
  let actions = 0;
  const consumed = new Set();
  const submit = async proof => {
    assert.ok(f.age(proof) <= 120_000, "ordinary server freshness gate remains unchanged");
    assert.ok(f.verify(proof));
    assert.equal(proof.runtimeSessionId, f.proof.runtimeSessionId);
    assert.equal(proof.nonce, f.proof.nonce);
    assert.ok(!consumed.has(proof.nonce), "all envelopes consume the same server nonce");
    consumed.add(proof.nonce); actions += 1;
    return { structuredContent: { updated: true } };
  };
  assert.deepEqual(await submitPreparedRuntimeProof({ preparation, submit }),
    { structuredContent: { updated: true } });
  assert.equal(actions, 1);
  assert.equal(f.state.expiresAt, new Date(Date.parse(f.proof.issuedAt) + 86_400_000).toISOString());
  preparation.close();
  assert.throws(() => preparation.forSubmission(), /invalid/);
});

test("only a timestamp rejection before dispatch receives one automatic fresh-proof retry", async () => {
  const f = await fixture(); const preparation = await f.create();
  const proofs = [];
  const result = await submitPreparedRuntimeProof({ preparation, submit: async proof => {
    proofs.push(proof); f.advance(121_000);
    return proofs.length === 1 ? { isError: true, structuredContent: {
      code: "TRELIO_RUNTIME_HOOK_REQUIRED", reason: "expired", expiredCause: "proof_age", beforeDispatch: true,
    } } : { structuredContent: { updated: true } };
  } });
  assert.equal(result.structuredContent.updated, true);
  assert.equal(proofs.length, 2);
  assert.equal(proofs[0].nonce, proofs[1].nonce);
  assert.notEqual(proofs[0].issuedAt, proofs[1].issuedAt);
  assert.ok(proofs.every(f.verify));
  preparation.close();
});

test("session/replay/unknown errors and ambiguous mutations are never replayed", async () => {
  for (const change of [
    { expiredCause: "runtime_session_expired" }, { expiredCause: "bridge_session_revoked" },
    { expiredCause: "source_grant_expired" }, { reason: "replayed" }, { reason: "invalid" },
    { beforeDispatch: false }, { beforeDispatch: undefined }, { expiredCause: undefined },
  ]) {
    const f = await fixture(); const preparation = await f.create(); let calls = 0;
    const error = { isError: true, structuredContent: {
      code: "TRELIO_RUNTIME_HOOK_REQUIRED", reason: "expired", expiredCause: "proof_age", beforeDispatch: true,
      ...change } };
    assert.equal(await submitPreparedRuntimeProof({ preparation, submit: async () => { calls++; return error; } }), error);
    assert.equal(calls, 1); preparation.close();
  }
  const f = await fixture(); const preparation = await f.create(); let calls = 0;
  await assert.rejects(submitPreparedRuntimeProof({ preparation, submit: async () => {
    calls++; throw new Error("lost mutation response");
  } }), /lost mutation response/);
  assert.equal(calls, 1); preparation.close();
});

test("stale/forged/wrong-tool input cannot obtain a new signature", async () => {
  const f = await fixture();
  await assert.rejects(f.create({ nativeTool: "clear_task_control" }), e => e.reason === "invalid");
  await assert.rejects(f.create({ proof: { ...f.proof, signature: "A".repeat(86) } }), e => e.reason === "invalid");
  f.advance(120_001);
  await assert.rejects(f.create(), e => e.reason === "expired" && e.expiredCause === "proof_age");
});

test("session expiry during preparation stays terminal and is diagnosed separately", async () => {
  const f = await fixture(); f.state.expiresAt = new Date(Date.parse(f.proof.issuedAt) + 200_000).toISOString();
  for (const [file, value] of f.files) if (file.includes("runtime-proof-bindings")) value.expiresAt = f.state.expiresAt;
  const preparation = await f.create(); f.advance(245_000);
  assert.throws(() => preparation.forSubmission(), e => e.reason === "expired"
    && e.expiredCause === "runtime_session_expired" && !JSON.stringify(e.toJSON()).includes(f.proof.nonce));
  preparation.close();
});

test("legacy/no-proof calls gain no signing authority", async () => {
  const f = await fixture(); f.files.clear();
  const legacy = await f.create(); f.advance(245_000);
  assert.deepEqual(legacy.forSubmission(), f.proof); legacy.close();
  const oauth = await f.create({ proof: null }); assert.equal(oauth.forSubmission(), null); oauth.close();
});
