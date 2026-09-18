import { relative, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { JestEnvironment, EnvironmentContext } from "@jest/environment";
import type { JestEnvironmentConfig } from "@jest/environment";
import type { Circus } from "@jest/types";
import type {
  Config,
  Metadata,
  RecordResult,
  Session,
  Options,
  Step,
} from "./types";
import type { FileSummary } from "../../doqa-js-commons/src/index";
import { Runtime } from "../../doqa-js-commons/src/index";
import { bridgeKey, metadataKey, registrationKey, templateKey } from "./bridge";
import { resolveConfig } from "./config";
import { namespaceOf } from "./framework";
import { serializeParameter } from "./parameter";
import { loadSession } from "../../doqa-js-commons/src/session";
import {
  atomic,
  failureOutcome,
  hash,
  reason,
  stripAnsi,
  truncate,
  warn,
} from "../../doqa-js-commons/src/index";

type EnvironmentConstructor = new (
  config: JestEnvironmentConfig,
  context: EnvironmentContext,
) => JestEnvironment;
type Annotated = Circus.TestFn & {
  [metadataKey]?: Metadata;
  [templateKey]?: string;
  doqaParameters?: { name: string; value: string }[];
  doqaRegistration?: unknown;
};
function primary(error: unknown): unknown {
  return Array.isArray(error) ? error[0] : error;
}
// Errors come from the test VM, so `instanceof Error` cannot be trusted here.
function text(error: unknown): string {
  const e = primary(error) as { name?: unknown; message?: unknown; stack?: unknown } | null;
  if (!e || typeof e !== "object" || typeof e.message !== "string") return String(e);
  return typeof e.name === "string" && e.stack ? `${e.name}: ${e.message}` : e.message;
}
function trace(error: unknown): string {
  const stack = (e: unknown) =>
    e && typeof e === "object" && "stack" in e && e.stack ? String(e.stack) : undefined;
  return (
    stack(primary(error)) ??
    (Array.isArray(error) && stack(error[1])
      ? `${text(error)}\n${stack(error[1])}`
      : text(error))
  );
}
// jest-circus registers its own root beforeEach (mock resets) before the test file loads.
function internalHook(hook: Circus.Hook): boolean {
  const own = /jest-circus[\\/]build[\\/]/;
  const registrar = /jest-circus[\\/]build[\\/](?:index|jestAdapterInit)\.js/;
  const frames = String(hook.asyncError?.stack ?? "").split("\n").slice(1);
  if (!frames.length) return /resetModules|clearAllMocks|restoreAllMocks/.test(String(hook.fn));
  const caller = frames.find((frame) => !registrar.test(frame));
  return caller !== undefined && own.test(caller);
}
export function wrapEnvironment(
  Base: EnvironmentConstructor,
): EnvironmentConstructor {
  return class DoqaEnvironment extends Base {
    private baseHandler?: (
      event: Circus.Event,
      state: Circus.State,
    ) => void | Promise<void>;
    private config: Config;
    private dir = "";
    private runtime: Runtime;
    private session?: Session;
    private active = false;
    private file: string;
    private project: string;
    private records = new Map<Circus.TestEntry, RecordResult>();
    private fallbackIds = new Set<Circus.TestEntry>();
    private excluded = new Set<Circus.TestEntry>();
    private internal = new WeakSet<Circus.Hook>();
    private fixtures = new Map<
      Circus.DescribeBlock,
      { before: Step[]; after: Step[] }
    >();
    private attemptRecords: { test: Circus.TestEntry; result: RecordResult }[] =
      [];
    private summary: FileSummary;
    private registeredRow = 0;
    private registration?: unknown;
    constructor(config: JestEnvironmentConfig, context: EnvironmentContext) {
      super(config, context);
      this.baseHandler = this.handleTestEvent?.bind(
        this,
      ) as typeof this.baseHandler;
      this.handleTestEvent = this.onEvent.bind(this);
      const options = config.projectConfig.testEnvironmentOptions.doqa as
        | (Options & { sessionDir: string })
        | undefined;
      if (!options?.sessionDir)
        warn("the DoQA environment is used without withDoqa(jestConfig) - nothing is reported");
      this.config = resolveConfig(options?.sessionDir ? options : { reporting: "off" });
      this.dir = options?.sessionDir ?? "";
      this.runtime = new Runtime(this.dir, this.config.maxMessageLength);
      this.file = relative(
        config.projectConfig.rootDir,
        context.testPath,
      ).replace(/\\/g, "/");
      this.project =
        this.config.projectName ?? config.projectConfig.displayName?.name ?? "";
      this.summary = { file: this.file, selected: 0, unreported: [], duplicates: [], notes: [] };
    }
    async setup(): Promise<void> {
      await super.setup();
      (this.global as unknown as Record<string, unknown>)[bridgeKey] =
        this.runtime;
      // Only the main process talks to DoQA; without its session nobody would pick the records up.
      this.session = this.dir ? loadSession(this.dir) : undefined;
      this.active = this.session !== undefined && this.session.sink !== "off";
    }
    private parents(test: Circus.TestEntry): Circus.DescribeBlock[] {
      const parents: Circus.DescribeBlock[] = [];
      for (
        let block: Circus.DescribeBlock | undefined = test.parent;
        block;
        block = block.parent
      )
        parents.unshift(block);
      return parents;
    }
    private makeRecord(test: Circus.TestEntry): RecordResult {
      const fn = test.fn as Annotated | undefined;
      const metadata: Metadata = structuredClone(fn?.[metadataKey] ?? {});
      const chain = this.parents(test)
        .slice(1)
        .map((b) => b.name);
      const classname = chain.join(" ");
      const template = fn?.[templateKey] ?? test.name;
      const titleId = test.name.match(/(?:\[|@)DOQA[-:](\d+)\]?/);
      const explicit = metadata.id ?? (titleId ? "DOQA-" + titleId[1] : undefined);
      if (!explicit) this.fallbackIds.add(test);
      const now = Date.now();
      return {
        uuid: randomUUID(),
        external_id:
          explicit ??
          "jest:" + hash([this.project, this.file, ...chain, template].join("\n")),
        name: [classname, test.name].filter(Boolean).join(" "),
        namespace: namespaceOf(this.file),
        classname,
        runner_method: template,
        metadata,
        parameters: [
          ...(metadata.parameters ?? []),
          ...(fn?.doqaParameters ?? []),
        ],
        outcome: "passed",
        started_on: now,
        completed_on: now,
        duration_ms: 0,
        step_results: [],
        setup_results: [],
        teardown_results: [],
        attachments: [],
      };
    }
    private record(test: Circus.TestEntry): RecordResult {
      let record = this.records.get(test);
      if (!record) {
        record = this.makeRecord(test);
        this.records.set(test, record);
      }
      return record;
    }
    // The location only vouches for tests whose id may still appear at execution time.
    private rank(test: Circus.TestEntry): number {
      const r = this.record(test);
      const byLocation = this.fallbackIds.has(test);
      const rank = this.session?.plan?.findIndex(
        (p) =>
          p.externalId === r.external_id ||
          (byLocation &&
            p.namespace === r.namespace &&
            (p.classname ?? "") === r.classname &&
            p.runnerMethod === r.runner_method),
      );
      return rank === undefined || rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
    }
    private prepare(block: Circus.DescribeBlock, owners: Map<string, Set<unknown>>): void {
      for (const child of block.children) {
        if (child.type === "describeBlock") {
          this.prepare(child, owners);
          continue;
        }
        const r = this.record(child);
        if (this.session?.plan && this.rank(child) === Number.MAX_SAFE_INTEGER) {
          child.mode = "skip";
          this.excluded.add(child);
          continue;
        }
        this.summary.selected++;
        const owner = (child.fn as Annotated | undefined)?.doqaRegistration ?? child;
        owners.set(r.external_id, (owners.get(r.external_id) ?? new Set()).add(owner));
        if (owners.get(r.external_id)?.size === 2)
          this.summary.duplicates.push(r.external_id);
        const original = child.fn;
        if (original) {
          const environment = this;
          const invoke = function (this: unknown, ...args: unknown[]) {
            return environment.runtime.context.run(
              { result: environment.record(child) },
              () => Reflect.apply(original, this, args),
            );
          };
          // Jest distinguishes done-callback tests by function.length.
          Object.defineProperty(invoke, "length", { value: original.length });
          child.fn = Object.assign(invoke, {
            [metadataKey]: (original as Annotated)[metadataKey],
            [templateKey]: (original as Annotated)[templateKey],
            doqaParameters: (original as Annotated).doqaParameters,
          }) as Circus.TestFn;
        }
      }
      for (const hook of block.hooks) {
        if (internalHook(hook)) {
          this.internal.add(hook);
          continue;
        }
        const original = hook.fn;
        const environment = this;
        const wrapped = function (this: unknown, ...args: unknown[]) {
          const active = environment.hookContext.get(hook);
          return active
            ? environment.runtime.context.run(active, () =>
                Reflect.apply(original, this, args),
              )
            : Reflect.apply(original, this, args);
        };
        Object.defineProperty(wrapped, "length", { value: original.length });
        hook.fn = wrapped as Circus.TestFn;
      }
    }
    // Falls back to the Jest order instead of failing the file.
    private order(block: Circus.DescribeBlock): boolean {
      const ranks = (
        entry: Circus.TestEntry | Circus.DescribeBlock,
      ): number[] =>
        entry.type === "test"
          ? this.excluded.has(entry)
            ? []
            : [this.rank(entry)]
          : entry.children.flatMap(ranks);
      const sorted = [...block.children].sort(
        (a, b) => Math.min(...ranks(a)) - Math.min(...ranks(b)),
      );
      let last = -1;
      for (const child of sorted) {
        if (child.type === "test" && child.concurrent && !this.excluded.has(child)) return false;
        const values = ranks(child).filter((n) => n !== Number.MAX_SAFE_INTEGER);
        if (values.length && Math.min(...values) < last) return false;
        if (values.length) last = Math.max(...values);
        if (child.type === "describeBlock" && !this.order(child)) return false;
      }
      block.children = sorted;
      return true;
    }
    private hookContext = new Map<
      Circus.Hook,
      { result: RecordResult; step: Step }
    >();
    private filtered(test: Circus.TestEntry, state: Circus.State): boolean {
      return (
        state.hasFocusedTests ||
        (state.testNamePattern != null &&
          !state.testNamePattern.test(this.record(test).name))
      );
    }
    private async onEvent(
      event: Circus.Event,
      state: Circus.State,
    ): Promise<void> {
      if (!this.active) {
        await this.baseHandler?.(event, state);
        return;
      }
      if (event.name === "add_test") {
        const registration = (this.global as unknown as Record<string, unknown>)[
          registrationKey
        ] as
          | { metadata: Metadata; template: string; rows: readonly unknown[] }
          | undefined;
        if (registration) {
          if (this.registration !== registration) {
            this.registration = registration;
            this.registeredRow = 0;
          }
          const fn = event.fn as Annotated;
          fn[metadataKey] = registration.metadata;
          fn[templateKey] = registration.template;
          fn.doqaRegistration = registration;
          const row = registration.rows[this.registeredRow++];
          fn.doqaParameters = (Array.isArray(row) ? row : [row]).map(
            (v, i) => ({
              name: `arg${i}`,
              value: serializeParameter(v),
            }),
          );
        }
      }
      await this.baseHandler?.(event, state);
      if (event.name === "run_start") {
        const snapshot = (block: Circus.DescribeBlock): unknown[] =>
          block.children.map((c) => (c.type === "describeBlock" ? [c, snapshot(c)] : c));
        this.prepare(state.rootDescribeBlock, new Map());
        if (this.config.executionOrder === "plan" && this.session?.plan) {
          const restore = (block: Circus.DescribeBlock, saved: unknown[]): void => {
            block.children = saved.map((entry) => {
              if (!Array.isArray(entry)) return entry as Circus.TestEntry;
              restore(entry[0], entry[1]);
              return entry[0] as Circus.DescribeBlock;
            });
          };
          const saved = snapshot(state.rootDescribeBlock);
          if (!this.order(state.rootDescribeBlock)) {
            restore(state.rootDescribeBlock, saved);
            this.summary.notes.push(
              `the plan order cannot be applied to ${this.file} (test.concurrent or interleaved describe blocks) - ` +
                "the file runs in the Jest order",
            );
          }
        }
      }
      if (event.name === "test_start") {
        const r = this.record(event.test);
        r.started_on = Date.now();
      }
      if (event.name === "hook_start" && !this.internal.has(event.hook)) {
        const hook = event.hook;
        const test =
          hook.type === "beforeAll" || hook.type === "afterAll"
            ? null
            : state.currentlyRunningTest;
        const record = test ? this.record(test) : this.makeFixtureRecord();
        const start = Date.now();
        const step: Step = {
          title: hook.type,
          outcome: "passed",
          started_on: start,
          completed_on: start,
          duration_ms: 0,
          steps: [],
          attachments: [],
        };
        this.hookContext.set(hook, { result: record, step });
        if (test)
          (hook.type === "beforeEach"
            ? record.setup_results
            : record.teardown_results
          ).push(step);
        else {
          let fixtures = this.fixtures.get(hook.parent);
          if (!fixtures) {
            fixtures = { before: [], after: [] };
            this.fixtures.set(hook.parent, fixtures);
          }
          (hook.type === "beforeAll" ? fixtures.before : fixtures.after).push(
            step,
          );
        }
      }
      if (event.name === "hook_success" || event.name === "hook_failure") {
        const context = this.hookContext.get(event.hook);
        if (context) {
          const step = context.step;
          step.completed_on = Date.now();
          step.duration_ms = step.completed_on - step.started_on;
          if (event.name === "hook_failure") {
            step.outcome = "broken";
            step.message = truncate(
              stripAnsi(text(event.error)),
              this.config.maxMessageLength,
            );
          }
          this.hookContext.delete(event.hook);
        }
      }
      if (
        event.name === "test_done" ||
        event.name === "test_skip" ||
        event.name === "test_todo"
      ) {
        if (this.excluded.has(event.test)) return;
        // Tests cut off by -t / test.only were never part of this run.
        if (
          event.name === "test_skip" &&
          (event.test.mode !== "skip" || this.filtered(event.test, state))
        )
          return;
        const r = this.record(event.test);
        r.completed_on = Date.now();
        r.duration_ms = r.completed_on - r.started_on;
        if (event.name !== "test_done") {
          r.outcome = "skipped";
          r.duration_ms = 0;
          if (event.name === "test_todo") r.message = "todo";
        } else if (event.test.errors.length) {
          const errors: unknown[] = event.test.errors;
          r.outcome = errors.some((e) => failureOutcome(primary(e)) === "failed")
            ? "failed"
            : "broken";
          r.message = truncate(
            stripAnsi(errors.map(text).join("\n")),
            this.config.maxMessageLength,
          );
          r.traces = truncate(
            stripAnsi(errors.map(trace).join("\n")),
            this.config.maxTraceLength,
          );
        }
        this.attemptRecords.push({ test: event.test, result: r });
      }
      if (event.name === "test_retry") this.records.delete(event.test);
      if (event.name === "run_finish") this.persist();
    }
    private persist(): void {
      for (const { test, result } of this.attemptRecords) {
        const fixtures = this.parents(test).map((b) => this.fixtures.get(b));
        result.setup_results.unshift(
          ...fixtures.flatMap((f) => f?.before ?? []),
        );
        result.teardown_results.push(
          ...fixtures.reverse().flatMap((f) => f?.after ?? []),
        );
        if (
          result.outcome !== "skipped" &&
          [...result.setup_results, ...result.teardown_results].some(
            (s) => s.outcome === "broken",
          )
        )
          result.outcome = "broken";
        result.parameters = result.parameters.map((p) => ({
          ...p,
          value: truncate(p.value, this.config.maxParameterLength),
        }));
        const plan = this.session?.plan;
        if (plan && !plan.some((p) => p.externalId === result.external_id)) {
          this.summary.unreported.push(`${result.name} (${this.file})`);
          continue;
        }
        try {
          atomic(
            join(this.dir, `${result.started_on}-${result.uuid}.record.json`),
            result,
          );
        } catch (error) {
          warn(`cannot persist a test result in '${this.dir}' (${reason(error)})`);
        }
      }
      try {
        atomic(join(this.dir, `${randomUUID()}.summary.json`), this.summary);
      } catch {
        // the summary only feeds warnings
      }
    }
    private makeFixtureRecord(): RecordResult {
      const now = Date.now();
      return {
        uuid: randomUUID(),
        external_id: "",
        name: "",
        namespace: namespaceOf(this.file),
        classname: "",
        runner_method: "",
        metadata: {},
        parameters: [],
        outcome: "passed",
        started_on: now,
        completed_on: now,
        duration_ms: 0,
        step_results: [],
        setup_results: [],
        teardown_results: [],
        attachments: [],
      };
    }
  };
}
