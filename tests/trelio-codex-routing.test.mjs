import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_TRELIO_DIRECT_TOOL_NAMESPACES,
  CodexRoutingConfigError,
  applyCodexTrelioHookRouting,
  buildCodexLegacyMcpRemovalPatch,
  buildCodexRoutingConfigPatch,
  migrateCodexLegacyTrelioMcpForRuntime,
  planCodexTrelioHookRouting,
  removeCodexLegacyTrelioMcpRegistration,
  resolveCodexConfigPath,
} from "../host-runtime/scripts/trelio-codex-routing.mjs";

test("Codex config path follows CODEX_HOME and the Windows user profile", () => {
  assert.equal(resolveCodexConfigPath({
    platform: "win32",
    environment: { USERPROFILE: "C:\\Users\\Ada" },
    homeDirectory: "C:\\Fallback",
  }), "C:\\Users\\Ada\\.codex\\config.toml");
  assert.equal(resolveCodexConfigPath({
    platform: "win32",
    environment: { CODEX_HOME: "D:\\CodexData", USERPROFILE: "C:\\Users\\Ada" },
    homeDirectory: "C:\\Fallback",
  }), "D:\\CodexData\\config.toml");
});

test("legacy Trelio MCP patch removes the exact server and all descendant tables", () => {
  const source = [
    "model = \"gpt-test\"",
    "",
    "[mcp_servers.\"trelio-mcp\"]",
    "command = \"node\"",
    "args = [\"legacy-server.mjs\"]",
    "",
    "[mcp_servers.\"trelio-mcp\".env]",
    "LEGACY_ONLY = \"1\"",
    "",
    "[mcp_servers.trelio-mcp.tools.get_task]",
    "enabled = false",
    "",
    "[mcp_servers.\"trelio-mcp-dev\"]",
    "command = \"keep-me\"",
    "",
    "[mcp_servers.trelio]",
    "url = \"https://trelio.example/mcp\"",
    "",
  ].join("\n");

  const patch = buildCodexLegacyMcpRemovalPatch(source);

  assert.equal(patch.status, "action_required");
  assert.doesNotMatch(patch.nextSource, /legacy-server|LEGACY_ONLY|tools\.get_task/u);
  assert.match(patch.nextSource, /\[mcp_servers\."trelio-mcp-dev"\]/u);
  assert.match(patch.nextSource, /command = "keep-me"/u);
  assert.match(patch.nextSource, /\[mcp_servers\.trelio\]/u);
  assert.match(patch.nextSource, /https:\/\/trelio\.example\/mcp/u);
  assert.equal(buildCodexLegacyMcpRemovalPatch(patch.nextSource).status, "ready");
});

test("legacy Trelio MCP patch removes exact dotted assignments only", () => {
  const source = [
    "mcp_servers.trelio-mcp.command = \"remove-me\"",
    "mcp_servers.\"trelio-mcp\".args = [\"remove-me-too\"]",
    "mcp_servers.trelio-mcp-dev.command = \"keep-me\"",
    "",
  ].join("\r\n");

  const patch = buildCodexLegacyMcpRemovalPatch(source);

  assert.equal(patch.status, "action_required");
  assert.doesNotMatch(patch.nextSource, /remove-me/u);
  assert.match(patch.nextSource, /trelio-mcp-dev\.command = "keep-me"\r\n/u);
  assert.equal(patch.nextSource.replaceAll("\r\n", "").includes("\n"), false);
});

