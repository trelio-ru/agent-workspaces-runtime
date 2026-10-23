# Общие защищённые локальные формы

Host API `trelio.local-form/v1` – один offline renderer для встроенных форм
Trelio, platform skills и company-private skills. Им пользуются сбор PAT,
логина/пароля/TOTP, ключа шифрования, подтверждение установки и Remote MCP write,
а также страницы успеха, отмены и ошибки. Это presentation API, не сервер
credentials и не новая mutation authority.

## Подключение из подписанного навыка

Host удаляет унаследованные `TRELIO_LOCAL_FORM_MODULE_URL` и
`TRELIO_LOCAL_FORM_NODE_EXECUTABLE`, затем выдаёт собственные exact module URL
и Node executable каждому исполняемому навыку. Agent Secret env binding не
может заменить их. Эти переменные содержат только публичное расположение кода.

```js
const ui = await import(process.env.TRELIO_LOCAL_FORM_MODULE_URL);
if (ui.LOCAL_FORM_API !== 'trelio.local-form/v1') {
  throw new Error('Supported host local-form API required');
}
const html = ui.renderLocalFormPage({
  title: 'Подключить сервис',
  sections: [{ fields: [
    { name: 'login', label: 'Логин', type: 'text', required: true },
    { name: 'password', label: 'Пароль', type: 'password', required: true },
  ] }],
  form: { action: '/credential', nonce, actions: [
    { label: 'Сохранить', name: 'decision', value: 'save' },
    { label: 'Отмена', name: 'decision', value: 'cancel',
      variant: 'secondary', formNoValidate: true },
  ] },
});
```

`html` направляется только в приватный browser response. Он не входит в MCP,
tool output, prompt, логи, Git или Workspace. Навык не включает собственную
копию HTML/CSS, remote assets или секретный default value. Если опубликованный
host ещё не поддерживает API, требуется его штатное обновление; исходник на
`main` не доказывает публикацию. Не искать похожую версию и не копировать
renderer как fallback.

Python и другие native runtimes используют тот же код: exact
`TRELIO_LOCAL_FORM_NODE_EXECUTABLE`, decoded file path из проверенного
`TRELIO_LOCAL_FORM_MODULE_URL`, один аргумент `local-form-render`, `shell=false`.
JSON definition передаётся по private stdin, HTML забирается только через
captured stdout. Никакие данные формы/QR не входят в argv или environment.
Функция и этот process adapter применяют одну schema. CLI принимает до 512 КиБ
UTF-8 JSON, не открывает браузер, файлы, credentials, account или Run. Ошибка
даёт только `LOCAL_FORM_INVALID`, пустой stdout и exit 1.

## Definition v1

Верхний объект принимает только `title`, optional `heading`, `description`,
`notice`, `sections`, `form`. Все обычные строки экранируются; raw HTML,
CSS, JavaScript, callbacks и resource URL для изображения не принимаются.
Неверная definition даёт закрытый `LOCAL_FORM_INVALID` без исходного input.

- `sections`: до 24 секций. Секция: optional `heading`, `paragraphs`, `items`,
  `rows`, `code`, `fields`, `links`, `qr`, `notice`. Коллекция – до 64 элементов.
  `rows` содержит `{label,value,code?}`; `code` – plain text, не исполняемый код.
  Ссылка `{label,url}` допускает HTTPS без credentials и открывается только
  явным действием пользователя с `noopener noreferrer`.
- `fields`: `name`, `label`, `type` (`text|password|email|tel|url|number|textarea|select|checkbox|file`),
  optional `help`, `error`, `required`, `minLength`, `maxLength`, `autocomplete`,
  `autofocus`, `disabled`. Select задаёт 1–128 `{label,value}` options; checkbox
  остаётся native, file допускает optional `accept` и требует explicit multipart
  у формы (проверка файла по-прежнему у владельца transport). Имя уникально; `nonce` зарезервировано. Нет `value`
  и автоматического сохранения draft. Видимая label связана с control; help и
  error – с `aria-describedby`, ошибка – с `aria-invalid` и `role=alert`.
- `notice`: `{tone,text}`, tone `info|pending|success|warning|error`.
  Ошибка имеет `role=alert`, остальные состояния – `role=status`; pending –
  `aria-busy=true`. Текст должен называть проверенное состояние, а не выдавать
  показ страницы за подтверждение сохранения или входа.
