import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";

import {
  connectRemoteMcpOAuth,
  discoverRemoteMcpOAuth,
  oauthHttpJson,
  refreshRemoteMcpOAuth,
} from "../host-runtime/scripts/trelio-remote-mcp-oauth.mjs";
import { loadPersonalCredential, forgetPersonalCredential, createHarnessConnection } from "../host-runtime/scripts/trelio-remote-mcp.mjs";
import { BrowserOpenError, withWorkspaceExecutionProfile, writePrivateJsonFile, readPrivateJsonFile } from "../host-runtime/scripts/trelio-workspace.mjs";
import { createRemoteMcpOAuthVault } from "../host-runtime/scripts/trelio-remote-mcp-oauth-vault.mjs";

const config = {
  endpoint: "https://dodo-service.example.com/mcp",
};

const callbackConfig = { ...config, authentication: { scopes: ["synthetic:read", "synthetic:write"] } };
const issuer = new URL(config.endpoint).origin;
const createOAuthTransport = (onToken = () => assert.fail("нельзя обменивать code после отказа")) => async (url, request) => {
  if (url.endsWith("/.well-known/oauth-authorization-server")) return { statusCode: 200, body: {
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`, code_challenge_methods_supported: ["S256"],
  } };
  if (url.endsWith("/register")) return { statusCode: 201, body: {
    client_id: "synthetic-client", token_endpoint_auth_method: "none",
    redirect_uris: JSON.parse(request.body).redirect_uris,
  } };
  if (url.endsWith("/token")) return onToken(request);
  assert.fail("неожиданный synthetic OAuth endpoint");
};
const requestCallback = (url, headers = {}) => new Promise((resolve, reject) => {
  const request = http.get(url, { headers, agent: false }, (response) => {
    response.resume();
    response.on("end", () => resolve(response.statusCode));
  });
  request.on("error", reject);
});
const assertListenerClosed = async (callback) => {
  assert.ok(callback);
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(callback.port) });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("OAuth callback listener остался открыт"));
    });
    socket.once("error", (error) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      reject(new Error("проверка закрытого callback не завершилась"));
    });
  });
};

test("fixed native OAuth profiles reject unknown IDs and resources before I/O", async () => {
  const nativeEndpoint = "https://trelio.ru/mcp";
  const multiToolClient = "trelio_multitool_agent_workspaces_v1";
  const unexpectedIO = () => assert.fail("invalid fixed profiles must fail before discovery or browser launch");
  for (const [endpoint, resource, publicClientId] of [
    [nativeEndpoint, nativeEndpoint, "unregistered-native-client"],
    [config.endpoint, config.endpoint, multiToolClient],
    [nativeEndpoint, null, multiToolClient],
    [nativeEndpoint, "https://trelio.ru/mcp/other", multiToolClient],
  ]) {
    await assert.rejects(connectRemoteMcpOAuth({ ...callbackConfig, endpoint }, {
      publicClientId, resource, httpJson: unexpectedIO, openBrowserFn: unexpectedIO,
    }), { code: "REMOTE_MCP_OAUTH_PROFILE_INVALID" });
  }
});

test("static Remote MCP client uses the same loopback and PKCE flow without DCR", async () => {
  const staticConfig = {
    ...config,
    authentication: { type: "oauth2_pkce", clientRegistration: "static", clientId: "kb_public_client", scopes: ["kb:read"] },
  };
  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
  let authorize;
  const grants = [];
  const httpJson = async (url, request) => {
    if (url.endsWith("/.well-known/oauth-authorization-server")) return { statusCode: 200, body: metadata };
    assert.equal(url, metadata.token_endpoint, "the provider does not publish a registration endpoint");
    const body = new URLSearchParams(request.body);
    assert.equal(body.get("client_id"), staticConfig.authentication.clientId);
    assert.equal(body.get("resource"), staticConfig.endpoint);
    assert.equal(body.has("client_secret"), false);
    const grant = body.get("grant_type");
    grants.push(grant);
    if (grant === "authorization_code") {
      assert.equal(body.get("redirect_uri"), authorize.searchParams.get("redirect_uri"));
      assert.equal(createHash("sha256").update(body.get("code_verifier")).digest("base64url"),
        authorize.searchParams.get("code_challenge"));
    } else {
      assert.equal(body.get("refresh_token"), "synthetic-refresh");
    }
    return { statusCode: 200, body: {
      token_type: "Bearer", access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600,
    } };
  };
  const session = await connectRemoteMcpOAuth(staticConfig, {
    httpJson,
    openBrowserFn: async (url) => {
      authorize = new URL(url);
      assert.equal(authorize.origin + authorize.pathname, metadata.authorization_endpoint);
      assert.equal(authorize.searchParams.get("client_id"), staticConfig.authentication.clientId);
      assert.equal(authorize.searchParams.get("resource"), staticConfig.endpoint);
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      const callback = new URL(authorize.searchParams.get("redirect_uri"));
      assert.equal(callback.hostname, "127.0.0.1");
      assert.equal(callback.pathname, "/callback");
      callback.searchParams.set("state", authorize.searchParams.get("state"));
      callback.searchParams.set("code", "synthetic-authorization-code");
      callback.searchParams.set("iss", issuer);
      assert.equal(await requestCallback(callback), 200);
    },
  });
  await assertListenerClosed(new URL(authorize.searchParams.get("redirect_uri")));
  await refreshRemoteMcpOAuth(staticConfig, session, { httpJson });
  await assert.rejects(refreshRemoteMcpOAuth(staticConfig, { ...session, clientId: "other-client" }, { httpJson }),
    { code: "REMOTE_MCP_OAUTH_RECONNECT_REQUIRED" });
  assert.deepEqual(grants, ["authorization_code", "refresh_token"]);
  await assert.rejects(discoverRemoteMcpOAuth(staticConfig, {
    httpJson: async () => ({ statusCode: 404, body: null }),
  }), { code: "REMOTE_MCP_OAUTH_METADATA_INVALID" });
  await assert.rejects(discoverRemoteMcpOAuth(staticConfig, {
    httpJson: async () => ({ statusCode: 200, body: { ...metadata, token_endpoint_auth_methods_supported: ["client_secret_post"] } }),
  }), { code: "REMOTE_MCP_OAUTH_METADATA_INVALID" });
});

test("OAuth opener failure and cancellation close the exact loopback listener", async (t) => {
  for (const cancel of [false, true]) {
    await t.test(cancel ? "cancel during browser handoff" : "opener failure", async () => {
      const controller = new AbortController();
      let callback;
      await assert.rejects(connectRemoteMcpOAuth(callbackConfig, {
        signal: controller.signal, httpJson: createOAuthTransport(),
        openBrowserFn: async (url) => {
          callback = new URL(new URL(url).searchParams.get("redirect_uri"));
          if (cancel) controller.abort();
          throw new Error(url);
        },
      }), (error) => {
        assert.equal(error.code, cancel ? "REMOTE_MCP_OAUTH_CANCELLED" : "REMOTE_MCP_OAUTH_BROWSER_OPEN_FAILED");
        assert.ok(!error.message.includes("state="));
        assert.equal(error.cause, undefined);
        return true;
      });
      await assertListenerClosed(callback);
    });
  }
});

test("OAuth cancellation while waiting closes the exact loopback listener", async () => {
  const controller = new AbortController();
  let callback;
  await assert.rejects(connectRemoteMcpOAuth(callbackConfig, {
    signal: controller.signal, httpJson: createOAuthTransport(),
    openBrowserFn: async (url) => {
      callback = new URL(new URL(url).searchParams.get("redirect_uri"));
      setImmediate(() => controller.abort());
    },
  }), (error) => error.code === "REMOTE_MCP_OAUTH_CANCELLED");
  await assertListenerClosed(callback);
});

test("OAuth callback timeout closes the listener without exchanging a code", async (t) => {
  let callback;
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await assert.rejects(connectRemoteMcpOAuth(callbackConfig, {
      httpJson: createOAuthTransport(),
      openBrowserFn: async (url) => {
        callback = new URL(new URL(url).searchParams.get("redirect_uri"));
        // Виртуализируем только JS timer; сам loopback server настоящий.
        setImmediate(() => t.mock.timers.tick(10 * 60 * 1_000));
      },
    }), (error) => error.code === "REMOTE_MCP_OAUTH_TIMEOUT");
  } finally {
    t.mock.timers.reset();
  }
  await assertListenerClosed(callback);
});

for (const nativeClient of ["codex", "kimi-work", "multitool", "deepseek-harness", "mimo-desktop",
  "claude-code", "cursor", "antigravity"]) {
  test(`${nativeClient}: manual fallback survives the tool result and resumes the exact OAuth attempt`, async t => {
    let stored, authorization, opens = 0, exchanges = 0, writes = 0;
    let releaseToken;
    const tokenGate = new Promise(resolve => { releaseToken = resolve; });
    const fakeAddress = "240.0.0.42";
    t.mock.method(dns, "lookup", async hostname => {
      assert.equal(hostname, "trelio.ru");
      return { address: fakeAddress, family: 4 };
    });
    const checkNativeEndpoint = async (url, resolveEndpoint) => {
      const { endpoint, address, family } = await resolveEndpoint(url);
      assert.equal(endpoint.href, url);
      assert.equal(address, fakeAddress);
      assert.equal(family, 4);
    };
    const httpJson = async (url, request = {}, { resolveEndpoint }) => {
      // Exercise the resolver that production supplies to OAuth discovery,
      // registration and exchange. Only the DNS answer and HTTP peer are fake.
      await checkNativeEndpoint(url, resolveEndpoint);
      if (url.includes(".well-known")) return { body: { issuer: "https://trelio.ru",
        authorization_endpoint: "https://trelio.ru/authorize", token_endpoint: "https://trelio.ru/token",
        registration_endpoint: "https://trelio.ru/register", code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp:read", "mcp:workspaces:read", "mcp:workspaces:write"] } };
      if (url.endsWith("/register")) return { body: { client_id: "synthetic-native", token_endpoint_auth_method: "none",
        redirect_uris: JSON.parse(request.body).redirect_uris } };
      assert.equal(url, "https://trelio.ru/token");
      exchanges++;
      const params = new URLSearchParams(request.body);
      assert.equal(params.get("code"), "synthetic-manual-code");
      assert.equal(createHash("sha256").update(params.get("code_verifier")).digest("base64url"), authorization.searchParams.get("code_challenge"));
      await tokenGate;
      return { body: { token_type: "Bearer", access_token: "synthetic-private-token", expires_in: 3600 } };
    };
    const connection = createHarnessConnection({ nativeClient, httpJson,
      vault: { read: async () => stored, write: async (_origin, _identity, value) => { stored = value; writes++; } },
      connectOAuth: (config, options) => connectRemoteMcpOAuth(config, { ...options, httpJson,
        openBrowserFn: async url => {
          opens++; authorization = new URL(url);
          throw new BrowserOpenError("safe diagnostic", { stage: "shell_execute", nativeCode: 5, exitCode: 1 });
        } }),
      httpRequest: async ({ config, payload }, { resolveEndpoint }) => {
        await checkNativeEndpoint(config.endpoint, resolveEndpoint);
        await assert.rejects(resolveEndpoint("https://other.example/mcp"), { code: "REMOTE_MCP_ENDPOINT_BLOCKED" });
        return { message: { jsonrpc: "2.0", id: payload.id,
          result: { protocolVersion: "2025-03-26" } } };
      },
    });
    const tool = new AbortController();
    try {
      const pending = await connection.connect(tool.signal, true);
      assert.equal(pending.status, "awaiting_authorization");
      assert.equal(pending.connected, false);
      assert.equal(pending.authorizationUrl, authorization.href);
      assert.equal(pending.browser.nativeCode, 5);
      assert.ok(Date.parse(pending.expiresAt) > Date.now() + 590_000);
      tool.abort(); // The completed call no longer owns the live listener.
      assert.deepEqual(await connection.connect(undefined, true), pending);
      assert.deepEqual(await connection.connect(), pending);
      assert.equal(opens, 1); assert.equal(exchanges, 0); assert.equal(writes, 0);
      assert.ok(!JSON.stringify(pending).includes("code_verifier"));
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "synthetic-manual-code");
      const forged = new URL(callback); forged.searchParams.set("state", "forged");
      assert.equal(await requestCallback(forged), 403);
      assert.equal(await requestCallback(callback), 200);
      const confirming = await connection.connect();
      assert.equal(confirming.status, "confirming_authorization");
      assert.equal(confirming.authorizationUrl, undefined);
      assert.equal(writes, 0);
      releaseToken();
      // Completion persists without a second tool call. Poll only after that
      // background pipeline has had a turn; it must not start OAuth again.
      for (let i = 0; i < 20 && !stored; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(writes, 1);
      await new Promise(resolve => setImmediate(resolve));
      const result = await connection.connect(undefined, true);
      assert.equal(result.connected, true);
      assert.equal(result.authorizationUrl, undefined);
      assert.ok(!JSON.stringify(result).includes("synthetic-private-token"));
      assert.equal(opens, 1); assert.equal(exchanges, 1);
      await assertListenerClosed(callback);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const replacement = await connection.connect(undefined, true);
      t.mock.timers.tick(600_000);
      await new Promise(resolve => setImmediate(resolve));
      await assert.rejects(connection.connect(undefined, true), { code: "REMOTE_MCP_OAUTH_TIMEOUT" });
      t.mock.timers.reset();
      assert.equal(opens, 2, "checking an expired attempt reports its outcome before starting another");
      await assertListenerClosed(new URL(new URL(replacement.authorizationUrl).searchParams.get("redirect_uri")));
      const final = await connection.connect(undefined, true);
      await connection.close();
      await assertListenerClosed(new URL(new URL(final.authorizationUrl).searchParams.get("redirect_uri")));
      assert.equal(exchanges, 1); assert.equal(writes, 1);
    } finally { releaseToken(); await connection.close(); }
  });
}

test("manual OAuth keeps one deadline and closes on timeout or host cancellation", async t => {
  for (const cancel of [false, true]) await t.test(cancel ? "host closes" : "deadline expires", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController();
    let handoff;
    const ready = new Promise(resolve => { handoff = resolve; });
    const completion = connectRemoteMcpOAuth(callbackConfig, {
      httpJson: createOAuthTransport(), signal: controller.signal,
      openBrowserFn: async () => { throw new BrowserOpenError("safe", { stage: "spawn", causeCode: "ENOENT" }); },
      onManualAuthorization: handoff,
    });
    const pending = await ready;
    const callback = new URL(new URL(pending.authorizationUrl).searchParams.get("redirect_uri"));
    if (cancel) controller.abort(); else t.mock.timers.tick(600_000);
    await assert.rejects(completion, error => {
      assert.equal(error.code, cancel ? "REMOTE_MCP_OAUTH_CANCELLED" : "REMOTE_MCP_OAUTH_TIMEOUT");
      if (!cancel) assert.equal(error.browser.causeCode, "ENOENT");
      assert.ok(!JSON.stringify(error).includes("state="));
      return true;
    });
    t.mock.timers.reset();
    await assertListenerClosed(callback);
  });
});

test("a callback that beats a slow opener completes without publishing a stale manual URL", async () => {
  let callback;
  const session = await connectRemoteMcpOAuth(callbackConfig, {
    httpJson: createOAuthTransport(() => ({ body: { token_type: "Bearer", access_token: "synthetic-race", expires_in: 3600 } })),
    onManualAuthorization: () => assert.fail("callback already consumed"),
    openBrowserFn: async (url, { signal }) => {
      const start = new URL(url); callback = new URL(start.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", start.searchParams.get("state")); callback.searchParams.set("code", "synthetic-code");
      const closed = new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("helper stopped")), { once: true }));
      void requestCallback(callback).catch(() => {});
      return closed;
    },
  });
  assert.equal(session.accessToken, "synthetic-race");
  await assertListenerClosed(callback);
});

test("OAuth callback rejects forged state, duplicate fields and wrong host before PKCE exchange", async () => {
  let authorization;
  let callback;
  let tokenCalls = 0;
  const session = await connectRemoteMcpOAuth(callbackConfig, {
    httpJson: createOAuthTransport((request) => {
      tokenCalls += 1;
      const body = new URLSearchParams(request.body);
      assert.equal(body.get("code"), "synthetic-code");
      assert.equal(body.get("redirect_uri"), authorization.searchParams.get("redirect_uri"));
      assert.equal(createHash("sha256").update(body.get("code_verifier")).digest("base64url"),
        authorization.searchParams.get("code_challenge"));
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      assert.equal(authorization.searchParams.get("scope"), "synthetic:read synthetic:write");
      return { statusCode: 200, body: {
        token_type: "Bearer", access_token: "synthetic-access-token", expires_in: 3_600,
      } };
    }),
    openBrowserFn: async (url) => {
      authorization = new URL(url);
      callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "synthetic-code");
      callback.searchParams.set("iss", issuer);
      const forged = new URL(callback);
      forged.searchParams.set("state", "forged-state");
      assert.equal(await requestCallback(forged), 403);
      for (const field of ["state", "code", "iss"]) {
        const duplicate = new URL(callback);
        duplicate.searchParams.append(field, duplicate.searchParams.get(field));
        assert.equal(await requestCallback(duplicate), 403);
      }
      assert.equal(await requestCallback(callback, { host: "other.example.test" }), 403);
      assert.equal(await requestCallback(callback), 200);
    },
  });
  assert.equal(session.accessToken, "synthetic-access-token");
  assert.equal(tokenCalls, 1);
  await assertListenerClosed(callback);
});

test("OAuth callback issuer mismatch closes the listener without exchanging a code", async () => {
  let callback;
  await assert.rejects(connectRemoteMcpOAuth(callbackConfig, {
    httpJson: createOAuthTransport(),
    openBrowserFn: async (url) => {
      const authorization = new URL(url);
      callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "synthetic-code");
      callback.searchParams.set("iss", "https://other.example.test");
      assert.equal(await requestCallback(callback), 403);
    },
  }), (error) => error.code === "REMOTE_MCP_OAUTH_ISSUER_MISMATCH");
  await assertListenerClosed(callback);
});

test("OAuth metadata cannot move the host to another authorization origin", async () => {
  await assert.rejects(() => discoverRemoteMcpOAuth(config, {
    httpJson: async () => ({ statusCode: 200, body: {
      issuer: "https://dodo-service.example.com",
      authorization_endpoint: "https://other.example.com/authorize",
      token_endpoint: "https://dodo-service.example.com/token",
      registration_endpoint: "https://dodo-service.example.com/register",
    } }),
  }), (error) => error.code === "REMOTE_MCP_OAUTH_ORIGIN_BLOCKED");
});

test("OAuth metadata falls back only after explicit 404", async () => {
  const metadata = await discoverRemoteMcpOAuth(config, {
    httpJson: async () => ({ statusCode: 404, body: null }),
  });
  assert.equal(metadata.tokenEndpoint, "https://dodo-service.example.com/token");
  await assert.rejects(() => discoverRemoteMcpOAuth(config, {
    httpJson: async () => { throw new Error("network failed"); },
  }), /network failed/u);
});

test("OAuth HTTP transport rejects redirects without contacting their target", async () => {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    response.writeHead(302, { location: "http://127.0.0.1/elsewhere" }).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/metadata`;
    await assert.rejects(() => oauthHttpJson(endpoint, {}, {
      resolveEndpoint: async (raw) => ({
        endpoint: new URL(raw), address: "127.0.0.1", family: 4,
      }),
    }), (error) => error.code === "REMOTE_MCP_OAUTH_REDIRECT_BLOCKED");
    assert.equal(hits, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("OAuth DNS cancellation stops before any late network request", async () => {
  const controller = new AbortController();
  let finishLookup;
  const lookup = new Promise((resolve) => { finishLookup = resolve; });
  const request = oauthHttpJson("https://dodo-service.example.com/token", {
    signal: controller.signal,
  }, { resolveEndpoint: async () => lookup });
  controller.abort();
  await assert.rejects(request, (error) => error.code === "REMOTE_MCP_OAUTH_CANCELLED");
  finishLookup({ endpoint: new URL("https://dodo-service.example.com/token"), address: "8.8.8.8", family: 4 });
});

const resolved = (fingerprint) => ({
  localIdentity: {
    companyId: "11111111-1111-4111-8111-111111111111",
    memberId: "22222222-2222-4222-8222-222222222222",
    skillId: "dodo-is",
  },
  remoteMcp: { configFingerprint: fingerprint },
});

test("OAuth vault binds a Keychain session to one exact declaration", async () => {
  const items = new Map();
  const keychain = {
    read: async (service, account) => items.get(`${service}:${account}`) || null,
    write: async (service, account, value) => { items.set(`${service}:${account}`, value); },
    remove: async (service, account) => { items.delete(`${service}:${account}`); },
  };
  const vault = createRemoteMcpOAuthVault({
    platform: "darwin", credentialFile: "/unused/personal-credential.json", keychain,
  });
  const session = {
    issuer: "https://dodo-service.example.com",
    clientId: "synthetic-client",
    accessToken: "synthetic-secret-access-token",
    refreshToken: "synthetic-secret-refresh-token",
    expiresAt: Date.now() + 3_600_000,
  };
  await vault.write("https://trelio.ru", resolved("a".repeat(64)), session);
  assert.equal((await vault.read("https://trelio.ru", resolved("a".repeat(64)))).accessToken, session.accessToken);
  assert.equal(await vault.read("https://trelio.ru", resolved("b".repeat(64))), null);
  assert.equal(await vault.remove("https://trelio.ru", resolved("a".repeat(64))), true);
  assert.equal(await vault.read("https://trelio.ru", resolved("a".repeat(64))), null);
});

test("OAuth Windows vault writes only DPAPI ciphertext and rejects another fingerprint", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trelio-oauth-vault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let plaintext = null;
  const vault = createRemoteMcpOAuthVault({
    platform: "win32",
    credentialFile: path.join(directory, "personal-credential.json"),
    dpapi: {
      protect: async (_origin, value) => { plaintext = value; return "opaque-dpapi-ciphertext"; },
      unprotect: async (_origin, ciphertext) => {
        assert.equal(ciphertext, "opaque-dpapi-ciphertext");
        return plaintext;
      },
    },
  });
  await vault.write("https://trelio.ru", resolved("c".repeat(64)), {
    issuer: "https://dodo-service.example.com",
    clientId: "synthetic-client",
    accessToken: "synthetic-secret-access-token",
    refreshToken: null,
    expiresAt: Date.now() + 3_600_000,
  });
  const bytes = await readFile(path.join(directory, "oauth-session.json"), "utf8");
  assert.equal(bytes.includes("synthetic-secret-access-token"), false);
  assert.equal((await vault.read("https://trelio.ru", resolved("c".repeat(64)))).clientId, "synthetic-client");
  assert.equal(await vault.read("https://trelio.ru", resolved("d".repeat(64))), null);
});

test('same OAuth vault isolates human and managed devices even for identical provider identity', async () => {
  const items=new Map(), keychain={read:async(s,a)=>items.get(`${s}:${a}`)||null,
    write:async(s,a,v)=>{items.set(`${s}:${a}`,v);},remove:async(s,a)=>{items.delete(`${s}:${a}`);}};
  const make=namespace=>createRemoteMcpOAuthVault({platform:'darwin',credentialFile:'/unused/same.json',keychain,namespace});
  const human=make(null),first=make('assistant:synthetic:device-one'),second=make('assistant:synthetic:device-two');
  const declaration=resolved('f'.repeat(64)), session={issuer,clientId:'synthetic-client',accessToken:'synthetic-only-token',refreshToken:null,expiresAt:Date.now()+60000};
  await human.write('https://trelio.ru',declaration,session);
  assert.equal(await first.read('https://trelio.ru',declaration),null);
  await first.write('https://trelio.ru',declaration,session);
  assert.equal(await second.read('https://trelio.ru',declaration),null);
  await first.remove('https://trelio.ru',declaration);
  assert.equal((await human.read('https://trelio.ru',declaration)).clientId,session.clientId);
  assert.equal(items.size,1);
});


test("native OAuth uses the same S256 loopback with resource binding and explicit token lifetime", async () => {
  let authorization;
  const session = await connectRemoteMcpOAuth(callbackConfig, {
    clientName: "Trelio native synthetic", resource: "https://trelio.ru/mcp", maximumLifetimeSeconds: 365 * 86400,
    httpJson: createOAuthTransport(request => {
      const body = new URLSearchParams(request.body);
      assert.equal(body.get("resource"), "https://trelio.ru/mcp");
      assert.equal(createHash("sha256").update(body.get("code_verifier")).digest("base64url"), authorization.searchParams.get("code_challenge"));
      return { statusCode: 200, body: { token_type: "Bearer", access_token: "synthetic-native", expires_in: 365 * 86400 } };
    }),
    openBrowserFn: async url => {
      authorization = new URL(url); assert.equal(authorization.searchParams.get("resource"), "https://trelio.ru/mcp");
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state")); callback.searchParams.set("code", "synthetic-code");
      callback.searchParams.set("iss", issuer); assert.equal(await requestCallback(callback), 200);
    },
  });
  assert.ok(session.expiresAt > Date.now() + 300 * 86400000);
});

test("native OAuth vault cannot borrow an external skill or another namespace", async () => {
  const items = new Map(), keychain = {
    read: async (service, account) => items.get(service + account) ?? null,
    write: async (service, account, value) => { items.set(service + account, value); },
    remove: async (service, account) => { items.delete(service + account); },
  };
  const native = createRemoteMcpOAuthVault({ platform: "darwin", credentialFile: "/unused/native.json", keychain,
    nativeClient: "deepseek-harness", namespace: "native-trelio-deepseek-harness-v1" });
  const external = createRemoteMcpOAuthVault({ platform: "darwin", credentialFile: "/unused/external.json", keychain });
  const id = resolved("a".repeat(64));
  await native.write("https://trelio.ru", id, { issuer, clientId: "synthetic", accessToken: "synthetic-native", expiresAt: Date.now() + 10000 });
  assert.equal(await external.read("https://trelio.ru", id), null);
  assert.equal((await native.read("https://trelio.ru", { remoteMcp: id.remoteMcp })).accessToken, "synthetic-native");
});


// Drive the production credential loader with the real vault identity/codec.
// Only the OS keyring and remote token endpoint are synthetic; no real user
// credential, browser, Trelio request or filesystem vault is consulted.
const refreshFixture = () => {
  const items = new Map();
  const keychain = {
    read: async (service, account) => items.get(service + account) ?? null,
    write: async (service, account, value) => { items.set(service + account, value); },
    remove: async (service, account) => { items.delete(service + account); },
  };
  const createVault = options => createRemoteMcpOAuthVault({ ...options, platform: "darwin", keychain });
  const declaration = { ...resolved("e".repeat(64)), remoteMcp: {
    configFingerprint: "e".repeat(64), config: { ...config, authentication: { type: "oauth2_pkce" } },
  } };
  const session = label => ({ issuer, clientId: "synthetic-client", accessToken: "synthetic-old-" + label,
    refreshToken: "synthetic-refresh-" + label, expiresAt: Date.now() - 1000 });
  const managedProfile = namespace => ({ kind: "digital_assistant", remoteMcpCredentialNamespace: namespace,
    requireToken: async () => assert.fail("no native HTTP"), prepareRequest: async () => assert.fail("no native HTTP"),
    assertRemoteMcpCurrent: async () => {}, resolveRemoteMcpCredentialDirectory: () => "/unused/managed" });
  return { createVault, declaration, session, managedProfile };
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
// These codec tests use an in-memory OS vault. Cross-process locking and native
// private I/O are exercised separately below in a disposable real directory.
const withSyntheticCredentialState = async (_root, operation) => operation();

for (const variation of ["company", "skill", "managed namespace"]) {
  test("OAuth refresh never shares tokens across " + variation, async () => {
    const { createVault, declaration, session, managedProfile } = refreshFixture();
    const other = { ...declaration, localIdentity: { ...declaration.localIdentity,
      ...(variation === "company" ? { companyId: "33333333-3333-4333-8333-333333333333" } : {}),
      ...(variation === "skill" ? { skillId: "other-mcp" } : {}),
    } };
    const namespace = variation === "managed namespace" ? "assistant:synthetic:other-device" : null;
    const firstVault = createVault({ credentialFile: "/unused/first.json", namespace: null });
    const otherVault = createVault({ credentialFile: "/unused/second.json", namespace });
    await firstVault.write("https://trelio.ru", declaration, session("first"));
    await otherVault.write("https://trelio.ru", other, session("second"));
    const started = deferred(), release = deferred(); let refreshes = 0;
    const options = { withCredentialState: withSyntheticCredentialState, createOAuthVault: createVault, refreshOAuth: async (_config, current) => {
      refreshes++; if (current.refreshToken === "synthetic-refresh-first") { started.resolve(); await release.promise; }
      return { ...current, accessToken: current.refreshToken + "-new", expiresAt: Date.now() + 3600000 };
    } };
    const first = loadPersonalCredential("https://trelio.ru", declaration, options);
    await started.promise;
    const second = namespace ? withWorkspaceExecutionProfile(managedProfile(namespace),
      () => loadPersonalCredential("https://trelio.ru", other, options)) : loadPersonalCredential("https://trelio.ru", other, options);
    // Let the second caller observe the already active first rotation. A single
    // event-loop boundary is a scheduling barrier, not a timing-based assertion.
    await new Promise(setImmediate); release.resolve();
    const result = await Promise.all([first, second]);
    assert.deepEqual(result, ["synthetic-refresh-first-new", "synthetic-refresh-second-new"]);
    assert.equal(refreshes, 2);
    assert.equal((await otherVault.read("https://trelio.ru", other)).accessToken, result[1]);
  });
}

test("OAuth caller joins its active refresh instead of reporting false reconnect", async () => {
  const { createVault, declaration, session } = refreshFixture();
  await createVault({ credentialFile: "/unused/shared.json" }).write("https://trelio.ru", declaration, session("shared"));
  const started = deferred(), release = deferred(); let refreshes = 0;
  const options = { withCredentialState: withSyntheticCredentialState, createOAuthVault: createVault, refreshOAuth: async (_config, current) => {
    refreshes++; started.resolve(); await release.promise;
    return { ...current, accessToken: "synthetic-shared-new", expiresAt: Date.now() + 3600000 };
  } };
  const first = loadPersonalCredential("https://trelio.ru", declaration, options);
  await started.promise;
  const second = loadPersonalCredential("https://trelio.ru", declaration, options);
  const outcome = Promise.allSettled([first, second]);
  await new Promise(setImmediate); release.resolve();
  assert.deepEqual(await outcome, [{ status: "fulfilled", value: "synthetic-shared-new" },
    { status: "fulfilled", value: "synthetic-shared-new" }]);
  assert.equal(refreshes, 1);
});

test("OAuth session removed before rotation returns reconnect without a TypeError or provider call", async () => {
  const { declaration, session } = refreshFixture(); let reads = 0, writes = 0, refreshes = 0;
  await assert.rejects(loadPersonalCredential("https://trelio.ru", declaration, {
    withCredentialState: withSyntheticCredentialState,
    createOAuthVault: () => ({ read: async () => ++reads === 1 ? session("removed") : null,
      write: async () => { writes++; } }),
    refreshOAuth: async () => { refreshes++; assert.fail("missing session cannot rotate"); },
  }), error => error.code === "REMOTE_MCP_OAUTH_RECONNECT_REQUIRED");
  assert.equal(writes, 0); assert.equal(refreshes, 0);
});

test("OAuth unknown refresh remains fenced and never retries its provider POST", async () => {
  const { createVault, declaration, session } = refreshFixture();
  await createVault({ credentialFile: "/unused/fenced.json" }).write("https://trelio.ru", declaration, session("fenced"));
  let refreshes = 0;
  const options = { withCredentialState: withSyntheticCredentialState, createOAuthVault: createVault, refreshOAuth: async () => {
    refreshes++; throw new Error("synthetic uncertain refresh");
  } };
  await assert.rejects(loadPersonalCredential("https://trelio.ru", declaration, options), /synthetic uncertain refresh/);
  await assert.rejects(loadPersonalCredential("https://trelio.ru", declaration, options),
    error => error.code === "REMOTE_MCP_OAUTH_RECONNECT_REQUIRED");
  assert.equal(refreshes, 1);
});


test("OAuth issuer changed between reads refuses before returning a replacement token", async () => {
  const { declaration, session } = refreshFixture(); let reads = 0, writes = 0, refreshes = 0;
  await assert.rejects(loadPersonalCredential("https://trelio.ru", declaration, {
    withCredentialState: withSyntheticCredentialState,
    createOAuthVault: () => ({ read: async () => ++reads === 1 ? session("before") : {
      ...session("replacement"), issuer: "https://other.example.test", expiresAt: Date.now() + 3600000,
    }, write: async () => { writes++; } }),
    refreshOAuth: async () => { refreshes++; assert.fail("changed issuer cannot rotate"); },
  }), error => error.code === "REMOTE_MCP_OAUTH_RECONNECT_REQUIRED");
  assert.equal(writes, 0); assert.equal(refreshes, 0);
});

test("OAuth cancelled joiner cannot receive another caller's eventual token", async () => {
  const { createVault, declaration, session } = refreshFixture();
  await createVault({ credentialFile: "/unused/cancel.json" }).write("https://trelio.ru", declaration, session("cancel"));
  const started = deferred(), release = deferred(); const controller = new AbortController(); let refreshes = 0;
  const options = { withCredentialState: withSyntheticCredentialState, createOAuthVault: createVault, refreshOAuth: async (_config, current) => {
    refreshes++; started.resolve(); await release.promise;
    return { ...current, accessToken: "synthetic-not-for-cancelled-caller", expiresAt: Date.now() + 3600000 };
  } };
  const first = loadPersonalCredential("https://trelio.ru", declaration, options);
  await started.promise;
  const second = loadPersonalCredential("https://trelio.ru", declaration, { ...options, signal: controller.signal });
  const outcomes = Promise.allSettled([first, second]);
  await new Promise(setImmediate); controller.abort(); release.resolve();
  const [success, cancelled] = await outcomes;
  assert.equal(success.status, "fulfilled"); assert.equal(cancelled.status, "rejected");
  assert.equal(cancelled.reason.name, "AbortError"); assert.equal(refreshes, 1);
});

test('forget waits for an active OAuth rotation and cannot resurrect its credential', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'trelio-oauth-forget-race-')));
  const { createVault, declaration, session, managedProfile } = refreshFixture();
  const profile = { ...managedProfile('assistant:synthetic:forget-race'), resolveRemoteMcpCredentialDirectory: () => root };
  const started = deferred(), release = deferred();
  try {
    await withWorkspaceExecutionProfile(profile, async () => {
      const vault = createVault({ credentialFile: '/unused/synthetic', namespace: profile.remoteMcpCredentialNamespace });
      await vault.write('https://trelio.ru', declaration, session('forget'));
      const options = { createOAuthVault: createVault, refreshOAuth: async (_config, current) => {
        started.resolve(); await release.promise;
        return { ...current, accessToken: 'synthetic-rotated', expiresAt: Date.now() + 3600000 };
      } };
      const first = loadPersonalCredential('https://trelio.ru', declaration, options);
      await started.promise;
      const forgotten = forgetPersonalCredential('https://trelio.ru', declaration, options);
      await new Promise(setImmediate); release.resolve();
      await first; assert.equal(await forgotten, true);
      assert.equal(await vault.read('https://trelio.ru', declaration), null);
    });
  } finally { release.resolve(); await rm(root, { recursive: true, force: true }); }
});

