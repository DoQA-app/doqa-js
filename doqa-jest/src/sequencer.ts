import Sequencer from "@jest/test-sequencer";
import type { Test } from "@jest/test-result";
import { relative } from "node:path";
import { resolveConfig } from "./config";
import { establishSession } from "../../doqa-js-commons/src/session";
import { reason, warn } from "../../doqa-js-commons/src/index";
import { secretsKey } from "./bridge";
import { framework, namespaceOf } from "./framework";
import type { Options } from "./types";

// A plan that cannot be followed falls back to the Jest order instead of failing the run.
export default class PlanSequencer extends Sequencer {
  async sort(tests: Test[]): Promise<Test[]> {
    const fallback = async (why: string) => {
      warn(`the plan order is not applied (${why}) - test files run in the Jest order`);
      return super.sort(tests);
    };
    if (!tests.length) return tests;
    try {
      const raw = tests[0].context.config.testEnvironmentOptions
        .doqa as Options & { sessionDir: string };
      const secrets = (globalThis as unknown as Record<symbol, Map<string, Options>>)[secretsKey];
      const options = { ...raw, ...secrets?.get(raw.sessionDir) };
      const session = await establishSession(
        options.sessionDir,
        resolveConfig(options),
        framework,
        warn,
      );
      if (!session.plan) return fallback("the run's selection is not available");
      const files = session.plan.map((p) => p.namespace);
      if (files.some((file) => !file))
        return fallback("some autotests of the run have no known location yet");
      const closed = new Set<string>();
      let previous: string | undefined;
      for (const file of files as string[]) {
        if (file !== previous && closed.has(file))
          return fallback("the plan interleaves test files");
        if (previous) closed.add(previous);
        previous = file;
      }
      const rank = (test: Test) => {
        const index = files.indexOf(
          namespaceOf(relative(test.context.config.rootDir, test.path)),
        );
        return index < 0 ? Infinity : index;
      };
      return [...tests].sort((a, b) => rank(a) - rank(b));
    } catch (error) {
      return fallback(reason(error));
    }
  }
}
