/**
 * Build the model-visible installation/onboarding plan from host-owned facts.
 *
 * The stable plugin must retain human authority and client-specific UI wording,
 * but it should not have to reimplement the Node/Git/plugin/pairing state
 * machine in Markdown. This module deliberately performs no mutations: it
 * converts the exact doctor and Codex-routing results into ordered, typed next
 * actions that a bundled skill can apply under its existing confirmation rules.
 */

import { CODEX_TRELIO_DIRECT_TOOL_INSTRUCTIONS, CODEX_TRELIO_DIRECT_TOOL_NAMESPACES } from "./trelio-codex-routing.mjs";

export const TRELIO_INSTALLATION_DIAGNOSTIC_TOOL_NAME = "diagnose_trelio_installation";

const requiresClientRestart = (requiredActions) => requiredActions.some((action) => (
  action.restartRequired === true || action.plan?.restartRequired === true
));

export const buildTrelioConnectionRecovery = (publicService, requiredActions = []) => ({
  state: ["available", "recovered"].includes(publicService?.state)
    ? "verify_current_client_tools" : "public_service_not_confirmed",
  connectionRetried: false,
  restartRequired: requiresClientRestart(requiredActions),
  instructions: "Public probes и doctor не переподключают MCP и не доказывают доступ модели. После available/recovered проверь direct schema и выполни одно безопасное обычное чтение в этом чате. Если schema действительно отсутствует в текущем ходе, перейди к client recovery для фактического клиента: это наблюдение о выдаче tools, не доказательство failed startup. Не заканчивай повтором doctor или общим отказом без следующего шага. Не объявляй старый 5xx текущей ошибкой. Без наблюдаемого client blocker или exact requiredAction не советуй restart; login, pairing и переустановка требуют своих отдельных оснований. Не придумывай команды или API reconnect.",
});

const CLIENT_KINDS = new Set(["codex", "claude-code", "cursor", "antigravity", "deepseek-harness"]);
const INTENTS = new Set(["diagnostics", "onboarding"]);

export class TrelioInstallationDiagnosticError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TrelioInstallationDiagnosticError";
    this.code = code;
  }
}

/**
 * Prepare one ordinary native read, without executing it from the local MCP.
 * Only the owning client sees its model's direct schemas and can dispatch the
 * normal hook/proof. A successful doctor, cached catalogue or empty ALL_TOOLS
 * cannot replace that evidence. Keeping selection here avoids asking the model
 * to reconstruct tool names/arguments or mistake an untested read for a failure.
 */
export const normalizeDiagnosticReadTarget = (value) => {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["companySlug", "projectSlug", "taskNumber"].includes(key))
    || typeof value.companySlug !== "string" || !/^[a-z0-9_-]{1,120}$/u.test(value.companySlug)
    || (value.projectSlug !== undefined && (typeof value.projectSlug !== "string" || !/^[a-z0-9_-]{1,120}$/u.test(value.projectSlug)))
    || (value.taskNumber !== undefined && (value.projectSlug === undefined
      || !["string", "number"].includes(typeof value.taskNumber)
      || !/^[1-9][0-9]{0,9}$/u.test(String(value.taskNumber))))) {
    throw new TrelioInstallationDiagnosticError(
      "TRELIO_INSTALLATION_DIAGNOSTIC_INVALID_INPUT",
      "readTarget requires exact companySlug, optional projectSlug and a positive taskNumber with projectSlug.",
    );
  }
  return {
    companySlug: value.companySlug,
    ...(value.projectSlug !== undefined ? { projectSlug: value.projectSlug } : {}),
    ...(value.taskNumber !== undefined ? { taskNumber: value.taskNumber } : {}),
  };
};

