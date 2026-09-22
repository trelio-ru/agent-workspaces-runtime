#!/usr/bin/env bash
set -euo pipefail

# Единый bootstrap dependency tree для локального runtime-worktree. Сейчас в
# дереве одна devDependency, но контракт намеренно проверяет весь package.json:
# следующий test-only пакет не должен снова потребовать ручного `npm ci`.

MODE="install"
REQUESTED_ROOT=""
NPM_RETRY_ATTEMPTS="${AGENT_WORKSPACES_NPM_RETRY_ATTEMPTS:-4}"
NPM_RETRY_DELAY_SECONDS="${AGENT_WORKSPACES_NPM_RETRY_DELAY_SECONDS:-1}"

usage() {
  cat >&2 <<'EOF'
Usage: bash scripts/bootstrap-worktree-dependencies.sh [--check] [worktree-path]

Without --check, installs exact development dependencies with npm ci.
With --check, validates the existing dependency tree without network access.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --check)
      MODE="check"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      printf '[agent-workspaces-bootstrap] ERROR: unknown argument: %s\n' "$1" >&2
      usage
      exit 2
      ;;
    *)
      if [[ -n "${REQUESTED_ROOT}" ]]; then
        printf '[agent-workspaces-bootstrap] ERROR: only one worktree path is allowed.\n' >&2
        usage
        exit 2
      fi
      REQUESTED_ROOT="$1"
      shift
      ;;
  esac
done

bootstrap_log() {
  printf '[agent-workspaces-bootstrap] %s\n' "$*" >&2
}

resolve_executable() {
  local configured_command="$1"

  if [[ "${configured_command}" == */* ]]; then
    [[ -x "${configured_command}" ]] || return 1
    printf '%s\n' "${configured_command}"
    return
  fi

  command -v "${configured_command}" 2>/dev/null
}

if [[ -z "${REQUESTED_ROOT}" ]]; then
  REQUESTED_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi

if [[ -z "${REQUESTED_ROOT}" ]] || [[ ! -d "${REQUESTED_ROOT}" ]]; then
  bootstrap_log "ERROR: worktree directory does not exist: ${REQUESTED_ROOT:-<empty>}"
  exit 1
fi

WORKTREE_ROOT="$(cd "${REQUESTED_ROOT}" && pwd -P)"
GIT_ROOT="$(git -C "${WORKTREE_ROOT}" rev-parse --show-toplevel 2>/dev/null || true)"

if [[ -z "${GIT_ROOT}" ]]; then
  bootstrap_log "ERROR: path is not a Git worktree: ${WORKTREE_ROOT}"
  exit 1
fi

GIT_ROOT="$(cd "${GIT_ROOT}" && pwd -P)"
if [[ "${GIT_ROOT}" != "${WORKTREE_ROOT}" ]]; then
  bootstrap_log "ERROR: bootstrap must target the worktree root: ${GIT_ROOT}"
  bootstrap_log "Received path: ${WORKTREE_ROOT}"
  exit 1
fi

for required_file in package.json package-lock.json; do
  if [[ ! -f "${WORKTREE_ROOT}/${required_file}" ]]; then
    bootstrap_log "ERROR: required dependency manifest is missing: ${WORKTREE_ROOT}/${required_file}"
    exit 1
  fi
done

NODE_BIN="$(resolve_executable "${AGENT_WORKSPACES_NODE_BIN:-node}" || true)"
NPM_BIN="$(resolve_executable "${AGENT_WORKSPACES_NPM_BIN:-npm}" || true)"

if [[ -z "${NODE_BIN}" ]]; then
  bootstrap_log "ERROR: Node.js is unavailable; install Node.js 22 or newer."
  exit 1
fi

if [[ -z "${NPM_BIN}" ]]; then
  bootstrap_log "ERROR: npm is unavailable; install it together with Node.js 22 or newer."
  exit 1
fi

NODE_MAJOR="$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [[ ! "${NODE_MAJOR}" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 22 )); then
  bootstrap_log "ERROR: Node.js 22 or newer is required; detected major version ${NODE_MAJOR:-unknown}."
  exit 1
fi

print_recovery_command() {
  bootstrap_log "Run to repair dependencies:"
  printf '[agent-workspaces-bootstrap]   npm --prefix %q run worktree:bootstrap\n' \
    "${WORKTREE_ROOT}" >&2
}

check_dependencies() {
  if [[ ! -d "${WORKTREE_ROOT}/node_modules" ]]; then
    bootstrap_log "ERROR: dependencies are missing: ${WORKTREE_ROOT}/node_modules"
    print_recovery_command
    return 1
  fi

  # npm ls не обращается к registry и проверяет все top-level dependencies,
  # включая devDependencies вроде tiktoken, до запуска длинного набора тестов.
  if ! (
    cd "${WORKTREE_ROOT}"
    "${NPM_BIN}" ls --depth=0 --include=dev --silent >/dev/null 2>&1
  ); then
    bootstrap_log "ERROR: installed dependencies do not match package.json."
    print_recovery_command
    return 1
  fi
}

if [[ "${MODE}" == "check" ]]; then
  check_dependencies
  bootstrap_log "Development dependencies are ready."
  exit 0
fi

if [[ ! "${NPM_RETRY_ATTEMPTS}" =~ ^[1-9][0-9]*$ ]]; then
  bootstrap_log "ERROR: AGENT_WORKSPACES_NPM_RETRY_ATTEMPTS must be a positive integer."
  exit 2
fi

if [[ ! "${NPM_RETRY_DELAY_SECONDS}" =~ ^[0-9]+$ ]]; then
  bootstrap_log "ERROR: AGENT_WORKSPACES_NPM_RETRY_DELAY_SECONDS must be a non-negative integer."
  exit 2
fi

attempt=1
exit_code=0
while (( attempt <= NPM_RETRY_ATTEMPTS )); do
  bootstrap_log "Installing development dependencies from the committed lock file (attempt ${attempt}/${NPM_RETRY_ATTEMPTS})."
  if (
    cd "${WORKTREE_ROOT}"
    # npm ci можно безопасно повторить после оборванной загрузки: каждая
    # попытка заново приводит node_modules к exact package-lock. Общий npm cache
    # ускоряет новые worktree, но сами node_modules между ними не разделяются.
    "${NPM_BIN}" ci \
      --include=dev \
      --ignore-scripts \
      --prefer-offline \
      --no-audit \
      --no-fund
  ); then
    break
  else
    exit_code=$?
  fi

  if (( attempt >= NPM_RETRY_ATTEMPTS )); then
    bootstrap_log "ERROR: npm ci failed after ${attempt} attempts (exit ${exit_code})."
    print_recovery_command
    exit "${exit_code}"
  fi

  bootstrap_log "WARN: npm ci failed; retrying after a short delay."
  sleep "$((NPM_RETRY_DELAY_SECONDS * attempt))"
  attempt=$((attempt + 1))
done

# Успешный exit npm недостаточен для контракта bootstrap: отдельный read-only
# preflight подтверждает, что обязательные devDependencies реально доступны.
check_dependencies
bootstrap_log "Development dependencies are installed and verified."
