import { openAsBlob, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Config,
  Options,
  RecordResult,
  Session,
  Step,
  Attachment,
  FrameworkInfo,
  FileSummary,
  Link,
} from "./types";
import { resolveConfig } from "./config";
import { Client, FormData } from "../../doqa-client/src/index";
import { establishSession } from "./session";
import { atomic, clip, reason, warn } from "./storage";
import { labelList, writeAllure, writeReportingInfo } from "./files";

const linkTypes = ["related", "defect", "requirement", "blocked_by", "repository"];
const uploadHint =
  "Upload them in a later CI step (doqactl upload / POST /api/autotests/report).";

export class Coordinator {
  readonly config: Config;
  private client: Client;
  private session?: Session;
  private pending = Promise.resolve();
  private chunk = 0;
  private seen = new Set<string>();
  private defined = new Map<string, string>();
  private upserted = new Set<string>();
  private duplicates = new Set<string>();
  private warned = new Set<string>();
  private delivered = 0;
  private fallback = 0;
  private troubled = false;
  private onExit = () => this.drainToFiles();
  private onSignal = (signal: NodeJS.Signals) => {
    this.drainToFiles();
    process.kill(process.pid, signal);
  };
  constructor(
    private options: Options & { sessionDir: string },
    private framework: FrameworkInfo,
  ) {
    this.config = resolveConfig(options, warn);
    this.client = new Client(this.config);
  }
  private get dir(): string {
    return this.options.sessionDir;
  }
  async start(): Promise<void> {
    this.session = await establishSession(
      this.dir,
      this.config,
      this.framework,
      warn,
      this.client,
    );
    if (this.session.sink === "off") return;
    this.writeInfo();
    process.once("exit", this.onExit);
    process.once("SIGINT", this.onSignal);
    process.once("SIGTERM", this.onSignal);
  }
  /** Picks up the records finished so far (realtime import). */
  notify(): void {
    this.enqueue(false);
  }
  async complete(): Promise<void> {
    this.enqueue(true);
    await this.pending;
    process.off("exit", this.onExit);
    process.off("SIGINT", this.onSignal);
    process.off("SIGTERM", this.onSignal);
    await this.client.close();
    if (!this.session || this.session.sink === "off") return;
    this.summarize();
    if (this.troubled) warn(`recovery files are kept in '${this.dir}'`);
    else {
      rmSync(this.dir, { recursive: true, force: true });
      try {
        rmdirSync(dirname(this.dir));
      } catch {
        // other sessions still use the parent directory
      }
    }
  }
  private enqueue(final: boolean): void {
    this.pending = this.pending
      .then(() => this.flush(final))
      .catch((error) => this.trouble("flush", `results could not be processed (${reason(error)})`));
  }
  private trouble(key: string, message: string): void {
    this.troubled = true;
    this.warnOnce(key, message);
  }
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    warn(message);
  }
  private writeInfo(): void {
    const session = this.session as Session;
    try {
      writeReportingInfo(
        this.config,
        session.sink === "api"
          ? {
              sink: "api",
              runId: session.runId,
              adapterMode: this.config.adapterMode,
              delivered: this.delivered,
              fallbackResults: this.fallback,
            }
          : {
              sink: "files",
              degradedFrom: session.reason ? "api" : undefined,
              reason: session.reason,
            },
      );
    } catch (error) {
      this.trouble("dir", `cannot write to the results directory '${this.config.resultsDir}' (${reason(error)})`);
    }
  }
  private links(items: Link[] | undefined): Link[] | undefined {
    const links = (items ?? [])
      .filter((link) => link.url && link.url.length <= 2048)
      .map((link) => {
        const known = link.type === undefined || linkTypes.includes(link.type);
        if (!known)
          this.warnOnce(`link:${link.type}`, `unknown link type "${link.type}" - the link is sent without a type`);
        return { url: link.url, title: clip(link.title, 255), type: known ? link.type : undefined };
      });
    return links.length ? links : undefined;
  }
  // DoQA limits apply to both sinks: a file result must be importable, too.
  private normalize(r: RecordResult): RecordResult {
    const steps = (items: Step[]): void =>
      items.forEach((s) => {
        s.title = clip(s.title, 500);
        s.attachments.forEach((a) => (a.name = clip(a.name, 255)));
        steps(s.steps);
      });
    r.external_id = clip(r.external_id, 255);
    r.name = clip(r.name, 255) || r.external_id;
    r.namespace = clip(r.namespace, 255);
    r.classname = clip(r.classname, 255);
    r.runner_method = clip(r.runner_method, 255);
    r.metadata.title = clip(r.metadata.title, 255);
    r.metadata.labels = labelList(r.metadata.labels).map((v) => clip(v, 255));
    r.metadata.tags = r.metadata.tags?.map((v) => clip(v, 255));
    r.metadata.links = this.links(r.metadata.links);
    r.attachments.forEach((a) => (a.name = clip(a.name, 255)));
    [r.setup_results, r.step_results, r.teardown_results].forEach(steps);
    const location = [r.namespace, r.classname, r.runner_method].join("\n");
    const owner = this.defined.get(r.external_id) ?? location;
    if (owner !== location) this.duplicates.add(r.external_id);
    this.defined.set(r.external_id, owner);
    return r;
  }
  private take(): RecordResult[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir)
        .filter((f) => f.endsWith(".record.json") && !this.seen.has(f))
        .sort();
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      this.seen.add(name);
      try {
        return [this.normalize(JSON.parse(readFileSync(join(this.dir, name), "utf8")) as RecordResult)];
      } catch (error) {
        this.trouble("record", `a result record is unreadable (${reason(error)})`);
        return [];
      }
    });
  }
  private toFiles(records: RecordResult[]): void {
    for (const record of records)
      try {
        writeAllure(record, this.config, this.dir, this.framework);
      } catch (error) {
        this.trouble("dir", `cannot write to the results directory '${this.config.resultsDir}' (${reason(error)})`);
      }
  }
  /** Last resort when the process ends before the run completes: synchronous, files only. */
  private drainToFiles(): void {
    if (!this.session || this.session.sink === "off") return;
    const records = this.take();
    this.toFiles(records);
    this.fallback += records.length;
    this.writeInfo();
  }
  private async flush(final: boolean): Promise<void> {
    const session = this.session;
    if (!session || session.sink === "off") return;
    const records = this.take();
    if (session.sink === "files") {
      this.toFiles(records);
      return;
    }
    let closed = false;
    for (let i = 0; i < records.length; i += this.config.batchSize) {
      const batch = records.slice(i, i + this.config.batchSize);
      const last = final && i + this.config.batchSize >= records.length;
      try {
        await this.deliver(batch, last);
        this.delivered += batch.length;
        closed = last;
      } catch (error) {
        // The rejected chunk goes to files; the following ones still travel to DoQA.
        this.toFiles(batch);
        this.fallback += batch.length;
        this.troubled = true;
        warn(
          `results chunk failed (${reason(error)}) - ${batch.length} results are written as Allure files to ` +
            `'${this.config.resultsDir}' instead. ${uploadHint}`,
        );
      }
    }
    if (final && !closed)
      await this.deliver([], true).catch((error) =>
        this.trouble("final", `the delivery could not be closed (${reason(error)}) - DoQA may keep waiting for the run to finish`),
      );
    this.writeInfo();
  }
  private async uploadAttachments(items: Attachment[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const item of items)
      try {
        const form = new FormData();
        form.set(
          "file",
          await openAsBlob(join(this.dir, item.source), { type: item.type }),
          item.name,
        );
        const response = await this.client.request("attachments", {}, "POST", false, form);
        if (!response.mediaFileId) throw new Error("DoQA did not return mediaFileId");
        results.push({ media_file_id: response.mediaFileId, name: item.name });
      } catch (error) {
        // The attachment is lost, the test is not.
        this.trouble("attachment", `attachment upload failed (${reason(error)}) - the result is sent without it`);
      }
    return results;
  }
  private async steps(items: Step[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const s of items)
      results.push({
        ...s,
        attachments: await this.uploadAttachments(s.attachments),
        steps: await this.steps(s.steps),
      });
    return results;
  }
  private definition(r: RecordResult): Record<string, unknown> {
    const tree = (items: Step[], kind: string): unknown[] =>
      items.map((s) => ({ title: s.title, kind, steps: tree(s.steps, kind) }));
    const list = <T>(values: T[] | undefined) => (values?.length ? values : undefined);
    return {
      external_id: r.external_id,
      name: r.name,
      title: r.metadata.title || undefined,
      description: r.metadata.description || undefined,
      namespace: r.namespace || undefined,
      classname: r.classname || undefined,
      runner_name: r.name,
      runner_method: r.runner_method || undefined,
      labels: list(r.metadata.labels as string[]),
      tags: list(r.metadata.tags),
      links: r.metadata.links,
      steps: list([
        ...tree(r.setup_results, "before"),
        ...tree(r.step_results, "step"),
        ...tree(r.teardown_results, "after"),
      ]),
      case_ids: list(r.metadata.caseIds),
    };
  }
  private async deliver(batch: RecordResult[], final: boolean): Promise<void> {
    const session = this.session as Session;
    const fresh = batch.filter(
      (r, i) =>
        !this.upserted.has(r.external_id) &&
        batch.findIndex((other) => other.external_id === r.external_id) === i,
    );
    if (fresh.length)
      try {
        await this.client.request("upsert", { autotests: fresh.map((r) => this.definition(r)) });
        fresh.forEach((r) => this.upserted.add(r.external_id));
      } catch (error) {
        this.trouble("upsert", `autotest definitions were not updated (${reason(error)}) - the results are still sent`);
      }
    const results: unknown[] = [];
    for (const r of batch)
      results.push({
        external_id: r.external_id,
        name: r.name,
        outcome: r.outcome,
        started_on: r.started_on,
        completed_on: r.completed_on,
        duration_ms: r.duration_ms,
        message: r.message,
        traces: r.traces,
        parameters: r.parameters,
        step_results: await this.steps(r.step_results),
        setup_results: await this.steps(r.setup_results),
        teardown_results: await this.steps(r.teardown_results),
        attachments: await this.uploadAttachments(r.attachments),
        links: r.metadata.links,
        create_manual_case: r.metadata.createManualCase || undefined,
        properties: {
          framework: this.framework.name,
          language: this.framework.language,
        },
        runner_name: r.name,
        runner_method: r.runner_method || undefined,
      });
    const payload = {
      test_run_id: session.runId,
      configuration_id: this.config.configurationId,
      ci_run_id: this.config.ciRunId,
      pipeline_id: clip(this.config.pipelineId === undefined ? undefined : String(this.config.pipelineId), 255),
      report_id: session.reportId,
      chunk_index: this.chunk,
      is_final_chunk: final,
      results,
    };
    atomic(join(this.dir, `chunk-${this.chunk}.json`), payload);
    // A failed request keeps its index: DoQA closes the delivery only over a gapless 0..N range.
    const response = await this.client.request("results", payload);
    atomic(join(this.dir, `chunk-${this.chunk}.receipt.json`), response);
    const index = this.chunk++;
    const skipped = (Array.isArray(response.skipped) ? response.skipped : []) as { reason?: string }[];
    // The index was taken by an earlier chunk whose answer got lost - this one was not recorded.
    if (batch.length && skipped.filter((s) => s?.reason === "replay").length === batch.length)
      throw new Error(`DoQA had already recorded chunk ${index}`);
    if (skipped.length || (typeof response.accepted === "number" && response.accepted < batch.length)) {
      const reasons = [...new Set(skipped.map((s) => s?.reason).filter(Boolean))];
      this.troubled = true;
      warn(
        `chunk ${index}: DoQA accepted ${response.accepted ?? "?"} of ${batch.length} results` +
          (reasons.length ? ` (skipped: ${reasons.join(", ")})` : "") +
          `; see the receipt in '${this.dir}'`,
      );
    }
  }
  private summarize(): void {
    const session = this.session as Session;
    const summaries: FileSummary[] = [];
    try {
      for (const name of readdirSync(this.dir))
        if (name.endsWith(".summary.json"))
          summaries.push(JSON.parse(readFileSync(join(this.dir, name), "utf8")) as FileSummary);
    } catch {
      return;
    }
    const sample = (items: string[]) =>
      items.slice(0, 3).join("; ") + (items.length > 3 ? `; … ${items.length - 3} more` : "");
    const unreported = summaries.flatMap((s) => s.unreported);
    const duplicates = [...new Set([...summaries.flatMap((s) => s.duplicates), ...this.duplicates])];
    if (session.plan?.length && !summaries.some((s) => s.selected))
      warn(
        `the run selects ${session.plan.length} autotests, but none of them matched the discovered tests - ` +
          "nothing was executed. Check that the tests' ids match the autotests of the run.",
      );
    if (unreported.length)
      warn(
        `${unreported.length} tests ran because their location matched the run, but their id is not part of it - ` +
          `their results are not reported: ${sample(unreported)}`,
      );
    if (duplicates.length)
      warn(`several tests share one id and collapse into a single autotest: ${sample(duplicates)}`);
    for (const note of new Set(summaries.flatMap((s) => s.notes))) warn(note);
  }
}
