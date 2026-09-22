#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-workspaces-bootstrap-test.XXXXXX")"

cleanup() {
  case "${TEST_ROOT}" in
    "${TMPDIR:-/tmp}"/agent-workspaces-bootstrap-test.*)
      # TEST_ROOT всегда создаётся exact mktemp выше; широкий temp-каталог сюда
      # попасть не может.
      find "${TEST_ROOT}" -depth -delete 2>/dev/null || true
      ;;
    *)
      printf 'Refusing unsafe test cleanup path: %s\n' "${TEST_ROOT}" >&2
      ;;
  esac
}
trap cleanup EXIT

FIXTURE_ROOT="${TEST_ROOT}/fixture"
MOCK_BIN="${TEST_ROOT}/mock-bin"
NPM_CALLS_FILE="${TEST_ROOT}/npm-calls"
NPM_ATTEMPTS_FILE="${TEST_ROOT}/npm-attempts"
CHECK_ERROR_FILE="${TEST_ROOT}/check-error"
OLD_NODE_ERROR_FILE="${TEST_ROOT}/old-node-error"

mkdir -p "${FIXTURE_ROOT}" "${MOCK_BIN}"
git init --initial-branch=main "${FIXTURE_ROOT}" >/dev/null

cat > "${FIXTURE_ROOT}/package.json" <<'EOF'
{"name":"runtime-fixture","version":"1.0.0","private":true,"devDependencies":{"tiktoken":"1.0.22"}}
EOF
cat > "${FIXTURE_ROOT}/package-lock.json" <<'EOF'
{"name":"runtime-fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"runtime-fixture","version":"1.0.0","devDependencies":{"tiktoken":"1.0.22"}},"node_modules/tiktoken":{"version":"1.0.22","dev":true}}}
EOF

cat > "${MOCK_BIN}/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${MOCK_NODE_MAJOR:-22}"
EOF

cat > "${MOCK_BIN}/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\t%s\n' "${PWD}" "$*" >> "${MOCK_NPM_CALLS_FILE}"

case "${1:-}" in
  ci)
    attempts="$(<"${MOCK_NPM_ATTEMPTS_FILE}")"
    attempts=$((attempts + 1))
    printf '%s\n' "${attempts}" > "${MOCK_NPM_ATTEMPTS_FILE}"
    if (( attempts <= MOCK_NPM_FAIL_UNTIL )); then
      exit 75
    fi
    mkdir -p node_modules/tiktoken
    ;;
  ls)
    [[ -d node_modules/tiktoken ]]
    ;;
  *)
    printf 'Unexpected mocked npm command: %s\n' "$*" >&2
    exit 2
    ;;
esac
EOF
chmod +x "${MOCK_BIN}/node" "${MOCK_BIN}/npm"

: > "${NPM_CALLS_FILE}"
printf '0\n' > "${NPM_ATTEMPTS_FILE}"

# Три безопасных повтора после первоначального сетевого сбоя должны довести
# exact npm ci до успешного verified dependency tree.
MOCK_NODE_MAJOR=22 \
MOCK_NPM_CALLS_FILE="${NPM_CALLS_FILE}" \
MOCK_NPM_ATTEMPTS_FILE="${NPM_ATTEMPTS_FILE}" \
MOCK_NPM_FAIL_UNTIL=3 \
AGENT_WORKSPACES_NODE_BIN="${MOCK_BIN}/node" \
AGENT_WORKSPACES_NPM_BIN="${MOCK_BIN}/npm" \
AGENT_WORKSPACES_NPM_RETRY_ATTEMPTS=4 \
AGENT_WORKSPACES_NPM_RETRY_DELAY_SECONDS=0 \
  bash "${SCRIPT_DIR}/bootstrap-worktree-dependencies.sh" \
    "${FIXTURE_ROOT}" >/dev/null

if [[ "$(<"${NPM_ATTEMPTS_FILE}")" != "4" ]] \
  || [[ ! -d "${FIXTURE_ROOT}/node_modules/tiktoken" ]]; then
  printf 'Bootstrap did not retry and install the required devDependency.\n' >&2
  exit 1
fi

