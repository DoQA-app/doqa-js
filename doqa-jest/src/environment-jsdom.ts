import { TestEnvironment } from "jest-environment-jsdom";
import { wrapEnvironment } from "./environment";
export = wrapEnvironment(TestEnvironment);
