/**
 * Build the model-visible installation/onboarding plan from host-owned facts.
 *
 * The stable plugin must retain human authority and client-specific UI wording,
 * but it should not have to reimplement the Node/Git/plugin/pairing state
 * machine in Markdown. This module deliberately performs no mutations: it
 * converts the exact doctor and Codex-routing results into ordered, typed next
 * actions that a bundled skill can apply under its existing confirmation rules.
 */

export const TRELIO_INSTALLATION_DIAGNOSTIC_TOOL_NAME = "diagnose_trelio_installation";

const CLIENT_KINDS = new Set(["codex", "claude-code", "cursor"]);
const INTENTS = new Set(["diagnostics", "onboarding"]);

export class TrelioInstallationDiagnosticError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TrelioInstallationDiagnosticError";
    this.code = code;
  }
}

const requireEnum = (value, allowed, fieldName) => {
  const normalized = String(value || "").trim();
  if (!allowed.has(normalized)) {
    throw new TrelioInstallationDiagnosticError(
      "TRELIO_INSTALLATION_DIAGNOSTIC_INVALID_INPUT",
      `${fieldName} содержит неподдерживаемое значение.`,
    );
  }
  return normalized;
};

const buildClientInspection = (clientKind) => (
  clientKind === "codex"
    ? {
        hookDispatch: {
          scope: "owning_app_server_and_current_chat",
          checks: ["loaded_definition", "current_definition_trust_and_enabled", "effective_hooks_and_managed_only_policy", "pretooluse_started_and_completed"],
          instructions: "Сопоставь текущий чат и call_id с владеющим App Server, его версией, effective config и hook events. Версия CLI из PATH и новый дочерний codex.exe не доказывают версию/перезапуск owner. Имя dispatch из журнала не является tool_name hook; не выводи ошибку matcher из их различия. Если клиент не раскрывает эти сведения, сохрани unknown, без изменения trust/config/OAuth.",
        },
        pluginInventory: {
          command: "codex plugin list --json",
          proves: ["installed_plugin_version", "plugin_enabled_state"],
        },
        mcpInventory: {
          command: "codex mcp list --json",
          proves: ["remote_mcp_registration", "local_mcp_registration"],
          doesNotProve: ["oauth_bearer_usable", "hook_approved", "runtime_proof"],
        },
      }
    : clientKind === "cursor" ? {
        mcpInventory: {
          surface: "Cursor Plugins and MCP settings",
          proves: ["remote_mcp_registration", "local_mcp_registration"],
          doesNotProve: ["oauth_bearer_usable"],
        },
      } : {
        mcpInventory: {
          command: "claude mcp list",
          remoteServerName: "plugin:trelio-agent-workspaces:trelio",
          localServerName: "plugin:trelio-agent-workspaces:trelio-remote-skills",
          proves: ["remote_mcp_registration", "local_mcp_registration"],
          doesNotProve: ["oauth_bearer_usable", "hook_approved", "runtime_proof"],
        },
      }
);

const buildNodeAction = (local) => ({
  code: "INSTALL_NODE_RUNTIME",
  reasonCode: "TRELIO_NODE_22_REQUIRED",
  authority: "explicit_user_confirmation_required",
  minimumMajorVersion: local.node?.minimumMajorVersion ?? 22,
  platform: local.platform,
});

const buildGitAction = (local) => ({
  code: "INSTALL_STANDALONE_GIT",
  reasonCode: local.git?.code || "TRELIO_GIT_REQUIRED",
  authority: "client_or_os_approval",
  minimumVersion: local.git?.minimumVersion ?? "2.28.0",
  ...(local.git?.install ? { installationPlan: local.git.install } : {}),
});

const buildPluginAction = (local) => ({
  code: "REPAIR_LOADED_PLUGIN_SHELL",
  reasonCode: "TRELIO_LOADED_PLUGIN_INCONSISTENT",
  authority: "plugin_manager",
  loadedVersion: local.plugin?.loadedVersion ?? null,
  issues: Array.isArray(local.plugin?.issues) ? local.plugin.issues : [],
  preserves: ["oauth", "bridge_pairing", "runtime_sessions"],
});

