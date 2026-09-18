import type { FrameworkInfo } from "../../doqa-js-commons/src/index";

export const framework: FrameworkInfo = {
  name: "jest",
  language: "javascript",
  displayName: "Jest",
};

const extension = /\.(?:[cm]?[jt]sx?)$/i;

/** `tests/checkout.test.ts` -> `tests.checkout`: the dotted form DoQA groups autotests by. */
export function namespaceOf(relativeFile: string): string {
  const segments = relativeFile.replace(/\\/g, "/").split("/");
  const last = segments.length - 1;
  segments[last] = segments[last].replace(extension, "").replace(/\.(?:test|spec)$/i, "");
  return segments.map((s) => s.replace(/\./g, "_")).join(".");
}
