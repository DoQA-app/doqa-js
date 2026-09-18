const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Client, ApiError } = require("../../dist/doqa-client/src");

async function serve(t, respond) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    req.resume();
    respond(res, calls.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}
// A port nobody listens on: above the ephemeral one just taken, so not a "bad port" for fetch.
function freePort(taken) {
  return Number(taken) === 65535 ? 65534 : Number(taken) + 1;
}
function client(t, url, extra = {}) {
  const instance = new Client({
    url,
    token: "test-secret",
    spaceId: 1,
    retries: 3,
    retryBackoffMs: 0,
    requestTimeoutMs: 30000,
    ...extra,
  });
  t.after(() => instance.close());
  return instance;
}

test("retries cover idempotent requests and 429 only; retries is the total number of attempts", async (t) => {
  let status = 503;
  const fake = await serve(t, (res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end('{"error":"echo test-secret"}');
  });
  const api = client(t, fake.url);
  await assert.rejects(() => api.request("upsert", {}));
  assert.equal(fake.calls.length, 1);
  fake.calls.length = 0;
  await assert.rejects(() => api.request("test-runs", {}, "POST", true));
  assert.equal(fake.calls.length, 3);
  fake.calls.length = 0;
  status = 429;
  await assert.rejects(() => api.request("results", {}));
  assert.equal(fake.calls.length, 3);
  fake.calls.length = 0;
  status = 401;
  await assert.rejects(() => api.request("results", {}, "POST", true));
  assert.equal(fake.calls.length, 1);
});
test("errors carry the status and the server answer, never the token", async (t) => {
  const fake = await serve(t, (res) => {
    res.writeHead(422, { "Content-Type": "application/json" });
    res.end('{"message":"classname is too long","token":"test-secret"}');
  });
  const error = await client(t, fake.url)
    .request("test-runs/5/autotests", {}, "GET")
    .catch((e) => e);
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 422);
  assert.equal(
    error.message,
    `GET ${fake.url}/api/autotests/test-runs/5/autotests -> 422: {"message":"classname is too long","token":"***"}`,
  );
  const closed = await serve(t, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const offline = await client(t, closed.url.replace(/\d+$/, (port) => String(freePort(port))), { retries: 1 })
    .request("upsert", {})
    .catch((e) => e);
  assert.equal(offline.status, 0);
  assert.match(offline.message, /-> no response \(ECONNREFUSED\)$/);
});
test("the base URL tolerates trailing slashes and an /api tail", async (t) => {
  const fake = await serve(t, (res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  for (const suffix of ["", "/", "//", "/api", "/api/"])
    await client(t, fake.url + suffix).request("upsert", {});
  assert.deepEqual([...new Set(fake.calls)], ["/api/autotests/upsert"]);
});
test("the circuit breaker opens after five failures", async (t) => {
  const fake = await serve(t, (res) => {
    res.writeHead(500);
    res.end("{}");
  });
  const api = client(t, fake.url);
  for (let i = 0; i < 5; i++) await assert.rejects(() => api.request("results", {}));
  const error = await api.request("results", {}).catch((e) => e);
  assert.match(error.message, /circuit breaker is open/);
  assert.equal(fake.calls.length, 5);
});
