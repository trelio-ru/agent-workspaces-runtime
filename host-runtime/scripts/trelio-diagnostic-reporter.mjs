import contract from "./trelio-agent-diagnostics-contract.json" with { type: "json" };
import { readExistingBridgeSessionToken } from "./trelio-workspace.mjs";
import { buildDiagnosticObservation, observationCode, observationCount } from "./trelio-diagnostic-observation.mjs";
import { readDiagnosticJournal, acknowledgeDiagnosticJournal, writeDiagnosticJournal } from "./trelio-diagnostic-journal.mjs";

class DeliveryError extends Error {
  constructor(reason, retryable = false) { super(reason); this.reason = reason; this.retryable = retryable; }
}
const discardBody = async response => { await response.body?.cancel(); };
// Compatibility lifecycle: diagnostics-v2-loss-catalog in Trelio's legacy registry.
// Original v2 servers did not advertise loss reasons. This fixed baseline
// keeps additive observation signals from rejecting an otherwise valid batch.
const LEGACY_LOSS_REASONS = ["queue_overflow", "delivery_timeout", "delivery_transport", "delivery_rejected",
  "credential_unavailable", "shutdown", "journal_full", "journal_invalid", "journal_expired", "catalog_mismatch", "unknown_code"];
export const createObservationTransport = ({ fetchImpl = fetch, readToken = readExistingBridgeSessionToken } = {}) => {
  let capabilities;
  return async (origin, samples, { signal, context = {} } = {}) => {
    // One credential read for this immutable batch, including network retries.
    // It shares cancellation with its invocation-local Windows worker. A read
    // error is terminal for telemetry; it never initiates OAuth or pairing.
    signal?.throwIfAborted();
    context.token ??= readToken(origin, { signal });
    let token;
    try { token = await context.token; } catch { throw new DeliveryError("credential_unavailable"); }
    signal?.throwIfAborted();
    if (!token) throw new DeliveryError("credential_unavailable");
    const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
    if (capabilities?.expires <= Date.now()) capabilities = undefined;
    if (!capabilities) {
      const response = await fetchImpl(new URL("/api/agent-workspaces/diagnostics/capabilities", origin), {
        method: "GET", headers, redirect: "error", signal,
      });
      if (response.status === 404 || response.status === 405) {
        await discardBody(response); capabilities = { version: 1, expires: Date.now() + 60000 };
      } else if (response.status === 200) {
        // Bound decoding before JSON parsing. A proxy/provider response is not
        // a source of new codes: only the intersection of two closed catalogs.
        const reader = response.body?.getReader();
        if (!reader) throw new DeliveryError("delivery_rejected");
        const chunks = []; let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            length += value.length;
            if (length > 65536) throw new DeliveryError("delivery_rejected");
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel().catch(() => {}); }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new DeliveryError("delivery_rejected"); }
        if (data.schemaVersion !== 2 || !Array.isArray(data.errorCodes) || data.errorCodes.length > 2000
          || !data.errorCodes.includes("DIAGNOSTICS_CODE_UNSUPPORTED")) throw new DeliveryError("delivery_rejected");
        if (data.lossReasons !== undefined && (!Array.isArray(data.lossReasons) || data.lossReasons.length > 256)) {
          throw new DeliveryError("delivery_rejected");
        }
        capabilities = { version: 2, codes: new Set(data.errorCodes.filter(code => contract.errorCodes.includes(code))),
          losses: new Set((data.lossReasons ?? LEGACY_LOSS_REASONS).filter(reason => contract.lossReasons.includes(reason))),
          expires: Date.now() + 300000 };
      } else {
        await discardBody(response);
        throw new DeliveryError("delivery_rejected", response.status >= 500);
      }
    }
    const selected = capabilities;
    let payload, endpoint;
    if (selected.version === 1) {
      // An explicitly old server gets only the permanent v1 UNKNOWN code.
      // Never post a new code blindly and lose unrelated events in its batch.
      const events = samples.map(sample => ({ id: sample.id, tool: contract.localTools.includes(sample.tool) ? sample.tool : "unknown",
        operation: contract.operations.includes(sample.operation) ? sample.operation : "unknown", code: "UNKNOWN",
        pluginVersion: sample.pluginVersion, runtimeVersion: sample.runtimeVersion,
        count: sample.outcomes.filter(row => !["OK", "ROUTED"].includes(row.code)).reduce((sum, row) => sum + row.count, 0),
      })).filter(event => event.count > 0);
      if (!events.length) return { legacy: true };
      payload = { schemaVersion: 1, events }; endpoint = "errors";
    } else {
      payload = { schemaVersion: 2, samples: samples.map(sample => {
        const outcomes = new Map(); let unsupported = 0;
        for (const row of sample.outcomes) {
          const code = ["OK", "ROUTED"].includes(row.code) || selected.codes.has(row.code) ? row.code : "DIAGNOSTICS_CODE_UNSUPPORTED";
          if (code !== row.code) unsupported += row.count;
          const key = code + ":" + row.field;
          const prior = outcomes.get(key);
          if (prior) prior.count += row.count; else outcomes.set(key, { ...row, code });
        }
        const losses = new Map();
        for (const row of sample.losses) {
          const reason = selected.losses.has(row.reason) ? row.reason : "catalog_mismatch";
          losses.set(reason, Math.min(1000000, (losses.get(reason) || 0) + row.count));
        }
        if (unsupported) losses.set("catalog_mismatch", Math.min(1000000, (losses.get("catalog_mismatch") || 0) + unsupported));
        return { ...sample, outcomes: [...outcomes.values()], losses: [...losses].map(([reason, count]) => ({reason, count})) };
      }) }; endpoint = "observations";
    }
    signal?.throwIfAborted();
    const response = await fetchImpl(new URL("/api/agent-workspaces/diagnostics/" + endpoint, origin), {
      method: "POST", headers, redirect: "error", signal, body: JSON.stringify(payload),
    });
    await discardBody(response);
    if (response.status !== 204) throw new DeliveryError("delivery_rejected", response.status >= 500);
    return { legacy: selected.version === 1 };
  };
};

