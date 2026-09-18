// Turns failed node:test cases into GitHub annotations, visible on the run summary.
const fs = require("node:fs");
const escape = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const log = fs.readFileSync(process.argv[2], "utf8");
const blocks = log.split(/^(?=not ok )/m).filter((block) => block.startsWith("not ok "));
if (!blocks.length) console.log(`::error title=Test run failed::${escape(log.slice(-3000))}`);
for (const block of blocks.slice(0, 10)) {
  const [head, ...lines] = block.split("\n");
  const end = lines.findIndex((line) => /^(ok |# )/.test(line));
  const body = (end < 0 ? lines : lines.slice(0, end))
    .filter((line) => !/duration_ms|^\s+(type|location|failureType):|^\s+(---|\.\.\.)$/.test(line))
    .slice(0, 40)
    .join("\n");
  const title = escape(head.replace(/^not ok \d+ - /, "")).replace(/,/g, "%2C").replace(/:/g, "%3A");
  console.log(`::error title=${title}::${escape(body)}`);
}
