import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Metadata, RecordResult, Step } from "./types";
import { contentTypeOf, failureOutcome, stripAnsi, truncate, warn } from "./storage";
import { labelList } from "./files";

export interface Context {
  result: RecordResult;
  step?: Step;
}
function union<T>(current: T[] | undefined, added: T[]): T[] {
  const keys = new Set((current ?? []).map((v) => JSON.stringify(v)));
  return [...(current ?? []), ...added.filter((v) => !keys.has(JSON.stringify(v)))];
}
export class Runtime {
  readonly context = new AsyncLocalStorage<Context>();
  constructor(
    private dir: string,
    private maxMessageLength = 10000,
  ) {}
  /** Adds to the running test; outside of one it is a silent no-op. */
  metadata(value: Metadata): void {
    const current = this.context.getStore();
    if (!current) return;
    const meta = current.result.metadata;
    const { caseIds, labels, tags, links, parameters, createManualCase, ...scalars } = value;
    Object.assign(meta, scalars);
    if (caseIds) meta.caseIds = union(meta.caseIds, caseIds);
    if (labels) meta.labels = union(labelList(meta.labels), labelList(labels));
    if (tags) meta.tags = union(meta.tags, tags);
    if (links) meta.links = union(meta.links, links);
    if (createManualCase) meta.createManualCase = true;
    if (parameters) current.result.parameters.push(...parameters);
    if (value.id) current.result.external_id = value.id;
  }
  step<T>(title: string, fn: () => T): T {
    const current = this.context.getStore();
    if (!current) return fn();
    const start = Date.now();
    const step: Step = {
      title,
      outcome: "passed",
      started_on: start,
      completed_on: start,
      duration_ms: 0,
      steps: [],
      attachments: [],
    };
    (current.step?.steps ?? current.result.step_results).push(step);
    const finish = (error?: unknown) => {
      step.completed_on = Date.now();
      step.duration_ms = step.completed_on - start;
      if (error !== undefined) {
        step.outcome = failureOutcome(error);
        step.message = truncate(stripAnsi(String(error)), this.maxMessageLength);
      }
    };
    return this.context.run({ ...current, step }, () => {
      try {
        const value = fn();
        if (value && typeof (value as { then?: unknown }).then === "function") {
          return Promise.resolve(value).then(
            (v) => {
              finish();
              return v;
            },
            (e) => {
              finish(e ?? new Error(String(e)));
              throw e;
            },
          ) as T;
        }
        finish();
        return value;
      } catch (error) {
        finish(error ?? new Error(String(error)));
        throw error;
      }
    });
  }
  attach(name: string, content: string | Uint8Array, type?: string): void {
    const current = this.context.getStore();
    if (!current) return;
    try {
      const source = `${randomUUID()}-attachment${extname(name) || (typeof content === "string" ? ".txt" : ".bin")}`;
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.dir, source), content, { mode: 0o600 });
      (current.step?.attachments ?? current.result.attachments).push({
        name,
        source,
        type: type ?? (extname(name) ? contentTypeOf(name) : typeof content === "string" ? "text/plain" : "application/octet-stream"),
      });
    } catch (error) {
      warn(`cannot save the attachment '${name}' (${(error as Error).message})`);
    }
  }
  attachFile(path: string, name = basename(path), type?: string): void {
    if (!this.context.getStore()) return;
    try {
      this.attach(name, readFileSync(path), type ?? contentTypeOf(name));
    } catch (error) {
      warn(`cannot read the attachment file '${path}' (${(error as Error).message})`);
    }
  }
}
