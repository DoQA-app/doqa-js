# DoQA Jest Adapter - `@doqa-tms/jest`

Адаптер отправляет результаты ваших Jest-тестов в DoQA: автотесты создаются/обновляются сами,
результаты приходят с шагами, фикстурами, параметрами, вложениями и ссылками. Работает в двух
режимах - **напрямую в API** DoQA или **файлами** (Allure-совместимые артефакты, без сети и без
токена в тестовом процессе). Ничего не ломает: если DoQA недоступен или не настроен, ваши тесты
проходят как обычно.

---

## Быстрый старт (2 минуты)

**Шаг 1.** Установите пакет и подключите его в конфиге Jest:

```sh
npm install --save-dev @doqa-tms/jest
```

```js
// jest.config.cjs
const { withDoqa } = require('@doqa-tms/jest');
module.exports = withDoqa({ testEnvironment: 'node' });   // второй аргумент - настройки адаптера, необязателен
```

Для ESM-конфига - `import { withDoqa } from '@doqa-tms/jest'`. `withDoqa` подменяет встроенные среды
`node`/`jsdom` на обёрнутые и добавляет reporter; существующие настройки трансформации TypeScript,
свои reporters и хуки сохраняются. Собственную среду оборачивайте `wrapEnvironment(YourEnvironment)`
(экспортируется из `@doqa-tms/jest`) - тогда docblock `@jest-environment` должен указывать на
`@doqa-tms/jest/environment-node` или `@doqa-tms/jest/environment-jsdom`. Существующие `test`/`it` менять не
нужно - они отчитываются и без разметки.

**Шаг 2.** Запустите тесты: `npx jest`.

Без какой-либо конфигурации адаптер уже пишет результаты в `./results/` - файлы Allure-совместимого
формата, который принимает конвейер загрузки DoQA (заодно они открываются обычным Allure Report).
Загрузить их в DoQA можно командой `doqactl upload` или CI-джобой. Разметка не обязательна: каждый
тест получает стабильный идентификатор автоматически.

**Шаг 3 (опционально).** Чтобы слать результаты сразу в DoQA - создайте `doqa.properties` в рабочей
директории запуска Jest (путь можно переопределить настройкой `config` или переменной
`DOQA_CONFIG`) или задайте те же ключи через переменные окружения:

```properties
url=https://demo.doqa.app
token=<project token из настроек пространства>
spaceId=42
```

С этими тремя ключами адаптер переключается в API-режим: сам создаёт прогон и наполняет его одним
батчем в конце прогона (или в реальном времени - `importRealtime: true`).

> **Внимание:** токен в конфиге = каждый запуск тестов пишет в DoQA, включая локальные. Обычная
> схема: локально конфига нет (файлы никуда не отправляются), в CI ключи приходят из переменных
> окружения `DOQA_URL` / `DOQA_TOKEN` / `DOQA_SPACE_ID`.

---

## Как адаптер решает, куда слать (`reporting`)

| `reporting=` | Что происходит |
|---|---|
| `auto` *(по умолчанию)* | заданы `url`+`token`+`spaceId` → `api`; иначе `files` **и предупреждение** «DoQA: no reporting configuration found (missing …)» |
| `api` | только API; не хватает настроек → «DoQA: reporting=api, but the configuration is incomplete (missing …) - reporting is disabled», отчётность выключается |
| `files` | только файлы Allure-совместимого формата в `resultsDir` (по умолчанию `results/`), без предупреждений |
| `off` | ничего не пишется и не отправляется |

Файловый режим - это «путь CI-артефактов»: тестовому процессу не нужны ни сеть до DoQA, ни токен.
Файлы забирает следующий шаг пайплайна:

```yaml
# .gitlab-ci.yml
test:
  script: npx jest          # адаптер пишет results/
  artifacts:
    paths: [results/]

upload-to-doqa:
  needs: [test]
  script: doqactl upload --token "$DOQA_TOKEN" --space "$DOQA_SPACE_ID" results/
```

### Деградация при отказе DoQA

