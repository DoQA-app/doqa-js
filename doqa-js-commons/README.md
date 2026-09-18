# doqa-js-commons - общее ядро JavaScript-адаптеров DoQA

`doqa-js-commons` - фреймворк-агностичное ядро, общее для всех JavaScript-адаптеров DoQA. Слой
между API-клиентом и обвязкой конкретного тестового фреймворка:

```
ваши тесты ──► doqa-jest (обвязка Jest) ──► doqa-js-commons (этот модуль) ──► doqa-client (HTTP/файлы)
```

Часть монорепозитория `doqa-js`: отдельным npm-пакетом не публикуется, входит в состав пакета
`@doqa-tms/jest` и доступен по импорту `@doqa-tms/jest/commons` (плюс отдельные подпути `@doqa-tms/jest/commons/session`
и `@doqa-tms/jest/commons/coordinator`). Использует встроенный клиент, глобальных объектов Jest не
требует.

HTTP-компоненты вынесены в отдельные exports: импорт основной точки входа `@doqa-tms/jest/commons` не
тянет за собой HTTP-клиент - это важно внутри тестового VM-контекста jsdom, где нет глобалов Node
для `fetch`.

## Требования

- Node.js 22 или 24.

## Установка

Тестовым проектам этот модуль напрямую не нужен - ставьте адаптер своего фреймворка
(`npm install --save-dev @doqa-tms/jest`), он принесёт ядро с собой. Прямой импорт нужен только при
написании нового адаптера:

```js
const { Runtime, resolveConfig } = require('@doqa-tms/jest/commons');
const { establishSession, loadSession } = require('@doqa-tms/jest/commons/session');
const { Coordinator } = require('@doqa-tms/jest/commons/coordinator');
```

## Что внутри

- **`resolveConfig(options, onWarning)`** - настройки: приоритет `options` (второго аргумента
  `withDoqa`) → переменные окружения `DOQA_*` → файл `doqa.properties` → дефолты; алиасы,
  валидация чисел/режима/`reporting`, детект нераскрытых переменных вида `$DOQA_TOKEN`. Никогда не
  бросает исключение - о сломанной настройке сообщает через `onWarning` и откатывается на дефолт.
- **`Runtime`** - async-контекст (`AsyncLocalStorage`) одного теста или шага: `metadata(value)`,
  `step(title, fn)`, `attach(name, content, type?)`, `attachFile(path, name?, type?)`. Вне
  активного контекста каждый вызов - безопасный no-op.
- **Контракт данных** (`RecordResult`, `Step`, `Metadata`, `Attachment`, `Link`, `Parameter`,
  `PlanItem`, `Session`, `FrameworkInfo`, `FileSummary`) - общая модель между воркерами и
  координатором, не зависящая от фреймворка.
- **`atomic`, `hash`, `warn`, `truncate`, `stripAnsi`, `failureOutcome`, `contentTypeOf`, `reason`** -
  служебные функции: атомарная запись файла (запись во временный файл + переименование), SHA-1 для
  каскада идентификации, вывод предупреждений `DoQA: …` в stderr, обрезка длинных полей, снятие
  ANSI-кодов, классификация ошибки в `failed`/`broken`.
- **`writeAllure`, `writeReportingInfo`, `labelList`** - файловый sink: Allure 2 совместимые
  `<uuid>-result.json` / `<uuid>-container.json`, `environment.properties` и маркер
  `doqa-reporting.properties`.
- **`/session`: `establishSession`, `loadSession`** - установка прогона в DoQA (или осознанная
  деградация в файлы) и чтение уже установленной сессии воркерами.
- **`/coordinator`: `Coordinator`** - владеет прогоном целиком: собирает `*.record.json` от
  воркеров, шлёт пакеты по `batchSize`, грузит вложения, деградирует в файлы при сбоях, оставляет
  каталог восстановления при проблемах и печатает сводные предупреждения по окончании прогона.

## Использование

```js
const { Coordinator } = require('@doqa-tms/jest/commons/coordinator');

const coordinator = new Coordinator(
  { reporting: 'files', sessionDir: '.doqa/example', resultsDir: 'results' },
  { name: 'example-runner', language: 'javascript', displayName: 'Example runner' },
);
await coordinator.start();
// воркеры пишут RecordResult в *.record.json через atomic(...)
await coordinator.complete();
```

Адаптер создаёт одну сессию и один `Coordinator` на запуск, передаёт воркерам `sessionDir` и
вызывает `complete()` после их завершения. На стороне воркеров `Runtime.context.run({ result },
fn)` связывает текущий `result` с пользовательским кодом теста - внутри `fn` вызовы
`doqa.metadata`/`step`/`attach*` находят нужную запись сами. Маппинг событий фреймворка в исходы,
правила отбора и порядка тестов остаются в самом адаптере.

## Как написать адаптер поверх ядра

Обвязка фреймворка отвечает за пять вещей:

1. **Сессия и координатор** - в главном процессе на старте прогона создайте `Coordinator(options,
   frameworkInfo)` (`frameworkInfo = { name, language, displayName }`) и вызовите
   `await coordinator.start()`. Он резолвит настройки через `resolveConfig`, устанавливает прогон
   в DoQA (или переключается на файлы) и пишет `session.json` в `sessionDir` - единственный канал,
   из которого воркеры узнают об активной сессии.
2. **Воркеры читают сессию** - каждый воркер вызывает `loadSession(sessionDir)`, чтобы узнать
   `sink` (`api`/`files`/`off`) и, в режиме 0, состав прогона (`plan`). Без файла сессии воркер
   остаётся пассивным - это и означает `reporting=off`.
3. **Жизненный цикл теста** - на старте теста оберните его исполнение в `runtime.context.run({
   result }, () => …)`, где `runtime = new Runtime(sessionDir, maxMessageLength)`, а `result` -
   собранный `RecordResult` (id, `namespace`, `classname`, `runner_method`, `metadata`, …). По
   завершении сохраните запись атомарно: `atomic(join(sessionDir, '<имя>.record.json'), result)`.
4. **Отбор и порядок (опционально)** - если фреймворк даёт хуки discovery, используйте
   `session.plan`, чтобы деселектить тесты не из плана и сортировать оставшиеся по позиции в нём.
   На границе прогона пишите файл-сводку `*.summary.json` (`selected`, `unreported`, `duplicates`,
   `notes`) - по нему `coordinator.complete()` печатает агрегированные предупреждения.
5. **Точки доставки** - вызывайте `coordinator.notify()` по мере готовности результатов (realtime)
   и `await coordinator.complete()` в конце прогона. Ошибка координатора никогда не должна вылетать
   в прогон пользователя.

Модуль [`doqa-jest`](../doqa-jest/README.md) - эталонная реализация этого рецепта.

## Сборка

Модуль живёт в монорепозитории `doqa-js` и собирается из его корня:

```sh
npm run build
node --test doqa-js-commons/tests/*.test.cjs
```

Тесты - контрактные фикстуры над ядром (резолвинг конфигурации, файловый sink, координатор
доставки, преждевременное завершение процесса) - без сети и без запуска тестового движка.

## Лицензия

[Apache License 2.0](../LICENSE)