export const createAgentDiagnosticReporter = ({
  origin, environment = process.env, send = createObservationTransport(),
  delayMs = 5000, retryDelays = [250, 750, 1500], timeoutMs = 3000,
  journal = origin ? { write: sample => writeDiagnosticJournal(origin, sample), read: () => readDiagnosticJournal(origin), acknowledge: samples => acknowledgeDiagnosticJournal(origin, samples) } : null,
} = {}) => {
  const pending = new Map(), losses = new Map();
  let timer, active, occupied, controller, closed = false;
  const loss = (reason, count = 1) => {
    if (contract.lossReasons.includes(reason) && count > 0) losses.set(reason, Math.min(1000000, (losses.get(reason) || 0) + count));
  };
  const schedule = () => {
    if (!closed && !timer && !active && !occupied && pending.size) {
      timer = setTimeout(() => { timer = undefined; void flush(); }, delayMs); timer.unref?.();
    }
  };
  const run = async () => {
    let journalSamples = [];
    if (journal) {
      try { const result = await journal.read(); journalSamples = result.samples.slice(0, 10);
        for (const [reason, count] of Object.entries(result.losses)) loss(reason, count);
      } catch { loss("journal_invalid"); }
    }
    if (closed || occupied) return;
    const local = [...pending.values()].slice(0, 19 - journalSamples.length);
    for (const sample of local) pending.delete(sample.key);
    const samples = [...journalSamples, ...local.map(({ key, ...sample }) => sample)];
    const carriedLosses = [...losses];
    if (losses.size && samples.length) {
      const health = buildDiagnosticObservation("unknown", {}, null, { boundary: "collector", environment });
      health.losses = [...losses].map(([reason, count]) => ({reason, count})); losses.clear(); samples.push(health);
    }
    if (!samples.length) return;
    const count = local.reduce((sum, sample) => sum + observationCount(sample), 0);
    const context = {};
    for (let attempt = 0; attempt <= retryDelays.length && !closed; attempt++) {
      controller = new AbortController(); let timeout, settled = false, failed;
      const sending = Promise.resolve().then(() => send(origin, samples, { signal: controller.signal, context }));
      // Retain the occupancy fence until the underlying work really settles.
      // Promise.race alone only ends waiting; it cannot cancel an arbitrary
      // adapter. No later flush/retry may start another credential read then.
      occupied = sending;
      const release = () => { settled = true; if (occupied === sending) occupied = undefined; schedule(); };
      void sending.then(release, release);
      try {
        const result = await Promise.race([sending, new Promise((_, reject) => {
          timeout = setTimeout(() => { controller.abort(); reject(new DeliveryError("delivery_timeout", true)); }, timeoutMs);
          timeout.unref?.();
        })]);
        if (result?.legacy) loss("catalog_mismatch", samples.reduce((sum, sample) => sum + observationCount(sample), 0));
        if (journalSamples.length) await journal?.acknowledge(journalSamples);
        return;
      } catch (error) { failed = error; }
      finally { clearTimeout(timeout); }
      const reason = failed instanceof DeliveryError ? failed.reason : "delivery_transport";
      if (!settled || (failed instanceof DeliveryError && !failed.retryable) || attempt === retryDelays.length || closed) {
        for (const [kind, amount] of carriedLosses) loss(kind, amount);
        if (count) loss(reason, count);
        return;
      }
      await new Promise(resolve => { const id = setTimeout(resolve, retryDelays[attempt]); id.unref?.(); });
    }
  };
  const flush = () => {
    if (active) return active;
    if (closed || occupied) return Promise.resolve();
    active = run().catch(() => { loss("delivery_transport"); }).finally(() => { active = undefined; schedule(); });
    return active;
  };
  const poll = journal ? setInterval(() => { void flush(); }, 30000) : undefined;
  poll?.unref?.();
  if (journal) { timer = setTimeout(() => { timer = undefined; void flush(); }, delayMs); timer.unref?.(); }
  return {
    record(tool, args, code = "OK", details = {}) {
      if (closed) return;
      const sample = buildDiagnosticObservation(tool, args, code, { environment, field: details.field });
      if (observationCode(code) === "UNKNOWN" && code !== "UNKNOWN") loss("unknown_code");
      const { id, outcomes, losses: ignored, ...dimensions } = sample;
      const key = JSON.stringify(dimensions);
      let previous = pending.get(key);
      if (previous && observationCount(previous) >= 1000) { loss("queue_overflow"); return; }
      if (!previous) {
        if (pending.size >= 128) { loss("queue_overflow"); return; }
        previous = { ...sample, outcomes: [], key }; pending.set(key, previous);
      }
      let row = outcomes[0];
      if (previous.outcomes.length >= 63 && !previous.outcomes.some(item => item.code === row.code && item.field === row.field))
        row = { code: "DIAGNOSTICS_DETAIL_OVERFLOW", field: "unknown", count: 1 };
      const match = previous.outcomes.find(item => item.code === row.code && item.field === row.field);
      if (match) match.count++; else previous.outcomes.push(row);
      schedule();
    },
    flush,
    health() { return { pendingGroups: pending.size, inFlight: Boolean(occupied), losses: Object.fromEntries(losses) }; },
    close() {
      closed = true; clearTimeout(timer); clearInterval(poll); controller?.abort();
      loss("shutdown", [...pending.values()].reduce((sum, sample) => sum + observationCount(sample), 0)); pending.clear();
      // Persist only the bounded content-free loss snapshot; shutdown never
      // waits for a token or network. If the OS kills us before this local write,
      // those losses remain unknowable and must not be claimed as measured.
      if (journal?.write && losses.size) {
        const health = buildDiagnosticObservation("unknown", {}, null, { boundary: "collector", environment });
        health.losses = [...losses].map(([reason, count]) => ({ reason, count }));
        void Promise.resolve().then(() => journal.write(health)).catch(() => {});
      }
    },
  };
};
