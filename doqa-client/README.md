# doqa-client - клиентское ядро DoQA Autotest API (JavaScript)

`doqa-client` - HTTP-клиент DoQA Autotest API для JavaScript, на котором работают адаптеры
тестовых фреймворков DoQA (сейчас - [`@doqa-tms/jest`](../doqa-jest/README.md)). Часть монорепозитория
`doqa-js`: отдельным npm-пакетом не публикуется, входит в состав пакета `@doqa-tms/jest` и доступен по
импорту `@doqa-tms/jest/client`. Умеет говорить с DoQA Autotest API напрямую; эмиссией
Allure-совместимых файлов результатов занимается [`doqa-js-commons`](../doqa-js-commons/README.md).

**Единственная рантайм-зависимость всего пакета `@doqa-tms/jest` - `undici`** (HTTP/`fetch`, JSON и
multipart через `FormData`); ничего из Jest в этот модуль не протекает, поэтому его безопасно
использовать и вне тестового процесса.

## Требования

- Node.js 22 или 24.

## Установка

Напрямую вам этот модуль не нужен - ставьте адаптер своего фреймворка
(`npm install --save-dev @doqa-tms/jest`), он принесёт клиент с собой той же версией. Прямой импорт
нужен только при написании собственного адаптера или интеграции:

```js
const { Client, ApiError } = require('@doqa-tms/jest/client');
```

## Назначение

`Client` отправляет запросы в `/api/autotests/…`, добавляет токен и `spaceId` в каждый запрос,
поддерживает JSON и multipart (`FormData` из `undici`), TLS/прокси, таймауты и circuit breaker.
Безопасные запросы (GET, создание прогона по идемпотентному ключу) повторяются при временных
ошибках, любые - при 429 и когда соединение вообще не установилось; в остальных случаях POST не
повторяется - потерянный ответ не должен задублировать прогон или результат. `ApiError` несёт
HTTP-статус и начало тела ответа; токен в сообщениях маскируется (`***`), URL печатается без query.
После использования вызовите `await client.close()`.

## Использование

```js
const { Client } = require('@doqa-tms/jest/client');

const client = new Client({
  url: process.env.DOQA_URL,
  token: process.env.DOQA_TOKEN,
  spaceId: process.env.DOQA_SPACE_ID,
  requestTimeoutMs: 30000,
  retries: 3,
  retryBackoffMs: 500,
});
try {
  const plan = await client.request('test-runs/123/autotests', {}, 'GET');
} finally {
  await client.close();
}
```

Пример вызывается внутри async-функции. `ApiError` - ошибка с полем `status` (HTTP-код ответа,
`0` - DoQA не ответила); в остальном ведёт себя как обычный `Error`. CJS/ESM и типы TypeScript
доступны из коробки.

## Сборка

Модуль живёт в монорепозитории `doqa-js` и собирается из его корня:

```sh
npm run build
node --test doqa-client/tests/*.test.cjs
```

Тесты - контрактные фикстуры над HTTP-контрактом (локальный сервер на loopback-порту), сеть наружу
не нужна.

## Лицензия

[Apache License 2.0](../LICENSE)
