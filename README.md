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

Переносимая model projection генерируется из backend
`agent-response-projection.ts`. Секция instructions выбранного навыка включает
отдельный личный слой `skill.personalRules` после локальной hydration.
Summary/reuse исключают этот текст; membership и revision (включая очистку)
входят в instruction key. Подписанный base Markdown и runtime admission не
меняются. Это additive response contract, без нового plugin ABI или minimum.

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


Tagged artifact собирается на GitHub только после проверки successful PR gate
того же exact SHA на Linux/macOS/Windows. Main/tag не повторяют уже зелёный
полный test set; новый source SHA сначала проходит новый PR gate.

### Поиск Python для Agent Skills

Python runtime требует Python 3.10+ и использует фиксированные пути, а не первый
`python` из `PATH`. В Windows проверяются стандартные machine-каталоги
`Program Files`/`Program Files (x86)` с именами `Python310`–`Python314` либо
`Python 3.10`–`Python 3.14`, затем стандартная установка текущего пользователя
`AppData\Local\Programs\Python\Python310`–`Python314` под его OS profile.
Для user-каталогов поддерживаются также суффиксы `-32`, `-64`, `-arm64`.
Последний legacy-кандидат – `Windows\py.exe -3`. Пользовательская установка
работает без обновлённого process PATH; установка для всех пользователей и
права администратора для этого не требуются. Нестандартные директории, venv
и WindowsApps aliases не добавляются автоматически.

Profile текущей OS identity определяется через `os.userInfo()`, без выбора
пользователя из окружения навыка. Canonical executable не может находиться в
workspace, temp или plugin cache; user installation не может перенаправляться
junction/symlink за свой фиксированный каталог. Probe и запуск используют
`-I -B` и очищенное окружение. Signed runtime root добавляется в `sys.path`
только для его собственных sibling imports. Установленная Python stack и OS
account остаются machine trust roots; это не защита от процесса с теми же
правами пользователя. На macOS/Linux сохраняются прежние фиксированные пути.

### Системное открытие браузера

