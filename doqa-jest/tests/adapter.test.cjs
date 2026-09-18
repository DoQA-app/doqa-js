const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const http = require("node:http");
const root = path.resolve(__dirname, "../../dist/doqa-jest");
const jest = require.resolve("jest/bin/jest");

async function run(t, sources, options = {}, config = {}, args = [], extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doqa-jest-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(sources))
    fs.writeFileSync(path.join(dir, file), source);
  fs.writeFileSync(
    path.join(dir, "jest.config.cjs"),
    `const {withDoqa}=require(${JSON.stringify(root + "/src")});module.exports=withDoqa(${JSON.stringify({ rootDir: dir, testMatch: ["**/*.test.cjs", "**/*.test.mjs"], maxWorkers: 2, ...config })},${JSON.stringify({ reporting: "files", resultsDir: path.join(dir, "results"), ...options })});`,
  );
  const env = { ...process.env, NODE_OPTIONS: "--experimental-vm-modules" };
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(env))
    if (key.startsWith("DOQA_") || key === "FORCE_COLOR") delete env[key];
  Object.assign(env, extraEnv);
  const processResult = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [jest, "--config", path.join(dir, "jest.config.cjs"), "--no-cache", ...args],
      { cwd: dir, env },
    );
    let output = "";
    child.stdout.on("data", (s) => (output += s));
    child.stderr.on("data", (s) => (output += s));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
  const resultsDir = path.join(dir, "results");
  const files = fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir) : [];
  const read = (f) => JSON.parse(fs.readFileSync(path.join(resultsDir, f)));
  const results = files.filter((f) => f.endsWith("-result.json")).map(read);
  const containers = files.filter((f) => f.endsWith("-container.json")).map(read);
  const marker = files.includes("doqa-reporting.properties")
    ? Object.fromEntries(
        fs
          .readFileSync(path.join(resultsDir, "doqa-reporting.properties"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      )
    : undefined;
  const sessions = fs.existsSync(path.join(dir, ".doqa"))
    ? fs.readdirSync(path.join(dir, ".doqa"))
    : [];
  const warnings = processResult.output.split("\n").filter((l) => l.startsWith("DoQA: "));
  return { ...processResult, dir, files, results, containers, marker, sessions, warnings };
}
const api = `const {doqa}=require(${JSON.stringify(root + "/src")});\n`;
const labelsOf = (result, name) =>
  result.labels.filter((l) => l.name === name).map((l) => l.value);
async function server(t, plan = [], handler) {
  const calls = [];
  const service = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = req.headers["content-type"]?.includes("application/json")
      ? JSON.parse(body)
      : {};
    const url = new URL(req.url, "http://localhost");
    calls.push({ method: req.method, path: url.pathname, body: json, url });
    res.setHeader("Content-Type", "application/json");
    if (handler?.(url, json, req, res, calls)) return;
    if (url.pathname.endsWith("/autotests") && req.method === "GET")
      return res.end(JSON.stringify({ autotests: plan }));
    if (url.pathname.endsWith("/test-runs")) return res.end('{"runId":42}');
    if (url.pathname.endsWith("/attachments"))
      return res.end('{"mediaFileId":7}');
    if (url.pathname.endsWith("/results"))
      return res.end(
        JSON.stringify({ accepted: json.results.length, elementIds: [], skipped: [] }),
      );
    res.end('{"map":{}}');
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => service.close(resolve)));
  const of = (suffix) => calls.filter((c) => c.path.endsWith(suffix));
  return {
    calls,
    chunks: () => of("/results").map((c) => c.body),
    sent: () => of("/results").flatMap((c) => c.body.results),
    definitions: () => of("/upsert").flatMap((c) => c.body.autotests),
    runs: () => of("/test-runs"),
    options: {
      reporting: "api",
      url: `http://127.0.0.1:${service.address().port}`,
      spaceId: 1,
      token: "test-secret",
      retries: 1,
    },
  };
}
const fail = (suffix, status, times = Infinity) => {
  let seen = 0;
  return (url, _json, _req, res) => {
    if (!url.pathname.endsWith(suffix) || ++seen > times) return false;
    res.statusCode = status;
    res.end('{"message":"rejected by the test server"}');
    return true;
  };
};

