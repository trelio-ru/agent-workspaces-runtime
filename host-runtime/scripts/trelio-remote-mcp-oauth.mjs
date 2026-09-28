/**
 * OAuth 2.1 public-client flow for the fixed MCP 2025-03-26 transport.
 *
 * Registration, metadata and token traffic share the Remote MCP host's pinned
 * DNS/TLS guard. Only the selected service origin is accepted as issuer. Dodo
 * IS credentials belong to the service and never enter this client.
 */
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { openBrowser } from "./trelio-workspace.mjs";

const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const OAUTH_TIMEOUT_MS = 20_000;
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000;

export class RemoteMcpOAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => new RemoteMcpOAuthError(code, message);
const baseOrigin = (endpoint) => new URL(endpoint).origin;
const sameOriginUrl = (candidate, origin) => {
  let url;
  try { url = new URL(candidate); } catch { throw fail("REMOTE_MCP_OAUTH_METADATA_INVALID", "OAuth endpoint некорректен."); }
  if (
    url.origin !== origin
    || url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
  ) {
    throw fail("REMOTE_MCP_OAUTH_ORIGIN_BLOCKED", "OAuth endpoint не совпал с origin Remote MCP.");
  }
  return url.toString();
};

const readJson = (body) => {
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* A malformed provider response must remain a bounded error. */ }
  throw fail("REMOTE_MCP_OAUTH_RESPONSE_INVALID", "OAuth server вернул некорректный JSON.");
};

export const oauthHttpJson = async (
  url,
  { method = "GET", contentType = null, body = null, signal } = {},
  { resolveEndpoint } = {},
) => {
  if (typeof resolveEndpoint !== "function") throw new TypeError("resolveEndpoint is required");
  if (signal?.aborted) throw fail("REMOTE_MCP_OAUTH_CANCELLED", "OAuth-подключение отменено.");
  const startedAt = Date.now();
  let lookupTimer;
  let lookupAbort;
  let safe;
  try {
    // DNS validation is inside the same absolute bound as the HTTP request.
    // A late resolver cannot start network I/O after cancellation or timeout.
    safe = await Promise.race([
      resolveEndpoint(url),
      new Promise((_, reject) => {
        lookupTimer = setTimeout(() => reject(fail(
          "REMOTE_MCP_OAUTH_TIMEOUT", "OAuth server не ответил вовремя.",
        )), OAUTH_TIMEOUT_MS);
      }),
      new Promise((_, reject) => {
        lookupAbort = () => reject(fail("REMOTE_MCP_OAUTH_CANCELLED", "OAuth-подключение отменено."));
        signal?.addEventListener("abort", lookupAbort, { once: true });
      }),
    ]);
  } finally {
    if (lookupTimer) clearTimeout(lookupTimer);
    if (lookupAbort) signal?.removeEventListener("abort", lookupAbort);
  }
  if (signal?.aborted) throw fail("REMOTE_MCP_OAUTH_CANCELLED", "OAuth-подключение отменено.");
  const remainingMs = OAUTH_TIMEOUT_MS - (Date.now() - startedAt);
  if (remainingMs <= 0) throw fail("REMOTE_MCP_OAUTH_TIMEOUT", "OAuth server не ответил вовремя.");
  const source = body === null ? null : Buffer.from(body, "utf8");
  if (source && source.length > MAX_OAUTH_RESPONSE_BYTES) {
    throw fail("REMOTE_MCP_OAUTH_REQUEST_TOO_LARGE", "OAuth request превысил лимит.");
  }
  const transport = safe.endpoint.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    let outgoing;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        outgoing?.destroy();
        reject(error instanceof RemoteMcpOAuthError
          ? error
          : fail("REMOTE_MCP_OAUTH_NETWORK_ERROR", "OAuth server недоступен."));
      } else resolve(result);
    };
    const onAbort = () => finish(fail("REMOTE_MCP_OAUTH_CANCELLED", "OAuth-подключение отменено."));
    const timer = setTimeout(() => finish(fail("REMOTE_MCP_OAUTH_TIMEOUT", "OAuth server не ответил вовремя.")), remainingMs);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    outgoing = transport.request({
      protocol: safe.endpoint.protocol,
      hostname: safe.endpoint.hostname,
      port: safe.endpoint.port || undefined,
      path: `${safe.endpoint.pathname}${safe.endpoint.search}`,
      servername: safe.endpoint.hostname,
      method,
      headers: {
        accept: "application/json",
        ...(contentType ? { "content-type": contentType } : {}),
        ...(source ? { "content-length": String(source.length) } : {}),
      },
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [{ address: safe.address, family: safe.family }]);
        else callback(null, safe.address, safe.family);
      },
    }, (incoming) => {
      const statusCode = incoming.statusCode || 0;
      // Redirects are intentionally never followed. A provider metadata or
      // token endpoint cannot move the host to an unreviewed network target.
      if (statusCode >= 300 && statusCode < 400) {
        incoming.resume();
        finish(fail("REMOTE_MCP_OAUTH_REDIRECT_BLOCKED", "OAuth server ответил перенаправлением."));
        return;
      }
      const chunks = [];
      let size = 0;
      incoming.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_OAUTH_RESPONSE_BYTES) {
          incoming.destroy();
          finish(fail("REMOTE_MCP_OAUTH_RESPONSE_TOO_LARGE", "OAuth response превысил лимит."));
        } else chunks.push(chunk);
      });
      incoming.on("error", (error) => finish(error));
      incoming.on("end", () => {
        if (settled) return;
        const responseBody = Buffer.concat(chunks);
        if (statusCode === 404) {
          finish(null, { statusCode, body: null });
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          finish(fail(
            statusCode === 400 || statusCode === 401 || statusCode === 403
              ? "REMOTE_MCP_OAUTH_REJECTED"
              : "REMOTE_MCP_OAUTH_HTTP_ERROR",
            `OAuth server завершил запрос с HTTP ${statusCode}.`,
          ));
          return;
        }
        try { finish(null, { statusCode, body: readJson(responseBody) }); }
        catch (error) { finish(error); }
      });
    });
    outgoing.on("error", (error) => finish(error));
    outgoing.end(source);
  });
};

