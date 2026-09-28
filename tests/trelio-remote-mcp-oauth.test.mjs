import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import {
  discoverRemoteMcpOAuth,
  oauthHttpJson,
} from "../host-runtime/scripts/trelio-remote-mcp-oauth.mjs";
import { createRemoteMcpOAuthVault } from "../host-runtime/scripts/trelio-remote-mcp-oauth-vault.mjs";

const config = {
  endpoint: "https://dodo-service.example.com/mcp",
};

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