const buildCodexRoutingAction = (routing) => ({
  code: "REVIEW_CODEX_DIRECT_ROUTING",
  reasonCode: "TRELIO_CODEX_DIRECT_ROUTING_REQUIRED",
  authority: "separate_explicit_confirmation_required",
  plan: {
    planHash: routing.planHash,
    change: routing.change,
    missingNamespaces: routing.missingNamespaces,
    restartRequired: routing.restartRequired,
    verification: routing.verification,
  },
  apply: {
    toolName: "apply_codex_trelio_hook_routing",
    argumentsAfterConfirmation: {
      planHash: routing.planHash,
      confirmed: true,
    },
  },
});

const buildBlockedCodexRoutingAction = (routing) => ({
  code: "REPAIR_CODEX_DIRECT_ROUTING_MANUALLY",
  reasonCode: routing.error?.code || "TRELIO_CODEX_ROUTING_CONFIG_UNSUPPORTED",
  authority: "manual_user_edit_required",
  message: routing.error?.message || "Codex config нельзя безопасно изменить автоматически.",
  preserves: ["hook_trust", "oauth", "plugin_enabled_state"],
});

const buildRemovedLegacyMcpRestartAction = () => ({
  code: "RESTART_CODEX_AFTER_LEGACY_TRELIO_MCP_REMOVAL",
  reasonCode: "TRELIO_CODEX_LEGACY_MCP_REMOVED",
  authority: "client_restart_required",
  removedServerName: "trelio-mcp",
  restartRequired: true,
  nextStep: "Полностью перезапустите Codex/ChatGPT и повторите защищённое чтение Trelio в этом же чате.",
});

const buildBlockedLegacyMcpRemovalAction = (migration) => ({
  code: "REMOVE_LEGACY_TRELIO_MCP_REGISTRATION",
  reasonCode: migration.error?.code || "TRELIO_CODEX_LEGACY_MCP_REMOVAL_FAILED",
  authority: "automatic_repair_failed",
  serverName: "trelio-mcp",
  fallbackCommand: "codex mcp remove trelio-mcp",
  restartRequired: true,
  message: migration.error?.message || "Runtime не смог автоматически удалить legacy MCP server trelio-mcp.",
});

const buildBridgeConnectionAction = (connection) => ({
  code: connection?.status === "pairing_pending"
    ? "CONTINUE_BRIDGE_PAIRING"
    : "START_BRIDGE_PAIRING",
  reasonCode: connection?.issue || (
    connection?.status === "pairing_pending"
      ? "TRELIO_BRIDGE_PAIRING_PENDING"
      : "TRELIO_BRIDGE_NOT_CONFIGURED"
  ),
  authority: "normal_tool_approval_policy",
  call: {
    toolName: "continue_trelio_workspace_action",
    arguments: {
      schemaVersion: 1,
      operation: "login",
      parameters: {},
    },
  },
  followPairingRequest: {
    toolName: "approve_agent_workspace_bridge_pairing",
    useExactReturnedFields: ["pairingId", "deviceName"],
  },
});

/**
 * Project the verbose local doctor into the bounded facts needed by the model.
 * Absolute executable/config paths, hook hashes and observed command strings are
 * useful to the host doctor but do not participate in the repair decision.
 */
