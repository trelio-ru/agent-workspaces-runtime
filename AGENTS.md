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

- Перед новой функцией или инструкцией модели применяй
  [приоритет алгоритмического исполнения](docs/agent-workspace-runtime.md#algorithmic-execution).
- Подробно комментируй нетривиальный код, особенно security, transport, ACL,
  credential и cross-platform решения.
- Не добавляй tokens, credentials, cookies, sessions, workspace content, signing
  keys или production runtime packages в Git, fixtures и logs.
- Не ослабляй exact confirmation, idempotency/CAS, bounds, attestation, package
  verification и encrypted-company fail-closed behavior.
- Hook и doctor используют единый контракт идентичности инструмента. Парсить
  только hook tool_name и exact local envelope; dispatch display из журнала
  не является hook identity. Некорректный распознанный action отклоняется до
  регистрации, а допустимые local templates без nativeTool сохраняют свой ABI.
  Статическая совместимость matcher не доказывает dispatch или trust клиента.
- Диагностика сохранённых Codex hooks читает только пользовательский config
  и возвращает enabled отдельно от наличия trusted_hash. Наличие hash не
  включает hook; дисковый снимок не является effective state App Server.
  Диагностика ничего не меняет; исходный config и значения hashes не выдаёт.
- Generic диагностика учитывает реальный clientKind и выбранный permanent root.
  Refresh существующего managed блока сохраняет scope и bytes personal rules,
  использует current template/CAS/read-back; без тестовых задач/Run и отправки
  отчёта. Чтение не подтверждает save. [Контракт](docs/agent-workspace-runtime.md#readiness-diagnostics).
- Ошибка распознанного `PreToolUse` передаётся JSON-решением `deny` с причиной
  и process exit `0`: PowerShell может превратить блокирующий exit `2` в `1`.
  Проверяй actual runtime через launcher в `cmd.exe`, Windows PowerShell и
  `pwsh.exe`; одного ненулевого exit code недостаточно для проверки блокировки.
- Hook выполняет ACL/DPAPI и сеть под общим непродлеваемым внутренним deadline
  до тайм-аута клиента. Windows private transport живёт только в одном hook/bridge invocation и
  повторно проверяет каждый путь; результат проверки прав не кешируется.
  Зависший private subprocess отменяется, lock очищается, следующий hook
  продолжает ту же client session без ручного удаления состояния.
- Startup private worker ограничен 20 секундами, каждый запрос после readiness –
  10; общий hook deadline не продлевается. ACL и DPAPI используют один процесс,
  сохраняя CurrentUser, entropy, read-back и отсутствие секретов в argv/env/log.
- Production ACL/DPAPI использует подписанный native Win32 helper, без shell,
  CLR, local compile и fallback. Hosted MSVC собирает x64/ia32/arm64; source SHA,
  PE machine и binary hashes проверяются до упаковки. Tag использует только
  exact PR-tested artifact; обычная учётная запись и ARM64 проверяются отдельно.
- ACL worker использует собственные pipes без shell/CLR и смены code page. Запрос ждёт readiness под исходным deadline;
  startup/dispatch различаются, readiness не является подтверждением ACL.
- Штатная Windows-диагностика запускает read-only readiness worker до чтения
  private state; при отказе state остаётся `not_checked`, без повторных ACL
  helpers. Отдельный public HTTPS probe не доказывает OAuth/MCP или причину
  startup; ограничивай время/cleanup, не возвращай raw output/paths и не меняй
  настройки, trust, ACL, сертификаты или credentials. Контракт –
  [README](README.md#диагностика-windows-worker-до-готовности).
- Windows ACL сравнивает SID напрямую, без PowerShell `Access`/NTAccount
  resolution. Ошибки чтения private state не означают отсутствие state:
  ACL/I/O/deadline сохраняют исходный отказ, не запускают новую регистрацию.
  Timeout diagnostics используют только закрытые stage/operation/timeout;
  worker progress не продлевает deadline и не раскрывает paths/identities.
- Для private runtime state и поиска transcript используй один resolver текущего
  `hookInput.session_id`; inherited environment ID допустим только при отсутствии
  ID события. Все повторы захвата lock ограничены общим deadline, ошибки удаления
  stale lock не проглатываются и не разрешают recursive cleanup либо смену ACL.
- Codex effort ищется в ближайшем `turn_context` назад блоками с ограничением
  памяти/времени, не фиксированным tail. Большой tool output не скрывает context;
  неполное/повреждённое новое наблюдение не заменяется effort старого хода.
  Контракт и fail-closed границы — [README](README.md#ошибки-lifecycle-hooks).
- При отсутствии paired bridge hook возвращает точный pairing code и публичный
  approval nextCall; обычное подтверждение клиента сохраняется. После approval
  один retry исходного MCP завершает pairing и admission в той же задаче.
  Pending SessionStart observation сохраняется до регистрации; stdout hook
  содержит только JSON, без CLI status line успешного обмена и private verifier.
- `BRIDGE_SESSION_INVALID`/`BRIDGE_SESSION_REQUIRED` с HTTP 401 до hook admission
  или в login требуют отдельного authenticated read-only подтверждения. Только
  подтверждённый отказ запускает обычный pairing без ручного revoke и сброса
  OAuth; прежний credential сохраняется до approval и защищённой записи замены.
  403, transport/5xx, version gate и противоречивый успешный probe не разрешают
  замену. Исходная рабочая mutation не повторяется этим recovery.
- После неоднозначной mutation сначала установи live state; blind retry запрещён.
- `SessionStart source=compact` восстанавливает обязанность полного чтения
  pinned authority без замены Run/session. Контракт и ограничения –
  [README](README.md#ошибки-lifecycle-hooks); stable hook definition не меняется.
- Поля `knownInstructionRevisionKey`/`knownInstructionLayerKeys` принадлежат
  host runtime: model hints удаляются до проверки доставки. Bounded adapter
  подтверждает полные direct Codex native и typed local mirror-read responses
  в текущем контексте; namespaces и company route не смешиваются;
  Claude, неизвестный формат, Code Mode и ошибки возвращаются к полному чтению.
  Оптимизация не ослабляет admission/proof и не кеширует тексты правил.
- Browser fill повторяет только value-free preflight: временно отсутствующее
  AX/UIA-дерево проверяется не более трёх раз на той же поверхности. Activation,
  потерянный ответ и передача значения повторов не допускают; field-only grant
  сохраняет привязку к embedded-вкладке даже при недоступном дереве.
- Hook/bridge/MCP используют общий recovery exact stable loader по
  [контракту](docs/agent-workspace-runtime.md#восстановление-подписанного-рантайма).
  Только подтверждённый missing shell требует restart; ACL, I/O и update failure
  сохраняются отдельно. Никакого второго verifier, cache scan или blind replay.
- Server-returned paths и commands трактуются буквально. Runtime не сканирует
  plugin cache и не выбирает похожую установленную версию.
- CLI main-module guard сравнивает realpath exact файлов: Node раскрывает
  directory aliases, а argv сохраняет исходный путь. Это не меняет запрет
  symlink entries в package/private storage. Проверяй всю signed loader →
  entrypoint → hook цепочку через Windows shells, а не только stub loader.
- Синхронизация названия task-чата – optional механика runtime после Run lifecycle,
  без модели: [контракт](docs/agent-workspace-runtime.md#названия-связанных-codex-чатов).
  Exact locator выбирает сервер, inherited `CODEX_THREAD_ID` не заменяет его.
- Подписанный Agent Skill может получить `CODEX_THREAD_ID` из ограниченного
  окружения для точного локального чтения названия чата. Этот ID не даёт прав
  Trelio или внешнего сервиса; название проверяется по exact ID ответа.
- Browser-навыки используют общий host-owned `browser-session-v1`: signed
  descriptor выбирает класс хранения, absolute lease и opt-in manual assist;
  host один раз реализует browser discovery, Playwright bootstrap, process
  lifecycle и profile lock. Provider-specific navigation, selectors, read
  guards и mutation authority в generic host не переносятся; профили разных
  навыков не объединяются.
- HTTP-ошибки browser document сохраняют только numeric status и approved
  origin через общий observer; transport failure не получает выдуманного кода.
  Provider interpretation и отсутствие credential reset/replay сохраняются по
  [контракту HTTP-диагностики](README.md#http-диагностика-браузера).
- Изменения системного открытия браузера проверяй по
  [контракту opener](docs/agent-workspace-runtime.md#системное-открытие-браузера):
  Windows handoff требует настоящего URI handler test; mock argv не подтверждает
  передачу полного OAuth URL, а успех helper не заменяет OAuth callback.
- Persistent messenger adapter по умолчанию использует `startInBackground=true`: headed
  process запускается без startup window, provider guards ставятся до exact
  inactive CDP target, viewport не изменяет native window bounds. Host не
  активирует и не скрывает чужие приложения. Launch policy и target binding
  проверяются deterministic tests и synthetic macOS focus smoke.
  Последующие `context.newPage` также неактивны; `bringToFront` не меняет фокус.
  Явный `startInBackground=false` допустим только для согласованного ручного
  шага, когда пользователь попросил показать окно. Provider popup guards
  обязаны исключать самопроизвольное открытие foreground-окон.
- Playwright bootstrap допускает отдельную системную Node/npm-установку, даже
  когда host работает своим Node и очищает runtime PATH. Запускать можно только
  exact `npm-cli.js`, найденный в стандартном absolute layout либо через
  проверенную realpath-ссылку `~/.local/bin/npm`, текущим Node и с `shell:false`;
  `npm`, `npm.cmd` и другой shell-wrapper не исполняются.
  Windows дополнительно проверяет `nodejs` в absolute `ProgramW6432`,
  `ProgramFiles` и `ProgramFiles(x86)` без расширения PATH; native bootstrap
  проверяется Windows job по [контракту](docs/agent-workspace-runtime.md#browser-bootstrap).
- Python discovery учитывает стандартную per-user установку Windows без
  ambient PATH, сохраняя canonical-path проверки и isolated startup. Не требуй
  all-users reinstall из-за отсутствия PATH; контракт и Windows fixture –
  [README](README.md#поиск-python-для-agent-skills).
- Незавершённый encrypted mirror не публикуется. Resume-кэш файлов остаётся
  зашифрованным и привязанным к exact head; свежие manifest/ACL и bounded
  обработка read-conflicts всех этапов чтения обязательны по
  [runtime contract](docs/agent-workspace-runtime.md). Публикация не повторяется;
  HTTP 409 `LOCAL_CONTEXT_GENERATION_CHANGED` сохраняет code без backend payload/details.
- Пакетное чтение больших task rules сохраняет immutable части/revision и
  legacy single-part формат. Бюджет полного MCP envelope генерируется из
  backend `shared/task-read-budget.ts`; его копию вручную не менять.
  Native/local bounds и continuation проверять
  по [контракту exact read](docs/agent-workspace-runtime.md).
- Файловый поиск использует generated `trelio-workspace-text-chunks.mjs` из backend
  pure module. Проверяй native/local parity, большие файлы, границы UTF-8/слов,
  crypto binding и очистку staging по [контракту](docs/agent-workspace-runtime.md).
  Chunk/batch bounds не являются лимитом полного индексируемого текста.
- Сохраняй чужие изменения и отделяй scope текущей задачи.
- Диагностика local MCP следует [контракту](README.md#статистика-ошибок-local-mcp):
  только закрытые технические dimensions, без input/message/paths и без
  auth recovery. Сбой сборщика не меняет ответ исходной операции.
  Failed child допускает только closed failure category; classification не
  разрешает повтор mutation или передачу stdout/message в telemetry.
  Сохраняй внутренний skill exit отдельно от CLI exit; Windows private worker
  различает startup/request/protocol/ACL/DPAPI. Hook deny сохраняет закрытый
  failureCode/phase, но lifecycle hooks не входят в общий счётчик.
- `search` возвращает компактный `guidance` перед материалами; matching и
  projection генерируются из backend pure module через
  `scripts/build-agent-guidance-search.mjs --runtime-root <checkout>`.
  Проверяй `--check`, scope parity и раздельные limits. Legacy guidance tool
  сохраняется, а searched block не требует второго catalog call.

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
- Все non-UI local-company continuations используют один model-visible
  `continue_trelio_local_action` envelope (`route` + exact native
  `parameters.arguments`). Новый native MCP-метод добавляется в backend
  capability matrix и runtime dispatcher без изменения plugin shell. Отдельный
  `render_trelio_local_proposal` сохраняется только из-за MCP App metadata, а
  typed `continue_trelio_workspace_action` – как bridge ABI. Старые отдельные
  local aliases и прямой pre-envelope ABI не публикуются в MCP catalog.
- Имена полей action и native preparation tools не становятся executable
  aliases. Unsupported operation возвращает безопасный recovery к exact
  `action.arguments` до registry/process access; произвольный вход не отражается.
  Подсказки добавляются только ошибкам, а обычный context budget не увеличивается.
- Cross-repository tests используют реальный plugin checkout через
  `TRELIO_AGENT_WORKSPACES_PLUGIN_ROOT`. CI checkout является read-only input и
  не попадает в package.
- Production runtime source меняется только вместе с targeted tests и актуальным
  контрактом. Generated package вручную не редактируется и не коммитится.
- Optional proposal `preparationRef` подставляет только structural CAS fields:
  [контракт](docs/agent-workspace-runtime.md#подстановка-служебных-полей-предложений).
  Stale требует нового чтения, без auto-refresh/save; legacy fields сохраняются.
- Итоговые task proposals собирает общий generated assembler по
  [контракту completion](docs/agent-workspace-runtime.md#машинная-подготовка-итоговых-task-proposals).
  Решения остаются локально; stale/использованный план не повторять автоматически.
- Default selection context/worklog вложений, прямой пользовательский exception
  и E2EE local selection – [контракт proposals](docs/agent-workspace-runtime.md).
  Pure policy генерируется из backend, вручную не дублируется.
- Личный слой навыка в model projection сохраняется отдельно от signed base;
  lazy/reuse semantics проверяются в `tests/trelio-mcp-results.test.mjs`.

## Git workflow

- Канонический checkout регистрируется через `npm run git:configure-main` и
  остаётся clean на `main`.
- Перед правкой выполни `git fetch --prune origin`, `git status -sb` и
  `git rev-list --left-right --count HEAD...@{upstream}`.
- Работай в отдельном worktree/ветке `codex/*`, созданном через
  `npm run git:new-worktree -- codex/<task-slug>`. Успешная команда также
  устанавливает и проверяет exact devDependencies; после bootstrap-ошибки
  продолжай в сохранённом worktree через напечатанный `worktree:bootstrap`, не
  создавая вторую ветку. `--skip-bootstrap` допустим только без локальных
  отчётов, сборок и тестов.
- Завершённая правка получает commit на русском и интегрируется только через
  `npm run git:push-main`; raw push в `main` запрещён.
- После интеграции выполни из canonical checkout
  `npm run git:finish-worktree -- <absolute-task-worktree>`.
- Stable runtime tag создаётся только по явной команде на runtime release и
  пушится атомарно через `npm run git:push-main -- --tag vX.Y.Z`.

## Проверки

- Сначала запускай узкие изменённые tests, затем весь список direct Node tests из
  `.github/workflows/runtime-tests.yml`.
- Перед локальным gate `npm run check:dependencies` должен подтвердить exact
  dependency tree; `node_modules` разных worktree не объединяются.
- Package builder проверяй двумя сборками одной версии и byte comparison.
- Cross-repository tests запускай с exact plugin root. Ошибка отсутствующего
  plugin checkout – setup failure, а не повод копировать plugin source.
- Перед commit проверь `git diff --check`, полный diff и clean status после commit.
