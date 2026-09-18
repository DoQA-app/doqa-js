import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client, ApiError } from "../../doqa-client/src/index";
import type { Config, Session, PlanItem, FrameworkInfo } from "./types";
import { atomic, clip, reason } from "./storage";

const file = "session.json";

/** Workers only read what the main process has established. */
export function loadSession(dir: string): Session | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, file), "utf8")) as Session;
  } catch {
    return undefined;
  }
}

function statusHint(error: unknown, config: Config): string {
  if (!(error instanceof ApiError)) return "";
  if (error.status === 0) return ` DoQA did not answer at ${config.url}.`;
  if (error.status === 401)
    return " DoQA rejected the token (401): check the token / DOQA_TOKEN.";
  if (error.status === 403)
    return (
      " The token is not allowed for this space or CI binding (403): " +
      "re-issue the CI variables from the DoQA CI/CD settings."
    );
  return error.status >= 500
    ? ` DoQA answered ${error.status} - the server is unhealthy.`
    : "";
}

async function loadPlan(client: Client, config: Config): Promise<PlanItem[]> {
  const result = await client.request(
    `test-runs/${config.testRunId}/autotests`,
    { configuration_id: config.configurationId, ciRunId: config.ciRunId },
    "GET",
  );
  if (!Array.isArray(result.autotests))
    throw new Error("the run's selection has no autotests list");
  const text = (value: unknown) =>
    typeof value === "string" && value !== "" ? value : undefined;
  return result.autotests.flatMap((entry: Record<string, unknown>) => {
    const externalId = text(entry.externalId ?? entry.external_id);
    return externalId
      ? [
          {
            externalId,
            namespace: text(entry.namespace),
            classname: text(entry.classname),
            runnerMethod: text(entry.runnerMethod ?? entry.runner_method),
          },
        ]
      : [];
  });
}

/**
 * Main-process only. A failing DoQA never costs the results: whatever goes wrong here turns
 * the session into a file session.
 */
export async function establishSession(
  dir: string,
  config: Config,
  framework: FrameworkInfo,
  onWarning: (message: string) => void,
  sharedClient?: Client,
): Promise<Session> {
  const existing = loadSession(dir);
  if (existing) return existing;
  const session: Session = { reportId: randomUUID(), sink: config.reporting };
  if (config.reporting === "api") {
    const client = sharedClient ?? new Client(config);
    try {
      if (config.adapterMode !== 2 && config.testRunId === undefined)
        throw new Error(`adapterMode=${config.adapterMode} requires testRunId`);
      if (config.adapterMode === 0) session.plan = await loadPlan(client, config);
      if (config.adapterMode === 2) {
        const response = await client.request(
          "test-runs",
          {
            name: clip(config.testRunName ?? framework.displayName, 100),
            external_key: session.reportId,
            configuration_id: config.configurationId,
            pipeline_id: config.pipelineId,
            branch: clip(config.branch, 255),
            environment: clip(config.environment, 100),
          },
          "POST",
          true,
        );
        if (typeof response.runId !== "number" && typeof response.runId !== "string")
          throw new Error("DoQA created the run but did not return its id");
        session.runId = response.runId;
      } else session.runId = config.testRunId;
    } catch (error) {
      session.sink = "files";
      session.reason = reason(error);
      delete session.plan;
      onWarning(
        `could not establish the test run (${session.reason}) - results are written as Allure files to ` +
          `'${config.resultsDir}' instead and are NOT sent to DoQA directly. Upload them in a later CI step ` +
          `(doqactl upload / POST /api/autotests/report).${statusHint(error, config)}` +
          (config.adapterMode === 0
            ? " The run's selection could not be fetched, so every discovered test runs."
            : ""),
      );
    } finally {
      if (!sharedClient) await client.close();
    }
  }
  // Without a session file the workers stay passive, which is what "off" means.
  if (session.sink !== "off") atomic(join(dir, file), session);
  return session;
}