На Windows generic opener передаёт URI зарегистрированному системному handler
через `ProcessStartInfo.UseShellExecute`, сохраняя query целиком. URL приходит
фиксированному PowerShell helper по анонимному stdin и не становится shell-кодом.
Успех передачи URI и завершение OAuth callback проверяются отдельно.
Пределы, очистка и обязательная Windows-проверка описаны в
[контракте opener](docs/agent-workspace-runtime.md#системное-открытие-браузера).

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

### Диагностика Windows worker до готовности

`diagnose_trelio_installation(clientKind="codex"|"claude-code", intent="diagnostics")`
и `bridge doctor --json` на Windows автоматически включают `hookStartup`.
Используется код фактически загруженного signed runtime, без отдельного скрипта,
поиска в cache и изменения plugin shell. Onboarding и folder onboarding эти
дополнительные пробы не запускают; на других ОС возвращается `not_applicable`.

`windows_acl.worker_startup` означает отсутствие подтверждения готовности до
лимита, а не доказанную ошибку CreateProcess или доступа к Trelio. Первым, до
чтения private state, запускается настоящий worker с открытым stdin и прежним
stderr. Затем проверяются минимальный PowerShell marker и Node pipe. Только
при неготовом или слишком медленном worker сравниваются piped stderr, закрытый
stdin и системный PSModulePath дочернего процесса. ACL-функция лишь определяется,
запрос ей не отправляется. Новый probe не читает private state/credentials,
не регистрирует runtime session и не создаёт proof. Настройки, ACL, сертификаты,
антивирус, OAuth и pairing не меняются.

При `hookStartup.status=attention` обычное чтение private sessions/connection
пропускается с `not_checked`, без нулевых counters или вывода об отсутствии pairing.
MCP возвращает `REVIEW_WINDOWS_HOOK_STARTUP_DIAGNOSTIC`; следующий protected read
не предлагается до разбора локального отказа. Успех readiness сам по себе не
доказывает ACL, dispatch, trust или успех исходного MCP-вызова.

Параллельный независимый публичный HTTPS GET к `https://trelio.ru/api/health`
сохраняет времена DNS/TCP/TLS, HTTP status либо закрытый error code. Redirects
не исполняются, заголовки/тело не собираются, bearer/cookies не передаются.
Native Node route может отличаться от proxy desktop MCP. Ответ подтверждает
только достижимость public endpoint; сетевой отказ сам по себе не объясняет
локальное зависание до readiness и не разрешает OAuth/pairing recovery.

Исходный worker получает 25 секунд диагностического времени; готовность после
штатного 20-секундного startup deadline остаётся `attention`. Поля
`hookStartupTimeoutMs` и `hookPrivateProcessTimeoutMs` разделяют запуск и запрос.
Минимальный PowerShell marker получает 15 секунд, дополнительные сравнительные
PowerShell-пробы – 5, Node – 3; cleanup каждого child – до 1,5 секунды.
Короткая сравнительная проба не переопределяет успешную готовность настоящего
worker в его бюджете. Локальная последовательность имеет до 58 секунд ожиданий
плюс bounded cleanup; синхронный OS spawn может задержать JavaScript timers. Отмена
MCP останавливает children. HTTPS – до четырёх попыток по 3,5 секунды с паузами
300/600/1000 мс только при transport/429/5xx. Общий срок hook не продлевается.

Отчёт содержит измерения, версии ОС/Node и закрытые категории без raw output,
paths или environment. Последующие пробы могут пользоваться прогретыми caches;
разница времени не доказывает влияние одного параметра. Для установления
причины нужны данные с затронутого устройства и при необходимости отдельный
согласованный A/B-проход с изменением только сети.

Сетевые задержки старта PowerShell описаны в
[документации Microsoft](https://learn.microsoft.com/en-us/powershell/scripting/dev-cross-plat/performance/startup-performance),
но runtime уже использует `-NoProfile -NonInteractive`. Случай интерактивного
PowerShell 7/PSReadLine не доказывает причину в Windows PowerShell 5.1 worker.
Отключение CRL или защиты в диагностике запрещено.

### Ошибки lifecycle hooks

Запуск CLI сравнивает реальные пути к entrypoint, поскольку Node раскрывает
ссылки на каталоги, а `argv[1]` сохраняет исходное написание. Это поддерживает
в том числе Windows junction в родительском пути cache: hook не должен молча
завершаться с exit `0` без протокольного ответа. Import модулей остаётся без
CLI-побочных эффектов; signature, hash и запрет ссылок внутри package сохраняются.
Cross-repository CI проверяет настоящий loader, подписанный fixture package,
entrypoint и hook через cmd.exe, Windows PowerShell и PowerShell 7, включая
две разные подписи и JSON deny. Время MCP-запроса не заменяет время этой цепочки.

Hook и doctor используют общий parser для поддерживаемых имён Trelio.
Некорректный распознанный local action получает
`TRELIO_HOOK_TOOL_IDENTITY_INVALID` до регистрации и отправки; закрытые
аргументы в ошибку не входят. Диагностика показывает статическую совместимость
matcher/parser отдельно от фактического запуска hook и доверия клиента.

В [Codex 0.160.0](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/mcp.rs#L115)
имя hook строится с `__` независимо от склеенного
[dispatch display](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/tool_name.rs#L54).
Поэтому строка вида `mcp__trelioget_agent_instructions` в журнале сама по себе
не доказывает несовместимость matcher. Если proof отсутствует при подтверждённом
trust, `diagnose_trelio_installation` направляет к проверке owning App Server,
effective hooks policy и событий текущего чата; недоступные сведения остаются
unknown. Новый дочерний CLI-процесс не подтверждает перезапуск owner.

`codexHookSettings` отдельно показывает сохранённые настройки из пользовательского
config: общий флаг hooks и enabled/наличие trust для трёх Trelio hooks.
`PreToolUse.enabled=false` даёт предупреждение с конкретным следующим шагом:
пользователь проверяет и включает именно этот hook, перезапускает клиент и
повторяет одно защищённое чтение. Сохранённый `trusted_hash` не включает hook
и не доказывает доверие текущему определению; effective state остаётся unknown.
Диагностика не возвращает содержимое config, paths или hashes и ничего не меняет.

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

Windows hook и отдельная bridge-команда используют один PowerShell transport
для последовательных ACL/DPAPI операций через собственные UTF-8 stdin/stdout pipes: он не меняет кодовую
страницу консоли, не использует Console.In/Out и PowerShell module/cmdlet pipeline.
Фиксированный ASCII-протокол передаёт id, kind и base64 данные; readiness
подтверждается до передачи первого запроса. DPAPI CurrentUser получает
origin-bound entropy и bytes только через anonymous pipes; buffers очищаются,
результат не попадает в stderr/error/argv/env. Старый ciphertext совместим,
protect по-прежнему проверяется обратным unprotect перед сохранением. Каждый exact путь заново получает и
проверяет owner-only descriptor,
результат не кешируется. Transport закрывается при завершении invocation и не
переиспользуется между hooks/командами. Однократный startup ограничен 20 секундами;
после readiness каждый ACL/DPAPI запрос имеет отдельный лимит 10 секунд. DPAPI
не запускает второй PowerShell. ACL, credentials и сеть дополнительно разделяют непродлеваемый
внутренний срок (22 секунды для PreToolUse, 8 для SessionStart, 2 для SessionEnd).
Тайм-аут отменяет subprocess и HTTP, освобождает registration lock и возвращает
JSON deny до внешнего лимита 30 секунд, оставляя время для Windows launcher.
Повторный вызов может продолжить ту же client session; отсутствие повторного
client dispatch нельзя исправлять сбросом OAuth или переустановкой plugin.

ACL проверяется по SID через `GetAccessRules(..., SecurityIdentifier)`.
PowerShell-свойство `Access` и обратный перевод имени учётной записи не
используются: доступность домена не должна участвовать в локальной проверке.
Owner, полный DACL и отсутствие inherited/посторонних правил проверяются при
каждом обращении. Ошибки ACL, I/O и deadline при чтении runtime state сразу
останавливают hook; только отсутствие или повреждённый JSON допускают обычное
восстановление. Один снимок под registration lock разбирается как registered
либо pending без повторного чтения и повторной проверки того же файла.

Тайм-аут содержит закрытые `stage`, `operation` и `timeout`:
например, `runtime_state_read`, `windows_acl.dacl_verify`, `private_process`.
Private transport сообщает этапы чтения owner, записи и проверки DACL. До readiness
указывается `worker_startup`, после передачи запроса и до первой ACL phase –
`request_dispatch`. `windows_dpapi.protect/unprotect` отдельно обозначают DPAPI.
Эти этапы локализуют ожидание, но не доказывают конкретную
причину сбоя ОС. Readiness завершает startup и начинает ограниченный запрос; progress не продлевает
его лимит. Общий срок hook остаётся непродлеваемым.
Имена пользователей, SID, пути, вход MCP и вывод дочернего процесса в эту
диагностику не входят. `missing` и внутренний тайм-аут не взаимозаменяемы.

ID текущего hook-события имеет приоритет над унаследованными ID окружения и
одинаково выбирает private state и transcript для model/effort. Все повторы
захвата registration lock входят в пятисекундный deadline. Неудаляемая stale-
блокировка возвращает `TRELIO_RUNTIME_LOCK_RECOVERY_FAILED` с кодом ошибки ОС;
её содержимое и ACL сохраняются. Отсутствие session-файла и lock после ошибки
не является доказательством отсутствия запуска hook.

Обновление runtime из hook, bridge и MCP использует общий
[recovery exact stable loader](docs/agent-workspace-runtime.md#восстановление-подписанного-рантайма).
Подтверждённая потеря загруженной оболочки требует полного перезапуска клиента;
отказ доступа, неправильный тип файла и ошибка обновления имеют отдельные причины.
Runtime не выбирает другую версию plugin cache и не меняет OAuth, pairing или trust.

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

## Статистика ошибок local MCP

Dispatcher отправляет content-free наблюдения пойманных ошибок `tools/call`
в `/api/agent-workspaces/diagnostics/errors` через существующую bridge session.
Отправка best effort в фоне, без OAuth/pairing, credential migration и UI;
ошибка telemetry не меняет исходный MCP result. Возвращаемые provider `isError`,
HTTP `TrelioApiError`, hooks и process crashes в этот счётчик не входят.
Пойманный failed Workspace subprocess классифицируется по фиксированным Node
признакам: directory, permission, exit, termination, output limit. Только для
`skill_run` допустим один JSON stdout до 64 KiB с `ok=false`: извлекается лишь
один из закрытых MAX assist codes. Message/details и произвольные коды не
передаются в telemetry. Публичный action wrapper сохраняет прежний код, локальный
`details.failureCode` объясняет причину. Повтор действия не выполняется.

Закрытый wire-каталог `trelio-agent-diagnostics-contract.json` ограничивает
tool/operation/code. Payload содержит лишь UUID события, эти dimensions,
числовые версии plugin/runtime и count. Unknown values сворачиваются; message,
stack, args, paths, company/user/session/skill IDs и credentials исключены.
Тот же allowlist проверяет backend. Каталоги меняются совместимо и проверяются
при cross-repository изменении; они не входят в model-visible catalog.
Новые категории сначала принимает backend, затем signed runtime. Старый endpoint
может отклонить пакет с неизвестным кодом; sender прекращает отправку этого
пакета без изменения исходной операции.

RAM queue ограничена 128 группами/1000 повторов; каждые 1 с – пакет до 20 групп.
Активный пакет неизменен: после transport/5xx до трёх повторов через
250/750/1500 мс с теми же UUID; timeout 3 с/attempt, redirects запрещены.
4xx прекращает отправку без recovery. Shutdown отменяет отправки и удаляет
queue без disk spool. Backend хранит события 30 дней и отправляет суперадминам
ежедневную Telegram-сводку только при ошибках; отчёт не является error rate.
Сначала выпускается совместимый backend, затем signed runtime; старый endpoint
404 безопасно отключает конкретную отправку. Public plugin не меняется.

См. [SECURITY.md](SECURITY.md). Не публикуйте credentials, company content,
runtime sessions, E2EE keys, signing material и production package URLs в issue,
fixture или log.
