# Trelio Agent Workspaces Runtime

Публичный generic host runtime для Trelio Agent Workspaces. Он выполняет
локальный Git/data plane, lifecycle hooks, local MCP, encrypted-company
материализацию и общие security/credential primitives.

Устанавливаемый плагин находится в отдельном репозитории
[`trelio-ru/agent-workspaces`](https://github.com/trelio-ru/agent-workspaces).
Пользователи устанавливают именно его: runtime загружается stable shell-ом как
подписанный content-addressed package и не устанавливается вручную.

## Граница репозиториев

Этот репозиторий владеет:

- исходниками `host-runtime/**`;
- deterministic package builder;
- runtime tests для Linux, macOS и Windows;
- cross-repository contract tests со stable plugin shell;
- offline context-budget report.

Plugin-репозиторий владеет manifests, hooks, launchers, loader/verifier, bundled
skills и assets. Backend Trelio владеет Ed25519 signing, публикацией descriptor и
package, compatibility gates и atomic activation. Signing key никогда не попадает
в GitHub Actions или этот репозиторий.

Runtime и plugin выпускаются независимо. Совместимый runtime release не меняет
plugin version и не требует marketplace update. Новый plugin release нужен только
при изменении stable shell или их публичного ABI.

## Публичный ABI

Stable shell передаёт runtime:

- один entrypoint с режимами `bridge`, `hook` и `mcp`;
- exact `TRELIO_PLUGIN_ROOT` и `TRELIO_PLUGIN_VERSION`;
- exact `TRELIO_HOST_RUNTIME_VERSION` и immutable runtime source directory;
- bounded signed package descriptor с `minimumPluginVersion`;
- существующие HTTP headers и typed compatibility/upgrade errors.

Runtime не сканирует plugin cache и не предполагает, что оба source tree лежат в
одном репозитории.

## Локальная разработка

Требуются Node.js 22+ и standalone Git 2.28+.

```bash
npm ci
export TRELIO_AGENT_WORKSPACES_PLUGIN_ROOT=/absolute/path/to/agent-workspaces/plugins/trelio-agent-workspaces
node tests/trelio-host-runtime-entry.test.mjs
node tests/trelio-workspace.test.mjs
npm run test:context-budget
```

Полный список direct test invocations закреплён в
[runtime-tests.yml](.github/workflows/runtime-tests.yml). Tests запускаются
отдельными Node processes: это исключает нестабильность parent `node --test` IPC
на hosted runners.

Deterministic unsigned package:

```bash
npm run build:host-runtime -- \
  --runtime-version 0.0.0 \
  --output /tmp/trelio-host-runtime.skillpkg
```

Builder включает только исполняемые runtime sources. Maintainer report
`report-context-budget.mjs`, tests и plugin checkout в package не попадают.

Offline context-budget report:

```bash
npm run report:context-budget -- \
  --plugin-root /absolute/path/to/agent-workspaces/plugins/trelio-agent-workspaces
```

## Релизы

Source split и обычный merge в `main` не являются runtime release. Stable tag и
production publication выполняются только по отдельному решению о выпуске новой
runtime version. Production flow строит package из exact commit этого
репозитория, подписывает его только в защищённом backend-контуре и проверяет
descriptor/package read-back до activation.

## Безопасность

См. [SECURITY.md](SECURITY.md). Не публикуйте credentials, company content,
runtime sessions, E2EE keys, signing material и production package URLs в issue,
fixture или log.