- `form`: только same-origin path `action`, `nonce`, 1–8 `actions`, optional
  `encoding` (`urlencoded|multipart`). Метод всегда
  POST. Action: `label`, optional `name`, `value`, `variant` (`primary|secondary`),
  `formNoValidate`, `disabled`. Имена actions не пересекаются с полями/nonce.
  Native submit сохраняет exact button value и browser validation; Cancel
  может явно обходить field validation, но не transport/nonce guards.
- `qr`: `{matrix,label,help?}`. Одна квадратная boolean-матрица QR version 1–40
  (21–177 модулей) на странице. Кодирование auth URI/QR выполняет provider
  приватно. Fixed SVG renderer добавляет quiet zone четыре модуля, белый фон,
  чёрные модули и доступное имя. Он не получает SVG/HTML/remote image URL.
  Матрица и страница не передаются агенту; synthetic checkerboard fixture
  проверяет presentation, не совместимость конкретной авторизации.

`renderLocalFormMessage(title,text,tone)` создаёт страницу состояния через тот
же renderer. `LOCAL_FORM_CSP` запрещает scripts, network resources, embedding
и стороннюю отправку формы, разрешая только встроенные стили и native same-origin
POST. Caller выставляет также `no-store`, `no-referrer`, `nosniff` и frame deny.

## Владение и дизайн

Host владеет единственными markup и стилями. Композиция согласована с Trelio:
Arial до 700, левый заголовок и колонка до 920px, Surface/Section, Field с help
и feedback, primary/secondary Button, semantic feedback, native focus. Controls
не меньше 44px; на narrow экранe действия складываются в колонку. QR сохраняет
quiet zone, не растягивает страницу и не зависит от theme. Нет remote шрифтов,
изображений, scripts, web app session или frontend bootstrap.

Одноразовый credential handoff не является редактором рабочего документа:
значения живут только в native форме и её POST, не в presentation API или
draft persistence. Renderer не читает inputs и не включает app dirty-state,
autosave, repeat submit или browser credential storage. Новый presentation
callback не создаёт ещё одну точку сохранения.

Provider сохраняет прежние loopback Host/port/socket/Origin/Fetch Metadata,
nonce, limits, one-use confirmation, private storage, lease, cancellation и
completion/status/wait. Ни QR, ни success page не подтверждают mutation или
provider readiness. Native OS dialogs, страницы самого provider и Trelio
proposal Apps остаются их собственными surfaces. Этот API не перекрашивает
чужую страницу и не разрешает обойти существующее согласование.

## Ввод значения нового Agent Secret ассистента

Внутренний `collectAgentSecretThroughProtectedForm` в существующем Secret
module использует этот renderer и общий `collectCredentialThroughLoopback`.
Native adapter сначала проверяет exact sealed owner intent, текущие
task/device/pass/own Run и фиксирует одноразовую попытку в обычном operation
ledger. Только затем человек вводит значения. Личный и company holder
используют одну форму; scope, ACL, metadata, AAD и writer выбирает native adapter.
Форма не извлекает credentials из аккаунта, браузера, файла или model input.

До отправки локально проверяются exact поля, required state, дубли и общий
размер JSON до 8 КиБ. Прежний общий loopback limit 32 КиБ не увеличивается.
Поле не получает prefill; password whitespace сохраняется. Значения живут
только в браузерном POST и protected host invocation. E2EE записывается
обычными `agent_secret.metadata`/`agent_secret.value` codecs; assistant-content
markers для value и metadata не подходят. Plain fingerprint использует
существующий защищённый OS device key, не opaque token handle.

Открытие формы, отмена и timeout не подтверждают сохранение. После начала
persist callback ошибка терминальна: one-flight latch остаётся установленным,
HTML не содержит exception и формы для повторной записи. Продолжение читает
только exact native structural receipt. Pending/unknown состояние не
разрешает writer replay или новую форму под прежним intent. Страница успеха
допустима лишь после положительной квитанции общего atomic writer.

## Проверки

`tests/trelio-local-form.test.mjs` проверяет единый style всех встроенных форм,
экранирование, отказ raw HTML/CSS/secret prefill/remote QR/unsafe POST,
same-host env binding и настоящий process-only adapter. Native browser fixture
на macOS/Linux/Windows/ARM64 проверяет 1440/390/320px, keyboard/focus, отсутствие
network assets, реальные save/error/reopen/cancel и exact submitted decision.
Скриншоты допускаются только для synthetic UI, без живого auth QR/credentials.

Существующие transport, consent, OAuth и credential tests остаются обязательны.
Наличие renderer не означает, что все исторические provider packages уже
переведены на него: их migration сохраняет собственный owner/release workflow.
