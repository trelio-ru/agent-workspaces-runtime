import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import {
  connectRemoteMcpOAuth,
  discoverRemoteMcpOAuth,
  oauthHttpJson,
} from "../host-runtime/scripts/trelio-remote-mcp-oauth.mjs";
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
    await assert.rejects(connectRemoteMcpOAuth(callbackConfig, {
      httpJson: createOAuthTransport(),
      openBrowserFn: async (url) => {
        callback = new URL(new URL(url).searchParams.get("redirect_uri"));
        // Виртуализируем только JS timer; сам loopback server настоящий.
        t.mock.timers.enable({ apis: ["setTimeout"] });
        setImmediate(() => t.mock.timers.tick(10 * 60 * 1_000));
      },
    }), (error) => error.code === "REMOTE_MCP_OAUTH_TIMEOUT");
  } finally {
    t.mock.timers.reset();
  }
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
