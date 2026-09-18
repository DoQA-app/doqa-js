const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveConfig } = require("../../dist/doqa-js-commons/src");

function withEnv(values, fn) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env))
    if (/^(DOQA_|CI_|GITHUB_)/.test(key)) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}
function resolve(options, env = {}) {
  const warnings = [];
  const config = withEnv(env, () => resolveConfig(options, (m) => warnings.push(m)));
  return { config, warnings };
}

test("a broken setting falls back with a warning instead of throwing", () => {
  const { config, warnings } = resolve({
    reporting: "sometimes",
    adapterMode: "partial",
    batchSize: 0,
    retries: "x",
    testRunId: 42,
  });
  assert.equal(config.reporting, "files");
  assert.equal(config.adapterMode, 1);
  assert.equal(config.batchSize, 100);
  assert.equal(config.retries, 3);
  assert.deepEqual(
    warnings.map((w) => w.split(/[= ]/)[0]),
    ["batchSize", "retries", "adapterMode", "reporting", "no"],
  );
});
test("ids that are not numbers count as unset", () => {
  const { config, warnings } = resolve({ reporting: "files", ciRunId: "abc", configurationId: "7", testRunId: "run-5" });
  assert.equal(config.ciRunId, undefined);
  assert.equal(config.configurationId, "7");
  assert.equal(config.adapterMode, 2);
  assert.equal(warnings.length, 2);
});
test("modes accept the symbolic names; an explicit new run drops testRunId", () => {
  assert.equal(resolve({ reporting: "files", adapterMode: "selective", testRunId: 1 }).config.adapterMode, 0);
  assert.equal(resolve({ reporting: "files", adapterMode: "existing-run", testRunId: 1 }).config.adapterMode, 1);
  assert.equal(resolve({ reporting: "files", testRunId: 1 }).config.adapterMode, 1);
  const fresh = resolve({ reporting: "files", adapterMode: "new", testRunId: 7 });
  assert.equal(fresh.config.adapterMode, 2);
  assert.equal(fresh.config.testRunId, undefined);
  assert.match(fresh.warnings[0], /creates a NEW run/);
});
test("options beat the environment, the environment beats the file; aliases belong to the environment layer", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doqa-config-"));
  const file = path.join(directory, "doqa.properties");
  fs.writeFileSync(
    file,
    "# comment\nurl = https://file.example \ntoken=file-token\nproject_id: 5\nTEST-RUN-NAME=from file\npipelineId=file-pipeline\n",
  );
  try {
    const fromFile = resolve({ config: file });
    assert.equal(fromFile.config.url, "https://file.example");
    assert.equal(fromFile.config.spaceId, "5");
    assert.equal(fromFile.config.testRunName, "from file");
    assert.equal(fromFile.config.reporting, "api");
    assert.deepEqual(fromFile.warnings, []);
    const layered = resolve(
      { config: file, url: "https://options.example", token: undefined },
      { DOQA_PRIVATE_TOKEN: "alias-token", DOQA_PROJECT_ID: "17", CI_PIPELINE_ID: "900" },
    );
    assert.equal(layered.config.url, "https://options.example");
    assert.equal(layered.config.token, "alias-token");
    assert.equal(layered.config.spaceId, "17");
    assert.equal(layered.config.pipelineId, "900");
    assert.equal(layered.config.projectName, undefined);
    assert.equal(resolve({ config: file }, { DOQA_TOKEN: "main", DOQA_PRIVATE_TOKEN: "alias" }).config.token, "main");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("unexpanded CI references and blanks count as unset", () => {
  const { config, warnings } = resolve(
    { url: "https://doqa.example", spaceId: 1 },
    { DOQA_TOKEN: "${DOQA_TOKEN}", DOQA_ENVIRONMENT: "   " },
  );
  assert.equal(config.token, undefined);
  assert.equal(config.environment, undefined);
  assert.equal(config.reporting, "files");
  assert.match(warnings[0], /unexpanded variable reference "\$\{DOQA_TOKEN\}"/);
  assert.match(warnings[1], /no reporting configuration found \(missing token\)/);
});
test("an explicit api without its settings is switched off, an explicit files stays quiet", () => {
  const api = resolve({ reporting: "api", url: "https://doqa.example" });
  assert.equal(api.config.reporting, "off");
  assert.match(api.warnings[0], /incomplete \(missing token, spaceId\)/);
  assert.deepEqual(resolve({ reporting: "files" }).warnings, []);
  assert.match(resolve({ config: "/nonexistent/doqa.properties", reporting: "files" }).warnings[0], /cannot read/);
});
test("booleans understand the usual spellings", () => {
  const { config } = resolve({ reporting: "files" }, { DOQA_CERT_VALIDATION: "0", DOQA_IMPORT_REALTIME: "yes" });
  assert.equal(config.certValidation, false);
  assert.equal(config.importRealtime, true);
});
