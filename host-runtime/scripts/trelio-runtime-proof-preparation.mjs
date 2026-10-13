/**
 * Продолжение уже подписанного hook-вызова после долгой локальной подготовки.
 *
 * Индекс здесь только находит private state: сам по себе UUID/индекс не даёт
 * права подписывать. На входе обязательно проверяем свежесть и Ed25519-подпись
 * исходного proof для exact nativeTool. Ключ остаётся внутри этого invocation.
 * Новый timestamp сохраняет исходный nonce, поэтому сервер может принять
 * исходный и обновлённый envelope суммарно только один раз.
 */
import crypto from "node:crypto";
import path from "node:path";
import { ProcessDiagnosticError } from "./trelio-process-diagnostics.mjs";

export const RUNTIME_PROOF_MAX_AGE_MS = 120_000;
const CLOCK_SKEW_MS = 30_000;
const MAX_PREPARATION_MS = 660_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STATE_KEY = /^[a-f0-9]{64}$/u;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const payload = (proof, toolName) => Buffer.from([
  "trelio-runtime-proof-v1", proof.runtimeSessionId, toolName, proof.issuedAt, proof.nonce,
].join("\n"), "utf8");

export class RuntimeProofPreparationError extends Error {
  constructor(reason, expiredCause = null) {
    super(`Trelio runtime proof rejected (${reason}${expiredCause ? `: ${expiredCause}` : ""}).`);
    this.code = "TRELIO_RUNTIME_HOOK_REQUIRED";
    this.reason = reason;
    this.expiredCause = expiredCause;
  }
  toJSON() {
    return { code: this.code, reason: this.reason, message: this.message,
      ...(this.expiredCause ? { expiredCause: this.expiredCause } : {}),
      protectedWorkBlocked: true };
  }
}

export const runtimeProofBindingPath = ({ configDirectory, runtimeSessionId }) => (
  UUID.test(String(runtimeSessionId))
    ? path.join(configDirectory, "runtime-proof-bindings", `${hash(runtimeSessionId.toLowerCase())}.json`)
    : null
);

export const saveRuntimeProofBinding = async ({
  configDirectory, origin, clientSessionId, runtimeSessionId, expiresAt, writePrivateJsonFile,
}) => {
  const file = runtimeProofBindingPath({ configDirectory, runtimeSessionId });
  if (!file || !clientSessionId) throw new RuntimeProofPreparationError("invalid");
  // Only the hook calls this writer. No environment/agent-supplied chat ID
  // participates in the later lookup, and the index contains no signing key.
  await writePrivateJsonFile(file, { schemaVersion: 1, origin: new URL(origin).origin,
    runtimeSessionId, stateKey: hash(`${origin}\n${clientSessionId}`), expiresAt });
};

export const prepareRuntimeProofSubmission = async ({
  origin, nativeTool, proof, configDirectory, readPrivateJsonFile, now = Date.now,
}) => {
  let key = null;
  let closed = false;
  const startedAt = now();
  const original = proof ? { ...proof } : null;
  const readState = async (file, options) => {
    try { return await readPrivateJsonFile(file, options); }
    catch (error) {
      if (error instanceof ProcessDiagnosticError) throw error;
      // Private-file IO is not missing authority and never permits a fresh
      // registration. Keep filesystem paths/native exceptions out of MCP.
      throw new RuntimeProofPreparationError("invalid");
    }
  };
  // Older hooks have no index. Keep their original envelope, including malformed
  // input, for the ordinary backend validator; never fabricate an identity.
  let expiresAt = null;
  if (original?.schemaVersion === 1 && UUID.test(String(original.runtimeSessionId))) {
    const file = runtimeProofBindingPath({ configDirectory, runtimeSessionId: original.runtimeSessionId });
    const binding = await readState(file, { maximumBytes: 2048 });
    if (Object.keys(binding).length) {
      if (binding.schemaVersion !== 1 || binding.origin !== new URL(origin).origin
        || binding.runtimeSessionId !== original.runtimeSessionId || !STATE_KEY.test(binding.stateKey)) {
        throw new RuntimeProofPreparationError("invalid");
      }
      const state = await readState(
        path.join(configDirectory, "runtime-sessions", `${binding.stateKey}.json`),
        { maximumBytes: 64 * 1024 },
      );
      if (state.schemaVersion !== 1 || state.runtimeSessionId !== original.runtimeSessionId
        || state.expiresAt !== binding.expiresAt || typeof state.privateKeyPkcs8 !== "string") {
        throw new RuntimeProofPreparationError("invalid");
      }
      expiresAt = Date.parse(state.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= startedAt) {
        throw new RuntimeProofPreparationError("expired", "runtime_session_expired");
      }
      const issuedAt = Date.parse(original.issuedAt);
      if (!Number.isFinite(issuedAt) || !UUID.test(String(original.nonce))
        || typeof original.signature !== "string" || !/^[A-Za-z0-9_-]{40,160}$/u.test(original.signature)) {
        throw new RuntimeProofPreparationError("invalid");
      }
      if (issuedAt < startedAt - RUNTIME_PROOF_MAX_AGE_MS) {
        throw new RuntimeProofPreparationError("expired", "proof_age");
      }
      if (issuedAt > startedAt + CLOCK_SKEW_MS) {
        throw new RuntimeProofPreparationError("expired", "proof_clock_skew");
      }
      try {
        key = crypto.createPrivateKey({ key: Buffer.from(state.privateKeyPkcs8, "base64url"),
          format: "der", type: "pkcs8" });
        if (key.asymmetricKeyType !== "ed25519" || !crypto.verify(null, payload(original, nativeTool),
          crypto.createPublicKey(key), Buffer.from(original.signature, "base64url"))) {
          throw new Error("invalid signature");
        }
      } catch { throw new RuntimeProofPreparationError("invalid"); }
    }
  }
  return {
    forSubmission() {
      if (closed) throw new RuntimeProofPreparationError("invalid");
      if (!key) return original;
      const timestamp = now();
      if (timestamp >= expiresAt) throw new RuntimeProofPreparationError("expired", "runtime_session_expired");
      if (timestamp - startedAt > MAX_PREPARATION_MS) {
        throw new RuntimeProofPreparationError("expired", "preparation_deadline");
      }
      const renewed = { ...original, issuedAt: new Date(timestamp).toISOString() };
      renewed.signature = crypto.sign(null, payload(renewed, nativeTool), key).toString("base64url");
      return renewed;
    },
    close() { closed = true; key = null; },
  };
};

/** Only a server-confirmed rejection before handler execution allows one retry. */
export const isProofAgeRejectedBeforeDispatch = result => (
  result?.isError === true
  && result.structuredContent?.code === "TRELIO_RUNTIME_HOOK_REQUIRED"
  && result.structuredContent?.reason === "expired"
  && result.structuredContent?.expiredCause === "proof_age"
  && result.structuredContent?.beforeDispatch === true
);

export const submitPreparedRuntimeProof = async ({ preparation, submit }) => {
  const result = await submit(preparation.forSubmission());
  if (!isProofAgeRejectedBeforeDispatch(result)) return result;
  // Same prepared arguments/nonce; no mirror rebuild, ciphertext re-upload,
  // credential recovery or retry of an ambiguous transport/mutation result.
  return submit(preparation.forSubmission());
};
