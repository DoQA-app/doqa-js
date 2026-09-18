import { TestEnvironment } from "jest-environment-node";
import { wrapEnvironment } from "./environment";
export = wrapEnvironment(TestEnvironment);