test("legacy Trelio MCP migration is automatic, value-free and idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trelio-codex-legacy-mcp-"));
  const configPath = path.join(directory, "config.toml");
  try {
    await writeFile(configPath, [
      "secret_setting = \"must-stay-private\"",
      "",
      "[mcp_servers.trelio-mcp]",
      "command = \"legacy\"",
      "",
      "[mcp_servers.trelio]",
      "url = \"https://trelio.example/mcp\"",
      "",
    ].join("\n"), { mode: 0o600 });

    const removed = await removeCodexLegacyTrelioMcpRegistration({ configPath });
    assert.deepEqual(removed, {
      schemaVersion: 1,
      status: "removed",
      serverName: "trelio-mcp",
      restartRequired: true,
    });
    assert.doesNotMatch(JSON.stringify(removed), /must-stay-private|trelio-codex-legacy/u);
    const nextSource = await readFile(configPath, "utf8");
    assert.match(nextSource, /secret_setting = "must-stay-private"/u);
    assert.doesNotMatch(nextSource, /\[mcp_servers\.trelio-mcp\]/u);
    assert.match(nextSource, /\[mcp_servers\.trelio\]/u);

    assert.deepEqual(await removeCodexLegacyTrelioMcpRegistration({ configPath }), {
      schemaVersion: 1,
      status: "not_found",
      serverName: "trelio-mcp",
      restartRequired: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime migration skips Claude and converts Codex write failures to a typed blocker", async () => {
  let migrationCalls = 0;
  const skipped = await migrateCodexLegacyTrelioMcpForRuntime({
    environment: {
      CLAUDE_PLUGIN_ROOT: "/plugin",
      // A shell may carry this unrelated variable into Claude Code; it must
      // not turn a Claude plugin process into a Codex migration owner.
      CODEX_HOME: "/inherited/codex",
    },
    migrate: async () => {
      migrationCalls += 1;
      return { status: "removed" };
    },
  });
  assert.equal(skipped.status, "not_applicable");
  assert.equal(migrationCalls, 0);

  const blocked = await migrateCodexLegacyTrelioMcpForRuntime({
    environment: { CODEX_HOME: "/codex" },
    migrate: async () => {
      throw new CodexRoutingConfigError(
        "TRELIO_CODEX_ROUTING_CONFIG_UNSAFE",
        "config is a symlink",
      );
    },
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.error.code, "TRELIO_CODEX_ROUTING_CONFIG_UNSAFE");
  assert.match(blocked.error.message, /config is a symlink/u);
});

test("routing patch creates one focused Code Mode table", () => {
  const patch = buildCodexRoutingConfigPatch("model = \"gpt-test\"\n");

  assert.equal(patch.status, "action_required");
  assert.deepEqual(patch.missingNamespaces, CODEX_TRELIO_DIRECT_TOOL_NAMESPACES);
  assert.equal(
    patch.nextSource,
    "model = \"gpt-test\"\n\n[features.code_mode]\n"
      + "direct_only_tool_namespaces = [\"mcp__trelio\",\"mcp__trelio_remote_skills\"]\n",
  );
});

test("routing patch merges existing namespaces and preserves CRLF plus trailing comments", () => {
  const source = [
    "[features.code_mode]",
    "direct_only_tool_namespaces = [\"mcp__other\", \"mcp__trelio\"] # keep",
    "",
    "[features]",
    "hooks = true",
    "",
  ].join("\r\n");
  const patch = buildCodexRoutingConfigPatch(source);

  assert.equal(patch.status, "action_required");
  assert.deepEqual(patch.missingNamespaces, ["mcp__trelio_remote_skills"]);
  assert.match(
    patch.nextSource,
    /direct_only_tool_namespaces = \["mcp__other", "mcp__trelio", "mcp__trelio_remote_skills"\] # keep\r\n/u,
  );
  assert.equal(patch.nextSource.replaceAll("\r\n", "").includes("\n"), false);

  const ready = buildCodexRoutingConfigPatch(patch.nextSource);
  assert.equal(ready.status, "ready");
  assert.equal(ready.nextSource, patch.nextSource);
});

test("routing patch keeps an existing table and unrelated settings", () => {
  const source = [
    "[features.code_mode]",
    "enabled = false",
    "",
    "[projects.\"C:/work\"]",
    "trust_level = \"trusted\"",
    "",
  ].join("\n");
  const patch = buildCodexRoutingConfigPatch(source);

  assert.match(
    patch.nextSource,
    /enabled = false\n\ndirect_only_tool_namespaces = \["mcp__trelio","mcp__trelio_remote_skills"\]\n\n\[projects\./u,
  );
  assert.match(patch.nextSource, /trust_level = "trusted"/u);
});

test("routing patch recognizes quoted Code Mode table keys", () => {
  const source = [
    "[features.\"code\\U0000005Fmode\"]",
    "'direct_only_tool_namespaces' = ['mcp__other']",
    "",
  ].join("\n");
  const patch = buildCodexRoutingConfigPatch(source);

  assert.equal(patch.status, "action_required");
  assert.match(
    patch.nextSource,
    /'direct_only_tool_namespaces' = \['mcp__other', "mcp__trelio", "mcp__trelio_remote_skills"\]/u,
  );
  assert.doesNotMatch(patch.nextSource, /\n\[features\.code_mode\]\n/u);
});

test("routing patch migrates the legacy Codex feature boolean without changing its value", () => {
  for (const enabled of ["true", "false"]) {
    const source = [
      "[features]",
      `code_mode = ${enabled} # keep state`,
      "hooks = true",
      "",
    ].join("\r\n");
    const patch = buildCodexRoutingConfigPatch(source);

    assert.equal(patch.status, "action_required");
    assert.equal(patch.migratesLegacyBoolean, true);
    assert.doesNotMatch(patch.nextSource, /^code_mode\s*=/mu);
    assert.match(patch.nextSource, /\[features\]\r\nhooks = true/u);
    assert.match(
      patch.nextSource,
      new RegExp(`\\[features\\.code_mode\\]\\r\\nenabled = ${enabled} # keep state`, "u"),
    );
    assert.equal(patch.nextSource.replaceAll("\r\n", "").includes("\n"), false);
  }
});

test("routing patch fails closed for ambiguous tables and commented target arrays", () => {
  assert.throws(
    () => buildCodexRoutingConfigPatch("features = { code_mode = { enabled = true } }\n"),
    (error) => error instanceof CodexRoutingConfigError
      && error.code === "TRELIO_CODEX_ROUTING_CONFIG_UNSUPPORTED",
  );
  assert.throws(
    () => buildCodexRoutingConfigPatch("[features]\ncode_mode = { enabled = false }\n"),
    (error) => error instanceof CodexRoutingConfigError
      && error.code === "TRELIO_CODEX_ROUTING_CONFIG_UNSUPPORTED",
  );
  assert.throws(
    () => buildCodexRoutingConfigPatch("features.code_mode.enabled = true\n"),
    (error) => error instanceof CodexRoutingConfigError
      && error.code === "TRELIO_CODEX_ROUTING_CONFIG_UNSUPPORTED",
  );
  assert.throws(
    () => buildCodexRoutingConfigPatch([
      "[features.code_mode]",
      "direct_only_tool_namespaces = [",
      "  \"mcp__other\", # user note",
      "]",
      "",
    ].join("\n")),
    (error) => error instanceof CodexRoutingConfigError
      && error.code === "TRELIO_CODEX_ROUTING_CONFIG_UNSUPPORTED",
  );
});

test("plan is value-free and apply requires exact confirmation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trelio-codex-routing-"));
  const configPath = path.join(directory, "config.toml");
  try {
    await writeFile(configPath, "api_key = \"must-not-leak\"\n", { mode: 0o600 });
    const plan = await planCodexTrelioHookRouting({ configPath });

    assert.equal(plan.status, "action_required");
    assert.match(plan.planHash, /^[0-9a-f]{64}$/u);
    assert.deepEqual(plan.change.add, CODEX_TRELIO_DIRECT_TOOL_NAMESPACES);
    assert.doesNotMatch(JSON.stringify(plan), /must-not-leak|trelio-codex-routing-/u);
    assert.match(plan.verification, /вернитесь в этот же чат/u);
    assert.match(plan.verification, /Новый чат того же проекта нужен только если/u);
    assert.doesNotMatch(plan.verification, /новую задачу/u);

    await assert.rejects(
      applyCodexTrelioHookRouting({ configPath, planHash: plan.planHash, confirmed: false }),
      (error) => error.code === "TRELIO_CODEX_ROUTING_CONFIRMATION_REQUIRED",
    );
    const applied = await applyCodexTrelioHookRouting({
      configPath,
      planHash: plan.planHash,
      confirmed: true,
    });
    assert.equal(applied.status, "applied");
    assert.equal(applied.restartRequired, true);
    assert.match(applied.verification, /вернитесь в этот же чат/u);
    assert.match(applied.verification, /Новый чат того же проекта нужен только если/u);
    assert.doesNotMatch(applied.verification, /новую задачу/u);
    assert.match(await readFile(configPath, "utf8"), /mcp__trelio_remote_skills/u);

    const ready = await planCodexTrelioHookRouting({ configPath });
    assert.equal(ready.status, "ready");
    assert.equal(ready.planHash, null);
    assert.match(ready.verification, /Пользовательский config Codex/u);
    assert.match(ready.verification, /текущем чате/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("apply rejects a stale plan without overwriting the newer config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trelio-codex-routing-stale-"));
  const configPath = path.join(directory, "config.toml");
  try {
    await writeFile(configPath, "model = \"first\"\n");
    const plan = await planCodexTrelioHookRouting({ configPath });
    await writeFile(configPath, "model = \"newer\"\n");

    await assert.rejects(
      applyCodexTrelioHookRouting({
        configPath,
        planHash: plan.planHash,
        confirmed: true,
      }),
      (error) => error.code === "TRELIO_CODEX_ROUTING_PLAN_STALE",
    );
    assert.equal(await readFile(configPath, "utf8"), "model = \"newer\"\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plan refuses a non-file config target", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trelio-codex-routing-unsafe-"));
  const configPath = path.join(directory, "config.toml");
  try {
    await mkdir(configPath);
    await assert.rejects(
      planCodexTrelioHookRouting({ configPath }),
      (error) => error.code === "TRELIO_CODEX_ROUTING_CONFIG_UNSAFE",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