Если не удалось установить прогон (401/403/422/5xx/сеть; режим 0/1 без `testRunId`; план не
получен) - вся сессия становится файловой: в `resultsDir` пишутся результаты, а в stderr - предупреждение
с причиной и подсказкой:

«DoQA: could not establish the test run (`<METHOD url -> статус: тело ответа>`) - results are
written as Allure files to '`<dir>`' instead and are NOT sent to DoQA directly. Upload them in a
later CI step (doqactl upload / POST /api/autotests/report).»

К нему добавляется подсказка по коду ответа:

- нет ответа → «DoQA did not answer at `<url>`.»;
- 401 → «DoQA rejected the token (401): check the token / DOQA_TOKEN.»;
- 403 → «The token is not allowed for this space or CI binding (403): re-issue the CI variables
  from the DoQA CI/CD settings.»;
- 5xx → «DoQA answered `<status>` - the server is unhealthy.».

В режиме 0 добавляется ещё «The run's selection could not be fetched, so every discovered test
runs.» - в этом случае исполняется всё, но в прогон DoQA ничего не уезжает.

Если пакет результатов отвергнут **посреди прогона**, в файлы уходит только он - «DoQA: results
chunk failed (…) - N results are written as Allure files to '`<dir>`' instead. Upload them in a
later CI step (doqactl upload / POST /api/autotests/report).» - следующие пакеты продолжают идти
по API. Повторной отправки отвергнутого пакета нет намеренно - чтобы не задублировать результаты.

Сбой загрузки вложения не стоит результата: «DoQA: attachment upload failed (…) - the result is
sent without it». Сбой upsert определений не стоит результатов: «DoQA: autotest definitions were
not updated (…) - the results are still sent». Если процесс завершился раньше конца прогона
(`process.exit`, SIGINT/SIGTERM) - накопленные к этому моменту результаты синхронно дописываются
файлами. Токен и тело ответа с токеном в сообщениях маскируются (`***`), URL печатается без query.

### Маркер `doqa-reporting.properties`

В `resultsDir` всегда лежит `doqa-reporting.properties`:

- при доставке по API: `sink=api`, `runId`, `adapterMode`, `delivered`, `fallbackResults`;
- в файловом режиме: `sink=files`; при деградации ещё `degradedFrom=api`, `reason=<текст ошибки>`.

Маркер позволяет CI-шагу загрузки отличить «всё уже в DoQA» от «адаптер не отработал».

---

## Полная конфигурация

Источники по убыванию приоритета: второй аргумент `withDoqa` (настройки адаптера) → переменные
окружения `DOQA_*` (плюс алиасы `DOQA_PRIVATE_TOKEN`, `DOQA_PROJECT_ID`, а также CI-переменные
`CI_PIPELINE_ID`/`GITHUB_RUN_ID` и `CI_COMMIT_REF_NAME`/`GITHUB_REF_NAME`) → файл `doqa.properties`
→ дефолты. `undefined` в настройках ничего не затирает. Значения тримятся, пустые считаются
незаданными. Значение вида `$DOQA_TOKEN` / `${DOQA_TOKEN}` считается незаданным - так выглядит
несуществующая CI-переменная, дотёкшая до процесса литералом - с предупреждением «DoQA: `<ключ>`
is set to the unexpanded variable reference "…" (…) - treating it as unset. Check that the CI
variable exists and is exported to this job.». Невалидное значение (число, режим, `reporting`) -
предупреждение и дефолт. `spaceId`, `configurationId`, `testRunId` и `ciRunId` - числа: иное значение
считается незаданным, тоже с предупреждением.

`doqa.properties`: UTF-8, строки `ключ=значение` или `ключ: значение`, комментарии `#`/`!`; ключи
пишутся без префикса, регистр и `-`/`_` не важны (`testRunId` = `test_run_id` = `TEST-RUN-ID`),
есть алиасы `privateToken`, `projectId`. Путь к файлу задаёт настройка `config` или переменная
`DOQA_CONFIG` (явно заданный, но нечитаемый файл - предупреждение). Формат общий с doqa-java и
doqa-python. Токен из настроек `withDoqa` не попадает в конфигурацию Jest (`--showConfig`,
`--debug`, воркеры) - он остаётся в главном процессе. Булевы значения: `1|true|yes|on|y` - истина,
`0|false|no|off|n` - ложь.

