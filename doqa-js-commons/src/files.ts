import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Attachment,
  Config,
  Metadata,
  RecordResult,
  Step,
  FrameworkInfo,
} from "./types";
import { atomic, hash } from "./storage";

export const reportingInfoFile = "doqa-reporting.properties";
const opened = new Set<string>();

export function labelList(labels: Metadata["labels"]): string[] {
  return Array.isArray(labels)
    ? labels
    : Object.entries(labels ?? {}).map(([name, value]) => `${name}:${value}`);
}

function open(config: Config): void {
  if (opened.has(config.resultsDir)) return;
  mkdirSync(config.resultsDir, { recursive: true });
  if (config.environment?.trim())
    writeFileSync(
      join(config.resultsDir, "environment.properties"),
      `environment=${config.environment.trim().replace(/[\r\n]/g, " ")}\n`,
    );
  opened.add(config.resultsDir);
}

/** Tells a later CI step whether the results went to DoQA or wait in this directory. */
export function writeReportingInfo(
  config: Config,
  entries: Record<string, string | number | undefined>,
): void {
  open(config);
  writeFileSync(
    join(config.resultsDir, reportingInfoFile),
    Object.entries(entries)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, " ")}\n`)
      .join(""),
  );
}

export function writeAllure(
  result: RecordResult,
  config: Config,
  sessionDir: string,
  framework: FrameworkInfo,
): void {
  open(config);
  const attachments = (items: Attachment[]) =>
    items.filter((item) => {
      try {
        const target = join(config.resultsDir, item.source);
        copyFileSync(join(sessionDir, item.source), target);
        chmodSync(target, 0o644);
        return true;
      } catch {
        return false;
      }
    });
  const steps = (items: Step[]): unknown[] =>
    items.map((s) => ({
      name: s.title,
      status: s.outcome,
      start: s.started_on,
      stop: s.completed_on,
      ...(s.message ? { statusDetails: { message: s.message } } : {}),
      steps: steps(s.steps),
      attachments: attachments(s.attachments),
    }));
  const meta = result.metadata;
  const labels = Object.entries({
    doqa_title: meta.title,
    doqa_id: result.external_id,
    ...(meta.caseIds?.length
      ? {
          doqa_cases: meta.caseIds.join(","),
          doqa_work_items: meta.caseIds.join(","),
        }
      : {}),
    doqa_create_manual_case: meta.createManualCase ? "true" : undefined,
    doqa_runner_name: result.name,
    doqa_runner_method: result.runner_method,
    framework: framework.name,
    language: framework.language,
    package: result.namespace,
    testClass: result.classname,
    suite: result.classname,
  })
    .filter(([, value]) => value)
    .map(([name, value]) => ({ name, value }));
  for (const tag of [...(meta.tags ?? []), ...labelList(meta.labels)])
    labels.push({ name: "tag", value: tag });
  if (result.setup_results.length || result.teardown_results.length) {
    const uuid = randomUUID();
    atomic(
      join(config.resultsDir, `${uuid}-container.json`),
      {
        uuid,
        children: [result.uuid],
        befores: steps(result.setup_results),
        afters: steps(result.teardown_results),
      },
      false,
    );
  }
  atomic(join(config.resultsDir, `${result.uuid}-result.json`), {
    uuid: result.uuid,
    historyId: hash([result.external_id, result.parameters]),
    testCaseId: result.external_id,
    name: result.name,
    fullName: `${[result.namespace, result.classname].filter(Boolean).join(".")}#${result.runner_method}`,
    status: result.outcome,
    start: result.started_on,
    stop: result.completed_on,
    statusDetails: { message: result.message, trace: result.traces },
    description: meta.description,
    labels,
    links: meta.links ?? [],
    parameters: result.parameters,
    steps: steps(result.step_results),
    attachments: attachments(result.attachments),
  }, false);
}
