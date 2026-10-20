/** Model-visible setup composes the existing protected S256/device client.
 * Only structural receipts leave this boundary; raw verifier/credential stays
 * inside the common OS-backed store and fixed HTTPS transport. */
import { createAssistantPairingClient, createAssistantDeviceClient } from './trelio-assistant-transport.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export class AssistantSetupError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new AssistantSetupError(code); };
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('ASSISTANT_SETUP_INVALID_INPUT'); return value.toLowerCase(); };
export const createAssistantSetup = ({ origin, store, http, now = Date.now }) => {
  const pairing = createAssistantPairingClient({ origin, store, http, now });
  const key = enrollmentId => ({ origin, kind: 'pairing', id: id(enrollmentId) });
  const paired = async record => {
    if (record.origin !== origin) fail('ASSISTANT_SETUP_RECOVERY_REQUIRED');
    const assistantId = id(record.assistantId), deviceId = id(record.deviceId);
    const client = createAssistantDeviceClient({ origin, assistantId, deviceId, store, http });
    // A completed pairing receipt is not an offline grant. It must still
    // survive live expiry, revocation and owner checks before reporting contact.
    await client.heartbeat();
    return { state: 'paired', assistantId, deviceId, businessReady: false,
      requiredCapabilities: ['task_pass_admission', 'background_service'] };
  };
  const status = async enrollmentId => {
    const record = await store.get(key(enrollmentId));
    if (!record) return { state: 'not_started' };
    if (record.phase === 'complete') return paired(record);
    if (record.phase === 'exchanging') return { state: 'recovery_required' };
    if (record.phase === 'prepared') return { state: 'prepared' };
    if (record.phase !== 'pending' || !Number.isSafeInteger(record.expiresAt)
      || !/^[A-F0-9]{8}$/u.test(record.verificationCode ?? '')) fail('ASSISTANT_SETUP_RECOVERY_REQUIRED');
    return { state: record.expiresAt <= now() ? 'expired' : 'waiting_owner',
      verificationCode: record.verificationCode, expiresAt: record.expiresAt };
  };
  return {
    status,
    async begin(enrollmentId, deviceName) {
      id(enrollmentId);
      const record = await store.get(key(enrollmentId));
      if (record?.phase === 'complete') return paired(record);
      const result = await pairing.begin(enrollmentId, deviceName);
      return { state: 'waiting_owner', verificationCode: result.verificationCode, expiresAt: result.expiresAt };
    },
    async finish(enrollmentId) {
      const record = await store.get(key(enrollmentId));
      if (record?.phase === 'complete') return paired(record);
      const result = await pairing.exchange(enrollmentId);
      if (result.state === 'pending') return { state: 'waiting_owner' };
      return paired({ phase: 'complete', ...result });
    },
  };
};