| Ключ | Переменная окружения | Дефолт | Назначение |
|---|---|---|---|
| `url` | `DOQA_URL` | - | адрес DoQA (хвост `/api` и завершающие `/` срезаются) |
| `token` | `DOQA_TOKEN` (`DOQA_PRIVATE_TOKEN`) | - | токен проекта |
| `spaceId` | `DOQA_SPACE_ID` (`DOQA_PROJECT_ID`) | - | пространство |
| `reporting` | `DOQA_REPORTING` | `auto` | `api` / `files` / `auto` / `off` - см. выше |
| `adapterMode` | `DOQA_ADAPTER_MODE` | `2` (`1`, если задан `testRunId`) | `0`/`selective`, `1`/`existing`, `2`/`new` - см. ниже |
| `testRunId` | `DOQA_TEST_RUN_ID` | - | прогон для режимов 0/1 |
| `testRunName` | `DOQA_TEST_RUN_NAME` | `Jest` | имя нового прогона (режим 2) |
| `configurationId` | `DOQA_CONFIGURATION_ID` | - | конфигурация прогона |
| `environment` | `DOQA_ENVIRONMENT` | - | метка окружения прогона (в файловом режиме - `environment.properties`) |
| `ciRunId` | `DOQA_CI_RUN_ID` | - | запуск CI, инициированный DoQA |
| `pipelineId` | `DOQA_PIPELINE_ID` | `CI_PIPELINE_ID` / `GITHUB_RUN_ID` | привязка прогона к CI-пайплайну |
| `branch` | `DOQA_BRANCH` | `CI_COMMIT_REF_NAME` / `GITHUB_REF_NAME` | ветка прогона |
| `resultsDir` | `DOQA_RESULTS_DIR` | `results` | каталог файлового режима |
| `importRealtime` | `DOQA_IMPORT_REALTIME` | `false` | отправлять по мере завершения файлов тестов |
| `executionOrder` | `DOQA_EXECUTION_ORDER` | `jest` | `plan` - порядок плана DoQA |
| `projectName` | `DOQA_PROJECT_NAME` | `displayName` проекта Jest | различает одинаковые пути в разных projects (входит в фолбэк-id) |
| `batchSize` | `DOQA_BATCH_SIZE` | `100` | максимум результатов в одном батч-запросе |
| `requestTimeoutMs` | `DOQA_REQUEST_TIMEOUT_MS` | `30000` | таймаут HTTP-запроса |
| `retries` | `DOQA_RETRIES` | `3` | попыток на запрос (всего) |
| `retryBackoffMs` | `DOQA_RETRY_BACKOFF_MS` | `500` | базовая пауза между попытками |
| `maxTraceLength` | `DOQA_MAX_TRACE_LENGTH` | `100000` | лимит длины stack trace (символов) |
| `maxMessageLength` | `DOQA_MAX_MESSAGE_LENGTH` | `10000` | лимит длины сообщений |
| `maxParameterLength` | `DOQA_MAX_PARAMETER_LENGTH` | `2000` | лимит длины значений параметров |
| `proxy` | `DOQA_PROXY` | - | HTTP-прокси `host:port` (или полный URL), только для адаптера |
| `certValidation` | `DOQA_CERT_VALIDATION` | `true` | `false` = доверять самоподписанным TLS (отключает и проверку hostname), только для адаптера |
| `config` | `DOQA_CONFIG` | `doqa.properties` | путь к файлу настроек |

Строковые поля, превышающие лимиты, обрезаются с маркером `… truncated (N chars)`.

---

## Режимы запуска (API)

