import { resolveConfig as resolveCommonConfig } from "../../doqa-js-commons/src/index";
import type { Config, Options } from "./types";
export function resolveConfig(
  options: Options = {},
  onWarning: (message: string) => void = () => {},
): Config {
  const config = resolveCommonConfig(options, onWarning) as Config;
  const order = String(config.executionOrder ?? "jest").toLowerCase();
  if (order !== "jest" && order !== "plan")
    onWarning(`executionOrder="${config.executionOrder}" is unknown - using the Jest order`);
  config.executionOrder = order === "plan" ? "plan" : "jest";
  return config;
}
