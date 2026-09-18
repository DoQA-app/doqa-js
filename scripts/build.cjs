const { rmSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
rmSync(path.join(root, "dist"), { recursive: true, force: true });
const result = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc")], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
require("./esm.cjs");