- **mode 2 / `new`** *(дефолт)* - адаптер сам создаёт один прогон на весь запуск Jest (все воркеры
  и все projects). Явный `2` при уже заданном `testRunId` создаёт **новый** прогон - предупреждение
  «DoQA: adapterMode=2 creates a NEW run - the configured testRunId … is ignored (use adapterMode=1
  to report into it)».
- **mode 1 / `existing`** - результаты уходят в существующий `testRunId`. Если `testRunId` задан, а
  `adapterMode` не задан явно - адаптер сам работает в этом режиме (указанный прогон никогда не
  игнорируется молча).
- **mode 0 / `selective`** - **селективный прогон**: адаптер получает состав прогона `testRunId` и
  физически исполняет только его. Невыбранные тесты в Jest видны как `skipped`, их тела, а также
  `beforeEach` и `beforeAll`/`afterAll` полностью отсечённых `describe`-блоков не исполняются; в
  DoQA они не отправляются. Модули тестов при этом всё равно загружаются - discovery происходит до
  отбора. Пустой состав - не исполняется ничего. Если ни один тест не совпал - предупреждение
  «DoQA: the run selects N autotests, but none of them matched the discovered tests - nothing was
  executed. Check that the tests' ids match the autotests of the run.». Отбор идёт по id из состава
  прогона; для тестов без явного id - ещё и по совпадению места (namespace + цепочка `describe` +
  название), чтобы тест мог предъявить id уже во время выполнения (`doqa.metadata({ id })`). Если
  итоговый id не входит в прогон, результат такого теста не отправляется, а в конце печатается
  сводное предупреждение «DoQA: N tests ran because their location matched the run, but their id is
  not part of it - their results are not reported: …».

`--shard`: каждый шард - отдельный процесс Jest; в режиме 2 получится прогон на шард, поэтому для
шардов используйте режим 1. Watch-режим не отчитывается - «DoQA: watch mode is not reported - every
DoQA run needs its own Jest process» - тесты при этом идут как обычно.

---

## Запуск из DoQA: нативный фильтр

DoQA для Jest выдаёт переменную `DOQA_NATIVE_FILTER` вида `(название|название)$` для запуска
`npx jest -t "$DOQA_NATIVE_FILTER"`. Тесты, отсечённые `-t`/`--testNamePattern` или `test.only`, в
DoQA не отправляются - включая явные `test.skip` вне фильтра. Без фильтра `test.skip` и
`test.todo` по-прежнему уходят как `skipped`.

Ограничение: строки `doqa.test.each` фильтр по названию выбирает по одной; чтобы выбрать шаблон
целиком, используйте режим 0.

---

## Порядок прохождения по плану DoQA

`executionOrder: 'plan'` вместе с режимом 0: файлы идут последовательно в порядке плана
(`maxWorkers: 1` адаптер выставляет сам), а внутри файла тесты сортируются по плану. Если план
нельзя соблюсти - нет места в плане у части автотестов, план перемежает файлы или describe-блоки,
есть `test.concurrent` или подключён свой `testSequencer` - выводится предупреждение и применяется
обычный порядок Jest; прогон не падает.

---

## Разметка тестов (всё опционально)

```js
const { doqa } = require('@doqa-tms/jest');

doqa.test('создание заявки', {
  id: 'REQUEST-CREATE',                         // стабильный ключ автотеста (рекомендуем)
  title: 'Пользователь создаёт заявку',
  description: 'Заявка сохраняется и получает номер',
  caseIds: [123],                                // привязка к ручным кейсам DoQA
  labels: { owner: 'requests' },                 // или ['owner:requests', 'smoke']
  tags: ['smoke'],
  links: [{ url: 'https://example.org/REQ-1', title: 'Требование', type: 'requirement' }],
  createManualCase: true,                        // завести связанный ручной кейс
}, async () => {
  await doqa.step('заполнить форму', async () => {
    doqa.parameter('role', 'user');
    doqa.attach('request.txt', 'демонстрационное вложение', 'text/plain');
  });
});

doqa.test('без разметки', () => { /* метаданные необязательны */ });

doqa.test.each([['admin'], ['user']])('роль %s', { id: 'REQUEST-ROLE' }, (role) => {
  doqa.parameter('role', role);
});
```

