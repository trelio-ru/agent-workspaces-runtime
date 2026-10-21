/**
 * Native GigaCode Desktop transport for the fixed Trelio human MCP service.
 *
 * GigaCode's ACP UI cannot start its CLI-only MCP OAuth flow. This signed
 * adapter owns only PKCE, OS-vault storage and stdio/HTTPS framing. Native
 * Trelio still owns the complete live schema, scopes, ACL, company client
 * policy and mutation/human-decision guards. There is no provider catalogue,
 * synthetic hook/model proof, generic URL, token export or mutation replay.
 */
import crypto from "node:crypto";
import path from "node:path";
import { connectRemoteMcpOAuth } from "./trelio-remote-mcp-oauth.mjs";
import { createOAuthSessionVault } from "./trelio-remote-mcp-oauth-vault.mjs";
import { createRemoteSession, closeRemoteSession, remoteMcpHttpRequest, resolveSafeRemoteMcpEndpoint, runStdioHost } from "./trelio-remote-mcp.mjs";
import { resolveWorkspaceBridgeConfigDirectory } from "./trelio-workspace.mjs";
import { HOST_RUNTIME_VERSION } from "./trelio-component-versions.mjs";
import { isDirectModuleInvocation } from "./trelio-local-path.mjs";

const ORIGIN = "https://trelio.ru";
const CLIENT_ID = "trelio_gigacode_agent_workspaces_v1";
const CONFIG = Object.freeze({ endpoint: `${ORIGIN}/mcp`, protocolVersion: "2025-03-26",
  headers: {}, authentication: { type: "oauth2_pkce", scopes: [] } });
const CONNECT_TOOL = Object.freeze({
  name: "connect_trelio_gigacode",
  description: "Connect GigaCode Desktop to Trelio through browser OAuth. Reuse the existing OS-protected session; reauthorize only on an actual OAuth challenge or an explicit reconnect request. The user enters credentials and confirms consent in the browser. No Workspace/Run is created.",
  inputSchema: { type: "object", properties: { reauthorize: { type: "boolean" } }, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
});
const FORWARDED_METHODS = new Set(["tools/list", "tools/call", "resources/list", "resources/read",
  "resources/templates/list", "prompts/list", "prompts/get", "ping"]);
const LOCAL_ERROR_CODES = new Set(["TRELIO_GIGACODE_PLATFORM_UNSUPPORTED", "TRELIO_GIGACODE_SESSION_INVALID",
  "TRELIO_GIGACODE_AUTH_REQUIRED", "TRELIO_GIGACODE_INITIALIZE_FAILED", "TRELIO_GIGACODE_STORE_FAILED",
  "TRELIO_GIGACODE_RESPONSE_INVALID"]);
const errorResult = (id, code) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: code } });
const failureCode = (error, signal) => error?.code === "REMOTE_MCP_AUTH_REJECTED" ? "TRELIO_GIGACODE_AUTH_REJECTED"
  : error?.code === "REMOTE_MCP_INSUFFICIENT_SCOPE" ? "TRELIO_GIGACODE_ACCESS_DENIED"
  : LOCAL_ERROR_CODES.has(error?.message) ? error.message
  : signal?.aborted || error?.code === "REMOTE_MCP_OAUTH_CANCELLED" ? "TRELIO_GIGACODE_CANCELLED"
  : "TRELIO_GIGACODE_CONNECTION_FAILED";
const connectedResult = instructions => ({ content: [{ type: "text", text:
  "Trelio OAuth is connected. Read the live tool catalogue and continue the original setup request. "
  + "This confirms authorization only; verify the exact company, folder binding and accepted Workspace separately. "
  + (instructions || "") }] });

