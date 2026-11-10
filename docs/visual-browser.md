# Визуальный браузер Agent Skills

API v1 принадлежит generic host. Signed provider задаёт
HTTPS origins/domains, optional externalNavigation, начальный адрес и явный observationMode; binary, профиль, ключ и executable
выбирает host. Source не означает stable release или завершённую native-проверку.

## Выбор представления и восстановление UI

`VISUAL_PRESENTATION_API = trelio.visual-presentation/v1` подтверждает signed
`runVisualSession({ presentation: 'hidden' })`. Default `windowed` сохраняет
прежний запуск всех существующих providers. Выбор задаёт подписанный source,
не CLI/MCP flag или environment, и он закреплён в live owner. Другой выбор
не переиспользует live worker для content/input; status/wait/ready/close остаются
доступны. Общие scopes, AEAD snapshot, OS key, account CAS и lease не меняются.

Обычная работа `hidden` запускает managed Chromium с `--headless=new`: text,
PNG, ввод и safeguards остаются теми же. Это не native SW_HIDE, не минимизация
и не обещание работы при выключенной ОС. Hidden startup не делает предварительную
попытку входа и не служит fallback после отказа windowed browser.
Во всех managed visual/persistent профилях отключён browser-level sign-in Chromium
(`signin.allowed` и `signin.allowed_on_next_startup`):
это web-сессия навыка, не профиль Chrome Sync. Остальные preferences сохраняются;
обычный профиль пользователя и OS/Bluetooth settings не меняются.

Явный `setup` предназначен для входа человеком и всегда запускает обычное
видимое окно. Из активного hidden процесса он сначала штатно останавливает и
сохраняет auth profile, затем один раз открывает reviewed setup URL под прежней
owner/session identity и исходной lease. Ошибка stop/persist блокирует переход;
неизвестное browser input не повторяется. Перезапуск переносит сохранённую
авторизацию, а не произвольный несохранённый черновик/transaction: до setup
необходимо установить исход предыдущих бизнес-действий. `show-login` показывает
уже открытый ручной setup, не является автоматическим новым входом.
После human `ready`/window-close прежний save gate сохраняет профиль до снятия
блокировки снимков; следующая явно порученная navigate работает скрыто.

