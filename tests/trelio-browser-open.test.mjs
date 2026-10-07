import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import {
  BrowserOpenError,
  openBrowser,
  resolveWindowsPowerShellExecutable,
} from "../host-runtime/scripts/trelio-workspace.mjs";

// Только синтетические значения: этот URI никогда не участвует в реальном OAuth.
const syntheticUrl = "https://authorization.example.test/auth?response_type=code"
  + "&client_id=test%22client&redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2Fcallback"
  + "&state=synthetic-state&code_challenge=synthetic-challenge"
  + "&scope=read+write&equals=a=b&encoded=%26%2B%3D%20%22"
  + "&unicode=%D0%A2%D0%B5%D1%81%D1%82#fragment+with=equals";

const createChild = () => {
  const child = new EventEmitter();
  const chunks = [];
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  child.input = () => Buffer.concat(chunks).toString("utf8");
  child.kill = () => {};
  return child;
};

test("Windows browser opener hands off the entire URL through private stdin", async () => {
  const child = createChild();
  let invocation;
  const opening = openBrowser(syntheticUrl, {
    platform: "win32",
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
  });
  child.emit("close", 0, null);
  await opening;

  assert.equal(child.input(), syntheticUrl, "параметры после & должны доходить целиком");
  assert.equal(invocation.command, resolveWindowsPowerShellExecutable());
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ["pipe", "ignore", "ignore"]);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.env, undefined, "URI не переносится через environment");
  assert.ok(invocation.args.includes("-NoProfile"));
  assert.ok(invocation.args.includes("-NonInteractive"));
  const script = Buffer.from(invocation.args.at(-1), "base64").toString("utf16le");
  assert.match(script, /UseShellExecute\s*=\s*\$true/u);
  assert.match(script, /Console\]::In\.ReadToEnd\(\)/u);
  assert.ok(!JSON.stringify(invocation).includes("synthetic-state"));
  assert.ok(!script.includes("synthetic-state"));
});

test("Windows browser opener preserves UTF-8 and literal shell punctuation as data", async () => {
  const child = createChild();
  const url = `${syntheticUrl}&literal=Тест + \"quote\" $value; (x) | data`;
  const opening = openBrowser(url, { platform: "win32", spawnProcess: () => child });
  child.emit("close", 0, null);
  await opening;
  assert.equal(child.input(), url);
});

test("Windows browser opener waits for helper exit rather than spawn or stdin finish", async () => {
  const child = createChild();
  let resolved = false;
  const opening = openBrowser(syntheticUrl, {
    platform: "win32", spawnProcess: () => child,
  }).then(() => { resolved = true; });
  child.emit("spawn");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.stdin.writableFinished, true);
  assert.equal(resolved, false);
  child.emit("close", 0, null);
  await opening;
  assert.equal(resolved, true);
});

const assertPrivateFailure = (error) => {
  assert.ok(error instanceof BrowserOpenError);
  assert.equal(error.code, "BROWSER_OPEN_FAILED");
  assert.equal(error.cause, undefined, "исходные process errors могут содержать ссылку");
  assert.ok(!error.stack.includes("synthetic-state"));
  return true;
};

test("Windows browser opener fails safely on helper exit and spawn errors", async (t) => {
  for (const kind of ["nonzero", "error", "throw"]) {
    await t.test(kind, async () => {
      const child = createChild();
      const opening = openBrowser(syntheticUrl, {
        platform: "win32",
        spawnProcess() {
          if (kind === "throw") throw new Error(syntheticUrl);
          return child;
        },
      });
      if (kind === "nonzero") child.emit("close", 1, null);
      if (kind === "error") child.emit("error", new Error(syntheticUrl));
      await assert.rejects(opening, assertPrivateFailure);
    });
  }
});

test("Windows browser opener handles stdin errors and synchronous write failures", async (t) => {
  for (const kind of ["EPIPE", "throw"]) {
    await t.test(kind, async () => {
      const child = createChild();
      let kills = 0;
      child.kill = () => { kills += 1; child.emit("close", 0, null); };
      if (kind === "throw") child.stdin.end = () => { throw new Error(syntheticUrl); };
      const opening = openBrowser(syntheticUrl, {
        platform: "win32", spawnProcess: () => child,
      });
      if (kind === "EPIPE") child.stdin.emit("error", new Error(syntheticUrl));
      await assert.rejects(opening, assertPrivateFailure);
      assert.equal(kills, 1);
      // Закрытие helper может породить поздний EPIPE после уже выданного отказа.
      child.stdin.emit("error", new Error(syntheticUrl));
      assert.equal(kills, 1);
    });
  }
});

