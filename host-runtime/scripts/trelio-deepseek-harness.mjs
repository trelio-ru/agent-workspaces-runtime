/**
 * Experimental native DeepSeek Harness adapter.
 *
 * This is a Cordis plugin, not a Claude/Codex command-hook compatibility layer.
 * The actual request header supplies runtime evidence; the shared hook engine
 * adds a one-use proof only inside dispatch. OAuth, private storage, local E2EE
 * continuations and domain execution reuse the existing host engines.
 */
import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { recoverSelectedContinuation, validateLocalContinuationArguments } from "./trelio-local-continuation.mjs";
import { getHostRuntimeVersion } from "./trelio-component-versions.mjs";
import { prepareNativeRuntimeToolArguments } from "./trelio-runtime-session.mjs";
import { createRemoteMcpOAuthVault } from "./trelio-remote-mcp-oauth-vault.mjs";
import { connectRemoteMcpOAuth, oauthHttpJson } from "./trelio-remote-mcp-oauth.mjs";
import { assertJsonRpcResult, handleLocalMcpMessage, remoteMcpHttpRequest,
  resolveSafeRemoteMcpEndpoint } from "./trelio-remote-mcp.mjs";
import { deliverLocalMcpResult } from "./trelio-mcp-results.mjs";
import { buildBridgeRequestHeaders, resolveWorkspaceBridgeConfigDirectory } from "./trelio-workspace.mjs";
import { withPrivateProcessSession } from "./trelio-hook-private-session.mjs";

export const name = "trelio-deepseek-harness";
export const inject = ["tools", "llm"];
const ORIGIN = "https://trelio.ru";
const RESOURCE = `${ORIGIN}/mcp`;
const PROTOCOL = "2025-03-26";
const MAX_TOOLS = 512;
const MAX_ARGUMENT_BYTES = 512 * 1024;
const MAX_CONTINUATION_BYTES = 2 * 1024 * 1024;
const PRIVATE_ARGUMENT_KEYS = new Set(["runtimeSessionProof", "knownInstructionRevisionKey",
  "knownInstructionLayerKeys", "knownInstructionKey"]);
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/u;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
// Harness only renders Error.message for foreign Error classes. Preserve the
// closed recovery discriminator there, never spread an error's private fields
// (pairing verifier, credential cause, local grant or native process output).
const nativeError = error => {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.code) ? error.code : "TRELIO_HARNESS_FAILED";
  return fail(code, `${code}: ${error instanceof Error ? error.message : "Ошибка native адаптера Trelio."}`);
};
const cleanInput = input => {
  if (!record(input) || Buffer.byteLength(JSON.stringify(input)) > MAX_ARGUMENT_BYTES) {
    throw fail("TRELIO_HARNESS_INPUT_INVALID", "Некорректные аргументы инструмента Trelio.");
  }
  return Object.fromEntries(Object.entries(structuredClone(input)).filter(([key]) => !PRIVATE_ARGUMENT_KEYS.has(key)));
};

/** Read the header of the request that produced this tool call, not UI defaults
 * or an inherited Codex/Claude environment. Unknown/off effort stays null; it
 * is never promoted to an invented stronger level. Provider is part of model
 * identity so a custom endpoint cannot borrow another client's model rule.
 */
export const observeHarnessRuntime = execution => {
  const session = execution?.agent?.session;
  const header = session?.requestHeader?.()?.config;
  if (!record(header) || !identifier.test(header.provider ?? "") || !identifier.test(header.model ?? "")
      || typeof session?.header?.id !== "string" || !session.header.id || session.header.id.length > 256) {
    throw fail("TRELIO_RUNTIME_OBSERVATION_REQUIRED", "Harness не предоставил текущие provider/model/session.");
  }
  const modelId = `${header.provider}/${header.model}`;
  if (modelId.length > 255) throw fail("TRELIO_RUNTIME_OBSERVATION_REQUIRED", "Идентификатор модели Harness превышает лимит.");
  return { sessionId: session.header.id, observation: {
    schemaVersion: 1, clientFamily: "deepseek-harness", modelId,
    effortLevel: ["low", "medium", "high", "xhigh", "max", "ultra"].includes(header.reasoningEffort)
      ? header.reasoningEffort : null,
    evidenceLevel: "local_observed", source: "deepseek_native", observedAt: new Date().toISOString(),
  } };
};