const buildDiagnosticReadVerification = ({ clientKind, readTarget, workingFolder, publicService, requiredActions }) => {
  const target = normalizeDiagnosticReadTarget(readTarget ?? workingFolder?.scope);
  const nextCall = target
    ? { toolName: target.taskNumber !== undefined ? "get_task" : "get_agent_instructions", arguments: target }
    : { toolName: "list_companies", arguments: {} };
  // Git is required for Workspace work, not for a remote task/rules read.
  // Conversely an established hook/routing/process blocker must be resolved
  // before a protected read; this plan never bypasses that existing boundary.
  const blockers = requiredActions.filter((action) => action.code !== "INSTALL_STANDALONE_GIT").map(({ code }) => code);
  const state = blockers.length ? "prerequisite_action_required"
    : ["available", "recovered"].includes(publicService?.state) ? "client_read_required" : "public_service_not_confirmed";
  return {
    state,
    readResult: "not_checked",
    invocation: "direct",
    ...(clientKind === "codex" ? { namespace: "mcp__trelio" } : {}),
    targetSource: readTarget ? "request" : target ? "existing_folder_binding" : "company_discovery",
    nextCall: state === "client_read_required" ? nextCall : null,
    ...(blockers.length ? { prerequisiteActions: blockers } : {}),
    insufficientEvidence: ["empty_nested_ALL_TOOLS", "public_service_available", "server_ready", "cli_inventory"],
    instructions: "При state=client_read_required выполни nextCall обычным прямым MCP-вызовом в текущем чате, вне functions.exec. Пустой ALL_TOOLS не проверяет direct schema. До фактического ответа или точного отказа клиента чтение остаётся not_checked: не объявляй инструменты недоступными и не повторяй doctor вместо чтения. Если direct schema действительно отсутствует, укажи отсутствие direct schema и чтение not_checked; не выдумывай вызов и не обходи его shell/HTTP/local proxy. После успешного чтения продолжай исходную работу; list_companies проверяет только OAuth и требует затем выбрать exact scope. Обычные ACL/proof/E2EE и отдельный refresh существующей папки сохраняются; исходную mutation не повторяй.",
  };
};

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

/**
 * These are native-client recovery instructions, never a runtime repair action.
 * The installed Codex plugin toggle reloads the owning process's configuration;
 * editing config from this separate stdio host would not perform that reload.
 * Keep the UI step with the client/user, preserve the same chat and schedules,
 * and never present toggling as a substitute for a required process restart.
 * Archive is excluded entirely: it can delete a chat's associated automation.
 */
const buildCodexMcpRecoveryInspection = (restartRequired) => ({
  state: "client_preflight_required",
  connectionRetried: false,
  restartRequired,
  userOptions: restartRequired
    ? ["fully_quit_and_reopen_application"]
    : ["toggle_trelio_plugin", "fully_quit_and_reopen_application"],
  archiveRecoveryAllowed: false,
  appliesTo: "observed_client_tool_exposure_gap_or_failed_mcp_connection",
  evidence: {
    state: "not_checked",
    accepted: ["direct_schema_absent_in_current_turn", "diagnosed_stale_or_failed_mcp_connection"],
    insufficient: ["empty_nested_ALL_TOOLS", "public_probe_timeout", "cli_inventory"],
    instructions: "Сначала проверь реально доступную direct schema текущего хода. Отсутствие только в ALL_TOOLS не является отсутствием инструмента. Если direct schema отсутствует даже при server ready, предложи восстановление выдачи tools; не приписывай серверу тайм-аут и не требуй ещё один doctor. Наличие schema ведёт к обычному direct read; его ACL/OAuth/hook-отказ разбирается по точному коду, а не через toggle.",
  },
  preferred: {
    method: "config/mcpServer/reload",
    owner: "existing_codex_app_server",
    scope: "loaded_threads",
    availability: "not_checked",
    instructions: "Только через доступный штатный API текущего owner. Новый codex app-server не обновляет подключение старого процесса; private IPC, правка приложения и повторный OAuth ради reload запрещены.",
  },
  sameThreadFallback: {
    method: "toggle_trelio_plugin",
    state: restartRequired ? "not_applicable" : "client_action_required",
    automatic: false,
    instructions: "При наблюдаемом отсутствии direct schema в текущем ходе либо подтверждённом зависшем/неудачном MCP startup предложи два варианта: выключить и включить сам плагин Trelio Agent Workspaces в настройках Codex/ChatGPT → Плагины либо полностью выйти из приложения и открыть его снова. Сначала предложи переключение плагина как вариант без полного выхода. Нужен переключатель всего плагина, не отдельного MCP-сервера; дождись выключения, затем включения и вернись в прежний чат. Шаг выполняет пользователь либо доступный штатный client tool; local runtime не автоматизирует UI и не редактирует config ради имитации reload. Если переключателя нет или проверка после переключения не прошла, используй полный выход. Exact requiredAction с restartRequired=true требует полного выхода: переключение его не заменяет. Не удаляй/переустанавливай плагин, не меняй OAuth, pairing или hook trust.",
  },
  restartAlternative: {
    method: "fully_quit_and_reopen_application",
    automatic: false,
    instructions: "Полностью завершить Codex/ChatGPT обычной командой выхода, открыть заново и вернуться в тот же чат. Закрытие окна или создание нового чата в прежнем процессе не являются полным выходом. Предложи этот вариант при наблюдаемом отсутствии direct schema, подтверждённом stale/failed MCP либо обязательном process restart; не повторяй уже выполненный restart без нового evidence и не завершай процессы автоматически.",
  },
  verification: {
    checks: ["same_thread_preserved", "linked_schedules_preserved", "fresh_mcp_starting_then_ready", "safe_direct_read_in_target_thread"],
    instructions: "После выбранного варианта вернись в тот же чат, проверь direct schema и одно безопасное обычное чтение с прежними ACL/proof/E2EE. ready подтверждает соединение, но не выдачу инструментов модели. Чат не архивировать, расписания не удалять/переносить/пересоздавать: unarchive их не восстанавливает. Не посылай сообщение в другой чат без отдельного разрешения и не повторяй mutation. Неизвестную проверку обозначь not_checked.",
  },
});