const buildLocalSummary = (local, clientKind) => ({
  schemaVersion: local.schemaVersion ?? 1,
  status: local.status ?? "unknown",
  platform: local.platform ?? "unknown",
  node: {
    status: local.node?.status ?? "unknown",
    version: local.node?.version ?? null,
    minimumMajorVersion: local.node?.minimumMajorVersion ?? 22,
  },
  git: {
    status: local.git?.status ?? "unknown",
    code: local.git?.code ?? null,
    version: local.git?.version ?? null,
    minimumVersion: local.git?.minimumVersion ?? "2.28.0",
    processPathReady: local.git?.processPathReady === true,
  },
  plugin: {
    status: local.plugin?.status ?? "unknown",
    loadedVersion: local.plugin?.loadedVersion ?? null,
    manifests: {
      codexVersion: local.plugin?.manifests?.codexVersion ?? null,
      claudeVersion: local.plugin?.manifests?.claudeVersion ?? null,
      ...(clientKind === "cursor" ? { cursorVersion: local.plugin?.manifests?.cursorVersion ?? null } : {}),
    },
    hooks: clientKind === "cursor" ? { status: "not_applicable" } : {
      status: local.plugin?.hooks?.status ?? "unknown",
      preToolUseScope: local.plugin?.hooks?.preToolUseScope ?? null,
      toolRouting: local.plugin?.hooks?.toolRouting ?? { status: "unknown" },
      approvalStatus: local.plugin?.hooks?.approvalStatus ?? "client_managed_unknown",
    },
    issues: Array.isArray(local.plugin?.issues) ? local.plugin.issues : [],
  },
  hostRuntime: {
    loadedVersion: local.hostRuntime?.loadedVersion ?? null,
  },
  ...(local.hookStartup ? { hookStartup: local.hookStartup } : {}),
  runtimeSessions: {
    status: local.runtimeSessions?.status ?? "unknown",
    ...(local.runtimeSessions?.status === "not_applicable" ? {} : local.runtimeSessions?.status === "not_checked"
      ? { issue: local.runtimeSessions.issue }
      : {
        activeCount: local.runtimeSessions?.activeCount ?? 0,
        pendingCount: local.runtimeSessions?.pendingCount ?? 0,
        expiredCount: local.runtimeSessions?.expiredCount ?? 0,
        invalidCount: local.runtimeSessions?.invalidCount ?? 0,
        registrationLockCount: local.runtimeSessions?.registrationLockCount ?? 0,
        staleRegistrationLockCount: local.runtimeSessions?.staleRegistrationLockCount ?? 0,
        omittedCount: local.runtimeSessions?.omittedCount ?? 0,
      }),
  },
  connection: {
    status: local.connection?.status ?? "unknown",
    deviceSessionConfigured: local.connection?.status === "not_checked" ? null : local.connection?.deviceSessionConfigured === true,
    pendingPairing: local.connection?.status === "not_checked" ? null : local.connection?.pendingPairing === true,
    issue: local.connection?.issue ?? null,
  },
  issues: Array.isArray(local.issues) ? local.issues : [],
});

/**
 * Keep the result explicitly short of claiming end-to-end readiness. A local
 * doctor cannot see OAuth bearer usability or the client's hook-trust choice;
 * only the listed live reads can establish those independent facts.
 */
