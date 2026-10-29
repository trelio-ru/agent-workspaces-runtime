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

- Очередь цифрового ассистента – [контракт](docs/assistant-inbox.md).
  Source attention gates intake before models: email INBOX all new; Telegram/MAX
  private incoming or native mention/direct reply. Ordinary group history stays
  at provider; scheduled review uses accepted per-task WORK.md bookmarks, not
  the poll cursor/unread flag. Missing native attention preserves the checkpoint.
  Group originals suppress automatic range ACK (schema15); never mark skipped
  discussion read or erase an existing unknown-write reconciliation fence.
  Trelio inventory/poll/ACK не обрабатывают чужие provider rows; read ACK follows
  complete native-confirmed model delivery, separately from business processing.
  Exact body reads reuse the SAME signed executor and private inbox; encrypted intake/read/reply retains exact native source/revision package selectors.
  Encrypted metadata/guidance use the SAME scoped task reader; queries stay local.
  Structural read-reference syntax shares one pure parser with pre-send privacy
  admission; reuse the common account selector, never a second CLI grammar.
  Syntax does not replace native pass/source/route checks or body evidence. Only
  explicitly selected original slots with independent read evidence and native
  material outcome become processed; a whole pass/read slot is insufficient.
  External ACK attempts are durably fenced before provider invocation; expiry,
  restart or source resume permit read-only reconciliation, never blind write
  replay. A no-write result may release only its own exact attempt token.
  Source READ/ACK diagnostics share the native health/owner notice engine;
  healthy polling cannot erase uncertainty. Aggregate the SAME durable ACK
  journal across conversations; an empty source is never recovery evidence.
  Production read ACK reuses the SAME signed/account/process path and native
  model-read slots (legacy material receipts remain valid), with the original inbox fence at final spawn.
  Fresh tokens cover one conversation; legacy mixed tokens need ALL read-backs.
  Source resume grants only read-back of historical processed slots; schema v7
  seals that lease mode and records current positive verification in the SAME
  journal. It never revives routes or turns unknown/old success into a write.
  Email routing hashes untrusted threading headers, never owner identity. The
  SAME journal v8 binds exact full RFC822 SHA to the independent read slot; one
  UID per fresh ACK, all original UIDs on unknown read-back, never a thread STORE.
  New email sources take a forward-only baseline, never an unread history seed.
  Legacy initial-unread streams remain retained but are not automatically polled;
  existing forward positions, events and uncertain ACK fences are never reset.
  SQLite хранит только bounded structural refs; child stream hints/cursors
  commit in that SAME journal, never as guessed task/ACK authority. Final
  streams sleep until a new native hint; new hints cannot be consumed by an
  older final read. New channel hints retain the ORIGINAL account checkpoint;
  initial history is not narrowed by another client's unread marker and keeps
  the pre-history channel pts. No seed/reset for an existing channel cursor.
  Provider/domain authority,
  private storage и native Codex adapters не заменяются состоянием очереди.
  Native source discovery/passive reads feed that same queue; unknown refs stay
  unrouted/non-waking. Channel hints retain their source position until initialized/backfilled.
  Native per-original routes dispatch only through the canonical Trelio
  task source/permanent chat; source rows never rebind its scheduler. Fresh
  source/task generations and a synchronous pre-start snapshot fence are required.
  Native/business completion alone never processes an external body; dispatched
  unread refs stay pending without a repeat wake or ACK. See inbox schema v6.
  Cloud deletions resolve only from unique exact prior refs in the SAME account
  journal; ambiguous known peers retain the cursor without wake/ACK. Unjournaled
  ordinary group deletions are ignored without inventing peer identity.
  Циклы принадлежат runtime, не native Codex automations: [контракт](docs/assistant-scheduler.md).
  Next-run и обработка inbox коммитятся вместе; marker read-back и one-use
  startInvocation обязательны, queue/exit code не являются завершением.

- Managed skill consent/setup and company Secret recipes reuse SAME owner/consent/grant engine, signed inspector, account catalogue and bounded protected input; no model argv/import/unattended login. Local setup/status resolve native company UUID/slug references; a sole company is selected in code, without browser/UUID questions. See the local-first scheduler contract.
  Public signed human-input setup also selects the bounded setup view without
  pending device consent only on an explicit connection-section read; ordinary
  instructions/execution reads retain task/Run tools. Native pending consent
  still selects setup independently, including encrypted skill reads.
  Test task discovery → existing list change → exact
  owner decision → advertised setup → task view; never add a hidden-call alias.
