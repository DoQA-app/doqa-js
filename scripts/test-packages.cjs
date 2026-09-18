// Install the actual archives outside the workspace: no local module links or source imports.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const pkg = require("../package.json");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doqa-js-packages-"));
const env = { ...process.env, NODE_OPTIONS: "--experimental-vm-modules" };
delete env.NODE_TEST_CONTEXT;
for (const key of Object.keys(env))
  if (key.startsWith("DOQA_")) delete env[key];
function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: directory,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Command failed: ${args[0]}`);
}
try {
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "doqa-js-package-check", private: true }),
  );
  const archive = path.join(root, "release-dist", `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
  const jestVersion = require("jest/package.json").version;
  run([
    process.env.npm_execpath,
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    archive,
    `jest@${jestVersion}`,
    `jest-environment-node@${jestVersion}`,
    `jest-environment-jsdom@${jestVersion}`,
    `@jest/test-sequencer@${jestVersion}`,
  ]);
  const location = path.join(directory, "node_modules", pkg.name);
  assert.equal(fs.lstatSync(location).isSymbolicLink(), false);
  const installed = JSON.parse(fs.readFileSync(path.join(location, "package.json")));
  assert.equal(installed.version, pkg.version);
  assert.deepEqual(Object.keys(installed.dependencies), ["undici"]);
  assert.ok(!installed.workspaces);
  fs.writeFileSync(path.join(directory, "types.cts"), `
    import { withDoqa, doqa } from '${pkg.name}';
    import { withDoqa as jestConfig } from '${pkg.name}/jest';
    import { Client } from '${pkg.name}/client';
    import { Runtime } from '${pkg.name}/commons';
    import { Coordinator } from '${pkg.name}/commons/coordinator';
    withDoqa({testEnvironment: 'node'}, {reporting: 'files'});
    void [doqa, jestConfig, Client, Runtime, Coordinator];
  `);
  run([require.resolve("typescript/bin/tsc"), "--noEmit", "--module", "Node16", "--target", "ES2022", "--skipLibCheck", "types.cts"]);
  fs.writeFileSync(
    path.join(directory, "jest.config.cjs"),
    `
    const {withDoqa}=require('${pkg.name}');
    module.exports=withDoqa({maxWorkers:2,projects:[
      {displayName:'node',testEnvironment:'node',testMatch:['<rootDir>/node.test.cjs','<rootDir>/esm.test.mjs']},
      {displayName:'browser',testEnvironment:'jsdom',testMatch:['<rootDir>/browser.test.cjs']}
    ]},{reporting:'files',resultsDir:'results'});
  `,
  );
  fs.writeFileSync(
    path.join(directory, "node.test.cjs"),
    `
    const {doqa}=require('${pkg.name}');
    doqa.test('archive CJS',{id:'PACKAGE-CJS'},()=>{
      doqa.step('nested',()=>doqa.attach('proof.txt','installed archives','text/plain'));
      expect(typeof require('${pkg.name}/client').Client).toBe('function');
      expect(typeof require('${pkg.name}/commons/coordinator').Coordinator).toBe('function');
    });
  `,
  );
  fs.writeFileSync(
    path.join(directory, "esm.test.mjs"),
    `
    import {doqa} from '${pkg.name}';
    import {Runtime} from '${pkg.name}/commons';
    import {Client} from '${pkg.name}/client';
    doqa.test('archive ESM',{id:'PACKAGE-ESM'},()=>{
      expect(typeof Runtime).toBe('function'); expect(typeof Client).toBe('function');
    });
  `,
  );
  fs.writeFileSync(
    path.join(directory, "browser.test.cjs"),
    `
    const {doqa}=require('${pkg.name}');
    doqa.test('archive jsdom',{id:'PACKAGE-JSDOM'},()=>{
      document.body.innerHTML='<button>OK</button>';
      expect(document.querySelector('button').textContent).toBe('OK');
    });
  `,
  );
  run([
    path.join(directory, "node_modules/jest/bin/jest.js"),
    "--config",
    "jest.config.cjs",
  ]);
  const resultsDir = path.join(directory, "results");
  const results = fs
    .readdirSync(resultsDir)
    .filter((name) => name.endsWith("-result.json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(resultsDir, name))));
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.status === "passed"));
  const attachment = results.find(
    (result) => result.testCaseId === "PACKAGE-CJS",
  ).steps[0].attachments[0];
  assert.equal(
    fs.readFileSync(path.join(resultsDir, attachment.source), "utf8"),
    "installed archives",
  );
  console.log(
    `Single ${pkg.name} archive verified: CJS, ESM, jsdom and attachment contents.`,
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
