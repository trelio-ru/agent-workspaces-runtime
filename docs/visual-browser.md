# Визуальный браузер Agent Skills

Экспериментальный API v1 принадлежит generic host. Signed provider задаёт только
HTTPS origins/domains и начальный адрес; binary, профиль, ключ и executable
выбирает host. Source не означает stable release или завершённую native-проверку.

## Что получает модель

`trelio.visual-browser/v1` передаёт PNG отдельным MCP image block и закрытые
metadata: frame/session IDs, размеры, scroll flags, фазу и безопасную причину.
Модель не получает HTML, DOM/AX, site JS, storage, cookies, headers, response
bodies, clipboard, selectors или произвольный результат протокола браузера.
У API нет команд evaluate, произвольного CDP, raw HTTP или чтения профиля.
PNG проверяется до обычного stdout limit: размер, chunks/CRC и отсутствие
текстовых/вложенных данных. Невалидный marker не возвращается как обычный stdout.

Модель выбирает координаты, обычный текст или клавишу из закрытого набора.
Одноразовый frame действует 60 секунд и расходуется до input dispatch.
Неизвестный результат не разрешает повтор внешней записи. Динамическая страница
может сдвинуть контрол после кадра: token не заменяет визуальный смысловой review.

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
и Input события. Downloads ограничивает response-stage DNR guard. Это всё ещё debugger API; отсутствие startup
DevTools mode само по себе не гарантирует принятие внешним сайтом.

Extension подключается к одному host-owned loopback WebSocket: exact path,
exact extension Origin и случайный 256-bit token в private worker resource.
Token не передаётся в argv, Chromium environment, MCP или logs. WS transport
не является DevTools endpoint. Heartbeat и cleanup не стоят за зависшим input;
переподключение не переигрывает предыдущую команду.

Windows startup открывает `about:blank`, затем extension ставит navigation policy
и переводит owned вкладку на начальный адрес. Readiness означает отдельный hello
после обоих этапов, а не только открытый socket. В synthetic native tests
диагностика ограничена stage/exit и категориями sandbox/display; raw stderr,
native сообщения, пути и token никогда не печатаются.

Main-frame HTTP(S) navigation ограничена signed origins/domains через DNR.
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

## Локальное хранение и ручной вход

Во время работы owned профиль существует на диске в частном каталоге с native
owner/ACL guards. Это обычный профиль Chromium, а не in-memory incognito.
После нормальной остановки выбранные auth stores упаковываются в bounded
schema-v2 archive, шифруются AES-256-GCM и plaintext каталог удаляется.
Сохраняются Local State/preferences, cookies, localStorage, IndexedDB,
sessionStorage/WebStorage; History, Login Data, browser sessions, обычные cache
и downloads не включаются. Наличие storage не доказывает вход на конкретный сайт.
Пути, duplicates, типы, file/byte counts и распакованный размер проверяются;
symlink в том числе у промежуточного предка отклоняется.

Ключ находится в Keychain / Windows Credential Manager / desktop Linux Secret
Service. AAD привязывает snapshot к Trelio origin, skill и personal account UUID.
Неверный формат старого экспериментального snapshot, повреждение и потеря ключа
не создают гостевой замены. Нет plaintext fallback. Active OS user/admin и
компрометация устройства остаются вне этой модели защиты; API не является
sandbox против произвольного локального кода того же пользователя.

Native vault preflight выполняется до ручного окна. В фазе manual закрыты
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
ready и crash сохранение предыдущего snapshot. Headed Mac test независимо
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