if ! awk -F '\t' '$2 ~ /^ci / && $2 ~ /--include=dev/ && $2 ~ /--ignore-scripts/ { found = 1 } END { exit !found }' \
  "${NPM_CALLS_FILE}"; then
  printf 'Bootstrap npm ci call omitted required deterministic flags.\n' >&2
  exit 1
fi

# Read-only preflight не переустанавливает зависимости и ловит пропавший exact
# top-level package до запуска context-budget report.
attempts_before_check="$(<"${NPM_ATTEMPTS_FILE}")"
MOCK_NODE_MAJOR=22 \
MOCK_NPM_CALLS_FILE="${NPM_CALLS_FILE}" \
MOCK_NPM_ATTEMPTS_FILE="${NPM_ATTEMPTS_FILE}" \
MOCK_NPM_FAIL_UNTIL=0 \
AGENT_WORKSPACES_NODE_BIN="${MOCK_BIN}/node" \
AGENT_WORKSPACES_NPM_BIN="${MOCK_BIN}/npm" \
  bash "${SCRIPT_DIR}/bootstrap-worktree-dependencies.sh" \
    --check "${FIXTURE_ROOT}" >/dev/null

if [[ "$(<"${NPM_ATTEMPTS_FILE}")" != "${attempts_before_check}" ]]; then
  printf 'Read-only dependency check unexpectedly ran npm ci.\n' >&2
  exit 1
fi

find "${FIXTURE_ROOT}/node_modules/tiktoken" -depth -delete
if MOCK_NODE_MAJOR=22 \
  MOCK_NPM_CALLS_FILE="${NPM_CALLS_FILE}" \
  MOCK_NPM_ATTEMPTS_FILE="${NPM_ATTEMPTS_FILE}" \
  MOCK_NPM_FAIL_UNTIL=0 \
  AGENT_WORKSPACES_NODE_BIN="${MOCK_BIN}/node" \
  AGENT_WORKSPACES_NPM_BIN="${MOCK_BIN}/npm" \
  bash "${SCRIPT_DIR}/bootstrap-worktree-dependencies.sh" \
    --check "${FIXTURE_ROOT}" > /dev/null 2> "${CHECK_ERROR_FILE}"; then
  printf 'Dependency check accepted a missing tiktoken package.\n' >&2
  exit 1
fi

if ! grep -Fq 'worktree:bootstrap' "${CHECK_ERROR_FILE}"; then
  printf 'Dependency check did not print the exact recovery command.\n' >&2
  exit 1
fi

# Node preflight обязан завершиться до npm и назвать найденную major-версию.
if MOCK_NODE_MAJOR=21 \
  MOCK_NPM_CALLS_FILE="${NPM_CALLS_FILE}" \
  MOCK_NPM_ATTEMPTS_FILE="${NPM_ATTEMPTS_FILE}" \
  MOCK_NPM_FAIL_UNTIL=0 \
  AGENT_WORKSPACES_NODE_BIN="${MOCK_BIN}/node" \
  AGENT_WORKSPACES_NPM_BIN="${MOCK_BIN}/npm" \
  bash "${SCRIPT_DIR}/bootstrap-worktree-dependencies.sh" \
    "${FIXTURE_ROOT}" > /dev/null 2> "${OLD_NODE_ERROR_FILE}"; then
  printf 'Bootstrap accepted Node.js older than 22.\n' >&2
  exit 1
fi

if ! grep -Fq 'detected major version 21' "${OLD_NODE_ERROR_FILE}"; then
  printf 'Old Node.js error did not include the detected major version.\n' >&2
  exit 1
fi

node - "${PROJECT_ROOT}/package.json" "${PROJECT_ROOT}/scripts/create-task-worktree.sh" <<'EOF'
const { readFileSync } = require("node:fs");

const packageJson = JSON.parse(readFileSync(process.argv[2], "utf8"));
const createWorktree = readFileSync(process.argv[3], "utf8");

if (!packageJson.scripts?.["worktree:bootstrap"] || !packageJson.scripts?.["check:dependencies"]) {
  throw new Error("package.json must expose worktree bootstrap and read-only dependency checks");
}
if (!createWorktree.includes("bootstrap-worktree-dependencies.sh")) {
  throw new Error("git:new-worktree must invoke dependency bootstrap by default");
}
EOF

printf 'agent-workspaces worktree bootstrap tests passed\n'
