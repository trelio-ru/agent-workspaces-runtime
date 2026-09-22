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

const CLIENT_KINDS = new Set(["codex", "claude-code"]);
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
    : {
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
const buildLocalSummary = (local) => ({
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
    },
    hooks: {
      status: local.plugin?.hooks?.status ?? "unknown",
      preToolUseScope: local.plugin?.hooks?.preToolUseScope ?? null,
      approvalStatus: local.plugin?.hooks?.approvalStatus ?? "client_managed_unknown",
    },
    issues: Array.isArray(local.plugin?.issues) ? local.plugin.issues : [],
  },
  runtimeSessions: {
    status: local.runtimeSessions?.status ?? "unknown",
    activeCount: local.runtimeSessions?.activeCount ?? 0,
    pendingCount: local.runtimeSessions?.pendingCount ?? 0,
    expiredCount: local.runtimeSessions?.expiredCount ?? 0,
    invalidCount: local.runtimeSessions?.invalidCount ?? 0,
    registrationLockCount: local.runtimeSessions?.registrationLockCount ?? 0,
    staleRegistrationLockCount: local.runtimeSessions?.staleRegistrationLockCount ?? 0,
    omittedCount: local.runtimeSessions?.omittedCount ?? 0,
  },
  connection: {
    status: local.connection?.status ?? "unknown",
    deviceSessionConfigured: local.connection?.deviceSessionConfigured === true,
    pendingPairing: local.connection?.pendingPairing === true,
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
  codexLegacyMcpMigration = null,
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

  const requiredActions = [];
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
  if (intent === "onboarding" && local.connection?.status !== "ready") {
    requiredActions.push(buildBridgeConnectionAction(local.connection));
  }

  const warnings = [];
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
  if (intent === "diagnostics" && local.connection?.status !== "ready") {
    warnings.push({
      code: "BRIDGE_CONNECTION_NOT_READY",
      status: local.connection?.status ?? "unknown",
      effect: "blocks_local_bridge_only",
    });
  }

  return {
    schemaVersion: 1,
    clientKind,
    intent,
    status: requiredActions.length > 0
      ? "action_required"
      : "ready_for_live_verification",
    local: buildLocalSummary(local),
    codexRouting: clientKind === "codex" ? codexRouting : null,
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
    liveVerification: {
      oauth: {
        state: "unverified",
        nextTool: "list_companies",
        successProves: "oauth_bearer_usable_for_current_client_process",
      },
      hook: {
        state: "client_managed_unknown",
        nextTools: ["get_agent_instructions", "get_task"],
        successProves: "approved_hook_added_valid_one_use_runtime_proof",
        failureCode: "TRELIO_RUNTIME_HOOK_REQUIRED",
      },
      separation: [
        "local_doctor_does_not_prove_oauth",
        "hook_definition_integrity_does_not_prove_client_approval",
        "plugin_installation_does_not_prove_runtime_proof",
      ],
    },
  };
};
