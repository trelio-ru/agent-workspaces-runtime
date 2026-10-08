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

### Диагностика готовности

Пользователь пишет «Проведи диагностику Trelio» в выбранной постоянной папке.
Current runtime поддерживает Codex, Claude Code и Cursor; последний проверяет
свой manifest/OAuth без Codex/Claude hooks и без автоматического folder binding.
Tool принимает `intent=diagnostics` и optional
`folderOnboarding={folderPath}` из client-owned project context. Отсутствующий
root не угадывается из process cwd; проверка папки остаётся `not_checked`.

Возвращённый план ведёт к независимым live reads OAuth, exact rules/profile,
доступной личной задачи и existing accepted Workspace, затем к разрешённым
safe probes relevant skills. Учебные задачи, Workspace/Run и отправка отчёта
не создаются; успешное чтение не доказывает возможность сохранить результат.
Итог показывает подтверждённое, требующее настройки, непроверенное и неприменимое.

Runtime сравнивает существующий marked Trelio-блок с актуальным шаблоном.
После успешного protected read прежней exact области диагностический запрос
разрешает выполнить returned refresh, если пользователь не запретил изменения.
Refresh сохраняет company/project и personal bytes вне блока, учитывает active
`AGENTS.override.md`, а для Claude добавляет только отсутствующий import.
Нет привязки, неоднозначные markers, небезопасная папка или stale plan — blocker;
unchanged template — no-op. Остальная настройка сохраняет отдельный approval flow.
После записи нужен новый клиентский чат/сессия. [Полный контракт](docs/agent-workspace-runtime.md#readiness-diagnostics).

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

### Поиск npm для браузерных навыков

Bootstrap использует standalone npm даже при собственном Node.js desktop host
и очищенном PATH навыка. В Windows он проверяет стандартный каталог `nodejs`
под `ProgramW6432`, `ProgramFiles` и `ProgramFiles(x86)`, затем запускает exact
realpath `npm-cli.js` текущим Node с `shell:false`. Переустановка Node.js или
расширение PATH ради такого layout не требуются.
[Контракт и Windows regression](docs/agent-workspace-runtime.md#browser-bootstrap).

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

Штатный doctor до чтения private state измеряет readiness установленного native
worker и Node pipe control. Запросы ACL/DPAPI ему не отправляются. Проба не читает
credentials, не регистрирует runtime session и не создаёт proof; настройки,
ACL, сертификаты, антивирус, OAuth и pairing не меняются.

При `hookStartup.status=attention` обычное чтение private sessions/connection
пропускается с `not_checked`, без нулевых counters или вывода об отсутствии pairing.
MCP возвращает `REVIEW_WINDOWS_HOOK_STARTUP_DIAGNOSTIC`; следующий protected read
не предлагается до разбора локального отказа. Успех readiness сам по себе не
доказывает ACL, dispatch, trust или успех исходного MCP-вызова.

Отдельный публичный HTTPS GET к `https://trelio.ru/api/health`
сохраняет времена DNS/TCP/TLS, HTTP status либо закрытый error code. Redirects
не исполняются, заголовки/тело не собираются, bearer/cookies не передаются.
Native Node route может отличаться от proxy desktop MCP. Ответ подтверждает
только достижимость public endpoint; сетевой отказ сам по себе не объясняет
локальное зависание до readiness и не разрешает OAuth/pairing recovery.

Doctor запускает exact native Windows helper из подписанного package и отдельный
Node pipe control. `workerKind=windows_native` явно называет реализацию; PowerShell
больше не входит в обязательные пробы или ACL/DPAPI путь. Readiness не обращается
к private state и не выполняет ACL/DPAPI. Worker получает 25 секунд диагностического
времени, Node – 3; поздняя готовность за пределами штатных 20 секунд остаётся
`attention`. `hookStartupTimeoutMs` и `hookPrivateProcessTimeoutMs` разделяют запуск
и запрос. Время OS spawn включено в deadline; поздний callback не считается успехом.
Отмена MCP завершает children. Public HTTPS измеряется после локальных проб, чтобы
синхронный spawn не искажал DNS/connect timings; до четырёх попыток по 3,5 секунды
с паузами 300/600/1000 мс только при transport/429/5xx. Общий срок hook не продлевается.

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

Windows hook и отдельная bridge-команда используют один native Win32 helper
для последовательных ACL/DPAPI операций через anonymous stdin/stdout pipes.
C++ helper не запускает PowerShell/CLR, не требует компилятора на компьютере
пользователя и не меняет code page. Отсутствующий или запрещённый executable
завершается fail-closed без shell fallback. Legacy PowerShell builder остаётся
только для явно вызванных compatibility/fault-injection tests.
Фиксированный ASCII-протокол передаёт id, kind и base64 данные; readiness
подтверждается до передачи первого запроса. DPAPI CurrentUser получает
origin-bound entropy и bytes только через anonymous pipes; buffers очищаются,
результат не попадает в stderr/error/argv/env. Старый ciphertext совместим,
protect по-прежнему проверяется обратным unprotect перед сохранением. Каждый exact путь заново получает и
проверяет owner-only descriptor,
результат не кешируется. Transport закрывается при завершении invocation и не
переиспользуется между hooks/командами. Однократный startup ограничен 20 секундами;
после readiness каждый ACL/DPAPI запрос имеет отдельный лимит 10 секунд. DPAPI
вызывает CryptProtectData/CryptUnprotectData с UI_FORBIDDEN и без LOCAL_MACHINE. ACL, credentials и сеть дополнительно разделяют непродлеваемый
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

Codex effort читается из ближайшего `turn_context` текущего журнала, поиском
назад блоками по 256 KiB. Большой ответ инструмента не вытесняет эту запись
за фиксированную границу tail. Память для одной JSONL-записи ограничена 2 MiB,
поиск — двумя секундами внутри прежнего hook deadline. Большие обычные записи
пропускаются только по известному внешнему заголовку Codex. Повреждённый,
неизвестный либо слишком большой context, изменение журнала во время чтения
и истечение срока не разрешают взять effort предыдущего хода. Настройки UI,
tool arguments и агентские заявления не заменяют наблюдение клиента.
`EFFORT_REQUIRED` означает отсутствие наблюдаемого effort; слишком низкий
уровень имеет отдельную причину `EFFORT_TOO_LOW`.

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

Content-free v2 объединяет success/error в immutable sample с UUID, boundary,
OS/architecture, tool/operation, versions, закрытыми code/field и loss counters.
Нет company/user/session/run/skill IDs, message/stack/details, аргументов, paths,
proofs, credentials или provider content. Legacy error-only записи остаются
без знаменателя. Backend OS unknown, не ОС сервера вместо клиента.

Local MCP считает returned isError без чтения payload, typed exceptions и
TrelioApiError с закрытым code/HTTP-классом. Отдельная hook boundary включает
SessionStart, относящиеся к Trelio PreToolUse и SessionEnd; JSON deny с exit 0 –
отказ, update delegation – ROUTED. Loader/process kill до записи вне охвата.
Action validation имеет фиксированную причину и имя поля без значения;
внутренний skill exit сохраняется отдельно от CLI exit, без выдуманной семантики.
MAX assist closed stdout codes имеют приоритет. Windows helper различает
startup/request/protocol/ACL/DPAPI; wrappers прежние. Нет повторов действий.

GET diagnostics/capabilities согласует каталог (64 KiB/cache 5 минут).
Неизвестный серверу код – DIAGNOSTICS_CODE_UNSUPPORTED с catalog_mismatch,
остальной sample сохраняется. POST diagnostics/observations: 20 samples,
64 outcome-пар/1000 исходов/sample. 404/405 capabilities выбирает legacy errors
с UNKNOWN на минуту, без знаменателя. Другой 4xx terminal; нет OAuth/pairing.

RAM: 128 групп, отправка через 5 с; transport/5xx – три повтора 250/750/1500 мс
с теми же UUID, 3 с/attempt. Existing credential читается один раз/batch,
AbortSignal передаётся private worker. До реального завершения игнорирующего
отмену adapter второй read не начинается; поздний token не вызывает HTTP.

Hooks пишут строгую v2 schema в user-temp journal без private store, ACL repair,
DPAPI или сети; POSIX 0700/0600, Windows inherited user-temp ACL. 256 entries,
16 KiB/file, TTL 24 ч, bounded read/validation, UUID filename и atomic rename.
Это техническая очередь, не secret store/authority. MCP берёт до 10 journal
samples/batch, удаляет после 204, проверяет каждые 30 с и при новой активности.
Shutdown не ждёт сети и по возможности пишет content-free loss snapshot.
Queue/delivery/credential/journal/catalog losses различаются; они не рабочие
ошибки и не складываются в точное число потерь. Нет health-only retry loop.

Backend retention 30 дней. V2 rate – только доставленные исходы одной boundary;
ROUTED отдельно, boundaries не суммируются в уникальные запросы. Kill и failed
journal write оставляют неизвестные потери; тишина не доказывает исправность.
Сначала backend, затем signed runtime; plugin/minimum versions не меняются.
Регрессии: tests/trelio-agent-diagnostics.test.mjs.

См. [SECURITY.md](SECURITY.md). Не публикуйте credentials, company content,
runtime sessions, E2EE keys, signing material и production package URLs в issue,
fixture или log.

### Названия Codex-чатов

При open, heartbeat и checkpoint runtime автоматически обновляет название
уже связанного с task Run чата через точный read-only App Server запрос, без
хода модели. Переименование видно при следующем таком событии; недоступный
CLI оставляет прежнюю подпись. Малые обсуждения без Run не регистрируются.
Bounds, private Run binding и E2EE – в
[контракте runtime](docs/agent-workspace-runtime.md#названия-связанных-codex-чатов).
## Сборка native Windows private helper

`host-runtime/scripts/native-private-process/PrivateProcess.cpp` – единственный
исходник Win32 ACL/DPAPI worker. Hosted Windows выполняет
`scripts/build-windows-private-worker.ps1`: MSVC, static CRT, x64/ia32/arm64,
двойная deterministic сборка. Binaries не коммитятся и не компилируются на устройстве.
Все OS gates получают один artifact `windows-private-worker`; x64/ia32 и ARM64
исполняются на соответствующих hosted runners, обычная Windows учётная запись
отдельно проверяет права и DPAPI. Проверяются legacy ciphertext в обоих направлениях,
reparse points, malformed/oversized input и отсутствие plaintext в ошибках.

Tag workflow загружает native artifact только из успешного PR gate exact SHA.
Package builder требует metadata с SHA исходника, размером/SHA и PE machine
каждого binary; missing/stale input блокирует сборку. Готовые helpers входят
в общий подписанный runtime и проверяются stable loader вместе с его файлами.
