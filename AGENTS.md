# AGENTS.md

## Назначение репозитория

Этот публичный репозиторий – канонический источник generic Trelio host runtime.
Устанавливаемая stable plugin shell живёт отдельно в
[`trelio-ru/agent-workspaces`](https://github.com/trelio-ru/agent-workspaces).

В этот репозиторий входят только:

- `host-runtime/**` – bridge, lifecycle hook implementation, local MCP и общие
  security/runtime primitives;
- `scripts/build-host-runtime-package.mjs` – deterministic unsigned package
  builder; production signing и activation принадлежат backend Trelio;
- runtime и cross-repository compatibility tests;
- runtime CI и документация.

Marketplace manifests, plugin hooks, launchers, loader/verifier, skills и assets
сюда не копируются. Provider-specific runtimes, backend, signing keys и production
publication tooling также остаются вне этого публичного репозитория.

## Общие правила

- Подробно комментируй нетривиальный код, особенно security, transport, ACL,
  credential и cross-platform решения.
- Не добавляй tokens, credentials, cookies, sessions, workspace content, signing
  keys или production runtime packages в Git, fixtures и logs.
- Не ослабляй exact confirmation, idempotency/CAS, bounds, attestation, package
  verification и encrypted-company fail-closed behavior.
- После неоднозначной mutation сначала установи live state; blind retry запрещён.
- Server-returned paths и commands трактуются буквально. Runtime не сканирует
  plugin cache и не выбирает похожую установленную версию.
- Browser-навыки используют общий host-owned `browser-session-v1`: signed
  descriptor выбирает класс хранения, absolute lease и opt-in manual assist;
  host один раз реализует browser discovery, Playwright bootstrap, process
  lifecycle и profile lock. Provider-specific navigation, selectors, read
  guards и mutation authority в generic host не переносятся; профили разных
  навыков не объединяются.
- Сохраняй чужие изменения и отделяй scope текущей задачи.

## Граница plugin/runtime

- Plugin shell и host runtime имеют независимые release histories и versions.
  Изменение runtime само по себе не требует plugin release.
- Публичный ABI между ними включает signed package format, три entrypoint mode
  `bridge|hook|mcp`, descriptor fields, `minimumPluginVersion`, environment
  variables, headers и typed upgrade errors.
- Production loader передаёт exact `TRELIO_PLUGIN_ROOT`,
  `TRELIO_PLUGIN_VERSION`, `TRELIO_HOST_RUNTIME_VERSION` и immutable runtime
  source directory. Runtime не предполагает совместное source tree.
- `host-runtime/scripts/report-context-budget.mjs` – maintainer-only report и не
  входит в package. Он принимает exact plugin checkout через `--plugin-root` либо
  `TRELIO_AGENT_WORKSPACES_PLUGIN_ROOT`; plugin source не vendored.
- Cross-repository tests используют реальный plugin checkout через
  `TRELIO_AGENT_WORKSPACES_PLUGIN_ROOT`. CI checkout является read-only input и
  не попадает в package.
- Production runtime source меняется только вместе с targeted tests и актуальным
  контрактом. Generated package вручную не редактируется и не коммитится.

## Git workflow

- Канонический checkout регистрируется через `npm run git:configure-main` и
  остаётся clean на `main`.
- Перед правкой выполни `git fetch --prune origin`, `git status -sb` и
  `git rev-list --left-right --count HEAD...@{upstream}`.
- Работай в отдельном worktree/ветке `codex/*`, созданном через
  `npm run git:new-worktree -- codex/<task-slug>`.
- Завершённая правка получает commit на русском и интегрируется только через
  `npm run git:push-main`; raw push в `main` запрещён.
- После интеграции выполни из canonical checkout
  `npm run git:finish-worktree -- <absolute-task-worktree>`.
- Stable runtime tag создаётся только по явной команде на runtime release и
  пушится атомарно через `npm run git:push-main -- --tag vX.Y.Z`.

## Проверки

- Сначала запускай узкие изменённые tests, затем весь список direct Node tests из
  `.github/workflows/runtime-tests.yml`.
- Package builder проверяй двумя сборками одной версии и byte comparison.
- Cross-repository tests запускай с exact plugin root. Ошибка отсутствующего
  plugin checkout – setup failure, а не повод копировать plugin source.
- Перед commit проверь `git diff --check`, полный diff и clean status после commit.