for (const uncertain of [false, true]) test(`independent MCP processes share one OAuth rotation; uncertain=${uncertain}`, { timeout: 45_000 }, async () => {
  // Only the OS keyring and token endpoint are synthetic. Both child hosts use
  // production vault identity/codec, credential loader and native account lock.
  // A real POST is held while the second process enters; no token reaches the
  // parent stdout, model-visible error or process argv/environment.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "trelio-oauth-two-hosts-")));
  const vaultFile = path.join(root, "synthetic-os-vault.json");
  const { declaration, session } = refreshFixture();
  const next = { ...session("cross-process"), accessToken: "synthetic-rotated", expiresAt: Date.now() + 3600000 };
  await writePrivateJsonFile(vaultFile, { serialized: JSON.stringify({ schemaVersion: 1,
    account: (await import("../host-runtime/scripts/trelio-remote-mcp-oauth-vault.mjs")).remoteMcpOAuthSessionAccount("https://trelio.ru", declaration),
    fingerprint: declaration.remoteMcp.configFingerprint, ...session("cross-process") }) });
  const started = deferred(), release = deferred(); let posts = 0;
  const server = http.createServer(async (request, response) => {
    posts++; request.resume(); started.resolve(); await release.promise;
    if (uncertain) response.destroy();
    else { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(next)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const moduleUrl = name => new URL(`../host-runtime/scripts/${name}.mjs`, import.meta.url).href;
  const script = `
    import { loadPersonalCredential } from ${JSON.stringify(moduleUrl("trelio-remote-mcp"))};
    import { createRemoteMcpOAuthVault } from ${JSON.stringify(moduleUrl("trelio-remote-mcp-oauth-vault"))};
    import { readPrivateJsonFile, writePrivateJsonFile } from ${JSON.stringify(moduleUrl("trelio-workspace"))};
    const file = ${JSON.stringify(vaultFile)};
    const options = { createOAuthVault: input => { const vault = createRemoteMcpOAuthVault({ ...input, platform: "linux",
      linuxSecretTool: async (mode, _account, serialized) => mode === "lookup"
        ? (await readPrivateJsonFile(file)).serialized : writePrivateJsonFile(file, { serialized }) });
      return { ...vault, read: async (...args) => { const value = await vault.read(...args);
        if (value?.refreshInProgress) process.send({ stage: "contended" }); return value; } }; },
      refreshOAuth: async () => { const result = await fetch(${JSON.stringify(`http://127.0.0.1:${server.address().port}/token`)}, { method: "POST" }); return result.json(); } };
    process.send({ stage: "entered" });
    try { const token = await loadPersonalCredential("https://trelio.ru", ${JSON.stringify(declaration)}, options);
      process.send({ stage: "done", ready: token === "synthetic-rotated" }); }
    catch (error) { process.send({ stage: "done", refusal: error.code === "REMOTE_MCP_OAUTH_RECONNECT_REQUIRED" ? "reconnect" : "uncertain" }); }
  `;
  const children = [], closures = [];
  const start = () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TRELIO_CONFIG_HOME: path.join(root, "config") }, timeout: 35_000,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(child);
    let bytes = 0;
    for (const stream of [child.stdout, child.stderr]) stream.on("data", value => { bytes += value.length; });
    const entered = deferred(), contended = deferred(), done = deferred();
    child.on("message", value => { if (value.stage === "entered") entered.resolve(); if (value.stage === "contended") contended.resolve(); if (value.stage === "done") done.resolve(value); });
    const closed = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", code => code === 0 && bytes === 0 ? resolve() : reject(new Error("synthetic child failed without diagnostic output")));
    });
    closures.push(closed.catch(() => undefined));
    return { entered: entered.promise, contended: contended.promise, done: done.promise, closed };
  };
  try {
    const beforeDone = (stage, child) => Promise.race([stage, child.done.then(value => {
      throw new Error(`synthetic child settled before barrier: ${value.refusal || 'ready'}`);
    }), child.closed.then(() => { throw new Error('synthetic child closed before barrier'); })]);
    const first = start(); await beforeDone(started.promise, first);
    const second = start(); await beforeDone(second.contended, second);
    release.resolve();
    const [one, two] = await Promise.all([first.done, second.done]);
    await Promise.all([first.closed, second.closed]);
    assert.equal(posts, 1, "the second process must not replay the POST");
    if (uncertain) { assert.equal(one.refusal, "uncertain"); assert.equal(two.refusal, "reconnect"); }
    else { assert.equal(one.ready, true); assert.equal(two.ready, true); }
    const saved = JSON.parse((await readPrivateJsonFile(vaultFile)).serialized);
    assert.equal(saved.refreshInProgress, uncertain);
  } finally {
    release.resolve();
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(closures);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