export const createGigaCodeMcpHandler = ({
  platform = process.platform,
  vault = createOAuthSessionVault({
    credentialFile: path.join(resolveWorkspaceBridgeConfigDirectory(), "native-mcp", "gigacode", "credential.json"),
    keychainService: "ru.trelio.native-mcp-oauth.v1",
    accountForSession: origin => crypto.createHash("sha256").update(`${origin}\0${CLIENT_ID}`).digest("hex"),
    fingerprintForSession: () => "gigacode-human-mcp-v1",
  }),
  connect = connectRemoteMcpOAuth,
  httpRequest = remoteMcpHttpRequest,
} = {}) => {
  let credential = null;
  let loaded = false;
  let connection = null;
  let lastVerificationCode = null;
  const bootstrapTools = () => [{ ...CONNECT_TOOL, description: CONNECT_TOOL.description
    + (lastVerificationCode ? ` Last verification: ${lastVerificationCode}.` : "") }];
  const bootstrapResult = () => ({
    protocolVersion: CONFIG.protocolVersion, serverInfo: { name: "trelio-gigacode", version: HOST_RUNTIME_VERSION },
    instructions: "Call connect_trelio_gigacode, let the user finish Trelio browser consent, then continue setup from the live Trelio tool catalogue. Never use another clientKind, fake runtime proof or CLI licensing workaround. "
      + (lastVerificationCode ? `Last verification: ${lastVerificationCode}. Transport/storage failure does not prove logout. Reauthorize only after AUTH_REJECTED or an actual OAuth challenge. ` : ""),
  });
  const requirePlatform = () => {
    // The first supported desktop path is macOS, where the existing native
    // Keychain helper is tested. Never downgrade to GigaCode's plaintext token
    // file or claim Windows/Linux readiness from a substituted platform value.
    if (platform !== "darwin") throw new Error("TRELIO_GIGACODE_PLATFORM_UNSUPPORTED");
  };
  const validate = record => {
    if (!record) return null;
    if (record.issuer !== ORIGIN || record.clientId !== CLIENT_ID || !Number.isFinite(record.expiresAt)
      || typeof record.accessToken !== "string" || record.accessToken.length < 8
      || record.accessToken.length > 16_384 || /[\r\n\0]/u.test(record.accessToken)) {
      throw new Error("TRELIO_GIGACODE_SESSION_INVALID");
    }
    return record;
  };
  const load = async () => {
    requirePlatform();
    if (!loaded) { credential = validate(await vault.read(ORIGIN, null)); loaded = true; }
    return credential && credential.expiresAt > Date.now() ? credential : null;
  };
  const boundedRequest = (request, { signal } = {}) => httpRequest(request,
    { signal, resolveEndpoint: resolveSafeRemoteMcpEndpoint, timeoutMs: request.method === "DELETE" ? 5_000 : 120_000 });
  const withSession = async (signal, operation) => {
    const token = await load();
    if (!token) throw new Error("TRELIO_GIGACODE_AUTH_REQUIRED");
    // Reuse the existing bounded session engine and its empty capabilities.
    // No Apps/elicitation is advertised: native Trelio selects guarded text
    // review. Each request owns a short remote session, so desktop idle time,
    // an unrelated cancellation or server eviction cannot trigger a hidden
    // reconnect/replay of a later mutation. Token identity stays pinned until
    // this exact operation completes even if another call finishes consent.
    const session = await createRemoteSession(CONFIG, token.accessToken, boundedRequest, { signal });
    try { return await operation(session, token); }
    finally { await closeRemoteSession(CONFIG, token.accessToken, session.sessionId, boundedRequest, { signal }); }
  };
  return async (message, { signal, notifyClient } = {}) => {
    if (!message || message.jsonrpc !== "2.0") return null;
    const { id, method } = message;
    if (id === undefined || id === null) return null;
    try {
      requirePlatform();
      if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
      if (method === "initialize") {
        let result;
        try {
          result = await load() ? await withSession(signal, session => session.initializeResult) : bootstrapResult();
          lastVerificationCode = null;
        } catch (error) {
          // Keep the local setup tool reachable after an expired/revoked token,
          // locked vault or temporary outage. This does not admit any business
          // request, erase a credential or silently start a new browser flow.
          lastVerificationCode = failureCode(error, signal);
          result = bootstrapResult();
        }
        return { jsonrpc: "2.0", id, result: { ...result, capabilities: {
          tools: { listChanged: true }, resources: { listChanged: false } } } };
      }
      if (method === "tools/call" && message.params?.name === CONNECT_TOOL.name) {
        const args = message.params.arguments ?? {};
        if (!args || Array.isArray(args) || typeof args !== "object"
          || Object.keys(args).some(key => key !== "reauthorize")
          || (args.reauthorize !== undefined && typeof args.reauthorize !== "boolean")) {
          return errorResult(id, "TRELIO_GIGACODE_INVALID_ARGUMENTS");
        }
        if (!connection) connection = (async () => {
          // An explicit reconnect must remain reachable even when the old
          // record fails validation. Do not read/erase that record first;
          // only successful browser consent and vault read-back replace it.
          if (args.reauthorize === true || !await load()) {
            const session = validate(await connect(CONFIG, {
              resolveEndpoint: resolveSafeRemoteMcpEndpoint, signal, fixedClientId: CLIENT_ID,
              resource: CONFIG.endpoint, useSupportedScopes: true, maxExpiresIn: 366 * 24 * 60 * 60,
            }));
            // Persist and independently read back before calling it connected.
            // Failed/ambiguous storage keeps the old record; it never writes a
            // plaintext token file or retries the OAuth exchange automatically.
            await vault.write(ORIGIN, null, session);
            const stored = validate(await vault.read(ORIGIN, null));
            if (!stored || stored.accessToken !== session.accessToken) throw new Error("TRELIO_GIGACODE_STORE_FAILED");
            credential = stored; loaded = true;
          }
          return await withSession(signal, session => session.initializeResult.instructions);
        })().finally(() => { connection = null; });
        const instructions = await connection;
        lastVerificationCode = null;
        await notifyClient?.("notifications/tools/list_changed");
        return { jsonrpc: "2.0", id, result: connectedResult(instructions) };
      }
      if (!FORWARDED_METHODS.has(method)) return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
      if (method === "tools/list") {
        try {
          if (!await load()) return { jsonrpc: "2.0", id, result: { tools: bootstrapTools() } };
          const response = await withSession(signal, (session, token) => boundedRequest({ config: CONFIG,
            credential: token.accessToken, sessionId: session.sessionId,
            payload: { ...message, id: session.nextRequestId() } }, { signal }));
          if (response.message?.error || !Array.isArray(response.message?.result?.tools)) throw new Error("TRELIO_GIGACODE_RESPONSE_INVALID");
          lastVerificationCode = null;
          return { ...response.message, id, result: { ...response.message.result,
            tools: [CONNECT_TOOL, ...response.message.result.tools] } };
        } catch (error) {
          lastVerificationCode = failureCode(error, signal);
          return { jsonrpc: "2.0", id, result: { tools: bootstrapTools() } };
        }
      }
      // Shared request IDs cannot collide with that session's initialize.
      // A lost mutation response is returned as an error and is never replayed.
      const response = await withSession(signal, (session, token) => boundedRequest({
        config: CONFIG, credential: token.accessToken, sessionId: session.sessionId,
        payload: { ...message, id: session.nextRequestId() },
      }, { signal }));
      if (!response.message || response.message.jsonrpc !== "2.0") throw new Error("TRELIO_GIGACODE_RESPONSE_INVALID");
      const forwarded = { ...response.message, id };
      return forwarded;
    } catch (error) {
      // Native backend tool results (including challenges/policy/ACL errors)
      // are returned above unchanged. Local transport/storage causes may carry
      // private URLs/headers; expose only closed adapter categories here.
      return errorResult(id, failureCode(error, signal));
    }
  };
};

export const runGigaCodeMcp = options => runStdioHost({
  ...options, handleMessage: createGigaCodeMcpHandler(options),
  // This is a genuine GigaCode profile. Its startup never reads or migrates
  // Codex config even when launched from an inherited developer environment.
  skipCodexMigration: true,
});

if (isDirectModuleInvocation(import.meta.url)) {
  runGigaCodeMcp().catch(() => { process.stderr.write("TRELIO_GIGACODE_TRANSPORT_FAILED\n"); process.exitCode = 1; });
}