Доступны `doqa.test.only`, `.skip`, `.concurrent`, `.each` (комбинируются: `doqa.test.only.each`).
Требуются глобалы Jest (`injectGlobals: true`): без них `doqa.test` недоступен, а обычные тесты
отчитываются как прежде. Callback с `done` регистрируйте обычным `test`, не `doqa.test`.

Тип ссылки в `links` - `related` | `defect` | `requirement` | `blocked_by` | `repository`.
Неизвестный тип - предупреждение «DoQA: unknown link type "…" - the link is sent without a type»,
сама ссылка при этом уходит без типа. `createManualCase: true` запрашивает создание ручного кейса
для автотеста независимо от настроек пространства; точечно выключить его нельзя - источники этого
флага объединяются.

### Идентичность

Каскад id: `metadata.id` → `[DOQA-123]` / `@DOQA:123` в названии теста (→ `DOQA-123`) → `jest:` +
SHA-1 (UTF-8) от строк `projectName`, относительного пути файла (разделитель `/`), названий
`describe` по цепочке и названия теста - соединённых `\n`. Для `doqa.test.each` в хэш входит шаблон
названия: строки данных делят один автотест между собой, различаются параметрами (`arg0`, `arg1`, …)
и историей. Обычный `test.each` даёт отдельный автотест на каждую строку.

Формула хэша - публичный контракт, запинена тестом: переименование или перенос теста без явного id
создаёт новый автотест. Несколько тестов с одним id - предупреждение «DoQA: several tests share one
id and collapse into a single autotest: …».

`namespace` - точечный путь файла без расширения и без `.test`/`.spec` (`tests/checkout.test.ts` →
`tests.checkout`), `classname` - цепочка `describe` через пробел, `runner_method` - название теста
(шаблон - для `each`), `runner_name` - полное название теста в Jest (classname + название).

### Параметризованные тесты

`doqa.test.each` делит один автотест между строками данных: аргументы каждой инвокации уезжают как
именованные параметры результата (`arg0`, `arg1`, …), а строки различаются также историей
выполнения. Обычный `test.each` регистрирует в Jest уже раскрытые названия - адаптер видит их как
разные тесты, общей идентичности исходного шаблона он не обещает.

---

## Runtime-API

Вызывается внутри теста или хука; вне активного теста - тихий no-op:

```js
doqa.metadata({ caseIds: [42], labels: { severity: 'critical' } });   // ДОБАВЛЯЕТ, а не заменяет
doqa.parameter('env', 'staging');
doqa.step('открыть страницу логина', () => { /* sync -> возвращаемое значение */ });
await doqa.step('дождаться ответа', async () => { /* async -> Promise */ });
doqa.attach('response.json', JSON.stringify(body), 'application/json');   // вложение из памяти
doqa.attachFile('artifacts/screenshot.png');                              // тип из расширения
```

`doqa.metadata({...})` добавляет: `caseIds`/`labels`/`tags`/`links`/`parameters` накапливаются без
дублей, скалярные поля (`title`, `description`, `id`, …) заменяются, а `createManualCase: true`
снять нельзя. `doqa.step(title, fn)` поддерживает вложенность без ограничений; ошибка внутри шага
пробрасывается дальше как обычно, а сам шаг закрывается с исходом ошибки. `doqa.attach(name,
textOrBytes, mime?)` и `doqa.attachFile(path, name?, mime?)` сохраняют вложение к текущему тесту
или открытому шагу; тип вложения при отсутствии `mime` выводится из расширения имени.

---

## Фикстуры

Никаких дополнительных флагов - фикстуры попадают в отчёт сами: `beforeEach`/`afterEach` становятся
setup/teardown-блоками самого теста; `beforeAll`/`afterAll` - setup/teardown-блоками каждого теста
своего `describe`-блока. Служебный хук jest-circus (сброс моков перед каждым тестом) в отчёт не попадает.
Контексты `test.concurrent` изолированы друг от друга.

---

## Маппинг исходов