/** Same 64-character naming boundary as Harness's native MCP bridge. Mapping
 * is retained by each definition; the proof always signs the original method.
 */
export const harnessToolName = (server, method) => {
  const full = `mcp__${server}__${method}`;
  return full.length <= 64 ? full
    : `${full.slice(0, 51)}_${crypto.createHash("sha256").update(full).digest("hex").slice(0, 12)}`;
};

/** Project full structured authority into Native text without exposing hidden
 * App grants. PTC receives the same public envelope. Rich binary blocks stay
 * outside model text; original files use Trelio's existing local-file route.
 */
export const projectHarnessMcpResult = result => {
  if (!record(result) || !Array.isArray(result.content)) {
    throw fail("TRELIO_HARNESS_RESULT_INVALID", "Trelio вернул несовместимый MCP-ответ.");
  }
  const projected = deliverLocalMcpResult(result, true);
  return {
    content: projected.content.map(block => block.type === "text" ? { type: "text", text: block.text }
      : block.type === "resource_link" ? { type: "text", text: `Resource: ${block.name} (${block.uri})` }
        : { type: "text", text: `[MCP ${block.type} is unavailable in this adapter; use original local-file delivery]` }),
    ...(projected.structuredContent === undefined ? {} : { structuredContent: projected.structuredContent }),
    ...(result.isError === true ? { isError: true } : {}),
  };
};

/** Correlation is per actual Agent object and bounded RAM only. A continuation
 * must equal the complete server-selected route and structural seed. This is
 * not a cache of mutation results or a capability; native ACL/proof/CAS still
 * run on every call. No transcript parsing, filesystem cache or model ref
 * selects another agent's original plaintext arguments.
 */
export const createHarnessContinuations = () => {
  const agents = new WeakMap();
  return {
    remember(agent, method, input, result, now = Date.now()) {
      const selection = result?.structuredContent?.providerSelection;
      const envelope = selection?.arguments;
      if (!agent || selection?.automatic !== true || selection.server !== "trelio-remote-skills"
          || selection.tool !== "continue_trelio_local_action" || selection.nativeTool !== method
          || !record(envelope?.parameters) || typeof envelope.parameters.nativeCallRef !== "string") return;
      const generation = agent.session?.surface?.contentGeneration;
      if (!Number.isSafeInteger(generation)) return;
      const snapshot = { method, input: cleanInput(input),
        result: structuredClone({ code: result?.structuredContent?.code, providerSelection: selection }), now, generation };
      const size = Buffer.byteLength(JSON.stringify(snapshot));
      if (size > MAX_CONTINUATION_BYTES) return;
      let rows = agents.get(agent);
      if (!rows) { rows = new Map(); agents.set(agent, rows); }
      for (const [key, value] of rows) if (now - value.now > 15 * 60_000) rows.delete(key);
      // Include envelope/input size, not just a count: a giant original body
      // cannot make a long-lived agent accumulate unbounded decrypted context.
      while (rows.size >= 16 || [...rows.values()].reduce((sum, row) => sum + row.size, 0) + size > MAX_CONTINUATION_BYTES) {
        rows.delete(rows.keys().next().value);
      }
      const previous = rows.get(envelope.parameters.nativeCallRef);
      if (previous && (!isDeepStrictEqual(previous.input, snapshot.input)
        || !isDeepStrictEqual(previous.result, snapshot.result))) {
        rows.delete(envelope.parameters.nativeCallRef);
        throw fail("LOCAL_CONTEXT_INVALID_INPUT", "Повторный ref имеет другой исходный вызов.");
      }
      rows.set(envelope.parameters.nativeCallRef, { ...snapshot, size });
    },
    recover(agent, input, now = Date.now()) {
      const ref = input.parameters?.nativeCallRef;
      if (ref === undefined) return input;
      const row = agents.get(agent)?.get(ref);
      if (!row || now < row.now || now - row.now > 15 * 60_000
        || row.generation !== agent.session?.surface?.contentGeneration) {
        throw fail("LOCAL_CONTEXT_INVALID_INPUT", "Исходный вызов этого агента недоступен. Нужны полные исходные аргументы.");
      }
      const original = recoverSelectedContinuation({ method: row.method, original: row.input,
        result: row.result, input });
      if (!original) throw fail("LOCAL_CONTEXT_INVALID_INPUT", "Продолжение не совпало с выбранным Trelio маршрутом.");
      const { arguments: _supplied, ...requested } = input.parameters;
      const { nativeCallRef: _ref, nativeArgumentKeys: _keys, ...parameters } = requested;
      return { ...input, parameters: { ...parameters, arguments: original } };
    },
  };
};

