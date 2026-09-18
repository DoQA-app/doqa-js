import type {
  Options as CommonOptions,
  Config as CommonConfig,
} from "../../doqa-js-commons/src/index";
export type {
  Metadata,
  Parameter,
  Link,
  LinkType,
  RecordResult,
  Session,
  Step,
} from "../../doqa-js-commons/src/index";
export interface Options extends Omit<CommonOptions, "executionOrder"> {
  executionOrder?: "jest" | "plan";
}
export interface Config extends CommonConfig {
  executionOrder?: "jest" | "plan";
}