export const discoverRemoteMcpOAuth = async (config, options) => {
  const httpJson = options.httpJson || oauthHttpJson;
  const origin = baseOrigin(config.endpoint);
  const metadataUrl = `${origin}/.well-known/oauth-authorization-server`;
  const metadata = await httpJson(metadataUrl, { signal: options.signal }, options);
  if (metadata.statusCode === 404) {
    // The pinned protocol explicitly defines these fallback paths. A timeout,
    // 5xx or malformed document never causes this fallback.
    return {
      issuer: origin,
      authorizationEndpoint: `${origin}/authorize`,
      tokenEndpoint: `${origin}/token`,
      registrationEndpoint: `${origin}/register`,
    };
  }
  const value = metadata.body;
  if (value.issuer !== origin || !value.registration_endpoint) {
    throw fail("REMOTE_MCP_OAUTH_METADATA_INVALID", "OAuth issuer или registration endpoint не прошёл проверку.");
  }
  if (
    Array.isArray(value.code_challenge_methods_supported)
    && !value.code_challenge_methods_supported.includes("S256")
  ) {
    throw fail("REMOTE_MCP_OAUTH_PKCE_UNSUPPORTED", "OAuth server не объявил PKCE S256.");
  }
  return {
    issuer: origin,
    authorizationEndpoint: sameOriginUrl(value.authorization_endpoint, origin),
    tokenEndpoint: sameOriginUrl(value.token_endpoint, origin),
    registrationEndpoint: sameOriginUrl(value.registration_endpoint, origin),
  };
};

const tokenFromResponse = (body, previousRefreshToken = null) => {
  if (
    typeof body?.token_type !== "string"
    || body.token_type.toLowerCase() !== "bearer"
    || typeof body.access_token !== "string"
    || body.access_token.length < 8
    || body.access_token.length > 16_384
    || /[\r\n\0]/u.test(body.access_token)
    || !Number.isFinite(body.expires_in)
    || body.expires_in <= 0
    || body.expires_in > 86_400
  ) {
    throw fail("REMOTE_MCP_OAUTH_TOKEN_INVALID", "OAuth token response не прошёл проверку.");
  }
  const refreshToken = body.refresh_token ?? previousRefreshToken;
  if (refreshToken !== null && (typeof refreshToken !== "string" || refreshToken.length < 8 || refreshToken.length > 16_384 || /[\r\n\0]/u.test(refreshToken))) {
    throw fail("REMOTE_MCP_OAUTH_TOKEN_INVALID", "OAuth refresh token не прошёл проверку.");
  }
  return {
    accessToken: body.access_token,
    refreshToken,
    expiresAt: Date.now() + body.expires_in * 1_000,
  };
};

