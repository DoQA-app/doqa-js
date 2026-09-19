# Адаптер Jest: `@doqa-tms/jest`

Адаптер передаёт результаты тестов Jest в DoQA: через API DoQA или через файлы Allure-совместимого
формата, которые загружаются в DoQA отдельным шагом. Для каждого теста DoQA получает исход, шаги,
фикстуры, параметры, вложения и ссылки. По этим данным DoQA создаёт и обновляет автотесты.

Адаптер работает с Jest 29.7 и 30 и раннером jest-circus, который Jest использует по умолчанию.
Раннер `jest-jasmine2` не поддерживается. Требования к версиям Node.js и Jest приведены в
[корневом README](../README.md#требования).

Ошибки отправки не меняют результат прогона Jest: адаптер выводит предупреждение `DoQA: …` в stderr
и продолжает работу.

---

## Подключение

Установите пакет и подключите его в конфигурации Jest:

```sh
npm install --save-dev @doqa-tms/jest
```

```js
// jest.config.cjs
const { withDoqa } = require('@doqa-tms/jest');
module.exports = withDoqa({ testEnvironment: 'node' });   // второй аргумент - настройки адаптера, необязателен
```

Для ESM-конфигурации используйте `import { withDoqa } from '@doqa-tms/jest'`. `withDoqa` заменяет
встроенные среды `node` и `jsdom` на обёрнутые адаптером и добавляет reporter адаптера. Остальные
настройки конфигурации, в том числе трансформация TypeScript, собственные reporters и хуки,
сохраняются.

Если проект использует собственную тестовую среду, оберните её функцией
`wrapEnvironment(YourEnvironment)` из `@doqa-tms/jest`. Если тестовый файл задаёт среду
docblock-комментарием `@jest-environment`, укажите в нём `@doqa-tms/jest/environment-node` или
`@doqa-tms/jest/environment-jsdom`: `withDoqa` заменяет среду только в конфигурации Jest.

Если в `projects` указаны строки (пути к конфигурациям), тесты этих проектов не отчитываются, и
адаптер выводит предупреждение. Чтобы адаптер их учитывал, опишите проекты объектами.

Существующие тесты `test` и `it` менять не нужно: адаптер отчитывается по ним без дополнительной
разметки.

---

## Быстрый старт

Запустите тесты командой `npx jest`. Если подключение к DoQA не настроено, адаптер записывает
результаты в `./results/` в Allure-совместимом формате. Эти файлы принимает конвейер загрузки
DoQA, их также можно открыть в Allure Report. Загрузить файлы в DoQA можно командой
`doqactl upload` или отдельной джобой CI. Каждый тест получает идентификатор автотеста без
дополнительной разметки.

Чтобы отправлять результаты в DoQA через API, создайте `doqa.properties` в рабочей директории
запуска Jest или задайте те же настройки через переменные окружения. Путь к файлу можно изменить
настройкой `config` или переменной `DOQA_CONFIG`.

```properties
url=https://demo.doqa.app
token=<project token из настроек пространства>
spaceId=42
```

Когда заданы `url`, `token` и `spaceId`, адаптер создаёт прогон в DoQA при старте Jest и после
завершения всех тестов отправляет в него результаты. С `importRealtime: true` результаты
отправляются после завершения каждого тестового файла.

> **Внимание:** если эти настройки лежат в `doqa.properties`, в DoQA отправляется каждый запуск
> тестов, включая локальные. Обычно локально файла с настройками нет и результаты записываются в
> файлы, а в CI настройки передаются через переменные окружения `DOQA_URL` / `DOQA_TOKEN` /
> `DOQA_SPACE_ID`.

---

## Выбор способа отправки (`reporting`)

| `reporting=` | Поведение |
|---|---|
| `auto` *(по умолчанию)* | если заданы `url`, `token` и `spaceId`, результаты отправляются через API; иначе записываются в файлы, и адаптер выводит предупреждение «DoQA: no reporting configuration found (missing …)» |
| `api` | результаты отправляются только через API; если настроек не хватает, адаптер выводит «DoQA: reporting=api, but the configuration is incomplete (missing …) - reporting is disabled» и ничего не отправляет и не записывает |
| `files` | результаты записываются в `resultsDir` (по умолчанию `results/`) без предупреждений |
| `off` | адаптер ничего не записывает и не отправляет |

В файловом режиме тестовому процессу не нужны ни доступ к DoQA, ни токен. Файлы загружает
следующий шаг пайплайна, например:

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

### Ошибки при установке прогона

При старте адаптер создаёт прогон (режим 2) или получает состав прогона (режим 0). Если это не
удалось, адаптер переводит весь запуск в файловый режим и записывает результаты в `resultsDir`.
Так происходит при ответе с ошибкой (например, 401, 403, 422 или 5xx), при сетевой ошибке и при
режимах 0 и 1 без `testRunId`. В stderr адаптер выводит предупреждение с причиной:

«DoQA: could not establish the test run (`<METHOD url -> статус: тело ответа>`) - results are
written as Allure files to '`<dir>`' instead and are NOT sent to DoQA directly. Upload them in a
later CI step (doqactl upload / POST /api/autotests/report).»

К предупреждению добавляется подсказка по коду ответа:

- нет ответа → «DoQA did not answer at `<url>`.»;
- 401 → «DoQA rejected the token (401): check the token / DOQA_TOKEN.»;
- 403 → «The token is not allowed for this space or CI binding (403): re-issue the CI variables
  from the DoQA CI/CD settings.»;
- 5xx → «DoQA answered `<status>` - the server is unhealthy.».

В режиме 0 добавляется «The run's selection could not be fetched, so every discovered test
runs.». Адаптер выполняет все найденные тесты и записывает их результаты в файлы.

В режиме 1 адаптер при старте к DoQA не обращается. Ошибки доступа к прогону в этом режиме
проявляются при отправке пакетов результатов.

### Ошибки во время отправки

Если DoQA отклонил пакет результатов во время прогона, адаптер записывает в файлы только этот пакет
и выводит предупреждение «DoQA: results chunk failed (…) - N results are written as Allure files to
'`<dir>`' instead. Upload them in a later CI step (doqactl upload / POST /api/autotests/report).».
Следующие пакеты адаптер продолжает отправлять через API. Отклонённый пакет повторно не
отправляется, чтобы результаты не задублировались.

Если не удалось загрузить вложение, адаптер отправляет результат без него и выводит «DoQA:
attachment upload failed (…) - the result is sent without it». Если не удалось обновить
определения автотестов, результаты всё равно отправляются: «DoQA: autotest definitions were not
updated (…) - the results are still sent».

Если процесс Jest завершился до конца прогона (`process.exit`, SIGINT, SIGTERM), адаптер синхронно
записывает в файлы результаты, которые ещё не успел обработать.

В сообщениях адаптер заменяет токен на `***`, в том числе внутри тела ответа, и выводит URL без
query-параметров.

### Файл `doqa-reporting.properties`

В режимах `api` и `files` адаптер записывает в `resultsDir` файл `doqa-reporting.properties`:

- при отправке через API: `sink=api`, `runId`, `adapterMode`, `delivered`, `fallbackResults`;
- в файловом режиме: `sink=files`; если адаптер перешёл в файловый режим из-за ошибки, ещё
  `degradedFrom=api` и `reason=<текст ошибки>`.

По этому файлу шаг загрузки в CI отличает ситуацию «результаты уже в DoQA» от ситуации «адаптер
не отработал».

---

## Настройки

Адаптер читает настройки из трёх источников. По убыванию приоритета:

1. второй аргумент `withDoqa`;
2. переменные окружения `DOQA_*`, а также `DOQA_PRIVATE_TOKEN`, `DOQA_PROJECT_ID`, `CI_PIPELINE_ID`,
   `GITHUB_RUN_ID`, `CI_COMMIT_REF_NAME` и `GITHUB_REF_NAME`;
3. файл `doqa.properties`.

Если значение не задано ни в одном источнике, действует значение по умолчанию. Значение
`undefined` во втором аргументе `withDoqa` не перекрывает другие источники. Пробелы по краям
значений отбрасываются, пустые значения считаются незаданными.

Значение вида `$DOQA_TOKEN` или `${DOQA_TOKEN}` адаптер тоже считает незаданным: так выглядит
переменная CI, которая не существует и попала в процесс без подстановки. Адаптер выводит
предупреждение «DoQA: `<ключ>` is set to the unexpanded variable reference "…" (…) - treating it as
unset. Check that the CI variable exists and is exported to this job.».

Если значение числа, режима или `reporting` некорректно, адаптер выводит предупреждение и
использует значение по умолчанию. `spaceId`, `configurationId`, `testRunId` и `ciRunId` должны быть
целыми числами; другое значение адаптер считает незаданным и тоже выводит предупреждение.

Файл `doqa.properties` читается в UTF-8. Каждая строка имеет вид `ключ=значение` или
`ключ: значение`, строки с `#` или `!` в начале считаются комментариями. Ключи пишутся без
префикса, регистр и символы `-` и `_` в них не учитываются: `testRunId`, `test_run_id` и
`TEST-RUN-ID` означают одно и то же. Ключи `privateToken` и `projectId` задают `token` и
`spaceId`. Путь к файлу задаёт настройка `config` или переменная `DOQA_CONFIG`; если явно указанный
файл не читается, адаптер выводит предупреждение.

Токен из второго аргумента `withDoqa` не попадает в конфигурацию Jest, которую видят
`--showConfig`, `--debug` и workers: он остаётся в главном процессе.

Булевы значения: `1`, `true`, `yes`, `on`, `y` означают «да», `0`, `false`, `no`, `off`, `n`
означают «нет».

| Ключ | Переменная окружения | По умолчанию | Назначение |
|---|---|---|---|
| `url` | `DOQA_URL` | — | адрес DoQA; суффикс `/api` и завершающие `/` отбрасываются |
| `token` | `DOQA_TOKEN` (`DOQA_PRIVATE_TOKEN`) | — | токен проекта |
| `spaceId` | `DOQA_SPACE_ID` (`DOQA_PROJECT_ID`) | — | id пространства |
| `reporting` | `DOQA_REPORTING` | `auto` | `api` / `files` / `auto` / `off`, см. [выше](#выбор-способа-отправки-reporting) |
| `adapterMode` | `DOQA_ADAPTER_MODE` | `2` (`1`, если задан `testRunId`) | `0`/`selective`, `1`/`existing`, `2`/`new`, см. [режимы прогона](#режимы-прогона) |
| `testRunId` | `DOQA_TEST_RUN_ID` | — | прогон для режимов 0 и 1 |
| `testRunName` | `DOQA_TEST_RUN_NAME` | `Jest` | имя нового прогона (режим 2) |
| `configurationId` | `DOQA_CONFIGURATION_ID` | — | конфигурация прогона |
| `environment` | `DOQA_ENVIRONMENT` | — | метка окружения прогона; в файловом режиме записывается в `environment.properties` |
| `ciRunId` | `DOQA_CI_RUN_ID` | — | запуск CI, который инициировал DoQA |
| `pipelineId` | `DOQA_PIPELINE_ID` | `CI_PIPELINE_ID` / `GITHUB_RUN_ID` | пайплайн CI, к которому привязывается прогон |
| `branch` | `DOQA_BRANCH` | `CI_COMMIT_REF_NAME` / `GITHUB_REF_NAME` | ветка прогона |
| `resultsDir` | `DOQA_RESULTS_DIR` | `results` | каталог для файлов результатов |
| `importRealtime` | `DOQA_IMPORT_REALTIME` | `false` | отправлять результаты после завершения каждого тестового файла |
| `executionOrder` | `DOQA_EXECUTION_ORDER` | `jest` | `plan` — выполнять тесты в порядке плана DoQA |
| `projectName` | `DOQA_PROJECT_NAME` | `displayName` проекта Jest | различает одинаковые пути в разных `projects`; входит в вычисляемый идентификатор |
| `batchSize` | `DOQA_BATCH_SIZE` | `100` | максимальное число результатов в одном запросе |
| `requestTimeoutMs` | `DOQA_REQUEST_TIMEOUT_MS` | `30000` | таймаут HTTP-запроса, мс |
| `retries` | `DOQA_RETRIES` | `3` | общее число попыток на запрос |
| `retryBackoffMs` | `DOQA_RETRY_BACKOFF_MS` | `500` | пауза перед второй попыткой, мс; перед каждой следующей удваивается |
| `maxTraceLength` | `DOQA_MAX_TRACE_LENGTH` | `100000` | максимальная длина stack trace, символов |
| `maxMessageLength` | `DOQA_MAX_MESSAGE_LENGTH` | `10000` | максимальная длина сообщения, символов |
| `maxParameterLength` | `DOQA_MAX_PARAMETER_LENGTH` | `2000` | максимальная длина значения параметра, символов |
| `proxy` | `DOQA_PROXY` | — | HTTP-прокси `host:port` или полный URL; используется только для запросов адаптера |
| `certValidation` | `DOQA_CERT_VALIDATION` | `true` | `false` отключает проверку TLS-сертификата и имени хоста; действует только на запросы адаптера |
| `config` | `DOQA_CONFIG` | `doqa.properties` | путь к файлу настроек |

Строки длиннее лимита адаптер обрезает и добавляет маркер `… truncated (N chars)`.

---

## Режимы прогона

Режим задаёт настройка `adapterMode`. Он действует, когда результаты отправляются через API.

**Режим 2 (`new`, по умолчанию).** Адаптер создаёт один прогон на весь запуск Jest, включая все
workers и все `projects`. Если при явном `adapterMode=2` задан `testRunId`, адаптер всё равно
создаёт новый прогон и выводит предупреждение «DoQA: adapterMode=2 creates a NEW run - the
configured testRunId … is ignored (use adapterMode=1 to report into it)».

**Режим 1 (`existing`).** Адаптер отправляет результаты в прогон `testRunId`. Если `testRunId`
задан, а `adapterMode` нет, адаптер работает в этом режиме, чтобы указанный прогон не был
проигнорирован.

**Режим 0 (`selective`).** Адаптер получает из DoQA список автотестов прогона `testRunId` и
выполняет только тесты из этого списка. Этот режим DoQA включает, когда запускает выбранные
автотесты в CI: он передаёт в пайплайн `DOQA_TEST_RUN_ID` и `DOQA_ADAPTER_MODE=0`.

Невыбранные тесты Jest показывает как `skipped`, для них не выполняются тело теста и хук
`beforeEach`. Хуки `beforeAll` и `afterAll` не выполняются в `describe`-блоках, где не выбран ни
один тест. В DoQA невыбранные тесты не отправляются. Тестовые модули при этом загружаются, потому что Jest находит
тесты до отбора.

Если список пуст, не выполняется ни один тест. Если ни один тест не совпал со списком, адаптер
выводит «DoQA: the run selects N autotests, but none of them matched the discovered tests - nothing
was executed. Check that the tests' ids match the autotests of the run.».

Адаптер сравнивает со списком идентификаторы тестов. Тест без явного идентификатора он дополнительно
сравнивает по месту: namespace, цепочке `describe` и названию. Так тест может задать идентификатор
уже во время выполнения через `doqa.metadata({ id })`. Если итоговый идентификатор не входит в
прогон, результат не отправляется, и в конце запуска адаптер выводит «DoQA: N tests ran because
their location matched the run, but their id is not part of it - their results are not reported:
…».

**Шардирование.** При `--shard` каждый шард запускается отдельным процессом Jest. В режиме 2 каждый
шард создаст свой прогон, поэтому для шардов используйте режим 1.

**Режим watch.** В режиме watch адаптер ничего не отправляет и выводит «DoQA: watch mode is not
reported - every DoQA run needs its own Jest process». Тесты при этом выполняются как обычно.

---

## Нативный фильтр

Для Jest DoQA передаёт в пайплайн переменную `DOQA_NATIVE_FILTER` вида `(название|название)$`.
Её используют в команде `npx jest -t "$DOQA_NATIVE_FILTER"`. Тесты, которые не выполнялись из-за
`-t`/`--testNamePattern` или `test.only`, в DoQA не отправляются, в том числе `test.skip` вне
фильтра. Без фильтра `test.skip` и `test.todo` отправляются с исходом `skipped`.

Фильтр по названию выбирает строки `doqa.test.each` по отдельности. Чтобы выбрать все строки
шаблона, используйте режим 0.

---

## Порядок выполнения по плану DoQA

С `executionOrder: 'plan'` в режиме 0 адаптер выполняет тестовые файлы по одному в порядке плана
(`maxWorkers: 1` адаптер выставляет сам) и сортирует тесты внутри файла по плану.

Порядок плана не применяется в следующих случаях:

- у части автотестов в плане нет места (namespace) или план чередует тестовые файлы: файлы
  выполняются в порядке Jest, адаптер выводит «DoQA: the plan order is not applied (…) - test files
  run in the Jest order»;
- в файле есть `test.concurrent` или план чередует `describe`-блоки: этот файл выполняется в
  порядке Jest, адаптер выводит предупреждение;
- в конфигурации задан собственный `testSequencer`: файлы выполняются в его порядке, адаптер
  выводит предупреждение.

Прогон при этом продолжается.

---

## Разметка тестов

Разметка необязательна.

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

`doqa.test` поддерживает `.only`, `.skip`, `.concurrent` и `.each`, в том числе в сочетаниях вроде
`doqa.test.only.each`. `doqa.test` использует глобальные функции Jest, поэтому требует
`injectGlobals: true`. Без них `doqa.test` недоступен, а тесты `test` и `it` отчитываются как
обычно. Тест с callback `done` объявляйте через `test`, а не через `doqa.test`.

Допустимые типы ссылок в `links`: `related`, `defect`, `requirement`, `blocked_by`, `repository`.
Для другого типа адаптер выводит предупреждение «DoQA: unknown link type "…" - the link is sent
without a type» и отправляет ссылку без типа.

`createManualCase: true` запрашивает создание ручного кейса для автотеста независимо от настроек
пространства. Если флаг задан хотя бы в одном источнике (метаданные `doqa.test` или вызов
`doqa.metadata`), выключить его нельзя.

### Идентификатор автотеста

Адаптер определяет идентификатор автотеста так:

1. `metadata.id`;
2. номер из названия теста в форме `[DOQA-123]` или `@DOQA:123` (идентификатор `DOQA-123`);
3. `jest:` и SHA-1 (UTF-8) от строк `projectName`, относительного пути файла (разделитель `/`),
   названий `describe`-блоков по цепочке и названия теста, соединённых через `\n`.

Для `doqa.test.each` в хэш входит шаблон названия, поэтому все строки данных относятся к одному
автотесту. Обычный `test.each` создаёт отдельный автотест для каждой строки.

Формула хэша закреплена тестом. У теста без явного идентификатора переименование или перенос в
другой файл или `describe`-блок меняют хэш, и DoQA создаёт новый автотест. Если у нескольких
тестов один идентификатор, адаптер выводит «DoQA: several tests share one id and collapse into a
single autotest: …».

Кроме идентификатора, адаптер передаёт место теста:

- `namespace` — путь файла через точки, без расширения и суффикса `.test`/`.spec`
  (`tests/checkout.test.ts` → `tests.checkout`);
- `classname` — цепочка `describe` через пробел;
- `runner_method` — название теста (для `each` используется шаблон);
- `runner_name` — полное название теста в Jest (classname и название).

### Параметризованные тесты

Для `doqa.test.each` адаптер передаёт аргументы каждой строки как параметры результата `arg0`,
`arg1` и т. д. Все строки записываются в один автотест.

Обычный `test.each` регистрирует в Jest уже подставленные названия, поэтому адаптер обрабатывает
строки как отдельные тесты.

---

## Runtime API

Функции вызываются внутри теста или хука. Вне теста вызов ничего не делает.

```js
doqa.metadata({ caseIds: [42], labels: { severity: 'critical' } });   // ДОБАВЛЯЕТ, а не заменяет
doqa.parameter('env', 'staging');
doqa.step('открыть страницу логина', () => { /* sync -> возвращаемое значение */ });
await doqa.step('дождаться ответа', async () => { /* async -> Promise */ });
doqa.attach('response.json', JSON.stringify(body), 'application/json');   // вложение из памяти
doqa.attachFile('artifacts/screenshot.png');                              // тип из расширения
```

`doqa.metadata({...})` дополняет метаданные теста. `caseIds`, `labels`, `tags`, `links` и
`parameters` накапливаются без дублей, скалярные поля (`title`, `description`, `id` и другие)
заменяются, `createManualCase: true` снять нельзя.

`doqa.step(title, fn)` поддерживает вложенные шаги. Если внутри шага возникла ошибка, она
пробрасывается дальше, а шаг получает исход по этой ошибке.

`doqa.attach(name, textOrBytes, mime?)` и `doqa.attachFile(path, name?, mime?)` добавляют вложение к
текущему тесту или к открытому шагу. Если `mime` не указан, тип определяется по расширению имени.

---

## Фикстуры

Хуки попадают в отчёт без дополнительной настройки. `beforeEach` и `afterEach` становятся шагами
setup и teardown самого теста. `beforeAll` и `afterAll` становятся шагами setup и teardown каждого
теста своего `describe`-блока. Служебный хук jest-circus, который сбрасывает моки перед каждым
тестом, в отчёт не попадает. Контексты тестов `test.concurrent` не пересекаются.

---

## Исходы

| Что произошло | Исход |
|---|---|
| тест прошёл | `passed` |
| не выполнилась проверка `expect(...)`, `node:assert` или chai (`AssertionError`) | `failed` |
| другое исключение, таймаут, брошенная строка | `broken` |
| упал хук (`beforeAll`, `beforeEach`, `afterAll`, `afterEach`) | `broken`, шаг хука тоже `broken` |
| `test.skip`, `describe.skip`, `test.todo` | `skipped` |
| тест не выполнялся из-за `-t`, `test.only` или режима 0 | результат не отправляется |
| файл не загрузился (синтаксис, импорт) | в режиме 2 создаётся результат `broken` с названием «`<файл>` could not be loaded»; в режимах 0 и 1 адаптер выводит «DoQA: `<файл>` could not be loaded - its tests are not reported» |
| повтор через `jest.retryTimes` | каждая попытка отправляется отдельным результатом того же автотеста |

DoQA по-разному обрабатывает `failed` и `broken` при кластеризации ошибок и анализе нестабильных
тестов. Для шага правило то же: ошибка проверки даёт `failed`, любая другая ошибка даёт `broken`.
ANSI-коды из сообщений удаляются.

---

## Как адаптер отправляет результаты

Прогоном управляет reporter в главном процессе. Workers записывают результаты в файлы
`*.record.json` в каталоге `.doqa/<сессия>/` и к DoQA не обращаются.

Reporter отправляет результаты пакетами по `batchSize`. Для каждого пакета он сначала обновляет
определения автотестов, которых ещё не отправлял (шаги before/step/after, метки, теги, ссылки,
`case_ids`, `runner_name`, `runner_method`), затем загружает вложения и отправляет результаты с
полями `report_id`, `chunk_index` и `is_final_chunk`. С `importRealtime` пакеты отправляются после
завершения каждого тестового файла.

Номера пакетов идут без пропусков: номер неудачного запроса используется повторно. Если DoQA
отвечает, что пакет с таким номером уже записан (ответ на прошлый запрос не дошёл), адаптер
записывает пакет в файлы и продолжает нумерацию. Отправку закрывает пакет с `is_final_chunk`. Если
его не удалось отправить, адаптер повторяет закрытие пустым пакетом, а при неудаче выводит «DoQA:
the delivery could not be closed (…) - DoQA may keep waiting for the run to finish».

Строковые поля адаптер обрезает до лимитов DoQA: 255 символов, для названия шага 500, для имени
прогона 100.

GET-запросы и создание прогона (по ключу `external_key`) повторяются при сетевых ошибках, 5xx и
429. Остальные POST-запросы повторяются только при 429 и в случае, когда соединение не
установилось. `retries` задаёт общее число попыток на запрос. После 5 запросов подряд, завершившихся ошибкой,
адаптер 30 секунд не обращается к DoQA: запросы в это время сразу завершаются ошибкой. Затем
адаптер делает одну пробную попытку.

### Каталог восстановления

Если сессия прошла без ошибок, адаптер удаляет каталог `.doqa/<сессия>/`. При ошибках каталог
остаётся, и адаптер выводит «DoQA: recovery files are kept in '`<каталог>`'». В каталоге лежат
записи результатов, вложения, подготовленные пакеты `chunk-N.json` и ответы DoQA
`chunk-N.receipt.json`. Не удаляйте каталог, пока не разберётесь с ошибкой. Если DoQA принял только
часть пакета, адаптер выводит «DoQA: chunk N: DoQA accepted X of Y results (skipped: `<причины>`);
see the receipt in '`<каталог>`'».

---

## Формат файлов

Для каждого теста адаптер записывает `<uuid>-result.json` в формате Allure 2 с метками `doqa_id`,
`doqa_title`, `doqa_cases`, `doqa_work_items`, `doqa_create_manual_case`, `doqa_runner_name`,
`doqa_runner_method`, `framework=jest`, `language=javascript`, `package`, `testClass` и `suite`.
Теги и метки теста записываются как `tag`. `historyId` учитывает параметры. Файл
`<uuid>-container.json` записывается только для тестов с фикстурами. Вложения записываются в файлы
`<uuid>-attachment.<ext>`. Если задан ключ `environment`, адаптер записывает `environment.properties`.

Загружайте файлы командой `doqactl upload` или шагом CI. Метку `AS_ID` адаптер не записывает: связи
с Allure ID в адаптере Jest нет (см. [ограничения](#ограничения)).

---

## Ограничения

Адаптер не поддерживает:

- плейсхолдеры `{param}` в идентификаторах и названиях;
- метаданные на уровне `describe`;
- переопределение `namespace` и `classname`;
- отдельное сообщение к результату и описание шага;
- разметку Allure: вызовы `allure-js-commons` адаптер не перехватывает;
- тестовые функции-генераторы;
- раннер `jest-jasmine2`;
- строки в `projects`: такие проекты не отчитываются, адаптер выводит «DoQA: string entries of
  `projects` are not reported - describe them as objects to report them».

При переходе с отчётов-файлов (jest-junit, Allure) адаптер создаёт новые автотесты со своими
идентификаторами, без связи с прежней историей.

---

## Устранение неполадок

| Симптом | Причина и решение |
|---|---|
| Результатов нет ни в DoQA, ни в файлах | задан `reporting=api` без `url`, `token` или `spaceId`: в stderr есть «DoQA: reporting=api, but the configuration is incomplete…»; либо задан `reporting=off` |
| Результаты в `results/`, а ожидались в DoQA | режим `auto` без настроек API, в stderr есть «DoQA: no reporting configuration found (missing …)». Задайте `url`, `token` и `spaceId`. Если файловый режим нужен, задайте `reporting=files`, и предупреждение пропадёт |
| DoQA недоступен или отклонил токен, в `results/` появились файлы | адаптер перешёл в файловый режим (в stderr «DoQA: could not establish the test run…» или «DoQA: results chunk failed…»). Загрузите `results/` так же, как в файловом режиме |
| В stderr «is set to the unexpanded variable reference» | в процесс попала строка `$DOQA_TOKEN` без подстановки: переменная CI не существует или не передана в джобу |
| Выборочный прогон не выполнил ни одного теста | в stderr «DoQA: the run selects N autotests, but none of them matched…»: список автотестов в DoQA не совпадает с кодом. Отправьте в DoQA результаты полного прогона |
| Тесты выполнились, но часть результатов не отправлена | в stderr «DoQA: N tests ran because their location matched the run, but their id is not part of it…»: тест без явного идентификатора совпал по месту, но итоговый идентификатор (например, из `doqa.metadata({ id })`) не входит в прогон |
| Порядок плана не применяется | в stderr «DoQA: the plan order is not applied (…) - test files run in the Jest order». Причины: `test.concurrent`, собственный `testSequencer`, чередование файлов или `describe`-блоков в плане |
| Самоподписанный сертификат | `certValidation=false` (только для тестовых стендов) |
| DoQA доступен через прокси | `proxy=host:port` |
| Параметры или сообщения обрезаны с `… truncated` | увеличьте `maxParameterLength`, `maxMessageLength` или `maxTraceLength` |
| Локальные запуски создают прогоны в DoQA | уберите токен из локальной конфигурации или задайте локально `reporting=files` |
| В режиме watch ничего не отправляется | так задумано («DoQA: watch mode is not reported…»); в CI запускайте `npx jest` без `--watch` |

---

## Переход с jest-junit и Allure

Разметку jest-junit и вызовы `allure-js-commons` адаптер не использует. После перехода автотесты
создаются заново с идентификаторами адаптера (см. [идентификатор автотеста](#идентификатор-автотеста))
и без истории прежнего отчёта. Чтобы история начиналась с первого прогона через адаптер, задайте
`id` в `doqa.test(...)` до перехода.

Файловый режим записывает Allure-совместимые результаты, поэтому шаг CI, который загружает
Allure-артефакты (`doqactl upload` / `POST /api/autotests/report`), работает без изменений.

---

## Сборка из исходников

Адаптер находится в монорепозитории `doqa-js` вместе с модулями `doqa-js-commons` и `doqa-client`.
Все три модуля публикуются одним пакетом из корня репозитория:

```sh
npm ci
npm run lint
npm test
```

`npm test` собирает пакет и запускает `node --test` для тестов `doqa-client`, `doqa-js-commons` и
`doqa-jest`. Тесты адаптера запускают Jest в дочерних процессах и проверяют CJS и ESM, jsdom,
TypeScript, параметры, повторы, workers, отбор и порядок по плану, ошибки загрузки файлов.

## Лицензия

[Apache License 2.0](../LICENSE)
