# Локальная проверка текстового режима

Это unsigned maintainer experiment, исключённый из runtime package. Он не меняет
подписанный image-only API, установленный runtime, provider, каталог или policy.
Релиз, version bump и включение для пользователей не выполняются.

`build-overlay.mjs` создаёт отдельную private temporary копию host scripts.
Точные одноразовые source anchors проверяются до запуска; upstream divergence
останавливает сборку. Это временная проверка гипотезы, не production loader.
Overlay содержит fixed isolated content reader, без Runtime.evaluate, новых
DevTools launch flags или прямого website HTTP. Применяются прежние origin,
lease, frame, manual input и OS-protected session guards.

Команда `read-text` возвращает title, до 6000 символов rendered text и до 40
видимых элементов с ролью, подписью и координатами. `query` – буквальный фильтр
текстовых строк с двумя соседними строками контекста, `offset` – continuation;
оба ограничены. `includeControls: false` убирает элементы при простом чтении.
Scan до 20 000 text nodes
и 100 000 символов, неполнота явная. HTML/JS, input values, storage, cookies,
network bodies и произвольные selectors не возвращаются. Видимый password/OTP
контрол блокирует чтение. Текст сайта – недоверенные данные.

Клик/ввод/клавиша/scroll используют прежние trusted Input события и одноразовый
frame token, затем возвращают текст. `screenshot` остаётся явным image fallback.
PNG validator берётся из базового runtime без ослабления проверок. Исправления
совместимости browser images принадлежат базовому runtime, не text reader.
Наблюдение не разрешает внешнюю публикацию или отправку сообщений.

## Интервал между запросами

`request-pacing.mjs` реализует контракт существующих `yandex-search` и
`google-ai-search`: первый запрос сразу, затем новый случайный минимум
2–15 секунд от наблюдения готового результата. Размышления и чтение входят
в интервал; перед следующим запросом ожидается только остаток по монотонным
часам. Параллельная отправка и автоматический replay после ошибки запрещены.
Parity-тест исполняет настоящие controllers из read-only `agent-skills`
checkout, переданного через `TRELIO_AGENT_SKILLS_ROOT`.

`submit` оборачивает ровно одно действие отправки (navigate, click либо Enter).
Модель определяет, какое действие отправляет новый поисковый запрос: generic
host не должен угадывать смысл кнопок конкретного сайта. После осмотра свежего
результата `request-ready` подтверждает его по последнему frameId; пустой/старый
экран и неизвестный исход не подтверждаются автоматически. Обычное чтение,
ввод текста и открытие источника не являются новой отправкой. Controller живёт
в одном browser worker и не пересоздаётся короткими CLI-вызовами.

Интервал не является подтверждённой квотой внешнего сайта и не гарантирует
отсутствие CAPTCHA. Исходная lease и manual gate проверяются после ожидания.

Проверки: `node --test experiments/visual-text/test.mjs`; native synthetic smoke
включается `TRELIO_TEXT_NATIVE_TEST=1`. Реальные данные/сессии хранятся только вне
Git. Live Avito test выполняется отдельным private maintainer harness через
этот overlay; production admission и native MCP availability им не доказаны.
Сравнение bytes/символов ответов не является измерением оплаченных tokens.