const waitForOAuthCallback = async ({ issuer, openBrowserFn, buildAuthorizeUrl, signal }) => {
  if (signal?.aborted) throw fail("REMOTE_MCP_OAUTH_CANCELLED", "OAuth-подключение отменено.");
  let expectedPort = 0;
  const state = crypto.randomBytes(32).toString("base64url");
  let resolveCallback;
  let rejectCallback;
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  callback.catch(() => undefined);
  const server = http.createServer((incoming, outgoing) => {
    const host = `127.0.0.1:${expectedPort}`;
    if (
      incoming.method !== "GET"
      || incoming.headers.host !== host
      || incoming.socket.remoteAddress !== "127.0.0.1"
      || incoming.socket.localAddress !== "127.0.0.1"
      || incoming.socket.localPort !== expectedPort
    ) {
      outgoing.writeHead(403, { "cache-control": "no-store" }).end("Forbidden");
      return;
    }
    const url = new URL(incoming.url || "/", `http://${host}`);
    if (
      url.pathname !== "/callback"
      || url.searchParams.getAll("state").length !== 1
      || url.searchParams.get("state") !== state
      || url.searchParams.getAll("code").length > 1
      || url.searchParams.getAll("iss").length > 1
    ) {
      outgoing.writeHead(403, { "cache-control": "no-store" }).end("Forbidden");
      return;
    }
    if (url.searchParams.has("iss") && url.searchParams.get("iss") !== issuer) {
      outgoing.writeHead(403, { "cache-control": "no-store" }).end("Forbidden");
      rejectCallback(fail("REMOTE_MCP_OAUTH_ISSUER_MISMATCH", "OAuth callback issuer не совпал."));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code || code.length > 4_096 || url.searchParams.has("error")) {
      outgoing.writeHead(400, { "cache-control": "no-store" }).end("Authorization failed");
      rejectCallback(fail("REMOTE_MCP_OAUTH_REJECTED", "OAuth-подключение отклонено."));
      return;
    }
    outgoing.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "referrer-policy": "no-referrer",
    }).end("<!doctype html><meta charset=utf-8><title>Подключено</title><p>Remote MCP подключён. Эту вкладку можно закрыть.</p>");
    resolveCallback(code);
  });
  let timeout;
  let onAbort;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    expectedPort = server.address().port;
    const redirectUri = `http://127.0.0.1:${expectedPort}/callback`;
    const authorizeUrl = await buildAuthorizeUrl({ redirectUri, state });
    try {
      await openBrowserFn(authorizeUrl, { signal });
    } catch {
      throw fail("REMOTE_MCP_OAUTH_BROWSER_OPEN_FAILED", "Не удалось открыть OAuth-страницу в браузере.");
    }
    if (signal?.aborted) throw fail("REMOTE_MCP_OAUTH_CANCELLED", "OAuth-подключение отменено.");
    const code = await Promise.race([
      callback,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(fail("REMOTE_MCP_OAUTH_TIMEOUT", "OAuth-подключение не завершено вовремя.")), CALLBACK_TIMEOUT_MS);
      }),
      new Promise((_, reject) => {
        onAbort = () => reject(fail("REMOTE_MCP_OAUTH_CANCELLED", "OAuth-подключение отменено."));
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    return { code, redirectUri };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

export const connectRemoteMcpOAuth = async (
  config,
  { resolveEndpoint, openBrowserFn = openBrowser, httpJson = oauthHttpJson, signal } = {},
) => {
  const metadata = await discoverRemoteMcpOAuth(config, { resolveEndpoint, httpJson, signal });
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const scopes = config.authentication.scopes.join(" ");
  let clientId = null;
  const { code, redirectUri } = await waitForOAuthCallback({
    issuer: metadata.issuer,
    openBrowserFn,
    signal,
    buildAuthorizeUrl: async ({ redirectUri: callbackUrl, state }) => {
      const registration = await httpJson(metadata.registrationEndpoint, {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({
          client_name: "Trelio Remote MCP host",
          application_type: "native",
          redirect_uris: [callbackUrl],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: scopes,
        }),
        signal,
      }, { resolveEndpoint });
      clientId = registration.body?.client_id;
      if (
        typeof clientId !== "string"
        || !clientId
        || clientId.length > 1_024
        || registration.body?.token_endpoint_auth_method !== "none"
        || (Array.isArray(registration.body?.redirect_uris)
          && !registration.body.redirect_uris.includes(callbackUrl))
      ) {
        throw fail("REMOTE_MCP_OAUTH_REGISTRATION_INVALID", "OAuth client registration не вернул client_id.");
      }
      const url = new URL(metadata.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", callbackUrl);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", state);
      url.searchParams.set("scope", scopes);
      return url.toString();
    },
  });
  const tokenResponse = await httpJson(metadata.tokenEndpoint, {
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
    signal,
  }, { resolveEndpoint });
  if (typeof tokenResponse.body?.scope === "string") {
    const granted = new Set(tokenResponse.body.scope.split(/\s+/u));
    if (config.authentication.scopes.some((scope) => !granted.has(scope))) {
      throw fail("REMOTE_MCP_OAUTH_SCOPE_MISMATCH", "OAuth server не предоставил объявленные scopes.");
    }
  }
  return {
    issuer: metadata.issuer,
    clientId,
    ...tokenFromResponse(tokenResponse.body),
  };
};

export const refreshRemoteMcpOAuth = async (
  config,
  session,
  { resolveEndpoint, httpJson = oauthHttpJson, signal } = {},
) => {
  if (!session.refreshToken) {
    throw fail("REMOTE_MCP_OAUTH_RECONNECT_REQUIRED", "OAuth-сессия истекла. Подключите Remote MCP заново.");
  }
  const metadata = await discoverRemoteMcpOAuth(config, { resolveEndpoint, httpJson, signal });
  if (metadata.issuer !== session.issuer) {
    throw fail("REMOTE_MCP_OAUTH_ISSUER_MISMATCH", "OAuth issuer изменился. Подключите Remote MCP заново.");
  }
  const response = await httpJson(metadata.tokenEndpoint, {
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: session.clientId,
      refresh_token: session.refreshToken,
    }).toString(),
    signal,
  }, { resolveEndpoint });
  return {
    ...session,
    ...tokenFromResponse(response.body, session.refreshToken),
  };
};
