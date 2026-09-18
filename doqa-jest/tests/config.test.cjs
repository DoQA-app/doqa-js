const { test } = require("node:test");
const assert = require("node:assert/strict");

test("environment plan order also configures the Jest scheduler", () => {
  const { withDoqa } = require("../../dist/doqa-jest/src");
  const previous = process.env.DOQA_EXECUTION_ORDER;
  process.env.DOQA_EXECUTION_ORDER = "plan";
  try {
    const config = withDoqa({}, { reporting: "files" });
    assert.equal(config.maxWorkers, 1);
    assert.match(config.testSequencer, /sequencer\.js$/);
  } finally {
    if (previous === undefined) delete process.env.DOQA_EXECUTION_ORDER;
    else process.env.DOQA_EXECUTION_ORDER = previous;
  }
});

test("withDoqa and the reporter never throw on what they cannot report", () => {
  const { withDoqa } = require("../../dist/doqa-jest/src");
  const Reporter = require("../../dist/doqa-jest/src/reporter").default;
  const config = withDoqa(
    { injectGlobals: false, projects: ["<rootDir>/packages/a"], testSequencer: "./own.js" },
    { reporting: "files", adapterMode: "nonsense", executionOrder: "plan", token: "secret" },
  );
  assert.equal(config.testSequencer, "./own.js");
  assert.deepEqual(config.projects, ["<rootDir>/packages/a"]);
  assert.ok(!JSON.stringify(config).includes("secret"));
  const stderr = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => (stderr.push(String(chunk)), true);
  try {
    withDoqa({ injectGlobals: false }, { reporting: "files" });
  } finally {
    process.stderr.write = write;
  }
  assert.match(stderr.join(""), /doqa\.test needs the Jest globals/);
  const reporter = new Reporter({ watch: true }, config.reporters.at(-1)[1]);
  assert.equal(reporter.coordinator.config.reporting, "off");
});
