const fs = require("node:fs");
const path = require("node:path");
for (const folder of ["doqa-client", "doqa-js-commons", "doqa-jest"]) {
  const directory = path.resolve(__dirname, "../dist", folder, "src");
  const names = Object.keys(require(path.join(directory, "index.js")));
  fs.writeFileSync(path.join(directory, "index.mjs"), `import api from './index.js';\nexport const {${names.join(", ")}} = api;\n`);
}
