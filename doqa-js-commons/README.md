# doqa-js-commons: общая часть JavaScript-адаптеров DoQA

`doqa-js-commons` содержит код адаптеров DoQA, который не зависит от тестового фреймворка:
разбор настроек, шаги и вложения, отправку результатов и запись файлов. Модуль находится между
адаптером конкретного фреймворка и HTTP-клиентом:

```
ваши тесты ──► doqa-jest (адаптер Jest) ──► doqa-js-commons (этот модуль) ──► doqa-client (HTTP)
```

Модуль входит в монорепозиторий `doqa-js`, отдельным npm-пакетом не публикуется и доступен в
пакете `@doqa-tms/jest` по импорту `@doqa-tms/jest/commons`. Компоненты, которые обращаются к DoQA
по HTTP, вынесены в подпути `@doqa-tms/jest/commons/session` и `@doqa-tms/jest/commons/coordinator`.
Основная точка входа `@doqa-tms/jest/commons` HTTP-клиент не загружает: её импортирует код внутри
тестовой среды, а в среде jsdom нет глобальных объектов Node, которые нужны для `fetch`. Глобальные
объекты Jest модулю не нужны.

## Требования

- Node.js 22 или 24.

## Установка

Тестовым проектам модуль напрямую не нужен: установите адаптер своего фреймворка
(`npm install --save-dev @doqa-tms/jest`), модуль входит в него. Импортировать его напрямую нужно,
только если вы пишете новый адаптер:

```js
const { Runtime, resolveConfig } = require('@doqa-tms/jest/commons');
const { establishSession, loadSession } = require('@doqa-tms/jest/commons/session');
const { Coordinator } = require('@doqa-tms/jest/commons/coordinator');
```

## Состав

- **`resolveConfig(options, onWarning)`** собирает настройки. Приоритет: `options` (в адаптере
  Jest это второй аргумент `withDoqa`), затем переменные окружения `DOQA_*`, затем файл
  `doqa.properties`, затем значения по умолчанию. Функция учитывает алиасы, проверяет числа, режим
  и `reporting`, распознаёт нераскрытые ссылки на переменные вида `$DOQA_TOKEN`. Исключений она не
  выбрасывает: о некорректной настройке сообщает через `onWarning` и использует значение по
  умолчанию.
- **`Runtime`** хранит контекст текущего теста или шага в `AsyncLocalStorage` и предоставляет
  методы `metadata(value)`, `step(title, fn)`, `attach(name, content, type?)` и
  `attachFile(path, name?, type?)`. Вне контекста теста вызовы ничего не делают.
- **Типы данных** `RecordResult`, `Step`, `Metadata`, `Attachment`, `Link`, `Parameter`, `PlanItem`,
  `Session`, `FrameworkInfo`, `FileSummary` описывают данные, которыми обмениваются workers и
  координатор.
- **Служебные функции** `atomic`, `hash`, `warn`, `reason`, `clip`, `truncate`, `stripAnsi`,
  `failureOutcome`, `contentTypeOf`: атомарная запись файла (во временный файл с последующим
  переименованием), SHA-1 для вычисления идентификатора, вывод предупреждений `DoQA: …` в stderr,
  обрезка строк, удаление ANSI-кодов, выбор исхода `failed` или `broken` по ошибке.
- **`writeAllure`, `writeReportingInfo`, `labelList`** записывают результаты в формате Allure 2
  (`<uuid>-result.json`, `<uuid>-container.json`), `environment.properties` и файл
  `doqa-reporting.properties`.
- **`/session`: `establishSession`, `loadSession`.** `establishSession` создаёт прогон в DoQA или
  получает его состав; при ошибке переводит сессию в файловый режим. `loadSession` читает уже
  установленную сессию в workers.
- **`/coordinator`: `Coordinator`** управляет прогоном: собирает файлы `*.record.json` от workers,
  отправляет их пакетами по `batchSize`, загружает вложения, при ошибках записывает результаты в
  файлы, при проблемах сохраняет каталог восстановления и в конце прогона выводит сводные
  предупреждения.

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

Адаптер создаёт одну сессию и один `Coordinator` на запуск, передаёт workers путь `sessionDir` и
вызывает `complete()` после их завершения. В workers вызов `runtime.context.run({ result }, fn)` у
экземпляра `Runtime` связывает запись `result` с кодом теста: вызовы `doqa.metadata`, `doqa.step`
и `doqa.attach*` внутри `fn` попадают в эту запись. Сопоставление событий фреймворка с исходами,
отбор тестов и их порядок реализует сам адаптер.

## Как написать адаптер

Адаптер фреймворка отвечает за пять задач.

1. **Сессия и координатор.** В главном процессе при старте прогона создайте
   `new Coordinator(options, frameworkInfo)`, где `frameworkInfo = { name, language, displayName }`,
   и вызовите `await coordinator.start()`. Конструктор разбирает настройки через `resolveConfig`,
   а `start()` создаёт прогон в DoQA (или переключается на файлы) и записывает `session.json` в
   `sessionDir`. Из этого файла workers узнают об активной сессии.
2. **Чтение сессии в workers.** Каждый worker вызывает `loadSession(sessionDir)` и получает `sink`
   (`api`, `files` или `off`) и, в режиме 0, состав прогона (`plan`). Если файла сессии нет, worker
   ничего не записывает: так работает `reporting=off`.
3. **Жизненный цикл теста.** При старте теста выполните его внутри
   `runtime.context.run({ result }, () => …)`, где `runtime = new Runtime(sessionDir, maxMessageLength)`,
   а `result` — объект `RecordResult` (id, `namespace`, `classname`, `runner_method`, `metadata` и
   другие поля). После завершения теста сохраните запись:
   `atomic(join(sessionDir, '<имя>.record.json'), result)`. Координатор читает записи в порядке
   сортировки имён файлов.
4. **Отбор и порядок (необязательно).** Если фреймворк позволяет отбирать тесты до выполнения,
   используйте `session.plan`: исключите тесты, которых нет в плане, и отсортируйте остальные по
   позиции в плане. После выполнения каждой части прогона (в Jest — тестового файла) запишите файл
   `*.summary.json` с полями `selected`,
   `unreported`, `duplicates` и `notes`: по нему `coordinator.complete()` выводит сводные
   предупреждения.
5. **Отправка.** Вызывайте `coordinator.notify()`, когда готовы новые результаты (режим
   `importRealtime`), и `await coordinator.complete()` в конце прогона. Ошибки координатора не
   должны влиять на результат прогона тестов.

По этой схеме реализован адаптер [`doqa-jest`](../doqa-jest/README.md).

## Сборка и тесты

Модуль собирается из корня монорепозитория `doqa-js`:

```sh
npm run build
node --test doqa-js-commons/tests/*.test.cjs
```

Тесты проверяют разбор настроек, запись файлов, координатор и завершение процесса до конца
прогона. Доступ в сеть и запуск тестового фреймворка для них не нужны.

## Лицензия

[Apache License 2.0](../LICENSE)