test("Windows browser opener times out and stops only its helper", async () => {
  const child = createChild();
  let kills = 0;
  child.kill = () => { kills += 1; child.emit("close", 0, null); };
  await assert.rejects(openBrowser(syntheticUrl, {
    platform: "win32", spawnProcess: () => child, openerTimeoutMs: 10,
  }), (error) => assertPrivateFailure(error) && /вовремя/u.test(error.message));
  assert.equal(kills, 1);
});

test("Windows browser opener does not launch after cancellation and aborts a running helper", async (t) => {
  for (const alreadyAborted of [true, false]) {
    await t.test(String(alreadyAborted), async () => {
      const controller = new AbortController();
      const cancellation = new Error("synthetic cancellation");
      const child = createChild();
      let spawns = 0;
      let kills = 0;
      child.kill = () => { kills += 1; child.emit("close", 0, null); };
      if (alreadyAborted) controller.abort(cancellation);
      const opening = openBrowser(syntheticUrl, {
        platform: "win32", signal: controller.signal,
        spawnProcess() { spawns += 1; return child; },
      });
      if (!alreadyAborted) controller.abort(cancellation);
      await assert.rejects(opening, (error) => error === cancellation);
      assert.equal(spawns, alreadyAborted ? 0 : 1);
      assert.equal(kills, alreadyAborted ? 0 : 1);
    });
  }
});

test("Windows browser opener rejects invalid bounded input before launching", async () => {
  for (const url of ["", null, "x".repeat(32_769), "test:\0", "test:\r\n"]) {
    await assert.rejects(openBrowser(url, {
      platform: "win32", spawnProcess: () => assert.fail("invalid input launched a helper"),
    }), assertPrivateFailure);
  }
});

test("macOS and Linux browser openers preserve their existing argv and application selection", async () => {
  for (const platform of ["darwin", "linux"]) {
    const child = createChild();
    let invocation;
    const opening = openBrowser(syntheticUrl, {
      platform, application: "Safari",
      spawnProcess(command, args, options) { invocation = { command, args, options }; return child; },
    });
    child.emit("close", 0, null);
    await opening;
    assert.equal(invocation.command, platform === "darwin" ? "/usr/bin/open" : "xdg-open");
    assert.deepEqual(invocation.args, platform === "darwin" ? ["-a", "Safari", syntheticUrl] : [syntheticUrl]);
    assert.equal(invocation.options.stdio, "ignore");
    assert.equal(invocation.options.shell, false);
  }
});

test("native Windows URI handler receives the complete synthetic authorization URL", {
  skip: process.platform !== "win32" ? "требует настоящий Windows ShellExecute" : false,
  timeout: 30_000,
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio browser Тест "));
  const scheme = `trelio-url-test-${randomUUID()}`;
  const key = `HKCU\\Software\\Classes\\${scheme}`;
  const reg = path.win32.join(process.env.SYSTEMROOT || process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
  const run = (args) => promisify(execFile)(reg, args, {
    shell: false, windowsHide: true, timeout: 5_000,
  });
  const capturePath = path.join(directory, "captured synthetic url.json");
  const handlerPath = path.join(directory, "обработчик ссылки.mjs");
  let registered = false;
  try {
    await fs.copyFile(new URL("./fixtures/browser-open-url-capture.mjs", import.meta.url), handlerPath);
    // Изолированный per-user протокол использует тот же ShellExecute путь,
    // что браузер. Default HTTP handler и пользовательские настройки не меняются.
    await run(["add", key, "/ve", "/d", "Trelio synthetic URI handoff test", "/f"]);
    registered = true;
    await run(["add", key, "/v", "URL Protocol", "/d", "", "/f"]);
    await run(["add", `${key}\\shell\\open\\command`, "/ve", "/d",
      `"${process.execPath}" "${handlerPath}" "${capturePath}" "%1"`, "/f"]);
    const url = syntheticUrl
      .replace("https://authorization.example.test", `${scheme}://authorization.example.test`)
      .replace("#", "&literalUnicode=Тест#");
    await openBrowser(url, { openerTimeoutMs: 10_000 });
    const deadline = Date.now() + 10_000;
    let capture;
    while (Date.now() < deadline) {
      try {
        capture = JSON.parse(await fs.readFile(capturePath, "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.deepEqual(capture, [url], "реальный URI handler должен получить один полный URL");
  } finally {
    try {
      if (registered) await run(["delete", key, "/f"]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});
