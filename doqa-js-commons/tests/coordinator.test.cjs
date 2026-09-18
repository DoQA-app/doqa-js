const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { Runtime, atomic } = require("../../dist/doqa-js-commons/src");
const { Coordinator } = require("../../dist/doqa-js-commons/src/coordinator");

test("shared runtime and coordinator report a non-Jest framework without Jest globals", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doqa-commons-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionDir = path.join(directory, "session");
  const resultsDir = path.join(directory, "results");
  const coordinator = new Coordinator(
    { reporting: "files", adapterMode: 2, sessionDir, resultsDir },
    {
      name: "example-runner",
      language: "javascript",
      displayName: "Example runner",
    },
  );
  const now = Date.now();
  const record = {
    uuid: randomUUID(),
    external_id: "COMMONS",
    name: "Standalone core",
    namespace: "example",
    classname: "",
    runner_method: "check",
    metadata: {},
    parameters: [],
    outcome: "passed",
    started_on: now,
    completed_on: now,
    duration_ms: 0,
    step_results: [],
    setup_results: [],
    teardown_results: [],
    attachments: [],
  };
  await coordinator.start();
  const runtime = new Runtime(sessionDir);
  await runtime.context.run({ result: record }, () =>
    runtime.step("generic step", async () => {
      runtime.attach("proof.txt", "framework-independent");
    }),
  );
  atomic(path.join(sessionDir, `${record.uuid}.record.json`), record);
  await coordinator.complete();
  const report = JSON.parse(
    fs.readFileSync(path.join(resultsDir, `${record.uuid}-result.json`)),
  );
  assert.equal(report.status, "passed");
  assert.equal(
    report.labels.find((label) => label.name === "framework").value,
    "example-runner",
  );
  assert.equal(report.steps[0].name, "generic step");
  assert.equal(
    fs.readFileSync(
      path.join(resultsDir, report.steps[0].attachments[0].source),
      "utf8",
    ),
    "framework-independent",
  );
});

test("a process that ends before the run completes still leaves the result files", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doqa-exit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = `
    const path = require("node:path");
    const { atomic } = require(${JSON.stringify(path.resolve(__dirname, "../../dist/doqa-js-commons/src"))});
    const { Coordinator } = require(${JSON.stringify(path.resolve(__dirname, "../../dist/doqa-js-commons/src/coordinator"))});
    const sessionDir = path.join(${JSON.stringify(directory)}, "session");
    const coordinator = new Coordinator(
      { reporting: "files", sessionDir, resultsDir: path.join(${JSON.stringify(directory)}, "results") },
      { name: "example-runner", language: "javascript", displayName: "Example runner" },
    );
    coordinator.start().then(() => {
      const now = Date.now();
      atomic(path.join(sessionDir, "1.record.json"), {
        uuid: "lost", external_id: "LOST", name: "lost", namespace: "example", classname: "", runner_method: "lost",
        metadata: {}, parameters: [], outcome: "passed", started_on: now, completed_on: now, duration_ms: 0,
        step_results: [], setup_results: [], teardown_results: [], attachments: [],
      });
      process.exit(3);
    });
  `;
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(child.status, 3, child.stderr);
  const results = path.join(directory, "results");
  assert.ok(fs.existsSync(path.join(results, "lost-result.json")));
  assert.match(fs.readFileSync(path.join(results, "doqa-reporting.properties"), "utf8"), /^sink=files$/m);
});
