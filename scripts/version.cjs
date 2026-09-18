const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const version = process.argv[2];
assert.match(
  version || "",
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  "Provide an explicit version, e.g. 0.1.1",
);
const root = path.resolve(__dirname, "..");
const pkg = require("../package.json");
const lock = require("../package-lock.json");
const write = (file, value) =>
  fs.writeFileSync(
    path.join(root, file),
    JSON.stringify(value, null, 2) + "\n",
  );
pkg.version = lock.version = lock.packages[""].version = version;
write("package.json", pkg);
write("package-lock.json", lock);
require("./check-version.cjs");
