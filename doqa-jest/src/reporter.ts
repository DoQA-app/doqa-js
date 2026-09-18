import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import {
  atomic,
  hash,
  reason,
  stripAnsi,
  truncate,
  warn,
} from "../../doqa-js-commons/src/index";
import { Coordinator } from "../../doqa-js-commons/src/coordinator";
import { secretsKey } from "./bridge";
import { framework, namespaceOf } from "./framework";
import type { Options } from "./types";

type ReporterOptions = Options & { sessionDir: string };

export default class Reporter {
  private coordinator?: Coordinator;
  constructor(
    private global: { rootDir?: string; watch?: boolean; watchAll?: boolean },
    private options: ReporterOptions,
  ) {
    const secrets = (globalThis as unknown as Record<symbol, Map<string, Options>>)[secretsKey];
    this.options = { ...options, ...secrets?.get(options.sessionDir) };
    if (global.watch || global.watchAll) {
      warn("watch mode is not reported - every DoQA run needs its own Jest process");
      this.options.reporting = "off";
    }
    try {
      this.coordinator = new Coordinator(this.options, framework);
    } catch (error) {
      warn(`reporting is disabled (${reason(error)})`);
    }
  }
  private get config() {
    return this.coordinator?.config;
  }
  // Reporting must never fail the run.
  async onRunStart(): Promise<void> {
    await this.coordinator?.start().catch((error) => {
      warn(`reporting is disabled (${reason(error)})`);
      this.coordinator = undefined;
    });
  }
  async onRunComplete(): Promise<void> {
    await this.coordinator
      ?.complete()
      .catch((error) => warn(`results could not be completed (${reason(error)})`));
  }
  onTestResult(
    _test: unknown,
    result: {
      testFilePath: string;
      testExecError?: { message?: string; stack?: string };
      testResults: unknown[];
    },
  ): void {
    const config = this.config;
    if (!config || config.reporting === "off") return;
    if (result.testExecError && !result.testResults.length)
      this.loadFailure(result.testFilePath, result.testExecError);
    if (config.importRealtime) this.coordinator?.notify();
  }
  // Compilation / import failures never reach environment test_done.
  private loadFailure(path: string, error: { message?: string; stack?: string }): void {
    const config = this.config!;
    const file = relative(this.global.rootDir ?? process.cwd(), path).replace(/\\/g, "/");
    // Only a new run may grow by an autotest nobody planned.
    if (config.adapterMode !== 2) {
      warn(`${file} could not be loaded - its tests are not reported`);
      return;
    }
    const now = Date.now();
    const uuid = randomUUID();
    try {
      atomic(join(this.options.sessionDir, `${now}-${uuid}.record.json`), {
        uuid,
        external_id: "jest:" + hash([config.projectName ?? "", file, "<load>"].join("\n")),
        name: `${file} could not be loaded`,
        namespace: namespaceOf(file),
        classname: "",
        runner_method: "<load>",
        metadata: {},
        parameters: [],
        outcome: "broken",
        started_on: now,
        completed_on: now,
        duration_ms: 0,
        message: truncate(stripAnsi(error.message ?? ""), config.maxMessageLength),
        traces: truncate(stripAnsi(error.stack ?? ""), config.maxTraceLength),
        step_results: [],
        setup_results: [],
        teardown_results: [],
        attachments: [],
      });
    } catch (failure) {
      warn(`cannot persist a test result in '${this.options.sessionDir}' (${reason(failure)})`);
    }
  }
}