/** Fixed-origin OAuth and MCP transport. Dependency injection is source-test
 * only; no model-facing field selects a URL, bearer, executable or auth store.
 * Business calls are single-attempt. An expired/rejected grant requires the
 * explicit connect action, never an automatic login or mutation replay.
 */
export const createHarnessConnection = ({
  httpRequest = remoteMcpHttpRequest, httpJson = oauthHttpJson,
  connectOAuth = connectRemoteMcpOAuth, vault,
} = {}) => {
  let configuration, identity, session, initializing, sequence = 0;
  const config = () => configuration ??= { schemaVersion: 3, endpoint: RESOURCE, protocolVersion: PROTOCOL,
    headers: Object.fromEntries(buildBridgeRequestHeaders(null)), authentication: { type: "oauth2_pkce", scopes: [] } };
  const readMetadata = async signal => {
    const response = await httpJson(`${ORIGIN}/.well-known/oauth-authorization-server`, { signal },
      { resolveEndpoint: resolveSafeRemoteMcpEndpoint });
    const scopes = response.body?.scopes_supported;
    if (response.body?.issuer !== ORIGIN || !Array.isArray(scopes) || !scopes.length || scopes.length > 128
        || scopes.some(scope => typeof scope !== "string" || !/^mcp:[a-z0-9:-]+$/u.test(scope))) {
      throw fail("TRELIO_HARNESS_OAUTH_METADATA_INVALID", "Trelio не предоставил актуальный каталог OAuth scopes.");
    }
    config().authentication.scopes = [...new Set(scopes)].sort();
    identity = { remoteMcp: { configFingerprint: crypto.createHash("sha256")
      .update(JSON.stringify({ endpoint: RESOURCE, protocolVersion: PROTOCOL, scopes: config().authentication.scopes })).digest("hex") } };
    return identity;
  };
  const store = vault ?? createRemoteMcpOAuthVault({ nativeClient: "deepseek-harness",
    namespace: "native-trelio-deepseek-harness-v1", credentialFile:
      path.join(resolveWorkspaceBridgeConfigDirectory(), "native-clients", "deepseek-harness", "credential.json") });
  const credential = async signal => {
    if (!identity) await readMetadata(signal);
    const current = await store.read(ORIGIN, identity);
    if (!current || current.expiresAt <= Date.now()) throw fail("TRELIO_HARNESS_AUTH_REQUIRED",
      "Подключите Trelio инструментом trelio_connect. Вход выполняется только в браузере.");
    return current.accessToken;
  };
  const rpc = async (method, params, signal, token) => {
    const response = await httpRequest({ config: config(), credential: token ?? await credential(signal),
      sessionId: session?.sessionId, payload: { jsonrpc: "2.0", id: ++sequence, method, ...(params ? { params } : {}) } }, { signal });
    return { response, result: assertJsonRpcResult(response, method) };
  };
  const initialize = async signal => {
    if (session) return session;
    if (initializing) return initializing;
    initializing = (async () => {
      const token = await credential(signal);
      const { response, result } = await rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {},
        clientInfo: { name: "trelio-deepseek-harness", version: getHostRuntimeVersion() } }, signal, token);
      if (result?.protocolVersion !== PROTOCOL) throw fail("TRELIO_HARNESS_PROTOCOL_INVALID", "Trelio не согласовал MCP protocol.");
      const next = { sessionId: response.sessionId ?? null, instructions: result.instructions ?? "" };
      await httpRequest({ config: config(), credential: token, sessionId: next.sessionId,
        payload: { jsonrpc: "2.0", method: "notifications/initialized" } }, { signal });
      session = next;
      return session;
    })();
    try { return await initializing; } finally { initializing = null; }
  };
  return {
    initialize,
    async connect(signal, reauthorize = false) {
      const target = await readMetadata(signal);
      const current = await store.read(ORIGIN, target);
      if (reauthorize || !current || current.expiresAt <= Date.now()) {
        const created = await connectOAuth(config(), { signal, resolveEndpoint: resolveSafeRemoteMcpEndpoint,
          clientName: "Trelio – DeepSeek Harness (experimental)", resource: RESOURCE,
          maximumLifetimeSeconds: 365 * 24 * 60 * 60 });
        await store.write(ORIGIN, target, created);
        const saved = await store.read(ORIGIN, target);
        if (!saved || saved.accessToken !== created.accessToken) throw fail("TRELIO_HARNESS_AUTH_STORE_FAILED", "OAuth не подтверждён системным хранилищем.");
      }
      // Explicit reconnect starts a new read-only MCP negotiation; it never
      // repeats the prior business tool or revives a retired OAuth profile.
      session = null;
      await initialize(signal);
      return { connected: true, protectedRead: "not_checked", saving: "not_checked", experimental: true };
    },
    async listTools(signal) {
      await initialize(signal);
      const tools = [], cursors = new Set();
      let cursor;
      do {
        const { result } = await rpc("tools/list", cursor ? { cursor } : {}, signal);
        if (!Array.isArray(result?.tools) || tools.length + result.tools.length > MAX_TOOLS) {
          throw fail("TRELIO_HARNESS_CATALOG_INVALID", "MCP-каталог превышает допустимый размер.");
        }
        tools.push(...result.tools);
        cursor = result.nextCursor;
        if (cursor !== undefined && (typeof cursor !== "string" || cursors.has(cursor) || cursors.size >= 32)) {
          throw fail("TRELIO_HARNESS_CATALOG_INVALID", "Некорректная пагинация MCP-каталога.");
        }
        if (cursor !== undefined) cursors.add(cursor);
      } while (cursor !== undefined);
      if (new Set(tools.map(tool => tool.name)).size !== tools.length) {
        throw fail("TRELIO_HARNESS_CATALOG_INVALID", "MCP-каталог содержит повторные имена.");
      }
      return tools;
    },
    async call(method, args, signal) {
      await initialize(signal);
      return (await rpc("tools/call", { name: method, arguments: args }, signal)).result;
    },
    instructions: () => session?.instructions ?? "",
  };
};