- Модель ассистента: один owner choice/company, fresh execution state перед
  create/queue; native model/list и exact Desktop pair, без fallback. Policy block
  пропускается без ack/roll-forward, не останавливает другие компании и не
  снимает unknown-outcome fence. [Контракт](docs/assistant-scheduler.md#company-model-selection).
  Existing background status keeps OS state and appends a content-free native
  execution/SELECT-only inbox aggregate: missing model blocks even an empty
  queue, denied/incomplete reads stay unknown/null. No diagnostic poll, claim,
  migration, ACK or active-process inference from retained uncertain markers.
  SAME journal v11 retains only closed original delivery code/stage, atomically
  with uncertainty; old causes stay null. Status batches native-selected pairs
  through ONE existing account/model RPC under its original deadline, without
  a model turn, health write, default selection or readiness claim.

- Продление device authorization проверяется сервером на каждом fixed endpoint;
  локальная дата pairing не запрещает контакт после owner renewal. Отказ не
  удаляет credential и не разрешает blind retry mutation.
- Dedicated plugin использует явный `bridge assistant mcp|hook` profile общего
  signed entry; unknown command не переходит к human bridge/OAuth. Setup MCP
  композирует protected S256/private storage/fixed HTTPS без model credential и
  не объявляет businessReady. Assistant hook использует общий observer/proof/lock
  и exact protected pass journal; без live task-pass registration даёт JSON deny
  с exit 0. Ключ до HTTP сохраняется в OS-backed runtime slot, не human state. Контракт –
  [assistant setup](docs/assistant-scheduler.md#dedicated-plugin-entry-and-setup).
- Cached Desktop discovery retains two native intake definitions before pass activation; execution stays pass-narrowed, and both native/model catalogues keep the existing bound without truncation. See the scheduler intake contract.
- Assistant stdio получает read schemas только из dedicated backend catalog;
  fixed host allowlist и общий bounded MCP transport не создают domain authority.
  Нет schema copy, human OAuth/PAT fallback или automatic tools/call retry.
  Fresh native input inventory checks closed fields/container types BEFORE managed staging;
  generic skill parameters reuse the SAME pure continuation parser, never a copied schema.
  V2 company reads use SAME native schemas/ACL/mirror/exact/files; genuine task or private-owner intake origin, never fake task/Run. Initial discovery includes native search/fetch/contract alongside task/intake tools, without a mid-turn catalogue dependency. Exact repeated scalar schemas may share tool-local definitions only when lossless and smaller; retain native validation and 65 536-byte bounds. See the company-context scheduler contract.
  Cold search reuses the common short-wait registry and SAME signed read child;
  preparing is not an empty/error result. Fresh native admission on every poll,
  exact recipient binding and complete mirror publication remain mandatory. An owned first-sync timeout (direct reason or native AbortError with that exact cause) permits one resumed readonly child only after fresh admission; other failures never retry. Common read errors retain fixed closed codes, never paths/prose.
  Record preparation failures at owned-child settlement, even between polls;
  the common registry's discarded failed entry never resets refusal/retry state.
  The signed request pipe distinguishes its own timeout, caller cancellation,
  process/input failure, nonzero exit, empty/invalid response and output bound;
  none authorizes replay or exposes child output. Reject damaged UTF-8 before
  JSON, never replacement characters in an answer. Test the real native pipes.
  Producer/consumer share one closed failure-code predicate; bare auth codes
  never acquire setup provenance. Invalid pipes expose fixed UTF-8/JSON/frame
  stages only, no output or retry grant. Test actual entry-to-entry refusal frames.
  Owned preparation deadline errors use the SAME private-session Error/Signal
  identity, never public code/elapsed-clock inference; foreign lookalikes stay hard.
  Company-read acceptance composes serial MCP, actual request processes, native
  private storage and managed HPKE/mirror in ONE fixture; component stubs are not
  composed coverage. Keep the synthetic 3,000-file/~150-MiB cold case, exact current
  discussion, warm second question, one own-timeout resume, hard second timeout,
  native ACL refusal and no Task/Run. Original Telegram/model acceptance remains
  separate live evidence, never claimed from the deterministic fixture.
  The isolated native fixture uses the runner-owned short Windows HOME, not a
  long profile-TEMP nesting; filesystem diagnostics expose closed errno/syscall only.
  Genuine common HTTP errors reuse the closed bridge diagnostic vocabulary,
  without backend prose or device-auth recovery. Status-shaped foreign errors
  remain local failures; numeric request-frame tails admit only fixed HTTP buckets.
  Company GET proofs read one fresh atomic Keychain/DPAPI runtime value without
  the exclusive registration lock; pending/ended observations refuse. Registration,
  end and other routes retain their original lock. Native admission-before-key,
  final identity/session/model/recipient fences and all deadlines stay unchanged;
  no snapshot/key cache or retry. Cold pool/poll contention must pass on Windows.
  Native selected ciphertext follows weak snapshot/projection identity through common mirror batches; no cumulative company map or general resolver. Per-response 4096/32-MiB and current-recipient guards remain. Failures expose fixed stages only; no content, counts, paths or automatic retry.
  All local MCP materializers retain closed refusal codes or a fixed local stage,
  never a false endpoint outage. Only the exact native send error retains native
  MCP auth provenance through an arguments adapter; provider errors do not.
  Original attachment E2EE uses native-pinned AAD/range/digest, current managed
  recipient and SAME TRELIOE1/private local-file engine; no plaintext descriptor.
  Before pairing discovery не читает credential. Confirmed local device mismatch
  or fixed assistant native/MCP auth denial preserves exactly six public setup
  tools plus a closed diagnostic, never business authority or false readiness;
  private I/O/malformed/network failures remain hard. Staged replacement uses
  SAME protected enrollment/host lock, explicit native owner receipt and exact
  idle background CAS; no exchange/credential/unknown OS replay. Retained passes
  block before pairing; only definitive denied/expired pending intent may unwind. [Контракт](docs/assistant-scheduler.md#assistant-read-mcp-proxy).

- Личная очередь и server/model response contract – [контракт](docs/agent-workspace-runtime.md#unfiled-response-reminders).
  Пустая очередь не добавляет инструкции; fresh metadata не требует unlock.
  Новые plugin hooks и перехват final response для этого не добавляются.
  Entry-policy генерируется из backend; polling/proposal DTO не расширяются.

- Перед новой функцией или инструкцией модели применяй
  [приоритет алгоритмического исполнения](docs/agent-workspace-runtime.md#algorithmic-execution).
- Подробно комментируй нетривиальный код, особенно security, transport, ACL,
  credential и cross-platform решения.
- Не добавляй tokens, credentials, cookies, sessions, workspace content, signing
  keys или production runtime packages в Git, fixtures и logs.
- Не ослабляй exact confirmation, idempotency/CAS, bounds, attestation, package
  verification и encrypted-company fail-closed behavior.
- Долгая подготовка local action обновляет proof алгоритмически по
  [контракту](docs/agent-workspace-runtime.md#runtime-proof-preparation): только
  проверенная hook-подпись, прежние nonce/session/expiry и bounded invocation;
  неоднозначная mutation не повторяется, TTL proof не увеличивается.
- Hook и doctor используют единый контракт идентичности инструмента. Парсить
  только hook tool_name и exact local envelope; dispatch display из журнала
  не является hook identity. Некорректный распознанный action отклоняется до
  регистрации, а допустимые local templates без nativeTool сохраняют свой ABI.
  Статическая совместимость matcher не доказывает dispatch или trust клиента.
- Codex direct routing и выдача инструментов текущей модели проверяются отдельно:
  [диагностика](docs/agent-workspace-runtime.md#readiness-diagnostics).
  Пустой nested `ALL_TOOLS` не доказывает недоступность direct tools;
  бюджетные подсказки bundled skill относятся только к доступным nested tools.
  Missing direct schema сразу направляет в read-only диагностику по этому
  контракту; исправление предлагается по evidence с сохранением approval.
  Diagnostic read plan выбирает exact следующий native read, но держит результат
  not_checked до client response; request target не меняет folder scope.
  Public availability/recovery измеряется bounded anonymous probes; doctor
  не считается reconnect. Restart/new chat требует отдельного evidence.
  CLI bootstrap возвращает тот же read/recovery plan, без clientKind из env.
  Наблюдаемое отсутствие direct schema даже при ready или stale/failed MCP:
  предложи переключить сам плагин либо полностью выйти из приложения;
  exact required restart не заменяется toggle. Archive не recovery. См. тот же контракт.
- Диагностика сохранённых Codex hooks читает только пользовательский config
  и возвращает enabled отдельно от наличия trusted_hash. Наличие hash не
  включает hook; дисковый снимок не является effective state App Server.
  Диагностика ничего не меняет; исходный config и значения hashes не выдаёт.
- Cursor/Antigravity используют отдельный OAuth-допуск без hook identity.
  Diagnostics принимает их реальные clientKind, пропускает foreign hooks; folder binding/refresh выполняет общий planner/apply; native shell проверяется только в exact loaded plugin root.
  Root-level native manifest исключает startup-миграцию Codex до чтения его
  config, даже если процесс унаследовал CODEX_*; это не OAuth admission.
- Удалённые native clients не получают MCP subprofile или onboarding. Старые
  manifests/hooks не дают заимствовать identity/config поддерживаемого клиента;
  [контракт отказа](docs/agent-workspace-runtime.md#removed-native-clients).
- Generic диагностика учитывает реальный clientKind и выбранный permanent root.
  Routing recovery сначала повторяет protected read в том же чате после restart;
  при необходимом новом чате сохраняется выбранная папка без требования проекта.
  Refresh существующего managed блока допускает соседние root-материалы, не читая их; сохраняет scope и bytes personal rules,
  использует current template/CAS/read-back; без тестовых задач/Run и отправки
  отчёта. Чтение не подтверждает save. [Контракт](docs/agent-workspace-runtime.md#readiness-diagnostics).
- Форматы служебных Codex refs и полную проверку Git-объектов при онбординге
  меняй по [контракту](docs/agent-workspace-runtime.md#folder-service-git).
  Проверяй реальные Git fixtures, сохранение refs/objects/config, stderr при
  exit 0 и literal paths без повышения Git minimum; отказы проверяй до записи.
  Похожий prefix либо допустимое имя сами по себе не доказывают service Git.
- Ошибка распознанного `PreToolUse` передаётся JSON-решением `deny` с причиной
  и process exit `0`: PowerShell может превратить блокирующий exit `2` в `1`.
  Проверяй actual runtime через launcher в `cmd.exe`, Windows PowerShell и
  `pwsh.exe`; одного ненулевого exit code недостаточно для проверки блокировки.
- Hook выполняет ACL/DPAPI и сеть под общим непродлеваемым внутренним deadline
  до тайм-аута клиента. Он включает Node bootstrap/imports/stdin signed runtime;
  entrypoint и exact upgrade replay сохраняют исходные часы, не выдавая новый
  бюджет дочернему hook. Истёкший при запуске срок блокирует первый private read.
  Stable shell до загрузки runtime остаётся отдельной границей времени.
  Windows private transport живёт только в одном hook/bridge invocation и
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
  Hook interoperability gate использует этот же native worker под исходным
  deadline; legacy PowerShell служит только внешней проверкой DPAPI bytes.
  Его offline fixture имеет отдельный bounded startup budget и закрытые стадии;
  этот бюджет не передаётся native hook, worker или production transport.
  Медленная readiness и общий deadline проверяются отдельными protocol fixtures.
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
- Переключение model/effort создаёт новый snapshot в том же чате только через
  capability-gated refresh. Предыдущие Run bindings и expiry сохраняются;
  pending key записывается до HTTP. При сбое чтения effort сохраняй известный
  снимок той же модели с исходным TTL и записывай content-free диагностику.
  Legacy hydration не использует destructive registration; [контракт](docs/agent-workspace-runtime.md#runtime-configuration-refresh).
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
- Долгий `finish` возвращает bounded operation/poll по [контракту](docs/agent-workspace-runtime.md#finish-progress).
  Повтор не создаёт второго writer; прогресс содержит только стадии/счётчики,
  а timeout ожидания не означает принятия candidate или отмены сохранения.
  После прерванного finish exact read-back переиспользует только совпавший
  handoff; lost acceptance восстанавливается лишь при совпадении clean tree/head.
- Сохранение после 429, immutable upload streams и совместимость старого backend
  проверяй по [transport-контракту](docs/agent-workspace-runtime.md#saving-rate-limit-retry).
- Агентские public-feedback screenshots используют plain-only local binary
  transport по [контракту локальных вложений](docs/agent-workspace-runtime.md#локальные-вложения), без новых plugin hooks.
- Универсальный импорт использует [локальный transport](docs/agent-workspace-runtime.md#универсальный-импорт-данных):
  bounded immutable streams, paths только внутри выбранного пакета и compact
  receipts без файловых bytes/sessions; encrypted v1 fail-closed.
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
  Signed Chrome discovery не зависит от locator; field-only сохраняет вкладку.
  Preflight receipt не разрешает replay consume/fill: [контракт](docs/agent-workspace-runtime.md#protected-browser-fields).
  Вложенная форма требует explicit same-origin URL/hash path; native имена
  полей допустимы только с unique/object binding, без AX/UIA value reads.
  Старый host отказывается до checkout; такой план не меняет native surface.
  Discovery останавливается на HTTP(S) WebArea; общие native roots разделяют
  прежний bounded budget. Закрытые stage/limit не разрешают fill retry.
  Native UIA fixture reports fixed startup stages only; its window timeout is
  not permission to relax production admission, deadlines or Windows assertions.
- Hook/bridge/MCP используют общий recovery exact stable loader по
  [контракту](docs/agent-workspace-runtime.md#восстановление-подписанного-рантайма).
  Bridge handoff сохраняет cwd текущего Run через одноразовый process-only
  path; проверяй actual entrypoint после смены cwd загрузчиком. Метаданные,
  credentials и proof через этот путь не передаются.
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
- Для session-bound Agent Skill `CODEX_THREAD_ID` берётся из private exact-ID
  binding текущего hook-события, а не окружения долгоживущего MCP. Отсутствующий
  binding исключает stale inherited ID. Этот ID не даёт прав Trelio или внешнего
  сервиса; название проверяется по exact ID ответа. Регрессия проходит реальный
  hook с отсутствующим/чужим environment ID и отдельный skill subprocess.
- Browser-навыки используют общий host-owned `browser-session-v1`: signed
  descriptor выбирает класс хранения, absolute lease и opt-in manual assist;
  host один раз реализует browser discovery, Playwright bootstrap, process
  lifecycle и profile lock. Provider-specific navigation, selectors, read
  guards и mutation authority в generic host не переносятся; профили разных
  навыков не объединяются.
- Локальные формы и private skills используют общий [renderer](docs/local-forms.md):
  декларативные поля/QR/status, без собственной HTML/CSS-копии и secret prefill.
  Protected input новых company/private Secret использует тот же loopback и writer;
  после persist failure форма терминальна, exact native receipt читается без
  повторной записи. Открытие формы не является сохранением или входом.
- Визуальные browser-навыки следуют [контракту](docs/visual-browser.md):
  Protected automatic sign-in uses signed recipes and host-owned encrypted
  credentials, never model values; see [authentication](docs/visual-browser.md#protected-authentication).
  Missing API support is a runtime capability gap, not a ban on automatic login.
  Signed setup guidance uses `trelio.protected-browser-auth-setup/v1` and the
  common local-form renderer. Static paragraphs/approved-origin links never
  change credential/fence fingerprints or trigger account-setting navigation.
  Compatible authentication updates use `trelio.protected-browser-auth-compatibility/v1`:
  bind reusable secrets to exact delivery forms; legacy migration requires full
  signed previous recipes matching the encrypted hash, never a hash exception.
  Status is read-only; pending input/unknown ACK fences survive without writes.
  Generic email OTP uses `trelio.protected-browser-mail-auth/v1`; provider
  matchers/selectors stay outside host. Capture native UID baseline BEFORE any
  mail-triggering input, serialize browser attempts per mail account, keep OTP
  in private pipes, and grant exact Seen only after positive browser success.
  Persist attempt/ACK fences in the SAME encrypted credential record; a lost
  result permits observation/verify-only, never code/STORE replay.
  Signed authentication `follow` transitions use the additive
  `trelio.protected-browser-auth-transitions/v1` capability: exact same-origin
  anchor/path, no fields/values/popups/downloads or visible password/OTP.
  The SAME private attempt fences the click before dispatch; lost response,
  loop or restart never replay it or the password. Provider selectors stay
  outside generic host; pure and native browser guards are mandatory.
  image-only MCP по умолчанию с явным text opt-in, managed Chromium с private live profile и AEAD snapshot
  после нормальной остановки, native OS keyring, company/member claim и
  непродлеваемая lease. Собственный capture удаляет bounded ancillary iCCP без
  распаковки/выдачи профиля; CRC и весь PNG проверяются, обычный MCP validator
  остаётся строгим. Late bootstrap отменяется до browser launch; main-frame
  navigation отзывает старый frame token; browser load metadata ожидается bounded
  без DOM/selector polling. Window close/ready сохраняют попытку до снятия gate;
  Windows/Linux startup использует внутреннюю new-tab вкладку без URL в argv;
  background-only lifetime без окна применяется только к macOS.
  Новый owned профиль заранее получает обычный continue-session preference;
  одного --restore-last-session недостаточно до первого закрытия Windows/Linux.
  Existing Preferences не перезаписываются; policy ставится до provider URL,
  readiness подтверждается отдельным hello. Fixture diagnostics возвращают
  только закрытый stage/exit и категории sandbox/display, никогда raw stderr.
  Native fixture logging keeps production's ignored stdio; read only its bounded
  private log. An inherited diagnostic pipe must not alter browser stop lifetime.
  Loopback transport permission отделён от origins/content matches; CSP connect
  ограничен exact private портом. Fixture log tails дают только закрытые счётчики;
  detached fixture сохраняет те же bounded stages в частный diagnostic-файл.
  Both detached session/authentication fixtures preserve the original assertion,
  always close their synthetic listener/keyring handle, and never erase an active
  claim/profile. Assertions never print the bearer-bearing owner descriptor.
  The native authentication fixture also closes its own HTTP listener directly
  on abort, independently of a blocked browser queue; closed variant/action/
  state/reason diagnostics retain the original failure and unchanged deadlines.
  Synthetic startup failures retain only closed startup phases and common native
  process categories; messages/paths/owner data never enter fixture evidence.
  Owner-publication failures also retain an allowlisted filesystem syscall;
  authentication fixtures retain only closed reasons and synthetic effect counts.
  A failed authentication bootstrap also retains its current browser's numeric
  exit/signal/category and fixed native-log counters, never raw native output.
  Synthetic auth diagnostics distinguish finished POST responses from consumed attempt steps without raw values; the original success assertion and no-replay fence remain strict.
  Diagnostic evidence alone never fixes or permits replay of a failed action.
  Native manual-close regression shares the auth fixture's owned HTTP abort
  helper: abort its failed producer before HTTP-close waits, close listener/sockets
  before browser-queue cleanup, retain the original assertion, and emit only
  fixed phase/completion/state/reason/errno/syscall/stage counts before cleanup.
  Stopped, already persisted profile disposal has bounded transient rm retries;
  snapshot/auth/ACL/persist/input never replay. Native fixtures retain strict failure.
  Browser stop joins native stdio close as well as main exit under the SAME
  stop budget; failed fixtures retain their profile without recursive rm retries.
  Cleanup diagnostics expose only closed owned-file categories, never paths.
  Detached owner descriptor I/O/cleanup share the SAME PID/nonce private mutex
  as mirror readers; no age-based eviction of a live/paused holder. Its empty root
  stays outside the claim. Recheck complete original ownership/lease after
  waiting; never retry failed writes, ACL checks or browser/credential input.
  Ubuntu namespace restriction решается exact AppArmor profile в CI, без
  --no-sandbox и глобального отключения ограничений; production не меняет OS policy.
  Linux CI APT preparation использует bounded HTTPS mirror recovery, не skip
  native fixtures; [контракт](docs/visual-browser.md#проверки-и-текущие-границы).
  X11 child сохраняет DISPLAY и путь XAUTHORITY без выдачи auth cookie модели.
  crash не доказывает save/login. Native OS tests обязательны.
  macOS protected-session CLI/worker проверяет library-validation policy своего Node. При несовместимом
  embedded Node выбирается проверенный standalone Node >=22 той же архитектуры
  из fixed host roots под общим deadline; signatures/OS policy не меняются.
  Нет plaintext vault fallback, model executable override или запуска shell.
  Native vault deadline подтверждается JS-границей, а не только N-API signal:
  late result обнуляется и не продолжает preflight; неизвестный set не повторяется.
  Его отдельная input copy живёт до native settle, чтобы caller cleanup не менял
  ещё выполняющуюся запись OS. Secret delivery идёт только после выбора Node.
  Обычный запуск не использует DevTools pipe/port или WebDriver spoof.
  Debugger adapter имеет только fixed Page/Input и response-only Fetch guard,
  без чтения body/headers в MCP. Headerless HTTP redirects разрешаются по status;
  конечный main document требует HTML и не может стать download. MIME exception
  DNR даётся exact tab только после включения Fetch; новые popups и subframes
  сохраняют строгий DNR default. Служебная new-tab Windows/Linux переводится в
  about:blank до attach; bounded native metadata wait не делает HTTP.
  Detach отзывает exception и блокирует input
  до завершения policy write. Cookie API отдельно
  обслуживает private session-auth: signed domain scope, bounded schema, CHIPS
  identity и AEAD snapshot, без cookie-valued полей в MCP. Restore идёт до
  provider navigation и не повторяется при reconnect.
  Navigation DNR rules живут в browser session, ставятся до provider URL и
  не требуют persistent ruleset в auth archive. Read/write/inventory failures
  сохраняют отдельные закрытые startup stages.
  Last-window cleanup не считается logout; explicit logout при открытом окне
  очищает overlay.
  Last-window handoff отправляется синхронно по tracked native window events:
  async windows query после закрытия может не получить callback при teardown.
  Legacy snapshots сохраняют native cookies, explicit empty overlay удаляет stale
  session rows. NetworkDataMigrated сохраняется вместе с native Cookie DB.
  Никакие auth values не входят в worker.js. Локальный isolated link router
  читает href exact trusted click для same-tab navigation,
  не выдаёт модели DOM/код и не принимает произвольные scripts/selectors.
  Capture/input не активируют app; native foreground test проверяет это без
  возврата прежнего фокуса. Anchor routing не доказывает поддержку всех site
  popups/iframes. Source probes не входят в package и не являются fallback.
- Входящие вложения – отдельный signed `attachmentDownloads` opt-in в
  [visual contract](docs/visual-browser.md#входящие-вложения). Только координаты
  fresh frame: локальный href/one-click popup router, browser-owned authenticated
  stream, 20 МиБ/30с, exact main-frame DNR exception и отзыв. Не raw HTTP и не
  body/URL в MCP; проверенный original выдаётся private local receipt на 24ч,
  с quota/unsafe-path guards, без исполнения, извлечения архива или auth reset.
  Обычные non-HTML navigate остаются запрещены; native fixtures проверяют
  anchor/button, bytes, сохранение чата и отсутствие focus на всех OS.
- Исходящие файлы – signed `fileUploads` opt-in и additive API marker по
  [visual contract](docs/visual-browser.md#исходящие-файлы). Один coordinate
  click/native chooser получает только frozen regular files, без фильтра
  расширений, DOM/source/bytes в MCP и OS dialog. Source не меняется;
  copies вне auth profile живут до cleanup. Loader/frame/manual/lease и
  no-replay сохраняются; native fixtures проверяют разные типы и multi-file.
  Site acknowledgement is observed in a fresh frame after its own completion;
  chooser dispatch never proves asynchronous site completion or permits replay.
  Native upload fixtures use unique fresh rendered-control coordinates, not
  fixed pixels; missing controls fail before the one chooser click.
- Signed provider может явно выбрать bounded text observation по
  [контракту](docs/visual-browser.md#текстовый-режим). Default image-only не
  расширяется автоматически. Fixed isolated reader не выдаёт HTML/JS, input
  values, cookies/storage или произвольный DOM; оба MCP variants проверяются.
  Явные contenteditable=false документы читаются вне form/label; editable-
  предки, false-вставки в редакторе и ARIA textboxes остаются закрытыми.
  Полнота bounded rendered text проверяется пагинацией, не скриншотами.
  Один completion-based pacing controller живёт в browser worker: те же 2–15с
  от готового результата, что в поисковых навыках, с зачётом размышлений.
  Учёт пяти вкладок включает blank/login popups, не сбрасывается tool calls
  или закрытием вкладки; tabs.onCreated закрывает overflow. Нельзя обещать
  предотвращение самого transient popup creation до browser event.
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
  all-users reinstall из-за отсутствия PATH; missing prerequisite сохраняет
  `TRELIO_SKILL_PYTHON_REQUIRED` до provider launch. Контракт и Windows fixture –
  [README](README.md#поиск-python-для-agent-skills).
- Encrypted mirror – восстановимый кэш: текущий снимок, один ограниченный
  предыдущий и короткий compatibility grace. Startup cleanup охватывает старые
  schema roots без чтения content/keys; sync/read locks, current pointers и
  unsafe paths и смена lock до первого lstat защищены по [контракту](docs/agent-workspace-runtime.md#mirror-retention).
  Fresh sync claims recover only from a protected valid nonce/PID with native
  ESRCH, rechecked under the SAME metadata mutex; live/unknown owners stay intact.
  Cold managed reads keep the original first-sync join bound, not stale-read 30s.
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
- Exact task read сохраняет native `codexThreadTitleReminder` только после
  полной authority для одной задачи с человеческим названием; при пагинации –
  на последней реально включённой странице. Подсказка входит в envelope budget
  до выбора inline/batch и не запускает rename из runtime. Границы и роль модели –
  [контракт exact read](docs/agent-workspace-runtime.md#выбор-scope).
- Файловый поиск использует generated `trelio-workspace-text-chunks.mjs` из backend
  pure module. Проверяй native/local parity, большие файлы, границы UTF-8/слов,
  crypto binding и очистку staging по [контракту](docs/agent-workspace-runtime.md).
  Modern projection reads use at most four <=1-MiB files; large streams remain
  exclusive/serial, and all started workers settle before mirror lock release.
  Chunk/batch bounds не являются лимитом полного индексируемого текста.
  Отсутствующая обязательная browser projection допускает только проверенный
  encrypted accepted bundle с ephemeral private Git по тому же контракту;
  unknown/ACL/crypto/stale ошибки не разрешают fallback или пропуск Workspace.
- Сохраняй чужие изменения и отделяй scope текущей задачи.
- Recovery roots имеют собственные 3 дня retention; sibling Runs не продлевают срок.
  Проверенный recovery source остаётся в retention-only индексе, не в выборе writable root.
  Read-only managed context удаляется общим no-follow helper только после всех guards;
  permissions skipped roots, symlink targets и Git objects не меняются.
  Все native/Git/lock guards обязательны: [cleanup](docs/agent-workspace-runtime.md#restore-и-cleanup).
- Диагностика local MCP следует [контракту](README.md#статистика-ошибок-local-mcp):
  opt-in startup trace пишет только закрытые этапы и process clocks в stderr,
  не request content; запись initialize не доказывает получение клиентом.
  только закрытые технические dimensions, без input/message/paths и без
  auth recovery. Сбой сборщика не меняет ответ исходной операции.
  Failed child допускает только closed failure category; classification не
  разрешает повтор mutation или передачу stdout/message в telemetry.
  Typed HTTP failure bridge передаётся отдельным final frame: только exact
  status и allowlisted backend code участвуют в той же проекции, что in-process.
  Legacy prose не разбирается как HTTP; wrapper и правила повторов сохраняются.
  Сохраняй внутренний skill exit отдельно от CLI exit; Windows private worker
  различает startup/request/protocol/ACL/DPAPI. Hook deny сохраняет закрытый
  failureCode/phase. Hooks имеют отдельную boundary и content-free user-temp
  очередь без private helper; legacy error-only данные не входят в v2 rates.
- In-process и child bridge сохраняют один закрытый transport error contract:
  [контракт](docs/agent-workspace-runtime.md#bridge-transport-diagnostics).
  Не раскрывай native cause/stack и не добавляй автоматический повтор исходного действия.
- Test subprocess fixtures изолируют HOME/USERPROFILE, config roots и origin:
  CODEX_HOME не отделяет hook journal. Проверяй настоящий writer в fixture-очереди
  с cleanup; stdio collector не должен читать рабочий журнал/credential.
  Native locked-Keychain fixtures prepare the real helper in their isolated HOME
  before the unchanged no-UI lookup deadline; cold compilation remains covered
  by the separate migration/rebuild fixture, never a relaxed runtime deadline.
- `search` возвращает компактный `guidance` перед материалами; matching и
  projection генерируются из backend pure module через
  `scripts/build-agent-guidance-search.mjs --runtime-root <checkout>`.
  Проверяй `--check`, scope parity и раздельные limits. Legacy guidance tool
  сохраняется, а searched block не требует второго catalog call.

- Для личных аккаунтов, их миграции и гонок блокировок читай
  [общий контракт](docs/agent-workspace-runtime.md#личные-аккаунты-навыков);
  provider credential code остаётся вне host.
  Private `monitor` capture использует тот же materialized executor: bounded
  pipes/deadline, EOF, без inherited chat, setup/grants или нового admission.
  Explicit private exit DTO не переносится в Error/log и не принимает partial pipes.
  Справка и синтаксический отказ обрабатываются до account I/O/import;
  неизвестная операция не требует ревизии и не запускает provider.
  Ошибка importer сохраняет закрытую причину и numeric exit, без provider
  stdout/stderr или private paths; отказ не превращается в пустой импорт.
  Windows gate проверяет настоящий публичный Python provider как read-only input.
  Monitor fixtures создают собственную real Python installation в native fixed
  root на hosted Windows в обеих Node lanes через общий CI helper, а не зависят от toolcache/PATH; bounded cleanup retry
  применяется только к их disposable cwd после native abort, не к provider work.

- Assistant Workspace: generated policy, one-action profile, dedicated typed continuation/shared read/write engine, isolated inspection cache, no human auth fallback. [Contract](docs/assistant-scheduler.md#shared-workspace-http-profile).
  Handoff outcomes follow the exact native target scope, never the enclosing task pass: named Workspaces omit taskOutcome; task targets use no_status_change.
  Positive common LOCAL/DRAFT recovery may reopen its exact owned sibling once;
  retain original files and return reconciliation evidence in the same chat.
  SAME registry/metadata resolve later actions and heartbeat after restart;
  no model directory, blind retry, automatic transfer or material-outcome shortcut.
  Recovery uses a constant-length shared sibling locator and a verified same-Run registry handoff; source files remain intact, unrelated copies remain ambiguous.
  The stdio host owns one lazy finish/heartbeat coordinator across fresh native
  proxies; every poll reauthorises before registry access. EOF stops its timers,
  not a writer or private state. Exercise real serial MCP frames, not one proxy.
  Exact own-Run lifecycle reuses the human bridge private-session lifetime, not
  setup's 45s timer; caller/outer-hook cancellation and per-IPC/native lease checks remain.
  Native pre-handler 429/REQUEST_RATE_LIMITED has a closed distinct transport
  result; it never authorises request replay, pass release or auth replacement.
  Lost finish handles return only a fresh native-authorised read nextCall, never
  a finish retry, cached receipt, owner approval or implicit claim.
  Draft/blocker continuity has no task outcome; only handoff/finish supplies
  no_status_change to the SAME handoff validator. Test the real shared command boundary.
  Preserve validated encrypted inspection/lifecycle descriptors across the real
  isolated stdin boundary. Keep closed local recovery codes through MCP without
  copying raw exceptions or authorizing replay; parent validation is not delivery.
  Exercise facade -> coordinator -> real child and automatic heartbeat together;
  both parent boundaries reuse one closed plan projection.
  Native opaque echo equality uses existing canonical JSON, not object insertion
  order; reordered schema objects pass, added/tampered fields still refuse.
  Exact encrypted task reads reuse the SAME schema-v3/MVCC reader and hydrator,
  with native-selected ciphertext bundles only; no general payload resolver or
  human key fallback. Other encrypted adapters retain their independent gates.
  Accepted inspection reuses the SAME readonly Git/container cache with fresh
  native snapshot and final managed pass/envelope read-back; only exact pinned
  snapshot/bundle reads open. Child fixtures require an executed-flow sentinel,
  never inherited NODE_TEST_CONTEXT plus exit 0 as proof.
  Encrypted Run arguments are sealed before remote MCP with the SAME payload
  codecs and native writer validation; accepted material completion uses that
  SAME readonly inspector and observed signer. Never send/persist own WORK.md
  body/path/plaintext hash or treat a model witness as authority. Native
  acceptance/retraction/noChange/head/recipient guards remain independent.
  Managed setup uses that SAME registration/read-back, OS store and local scope
  opening/TRELIOE1 self-test; key_verified grants no content execution. See
  [identity ownership](docs/assistant-scheduler.md#managed-encryption-identity-ownership).
- Managed encryption identities use the SAME crypto codecs and assistant OS store,
  isolated by device/company; no human remembered-key fallback. An identity is
  not an envelope grant or encrypted readiness. [Contract](docs/assistant-scheduler.md#managed-encryption-identity-ownership).
- Assistant task skills use the SAME `skill_run`, signed loader/cache, account
  catalogue and process engine. Only native read admission/profile changes;
  no human cache/import/setup fallback. [Contract](docs/assistant-scheduler.md#shared-task-skill-execution).
  Signed v2 humanInputCommands reuse the SAME setup parser; existing-account
  auth requires independent owner/account admission and never ordinary task prefixes.
  Task commands additionally require provider-owned signed command prefixes;
  legacy/missing policy fails before account/bootstrap and again at execution.
  Policy v2 also rejects signed denied options (token/equals forms); no host
  provider map or model-selected executable/window/time override is introduced.
  This restriction never authorizes sending, source ACK or owner setup.

- Typed custom fields use native type/revision discovery and the SAME value protector; no model type hint or structural prose over HTTP.
- Owner dialogue keeps only structural question IDs in SQLite/stdin; live pass reads supply answers, never action approval. See [contract](docs/assistant-scheduler.md#private-owner-dialogue).
  Content preflight compares the real three-field device-client identity with
  the exact versioned host journal; test their production composition, not two
  identical fixture DTOs. Storage schema metadata grants no extra authority.
  Managed encrypted content/whole skill argv reuse the SAME protector/payload collision/hydrator;
  Comments reuse SAME human mention canonicalizer and signed native member/group selection.
  reject model markers before signing. Native exact target/proof/ACL/CAS and
  persisted owner consent remain independent. No human bridge or content journal.
- Source owner identity uses fresh native bindings, never usernames or a task grant: [contract](docs/assistant-scheduler.md#owner-identity-metadata-for-source-routing).
- Model-free source reads reuse common signature/cache/account execution under a fresh fixed device HTTP profile; no human admission cache, task pass, ACK or cursor reset. [Contract](docs/assistant-scheduler.md#model-free-source-reader).
  Local-first setup reserves inert available refs; only owner activation enters the SAME inbox. See scheduler.
  Fixed device discovery returns scoped desired refs only, never login/readiness
  evidence; failed/foreign/malformed inventories are not empty configurations.
  Source/task reads share the managed device namespace without human import or
  unbound labels. Separately admitted owner empty-create uses the SAME catalogue
  and atomic intent receipt; no provider login or readiness inference. Current
  signed worker discovery does not require a new stable plugin setup ABI.
  Stable encrypted owner source setup uses SAME exact config/recipient hydration and human-only form;
  Email incoming verification reuses one passive signed read and the same
  registration recheck as polling; it never commits its baseline/cursor or
  proves SMTP/background readiness. Source reasons remain closed/typed.
  Poll diagnostics use native per-source revision/CAS and shared account notices;
  reporting failure never replays work or changes committed inbox positions.
  Protected email setup needs a separate native owner opt-in; fixed browser-only
  capture reuses the same account/process engine and original human-input budget.
  It never accepts credentials/terminal args or upgrades passive reader limits.
  Telegram QR/2FA onboarding uses the SAME protected provider and catalogue;
  exact native `login` admission is separate from email configure/empty-create.
  Telegram receives only `login --qr`; the SAME catalogue selects its account
  through host metadata, never an invented provider `--account` argument.
  Failed setup projects only closed stderr categories or the original process
  exit through the SAME worker/facade; empty stdout never hides a failed child
  as malformed success. Raw provider text/fields stay private, with no retry.
  MAX reuses the same handoff path; only a fresh short native probe verifies
  its structural login, never owner identity/streams/processing readiness.
  Login never proves owner identity, enables intake/ACK or clears hook trust.
  MAX native sources require owner-selected numeric maxChatUrl and reviewed
  provider >=2.11.0. SAME journal/read observer/receipt/ACK engine; native IDs,
  complete unread time-range, one exact browser frame and verify-only unknown
  recovery, never names, a global receipt switch or numeric-ID range guesses.
  No local source/codec fixture proves a real MAX/Windows business E2E.
  Encrypted public source/task skill uses SAME managed keys/native builders and
  injected exact ciphertext hydration, not human payload resolve or a second
  executor. See [contract](docs/assistant-scheduler.md#encrypted-source-and-exact-public-task-skill).
- Assistant reads/writes, native guidance, relation intents, accepted file refs/read/delete and question choices forward live dedicated schemas/closed names only; no human approval flags or retries. [Contract](docs/assistant-scheduler.md#task-local-domain-actions).
  Encrypted comment files reuse native-selected signed own-Run manifests and the SAME local human link composer before whole-body sealing; native atomic references/receipts remain authoritative, never server append to opaque JSON.
  Structural encrypted own-error retraction uses the SAME native authority; correct files through an ordinary encrypted Run and verify before correction attachment.
  Content-bearing calls also require the SAME fresh managed company-mode
  preflight before remote MCP; unsupported encrypted content refuses locally,
  never after exposing prose to HTTP. Native ACL/CAS and sealed adapters remain
  independent; failed/missing mode is not plain and no mode cache is authority.
  Independent task creation uses the SAME proxy/native creator with a sealed
  owner decision and project ACL; no inherited pass/chat/route or sender proof.

- Terminal continuation: SAME pass/ledger, native trusted-hook preflight and indexed history. Twenty attempts per actual hook/signed-worker fingerprint still bound generic completion repair. Native failed model-capacity turns use separate unlimited paced continuations (1/5/15/30 minutes), SAME chat/pass and schema19 episode clock; no quota/network/prose inference or uncertain-action replay. Empty READY retries keep their original provision/thread. Health v3 notifies after fifteen minutes and preserves independent latches. See scheduler contract.
  Done permits only its existing canonical Run settlement, never new work; original binding/source receipts remain exact.
- Dispatch uncertainty uses SAME independent device-health/owner notice latch; clear only after durable native/business completion + pass release + zero retained device uncertainty, never metadata/READY. Health protocol v2 preserves old closed readers.
- Assistant maintenance: fixed signed worker, no replay/health shortcut; terminal retained-pass updates require the SAME coordinator lease/native evidence. MCP facade survives runtime updates. Check the exact public installable ref before any plugin install intent; pending publication preserves latches. Only legacy hook 0.1.0 admits native directory-only .git metadata. Current hooks require exact immutable git-subdir ./plugin with no installed .git; never prune cache or migrate trust. Plugin hooks live in a separately immutable companion: main-only updates preserve native hashes, real hook/loader changes require native review; never migrate approval or hide mutable bytes. Desktop maintenance defaults on for new/existing paired devices, preserves explicit owner opt-out and uses signed official MSIX under the SAME idle/setup locks; no standalone CLI update, forced exit or uncertain install replay. Plugin maintenance is an explicit per-device setup opt-in: SAME updater/retention, idle coordinator + setup mutex, durable native install/GUI/registered-parent handoff and bounded rollback; never automate hook trust. Installer options must cross both real entry boundaries; unknown commands/values refuse before spawn. Desktop discovery/exit uses SAME native worker, exact AppModel/user/session/process-root/generation, and normal Restart Manager; a tray-hidden process stays running, never force or local compile. [Contract](docs/assistant-scheduler.md#model-free-maintenance).
- Visible task chats reuse SAME native App Server + system URI opener. Empty bootstrap persists the explicit pair; ONLY the second GUI-queued READY earns provision. No exec/resume/hidden fallback, queue replay or model-mediated reconfiguration of old private history. See scheduler native invocation.
  Stored history may project an active GUI turn as interrupted; keep its reader
  until actual completion/failure or the original deadline. This snapshot never
  certifies cancellation, pass release, a new invocation or recovery authority.
- Native account preflight diagnoses login only from explicit missing auth, not
  prose or a cached catalogue. Only a fresh completed turn with exact read-back
  clears its current login latch; unrelated health incidents and delivery fences
  remain independent. [Contract](docs/assistant-scheduler.md#company-model-selection).
- Codex discovery shares that original deadline. A fixed public mode of the SAME
  native binary selects the current-user Codex package; vendor four-file hashes
  select/verify its exact existing relocated copy, never cache scanning/newest.
  The optional official standalone current/bin layout needs complete companions.
  No Store execution, PATH/ACL edit or install; discovery proves no business result.
  SAME narrowed child environment preserves Windows ComSpec/PATHEXT with canonical
  case for native MCP CMD discovery; no broad env/shell/auth fallback. Native CI
  uses pinned public CLI + isolated synthetic MCP, never an account/model turn.
- Background composition keeps one native pass per signed worker and private
  invocations per call. Supervisor updates only between cycles; full backend
  readiness gates business work. Task folders use compact full-identity hashes; prototype writable roots require review. OS installation and Windows E2E remain explicit
  gates: [contract](docs/assistant-scheduler.md#protected-background-host-composition).
- Maintainer QA launcher is source-tree-only: SAME verifier/factories, exact QA
  origin/configuration hash, isolated state; no model/env origin override or readiness mock.
- Explicit Windows autostart uses current paired identity/SID, least-privilege
  InteractiveToken and exact native Task Scheduler read-back. No saved password,
  autologon, force overwrite, active-pass termination or readiness inference.
  New tasks grant that principal control of its own registration; legacy ACLs
  are not silently rewritten or elevated during a maintenance retry.
  Explicit maintenance setup verifies native task write access and may resume
  only an untouched failed bootstrap; polling never resets candidate/trust latches.
  Constant public-metadata PowerShell is separate from native ACL/DPAPI.
  Owner rebind may inspect/hash and remove only the exact idle old registration;
  protected snapshot/identity fences never permit stop, force, path execution or session migration.
  It loads only the fixed OS utility manifest with process-local autoload off;
  slow module discovery never permits extra time or OS mutation replay.
  [Contract](docs/assistant-scheduler.md#per-user-windows-autostart).
- Windows console/taskbar branding uses the SAME signed native binary after
  host/registration checks. Its pipe accepts only that host's assistant UUID;
  only the direct parent's exclusive visible classic console may change.
  Shell relaunch/name/icon properties precede its version-independent AppID;
  relaunch targets only the SAME registered task, never bare Node/plugin paths.
  Window HICONs and PE taskbar artwork derive from one reviewed PNG array.
  No hidden/shared/ConPTY host, foreground change, new window, registry/pin edit
  or Node.exe patch. Restore only own values at EOF/partial failure; private
  worker startup stays unchanged. Native fixtures independently read Shell
  properties/resources and EOF restoration, not only WM_GETICON receipts.
  See [contract](docs/assistant-scheduler.md#owned-windows-console-and-taskbar-identity).

## Граница plugin/runtime

- Human Codex main и его immutable hook-компонент используют тот же verifier и
  retention по [контракту](docs/agent-workspace-runtime.md#human-codex-hook-component).
  Descriptor не разрешает установку/trust: missing, disabled и повреждение
  остаются отдельными состояниями. Main-only update не меняет hook identity.

- Долгие цели: host передаёт только проверенные UUID/path locators собственного
  `assistants/<assistantUserId>/WORK.md` по stdin; формат/continuation – task-worker
  нового плагина и [контракт](docs/assistant-scheduler.md#durable-human-goal).
  Markdown не хранится в SQLite, не становится authority и не закрывает цель
  по одному native completed turn. READY не создаёт task files.
- Mention-derived comment-only access uses native `workMode:discussion`, the SAME
  permanent chat/proof/comment/outcome engine, no Workspace or periodic timer.
  Completion requires the exact native reply receipt; full task material and
  source ACK guards stay independent. See the scheduler discussion contract.

- Plugin shell и host runtime имеют независимые release histories и versions.
  Изменение runtime само по себе не требует plugin release.
- Local tools/list скрывает owner/admin-only private-skill management по свежему
  content-free backend каталогу, без cache/pairing/Run. Диагностика остаётся доступна;
  проверка точного действия остаётся у backend. [Контракт](docs/agent-workspace-runtime.md#catalog-permissions).
- Публичный ABI между ними включает signed package format, три entrypoint mode
  `bridge|hook|mcp`, descriptor fields, `minimumPluginVersion`, environment
  variables, headers и typed upgrade errors.
- Открытый Codex MCP сохраняет точную loader-selected shell после записи initialize
  и восстанавливает только её проверенные bytes при внешней очистке cache.
  Dedicated assistant MCP and supervisor reuse that SAME retention engine with
  a closed assistant profile and separate code-copy namespace. Supervisor waits
  for its snapshot after exact OS registration, before starting workers; no
  human plugin store, version discovery, trust/config change or task replay.
  An in-place empty regular cache root uses only nonrecursive rmdir before
  verified publication; concurrent bytes/permission errors stay protected.
  Handoff validates the new loader; exact old journal paths are native CAS
  comparators only and need not survive cache pruning.
  A freshly verified/retained newer native main may supersede settled pending
  activation only at the official desired version, preserving the rollback
  basis and normal trust/GUI/MCP/parent gates; unknown install/dependency phases
  and the failed version never authorize adoption or another native add.
  Hook-free assistant main re-clones reconcile only through the same saved
  receipt, detached commit/content and bounded Git reader; see preservation.
  Dedicated cache/native-manifest version is independent of the pinned common
  loader's TRELIO_PLUGIN_VERSION; exercise the actual differing versions.
  Native root .git index/reflog changes require all remaining bytes to match.
  Repacked pack/idx/rev additionally require the SAME isolated verified Git to
  decode ALL objects, independently check their Git IDs and compare SHA-256
  content, then fence both complete trees. Legacy config/hooks/refs remain byte-strict;
  retained schema-v1 copies keep their full historical digest. Never
  rewrite receipts, overwrite checkout metadata or relax changed-code/trust guards.
  Lifecycle работает и для signed runtime: независимый runtime не делает
  hook/skill paths независимыми от plugin cache. Нужен production MCP regression
  внешнего обновления, cleanup после EOF и сохранение trust; см.
  [контракт](docs/agent-workspace-runtime.md#codex-plugin-preservation).
- Production loader передаёт exact `TRELIO_PLUGIN_ROOT`,
  `TRELIO_PLUGIN_VERSION`, `TRELIO_HOST_RUNTIME_VERSION` и immutable runtime
  source directory. Runtime не предполагает совместное source tree.
- `host-runtime/scripts/report-context-budget.mjs` – maintainer-only report и не
  входит в package. Он принимает exact plugin checkout через `--plugin-root` либо
  `TRELIO_AGENT_WORKSPACES_PLUGIN_ROOT`; plugin source не vendored.
- Исходные args, checkpoint binding и search selection исполняются по
  [контракту](docs/agent-workspace-runtime.md#исходные-аргументы-local-continuation).
- Все non-UI local-company continuations используют один model-visible
  `continue_trelio_local_action` envelope (`route` + exact native
  `parameters.arguments`). Новый native MCP-метод добавляется в backend
  capability matrix и runtime dispatcher без изменения plugin shell. Отдельный
  `render_trelio_local_proposal` сохраняется только из-за MCP App metadata, а
  typed `continue_trelio_workspace_action` – как bridge ABI. Старые отдельные
  local aliases и прямой pre-envelope ABI не публикуются в MCP catalog.
- Standalone encrypted rules read через `context/native_read` использует native
  settings handler и верхний hook proof, сохраняя history/editing и native
  envelope. Этот exact переход не допускает context mutations или guessed
  operation; [контракт](docs/agent-workspace-runtime.md#выбор-scope).
- Encrypted exact Workspace UUID reads use only their scoped MVCC/authority
  snapshot and final live ACL/revision fence after pinned files, never a company
  mirror or stale fallback; see [contract](docs/agent-workspace-runtime.md#поиск-и-отдельный-файл).
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
- Сохранённый start и итоговые task proposals собирает общий generated assembler по
  [контракту completion](docs/agent-workspace-runtime.md#машинная-подготовка-итоговых-task-proposals).
  Решения остаются локально; stale/использованный план не повторять автоматически.
- Локальное открытие proposal-файлов, signed evidence, E2EE и fallback –
  [контракт](docs/agent-workspace-runtime.md#локальное-открытие-proposal-файлов-в-codex).
- Default selection context/worklog вложений, прямой пользовательский exception
  и E2EE local selection – [контракт proposals](docs/agent-workspace-runtime.md).
  Pure policy генерируется из backend, вручную не дублируется.
- Основная инструкция новой публикации ограничена 16 КиБ UTF-8 до encryption.
  Полный `get_agent_skill` после hydration/projection и final text delivery
  ограничен 40 000 байтами; превышение возвращает typed error без action и
  без обрезки. Shared guard генерируется из backend, а не поддерживается копией.
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
- Завершённая правка получает commit на русском. Сначала опубликуй только task
  branch, открой PR и дождись SUCCESS exact head во всех обязательных hosted
  jobs выбранного по полному diff [CI-профиля](docs/runtime-ci.md). Unknown,
  shared/native/crypto/hook/transport/CI изменения требуют full с четырьмя visual
  OS jobs; narrow никогда не пропускает Windows/ARM64, proof/signature/package.
  Только затем `npm run git:push-main`:
  это transport интеграции, он не создаёт PR и сам не запускает/не проверяет CI.
  Push workflow на `main` не заменяет PR gate. Raw push в `main` запрещён.
- После интеграции выполни из canonical checkout
  `npm run git:finish-worktree -- <absolute-task-worktree>`.
  Git paths и complete-read guards – [контракт](docs/agent-workspace-runtime.md#git-output).
- Stable runtime tag создаётся только по явной команде на runtime release и
  пушится атомарно через `npm run git:push-main -- --tag vX.Y.Z`.

## Проверки

- Сначала запускай узкие изменённые tests, затем required direct tests выбранного
  CI-профиля; full сохраняет весь список из `.github/workflows/runtime-tests.yml`.
  Versioned planner/tag verifier используют exact base/head и полный Git diff,
  не labels/path filters. Narrow допускает только closed assistant orchestration;
  imports/rename/delete/mode/неоднозначный entry block возвращают full. Maintainer
  docs не расширяют code allowlist; docs-only остаётся full. Tag заново проверяет
  diff, run/attempt и все required conclusions; старый/неполный receipt не waiver.
- Перед локальным gate `npm run check:dependencies` должен подтвердить exact
  dependency tree; `node_modules` разных worktree не объединяются.
- Package builder проверяй двумя сборками одной версии и byte comparison.
- Cross-repository tests запускай с exact plugin root. Ошибка отсутствующего
  plugin checkout – setup failure, а не повод копировать plugin source.
- Перед commit проверь `git diff --check`, полный diff и clean status после commit.

- Windows retention claim: bounded pre-claim sharing retries only; private validation and operations never replay. See [mirror retention](docs/agent-workspace-runtime.md#mirror-retention).
- Concurrent plugin-retention tests await both real publication finalizers before the next prune; file visibility alone is not completed verification. Keep EPERM/access-denial and observed-deletion cases separate.
- Assistant Remote MCP reuses the SAME resolver/forms/vault/doctor/call with a managed namespace, native-selected encrypted config and one-use owner attempt fence. Presentation views never grant authority; see [contract](docs/assistant-scheduler.md#managed-remote-mcp-profile).
- Assistant owner actions: live sealed intent and persisted decision; never text-as-approval. Signup is one attempt, never site success. See [contract](docs/assistant-scheduler.md#exact-owner-action-client).
- Encrypted incremental saves select only the own Run/current native v2 base manifest; same reader/crypto and native late ACL. See the scheduler encrypted Run contract.
- Assistant pass completion: exact backend receipt + native read-back; schedule/inbox commit together, protected journal released afterwards. No replay on expiry. [Contract](docs/assistant-scheduler.md#durable-pass-completion-and-recovery).
- Encrypted own cancellation reuses SAME managed audit codec/store/collision equality; no human retry/local cleanup.
- Own abandoned Workspace cancellation is a server-only dedicated MCP call with
  the live native schema. No local cancel/restore alias, cleanup, human flag or
  automatic retry; accepted history, goal and cycle are retained. See the
  [MCP contract](docs/assistant-scheduler.md#assistant-read-mcp-proxy).
- Own accepted-error repair also forwards only the live dedicated native schema:
  retire evidence, safe accepted correction, exact file verification and record
  the correction before a valid business outcome. No local history reset or
  replay; source/correction never complete the goal. Same MCP contract.

- Private/company Secret use retains separate holder/ACL and SAME grant/crypto.
  Company recipe snapshots never replace native rights. Browser plans reuse the SAME one-use/native browser engine,
  with original grant/pass/device/Run binding and isolated fallback storage.
  No human profile, arbitrary CLI/reveal or uncertain fill replay. Signed v2
  private authentication reuses the same Run grant/package/account/process engine;
  exact auth-only argv/env, late one-use consume, all provider output discarded.
  Encrypted existing-card use sends commandId only; native immutable public
  recipe/current managed recipient/pass/Run precede consume. No model argv/prose
  crosses MCP. Browser preparation uses SAME URL parser, origin/hash-only native
  grant and managed target signature; full path/query stays local. Native
  context/consume retain genuine ABI/recipient/pass/Run checks. Unknown root or
  step fields fail before HTTP. NEW encrypted private cards admit only native
  neutral metadata and sealed owner policy; task prose stays company ciphertext,
  values use SAME private writer/receipt. No company credential adoption/export.
  Sealed empty-card receipts
  remain metadata. Separately reviewed NEW password generation reuses the same
  HMAC/fingerprint/keyring writer, original pass/Run and protected device material;
  no human intent flags, new vault, account signup or existing-card adoption. Metadata operations
  return before the local executor: [contract](docs/assistant-scheduler.md#private-secret-browser-use).

- Rate-limit and portable-Workspace fixtures budget all sequential CLI calls plus
  setup/cleanup separately; each original process deadline and no-duplicate
  assertion remains enforced. Diagnose timeout with closed stage/counters, never private output.
  Isolated encrypted inspection/open/recovery/finish/material fixtures likewise
  have one bounded aggregate budget, with actual child exit/signal and closed
  phase evidence; never infer their internal failure from elapsed time alone.
  Saved-handoff fixture cleanup retries only its disposable cwd after every
  child has settled and its server closed; no bridge request or assertion retry.
  Synthetic Windows carrier uses the scheduler's exact Utility manifest import,
  not module auto-discovery; fixed phase diagnostics never extend its deadline.


- Verified owner source intake is taskless, uses the SAME observer/proof/native
  creator/question/account engines; private owner replies use signed exact peer
  and schema16 attempt/positive receipts without task/Run. Lost provider results
  reconcile only through exact completed-call text + signed journal candidate +
  native read-only admission/header/peer/full-text checks, never another send.
  Never replay unknown
  sends or borrow task ACK. Native
  incoming/original linked sender ID is separate from model command assessment.
  Keep per-event routes and original-event dedup across company redirects;
  native create alone does not earn ACK. Positive native cancellation plus an
  explicit source generation remains the normal retry. Schema17 permits only a
  fresh native-confirmed unread/terminal owner attempt under a changed trusted
  runtime/hook fingerprint, with preserved original history and bounded retries.
  Recovery also requires the original native terminal marker; domain cancellation
  cannot replace it. Closed ACL/transport failures defer, never recreate or ACK.
  Additional company bind uses immutable owner origin-source/revision admission
  and SAME atomic catalogue intent receipt/CAS, preserving sessions/old bindings;
  no human import, pre-existing binding adoption, provider login or extra vault.
  See `docs/assistant-inbox.md` schema v9 and the scheduler companion contract.

NEW company Secret uses the SAME neutral sealed intent/generator/metadata/value
writer. `secret_company_create` binds holder, current task Run and original
valueSource; protected input records one native begin before the SAME local
form. Unknown begin/save permits exact receipt GET only, never automatic form
or value retry. Private legacy holder/AAD and company ACL remain separate.

- First outgoing reply routing is a post-capture structural projection on the
  SAME signed provider/account/pass engine. No hint failure repeats send; native
  bind stays independent. See [contract](docs/assistant-scheduler.md#first-outgoing-reply-routing).

- Existing-task source triage reuses SAME v10 inbox, nullable-thread native company
  selection, observed proof and two-tool `source_intake` view. Freeze original UUID
  batches before native begin; selected-scope refs must come from the actual signed
  journal before body access. Complete-inventory local queue preference grants no
  company authority. Native `routed` receipts install only original batch routes;
  presentation-only `intakeKind:'route_existing'` never grants read/ACK/binding.
  Conversation binding is nonexclusive correlation; every inbound batch is
  partitioned by original UUID across tasks before delivery. Permanent task
  routing and material processing remain independent. See the
  schema v10 section in `docs/assistant-inbox.md`; no per-message chats or new executor.

- MAX account roots require native selected `maxChatUrl:null`, fresh
  `maxAccountDiscovery:true` admission and signed provider >=2.13.0. Observe only
  the browser-emitted full sync/list chain through marker zero; no partial unread
  folder becomes an account cursor. Persist native dialog hints and original
  account-time seed atomically in SAME streams. First inventory has zero hints;
  exact native history covers only NEW rows strictly after that original seed.
  Old unread never becomes automatic work; full unread ACK coverage stays separate. Read-elsewhere flags never filter new references.
  Exact-chat rows retain >=2.11.0 semantics; body/material/ACK/owner proof remain
  independent, and root/exact duplicates choose only one local triage queue.
  [Contract](docs/assistant-inbox.md#native-max-through-the-same-source-journal).

Pre-native reservation recovery: SAME delivery v12/bit0/lease and native history, not a new invocation; see docs/assistant-scheduler.md.


Native DeepSeek Harness connection принадлежит host runtime; его bootstrap,
compatibility range, exact qualification fixture и границы описаны в [runtime contract](docs/agent-workspace-runtime.md#native-deepseek-harness-connection).
Folder planner и apply dispatcher используют общий exact client predicate;
проверяй returned action целиком для setup и refresh, а не только file writer.
Public plugin shell для этого клиента не меняется.
Потерянная MCP-сессия восстанавливается только по полному pre-dispatch отказу
из этого же контракта: один handshake/retry, без OAuth и blind mutation replay.

- Codex quotas use model-free native account/rate-limit reads and independent
  device metering CAS. Below-10 notices default on per owner assistant setting;
  hard blocks/recovery stay mandatory. Never infer recovery from reset clocks
  or percentages, purchase credits/reset limits, or replay unknown work.
  See [metering](docs/assistant-scheduler.md#codex-usage-monitoring).
