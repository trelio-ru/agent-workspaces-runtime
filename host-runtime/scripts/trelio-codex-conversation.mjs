/** Optional Run metadata maintenance. No model turn or local chat inventory. */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ENV_KEYS = ["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "CODEX_HOME"];
const titleEnvironment = (environment) => Object.fromEntries(ENV_KEYS
  .filter((key) => typeof environment[key] === "string")
  .map((key) => [key, environment[key]]));

const resolveCodexExecutable = async (environment) => {
  const filename = process.platform === "win32" ? "codex.exe" : "codex";
  const candidates = (environment.PATH || "").split(path.delimiter)
    .filter((directory) => path.isAbsolute(directory)).map((directory) => path.join(directory, filename));
  // Desktop may launch MCP with a restricted PATH. These are exact standard
  // bundle locations, not a search through another app's private chat storage.
  if (process.platform === "darwin") {
    for (const app of ["ChatGPT", "Codex"]) {
      candidates.push(`/Applications/${app}.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`);
    }
  }
  for (const candidate of candidates) {
    try {
      const executable = await fs.realpath(candidate);
      if ((await fs.stat(executable)).isFile()) return executable;
    } catch { /* An unavailable CLI leaves the existing generic label intact. */ }
  }
  return null;
};

/**
 * Read only one server-verified ID through Codex's documented App Server.
 * includeTurns=false prevents transcript retrieval; thread/read does not
 * resume a thread, subscribe to it, or start a model. Suppress stderr because
 * even a local CLI diagnostic can include private config or content.
 */
export const readCodexConversationTitle = async (conversationId, {
  environment = process.env,
  executable,
  spawnProcess = spawn,
  signal,
  timeoutMs = 3000,
} = {}) => {
  if (!UUID.test(String(conversationId)) || signal?.aborted) return null;
  const resolvedExecutable = executable || await resolveCodexExecutable(environment);
  if (!resolvedExecutable || signal?.aborted) return null;
  return new Promise((resolve) => {
    let child;
    let done = false;
    let timer;
    let pending = "";
    let bytes = 0;
    let initialized = false;
    const finish = (title = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child?.stdin.destroy();
      child?.stdout.destroy();
      // A separate App Server is short-lived even after success. Never leave
      // a background subscriber/process behind to watch future renames.
      child?.kill("SIGKILL");
      resolve(title);
    };
    const abort = () => finish();
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    try {
      child = spawnProcess(resolvedExecutable, ["app-server", "--listen", "stdio://"], {
        env: titleEnvironment(environment), shell: false, windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
      timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.on("error", abort);
      child.on("exit", abort);
      child.stdin.on("error", abort);
      child.stdout.on("error", abort);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (done) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 256 * 1024) return finish();
        pending += chunk;
        let newline;
        while (!done && (newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { return finish(); }
          if (message.id === 1 && !initialized) {
            if (message.error || !message.result) return finish();
            initialized = true;
            send({ method: "initialized" });
            send({ id: 2, method: "thread/read", params: { threadId: conversationId, includeTurns: false } });
          } else if (message.id === 2 && initialized) {
            const thread = message.result?.thread;
            const title = typeof thread?.name === "string" ? thread.name.trim() : "";
            return finish(!message.error && thread?.id === conversationId && title && title.length <= 500 ? title : null);
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "trelio_chat_title", version: "1.0.0" } } });
    } catch { finish(); }
  });
};

/**
 * Every attempt starts from live private Run metadata, never CODEX_THREAD_ID.
 * Compare the hydrated existing title before encryption/upload. An ambiguous
 * write is not replayed; the next lifecycle event reads the live state anew.
 * Dependencies receive one deadline, so optional metadata cannot hold up work.
 */
export const syncRunCodexConversationTitle = async ({
  readConversation, readTitle = readCodexConversationTitle, protectTitle, writeTitle,
  timeoutMs = 6000,
}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const { signal } = controller;
  try {
    const conversation = await readConversation(signal);
    if (!conversation || !UUID.test(String(conversation.conversationId))
      || !/^[0-9a-f]{64}$/u.test(String(conversation.expectedStateHash))) return false;
    const title = await readTitle(conversation.conversationId, { signal });
    if (signal.aborted || typeof title !== "string" || !title.trim() || title.trim().length > 500
      || title.trim() === conversation.title) return false;
    const protectedTitle = await protectTitle(title.trim(), signal);
    if (signal.aborted) return false;
    await writeTitle({ conversationId: conversation.conversationId,
      expectedStateHash: conversation.expectedStateHash, title: protectedTitle }, signal);
    return true;
  } catch {
    // Old backend/CLI, offline, denied ACL, stale CAS or unavailable E2EE keys
    // all preserve the successful core Run operation. No auth recovery, fallback
    // transport, stdout title, model instruction or persistent plaintext cache.
    return false;
  } finally { clearTimeout(timer); }
};