Для сбоя UI recipe действует общий browser recovery default из
[общего skill recovery](agent-skills-and-secrets.md#живой-каталог):
агент использует доступные text/image/input этой же допущенной сессии, если
навык не ограничивает это. Это смысловой выбор по свежему интерфейсу, не новая
capability или обход site/auth/ACL gate. Host сохраняет все deterministic guards;
unknown write сначала требует read-back. Проверенный дефект и результат recovery
могут стать предложением баг-репорта с отдельным human publication.

Signed authentication recipe может добавить `setup: {paragraphs, links}` для
защищённой формы через `trelio.protected-browser-auth-setup/v1`. До четырёх
plain-text абзацев и четырёх ссылок `{label,url}` на уже разрешённые exact
HTTPS origins, без credentials/query/hash. Их рендерит общий local-form API;
переход по ссылке выполняет пользователь. Статическая подсказка не меняет
fingerprint исполняемой recipe, credentials и pending fence.

<a id="parallel-skill-sessions"></a>

## Параллельные сценарии навыков

Общий `trelio-browser-session.mjs` предоставляет
`BROWSER_EXECUTION_SESSIONS_API=trelio.browser-execution-sessions/v1`.
Host передаёт точный module URL всем signed `local-session` packages через
`TRELIO_EXECUTION_SESSION_MODULE_URL`; browser packages также сохраняют прежний
`TRELIO_BROWSER_SESSION_MODULE_URL`. Переменные не наследуются и не могут
подменяться Secret checkout. Доступность source не доказывает публикацию API;
зависимый package обязан иметь minimumHostVersion первого опубликованного host.

`browserExecutionOwner` принимает только observed `TRELIO_SKILL_RUNTIME_SESSION_ID`.
Название/cwd чата, account UUID и ambient `CODEX_THREAD_ID` не заменяют владельца.
`browserExecutionDirectory(accountDirectory)` отделяет lease/control/status,
browser profile и cleanup каждого владельца от account vault/key/AAD.
Без observed identity legacy explicit-session ABI сохраняется; такой клиент
не получает обещание изоляции двух неразличимых implicit сценариев. Закрытие
чужого runtime session ID запрещено, даже если выбран тот же аккаунт.

`withPersistentBrowserSession` автоматически fork-ит native messenger auth
stores в отдельный stopped profile каждого владельца. IndexedDB CryptoKeys
переносятся native archive codec; cookies/storageState его не заменяют. History,
password store, cache и downloads не входят в fork. Browser close/process join
предшествует snapshot. Опубликованный snapshot меняется только при совпадении
base revision; late fork сохраняет свою копию, не затирая новый login/logout.
Это прежний private plaintext messenger-store contract, без plaintext fallback
для protected-snapshot. Visual workers используют отдельные live directories,
общий OS key и AEAD ciphertext; state конфликт сохраняется отдельно зашифрованным.
Credential/attempt-fence CAS не разрешает двум workers повторить один input.

`withBrowserAccountState` сериализует короткие account transactions. Provider
сохраняет свои native owner/ACL, key/unlock и vault format.
Protected store выполняет init и Windows DACL hardening под тем же mutex:
проверка private path на Windows также меняет ACL и не является read-only preflight.
Она не должна конкурировать с публикацией private file/claim другого worker.
Для opaque ciphertext `saveBrowserAccountSnapshot` сравнивает точную исходную revision. Неизменённые
credentials и browser storage не сливаются автоматически. Только provider-owned
`reconcile` может обновить независимо проверенную credential/refusal metadata,
сохраняя свежий browser state и собственный metadata CAS. Каждый callback
исполняется максимум один раз. `browserExecutionDirectories` даёт bounded
непереходящий по ссылкам inventory, включая legacy root: setup/reset/crypto-erase
резервируются тем же account mutex и требуют отсутствия конфликтующих live leases.

`withSharedAccountService` применяется к одному неклонируемому linked device
либо физическому экрану. У чатов разные logical session IDs; полные target-bound
операции идут в общей очереди. `start` возвращает boolean `reused`: уже работающий
native service допускается только при совпадении с exact host registry.
Legacy/unbound service нельзя присвоить новому чату и затем закрыть его последним
logical stop. Stop освобождает только свою lease, physical stop
выполняется последним владельцем. До него persist-ится closing fence; потерянный
результат проверяется status, stop/input не повторяются. Новый start запрещён
при неразрешённом closing любого владельца. Hard deadline физической сессии
не переносится вторым start. Native expiry/idle guards остаются authority.
Для physical UI mutation резервирует generation до dispatch; другой чат обязан
получить свежую observation. Unknown input также делает старые кадры непригодными.

Для SDK, который держит единственную SQLite/protocol session на аккаунт,
пакет включает в SAME signed inventory `trelio-execution-resource.json`:
`{"schemaVersion":1,"scope":"account"}` (`device` – один физический ресурс).
Host проверяет closed schema и `local-session`, ставит invocation в очередь до
interpreter/credential/native setup и сохраняет исходный wall/monotonic budget.
Свежий managed admission проверяется после ожидания. Metadata-only help/guides
и import не занимают provider resource. Отсутствующий marker не создаёт
глобальный lock у stateless API. Runtime не содержит таблицы provider ID.

Обязательные regressions: два владельца одного аккаунта, foreign session refusal,
независимые browser contexts и close, shared-key creation, stale auth-state CAS,
неизвестный input/stop без replay, реальная очередь child processes, physical
stale-frame refusal и original expiry. Synthetic native browser/OS tests не
доказывают одновременную поддержку сессий конкретным внешним сервисом: его
собственные ограничения отражаются отдельно и не обходятся повторным входом.

## Что получает модель

`trelio.visual-browser/v1` передаёт PNG отдельным MCP image block и закрытые
metadata: frame/session IDs, размеры, scroll flags, фазу и безопасную причину.
Модель не получает HTML, DOM/AX, site JS, storage, cookies, headers, response
bodies, clipboard, selectors или произвольный результат протокола браузера. Отдельный signed opt-in для
входящих файлов возвращает только локальный receipt, описанный ниже.
У API нет команд evaluate, произвольного CDP, raw HTTP или чтения профиля.
Отдельный signed opt-in исходящих файлов выбирает host-frozen originals через
native file chooser; он возвращает обычное наблюдение интерфейса, без bytes/paths.
PNG проверяется до обычного stdout limit: размер, chunks/CRC и отсутствие
текстовых/вложенных данных. Невалидный marker не возвращается как обычный stdout.

У собственного Chromium capture host удаляет один bounded ancillary `iCCP`
цветовой профиль до private HTTP и строгой MCP-валидации: такой профиль зависит
от дисплея и может появиться в обычном PNG. Проверяются CRC и полный контейнер;
профиль не распаковывается и не выдаётся модели. Raster samples сохраняются
побайтно, без профиля viewer использует своё default color space. Обычный
provider/MCP validator по-прежнему отклоняет `iCCP`, текст, EXIF, неизвестные
chunks и trailing bytes. Normalization не добавляет команды браузера или
извлечение содержимого страницы.

Модель выбирает координаты, обычный текст или клавишу из закрытого набора.
Одноразовый frame действует 60 секунд и расходуется до input dispatch.
Неизвестный результат не разрешает повтор внешней записи. Динамическая страница
может сдвинуть контрол после кадра: token не заменяет визуальный смысловой review.

### Диагностика запуска

`VISUAL_STARTUP_DIAGNOSTICS_API=trelio.browser-startup-diagnostics/v1` в общем
host module подтверждает additive контракт. Legacy `state`/`reason` сохраняются;
error дополнительно содержит закрытый `diagnostic: {stage,code,failureCode?,causeCode?,exitCode?,signal?}`.
Тот же validator проверяет worker HTTP, provider stdout и MCP; arbitrary поля,
prose, URL/paths, native output, credentials и diagnostic на успешном результате
отклоняются. Text-mode ошибки используют тот же status DTO без текста страницы.
Новых файлов журналов, native logging и telemetry dimensions нет.

Parallel detached native fixtures keep one closed diagnostic tail per verified
execution owner. Failed ready reports its original reason and that worker's
stop/snapshot/persist/cleanup stage, allowed errno/syscall and owned-file category.
No Error text/path, owner descriptor, extra native observation, input/save retry
or extended deadline is allowed. This diagnoses a refusal; it does not fix it.

Этап – место наблюдения отказа, не установленная первопричина:

| stage | code и смысл |
| --- | --- |
| `owner_read`, `owner_prepare`, `owner_publish`, `control_server`, `control_listen`, `worker_spawn` | `startup_failed`: отказ private descriptor/worker; нет оснований менять ACL или удалять claim |
| `worker_node` | `node_unavailable`: не найден совместимый Node под прежней signing policy |
| `worker_request` | `worker_unavailable`: не получен корректный ответ; не доказывает, что worker или браузер не запускался |
| `dependencies`, `dependency_install`, `dependency_load` | `startup_failed`, `dependency_install_failed`, `dependency_load_failed`: общая подготовка, установка либо загрузка native modules |
| `storage_read`, `storage_prepare` | `storage_unavailable`, `storage_corrupt`: недоступное либо повреждённое protected state |
| `profile_restore`, `profile_prepare`, `extension_prepare` | `startup_failed`, `storage_unavailable`, `storage_corrupt`: восстановление/подготовка; прежний snapshot не перезаписывается |
| `browser_install` | `browser_install_failed`: отказ подготовки managed Chromium |
| `browser_spawn` | `browser_spawn_failed`, `browser_exited`: spawn отказ либо наблюдённый ранний exit |
| `extension_connect` | `extension_not_connected`, `extension_not_ready`: socket отсутствует либо hello не завершён в прежний deadline |
| `extension_policy`, `extension_auth`, `extension_window` | `extension_bootstrap_failed`, `storage_unavailable`, `storage_corrupt`: фиксированный policy/auth/window этап расширения |

`failureCode` сохраняет только код настоящего `ProcessDiagnosticError` из общего
закрытого каталога subprocess diagnostics; native message/details не выдаются.
`causeCode` принимает только `EACCES|EPERM|ENOENT|EIO|EBUSY|ENOSPC|ENOTDIR|EEXIST|
ETIMEDOUT|ECONNREFUSED|ECONNRESET|ERR_DLOPEN_FAILED|ABORT_ERR`. `exitCode` – только
наблюдённый native integer (включая Windows DWORD); `signal` – только
`SIGKILL|SIGTERM|SIGTRAP|SIGABRT|SIGSEGV`. Неподдержанный code/message не
разбирается: остаётся известный этап без придуманной причины. Вложенный этап
сохраняется только у host-owned typed error, не у похожего arbitrary объекта.

Первый startup отказ остаётся в том же worker и возвращается последующими
`status`/`wait` и content-вызовами. Они не перезапускают browser/install/input,
не продлевают lease и не сбрасывают credentials/fences. При потере самого worker
доступный результат может ограничиться `worker_request/worker_unavailable`;
диагностика не восстанавливает незафиксированное прошлое evidence. Close и
cleanup сохраняют прежнюю самостоятельную семантику. Установка, reconnect,
исправление прав и повтор требуют прежних отдельных оснований.

Проверки включают real require/native child failure, отказ storage до запуска,
первый неизменный result, private HTTP → typed MCP, rejection canaries и native
detached worker с повреждённым синтетическим envelope на всех обязательных OS.

<a id="текстовый-режим"></a>

## Текстовый режим

`runVisualSession({ observationMode: 'text' })` – opt-in только в исходнике
подписанного provider. Default `'image'` не устанавливает текстовый reader и
отклоняет text/pacing команды до IO. Это API аргумент signed implementation,
не новое capability или поле browserSession descriptor. Режим закреплён в
private owner; живой worker другого режима нельзя переиспользовать для content
или input. `observation_mode_mismatch` разрешает exact owner status/wait/close,
не автоматический сброс входа. Account scope и AEAD binding не меняются.

`trelio.browser-text/v1` передаёт rendered text без кода страницы: до 6000
символов, title 240, 40 viewport controls (role/label до 120/x/y), scroll flags,
одноразовый frameId, nextOffset и scanLimited. Весь JSON не больше 40000 bytes.
`read-text` принимает literal query до 120 символов, offset 0..100000 и
includeControls. Это не selector, script, HTML, AX или атрибутный inventory.
Фиксированный isolated reader пропускает скрытые узлы, scripts/styles/templates,
input values, textarea/select, ARIA textboxes и редактируемые блоки. Явный
`contenteditable="false"` вне form/label и любого редактируемого/textbox-предка
читается как обычный документ: включая абзацы, заголовки и ячейки таблиц.
Read-only textbox, false-вставка в редакторе, неизвестное editable-значение,
скрытый текст и поля формы остаются закрытыми. Проверка labels по-прежнему
пропускает всё содержимое contenteditable, включая false. Rendered password/OTP
закрывает наблюдение. Во время manual phase закрыты также agent input и снимки.
Чтение не прокручивает и не фокусирует страницу. Same-document и main-frame
navigation во время extraction запрещают выдачу старого token.

Полный режим означает пагинацию **уже отрисованного** текста, не полный source:
scan не больше 20000 узлов/100000 символов. Длинные узлы тоже pageable;
scanLimited означает неполноту. Lazy loaded, iframe/canvas и скрытые данные
не обещаются. По query сохраняются две соседние строки по сторонам для суммы
и валюты. Координаты только видимых hit-tested controls; верстка может сдвинуть
их после наблюдения. `screenshot` остаётся явным PNG fallback. Оба variants
проходят closed validation в host/private HTTP/реальном typed MCP transport;
страница и labels всегда untrusted data, не authority.

Подписанный `semanticControls: true` (`trelio.visual-semantic-controls/v1`)
добавляет combobox/option/checkbox/radio/menuitem, checked/selected и отдельную
пагинацию viewport controls: `controlQuery` literal до 120, `controlOffset`
0..1200, `nextControlsOffset`. Кандидатов не больше 1200; неоднозначность и
scanLimited не доказывают отсутствие цели. Связанный native label может быть
видимой целью clipped checkbox. Прозрачный native checkbox допускается лишь
при собственной accessible label, видимом ancestor и успешном hit-test.
Значения полей в controls не добавляются; legacy reader сохраняет прежнюю схему.

`trelio.visual-form-checks/v1` разрешает отдельный signed `fieldCheckPolicy`:
только exact подмножество origins provider-а и до 64 точных business labels.
Политика канонизируется до private IO и закрепляется в SAME owner; изменение
не переиспользует live worker. `read-text.checks` содержит до шести сравнений
`{id,label,match,values}` с `equals`/`contains` и до восьми известных ожидаемых
строк (до 512 символов). Пустая строка проверяет отсутствие business input.
Фиксированный host adapter сравнивает значения только видимых hit-tested
textbox/select/combobox на объявленном origin. Ответ `fieldChecks` содержит
только id и `matches|different|missing|ambiguous`: без actual/expected, длины,
hash, DOM или selector. Authentication/manual/password/OTP gates сохраняются.
Это не универсальное разрешение читать формы: provider не выводит policy/checks
в model argv и допускает только известные значения поручения в своих recipes.

При signed `externalNavigation: true` видимый hit-tested HTML anchor может
дополнительно вернуть `control.url`: точный HTTP(S) адрес для передачи обычному
браузеру, цитирования или выбора другого подходящего инструмента. Это общий
примитив ссылки, без распознавания Google/других сайтов и их меню. URL не
сокращается, не переписывается и не запрашивается по сети при чтении. У кнопок,
полей, скрытых узлов и ссылок в редактируемом содержимом этого поля нет.
Default image mode и text providers без external opt-in сохраняют прежний DTO.

Общий self-contained URL validator применяется в isolated reader и повторно
на private HTTP/MCP границе. Он исключает userinfo, специальные схемы,
управляющие символы и известные credential/OAuth/SAML параметры в query/fragment;
отказанный URL не превращается в другой адрес удалением токена. Callback,
headers, auth state и signed download destinations по-прежнему не выдаются.
Обычная private навигация проверяется независимо и не получает запрета по домену
из-за отсутствия URL в наблюдении.

Один URL ограничен 2048 символами, совокупные JSON-поля URL — 8192 байтами
внутри прежнего complete-result bound. При исчерпании бюджета следующий адрес
опускается целиком и возвращается `linkTargetsLimited: true`. Поле `url`
необязательно: его отсутствие не доказывает отсутствия самой ссылки. Старые
наблюдения без URL/флага остаются валидными. Получение ссылки не передаёт
credentials/session другому инструменту и не разрешает внешнюю mutation.

`submit` оборачивает одну отправку нового логического поиска: navigate, click
или key Enter. `request-ready` отмечает завершённый результат по exact последнему
frameId. Классификация «новый поиск» и смысловая готовность остаются модели:
у generic host нет надёжного site-independent способа определить их по кнопке.
Остальная механика в одном worker controller: первый запрос сразу; после fresh
completion – новый случайный минимум 2000..15000 мс от observation time;
размышления и чтение источников входят в интервал. Перед следующим dispatch
ждётся только остаток по monotonic deadline, включая early timers. Concurrent
submit блокируется, исключение переводит в unknown без replay; неудачное чтение
отзывает старое completion evidence. После ожидания заново проверяются original
lease, frame TTL, manual gate и origin. Ordinary read, ввод и открытие источника
не являются новыми поисками и не получают искусственной задержки. Это тот же
контракт Yandex Search/Google AI Search, проверяемый на их actual source snippets;
он не обещает официальную квоту сервиса или обход CAPTCHA.

## Обычный Chromium и локальный adapter

Exact Playwright distribution manager загружает managed Chromium. OS keyring и
WebSocket transport также закреплены отдельным npm lockfile; lifecycle scripts
не исполняются. Versioned candidate cache атомарно повышается после read-back.
Обновление browser pin проходит OS tests и signed host release; администратору
компании не требуется обслуживать собственный browser binary. Системные
Opera/Chrome и пользовательские профили автоматически не импортируются.

По умолчанию Chromium запускается как обычный headed browser с собственным
приватным профилем; signed hidden presentation описан выше.
GUI child запускается с `windowsHide: false`: на Windows `SW_HIDE` в native
startup info может оставить белую поверхность вместо нормального окна Chromium,
включая ручной вход. Это общий launcher визуальных навыков для обычных
пользователей и ассистентов. Его stdio остаётся `ignore`; console helpers,
lease, закрытие и сохранение профиля сохраняют прежние ограничения.
Нет Puppeteer launch, remote-debugging port/pipe, `--enable-automation`,
AutomationControlled override или fingerprint spoof. MV3 extension использует
внутренний `chrome.debugger`: только фиксированные Page raster/layout/MIME
и Input события. Fixed Fetch guard приостанавливает только Document response
до body: по status и bounded заголовкам разрешает настоящий 301/302/303/307/308
с Location либо конечный HTML. Attachment, отсутствующий/иной MIME конечного
ответа, неоднозначные headers и неизвестная стадия запрещены; Location на 200
не делает ресурс редиректом. Body не запрашивается, headers/URL не выдаются модели.
Отдельный закрытый Cookie API обслуживает локальное сохранение
авторизации, без model-facing read/write методов. Обычные downloads ограничивает
response-stage guard и независимое DNR attachment rule; единственное временное
исключение – exact входящий файл, принятый локальным bounded stream. Это всё ещё debugger API; отсутствие startup
DevTools mode само по себе не гарантирует принятие внешним сайтом.

Extension подключается к одному host-owned loopback WebSocket: exact path,
exact extension Origin и случайный 256-bit token в private worker resource.
Token не передаётся в argv, Chromium environment, MCP или logs. WS transport
не является DevTools endpoint. Heartbeat и cleanup не стоят за зависшим input;
переподключение не переигрывает предыдущую команду.
Transport имеет отдельный loopback host permission, а CSP разрешает connect
только к exact private порту. Это не добавляет localhost в navigation policy
или content-script matches. Fixture native logs сворачиваются в закрытые
счётчики компонентов; raw text и содержимое auth stores не выводятся.
Authentication fixture сохраняет numeric exit, allowlisted signal и категории
только текущего browser generation вместе с этими фиксированными счётчиками:
поздний `extension_not_connected` не скрывает исходный native exit. Эти данные
не объявляют причину завершения процесса установленной и не разрешают повтор input/login.
Та же закрытая диагностика доступна synthetic detached fixture, чтобы его
startup не оставался скрытым за общим `bootstrap_failed`.
Authentication fixture проверяет первый `navigate` до входа и сохраняет его
общую validated startup diagnostic. Evidence очищается при смене browser generation;
startup refusal не считается попыткой пароля и не разрешает повтор запуска/input.
Штатный `error/manual_control_active` без startup diagnostic сохраняет закрытую
форму и допускает следующий private authenticate, но сам не доказывает вход/готовность.

Windows/Linux startup открывает внутреннюю new-tab вкладку без URL в argv.
Запуск без начального окна остаётся только на macOS с её app lifecycle.
Для нового owned профиля host заранее устанавливает обычный continue-session
preference: Chromium игнорирует restore switch у нового Profile. Эта настройка
сама по себе не гарантирует сохранение session cookies на Windows; для них
предусмотрен описанный ниже private overlay.
У восстановленного профиля существующие Preferences не перезаписываются.
Это настройка lifecycle профиля, без чтения/перезаписи website cookies.
Затем extension ставит navigation policy
и переводит owned вкладку на начальный адрес. Readiness означает отдельный hello
после обоих этапов, а не только открытый socket. В synthetic native tests
диагностика ограничена stage/exit и категориями sandbox/display; raw stderr,
native сообщения, пути и token никогда не печатаются.

Desktop Linux требует доступный sandbox/user namespaces и Secret Service.
Ubuntu 23.10+ может запрещать namespace для downloaded binary: нужен OS-owned
AppArmor profile с `userns` для managed Chromium, как в
[инструкции Chromium](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).
CI загружает профиль только для exact fixture binary. Runtime не меняет OS
policy и не добавляет `--no-sandbox`; это отдельная локальная prerequisite,
а не обслуживание со стороны администратора компании Trelio.
Для X11 child сохраняет также путь XAUTHORITY: без него DISPLAY недостаточно.

Main-frame HTTP(S) navigation по умолчанию ограничена signed origins/domains
через DNR; внешний web navigation включается отдельным signed opt-in ниже.
Правила принадлежат browser session: устанавливаются до первой provider
navigation и не сохраняются как persistent extension ruleset. Их lifetime
совпадает с owned browser process; reconnect не снимает действующие правила.
MIME-only DNR rule нельзя применять к 301 без Content-Type: это обычный переход,
не готовый файл. Host сначала включает Fetch guard exact owned tab, затем даёт
только этому tab исключение из main-frame MIME rule. Первый URL открывается
через blank после guard. Служебная new-tab Windows/Linux сначала коммитится в
инертную about:blank под прежним deadline; до Fetch нет provider HTTP.
Новые незащищённые popups и subframes сохраняют строгий
DNR default. При native detach exception отзывается, input/capture ждут policy
write и fail-closed при ошибке. Browser error document возвращает document_blocked,
не выдаётся за страницу с отсутствующим text adapter.
Source/resource URLs и специальные схемы отклоняются. Browser downloads
запрещены отдельно: suffix URL не доказывает тип ответа.

### Уведомления и нативные подтверждения сайта

Общий extension adapter применяется одинаково к human и managed assistant
вызовам подписанных визуальных навыков. Это поведение только принадлежащего
runtime Chromium: оно не перенастраивает пользовательский Chrome, Computer Use
Codex или ОС и само по себе не переводит все browser actions ассистента в этот
transport. Source commit не является публикацией установленного host runtime.

Перед первой provider navigation extension устанавливает через штатный
`contentSettings.notifications` profile-local `block` для `<all_urls>` и читает
результат для initial URL. Это выполняется при каждом запуске, включая restore,
до `hello`. Отказ записи/проверки остаётся закрытым `policy_write|policy_read`
startup failure. Existing Preferences не переписываются host-ом; cookies,
авторизация и OS notifications не меняются. Сайт получает denied, а не
синтетический успех запроса. Если его функция требует notifications, блокировка
не доказывает работоспособность этой функции и не разрешает тайный allow/fallback.

Native `Page.javascriptDialogOpening/Closed` наблюдаются отдельно от renderer
command queue. Для `alert` и `confirm` того же owned attached target доступны
только native type/message и answer. Предыдущий успешный credential guard
того же document generation обязателен: ожидающий диалог renderer не опрашивается
через DOM, content script или новый page input. Manual/authentication phases,
непроверенный новый документ, `prompt`, `beforeunload` и неизвестные types
возвращают `manual_input_required/manual_control_active` без native text/defaults.
Это handoff для штатного owner-question flow цифрового ассистента; runtime
не получает права согласиться за владельца либо самостоятельно отправить вопрос.
Touch ID, Keychain, CAPTCHA и иные OS/provider gates этим API не обходятся.

Сообщение ограничено 4000 UTF-16 units, 40 строками по 88 units и полными
Unicode code points. Управляющие/неполные строки и превышение лимита не
обрезаются до другого смысла: применяется тот же content-free handoff.
Image mode rasterises явно помеченную Trelio observation в extension-local
OffscreenCanvas, без дополнительного tab/window и site injection. Native text
не появляется в model JSON. Text mode использует прежний bounded text DTO.
Оба варианта показывают untrusted website content и только OK/Cancel controls;
смысловой выбор остаётся у модели в пределах реального поручения и независимых
owner decisions. Никакого auto-accept всех подтверждений нет.

Обычный `key Enter|Escape` либо coordinate click по показанной кнопке отвечает
только exact observed native dialog. Immutable modal observation переиспользует
один frame token до его расходования/60-second TTL, чтобы поздний внутренний
capture исходного input не отзывал уже выданную модели карточку. Нативный answer
расходует token ДО dispatch; human close, detach, document change и следующий
диалог не позволяют его использовать повторно. Other page input при открытом
диалоге отклоняется. Hidden `dialogId`, native URL/defaultPrompt и raw CDP
никогда не входят в public result/args.

Исходный click/key/submit может ещё ждать native acknowledgement. Его model call
возвращает modal observation, сохраняя тот же input promise. Answer освобождает
именно его; следующий native dialog получает отдельное наблюдение. После
закрытия возвращается fresh page observation или результат того же original
download. Только private extension continuation передаёт закрытое имя исходной
download operation; host проверяет signed opt-in, сохраняет original через
прежний file validator и удаляет эту metadata до MCP. Это не новый file/read API.
Lost answer/input outcome не разрешает повтор click, submit или native answer;
consumed/unsupported dialog остаётся явным handoff, original lease не продлевается.

Regressions исполняют materialized worker с действительно незавершённым native
input promise, ранним acknowledgement, cancellation, consecutive dialogs,
human close и unknown answer. Native Chromium fixture проходит text и PNG/MCP
validators, исходное действие ровно один раз, notification denied и настоящий
restore профиля; он включён в прежние visual OS lanes. Он не доказывает
совместимость любого внешнего сайта или возможность unattended OS unlock.

### Внешние ссылки

`VISUAL_EXTERNAL_NAVIGATION_API = trelio.visual-external-navigation/v1` подтверждает
signed `runVisualSession({ externalNavigation: true })`. В этом режиме обычные
HTTP(S)-страницы, ссылки и redirect не ограничены исходными origins/domains.
Host policy, native DNR и content-script matches используют один выбор; одного
разрешения в provider matcher недостаточно. Флаг не принимается из обычных
CLI/MCP arguments и по умолчанию остаётся false для прежних providers.

Выбор закреплён в private owner вместе с observation/download mode. Живой worker
с другим значением не переиспользуется для чтения или input; обычный close
сохраняет авторизацию. Это не требует удаления snapshot или повторного setup.
Explicit origins/domains по-прежнему ограничивают private session-cookie overlay;
только exact origins signed recipe разрешают protected credential delivery.
Внешний сайт не получает Dodo/другие provider credentials из-за одного перехода.

Общий document guard сохраняет отдельный путь получения originals через
`attachmentDownloads`. Навигация не выполняет бинарные файлы и не выдаёт их за
HTML. Special schemes, credentials в URL, source/resource suffix, чувствительные
формы, frame/lease и no-replay guards сохраняются. Внешний документ читается тем
же fixed rendered-text adapter; iframe/canvas не объявляются полным текстом.
Native fixture проверяет target=_blank на другой origin, HTTP redirect и текст
конечного документа через реальный Chromium; cookie/auth scopes проверяются
отдельно от успешной навигации.

### Клик и фокус

Обычные clicks/keys/text/scroll/capture не активируют OS app и не восстанавливают
другую программу для маскировки перехвата. Scheduling flags поддерживают
compositor/input в перекрытом окне. Один startup focus допустим только в
согласованном visible workflow; ручной `show-login` явно показывает своё окно.

Chromium может активировать приложение при создании новой вкладки даже от
background mouse click. Поэтому фиксированный isolated-world content adapter
перед exact координатным click вооружает одноразовый обработчик trusted event.
Он локально читает только href/target/download anchor на bounded click path,
отменяет new-tab default action и передаёт URL внутреннему worker для обычной
same-tab навигации после origin/resource проверки. URL, DOM и текст не выходят
в model-facing API. Произвольного scripting permission и параметра script нет.
Это ограниченная локальная механика ссылок, а не запрет всякого DOM обращения
внутри браузера. Синтетический click с `isTrusted=false` её не запускает.

Top-frame anchor routing не доказывает отсутствие активации от любого site
`window.open`, iframe или нативного диалога. Такие поверхности требуют отдельной
проверки до расширения поддерживаемых сценариев. Нельзя объявлять все popups
проверенными по одному успешному anchor test.

### Вкладки и завершение

Обычные ссылки используют существующую вкладку. Host допускает максимум пять
вкладок за lifetime собственного browser process, включая initial blank и
ручные login popups. Закрытие вкладки и повторный CLI/WS call не пополняют бюджет.
Перед host creation проверяется остаток; все browser-created tabs учитываются
через native event и startup inventory, overflow сразу закрывается и никогда
не выбирается для capture/input. Chrome сообщает onCreated после создания:
краткое появление popup и его возможная активация не предотвращаются этой
post-creation защитой. Сбой удаления блокирует дальнейшее content observation.
Окна/вкладки обычного браузера пользователя находятся в другом профиле.

`close`, lease expiry и worker signals закрывают все normal/popup окна своего
профиля. При сбое graceful stop exact-child watchdog завершает только собственный
процесс; crash не выдаётся за успешное сохранение. User browser process/PID из
claim не убивается. SIGKILL/отключение ОС не позволяет выполнить finally: прежний
durable auth snapshot сохраняется, unknown orphan state не удаляется вслепую.
Detached worker также закрывает собственные окна после десяти минут простоя.
Только валидные рабочие команды (наблюдение, навигация, ввод, загрузка и явный
auth/setup) начинают новый idle interval; status, wait и extension heartbeat
его не продлевают. Уже выполняющийся bounded command завершается до начала
idle interval. Ручной вход и ожидание ответа не отключают этот предел.
Idle использует тот же graceful stop, сохранение encrypted auth snapshot и
exact-child watchdog, что explicit close; это не disconnect/logout. Следующий
явный navigate восстанавливает сохранённую сессию без replay прежнего ввода.
Исходная signed absolute lease остаётся независимой и никогда не продлевается.
После подтверждённой остановки и сохранения snapshot только удаление собственного
временного профиля допускает пять стандартных transient retries Node с линейной
задержкой от 100 мс. Чтение auth/ACL, persist и browser input не
повторяются; исчерпание cleanup сохраняет исходный отказ. Fixture дополнительно
различает закрытые стадии snapshot/persist/cleanup, без исключений и путей.
Остановка дополнительно ждёт native `ChildProcess.close`: `exit` основного
процесса ещё не означает закрытия унаследованных stdio handles. Обе границы
разделяют прежние десять секунд остановки; snapshot/удаление не начинаются
раньше `close`. Это не завершает чужие процессы и не повторяет browser input.
При sharing violation fixture сохраняет исходный отказ и профиль, не входит
из `finally` в повторное рекурсивное удаление того же занятого дерева. Успешный
сценарий по-прежнему обязан полностью очиститься. Закрытая категория failed
target различает diagnostic log, cookie store, Crashpad и остальные owned
entries без выдачи путей; сама категория не доказывает снятие native lock.
Synthetic macOS shutdown diagnostics distinguish only fixed AppKit quit states
(`accepted|refused|not_found|helper_failed`) and a stop-timeout stage. They do not
add retries, extend the deadline or turn an unconfirmed stop into a saved profile;
native output, PID, profile paths and auth content are never reported.

## Входящие вложения

`runVisualSession({ attachmentDownloads: true })` – отдельный signed opt-in,
по умолчанию выключен. Он закреплён в live owner вместе с observation mode;
смена требует обычного close, без сброса auth. Команда `download-attachment`
принимает только свежий frameId и x/y. URL, headers, имя файла, executable,
script, selector и output path не принимаются.

Fixed isolated adapter локально разрешает href exact hit-tested anchor.
Для карточки-кнопки fixed MAIN router на один trusted click тех же координат
перенаправляет `window.open` в private worker без создания popup. Router не читает
DOM/source/site state и не исполняет model-selected JS. В остальных вызовах
остаётся native window.open. Временное разрешение ограничено nonce, frame,
координатами и 5 секундами; blank-window/proxy-location и произвольные popups
не считаются поддержанными. Page messages – недоверенные кандидаты, не authority.
Нельзя обещать отсутствие focus для сайта, который заменил этот router.

В ту же однократную file-button операцию входит native Document GET,
инициированный текущим документом либо его прямым iframe. Только на время
reviewed click Fetch дополнительно останавливает Document на Request stage:
проверяет прежний main frame/generation, parent loader для iframe, GET и signed
URL policy; XHR/subresources, headers/body и POST не читаются и не переигрываются.
Локальный пустой 204 отменяет исходный запрос до сети, сохраняет viewer и
передаёт destination тому же main-document receiver. Request interception
отзывается до единственного фактического GET и при любом выходе. Синтетические
204 всегда `Cache-Control: no-store`: пустая отмена не должна кешироваться
вместо оригинала при следующем явном скачивании.

Ссылка может вести в HTML-просмотрщик, а не сразу в binary. Обычный 200 HTML без
Content-Disposition attachment рендерится штатно и возвращает fresh text/image
observation; HTML/source не сохраняется как файл. File receipt появляется
только после отдельного проверенного binary ответа. Внешний viewer не расширяет
исходный provider поддержкой чужого сервиса: дальнейшая работа передаётся общему
браузерному инструменту либо отдельному подходящему навыку. Чужие menu/export
recipes не накапливаются в исходном provider и не переносятся в generic host.
Rendered ARIA menuitem
проецируется в существующий `button` перед toolbar controls в прежних scan/output
bounds; hidden/disabled/aria-disabled и поля
сохраняют прежние ограничения. Метка меню сама не разрешает edit/share/input.

Browser сам делает один authenticated main-document GET по выбранной ссылке.
Каждый redirect следует той же signed navigation policy: origins/domains
либо явному externalNavigation. Только exact pending main frame
получает временное исключение из attachment DNR rule; subframes, другие вкладки
и обычные navigate/click сохраняют запрет. Fetch stream читает лишь этот ответ,
не HTML/JS/JSON/XML/SVG, XHR, subresources или arbitrary URL. MIME и bounded
headers проверяются до body; body ограничен 20 МиБ и общим 30-секундным deadline
внутри исходной lease. По окончании 204 сохраняет прежний чат; exception
отзывается также при ошибке/detach. Browser-native Save As не получает body.

Host независимо проверяет bytes/MIME: PDF, PNG/JPEG/GIF/WebP/BMP/TIFF,
DOC/XLS/PPT, DOCX/XLSX/PPTX, ODT/ODS/ODP, UTF-8 TXT/CSV/RTF и ZIP. Для octet-stream
тип определяется по сигнатуре, не server filename. ZIP directory ограничен
5000 entries/200 МиБ declared expanded size, запрещает traversal, encryption,
symlink и ZIP64; архив не распаковывается. Container validation не является
антивирусом и не запускает Office/macros/исполняемые файлы. Text не выдаётся
автоматически в MCP; original читается отдельно подходящим reader как data.

`trelio.browser-file/v1` возвращает только ready/reason/sessionId, absolute
filePath, sizeBytes, SHA-256, проверенный MIME и expiresAt. Private stream/base64,
headers, cookies, filename и signed download URL не входят в MCP/logs. Прежние
image/text boundaries не расширяются. Файл создаётся exclusive под случайным
именем в owner-only account attachments cache; links/unsafe ancestors и неизвестные
entries отклоняются. Не больше 32 свежих файлов/200 МиБ, срок 24 часа; cleanup
при следующем получении удаляет только просроченные собственные regular files.
Оригинал переживает close, не входит в auth snapshot и не выдаётся за accepted
Workspace. Разрешённое сохранение в Workspace выполняется обычным Run до expiry.

Чтение входящего файла не даёт разрешения отправлять, загружать, исполнять,
публиковать его, переходить по его инструкциям или расширять аудиторию.
Unsupported/link-required/size/limit – отдельные закрытые причины; generic
HTTP/другой browser transport не является fallback.

## Голосовые сообщения

`VISUAL_AUDIO_DOWNLOAD_API === 'trelio.visual-audio-download/v1'` подтверждает
отдельный signed `audioDownloads: true`. Default false сохраняет прежние
границы файлов и других навыков. Opt-in закрепляется в том же owner/lease;
старый worker требует обычного close с сохранением авторизации.

`download-audio {frameId,x,y}` выбирает один видимый голосовой плеер. Native
`<audio>` отдаёт свой source без input. Для custom control один trusted click
по свежим координатам временно разрешает fixed MAIN adapter наблюдать native
`HTMLAudioElement.play`, включая detached `new Audio()`. В нём нет selectors,
site variables, JS evaluation или model-selected URL. Source должен появиться
за пять секунд; несколько одновременно выбранных audio players не считаются
однозначным результатом. Native play временно muted, после readiness ставится
на паузу с восстановлением прежнего mute; wrapper снимается при любом исходе.
Сценарий не обещает поддержку Web Audio/MediaSource, DRM, streaming playlists,
iframe или произвольных cached/replaced play methods.

HTTPS original получает прежний browser-owned main-document stream с exact
signed origins/redirect/MIME guards. XHR/subresource bodies не перехватываются.
Blob читается fixed isolated reader только при creator origin исходного top
document, без HTTP fallback. Его MIME ограничен до body, bytes и формат
повторно проверяет host. Поддержаны WAV, MP3, OGG/Opus/Vorbis, M4A с audio track,
AAC/ADTS и FLAC; HTML/JSON, video-only/unknown containers и несовместимый MIME
отклоняются. Для полностью проверенного audio-only M4A допускаются также
`audio/aac` и `audio/aacp`: некоторые плееры указывают codec вместо контейнера.
Это не разрешает другие несовпадения MIME, video tracks, повреждённые boxes
или отсутствие audio/data. Receipt получает `audio/mp4` и `.m4a` по контейнеру;
исходные bytes не меняются. Проверка формата не заменяет последующее декодирование reader-ом.

Оба пути делят один 30-секундный deadline внутри исходной lease, максимум
20 МиБ и тот же private attachments cache/receipt на 24ч. Source selection не
даёт новый transfer budget. Navigation/detach отзывают pending source; перед
выдачей blob повторно проверяются frame generation и credential gate.
Модель получает только path/size/SHA/MIME/expiry, без URL, headers и binary.
Чтение не включает ASR и не отправляет запись во внешний сервис: разрешённый
local file обрабатывается отдельно подходящим навыком. Текст/снимок плеера и
успех нажатия не доказывают получение аудио либо содержание речи.

Pure tests проверяют trusted click, однозначность, восстановление native method
и mute, отказ чужого blob и отсутствие HTTP fetch в isolated reader. Native
Chromium fixture проверяет HTTP, lazy blob и native `<audio>`, exact bytes,
сохранение чата, отсутствие replay и новые late guards в обязательных OS lanes.
Синтетический fixture не доказывает совместимость живого плеера конкретного сайта.

Its existing fixture-only callback also retains fixed phases of the ORIGINAL
audio arm (isolated request, MAIN receipt/native-method refusal/armed, source
timeout). The exact pending tab/nonce fences this evidence; only closed phase
names leave the extension. No URL, nonce, source/DOM, exception, extra observation,
input retry or deadline extension is added. Production audio selection is unchanged;
missing phase evidence never establishes a root cause or permission to replay.

Отказ `attachment_unsupported` при `download-audio` может дополнительно вернуть
закрытый `audioDiagnostic`: `audio_response` различает unsupported status,
invalid headers, unsupported MIME и invalid body; `audio_blob` – MIME/body;
`audio_container` – неподдержанный/повреждённый контейнер. Numeric `httpStatus`
допустим только для status refusal. `format` – только фиксированная family
(`wav|mpeg|ogg|mp4|aac|flac|webm|ebml|amr|3gpp|other`), без actual header value,
prefix bytes, source URL или filename. EBML magic не доказывает WebM/audio.
Обычные вложения и startup diagnostics сохраняют прежний контракт. MCP повторно
валидирует точные поля и сочетания; successful result не содержит диагностику.
Наблюдённый 206, MIME family или container signature не разрешают экспорт,
повтор input, новый transport, auth reset или ослабление format validation.
Для container refusal optional `detail` различает `container_structure`,
`mime_mismatch` и только у MP4: `box_bounds|box_count|box_depth|ftyp_header|
video_track_present|audio_track_missing|media_data_missing`. Только mismatch
добавляет `declaredFormat` из закрытых `wav|mpeg|ogg|mp4|aac|flac|other`.
Это классификация прежнего отказа: metadata/tracks/bytes и фактическое значение
MIME не возвращаются, допустимость файла и recovery не меняются.

## Исходящие файлы

`VISUAL_FILE_UPLOAD_API === 'trelio.visual-file-upload/v1'` в host module
подтверждает additive API. Signed provider включает `fileUploads: true` в
`runVisualSession`; default false сохраняет прежний контракт других навыков.
Opt-in закреплён в live owner. Изменение требует обычного close с сохранением
авторизации, а не переиспользования worker со старой policy.

`upload-files {frameId,x,y,files:[absolutePath,...]}` выбирает один или несколько
originals через отрисованную кнопку вложения. Типы/расширения не фильтруются
host-ом: фотографии, видео, документы, архивы и другие bytes остаются данными,
не исполняются и не распаковываются. Допустимость формата определяет сайт.
Пользователь должен разрешить выбранные файлы, destination и действие; скачивание
входящего файла или вход в аккаунт не дают основания на upload.

До website input host проверяет regular files, отсутствие symlink ancestors,
hardlinks/devices/directories и изменения source во время чтения. Он не меняет
originals или их ACL. Сохраняются имя и байты, duplicate basenames из разных
каталогов не конфликтуют. Выделенные private copies вне auth profile передаются
через тот же закрытый host/extension transport; source/staging paths, hashes,
binary/base64, input identity и browser protocol не выходят через MCP.
Windows UNC/device paths и alternate data streams не открываются.

Копирование потоковое, до 1 GiB на файл, 32 originals за вызов, 2 GiB/256 файлов
на browser lifetime и 25 секунд на staging в пределах исходной lease. Это
ресурсные границы локальной копии, не квоты/разрешённые форматы VK. Полный private
command сохраняет прежний deadline. Ошибка до dispatch удаляет только собственную
неполную копию; источник и прежние uploads сохраняются.

После fresh frame review один trusted coordinate click открывает перехваченный
`Page.fileChooserOpened`. Только его top-frame backend node, прежние loader/
navigation generation, origin, manual gate и lease разрешают один
`DOM.setFileInputFiles` с frozen paths. Ни selector, ни произвольный DOM/CDP
не принимаются. Single-file chooser не сокращает multi-file selection молча.
Late/unrequested chooser не получает files и не открывает OS dialog. Manual
handoff штатно отсоединяет debugger, возвращая обычный chooser человеку.

После выбора возвращается fresh text/PNG. Change handler сайта может начать
upload сразу; выбор не доказывает завершение upload, отправку сообщения или
публикацию. Проверь состояние вложений и отдельный результат порученного действия.
Неизвестный результат, detach и timeout не разрешают повтор input; сначала
fresh read-back. Copies после dispatch удерживаются до normal browser cleanup:
renderer может читать File асинхронно даже после потерянного ответа. Они не
попадают в auth archive. Crash сохраняет private остаток по прежнему recovery
контракту, не доказывает upload/save и не разрешает replay.

## Локальное хранение и ручной вход

<a id="protected-authentication"></a>

### Защищённый автоматический вход

`VISUAL_AUTHENTICATION_API === 'trelio.protected-browser-auth/v1'` в модуле
`TRELIO_VISUAL_SESSION_MODULE_URL` подтверждает поддержку исходного API.
Отсутствующий export в старом опубликованном host – недостающая возможность,
а не запрет автовхода. Source не является публикацией runtime.

Подписанный provider передаёт в `runVisualSession` optional `authentication`.
Default `null` сохраняет ручной setup. Значения credentials, selectors и рецепт
не принимаются из CLI/MCP либо веб-страницы. Пример value-free recipe:

```js
authentication: {
  steps: [
    { id: 'password', origin: 'https://auth.example.test',
      challenge: '#login-form', fields: { login: '#login', password: '#password' },
      submit: '#login-submit', manual: ['#captcha'] },
    { id: 'choose-authenticator', origin: 'https://auth.example.test',
      challenge: '#method-choice', action: 'follow',
      target: 'a#use-authenticator', path: '/authenticator', manual: ['#captcha'] },
    { id: 'totp', origin: 'https://auth.example.test',
      challenge: '#authenticator-code-form', fields: { totp: '#code' },
      submit: '#code-submit' },
  ],
  success: [{ origin: 'https://app.example.test', selector: '#account-menu' }],
}
```

Каждый origin входит в explicit `origins` signed provider; wildcard `domains`
не разрешает secret delivery. Не более восьми шагов/success selectors и 16 KiB
на рецепт; field selectors уникальны и ограничены 512 символами. TOTP selector
может быть массивом из шести/восьми ячеек. `submit: null` явно означает native
автоотправку при вводе; host не добавляет click. Provider обязан проверить,
что TOTP challenge действительно означает код аутентификатора, а не SMS/push.
Форма должна отправлять POST в тот же exact origin и собственную вкладку;
неоднозначные/hidden/disabled/readonly fields, CAPTCHA и неизвестный challenge
останавливают процедуру. Generic host не распознаёт смысл любого сайта.

Переход между формами требует дополнительный export
`VISUAL_AUTHENTICATION_TRANSITIONS_API === 'trelio.protected-browser-auth-transitions/v1'`.
Provider проверяет его до использования `action: 'follow'`; исходный v1 API
сам по себе не подтверждает эту возможность. Legacy field-only рецепты
сохраняют прежнюю нормализацию и fingerprint.

`follow` – value-free шаг того же signed recipe и той же private attempt.
В нём нет fields/submit или значений: только exact origin, unique visible
challenge/target, signed exact pathname и optional manual selectors. Host
следует одному HTML anchor в top frame, только в тот же origin/path и `_self`.
SSO query остаётся в ссылке на стороне сайта и не возвращается модели.
Downloads, popup targets, чужой origin, другой path, credentials в URL,
fragment, неоднозначный/скрытый target, CAPTCHA и видимый password/OTP
останавливают переход. Только навигационные ссылки: кнопки и отправка форм
не входят в этот контракт. Подписанный provider отвечает за проверку смысла
ссылки на реальном сайте; host не определяет по тексту любой безопасный вход.

Владелец алгоритма – generic host; provider задаёт проверяемые условия и
направление. Host пишет fence перед переходом, повторно проверяет document
token, origin/challenge/target и расходует document-local шаг до единственного
click. Пароль → выбор метода → TOTP продолжаются под исходным deadline,
с одной attempt ID и без снятия manual/image gate. Потерянный ответ, возврат
на прежний экран или restart не повторяют ссылку и предыдущую форму.
Переходы учитываются в общем лимите восьми шагов и 16 KiB; рецепт требует
хотя бы одного credential шага, отдельного click runner не создаётся.

Pure tests проверяют recipe bounds, old fingerprint shape, одну попытку,
отсутствие values в transition, lost response/loop/restart и pending fence.
Native Chromium fixture проверяет полный password → choice → TOTP проход,
а также foreign/path/popup/download/hidden/ambiguous/sensitive/CAPTCHA отказы.
Provider-specific селекторы, решения и личные данные в host не добавляются.

Базовые public operations принимают только `{}`:

- `credentials-setup` открывает существующий guarded loopback collector с
  логином, паролем и optional TOTP seed. `status`/`wait` наблюдают persisted
  result; повторная команда не открывает вторую pending-форму. Значения не
  предзаполняются и не возвращаются модели. Cancel/timeout/close прекращают
  ввод, прежняя запись сохраняется. Есть явное предупреждение про совместное
  хранение пароля/второго фактора и необязательность seed.
- `credentials-status` возвращает только наличие пригодной записи, без значений.
- `authenticate` выполняется после перехода в текущую owned вкладку входа.
  Success probe используется первым; рабочая сессия не требует нового входа.
  Иначе host приватно читает credentials, генерирует код существующим TOTP
  generator и вводит только в bound top-frame document. Seed/OS key никогда
  не передаются extension. Во время ввода картинки, rendered text и обычный
  input заблокированы. Authenticated state возвращает `saved_unverified` без
  контента: бизнес-readiness отдельно проверяет provider.
- `credentials-forget` только по прямой просьбе удаляет credentials выбранного
  аккаунта, сохраняя browser session и OS key. `disconnect` удаляет обе записи.

#### Защищённый email-код

`BROWSER_MAIL_AUTH_API = trelio.protected-browser-mail-auth/v1` добавляет
`authenticate-mail {mailAccountId}`: только UUID явно выбранного bound IMAP
аккаунта. Recipe остаётся signed provider source. Шаг с `factor: 'email'`
объявляет только `fields.emailOtp` и `mail: {skillId,sender,subjectIncludes,
bodyIncludes,digits}`; 6/8 цифр и literal anchors, без model regex/selector.
Шаги `factor: 'totp'` применяются только к TOTP; обычный `authenticate {}`
не включает email автоматически. Одновременно допускается один email-шаг.

Host сначала проверяет активную сессию. Для нового входа он создаёт private
attempt и value-free `trelio.browser-mail-request/v1` handle. Первый input
ещё не отправляется. Signed mail runtime того же company/member и exact
mail account через private pipe получает matcher, делает readonly UID baseline
и передаёт `begin`. Только persisted baseline разрешает пароль/выбор метода.
Старый UID, включая код из той же секунды, не подходит. Уже открытый email
challenge без такой предыстории остаётся ручным. Один host account lock
не допускает двух одновременных browser-входов через тот же ящик; expiry
не сбрасывает исходные credential fences.

Для non-JS provider host выдаёт только code location
`TRELIO_BROWSER_MAIL_MODULE_URL`; executable — прежний
`TRELIO_LOCAL_FORM_NODE_EXECUTABLE`. Module запускается без CLI arguments,
с `shell=false`, сообщения — captured private stdin/stdout до 16 KiB.
Разрешены `prepare`, `begin`, `deliver`, `status`, `claim-ack`, `record-ack`.
Это не MCP/обычный stdout и не разрешение запускать другой mail executor.
Current signed skill/account admission остаётся обязательным. OTP никогда
не записывается в файл/argv/env/log; matcher/receipt не выдаются модели.

Mail provider читает только новые exact UID через PEEK, сверяет sender,
native recipient, INTERNALDATE, UIDVALIDITY, MIME и единственный код.
После private delivery host ещё раз проверяет исходный document/challenge,
сохраняет fence до fill/submit и подтверждает положительный selector бизнеса.
Только этот результат разрешает отдельный additive Seen для использованного
UID с полным SHA-256 и FLAGS read-back. Его one-write fence сохраняется до
STORE в том же encrypted attempt. Неизвестный исход даёт verify-only, не новый
код, resend, submit или STORE. Ошибка пометки не отменяет состоявшийся вход.
Общий механизм не содержит URL/селекторов/семантики конкретного сервиса.

#### Совместимые обновления recipe

`VISUAL_AUTHENTICATION_COMPATIBILITY_API = trelio.protected-browser-auth-compatibility/v1`
подтверждает автоматическую проверку совместимости. Host разделяет полный
fingerprint исполняемого сценария и fingerprint доставки сохранённых секретов.
Второй включает каждый точный шаг с login/password/TOTP: origin, ID, challenge,
fields, submit, manual guards и порядок. Только factor-tag исключён. Добавление
email/follow либо изменение признака успеха не требуют повторного ввода данных;
изменение secret-bearing формы или адреса требует локального setup.

Для старых записей v1 одного hash недостаточно, чтобы доказать прежние адреса.
Signed provider может передать `credentialCompatibility: {previousRecipes: [...]}`
с полными exact прежними recipe. Host нормализует их той же схемой, проверяет
равенство контрактов доставки и совпадение с hash внутри зашифрованной записи.
Не более четырёх уникальных recipe, без вложенных compatibility, под прежним
общим лимитом 16 KiB. Hash-only exceptions, CLI/page evidence и guessed history
не принимаются. Evidence не исполняется и не меняет полный executable fingerprint.

Новые записи v2 содержат оба fingerprints; последующие совместимые версии
не требуют накопления истории. `credentials-status` проверяет совместимость
без записи. Upgrade выполняется в private копии, а сохраняется штатной
записью новой попытки под existing account owner lock. Pending input и unknown/
pending mail ACK проверяются ДО записи, остаются неизменными и блокируют replay.
Изменение recipe не разрешает reset, resend, повтор submit/STORE или перенос
записи в другой account/company/member. Старый live worker с другим полным
fingerprint по-прежнему требует нормального close; snapshot сохраняется.

Credentials хранятся в `credentials.enc` с AES-256-GCM и отдельным purpose/AAD,
вне профиля/Workspace/cache/package; OS-backed key и account scope общие с
`state.enc`. Совместимость не переносит секрет на новый адрес. Credentials-only account тоже сохраняет
запрет замены потерянного OS key. Секреты не входят в extension source, argv,
environment, screenshots, MCP, telemetry или логи.

Attempt fence записывается до первого ввода и до каждого следующего шага.
Один шаг не отправляется повторно; потерянный ответ, crash, навигация и новый
CLI/worker не снимают pending fence. Успешная процедура сохраняет complete;
неопределённый результат требует ручной помощи. CAPTCHA, SMS/push и TOTP без
seed остаются ручными, без угадывания поля/метода или попыток обхода проверки.
Исходная absolute lease, live account/company claim и независимое согласование
внешних бизнес-действий сохраняются. Новый recipe не реализует fresh OS unlock
для финансово чувствительного provider: его усиленный native gate остаётся
обязательным до использования generic API.

Во время работы owned профиль существует на диске в частном каталоге с native
owner/ACL guards. Это обычный профиль Chromium, а не in-memory incognito.
После нормальной остановки выбранные auth stores упаковываются в bounded
schema-v2 archive, шифруются AES-256-GCM и plaintext каталог удаляется.
Сохраняются Local State/preferences, cookies и network-migration checkpoint, localStorage, IndexedDB,
sessionStorage/WebStorage; History, Login Data, browser sessions, обычные cache
и downloads не включаются. Наличие storage не доказывает вход на конкретный сайт.
Пути, duplicates, типы, file/byte counts и распакованный размер проверяются;
symlink в том числе у промежуточного предка отклоняется.

Ключ находится в Keychain / Windows Credential Manager / desktop Linux Secret
Service. AAD привязывает snapshot к Trelio origin, skill и personal account UUID.
На macOS встроенный в приложение Node может запрещать сторонние native addons
через hardened library validation. Host читает его signing policy и при такой
несовместимости выбирает установленный standalone Node >=22 той же архитектуры
из fixed Codex cache/Homebrew/local roots для signed protected-session CLI и
worker, включая vault-only команды без открытого браузера. Binary должен быть обычным executable
файлом текущего пользователя/root без group/world write; version/platform/arch
и signing policy проверяются под общим пятисекундным deadline. Public identity
probe использует оставшийся исходный бюджет без отдельного cutoff 1.5с; late
result не разрешает запуск или новый probe после deadline. Нет изменения
подписи приложения, OS policy, shell или caller-selected executable. При
отсутствии совместимого Node запуск закрывается как `bootstrap_failed`, до
создания worker claim и доступа к vault; нужен standalone Node.js 22+.
Если совместимый текущий interpreter — Electron в режиме Node, host восстанавливает
его фиксированный Node-mode флаг из observed runtime identity для CLI, bootstrap
и worker по [общему контракту](agent-workspace-runtime.md#native-deepseek-harness-connection).
Унаследованное окружение не выбирает этот режим; standalone fallback его не получает.
Неверный формат старого экспериментального snapshot, повреждение и потеря ключа
не создают гостевой замены. Нет plaintext fallback. Active OS user/admin и
компрометация устройства остаются вне этой модели защиты; API не является
sandbox против произвольного локального кода того же пользователя.

Session-only cookies дополнительно сохраняются через локальный Chrome Cookie
API: Windows может удалить их из Cookie DB при закрытии последнего окна.
Значения живут в RAM host/extension и в том же AEAD snapshot; их нет в worker.js,
argv, environment, MCP metadata/images или production logs. Private transport
отделён от публичного pixels/input API. Cookie schema ограничивает поля, bytes,
количество, signed domain scope и CHIPS identity; transport-only localhost
permission не расширяет auth scope. До первой provider navigation host один раз
восстанавливает overlay. Переподключение не импортирует старое состояние поверх
ручной сессии. Cookie changes в открытом окне учитываются, включая logout;
после последнего tab/window close состояние фиксируется до browser cleanup.
Последнее окно определяется по native create/remove events без async browser
query после закрытия: в этот момент Chromium уже может останавливать профиль.
Explicit empty overlay очищает stale native session rows при следующем запуске.
Старые schema-v2 snapshots без overlay сначала сохраняют native session state;
переход не создаёт гостевую замену и не требует сбрасывать авторизацию.

Native vault preflight выполняется до ручного окна. Его общий deadline
15 секунд проверяется также на
JS-границе: native OS dialog может не отменить pending N-API promise. Поздние
bytes обнуляются и не продолжают создание ключа; неизвестный set не повторяется.
Отдельная копия input живёт до фактического native settle, чтобы очистка candidate
после timeout не меняла байты ещё выполняющейся записи OS.
Timeout сохраняет прежний snapshot и возвращает `storage_unavailable`.
В фазе manual закрыты
снимки и агентский input. `show-login` показывает exact существующее окно.
Закрытие последнего окна либо `ready` сохраняет остановленный профиль до снятия
image gate и возвращает `saved_unverified`. После этого новый browser process
проверяется по картинке кабинета. Дополнительное «готово» после window-close
не требуется. Crash/kill не считается нормальным закрытием и не перезаписывает
предыдущий durable snapshot. Private остаток аварийного профиля сохраняется
для recovery; он не импортируется автоматически как проверенная авторизация.

## Worker и lease

Короткие provider CLI используют один detached worker на personal account.
Atomic claim закреплён за company/member binding; вызовы не продлевают absolute
lease signed descriptor. CLI controller принимает только exact POST path,
application/json, loopback Host и random bearer token из owner-checked private
file; web Origin отклоняется. Ввод/ответ ограничены; wait не больше 30 секунд.
Private transport commands не становятся публичными aliases API.

Чтение и публикация малого `owner.json` используют тот же PID/nonce private mutex,
что защищает читателей mirror. Его пустой root находится вне `active`; живая
приостановленная операция не теряет lock по возрасту. Он защищает только descriptor I/O и cleanup, не browser/network
действия: Windows может отклонить atomic replacement при открытом reader handle.
После ожидания worker сверяет полный исходный claim и прежнюю absolute lease,
затем записывает PID/port один раз. Mutex не даёт права принять чужой claim,
повторить failed write/ACL/input, продлить lease или заново запустить browser.
Native Windows fixture отдельно характеризует обычный открытый read handle;
serialized regression проверяет paused live owner, ожидание, conflicts и отсутствие нового журнала.

Cleanup удаляет только exact собственный claim; encrypted snapshot сохраняется.
Dead-claim recovery не убивает PID из файла и не удаляет неизвестные каталоги.
Watchdog может завершить только созданный текущим worker ChildProcess.
Подключение и сохранение никогда не дают authority на сообщения, публикацию,
контакты, покупки или платежи; этот смысловой review остаётся у модели/человека.

## Проверки и текущие границы

Pure tests: result/MCP projection, loopback auth, AEAD, profile traversal и bounds.
Windows regression читает настоящие `GetStartupInfoW` flags внутри собственного
native child общего GUI launcher и запрещает `STARTF_USESHOWWINDOW/SW_HIDE`;
готовность extension сама по себе не доказывает видимость OS-окна.
Его PowerShell child отключает module auto-discovery и импортирует только
Utility по fixed `$PSHOME` manifest, как существующий native scheduler fixture.
Исходные 30 секунд и Win32 assertions сохраняются; timeout выдаёт только
закрытый startup stage, без native output или увеличения бюджета.
Extension E2E использует synthetic localhost: clicks, русский input, select-all,
scroll, same-tab target-blank routing, cookies/localStorage restore, window-close,
ready, explicit logout без восстановления входа и crash сохранение предыдущего snapshot. Headed Mac test независимо
сравнивает OS foreground до/после каждого действия, без activate/restore tricks.
Native OS vault и detached worker проходят отдельно. При browser/shared/native/
crypto/security/CI изменениях full CI обязателен на macOS, Windows x64/ARM64 и
desktop Linux; local VM не заменяет hosted gate. Только independently closed
assistant orchestration diff по [CI-контракту](runtime-ci.md) может не запускать
неизменённые browser GUI suites; он сохраняет native/proof/package проверки.
Linux CI заменяет только Azure HTTP entry в mirror list hosted runner на
официальный HTTPS archive. Оба APT installer, включая Playwright, используют
20-секундный network timeout и один retry; ошибка index refresh и общий
10-минутный deadline подготовки завершают gate ошибкой, не пропускают fixtures.
Проверка подписей APT и production OS policy не меняются.
Detached session/authentication fixtures сохраняют исходный assertion при ошибке shutdown и всегда
закрывают свой HTTP listener и keyring handle. Если claim не снят, private
профиль не удаляется. Закрытые fixture stages различают ожидание input/manual,
остановку browser, snapshot и снятие claim, без bearer/PID/path/native output.
Native authentication fixture отдельно закрывает только свой синтетический
HTTP listener и активные sockets по AbortSignal, даже если browser queue или
async finally ещё ждёт. При исходной ошибке owned browser отменяется без ожидания
этой очереди; cleanup не заменяет первичный assertion. Unit проверяет active
request, pre-aborted и pending-bind cleanup. Диагностика дополнительно сохраняет
только фиксированные variant/action/state/reason. Это исправляет утечку fixture,
а не доказывает устранение исходной native ошибки; 180 секунд и все assertions
сохранены.
Его существующий fixture-only callback сохраняет последние восемь закрытых
operation/state/reason исходных authentication calls: подтверждение ввода
отличается от последующего read-only probe. Arguments, document IDs, URLs,
credentials и native error prose не выдаются. Это не добавляет probe, повтор,
ожидание готовности или новый budget и само по себе не исправляет отказ.
Manual window-close/ready/logout/crash regression использует тот же общий
fixture-owned HTTP helper, что authentication regression. Ошибка тела выводит
только фиксированные phase/completion/state/reason, errno/syscall, lifecycle stages
и счётчик сохранений до async cleanup. При исходной ошибке own browser отменяется
до ожидания HTTP close; listener и его sockets закрываются до browser queue. Abort отдельно останавливает
только owned test browser. Это сохраняет исходный assertion вместо зависшего
finally; лимит 180 секунд, login/logout/snapshot/crash assertions и production
browser lifecycle остаются прежними. Такой cleanup сам по себе не доказывает
устранение исходного native отказа.
Ранний startup отказ дополнительно сохраняет только закрытый этап control/listen/
owner publish/dependency/browser и разрешённые common process category/operation/
timeout/errno. Используется общий diagnostic parser; Error message/stack и owner
descriptor в этот файл не попадают. Это свидетельство причины, не разрешение
повторить действие, продлить lease или убрать обязательный native gate.

Native office-viewer fixture records fixed action phases/modes, the original
validated result's closed state/reason, control/request counts and frame/title
booleans before cleanup. It never prints page text/labels, URLs, frame IDs or
file paths/receipts. Evidence comes only from the original calls, without an
extra read, readiness wait or input retry. The unique-menu, exact original bytes,
single actual GET and foreground assertions and original deadlines stay strict;
diagnostics do not establish the cause of a missing rendered control.

Fixture logging сохраняет production stdio `ignore`: отдельный диагностический
stderr pipe не создаётся. Chromium helper может унаследовать такой pipe после
exit основного процесса и искусственно задержать `ChildProcess.close`.
Счётчики и закрытые startup-категории читаются из уже существующего private
`native.log`, только bounded tail и без native текста в отчёте. Реальная native
регрессия запускает конечный дочерний процесс с наследующим stderr потомком.
Прежний stop deadline, ожидание exit/close, snapshot/disposal и все headed
authentication assertions остаются обязательными; отсутствие pipe само по себе
не доказывает остановку произвольных процессов или сохранение профиля.

В maintainer live smoke 2026-10-19 через extension механизм открыты Avito и
первое объявление, прочитано описание, выполнены scroll, русский поисковый
input и Enter. Foreground совпал до/после каждого действия, challenge не показан.
Пользователь затем выполнил manual login и закрыл окно. После закрытия окна и затем после перезапуска detached worker
авторизованный кабинет восстановился по изображению. Это live smoke на macOS,
а не доказательство готовности Windows/Linux или любого сценария сайта.
Предыдущий DevTools-pipe эксперимент зацикливал challenge; он удалён из рабочего
пути. Native CGEvent/AX probes также не являются provider fallback.


### Unicode boundaries in fixed text observation

The isolated reader receives the self-contained factory of the SAME generated
Unicode policy. `buildTextObserverScript` serializes only reviewed fixed functions
and the signed boolean, never page/caller code. Title/control prefixes and both
text-page boundaries preserve complete code points within their UTF-16 budgets.
Continuation advances by the actual cut; a manually split offset returns the
existing `invalid_input`. Renderer result validation also refuses lone surrogates.
Tests execute that exact script without lexical host imports and reconstruct a
multi-page synthetic document byte-for-byte. Content/privacy guards, no field-value
reads, visibility, scan limits, origins and native mutation authority are unchanged.
