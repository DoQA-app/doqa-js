import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config, Options } from "./types";
import { reason } from "./storage";

const numbers = {
  batchSize: 100,
  requestTimeoutMs: 30000,
  retries: 3,
  retryBackoffMs: 500,
  maxTraceLength: 100000,
  maxMessageLength: 10000,
  maxParameterLength: 2000,
};
const fields = [
  "url",
  "token",
  "spaceId",
  "configurationId",
  "testRunId",
  "testRunName",
  "adapterMode",
  "reporting",
  "resultsDir",
  "ciRunId",
  "pipelineId",
  "branch",
  "environment",
  "importRealtime",
  "executionOrder",
  "projectName",
  "proxy",
  "certValidation",
  ...Object.keys(numbers),
];
const canonical = new Map<string, string>([
  ...fields.map((field): [string, string] => [field.toLowerCase(), field]),
  ["privatetoken", "token"],
  ["projectid", "spaceId"],
]);
const envAliases: [string, string][] = [
  ["DOQA_PRIVATE_TOKEN", "token"],
  ["DOQA_PROJECT_ID", "spaceId"],
  ["CI_PIPELINE_ID", "pipelineId"],
  ["GITHUB_RUN_ID", "pipelineId"],
  ["CI_COMMIT_REF_NAME", "branch"],
  ["GITHUB_REF_NAME", "branch"],
];
const modes: Record<string, 0 | 1 | 2> = {
  "0": 0,
  selective: 0,
  "1": 1,
  existing: 1,
  existingrun: 1,
  "2": 2,
  new: 2,
  newrun: 2,
};
const unexpanded = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;
const hint =
  "Configure them via the DOQA_URL / DOQA_TOKEN / DOQA_SPACE_ID environment variables, " +
  "a doqa.properties file or the adapter options.";

function squash(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
}
function envName(field: string): string {
  return "DOQA_" + field.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase();
}
function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").toLowerCase();
  if (["1", "true", "yes", "on", "y"].includes(text)) return true;
  if (["0", "false", "no", "off", "n"].includes(text)) return false;
  return fallback;
}

/** Never throws: a broken setting is reported through `onWarning` and falls back. */
export function resolveConfig(
  options: Options = {},
  onWarning: (message: string) => void = () => {},
): Config {
  const values: Record<string, unknown> = {};
  const put = (field: string, value: unknown, source: string): void => {
    if (value === undefined || value === null) return;
    if (typeof value === "string") {
      value = value.trim();
      if (value === "") return;
      if (unexpanded.test(value as string)) {
        onWarning(
          `${field} is set to the unexpanded variable reference "${value}" (${source}) - treating it as unset. ` +
            "Check that the CI variable exists and is exported to this job.",
        );
        return;
      }
    }
    values[field] = value;
  };

  const explicitPath = options.config ?? process.env.DOQA_CONFIG;
  const path = explicitPath ?? "doqa.properties";
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([^#!\s=:][^\s=:]*)\s*[=:]\s*(.*)$/);
      const field = match && canonical.get(squash(match[1]));
      if (match && field) put(field, match[2], path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || explicitPath)
      onWarning(`cannot read the configuration file '${path}' (${reason(error)})`);
  }
  const env: Record<string, unknown> = {};
  for (const field of fields) env[field] = process.env[envName(field)] || undefined;
  for (const [name, field] of envAliases) env[field] ??= process.env[name] || undefined;
  for (const field of fields) put(field, env[field], "environment");
  for (const [name, value] of Object.entries(options)) {
    const field = canonical.get(squash(name));
    if (field) put(field, value, "options");
  }

  for (const [field, fallback] of Object.entries(numbers)) {
    const number = Number(values[field] ?? fallback);
    const min = field === "retries" || field === "retryBackoffMs" ? 0 : 1;
    if (Number.isInteger(number) && number >= min) values[field] = number;
    else {
      onWarning(`${field}="${values[field]}" is not a valid number - using ${fallback}`);
      values[field] = fallback;
    }
  }

  for (const field of ["spaceId", "configurationId", "testRunId", "ciRunId"])
    if (values[field] !== undefined && !/^\d+$/.test(String(values[field]))) {
      onWarning(`${field}="${values[field]}" is not a number - treating it as unset`);
      delete values[field];
    }

  const explicitMode = values.adapterMode !== undefined;
  let mode = explicitMode ? modes[squash(String(values.adapterMode))] : undefined;
  if (explicitMode && mode === undefined)
    onWarning(`adapterMode="${values.adapterMode}" is unknown - using the default`);
  mode ??= values.testRunId !== undefined ? 1 : 2;
  if (mode === 2 && values.testRunId !== undefined) {
    onWarning(
      `adapterMode=2 creates a NEW run - the configured testRunId ${values.testRunId} is ignored ` +
        "(use adapterMode=1 to report into it)",
    );
    delete values.testRunId;
  }
  values.adapterMode = mode;

  let reporting = String(values.reporting ?? "auto").toLowerCase();
  if (!["auto", "api", "files", "off"].includes(reporting)) {
    onWarning(`reporting="${values.reporting}" is unknown - using auto`);
    reporting = "auto";
  }
  values.resultsDir = resolve(String(values.resultsDir ?? "results"));
  const missing = ["url", "token", "spaceId"].filter((k) => values[k] === undefined);
  if (reporting === "auto") {
    reporting = missing.length ? "files" : "api";
    if (missing.length)
      onWarning(
        `no reporting configuration found (missing ${missing.join(", ")}) - results are written as Allure files ` +
          `to '${values.resultsDir}' and are NOT sent to DoQA. ${hint} ` +
          "Set reporting=files to make the file output explicit and silence this warning.",
      );
  } else if (reporting === "api" && missing.length) {
    onWarning(
      `reporting=api, but the configuration is incomplete (missing ${missing.join(", ")}) - ` +
        `reporting is disabled. ${hint}`,
    );
    reporting = "off";
  }
  values.reporting = reporting;
  values.importRealtime = bool(values.importRealtime, false);
  values.certValidation = bool(values.certValidation, true);
  return values as unknown as Config;
}