test("ordinary tests, nested steps, hooks, attachments, todo and failure", async (t) => {
  const result = await run(t, {
    "sample.test.cjs":
      api +
      `
    beforeAll(()=>doqa.step('suite setup',()=>{}));
    beforeEach(()=>doqa.step('setup',()=>{}));
    afterAll(()=>doqa.step('suite cleanup',()=>{}));
    doqa.test('success',{id:'DOQA-1',caseIds:[12]},async()=>{
      await doqa.step('outer',async()=>{doqa.step('inner',()=>doqa.attach('text','hello'));});
    });
    test('failure',()=>expect(1).toBe(2));test.skip('skip',()=>{});test.todo('todo');
  `,
  });
  assert.equal(result.code, 1, result.output);
  assert.equal(result.results.length, 4, result.output);
  const success = result.results.find((r) => r.name === "success");
  assert.equal(success.steps[0].steps[0].attachments.length, 1);
  assert.equal(
    fs.readFileSync(
      path.join(
        result.dir,
        "results",
        success.steps[0].steps[0].attachments[0].source,
      ),
      "utf8",
    ),
    "hello",
  );
  const container = result.containers.find((c) => c.children.includes(success.uuid));
  assert.ok(
    container.befores.some((s) =>
      s.steps.some((c) => c.name === "suite setup"),
    ),
  );
  assert.ok(
    container.befores.some((s) => s.steps.some((c) => c.name === "setup")),
  );
  assert.equal(container.afters.length, 1);
  assert.deepEqual(
    result.results.filter((r) => r.status === "skipped").map((r) => r.name).sort(),
    ["skip", "todo"],
  );
  assert.deepEqual(result.marker, { sink: "files" });
  assert.equal(result.sessions.length, 0, "a clean session leaves no recovery directory");
});
test("each has one test identity, different histories; retries retain their history", async (t) => {
  const result = await run(t, {
    "each.test.cjs":
      api +
      `
    jest.retryTimes(1);let count=0;
    doqa.test.each([[1],[2]])('row %i',{id:'DATA'},async value=>{doqa.parameter('value',value);});
    doqa.test('retry',{id:'RETRY'},()=>{expect(++count).toBe(2);});
  `,
  });
  assert.equal(result.code, 0, result.output);
  const rows = result.results.filter((r) => r.testCaseId === "DATA");
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].historyId, rows[1].historyId);
  const retries = result.results.filter((r) => r.testCaseId === "RETRY");
  assert.equal(retries.length, 2);
  assert.equal(retries[0].historyId, retries[1].historyId);
});
test("non-finite numeric datasets retain distinct parameters and history", async (t) => {
  const result = await run(t, {
    "numbers.test.cjs": api + `
      doqa.test.each([[NaN], [Infinity], [-Infinity], [null], [0], ["NaN"]])(
        'number %s', {id:'NUMBERS'}, value => {
          doqa.parameter('runtime', value);
          expect(true).toBe(true);
        });
    `,
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.results.length, 6);
  assert.equal(new Set(result.results.map(r => r.historyId)).size, 6);
  const parameters = result.results.map(r => r.parameters.find(p => p.name === 'arg0').value);
  assert.deepEqual(parameters.sort(), ['NaN', 'Infinity', '-Infinity', 'null', '0', '"NaN"'].sort());
  for (const row of result.results) {
    const value = row.parameters.find(p => p.name === 'arg0').value;
    assert.equal(row.parameters.find(p => p.name === 'runtime').value, value === '"NaN"' ? 'NaN' : value);
  }
});

test("concurrent and worker contexts cannot share steps or parameters", async (t) => {
  const source =
    api +
    `for(const id of ['A','B']) doqa.test.concurrent(id,{id},async()=>{await doqa.step(id,async()=>{await new Promise(r=>setTimeout(r,id==='A'?30:5));doqa.parameter('owner',id);doqa.attach(id,id);});});`;
  const result = await run(t, {
    "parallel.test.cjs": source,
    "worker.test.cjs":
      api + `doqa.test('C',{id:'C'},()=>doqa.step('C',()=>{}));`,
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.results.length, 3);
  for (const r of result.results) assert.equal(r.steps[0].name, r.testCaseId);
});
test("direct API creates one run and uses one completion tuple across workers", async (t) => {
  const fake = await server(t);
  const result = await run(
    t,
    {
      "a.test.cjs": api + `doqa.test('A',{id:'A'},()=>doqa.attach('x','x'));`,
      "b.test.cjs": api + `doqa.test('B',{id:'B'},()=>{});`,
    },
    { ...fake.options, batchSize: 1, importRealtime: true },
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(fake.runs().length, 1);
  const chunks = fake.chunks();
  assert.equal(
    chunks.reduce((n, c) => n + c.results.length, 0),
    2,
  );
  assert.equal(new Set(chunks.map((c) => c.report_id)).size, 1);
  assert.deepEqual(
    chunks.map((c) => c.chunk_index),
    chunks.map((_, i) => i),
  );
  assert.equal(chunks.filter((c) => c.is_final_chunk).length, 1);
  assert.ok(chunks.at(-1).is_final_chunk);
  assert.ok(chunks.every((c) => c.test_run_id === 42));
});
test("a delivered run leaves no result files, only the api marker", async (t) => {
  const fake = await server(t);
  const result = await run(
    t,
    { "ok.test.cjs": `test('one',()=>{});test('two',()=>{});` },
    fake.options,
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(fake.sent().length, 2);
  assert.deepEqual(result.files, ["doqa-reporting.properties"]);
  assert.deepEqual(result.marker, {
    sink: "api",
    runId: "42",
    adapterMode: "2",
    delivered: "2",
    fallbackResults: "0",
  });
  assert.equal(result.sessions.length, 0);
  assert.deepEqual(result.warnings, []);
});
test("tests cut off by -t or test.only are not reported as skipped", async (t) => {
  const source = `test('alpha',()=>{});test('beta',()=>{});test.skip('gamma',()=>{});test.todo('delta');`;
  const filtered = await run(t, { "f.test.cjs": source }, {}, {}, ["-t", "alpha$"]);
  assert.deepEqual(
    filtered.results.map((r) => `${r.name}=${r.status}`),
    ["alpha=passed"],
  );
  const focused = await run(t, {
    "o.test.cjs": `test.only('alpha',()=>{});test('beta',()=>{});test.skip('gamma',()=>{});`,
  });
  assert.deepEqual(
    focused.results.map((r) => `${r.name}=${r.status}`),
    ["alpha=passed"],
  );
  const plain = await run(t, { "p.test.cjs": source });
  assert.deepEqual(
    plain.results.map((r) => `${r.name}=${r.status}`).sort(),
    ["alpha=passed", "beta=passed", "delta=skipped", "gamma=skipped"],
  );
});
test("selective mode never executes excluded callbacks or beforeEach", async (t) => {
  const fake = await server(t, [{ externalId: "YES" }]);
  const result = await run(
    t,
    {
      "select.test.cjs":
        api +
        `
    let hooks=0;beforeEach(()=>hooks++);afterAll(()=>expect(hooks).toBe(1));
    doqa.test('selected',{id:'YES'},()=>{});
    doqa.test('excluded',{id:'NO'},()=>{throw new Error('should not execute')});
  `,
    },
    { ...fake.options, testRunId: 42, adapterMode: 0 },
  );
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(
    fake.sent().map((r) => r.external_id),
    ["YES"],
  );
  assert.equal(result.marker.adapterMode, "0");
});
test("the location selects only tests whose id may still appear at execution time", async (t) => {
  const at = (runnerMethod, externalId) => ({
    externalId,
    namespace: "place",
    classname: "suite",
    runnerMethod,
  });
  const fake = await server(t, [at("runtime", "RUNTIME"), at("moved", "OLD-ID"), at("static", "ELSEWHERE")]);
  const result = await run(
    t,
    {
      "place.test.cjs":
        api +
        `describe('suite',()=>{
          test('runtime',()=>{doqa.metadata({id:'RUNTIME'})});
          test('moved',()=>{console.log('MOVED-RAN')});
          doqa.test('static',{id:'STATIC'},()=>{throw new Error('must not execute')});
        });`,
    },
    { ...fake.options, testRunId: 42, adapterMode: 0 },
  );
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(
    fake.sent().map((r) => r.external_id),
    ["RUNTIME"],
  );
  assert.match(result.output, /MOVED-RAN/);
  assert.match(
    result.output,
    /1 tests ran because their location matched the run, but their id is not part of it.*suite moved/,
  );
});
test("valid empty plan executes no tests", async (t) => {
  const fake = await server(t, []);
  const result = await run(
    t,
    {
      "empty.test.cjs":
        api +
        `beforeAll(()=>{throw new Error('suite must not execute')});doqa.test('x',{id:'X'},()=>{throw new Error('must not execute')});`,
    },
    { ...fake.options, testRunId: 42, adapterMode: 0 },
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(fake.sent().length, 0);
});
test("a selection that matches nothing is called out", async (t) => {
  const fake = await server(t, [{ externalId: "UNKNOWN" }]);
  const result = await run(
    t,
    { "miss.test.cjs": `test('x',()=>{throw new Error('must not execute')});` },
    { ...fake.options, testRunId: 42, adapterMode: 0 },
  );
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /selects 1 autotests, but none of them matched/);
});
test("an unreachable DoQA turns the run into a file session", async (t) => {
  const result = await run(
    t,
    { "offline.test.cjs": api + `doqa.test('x',{id:'X'},()=>{});` },
    {
      reporting: "api",
      url: "http://127.0.0.1:1",
      token: "SECRET-NOT-LOGGED",
      spaceId: 1,
      requestTimeoutMs: 1000,
    },
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(result.results.length, 1);
  assert.match(result.output, /could not establish the test run \(POST http:\/\/127\.0\.0\.1:1\/api\/autotests\/test-runs -> no response/);
  assert.match(result.output, /DoQA did not answer at http:\/\/127\.0\.0\.1:1/);
  assert.ok(!result.output.includes("SECRET-NOT-LOGGED"));
  assert.equal(result.marker.sink, "files");
  assert.equal(result.marker.degradedFrom, "api");
  assert.match(result.marker.reason, /no response/);
});
test("a rejected token is explained and the results stay on disk", async (t) => {
  const fake = await server(t, [], fail("/test-runs", 401));
  const result = await run(t, { "auth.test.cjs": `test('x',()=>{});` }, fake.options);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.results.length, 1);
  assert.match(result.output, /-> 401: \{"message":"rejected by the test server"\}/);
  assert.match(result.output, /DoQA rejected the token \(401\)/);
  assert.ok(!result.output.includes("test-secret"));
});
test("an unavailable selection runs everything into files, not into the run", async (t) => {
  const fake = await server(t, [], fail("/autotests", 403));
  const result = await run(
    t,
    { "fallback.test.cjs": `test('[DOQA:17] title',()=>{});test('other',()=>{});` },
    { ...fake.options, testRunId: 42, adapterMode: 0 },
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(fake.sent().length, 0);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.some((r) => r.testCaseId === "DOQA-17"));
  assert.match(result.output, /re-issue the CI variables/);
  assert.match(result.output, /selection could not be fetched, so every discovered test runs/);
});
test("a rejected chunk is spilled to files while the next ones still reach DoQA", async (t) => {
  const fake = await server(t, [], fail("/results", 500, 1));
  const result = await run(
    t,
    { "three.test.cjs": `test('one',()=>{});test('two',()=>{});test('three',()=>{});` },
    { ...fake.options, batchSize: 1 },
  );
  assert.equal(result.code, 0, result.output);
  const chunks = fake.chunks();
  assert.deepEqual(
    chunks.map((c) => [c.chunk_index, c.is_final_chunk]),
    [
      [0, false],
      [0, false],
      [1, true],
    ],
  );
  assert.deepEqual(
    result.results.map((r) => r.name),
    ["one"],
  );
  assert.equal(result.marker.delivered, "2");
  assert.equal(result.marker.fallbackResults, "1");
  assert.match(result.output, /results chunk failed \(POST .*\/results -> 500/);
  assert.match(result.output, /recovery files are kept in/);
  assert.equal(result.sessions.length, 1);
});
test("a failing last chunk is followed by an empty final one", async (t) => {
  let seen = 0;
  const fake = await server(t, [], (url, json, _req, res) => {
    if (!url.pathname.endsWith("/results") || !json.results.length || ++seen !== 2) return false;
    res.statusCode = 500;
    res.end("{}");
    return true;
  });
  const result = await run(
    t,
    { "two.test.cjs": `test('one',()=>{});test('two',()=>{});` },
    { ...fake.options, batchSize: 1 },
  );
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(
    fake.chunks().map((c) => [c.chunk_index, c.is_final_chunk, c.results.length]),
    [
      [0, false, 1],
      [1, true, 1],
      [1, true, 0],
    ],
  );
});
test("a lost answer never leaves a gap in the chunk range", async (t) => {
  let seen = 0;
  const fake = await server(t, [], (url, json, req, res) => {
    if (!url.pathname.endsWith("/results")) return false;
    seen++;
    if (seen === 1) return req.socket.destroy(), true;
    if (seen === 2)
      return res.end(JSON.stringify({ accepted: 0, skipped: json.results.map(() => ({ reason: "replay" })) })), true;
    return false;
  });
  const result = await run(
    t,
    { "three.test.cjs": `test('one',()=>{});test('two',()=>{});test('three',()=>{});` },
    { ...fake.options, batchSize: 1 },
  );
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(
    fake.chunks().map((c) => [c.chunk_index, c.is_final_chunk, c.results[0].name]),
    [
      [0, false, "one"],
      [0, false, "two"],
      [1, true, "three"],
    ],
  );
  assert.deepEqual(result.results.map((r) => r.name).sort(), ["one", "two"]);
  assert.match(result.output, /DoQA had already recorded chunk 0/);
  assert.deepEqual([result.marker.delivered, result.marker.fallbackResults], ["1", "2"]);
});
test("a delivery that cannot be closed is called out", async (t) => {
  const fake = await server(t, [], fail("/results", 422));
  const result = await run(t, { "none.test.cjs": `test.only('x',()=>{});` }, fake.options, {}, ["-t", "nothing"]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /the delivery could not be closed \(POST .*-> 422/);
  assert.equal(fake.chunks().length, 1);
});
test("a lost attachment or a failed upsert never costs the results", async (t) => {
  const fake = await server(t, [], (url, _json, _req, res) => {
    if (!url.pathname.endsWith("/attachments") && !url.pathname.endsWith("/upsert")) return false;
    res.statusCode = url.pathname.endsWith("/upsert") ? 500 : 413;
    res.end("{}");
    return true;
  });
  const result = await run(
    t,
    {
      "att.test.cjs":
        api + `test('with',()=>{doqa.attach('a.txt','x')});test('plain',()=>{});`,
    },
    fake.options,
  );
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(
    fake.sent().map((r) => [r.name, r.attachments.length]).sort(),
    [
      ["plain", 0],
      ["with", 0],
    ],
  );
  assert.match(result.output, /attachment upload failed .*-> 413/);
  assert.match(result.output, /autotest definitions were not updated .*-> 500/);
  assert.equal(result.marker.delivered, "2");
});
test("a broken configuration never stops Jest", async (t) => {
  const fake = await server(t);
  const noRun = await run(
    t,
    { "a.test.cjs": `test('x',()=>{});` },
    { ...fake.options, adapterMode: "selective" },
  );
  assert.equal(noRun.code, 0, noRun.output);
  assert.equal(noRun.results.length, 1);
  assert.match(noRun.output, /adapterMode=0 requires testRunId/);
  const noToken = await run(
    t,
    { "b.test.cjs": `test('x',()=>{});` },
    { reporting: "api", url: "http://127.0.0.1:1", batchSize: "many", certValidation: "maybe" },
    {},
    [],
    { DOQA_TOKEN: "$DOQA_TOKEN", DOQA_SPACE_ID: "1" },
  );
  assert.equal(noToken.code, 0, noToken.output);
  assert.equal(noToken.files.length, 0);
  assert.match(noToken.output, /token is set to the unexpanded variable reference "\$DOQA_TOKEN"/);
  assert.match(noToken.output, /reporting=api, but the configuration is incomplete \(missing token\)/);
  assert.match(noToken.output, /batchSize="many" is not a valid number/);
  const unconfigured = await run(t, { "c.test.cjs": `test('x',()=>{});` }, { reporting: "auto" });
  assert.equal(unconfigured.code, 0, unconfigured.output);
  assert.equal(unconfigured.results.length, 1);
  assert.match(unconfigured.output, /no reporting configuration found \(missing url, token, spaceId\)/);
});
test("adapterMode=2 ignores a configured testRunId and says so", async (t) => {
  const fake = await server(t);
  const result = await run(
    t,
    { "new.test.cjs": `test('x',()=>{});` },
    { ...fake.options, adapterMode: 2, testRunId: 55 },
  );
  assert.equal(fake.runs().length, 1);
  assert.deepEqual(
    fake.chunks().map((c) => c.test_run_id),
    [42],
  );
  assert.match(result.output, /adapterMode=2 creates a NEW run - the configured testRunId 55 is ignored/);
});
test("assertions fail, anything else breaks; messages carry no ANSI codes", async (t) => {
  const result = await run(
    t,
    {
      "status.test.cjs":
        api +
        `const assert=require('node:assert');
      test('expect',()=>{expect({a:1}).toEqual({a:2})});
      test('node assert',()=>{assert.strictEqual(1,2)});
      test('type error',()=>{null.x});
      test('timeout',async()=>{await new Promise(r=>setTimeout(r,200))},20);
      test('step',async()=>{await doqa.step('broken step',()=>{throw new RangeError('boom')})});`,
    },
    {},
    {},
    [],
    { FORCE_COLOR: "1" },
  );
  const by = Object.fromEntries(result.results.map((r) => [r.name, r]));
  assert.equal(by.expect.status, "failed");
  assert.equal(by["node assert"].status, "failed");
  assert.equal(by["type error"].status, "broken");
  assert.equal(by.timeout.status, "broken");
  assert.equal(by.step.status, "broken");
  assert.equal(by.step.steps[0].status, "broken");
  for (const r of result.results) {
    assert.ok(!/\u001b\[/.test(JSON.stringify(r.statusDetails)), r.name);
    assert.ok(!r.statusDetails.message.includes("[object Object]"), r.name);
  }
  assert.match(by["type error"].statusDetails.message, /^TypeError: Cannot read properties of null/);
  assert.ok(!by["type error"].statusDetails.message.endsWith("\nError"));
});
test("definitions respect the DoQA contract", async (t) => {
  const fake = await server(t);
  const long = "x".repeat(300);
  const result = await run(
    t,
    {
      "contract.test.cjs":
        api +
        `describe(${JSON.stringify(long)},()=>{test(${JSON.stringify(long)},()=>{})});
      beforeEach(()=>{});
      doqa.test('plain',()=>{});
      doqa.test.each([[1],[2]])('row %i',{id:'ROWS',labels:{owner:'core'},tags:['smoke'],
        links:[{url:'https://example.org/1',type:'defect'},{url:'https://example.org/2',type:'bogus'}]},
        async()=>{await doqa.step('open',()=>{})});`,
    },
    fake.options,
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(fake.sent().length, 4);
  const definitions = fake.definitions();
  assert.equal(definitions.length, 3, "rows of one each share a single definition");
  for (const d of definitions)
    for (const key of ["external_id", "name", "namespace", "classname", "runner_name", "runner_method"])
      assert.ok((d[key] ?? "").length <= 255, key);
  const plain = definitions.find((d) => d.name === "plain");
  assert.ok(!("labels" in plain) && !("tags" in plain) && !("links" in plain));
  assert.equal(plain.namespace, "contract");
  const rows = definitions.find((d) => d.external_id === "ROWS");
  assert.deepEqual(rows.labels, ["owner:core"]);
  assert.deepEqual(rows.tags, ["smoke"]);
  assert.deepEqual(rows.links, [
    { url: "https://example.org/1", type: "defect" },
    { url: "https://example.org/2" },
  ]);
  assert.deepEqual(
    rows.steps.map((s) => [s.kind, s.title]),
    [
      ["before", "beforeEach"],
      ["step", "open"],
    ],
  );
  assert.match(result.output, /unknown link type "bogus"/);
});
test("result files follow the reference layout", async (t) => {
  const result = await run(t, {
    "src.v2.test.cjs":
      api +
      `doqa.test('files',{id:'1041',labels:{owner:'core'},tags:['smoke']},()=>{
        doqa.attach('shot.png',new Uint8Array([1,2,3]));doqa.attach('note','text');
      });`,
  });
  assert.equal(result.code, 0, result.output);
  const [file] = result.results;
  assert.deepEqual(labelsOf(file, "AS_ID"), []);
  assert.deepEqual(labelsOf(file, "doqa_id"), ["1041"]);
  assert.deepEqual(labelsOf(file, "package"), ["src_v2"]);
  assert.deepEqual(labelsOf(file, "doqa_runner_method"), ["files"]);
  assert.deepEqual(labelsOf(file, "tag").sort(), ["owner:core", "smoke"]);
  assert.deepEqual(labelsOf(file, "owner"), []);
  assert.equal(file.fullName, "src_v2#files");
  assert.deepEqual(
    file.attachments.map((a) => [a.name, path.extname(a.source), a.type]),
    [
      ["shot.png", ".png", "image/png"],
      ["note", ".txt", "text/plain"],
    ],
  );
  assert.equal(result.containers.length, 0, "no fixtures - no container");
});
test("file results respect the same limits and link rules as the API", async (t) => {
  const long = "x".repeat(300);
  const result = await run(t, {
    "limits.test.cjs":
      api +
      `describe(${JSON.stringify(long)},()=>{doqa.test(${JSON.stringify(long)},{id:${JSON.stringify(long)},
        links:[{url:'https://example.org/1',type:'bogus'}]},()=>{})});`,
    "twin.test.cjs": api + `doqa.test('twin',{id:'TWIN'},()=>{});`,
    "twin2.test.cjs": api + `doqa.test('another twin',{id:'TWIN'},()=>{});`,
  });
  assert.equal(result.code, 0, result.output);
  const file = result.results.find((r) => r.name.startsWith("x"));
  assert.equal(file.name.length, 255);
  assert.equal(file.testCaseId.length, 255);
  assert.ok(file.labels.every((l) => l.value.length <= 255));
  assert.deepEqual(file.links, [{ url: "https://example.org/1" }]);
  assert.match(result.output, /unknown link type "bogus"/);
  assert.match(result.output, /several tests share one id.*TWIN/);
  const mode = fs.statSync(path.join(result.dir, "results", result.files.find((f) => f.endsWith("-result.json")))).mode;
  assert.equal(mode & 0o777, 0o666 & ~process.umask());
});
test("the runner's own beforeEach is not a fixture, even without stack traces", async (t) => {
  const result = await run(
    t,
    {
      "nostack.cjs": `Error.stackTraceLimit = 0;`,
      "plain.test.cjs": `test('plain',()=>{});`,
      "hooked.test.cjs": `beforeEach(()=>{});test('hooked',()=>{});`,
    },
    {},
    { setupFiles: ["<rootDir>/nostack.cjs"] },
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(result.containers.length, 1);
  assert.deepEqual(
    result.containers[0].befores.map((s) => s.name),
    ["beforeEach"],
  );
});
test("the fallback id is a frozen public contract", async (t) => {
  const result = await run(
    t,
    {
      "golden.test.cjs":
        api +
        `test('plain',()=>{});
      describe('Корзина',()=>{describe('скидка',()=>{doqa.test.each([['A']])('применяется %s',()=>{})})});`,
    },
    {},
    {},
    [],
    { DOQA_PROJECT_ID: "17" },
  );
  const id = (name) => result.results.find((r) => r.name === name).testCaseId;
  assert.equal(id("plain"), "jest:bd0d7afb5f62352f91da876fa3885a020af2be22");
  const named = await run(
    t,
    {
      "golden.test.cjs":
        api +
        `describe('Корзина',()=>{describe('скидка',()=>{doqa.test.each([['A']])('применяется %s',()=>{})})});`,
    },
    { projectName: "web" },
  );
  assert.equal(
    named.results[0].testCaseId,
    "jest:f90a14eb00979453cf653bdf4b3fba230559a5d8",
  );
});
test("metadata accumulates and ids that collide are called out", async (t) => {
  const result = await run(t, {
    "meta.test.cjs":
      api +
      `doqa.test('meta',{id:'META',tags:['a'],createManualCase:true},()=>{
        doqa.metadata({tags:['b'],labels:['plain']});
        doqa.metadata({tags:['a','c'],labels:{k:'v'},createManualCase:false});
      });
      test('same',()=>{});test('same',()=>{});
      doqa.metadata({title:'outside of a test'});`,
  });
  assert.equal(result.code, 0, result.output);
  const meta = result.results.find((r) => r.testCaseId === "META");
  assert.deepEqual(labelsOf(meta, "tag").sort(), ["a", "b", "c", "k:v", "plain"]);
  assert.deepEqual(labelsOf(meta, "doqa_create_manual_case"), ["true"]);
  assert.match(result.output, /several tests share one id/);
  assert.ok(!result.output.includes("outside"));
});
test("ESM test imports typed package exports", async (t) => {
  const result = await run(t, {
    "esm.test.mjs": `import {doqa} from ${JSON.stringify(root + "/src/index.mjs")};doqa.test('esm',{id:'ESM'},()=>doqa.step('once',()=>{}));`,
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.results[0].steps.length, 1);
});
test("jsdom environment keeps browser APIs", async (t) => {
  const result = await run(
    t,
    {
      "dom.test.cjs":
        api +
        `doqa.test('dom',{id:'DOM'},()=>expect(document.createElement('p').tagName).toBe('P'));`,
    },
    {},
    { testEnvironment: "jsdom" },
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(result.results.length, 1);
});
test("strict plan order within suite and across files", async (t) => {
  const fake = await server(t, [
    { externalId: "Z", namespace: "second" },
    { externalId: "B", namespace: "first" },
    { externalId: "A", namespace: "first" },
  ]);
  const result = await run(
    t,
    {
      "first.test.cjs":
        api +
        `const seen=[];doqa.test('A',{id:'A'},()=>{seen.push('A')});doqa.test('B',{id:'B'},()=>{seen.push('B')});afterAll(()=>expect(seen).toEqual(['B','A']));`,
      "second.test.cjs": api + `doqa.test('Z',{id:'Z'},()=>{});`,
    },
    { ...fake.options, testRunId: 42, adapterMode: 0, executionOrder: "plan" },
  );
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(
    fake.sent().map((r) => r.external_id),
    ["Z", "B", "A"],
  );
  assert.deepEqual(result.warnings, []);
});
test("hook errors and file load failures produce broken results", async (t) => {
  const result = await run(t, {
    "hook.test.cjs":
      api +
      `beforeEach(()=>{throw new Error('setup failed')});doqa.test('hook',{id:'HOOK'},()=>{});`,
    "load.test.cjs": `throw new Error('load failed');`,
  });
  assert.equal(result.code, 1, result.output);
  assert.equal(result.results.length, 2, result.output);
  assert.ok(result.results.every((r) => r.status === "broken"));
});
test("a file that cannot be loaded adds nothing to an existing run", async (t) => {
  const fake = await server(t);
  const result = await run(
    t,
    { "load.test.cjs": `throw new Error('load failed');`, "ok.test.cjs": `test('ok',()=>{});` },
    { ...fake.options, testRunId: 42 },
  );
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(
    fake.sent().map((r) => r.name),
    ["ok"],
  );
  assert.match(result.output, /load\.test\.cjs could not be loaded - its tests are not reported/);
});
test("off has no reporting and does not duplicate step callbacks", async (t) => {
  const result = await run(
    t,
    {
      "off.test.cjs":
        api +
        `test('off',()=>{let n=0;doqa.step('once',()=>{n++});expect(n).toBe(1)});`,
    },
    { reporting: "off" },
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(result.files.length, 0);
  assert.equal(result.sessions.length, 0);
});

test("TypeScript transforms are preserved", async (t) => {
  const result = await run(
    t,
    {
      "typed.test.cjs":
        api +
        `const value: number = 7;doqa.test('typed',{id:'TS'},()=>expect(value).toBe(7));`,
      "transform.cjs": `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports={process(source){return {code:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText};}};`,
    },
    {},
    { transform: { "^.+\\.test\\.cjs$": "<rootDir>/transform.cjs" } },
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(result.results[0].testCaseId, "TS");
});
test("a plan order that cannot be followed falls back to the Jest order", async (t) => {
  const fake = await server(
    t,
    ["A", "B", "C"].map((externalId) => ({
      externalId,
      namespace: "order",
    })),
  );
  const result = await run(
    t,
    {
      "order.test.cjs":
        api +
        `describe('one',()=>{doqa.test('A',{id:'A'},()=>{});doqa.test('C',{id:'C'},()=>{});});describe('two',()=>{doqa.test('B',{id:'B'},()=>{});});`,
    },
    { ...fake.options, testRunId: 42, adapterMode: 0, executionOrder: "plan" },
  );
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(
    fake.sent().map((r) => r.external_id),
    ["A", "C", "B"],
  );
  assert.match(result.output, /the plan order cannot be applied to order\.test\.cjs/);
});
test("ordinary callback-style Jest tests retain done semantics", async (t) => {
  const result = await run(t, {
    "done.test.cjs": `test('callback',done=>{setTimeout(done,5)});`,
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.results[0].status, "passed");
});

test("multiple Jest projects share a run and separate fallback identities", async (t) => {
  const fake = await server(t);
  const result = await run(
    t,
    {
      "one.test.cjs": "test('same name',()=>{});",
      "two.test.cjs": "test('same name',()=>{});",
    },
    fake.options,
    {
      projects: [
        { displayName: "one", testMatch: ["**/one.test.cjs"] },
        { displayName: "two", testMatch: ["**/two.test.cjs"] },
      ],
    },
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(fake.sent().length, 2, result.output);
  assert.equal(new Set(fake.sent().map((r) => r.external_id)).size, 2);
  assert.equal(fake.runs().length, 1);
});
test("the token given to withDoqa stays out of the Jest configuration", async (t) => {
  const fake = await server(t);
  const result = await run(
    t,
    { "leak.test.cjs": `test('x',()=>{});` },
    fake.options,
    {},
    ["--debug"],
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(fake.sent().length, 1);
  assert.ok(!result.output.includes("test-secret"));
});

test("custom environment keeps its event handler", async (t) => {
  const result = await run(
    t,
    {
      "custom.cjs": `const {TestEnvironment}=require(${JSON.stringify(require.resolve("jest-environment-node"))});const {wrapEnvironment}=require(${JSON.stringify(root + "/src")});class Custom extends TestEnvironment {async setup(){await super.setup();this.global.customEvents=0;} handleTestEvent(e){if(e.name==='test_start')this.global.customEvents++;}}module.exports=wrapEnvironment(Custom);`,
      "custom.test.cjs":
        api +
        `doqa.test('custom',{id:'CUSTOM'},()=>expect(customEvents).toBe(1));`,
    },
    {},
    { testEnvironment: "<rootDir>/custom.cjs" },
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(result.results.length, 1);
});