const buildClientInspection = (clientKind, intent, requiredActions) => (
  clientKind === "codex"
    ? {
        // These are expected client capabilities, not observations made by
        // this stdio process. A disk config or successful MCP initialize cannot
        // tell us which direct schemas the owner delivered to the current turn.
        toolExposure: {
          state: "not_checked",
          scope: "current_chat_model_tools",
          invocation: "direct",
          expectedNamespaces: [...CODEX_TRELIO_DIRECT_TOOL_NAMESPACES],
          nestedInventoryIsComplete: false,
          checks: ["direct_tool_schema_present", "safe_direct_read_result"],
          instructions: CODEX_TRELIO_DIRECT_TOOL_INSTRUCTIONS,
        },
        hookDispatch: {
          scope: "owning_app_server_and_current_chat",
          checks: ["loaded_definition", "current_definition_trust_and_enabled", "effective_hooks_and_managed_only_policy", "pretooluse_started_and_completed"],
          instructions: "Сопоставь текущий чат и call_id с владеющим App Server, его версией, effective config и hook events. Версия CLI из PATH и новый дочерний codex.exe не доказывают версию/перезапуск owner. Имя dispatch из журнала не является tool_name hook; не выводи ошибку matcher из их различия. Если клиент не раскрывает эти сведения, сохрани unknown, без изменения trust/config/OAuth.",
        },
        ...(intent === "diagnostics" ? { mcpRecovery: buildCodexMcpRecoveryInspection(requiresClientRestart(requiredActions)) } : {}),
        pluginInventory: {
          command: "codex plugin list --json",
          proves: ["installed_plugin_version", "plugin_enabled_state"],
        },
        mcpInventory: {
          command: "codex mcp list --json",
          proves: ["remote_mcp_registration", "local_mcp_registration"],
          doesNotProve: ["oauth_bearer_usable", "hook_approved", "runtime_proof", "current_chat_model_tool_exposure"],
        },
      }
    : clientKind === "deepseek-harness" ? {
        nativeAdapter: { state: "not_checked", qualifiedVersion: "0.2.1-rc.2",
          checks: ["native_bundle_loaded", "current_request_provider_model", "safe_protected_read"],
          instructions: "Проверь native bundle в фактическом профиле Harness и текущие tools. OAuth выполняется trelio_connect, reauthorize=true только для замены отозванного/недостаточного grant. Не устанавливай Codex/Claude hooks. Успех CLI не доказывает protected read или сохранение. MCP Apps и browser-fill не поддержаны." },
      } : ["cursor", "antigravity"].includes(clientKind) ? {
        mcpInventory: {
          surface: clientKind === "antigravity" ? "Antigravity Customizations" : "Cursor Plugins and MCP settings",
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
      ...(clientKind === "antigravity" ? { antigravityVersion: local.plugin?.manifests?.antigravityVersion ?? null } : {}),
    },
    hooks: ["cursor", "antigravity", "deepseek-harness"].includes(clientKind) ? { status: "not_applicable" } : {
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

// Both entrypoints must fence the same local failures before recommending a
// read. In particular a cold Windows worker failure is not repaired by a
// successful public HTTPS probe. Git remains irrelevant to a remote read.
const buildLocalRequiredActions = (local) => {
  const actions = [];
  if (local.hookStartup?.status === "attention") actions.push({
    code: "REVIEW_WINDOWS_HOOK_STARTUP_DIAGNOSTIC",
    authority: "read_only_diagnosis",
    reasonCode: "WINDOWS_HOOK_STARTUP_NOT_READY",
    nextStep: "Сохрани local.hookStartup: готовность worker и публичный HTTPS измерены независимо. Spawn не доказывает готовность PowerShell; поздняя готовность не укладывается в лимит hook. Сравнения зависят от прогрева. Причину уточняй по локальному отчёту, не повторяя protected read и не меняя Hooks, trust, OAuth, pairing, ACL или сертификаты. Успех диагностики не доказывает успех исходного вызова.",
  });
  if (local.node?.status !== "ready") actions.push(buildNodeAction(local));
  if (local.git?.status !== "ready") actions.push(buildGitAction(local));
  if (local.plugin?.status !== "ready") actions.push(buildPluginAction(local));
  return actions;
};

/**
 * The frozen shell's bootstrap command has no clientKind/scope arguments and is
 * precisely what remains available when the local MCP tool is missing. Return
 * the SAME read and client-recovery plans here instead of a weaker doctor-only
 * paragraph. Do not infer the actual client from inherited Codex/Claude
 * environment or from co-installed manifests: the caller selects the
 * matching conditional branch. No disk config, owner IPC or business state is
 * read or changed by this pure projection; execution/evidence stay with the
 * current client, and an unknown routing check is never reported as ready.
 */
export const buildTrelioBootstrapVerification = ({ local, publicService }) => {
  const requiredActions = buildLocalRequiredActions(local);
  return {
    connectionRecovery: {
      ...buildTrelioConnectionRecovery(publicService, requiredActions),
      clientInspection: "clientRecoveryByKind",
    },
    readVerification: buildDiagnosticReadVerification({
      clientKind: null, publicService, requiredActions,
    }),
    clientRecoveryByKind: {
      clientKind: "not_checked",
      selection: "Используй только ветку фактического клиента. CLI не определяет clientKind, direct toolset или effective routing. Codex: обычный прямой MCP-вызов вне functions.exec; ветка codex применяется только после проверки её evidence. Для другого клиента используй его штатные возможности, не инструкции Codex.",
      codex: buildCodexMcpRecoveryInspection(requiresClientRestart(requiredActions)),
    },
  };
};

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
  publicService = null,
  readTarget = null,
}) => {
  const clientKind = requireEnum(rawClientKind, CLIENT_KINDS, "clientKind");
  const intent = requireEnum(rawIntent, INTENTS, "intent");
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

  const requiredActions = buildLocalRequiredActions(local);
  const startupBlocked = local.hookStartup?.status === "attention";
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

  const publicServiceBlocked = publicService && !["available", "recovered"].includes(publicService.state);
  if (publicServiceBlocked) warnings.push({
    code: "PUBLIC_TRELIO_SERVICE_NOT_CONFIRMED",
    state: publicService.state,
    effect: "public_reachability_only_no_auth_or_client_repair",
  });
  const folder = workingFolder ?? { status: "not_checked", reasonCode: "CLIENT_WORKING_FOLDER_REQUIRED" };
  return {
    schemaVersion: 1,
    clientKind,
    intent,
    status: requiredActions.length > 0 || publicServiceBlocked || (intent === "diagnostics" && ["blocked", "setup_required"].includes(folder.status))
      ? "action_required"
      : "ready_for_live_verification",
    local: buildLocalSummary(local, clientKind),
    ...(publicService ? { publicService } : {}),
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
    clientInspection: buildClientInspection(clientKind, intent, requiredActions),
    requiredActions,
    warnings,
    ...(intent === "diagnostics" ? {
      workingFolder: folder,
      readiness: {
        state: "not_confirmed",
        checks: {
          workingFolder: folder.status,
          localComponents: requiredActions.length > 0 ? "action_required" : local.status ?? "unknown",
          ...(publicService ? { publicService: publicService.state } : {}),
          oauth: "not_checked", protectedContext: "not_checked", workspaceRead: "not_checked",
          skills: "not_checked", savingResults: "not_checked",
          ...(clientKind === "codex" ? { toolExposure: "not_checked" } : {}),
        },
        reportStates: ["confirmed", "requires_action", "not_checked", "not_applicable"],
        instructions: "Report each actually checked layer separately. Local success never proves complete readiness or saving results. Continue independent read-only checks after a folder blocker. Do not create test tasks, Workspaces or Runs; do not send or centrally store the report.",
      },
    } : {}),
    liveVerification: {
      ...(intent === "diagnostics" ? {
        read: buildDiagnosticReadVerification({ clientKind, readTarget, workingFolder, publicService, requiredActions }),
        connectionRecovery: {
          ...buildTrelioConnectionRecovery(publicService, requiredActions),
          ...(clientKind === "codex" ? { clientInspection: "clientInspection.mcpRecovery" } : {}),
        },
      } : {}),
      ...(clientKind === "codex" ? {
        toolExposure: {
          state: "not_checked",
          inspection: "clientInspection.toolExposure",
          successProves: "only_the_direct_tool_and_current_turn_actually_checked",
        },
      } : {}),
      oauth: {
        state: "unverified",
        nextTool: "list_companies",
        successProves: "oauth_bearer_usable_for_current_client_process",
      },
      hook: ["cursor", "antigravity", "deepseek-harness"].includes(clientKind) ? { state: "not_applicable", nextTools: [] } : {
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
