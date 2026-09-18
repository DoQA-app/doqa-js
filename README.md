# DoQA для JavaScript - автотесты, которые сами попадают в TMS

[![CI](https://github.com/doqa-app/doqa-js/actions/workflows/ci.yml/badge.svg)](https://github.com/doqa-app/doqa-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@doqa-tms/jest?label=@doqa-tms%2Fjest)](https://www.npmjs.com/package/@doqa-tms/jest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Один пакет - и результаты ваших Jest-тестов появляются в [DoQA](https://doqa.app) сами: с шагами,
фикстурами, вложениями, параметрами и стабильной историей по каждому тесту. Без переписывания
тестов, без своего инфраструктурного кода, без риска для прогона - если DoQA недоступен или не
настроен, тесты проходят как обычно.

## Быстрый старт

**Шаг 1.** Установите пакет:

```sh
npm install --save-dev @doqa-tms/jest
```

**Шаг 2.** Подключите адаптер в конфиге Jest и запустите тесты:

```js
// jest.config.cjs
const { withDoqa } = require('@doqa-tms/jest');
module.exports = withDoqa({ testEnvironment: 'node' });   // второй аргумент - настройки адаптера, необязателен
```

Уже на этом шаге адаптер пишет в `results/` файлы Allure-совместимого формата - их принимает
конвейер загрузки DoQA, а мигрирующим с Allure не нужно менять пайплайн. Загрузить их в DoQA можно
артефактом CI.

**Шаг 3 (опционально).** А чтобы слать результаты сразу в API, достаточно трёх ключей:

```properties
# doqa.properties (или DOQA_URL / DOQA_TOKEN / DOQA_SPACE_ID в CI)
url=https://demo.doqa.app
token=<project token>
spaceId=42
```

Требуется Node.js 22 или 24, Jest 29.7 или 30.x (peer dependency). Подробный гайд - конфигурация,
разметка, режимы, траблшутинг - в [README адаптера](doqa-jest/README.md).

## Что вы получаете

- **Полный отчёт** - дерево шагов (`doqa.step`), фикстуры как setup/teardown (`beforeEach`/`afterEach`
  и `beforeAll`/`afterAll`), вложения (файлы и контент из памяти), параметры инвокаций, ссылки на
  задачи и требования, метки.
- **Стабильная история тестов** - каскад идентификации (`metadata.id` → id в названии теста →
  детерминированный хэш): переименования без явного id создают новый автотест осознанно, а не
  случайно.
- **Селективные прогоны** - Run Player DoQA перезапускает выбранные тесты, а адаптер физически
  исполняет только их (невыбранные видны в Jest как `skipped`) и умеет проходить их в порядке
  плана DoQA (`executionOrder: 'plan'`).
- **Живой прогресс** - `importRealtime` стримит результаты по мере прогона (пакет на каждый
  завершённый файл теста), батч-режим шлёт всё пакетами по `batchSize` в конце; и то и другое
  переживает сбои сети без потери прогона.
- **Не ломает прогон** - ошибка настройки, недоступный DoQA, отвергнутый пакет результатов или
  сбой вложения - это предупреждение `DoQA: …` в stderr и деградация в файлы, а не падение Jest.
- **Воркеры из коробки** - reporter в главном процессе один раз устанавливает прогон, воркеры Jest
  только пишут записи на диск и в сеть не ходят - отдельная настройка для параллельного запуска
  не нужна.
- **Файловый режим для строгих контуров** - тестовому процессу не нужны ни сеть до DoQA, ни
  токен: результаты уезжают артефактом пайплайна.

## Что внутри

Исходники разделены по назначению, но публикуются **одним npm-пакетом** `@doqa-tms/jest` из корня
монорепозитория - отдельных пакетов `doqa-client` и `doqa-js-commons` в npm нет, их модули
доступны через subpath-импорты того же пакета.

| Модуль исходников | Импорт | Назначение |
|---|---|---|
| [`doqa-jest`](doqa-jest/README.md) | `@doqa-tms/jest` (= `@doqa-tms/jest/jest`) | адаптер Jest - то, что подключают в тестовый проект |
| [`doqa-js-commons`](doqa-js-commons/README.md) | `@doqa-tms/jest/commons` | фреймворк-агностичное ядро: конфигурация, шаги, вложения, координатор доставки |
| [`doqa-client`](doqa-client/README.md) | `@doqa-tms/jest/client` | HTTP-клиент DoQA Autotest API; ноль рантайм-зависимостей, кроме `undici` |

Отдельными подпутями доступны также `@doqa-tms/jest/reporter`, `@doqa-tms/jest/environment-node`,
`@doqa-tms/jest/environment-jsdom`, `@doqa-tms/jest/sequencer`, `@doqa-tms/jest/commons/session` и
`@doqa-tms/jest/commons/coordinator`.

## Как это устроено

```
ваши тесты ──► doqa-jest (адаптер) ──► doqa-js-commons (ядро) ──► doqa-client (HTTP/файлы) ──► DoQA
```

Пользовательский API (`doqa.test`, `doqa.step`, `doqa.metadata`, …) живёт в адаптере и не зависит
от ядра напрямую - ядро и клиент фреймворк-агностичны и переиспользуются будущими адаптерами других
тестовых раннеров. Не нашли адаптер своего фреймворка - напишите нам в поддержку support@doqa.app,
а в [README ядра](doqa-js-commons/README.md) есть рецепт, как разработать свой.

## Сборка

Нужен только Node.js 22 или 24:

```sh
npm ci
npm run lint
npm test
npm run pack
npm run test:packages
```

`npm test` собирает пакет и прогоняет контрактные тесты клиента, ядра и адаптера (в том числе
настоящие дочерние процессы Jest); `npm run pack` собирает архив пакета, `npm run test:packages`
проверяет его установку и импорт в отдельном временном проекте. Релиз - тег `v<версия>`, дальше CI
сам публикует пакет `@doqa-tms/jest` в npm и собирает release notes из `type:`-лейблов PR.

## Лицензия

[Apache License 2.0](LICENSE)
