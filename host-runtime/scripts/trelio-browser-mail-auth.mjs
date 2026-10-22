import { randomUUID } from 'node:crypto';

export const BROWSER_MAIL_AUTH_API = 'trelio.protected-browser-mail-auth/v1';
export const BROWSER_MAIL_REQUEST_KIND = 'trelio.browser-mail-request/v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digest = /^[0-9a-f]{64}$/u;
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(v, k));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const text = (v, max = 240) => typeof v === 'string' && v.trim().length > 0
  && v.length <= max && !/[\x00-\x1f\x7f]/u.test(v);

/** Only the signed browser provider declares the mail matcher. It is literal,
 * bounded data, not caller regex, arbitrary mail search or code from a page.
 * Sender/subject/body anchors must be verified by that provider before release.
 * The recipient comes from the explicitly selected mailbox's native identity.
 */
export function normalizeBrowserMailSpec(value) {
  if (!exact(value, ['skillId', 'sender', 'subjectIncludes', 'bodyIncludes', 'digits'])
    || !text(value.skillId, 120) || !/^[a-z0-9][a-z0-9-]{0,119}$/u.test(value.skillId)
    || !text(value.sender) || !/^[^\s<>@"\\]+@[^\s<>@"\\]+\.[^\s<>@"\\]+$/u.test(value.sender)
    || !text(value.subjectIncludes) || !text(value.bodyIncludes)
    || ![6, 8].includes(value.digits)) fail('authentication_mail_invalid');
  return { ...value, sender: value.sender.toLowerCase() };
}

export function parseBrowserMailHandle(value) {
  if (typeof value !== 'string' || value.length !== 101 || !/^[0-9a-f]{64}\.[0-9a-f-]{36}$/u.test(value)) fail('authentication_mail_invalid');
  const [scope, requestId] = value.split('.');
  if (!uuid.test(requestId)) fail('authentication_mail_invalid');
  return { scope, requestId };
}

/** Metadata-only identity supplied by the normal signed skill/account engine.
 * A request handle is a locator, never admission. The mail worker must match
 * the exact company/member, provider and explicitly selected account too.
 */
export function browserMailActor(env = process.env) {
  let account;
  try { account = JSON.parse(env.TRELIO_SKILL_ACCOUNT_JSON || 'null'); } catch { fail('authentication_mail_scope'); }
  const value = { origin: new URL(env.TRELIO_ORIGIN || 'https://trelio.ru').origin,
    skillId: env.TRELIO_SKILL_ID, accountId: account?.id,
    companyId: env.TRELIO_SKILL_COMPANY_ID, memberId: env.TRELIO_SKILL_MEMBER_ID };
  if (!value.origin.startsWith('https://') || !text(value.skillId, 120) || !uuid.test(value.accountId)
    || !uuid.test(value.companyId) || !uuid.test(value.memberId)
    || !digest.test(account?.companyBinding || '')) fail('authentication_mail_scope');
  return value;
}

export function validateBrowserMailReference(value) {
  if (!exact(value, ['scope', 'uidValidity', 'uid', 'revision', 'originalSha256'])
    || !digest.test(value.scope) || !digest.test(value.revision) || !digest.test(value.originalSha256)
    || !Number.isSafeInteger(value.uidValidity) || value.uidValidity < 1 || value.uidValidity > 0xffffffff
    || !Number.isSafeInteger(value.uid) || value.uid < 1 || value.uid > 0xffffffff) fail('authentication_mail_invalid');
  return { scope: value.scope, uidValidity: value.uidValidity, uid: value.uid,
    revision: value.revision, originalSha256: value.originalSha256 };
}

export function validateBrowserMailJournal(value) {
  if (!exact(value, ['requestId', 'requestedAt', 'expiresAt', 'mailAccountId', 'state', 'acknowledgement', 'reference', 'baseline'])
    || !uuid.test(value.requestId) || !uuid.test(value.mailAccountId)
    || !Number.isSafeInteger(value.requestedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= value.requestedAt || value.expiresAt - value.requestedAt > 120000
    || !['waiting', 'armed', 'code_received', 'authenticated', 'failed'].includes(value.state)
    || !['none', 'pending', 'complete', 'unknown'].includes(value.acknowledgement)) fail('authentication_mail_invalid');
  if (value.reference !== null) validateBrowserMailReference(value.reference);
  if (value.baseline !== null) validateBrowserMailBaseline(value.baseline);
  if (['armed', 'code_received', 'authenticated'].includes(value.state) && value.baseline === null) fail('authentication_mail_invalid');
  if (['code_received', 'authenticated'].includes(value.state) && value.reference === null) fail('authentication_mail_invalid');
  return value;
}

export function validateBrowserMailBaseline(value) {
  if (!exact(value, ['scope', 'uidValidity', 'lastUid']) || !digest.test(value.scope)
    || !Number.isSafeInteger(value.uidValidity) || value.uidValidity < 1 || value.uidValidity > 0xffffffff
    || !Number.isSafeInteger(value.lastUid) || value.lastUid < 0 || value.lastUid > 0xffffffff) fail('authentication_mail_invalid');
  return { scope: value.scope, uidValidity: value.uidValidity, lastUid: value.lastUid };
}

/** One pending authentication, owned by the SAME browser worker and encrypted
 * credential attempt. This is not a second vault, queue or credential service.
 * The caller persists journal through its existing store before every dispatch.
 * Code bytes live only in RAM/private delivery; journal stores structural refs.
 * Process loss therefore leaves the original attempt fenced, never resumable
 * by another code submission or a fresh CLI invocation.
 */
export class ProtectedBrowserMailAttempt {
  #resolveCode; #rejectCode; #resolveReady; #rejectReady; #resolveOutcome; #timer; #finished = false;
  constructor({ scope, identity, mailAccountId, spec, journal, persist, active,
    now = Date.now, expiresAt, requestedAt, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.spec = normalizeBrowserMailSpec(spec);
    if (!digest.test(scope) || !text(identity?.origin) || !identity.origin.startsWith('https://')
      || !uuid.test(identity?.companyId) || !uuid.test(identity?.memberId)
      || !uuid.test(mailAccountId) || !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(requestedAt)
      || expiresAt <= now() || expiresAt - requestedAt > 120000 || requestedAt > now() + 5000
      || typeof persist !== 'function' || typeof active !== 'function' || !journal
      || Object.keys(journal).length) fail('authentication_mail_invalid');
    this.scope = scope; this.identity = { ...identity }; this.mailAccountId = mailAccountId;
    this.journal = journal; this.persist = persist; this.active = active; this.now = now;
    this.clearTimer = clearTimer;
    Object.assign(journal, { requestId: randomUUID(), requestedAt, expiresAt,
      mailAccountId, state: 'waiting', acknowledgement: 'none', reference: null, baseline: null });
    this.handle = `${scope}.${journal.requestId}`;
    this.code = new Promise((resolve, reject) => { this.#resolveCode = resolve; this.#rejectCode = reject; });
    // A failure can precede the authenticator awaiting code. Attach a handler
    // without converting the original rejected promise into successful input.
    this.code.catch(() => {});
    this.ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    this.ready.catch(() => {});
    this.outcome = new Promise(resolve => { this.#resolveOutcome = resolve; });
    this.#timer = setTimer(() => { this.cancel('authentication_mail_expired'); }, expiresAt - now());
    this.#timer?.unref?.();
  }
  async start() { this.active(); await this.persist(); return this.publicStatus(); }
  #authorize(actor, handle, { allowExpired = false } = {}) {
    if (!exact(actor, ['origin', 'skillId', 'accountId', 'companyId', 'memberId'])
      || actor.origin !== this.identity.origin
      || actor.skillId !== this.spec.skillId || actor.accountId !== this.mailAccountId
      || actor.companyId !== this.identity.companyId || actor.memberId !== this.identity.memberId
      || handle !== this.handle) fail('authentication_mail_scope');
    this.active();
    if (!allowExpired && this.now() >= this.journal.expiresAt) fail('authentication_mail_expired');
  }
  publicStatus() {
    // No sender/recipient, message body, code, reference or worker bearer token
    // crosses the ordinary MCP boundary. The handle is useless without actor
    // admission and the current private browser owner.
    return { kind: BROWSER_MAIL_REQUEST_KIND, state: this.#finished ? 'finished' : 'waiting',
      handle: this.handle, expiresAt: this.journal.expiresAt,
      authenticated: this.journal.state === 'authenticated', acknowledgement: this.journal.acknowledgement };
  }
  prepare(actor, handle) {
    this.#authorize(actor, handle);
    if (this.journal.state !== 'waiting') fail('authentication_mail_consumed');
    return { api: BROWSER_MAIL_AUTH_API, ...this.spec,
      requestedAt: this.journal.requestedAt, expiresAt: this.journal.expiresAt };
  }
  status(actor, handle) {
    this.#authorize(actor, handle, { allowExpired: true });
    return { authenticated: this.journal.state === 'authenticated',
      state: this.journal.state, finished: this.#finished, acknowledgement: this.journal.acknowledgement,
      reference: this.journal.reference ? { ...this.journal.reference } : null,
      baseline: this.journal.baseline ? { ...this.journal.baseline } : null,
      request: { api: BROWSER_MAIL_AUTH_API, ...this.spec,
        requestedAt: this.journal.requestedAt, expiresAt: this.journal.expiresAt } };
  }
  async begin(actor, handle, baseline) {
    this.#authorize(actor, handle);
    if (this.journal.state !== 'waiting') fail('authentication_mail_consumed');
    // Record UIDNEXT-1 BEFORE allowing any password/email-method click that
    // could send a code. A recent but pre-existing message can never qualify.
    this.journal.baseline = validateBrowserMailBaseline(baseline);
    this.journal.state = 'armed';
    await this.persist(); this.active(); this.#resolveReady();
    return { armed: true };
  }
  async deliver(actor, handle, { code, reference }) {
    this.#authorize(actor, handle);
    if (this.journal.state !== 'armed' || typeof code !== 'string'
      || !new RegExp(`^[0-9]{${this.spec.digits}}$`, 'u').test(code)) fail('authentication_mail_consumed');
    // Consume synchronously before the first await, so concurrent deliveries
    // cannot both reach the provider. Persist exact source identity BEFORE
    // releasing the code to the existing fenced fill/submit path.
    const ref = validateBrowserMailReference(reference), base = this.journal.baseline;
    if (!base || ref.scope !== base.scope || ref.uidValidity !== base.uidValidity || ref.uid <= base.lastUid) fail('authentication_mail_invalid');
    this.journal.reference = ref;
    this.journal.state = 'code_received';
    try { await this.persist(); this.active(); this.#resolveCode(code); }
    catch (error) { this.cancel('authentication_mail_unknown'); throw error; }
    finally { code = ''; }
    return this.outcome;
  }
  async finish(authenticated) {
    if (this.#finished) return;
    this.#finished = true; this.clearTimer(this.#timer);
    // Only the browser's positive signed success selector can call true.
    // Code extraction, a submitted form or saved credentials do not suffice.
    this.journal.state = authenticated && this.journal.state === 'code_received' ? 'authenticated' : 'failed';
    try { await this.persist(); }
    catch (error) {
      this.journal.state = 'failed';
      throw error;
    } finally {
      this.#rejectCode(Object.assign(new Error('authentication_mail_finished'), { code: 'authentication_mail_finished' }));
      this.#rejectReady(Object.assign(new Error('authentication_mail_finished'), { code: 'authentication_mail_finished' }));
      this.#resolveOutcome({ authenticated: this.journal.state === 'authenticated', acknowledgement: this.journal.acknowledgement });
    }
  }
  cancel(code = 'authentication_mail_cancelled') {
    if (this.#finished) return;
    this.#finished = true; this.clearTimer(this.#timer);
    // The parent authenticator retains its persisted pending fence. No input
    // is replayed and no mailbox flag is changed on cancellation or expiry.
    this.#rejectCode(Object.assign(new Error(code), { code }));
    this.#rejectReady(Object.assign(new Error(code), { code }));
    this.#resolveOutcome({ authenticated: false, acknowledgement: 'none' });
  }
  async claimAcknowledgement(actor, handle, reference) {
    this.#authorize(actor, handle, { allowExpired: true });
    const ref = validateBrowserMailReference(reference);
    if (this.journal.state !== 'authenticated' || JSON.stringify(ref) !== JSON.stringify(this.journal.reference)) fail('authentication_mail_not_verified');
    if (this.journal.acknowledgement === 'complete') return { action: 'none' };
    // A pending/unknown marker never grants another STORE, even after a
    // lost process response. The mail provider may only read back exact flags.
    if (this.journal.acknowledgement !== 'none') return { action: 'verify_only' };
    if (this.now() >= this.journal.expiresAt) fail('authentication_mail_expired');
    this.journal.acknowledgement = 'pending';
    await this.persist(); this.active();
    return { action: 'mark_seen_once' };
  }
  async recordAcknowledgement(actor, handle, { seenVerified, writeAttempted }) {
    this.#authorize(actor, handle, { allowExpired: true });
    if (this.journal.state !== 'authenticated' || this.journal.acknowledgement === 'none'
      || typeof seenVerified !== 'boolean' || typeof writeAttempted !== 'boolean') fail('authentication_mail_not_verified');
    this.journal.acknowledgement = seenVerified ? 'complete' : 'unknown';
    await this.persist();
    return { authenticated: true, acknowledgement: this.journal.acknowledgement };
  }
}
