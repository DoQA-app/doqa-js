import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config as JestConfig } from "jest";
import type { Options } from "./types";
import { resolveConfig } from "./config";
import { secretsKey } from "./bridge";
import { warn } from "../../doqa-js-commons/src/index";
export { doqa } from "./api";
// Test files import this module inside Jest's VM (jsdom has no Node fetch globals).
// Load the environment implementation only when configuring an environment.
export const wrapEnvironment: typeof import("./environment").wrapEnvironment = (
  Base,
) =>
  (require("./environment") as typeof import("./environment")).wrapEnvironment(
    Base,
  );
export type { Options, Metadata, Parameter, Link, LinkType } from "./types";
export function withDoqa(
  config: JestConfig = {},
  options: Options = {},
): JestConfig {
  const sessionDir = resolve(".doqa", randomUUID());
  // The token stays in this process: the Jest config is printed by --showConfig and sent to workers.
  const { token, ...shared } = options;
  const registry = globalThis as unknown as Record<symbol, Map<string, Options>>;
  (registry[secretsKey] ??= new Map()).set(sessionDir, { token });
  const opts = { ...shared, sessionDir };
  const planOrder = resolveConfig(options).executionOrder === "plan";
  if (config.projects?.some((p) => typeof p === "string"))
    warn("string entries of `projects` are not reported - describe them as objects to report them");
  if ([config, ...(config.projects ?? [])].some((p) => typeof p === "object" && p.injectGlobals === false))
    warn("doqa.test needs the Jest globals (injectGlobals: true); plain tests are still reported");
  if (String(config.testRunner ?? "").includes("jasmine"))
    warn("only the default jest-circus runner is reported");
  if (planOrder && config.testSequencer)
    warn("the plan order does not replace a custom testSequencer - test files run in its order");
  const configure = (project: JestConfig): JestConfig => {
    const environment = project.testEnvironment ?? "node";
    const builtIn = [
      "node",
      "jest-environment-node",
      "jsdom",
      "jest-environment-jsdom",
    ].includes(environment);
    return {
      ...project,
      testEnvironment: builtIn
        ? join(
            __dirname,
            environment.includes("jsdom")
              ? "environment-jsdom.js"
              : "environment-node.js",
          )
        : environment,
      testEnvironmentOptions: { ...project.testEnvironmentOptions, doqa: opts },
    };
  };
  return {
    ...configure(config),
    ...(config.projects
      ? {
          projects: config.projects.map((p) =>
            typeof p === "string" ? p : configure(p),
          ),
        }
      : {}),
    reporters: [
      ...(config.reporters ?? ["default"]),
      [join(__dirname, "reporter.js"), opts],
    ],
    ...(planOrder
      ? {
          maxWorkers: 1,
          ...(config.testSequencer ? {} : { testSequencer: join(__dirname, "sequencer.js") }),
        }
      : {}),
  };
}