export const buildTrelioInstallationDiagnostic = ({
  clientKind: rawClientKind,
  intent: rawIntent,
  local,
  codexRouting = null,
  codexHookSettings = null,
  codexLegacyMcpMigration = null,
  workingFolder = null,
}) => {
  const clientKind = requireEnum(rawClientKind, CLIENT_KINDS, "clientKind");
  const intent = requireEnum(rawIntent, INTENTS, "intent");
  if (clientKind === "cursor" && intent !== "diagnostics") {
    throw new TrelioInstallationDiagnosticError("TRELIO_INSTALLATION_DIAGNOSTIC_INVALID_INPUT", "Cursor supports diagnostics only; Codex/Claude onboarding is not its setup route.");
  }
  if (!local || typeof local !== "object" || Array.isArray(local)) {
    throw new TrelioInstallationDiagnosticError(
      "TRELIO_INSTALLATION_DIAGNOSTIC_INVALID_RESULT",
      "Локальная диагностика не вернула structured object.",
    );
  }
  if (clientKind === "codex" && (!codexRouting || typeof codexRouting !== "object")) {
    throw new TrelioInstallationDiagnosticError(
      "TRELIO_INSTALLATION_DIAGNOSTIC_INVALID_RESULT",
      "Проверка Codex direct routing не вернула structured object.",
    );
  }

  const requiredActions = [];
  const startupBlocked = local.hookStartup?.status === "attention";
  if (startupBlocked) requiredActions.push({
    code: "REVIEW_WINDOWS_HOOK_STARTUP_DIAGNOSTIC",
    authority: "read_only_diagnosis",
    reasonCode: "WINDOWS_HOOK_STARTUP_NOT_READY",
    nextStep: "Сохрани local.hookStartup: готовность worker и публичный HTTPS измерены независимо. Spawn не доказывает готовность PowerShell; поздняя готовность не укладывается в лимит hook. Сравнения зависят от прогрева. Причину уточняй по локальному отчёту, не повторяя protected read и не меняя Hooks, trust, OAuth, pairing, ACL или сертификаты. Успех диагностики не доказывает успех исходного вызова.",
  });
  if (local.node?.status !== "ready") requiredActions.push(buildNodeAction(local));
  if (local.git?.status !== "ready") requiredActions.push(buildGitAction(local));
  if (local.plugin?.status !== "ready") requiredActions.push(buildPluginAction(local));
  if (clientKind === "codex" && codexLegacyMcpMigration?.status === "removed") {
    requiredActions.push(buildRemovedLegacyMcpRestartAction());
  } else if (clientKind === "codex" && codexLegacyMcpMigration?.status === "blocked") {
    requiredActions.push(buildBlockedLegacyMcpRemovalAction(codexLegacyMcpMigration));
  }
  if (clientKind === "codex" && codexRouting.status === "action_required") {
    requiredActions.push(buildCodexRoutingAction(codexRouting));
  } else if (clientKind === "codex" && codexRouting.status !== "ready") {
    requiredActions.push(buildBlockedCodexRoutingAction(codexRouting));
  }
  if (intent === "onboarding" && local.connection?.status !== "ready" && local.connection?.status !== "not_checked") {
    requiredActions.push(buildBridgeConnectionAction(local.connection));
  }

  const warnings = [];
  const lastHttps = local.hookStartup?.publicHttps?.at(-1);
  if (lastHttps && (lastHttps.status !== "http_response" || lastHttps.httpStatus >= 400)) {
    warnings.push({
      code: "PUBLIC_HTTPS_PROBE_FAILED",
      effect: "independent_of_windows_worker_startup",
      nextStep: "Публичный HTTPS не подтвердил успешный ответ. Сохрани DNS/TCP/TLS/HTTP и код из local.hookStartup.publicHttps. Этот запрос не использует OAuth; его отказ не разрешает login, pairing или изменение настроек. Маршрут desktop MCP может отличаться.",
    });
  }
  if (clientKind === "codex" && (
    codexHookSettings?.hooksFeatureEnabled === false
    || codexHookSettings?.legacyHooksFeatureEnabled === false
    || codexHookSettings?.events?.PreToolUse?.enabled === false
  )) {
    warnings.push({
      code: "CODEX_TRELIO_HOOK_DISABLED_IN_USER_CONFIG",
      effect: "persisted_disable_candidate_effective_state_unknown",
      nextStep: "В пользовательском config сохранено отключение hooks или Trelio PreToolUse. trusted_hash не включает hook. Проверь именно PreToolUse в Hooks текущего клиента; включение и trust выполняет пользователь. После изменения полностью перезапусти приложение и повтори одно защищённое чтение. Если настройка уже включена в текущем App Server, продолжи clientInspection.hookDispatch.",
    });
  }
  if (local.runtimeSessions?.status === "attention") {
    warnings.push({
      code: "RUNTIME_SESSIONS_REQUIRE_ATTENTION",
      counters: {
        active: local.runtimeSessions.activeCount ?? 0,
        pending: local.runtimeSessions.pendingCount ?? 0,
        expired: local.runtimeSessions.expiredCount ?? 0,
        invalid: local.runtimeSessions.invalidCount ?? 0,
        registrationLocks: local.runtimeSessions.registrationLockCount ?? 0,
        staleRegistrationLocks: local.runtimeSessions.staleRegistrationLockCount ?? 0,
        omitted: local.runtimeSessions.omittedCount ?? 0,
      },
      effect: "does_not_prove_hook_or_oauth_failure",
    });
  }
  if (intent === "diagnostics" && local.connection?.status !== "ready" && local.connection?.status !== "not_checked") {
    warnings.push({
      code: "BRIDGE_CONNECTION_NOT_READY",
      status: local.connection?.status ?? "unknown",
      effect: "blocks_local_bridge_only",
    });
  }

  const folder = workingFolder ?? { status: "not_checked", reasonCode: "CLIENT_WORKING_FOLDER_REQUIRED" };
  return {
    schemaVersion: 1,
    clientKind,
    intent,
    status: requiredActions.length > 0 || (intent === "diagnostics" && ["blocked", "setup_required"].includes(folder.status))
      ? "action_required"
      : "ready_for_live_verification",
    local: buildLocalSummary(local, clientKind),
    codexRouting: clientKind === "codex" ? codexRouting : null,
    codexHookSettings: clientKind === "codex"
      ? codexHookSettings ?? { status: "unknown", scope: "user_config_on_disk", effectiveState: "unknown" }
      : null,
    codexLegacyMcpMigration: clientKind === "codex" && codexLegacyMcpMigration
      ? {
          status: codexLegacyMcpMigration.status,
          serverName: codexLegacyMcpMigration.serverName ?? "trelio-mcp",
          restartRequired: codexLegacyMcpMigration.restartRequired === true,
          ...(codexLegacyMcpMigration.error
            ? { error: codexLegacyMcpMigration.error }
            : {}),
        }
      : null,
    clientInspection: buildClientInspection(clientKind),
    requiredActions,
    warnings,
    ...(intent === "diagnostics" ? {
      workingFolder: folder,
      readiness: {
        state: "not_confirmed",
        checks: {
          workingFolder: folder.status,
          localComponents: requiredActions.length > 0 ? "action_required" : local.status ?? "unknown",
          oauth: "not_checked", protectedContext: "not_checked", workspaceRead: "not_checked",
          skills: "not_checked", savingResults: "not_checked",
        },
        reportStates: ["confirmed", "requires_action", "not_checked", "not_applicable"],
        instructions: "Report each actually checked layer separately. Local success never proves complete readiness or saving results. Continue independent read-only checks after a folder blocker. Do not create test tasks, Workspaces or Runs; do not send or centrally store the report.",
      },
    } : {}),
    liveVerification: {
      oauth: {
        state: "unverified",
        nextTool: "list_companies",
        successProves: "oauth_bearer_usable_for_current_client_process",
      },
      hook: clientKind === "cursor" ? { state: "not_applicable", nextTools: [] } : {
        state: startupBlocked ? "blocked_by_local_startup" : "client_managed_unknown",
        nextTools: startupBlocked ? [] : ["get_agent_instructions", "get_task"],
        successProves: "approved_hook_added_valid_one_use_runtime_proof",
        failureCode: "TRELIO_RUNTIME_HOOK_REQUIRED",
        failureInterpretation: {
          missing: clientKind === "codex"
            ? "Proof отсутствует; причина ещё не установлена. Сначала учти отдельное предупреждение о сохранённом отключении. Иначе при подтверждённом trust выполни clientInspection.hookDispatch без повторного совета включить Hooks. Отсутствие записей/state не доказывает отсутствие dispatch."
            : "Proof отсутствует; причина ещё не установлена. При уже подтверждённом trust проверь загруженное определение и события PreToolUse текущей сессии Claude Code, не повторяй совет включить Hooks. Недоступные сведения оставь unknown.",
          invalidIdentity: "TRELIO_HOOK_TOOL_IDENTITY_INVALID доказывает запуск hook и отказ до отправки. Проверь exact server-returned action; не подставляй имя из dispatch-лога и не создавай proof вручную.",
        },
      },
      ...(intent === "diagnostics" ? {
        context: {
          nextTool: "get_agent_instructions",
          ...(folder.scope ? { arguments: folder.scope } : {}),
          selection: "Use the exact existing binding or explicit user scope; otherwise select the sole accessible company or ask. Never infer scope from folder names. Follow the server-selected encrypted provider; do not initialize encryption or repeat OAuth during diagnosis.",
        },
        task: {
          when: "an_exact_accessible_task_is_known_or_selected_from_list_my_tasks",
          nextTool: "get_task",
        },
        workspace: {
          when: "the_selected_task_has_an_existing_readable_workspace",
          nextTool: "prepare_agent_workspace_read",
          instructions: "Execute its exact bridge.action; read both materialized authority files before accepted materials. No Run or lease. Otherwise report not_checked.",
        },
        skills: {
          when: "relevant_enabled_skills_are_known_or_selected_from_exact_scope_guidance",
          nextTool: "get_agent_skill",
          instructions: "Load instructions/execution before only declared safe doctor/auth probes; do not set up connections, unlock secrets or execute external business actions. Lack of access is not an empty catalog.",
        },
        instructionRefresh: {
          when: "workingFolder.refresh exists and the exact scope protected read succeeded",
          instructions: "A diagnostic request includes refreshing the existing managed Trelio instructions unless the user forbids changes. Explain the exact local file delta, execute refresh.action unchanged, and verify its result. All other repairs require their existing setup/approval flow. Do not create/rebind scope, change trust/OAuth or use shell edits. Stale plans need a fresh diagnosis. Report the new-chat/session requirement after apply; unchanged templates are a no-op.",
        },
      } : {}),
      separation: [
        "local_doctor_does_not_prove_oauth",
        "hook_definition_integrity_does_not_prove_client_approval",
        "plugin_installation_does_not_prove_runtime_proof",
        "static_tool_routing_check_does_not_prove_hook_dispatch",
      ],
    },
  };
};
