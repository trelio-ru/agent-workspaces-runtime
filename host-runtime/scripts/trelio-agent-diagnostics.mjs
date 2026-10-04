import { randomUUID } from "node:crypto";
import contract from "./trelio-agent-diagnostics-contract.json" with { type: "json" };
import { getPluginVersion, getHostRuntimeVersion } from "./trelio-component-versions.mjs";
import { readExistingBridgeSessionToken } from "./trelio-workspace.mjs";

const known = (values, value, fallback) => values.includes(value) ? value : fallback;
const version = (value) => /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u.test(value) ? value : "0.0.0";

export const buildAgentDiagnosticEvent = (tool, args, code, environment = process.env) => ({
  id: randomUUID(),
  tool: known(contract.localTools, tool, "unknown"),
  // Only the envelope discriminator is considered. Never inspect skill args,
  // messages, paths, company identity, proofs or any nested provider payload.
  operation: known(contract.operations, args?.operation ?? args?.route, "unknown"),
  code: known(contract.errorCodes, code, "UNKNOWN"),
  pluginVersion: version(getPluginVersion(environment)),
  runtimeVersion: version(getHostRuntimeVersion(environment)),
  count: 1,
});

export const sendAgentDiagnosticBatch = async (origin, events, {
  fetchImpl = fetch,
  readToken = readExistingBridgeSessionToken,
  signal,
} = {}) => {
  // Telemetry is optional: use an existing paired session without login,
  // credential migration, refresh, pairing or source OAuth fallback.
  const token = await readToken(origin);
  if (!token) return;
  const response = await fetchImpl(new URL("/api/agent-workspaces/diagnostics/errors", origin), {
    method: "POST", redirect: "error", signal,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, events }),
  });
  await response.body?.cancel();
  // Rejected/old servers need no recovery. Only transport/5xx are retried,
  // always using the identical batch IDs so a lost 204 cannot inflate counts.
  if (response.status >= 500) throw new Error("DIAGNOSTICS_RETRY");
};

export const createAgentDiagnosticReporter = ({
  origin, environment = process.env,
  send = sendAgentDiagnosticBatch,
  delayMs = 1000, retryDelays = [250, 750, 1500], timeoutMs = 3000,
} = {}) => {
  const pending = new Map();
  const controllers = new Set();
  let timer, active, closed = false;
  const sleep = (ms) => new Promise((resolve) => {
    const id = setTimeout(resolve, ms); id.unref?.();
  });
  const schedule = () => {
    if (!closed && !timer && !active && pending.size) {
      timer = setTimeout(() => { timer = undefined; void flush(); }, delayMs);
      timer.unref?.();
    }
  };
  const flush = () => {
    if (active) return active;
    if (closed || !pending.size) return Promise.resolve();
    // Freeze this batch before sending. New observations get new UUIDs;
    // retries must never reuse an ID with a larger accumulated count.
    const events = [...pending.values()].slice(0, 20);
    for (const event of events) pending.delete(event.key);
    const payload = events.map(({ key, ...event }) => event);
    active = (async () => {
      for (let attempt = 0; attempt <= retryDelays.length && !closed; attempt++) {
        const controller = new AbortController();
        controllers.add(controller);
        let timeout;
        try {
          // A broken credential adapter must not occupy the collector forever.
          // The timeout also aborts fetch; rejected late promises are consumed.
          await Promise.race([
            send(origin, payload, { signal: controller.signal }),
            new Promise((_, reject) => {
              timeout = setTimeout(() => { controller.abort(); reject(new Error("DIAGNOSTICS_TIMEOUT")); }, timeoutMs);
              timeout.unref?.();
            }),
          ]);
          break;
        } catch {
          if (attempt < retryDelays.length && !closed) await sleep(retryDelays[attempt]);
        } finally {
          clearTimeout(timeout);
          controllers.delete(controller);
        }
      }
    })().finally(() => { active = undefined; schedule(); });
    return active;
  };
  return {
    record(tool, args, code) {
      if (closed) return;
      const event = buildAgentDiagnosticEvent(tool, args, code, environment);
      const key = JSON.stringify([event.tool, event.operation, event.code, event.pluginVersion, event.runtimeVersion]);
      const previous = pending.get(key);
      if (previous) previous.count = Math.min(1000, previous.count + 1);
      else if (pending.size < 128) pending.set(key, { ...event, key });
      schedule();
    },
    flush,
    close() {
      closed = true; clearTimeout(timer); pending.clear();
      for (const controller of controllers) controller.abort();
      // Shutdown never waits for optional telemetry or persists it to disk.
    },
  };
};
