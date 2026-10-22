/**
 * Owner-private OAuth session storage for Remote MCP.
 *
 * Tokens never enter MCP results, Trelio, argv, environment variables or a
 * plaintext file. The stored record includes the complete declaration hash so
 * a changed endpoint, scope or tool policy cannot reuse an older grant. The
 * stable account key lets reconnect replace and forget an older grant.
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  deleteMacosPrivateKeychainValue,
  ensurePrivateDirectory,
  getMacosPrivateKeychainValue,
  protectWindowsBridgeSessionToken,
  readPrivateJsonFile,
  setMacosPrivateKeychainValue,
  unprotectWindowsBridgeSessionToken,
  writePrivateJsonFile,
} from "./trelio-workspace.mjs";

const KEYCHAIN_SERVICE = "ru.trelio.remote-mcp-oauth.v1";
const MAX_SESSION_BYTES = 32 * 1024;

const sessionAccount = (origin, resolved) => crypto.createHash("sha256")
  .update(JSON.stringify({
    origin,
    companyId: resolved.localIdentity.companyId,
    memberId: resolved.localIdentity.memberId,
    skillId: resolved.localIdentity.skillId,
  }))
  .digest("hex");

const runSecretTool = (mode, account, value = null) => new Promise((resolve, reject) => {
  const argumentsList = mode === "store"
    ? ["store", "--label=Trelio Remote MCP OAuth", "service", KEYCHAIN_SERVICE, "account", account]
    : [mode, "service", KEYCHAIN_SERVICE, "account", account];
  const child = spawn("secret-tool", argumentsList, {
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const chunks = [];
  let size = 0;
  let settled = false;
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(new Error("Системное хранилище OAuth недоступно."));
    else resolve(result);
  };
  const timer = setTimeout(() => {
    child.kill();
    finish(true);
  }, 20_000);
  child.on("error", () => finish(true));
  child.stdout.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_SESSION_BYTES) {
      child.kill();
      finish(true);
      return;
    }
    chunks.push(chunk);
  });
  child.on("close", (code) => {
    // libsecret uses exit 1 for a missing lookup/clear. Treat it as no stored
    // session only on read/delete; a failed store must never look successful.
    if (code === 1 && mode !== "store") {
      finish(null, null);
    } else if (code !== 0) {
      finish(true);
    } else {
      finish(null, Buffer.concat(chunks).toString("utf8").trimEnd());
    }
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(value === null ? "" : value);
});

export const createRemoteMcpOAuthVault = ({
  platform = process.platform,
  credentialFile,
  keychain = {
    read: getMacosPrivateKeychainValue,
    write: setMacosPrivateKeychainValue,
    remove: deleteMacosPrivateKeychainValue,
  },
  dpapi = {
    protect: protectWindowsBridgeSessionToken,
    unprotect: unprotectWindowsBridgeSessionToken,
  },
  linuxSecretTool = runSecretTool,
} = {}) => {
  if (!credentialFile) throw new TypeError("OAuth credentialFile is required.");
  const file = path.join(path.dirname(credentialFile), "oauth-session.json");

  const read = async (origin, resolved) => {
    const account = sessionAccount(origin, resolved);
    let serialized = null;
    if (platform === "darwin") {
      serialized = await keychain.read(KEYCHAIN_SERVICE, account);
    } else if (platform === "win32") {
      const stored = await readPrivateJsonFile(file);
      if (stored?.account === account && typeof stored.ciphertext === "string") {
        serialized = await dpapi.unprotect(origin, stored.ciphertext);
      }
    } else if (platform === "linux") {
      serialized = await linuxSecretTool("lookup", account);
    } else {
      throw new Error("OAuth Remote MCP не поддерживает хранилище секретов этой ОС.");
    }
    if (!serialized) return null;
    if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_BYTES) {
      throw new Error("Сохранённая OAuth-сессия превышает лимит.");
    }
    let record;
    try {
      record = JSON.parse(serialized);
    } catch {
      throw new Error("Сохранённая OAuth-сессия повреждена.");
    }
    if (
      record?.schemaVersion !== 1
      || record.account !== account
      || typeof record.fingerprint !== "string"
      || typeof record.clientId !== "string"
      || typeof record.accessToken !== "string"
      || typeof record.issuer !== "string"
      || typeof record.expiresAt !== "number"
      || (record.refreshInProgress !== undefined && typeof record.refreshInProgress !== "boolean")
    ) {
      throw new Error("Сохранённая OAuth-сессия не совпала с текущим навыком.");
    }
    if (record.fingerprint !== resolved.remoteMcp.configFingerprint) return null;
    return record;
  };

  const write = async (origin, resolved, session) => {
    const account = sessionAccount(origin, resolved);
    const serialized = JSON.stringify({
      schemaVersion: 1,
      account,
      fingerprint: resolved.remoteMcp.configFingerprint,
      ...session,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_BYTES) {
      throw new Error("OAuth-сессия превышает локальный лимит.");
    }
    if (platform === "darwin") {
      await keychain.write(KEYCHAIN_SERVICE, account, serialized);
    } else if (platform === "win32") {
      const ciphertext = await dpapi.protect(origin, serialized);
      await ensurePrivateDirectory(path.dirname(file));
      await writePrivateJsonFile(file, { schemaVersion: 1, account, ciphertext });
      const verified = await read(origin, resolved);
      if (verified.accessToken !== session.accessToken) {
        throw new Error("Windows DPAPI не подтвердил сохранённую OAuth-сессию.");
      }
    } else if (platform === "linux") {
      await linuxSecretTool("store", account, serialized);
      if (!(await read(origin, resolved))) {
        throw new Error("Системное хранилище не подтвердило OAuth-сессию.");
      }
    } else {
      throw new Error("OAuth Remote MCP не поддерживает хранилище секретов этой ОС.");
    }
  };

  const remove = async (origin, resolved) => {
    const account = sessionAccount(origin, resolved);
    if (platform === "darwin") {
      const existed = Boolean(await keychain.read(KEYCHAIN_SERVICE, account));
      if (existed) await keychain.remove(KEYCHAIN_SERVICE, account);
      return existed;
    }
    if (platform === "win32") {
      const stored = await readPrivateJsonFile(file);
      if (stored?.account !== account) return false;
      const fs = await import("node:fs/promises");
      await fs.rm(file);
      return true;
    }
    if (platform === "linux") {
      const existed = Boolean(await linuxSecretTool("lookup", account));
      if (existed) await linuxSecretTool("clear", account);
      return existed;
    }
    throw new Error("OAuth Remote MCP не поддерживает хранилище секретов этой ОС.");
  };

  return { read, write, remove };
};
