const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const destination = path.join(root, "release-dist");
// This directory contains only generated release artifacts.
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
const result = spawnSync(
  process.execPath,
  [
    process.env.npm_execpath,
    "pack",
    "--pack-destination",
    destination,
  ],
  {
    cwd: root,
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
