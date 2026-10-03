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

### Восстановление подключения из hook

Первый protected call без paired bridge возвращает
`TRELIO_BRIDGE_PAIRING_REQUIRED` и exact `nextCall` к обычному MCP approval.
Агент сразу продолжает текущую задачу через этот вызов, сохраняя одобрение
клиента, и повторяет исходный MCP ровно один раз после успешного approval.
Hook сам завершает PKCE exchange и регистрацию runtime; он никогда не
одобряет собственную заявку. Пользовательский отказ или запрет подключения
останавливает recovery. Новый чат и специальный промпт не нужны.

Тот же flow восстанавливает сохранённую device-session, которую сервер отверг
точным HTTP 401 `BRIDGE_SESSION_INVALID` либо `BRIDGE_SESSION_REQUIRED` при
регистрации hook. Runtime сначала делает отдельный authenticated read-only
probe. Только второй подтверждённый отказ разрешает обычный pairing. Старый
credential сохраняется до одобрения заявки и защищённой записи замены; ручной
отзыв устройства, удаление файлов, повторный OAuth и restart не требуются.
Login также проверяет сессию на сервере до сообщения «уже подключён».

Отказ прав, версия, transport/5xx и успешная повторная проверка не считаются
истёкшей сессией и не запускают pairing. При замене другим процессом runtime
использует новый token с повторной проверкой. Hook сохраняет общий deadline,
делает не больше одного повтора регистрации после замены и не повторяет
рабочие mutations. Список устройств и наличие локального credential сами по
себе не доказывают действующий доступ: source OAuth grant может истечь раньше
указанного срока device-session.

В recovery входят только публичные pairing ID/device name; verifier, токен
и ключи остаются локально. При отсутствии корректной заявки выдаётся typed
login action. Pending SessionStart observation сохраняется до регистрации,
а CLI status line обмена подавляется, чтобы stdout содержал один JSON.

## Публичный ABI

Stable shell передаёт runtime:

- один entrypoint с режимами `bridge`, `hook` и `mcp`;
- exact `TRELIO_PLUGIN_ROOT` и `TRELIO_PLUGIN_VERSION`;
- exact `TRELIO_HOST_RUNTIME_VERSION` и immutable runtime source directory;
- bounded signed package descriptor с `minimumPluginVersion`;
- существующие HTTP headers и typed compatibility/upgrade errors.

Runtime не сканирует plugin cache и не предполагает, что оба source tree лежат в
одном репозитории.

Runtime не хранит общий `BRIDGE_VERSION`: shell и host имеют две независимые
identity. Production entrypoint принимает их только через loader и прекращает
запуск при отсутствующем либо некорректном `TRELIO_PLUGIN_VERSION` или
`TRELIO_HOST_RUNTIME_VERSION`; source-tree execution использует отдельный
непубликуемый marker `0.0.0`.

Local MCP предоставляет read-only `diagnose_trelio_installation`: он объединяет
host-owned doctor Node/Git/plugin/session/pairing с Codex direct-routing plan и
возвращает ordered typed actions. Сам tool не устанавливает компоненты, не
применяет direct-routing plan, не запускает login и не объявляет hook одобренным;
OAuth и runtime proof подтверждаются отдельными live reads. До MCP initialize
Codex-host автоматически удаляет из пользовательского `config.toml` exact
legacy-регистрацию `mcp_servers.trelio-mcp` вместе с её дочерними таблицами.
Это product-owned migration без повторного подтверждения; остальные MCP server
и настройки сохраняются. После фактического удаления initialize и doctor
требуют полный restart, потому что текущий процесс Codex мог уже загрузить
`mcp__trelio_mcp__*` в свой tool catalog.
Тот же tool с `intent=folder_onboarding` классифицирует один exact
client-selected root, служебный Git и активные instruction-файлы. После выбора
company/project он возвращает preview и CAS-bound `folder_onboarding_apply` для
trusted host. Модель не анализирует refs/objects и не пишет
`AGENTS.md`/`CLAUDE.md`/`.gitignore` самостоятельно; runtime проверяет итог и
откатывает ещё принадлежащие ему записи при ошибке.
Небезопасный или неподдерживаемый Codex TOML не скрывает остальные результаты:
plan возвращает отдельное manual-only действие и по-прежнему не раскрывает путь
либо содержимое config.

Backend и runtime обмениваются только typed actions. Command-only ответы и
модельная интерпретация launcher/argv не входят в публичный ABI.

Агент исполняет возвращённые `action.arguments` через указанный server/tool:
имя поля, например `turnCheck`, не является операцией (`status`). Для шаблона
добавляются только объявленные параметры. Неизвестная операция отклоняется до
чтения registry и запуска процесса с `TRELIO_WORKSPACE_ACTION_INVALID_INPUT`.
Ошибка содержит `requiredAction=execute_returned_action_arguments`; для
известной путаницы она также называет точный источник аргументов и операцию.
Подсказка не исполняет действие и не принимает алиасы. Произвольный вход не
копируется в ошибку; успешные ответы не получают дополнительные поля.

Local company search и Workspace-file search возвращают один компактный
`nextCall`: exact continuation tool/operation плюс mapping полей выбранного
результата. Plugin reference хранит только authority/fail-closed правила, а не
дублирует устройство mirror, ranking и fetch routing.

При server-selected локальном `route=action` runtime сохраняет короткоживущий
непрозрачный provider marker, включая legacy reads proposal context. Hook
останавливает неподходящий native proposal renderer до монтирования MCP App;
для plain company marker снимается при подтверждённом native provider.


### HTTP-диагностика браузера