/** Cordis registration factory is also the offline integration-test boundary.
 * Production uses only the defaults above. Tool input is frozen by Harness;
 * proof, bearer and hidden metadata never become its recorded argument value.
 */
export const applyHarnessAdapter = async (ctx, {
  connection = createHarnessConnection(), prepare = prepareNativeRuntimeToolArguments,
  localMessage = handleLocalMcpMessage,
} = {}) => {
  let disposed = false;
  let disposers = [];
  const continuations = createHarnessContinuations();
  const publicTool = tool => !(tool?._meta?.ui?.visibility?.length > 0
    && tool._meta.ui.visibility.every(value => value === "app"));
  const publicSchema = tool => {
    const schema = structuredClone(tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: false });
    if (!record(schema) || schema.type !== "object") throw fail("TRELIO_HARNESS_CATALOG_INVALID", "Некорректная схема инструмента.");
    for (const key of PRIVATE_ARGUMENT_KEYS) if (schema.properties) delete schema.properties[key];
    if (schema.required) schema.required = schema.required.filter(key => !PRIVATE_ARGUMENT_KEYS.has(key));
    return schema;
  };
  const definition = (tool, server, call) => ({
    name: harnessToolName(server, tool.name), description: tool.description ?? "",
    parameters: publicSchema(tool),
    output: { schema: { type: "object", properties: {}, additionalProperties: true },
      render: (_args, result) => result.content },
    async execute(raw, execution) {
      try {
        if (disposed) throw fail("TRELIO_HARNESS_DISPOSED", "Плагин Trelio остановлен.");
        let input = cleanInput(raw);
        // Browser fill requires a trusted client browser delivery surface. This
        // experimental native transport has none and must not issue a grant.
        if (tool.name === "prepare_agent_secret_browser_fill"
          || input.parameters?.nativeTool === "prepare_agent_secret_browser_fill"
          || ["secret_browser_prepare", "secret_browser_fill"].includes(input.operation)
          || ["secret_browser_prepare", "secret_browser_fill"].includes(input.parameters?.operation)) {
          throw fail("TRELIO_HARNESS_UNSUPPORTED_OPERATION", "Browser-fill не поддержан native адаптером Harness.");
        }
        if (server === "trelio_remote_skills" && tool.name === "continue_trelio_local_action") {
          input = continuations.recover(execution.agent, input);
          validateLocalContinuationArguments(input);
        }
        // Only native Trelio and its existing correlated local dispatcher carry
        // hook proofs. Setup/recovery and other local tools retain their own ABI.
        if (server === "trelio" || tool.name === "continue_trelio_local_action") {
          input = await prepare({ ...observeHarnessRuntime(execution),
            toolName: `mcp__${server}__${tool.name}`, input, signal: execution.signal });
        }
        const result = await withPrivateProcessSession(() => call(input, execution.signal), execution.signal);
        if (server === "trelio") continuations.remember(execution.agent, tool.name, raw, result);
        const value = projectHarnessMcpResult(result);
        if (value.isError) throw fail("TRELIO_MCP_ERROR", value.content.map(block => block.text).join("\n"));
        return value;
      } catch (error) { throw nativeError(error); }
    },
  });
  const refresh = async signal => {
    const remote = await connection.listTools(signal);
    const local = await localMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: ORIGIN, signal });
    if (!Array.isArray(local?.result?.tools)) throw fail("TRELIO_HARNESS_CATALOG_INVALID", "Локальный каталог Trelio недоступен.");
    if (disposed) return;
    const definitions = [
      ...remote.filter(publicTool).map(tool => definition(tool, "trelio", (input, callSignal) => connection.call(tool.name, input, callSignal))),
      ...local.result.tools.filter(publicTool).map(tool => definition(tool, "trelio_remote_skills", async (input, callSignal) => {
        const reply = await localMessage({ jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: tool.name, arguments: input } }, { origin: ORIGIN, signal: callSignal });
        if (!reply?.result) throw fail("TRELIO_HARNESS_LOCAL_FAILED", "Локальный компонент Trelio отклонил вызов.");
        return reply.result;
      })),
    ];
    if (new Set(definitions.map(tool => tool.name)).size !== definitions.length) throw fail("TRELIO_HARNESS_CATALOG_INVALID", "Коллизия имён инструментов Trelio.");
    for (const dispose of disposers) dispose();
    disposers = [];
    try { for (const tool of definitions) disposers.push(ctx.tools.register(tool)); }
    catch (error) { for (const dispose of disposers) dispose(); disposers = []; throw error; }
  };
  ctx.tools.register({ name: "trelio_connect",
    description: "Connect or explicitly reconnect Trelio in the system browser. Never supply tokens or authorization codes in chat. Also refreshes the live tool catalogue; it does not retry a previous business action.",
    parameters: { type: "object", properties: { reauthorize: { type: "boolean", description: "Explicitly replace a revoked or insufficient OAuth grant in the browser." } }, additionalProperties: false },
    output: { schema: { type: "object", properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(input, execution) {
      try {
        const connected = await withPrivateProcessSession(() => connection.connect(execution.signal, input.reauthorize === true), execution.signal);
        await refresh(execution.signal);
        return connected;
      } catch (error) { throw nativeError(error); }
    },
  });
  ctx.inject(["systemPrompt"], inner => inner.systemPrompt.section({
    name: "mcp:trelio", order: inner.systemPrompt.getSectionOrder("MCP_SERVERS"), interpolate: false,
    text: () => connection.instructions(),
  }));
  ctx.effect(() => () => { disposed = true; for (const dispose of disposers) dispose(); disposers = []; });
  try { await refresh(); }
  catch (error) {
    // Boot with the explicit recovery tool when no grant exists. A network,
    // protocol or private-store failure remains a failure, not an empty list.
    if (!["TRELIO_HARNESS_AUTH_REQUIRED", "REMOTE_MCP_AUTH_REJECTED", "REMOTE_MCP_INSUFFICIENT_SCOPE"].includes(error.code)) throw error;
  }
};

export const apply = ctx => applyHarnessAdapter(ctx);