| Что случилось | Исход |
|---|---|
| тест прошёл | `passed` |
| упал `expect(...)`, `node:assert`, chai (`AssertionError`) | `failed` |
| любое другое исключение, таймаут, брошенная строка | `broken` |
| упал хук (`beforeAll`/`beforeEach`, `afterAll`/`afterEach`) | `broken` (и шаг хука - `broken`) |
| `test.skip`, `describe.skip`, `test.todo` | `skipped` |
| тест отсечён `-t`/`test.only`/режимом 0 | результат не отправляется |
| файл не загрузился (синтаксис, import) | режим 2 - создаётся результат `broken` с названием «`<файл>` could not be loaded»; режимы 0/1 - только предупреждение «DoQA: `<файл>` could not be loaded - its tests are not reported» |
| повтор `jest.retryTimes` | каждая попытка - отдельный результат с общей историей |

`failed` vs `broken` - важное различие: кластеризация ошибок и flaky-аналитика DoQA обрабатывают их
по-разному. Внутри шага: падение assertion - `failed`, всё остальное - `broken`. ANSI-коды из
сообщений вырезаются.

---

## Доставка результатов

Reporter в главном процессе владеет прогоном; воркеры пишут записи (`*.record.json`) в
`.doqa/<сессия>/` через атомарную запись и в сеть не ходят. Пакеты идут по `batchSize`: сначала
upsert определений (по одному на автотест - с шагами before/step/after, метками, тегами, ссылками,
`case_ids`, `runner_name`, `runner_method`), затем результаты с `report_id`/`chunk_index`/
`is_final_chunk`. Вложения загружаются заранее. `importRealtime` включает отправку по мере
завершения файлов тестов. Номера пакетов идут без пропусков: неудачный запрос свой номер не
расходует, а если DoQA сообщает, что пакет с таким номером уже записан (ответ на прошлый запрос
потерялся), пакет уходит в файлы и нумерация продолжается. Если закрыть доставку не удалось -
предупреждение «DoQA: the delivery could not be closed (…) - DoQA may keep waiting for the run to
finish». Строковые поля обрезаются под лимиты DoQA (255 символов; название шага -
500; имя прогона - 100).

Повторы: GET-запросы и создание прогона (идемпотентно, по `external_key`) повторяются при
сети/5xx/429; остальные POST повторяются только при 429 и когда соединение вообще не установилось.
`retries` - общее число попыток на запрос. После 5 неудач подряд - пауза 30 секунд, затем одна
пробная попытка.

### Каталог восстановления

Успешная сессия удаляет каталог `.doqa/<сессия>/`. При проблемах он остаётся - предупреждение
«DoQA: recovery files are kept in '`<каталог>`'»: в нём лежат исходные записи, вложения,
подготовленные пакеты `chunk-N.json` и ответы сервера `chunk-N.receipt.json`. Не удаляйте каталог
до разбора. Частичный приём пакета сервером даёт отдельное предупреждение «DoQA: chunk N: DoQA
accepted X of Y results (skipped: `<причины>`); see the receipt in '`<каталог>`'».

---

## Файловый режим

`<uuid>-result.json` (Allure 2): метки `doqa_id`, `doqa_title`, `doqa_cases` + `doqa_work_items`,
`doqa_create_manual_case`, `doqa_runner_name`, `doqa_runner_method`, `framework=jest`,
`language=javascript`, `package`, `testClass`, `suite`; теги и метки уходят как `tag`. `historyId`
учитывает параметры. `<uuid>-container.json` пишется только при наличии фикстур. Вложения -
`<uuid>-attachment.<ext>`. `environment.properties` пишется при заданном ключе `environment`.
Загрузка - `doqactl upload` или шаг CI. Метка `AS_ID` не пишется: моста с Allure ID в Jest нет (см.
«Ограничения» ниже).

---

## Ограничения (честно)