`trelio-browser-session.mjs` экспортирует `createDocumentHttpObserver(context,
{isAllowedUrl, ignoreStatus})` и `safeHttpFailure`. Signed browser-capable package
получает exact host-owned module URL даже без lifecycle descriptor; это не
создаёт lease и не заменяет native supervisor. Provider устанавливает observer
до навигации и проверяет `failure(page)` до определения login/UI и перед
действиями. Выход содержит только integer `httpStatus` 400–599 и approved HTTPS
`origin`; full URL, query, headers, body и raw exception не выходят из процесса.

Наблюдается только текущий main-frame document exact Page/Request. Новая
навигация очищает прежнее доказательство, поздний response старого Request,
XHR, assets, iframe и соседние страницы его не заменяют. Hash-переход SPA
сохраняет тот же document; paths/query сравниваются только в RAM. Timeout,
DNS/reset и HTTP 200 с ошибкой в HTML не получают выдуманного HTTP-кода.
Provider сохраняет интерпретацию 401/403/404, allowlist и распознавание HTTP 200
error-page; 5xx не означает logout, не разрешает credential reset, новый login,
manual fallback или replay mutation. Ошибка и безопасные поля сохраняются через
CLI, worker, control transport и closed status. Observer не делает retry/reload.

### Ошибки lifecycle hooks

Успешный `SessionStart` с `source=compact` возвращает один JSON с value-free
`additionalContext`: агент обязан до продолжения работы полностью перечитать
rules/profile текущего Run из pinned файлов, вне Run – полную authority exact
области без known keys. При недоступных источниках зависящая работа блокируется.
В сводке остаются source pointers, прогресс и прямые решения пользователя,
а восстановимый текст правил/профиля не копируется и не пересказывается.
Runtime не изменяет саму сводку клиента и не подтверждает чтение моделью.
Pending/registered session сохраняется; startup/resume не получают reminder.
Используется прежняя approved `SessionStart` definition stable shell;
изменение runtime не требует повторного одобрения hooks. Новая или изменённая
definition требует отдельного доверия клиента.

После распознавания события `PreToolUse` runtime возвращает ошибки через
`hookSpecificOutput.permissionDecision = "deny"` и `permissionDecisionReason`,
завершая процесс с кодом `0`. Это успешная доставка запрета, а не разрешение
MCP-вызова. Windows PowerShell и PowerShell 7 могут преобразовать внутренний
exit `2` в `1`; Codex не обязан блокировать tool при таком коде. Поэтому
причина не зависит от stderr внешней оболочки. JSON отказа не содержит исходные
аргументы tool, private state, ключи или proof. Lifecycle-события и нераспознанный
вход сохраняют прежний stderr/exit `2`; ошибка launcher до запуска runtime
находится вне этого обработчика.

ID текущего hook-события имеет приоритет над унаследованными ID окружения и
одинаково выбирает private state и transcript для model/effort. Все повторы
захвата registration lock входят в пятисекундный deadline. Неудаляемая stale-
блокировка возвращает `TRELIO_RUNTIME_LOCK_RECOVERY_FAILED` с кодом ошибки ОС;
её содержимое и ACL сохраняются. Отсутствие session-файла и lock после ошибки
не является доказательством отсутствия запуска hook.

### Подготовка защищённого заполнения браузера

`accessibility_unavailable` означает отсутствие пригодного AX/UIA-дерева
встроенной вкладки; отказ системного разрешения имеет отдельную причину
`access_required`. До consume runtime делает максимум три проверки временно
недоступного дерева с паузами 500 и 1000 мс. Каждая заново сверяет exact URL и
поля, закрывает прежний helper и не активирует приложение. План с activation
не повторяется: клик уже мог изменить страницу. Ошибки permission, подписи,
неоднозначности и потерянный ответ также не запускают эти повторы.

Если field-only план по-прежнему недоступен, сообщение подтверждает, что эта
попытка ещё не расходовала grant, и предлагает через штатный browser tool
показать уже открытую исходную вкладку в её чате, затем повторить то же действие
один раз. Другой профиль или новая вкладка не подставляются. Grant мог истечь
или быть использован другим вызовом: backend заново проверяет его при повторе.
При устойчивом отказе остаётся ручной вход. После consume или неоднозначной
передачи значения такой recovery не предлагается.

## Локальная разработка

Требуются Node.js 22+ и standalone Git 2.28+.

```bash
npm run worktree:bootstrap
export TRELIO_AGENT_WORKSPACES_PLUGIN_ROOT=/absolute/path/to/agent-workspaces/plugins/trelio-agent-workspaces
node tests/trelio-host-runtime-entry.test.mjs
node tests/trelio-workspace.test.mjs
npm run test:context-budget
```

`npm run git:new-worktree -- codex/<task-slug>` по умолчанию выполняет этот
bootstrap автоматически и возвращает готовую к тестам папку. Если registry
временно недоступен, созданные branch/worktree сохраняются, а команда печатает
точный безопасный способ продолжить установку без создания новой ветки.

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

Постоянные Run layers и условный `compactionRecovery` reminder измеряются
отдельно; последний приходит только после сжатия, без company rules/profile.

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

Bridge device-session защищена login Keychain на macOS и DPAPI `CurrentUser` на
Windows; Linux использует owner-only file fallback. Совместимый runtime
автоматически мигрирует прежнюю файловую запись только после проверенного
OS-protected read-back, без передачи token через argv, environment или
диагностический stdout/stderr.
Разошедшиеся protected и legacy-копии сверяются отдельными live read-only
проверками: подтверждённая сессия сохраняется, а вторую runtime удаляет только
после доказанного 401 либо успешного self-revoke.

См. [SECURITY.md](SECURITY.md). Не публикуйте credentials, company content,
runtime sessions, E2EE keys, signing material и production package URLs в issue,
fixture или log.
