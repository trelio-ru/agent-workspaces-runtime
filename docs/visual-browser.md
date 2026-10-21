# Визуальный браузер Agent Skills

API v1 принадлежит generic host. Signed provider задаёт
HTTPS origins/domains, начальный адрес и явный observationMode; binary, профиль, ключ и executable
выбирает host. Source не означает stable release или завершённую native-проверку.

## Что получает модель

`trelio.visual-browser/v1` передаёт PNG отдельным MCP image block и закрытые
metadata: frame/session IDs, размеры, scroll flags, фазу и безопасную причину.
Модель не получает HTML, DOM/AX, site JS, storage, cookies, headers, response
bodies, clipboard, selectors или произвольный результат протокола браузера. Отдельный signed opt-in для
входящих файлов возвращает только локальный receipt, описанный ниже.
У API нет команд evaluate, произвольного CDP, raw HTTP или чтения профиля.
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
input values, textarea/select/contenteditable contents. Rendered password/OTP
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

Chromium запускается как обычный headed browser с собственным приватным профилем.
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
Та же закрытая диагностика доступна synthetic detached fixture, чтобы его
startup не оставался скрытым за общим `bootstrap_failed`.

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

Main-frame HTTP(S) navigation ограничена signed origins/domains через DNR.
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

Browser сам делает один authenticated main-document GET по выбранной ссылке.
Каждый redirect ограничен signed origins/domains. Только exact pending main frame
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

## Локальное хранение и ручной вход

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
и signing policy проверяются под общим пятисекундным deadline. Нет изменения
подписи приложения, OS policy, shell или caller-selected executable. При
отсутствии совместимого Node запуск закрывается как `bootstrap_failed`, до
создания worker claim и доступа к vault; нужен standalone Node.js 22+.
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

Cleanup удаляет только exact собственный claim; encrypted snapshot сохраняется.
Dead-claim recovery не убивает PID из файла и не удаляет неизвестные каталоги.
Watchdog может завершить только созданный текущим worker ChildProcess.
Подключение и сохранение никогда не дают authority на сообщения, публикацию,
контакты, покупки или платежи; этот смысловой review остаётся у модели/человека.

## Проверки и текущие границы

Pure tests: result/MCP projection, loopback auth, AEAD, profile traversal и bounds.
Extension E2E использует synthetic localhost: clicks, русский input, select-all,
scroll, same-tab target-blank routing, cookies/localStorage restore, window-close,
ready, explicit logout без восстановления входа и crash сохранение предыдущего snapshot. Headed Mac test независимо
сравнивает OS foreground до/после каждого действия, без activate/restore tricks.
Native OS vault и detached worker проходят отдельно. CI обязателен на macOS,
Windows x64/ARM64 и desktop Linux; local VM не заменяет hosted gate.

В maintainer live smoke 2026-10-19 через extension механизм открыты Avito и
первое объявление, прочитано описание, выполнены scroll, русский поисковый
input и Enter. Foreground совпал до/после каждого действия, challenge не показан.
Пользователь затем выполнил manual login и закрыл окно. После закрытия окна и затем после перезапуска detached worker
авторизованный кабинет восстановился по изображению. Это live smoke на macOS,
а не доказательство готовности Windows/Linux или любого сценария сайта.
Предыдущий DevTools-pipe эксперимент зацикливал challenge; он удалён из рабочего
пути. Native CGEvent/AX probes также не являются provider fallback.