Нет: плейсхолдеров `{param}` в id/названиях, разметки уровня `describe`, переопределения
`namespace`/`classname`, отдельного сообщения к результату, описания шага, моста Allure
(`allure-js-commons` не перехватывается), генераторных callbacks, раннера `jest-jasmine2`, строковых
записей `projects` (не отчитываются - предупреждение «DoQA: string entries of `projects` are not
reported - describe them as objects to report them»). Переход с отчётов-файлов (jest-junit, Allure)
на адаптер создаёт новые автотесты с id адаптера, без связи с прежней историей.

---

## Траблшутинг

| Симптом | Причина и лечение |
|---|---|
| Результатов нигде нет | `reporting=api` без `url`/`token`/`spaceId` - смотрите предупреждение «DoQA: reporting=api, but the configuration is incomplete…» в stderr; либо `reporting=off` |
| Результаты в `results/`, а ждали в DoQA | это `auto` без API-настроек - в stderr «DoQA: no reporting configuration found (missing …)»; задайте `url`/`token`/`spaceId`. Если файловый режим выбран сознательно, поставьте `reporting=files` - предупреждение исчезнет |
| DoQA недоступна или отвергла токен, а в `results/` появились файлы | так и задумано: адаптер деградировал в файловый режим («DoQA: could not establish the test run…» либо «DoQA: results chunk failed…» в stderr); догрузите `results/`, как в файловом режиме |
| В stderr «is set to the unexpanded variable reference» | до процесса дотёк литерал `$DOQA_TOKEN` - CI-переменная не существует или не экспортирована в джобу |
| Селективный прогон ничего не запустил | «DoQA: the run selects N autotests, but none of them matched…» - каталог автотестов в DoQA отстал от кода, перезалейте полный прогон |
| Тесты выполнились, но часть результатов не отправилась | «DoQA: N tests ran because their location matched the run, but their id is not part of it…» - тест без явного id совпал по месту, но итоговый id (например, из `doqa.metadata({ id })`) не входит в состав прогона |
| Порядок плана не применяется | предупреждение «DoQA: the plan order is not applied (…) - test files run in the Jest order» - `test.concurrent`, свой `testSequencer` или перемежение файлов/describe-блоков |
| Самоподписанный сертификат | `certValidation=false` (только для тестовых стендов!) |
| DoQA за прокси | `proxy=host:port` |
| Параметры/сообщения обрезаны `… truncated` | поднимите `maxParameterLength` / `maxMessageLength` / `maxTraceLength` |
| Локальные прогоны спамят прогоны в DoQA | уберите токен из локального конфига или поставьте локально `reporting=files` |
| Watch-режим ничего не отправляет | так и задумано - «DoQA: watch mode is not reported…»; в CI запускайте `npx jest` без `--watch` |

Ошибка доставки **никогда не роняет прогон** - адаптер пишет предупреждение и продолжает.

---

## Переход с отчётов-файлов (jest-junit, Allure)

Готового моста нет: `allure-js-commons` не перехватывается (см. «Ограничения»), а разметка
jest-junit ни во что не транслируется. При переходе на адаптер автотесты заводятся заново - с id
адаптера (каскад «Идентичность» выше) и без связи с историей, накопленной в прежнем отчёте. Если
нужна стабильная история сразу с первого прогона под DoQA - расставьте `id` в `doqa.test(...)` до
него. Файловый режим по-прежнему пишет Allure-совместимые результаты, так что существующий шаг CI,
который загружает Allure-артефакты (`doqactl upload` / `POST /api/autotests/report`), продолжит
работать без изменений.

---

## Сборка адаптера из исходников

Адаптер живёт в монорепозитории `doqa-js` вместе со своим ядром `doqa-js-commons` и клиентом
`doqa-client`; все три модуля публикуются одним пакетом из корня репозитория:

```sh
npm ci
npm run lint
npm test
```

`npm test` собирает пакет и запускает `node --test` по тестам `doqa-client`, `doqa-js-commons` и
`doqa-jest` - в том числе настоящие дочерние процессы Jest (CJS/ESM, jsdom, TypeScript, параметры,
retries, воркеры, отбор и порядок по плану, ошибки загрузки).

## Лицензия

[Apache License 2.0](../LICENSE)
