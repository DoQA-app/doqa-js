import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
/** `secure` keeps session data private; published results follow the umask instead. */
export function atomic(path: string, value: unknown, secure = true): void {
  mkdirSync(dirname(path), { recursive: true, ...(secure ? { mode: 0o700 } : {}) });
  const temp = path + "." + randomUUID() + ".tmp";
  writeFileSync(temp, JSON.stringify(value), secure ? { mode: 0o600 } : {});
  renameSync(temp, path);
}
export function hash(value: unknown): string {
  return createHash("sha1")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}
export function warn(message: string): void {
  process.stderr.write(`DoQA: ${message}\n`);
}
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}
export function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… truncated (${text.length - max} chars)`;
}
export function clip<T extends string | undefined>(text: T, max: number): T {
  return (text === undefined ? text : text.slice(0, max)) as T;
}
/** Assertion failures are "failed" (a product signal), anything else is "broken". */
export function failureOutcome(error: unknown): "failed" | "broken" {
  if (!error || typeof error !== "object") return "broken";
  const e = error as { matcherResult?: unknown; name?: unknown; code?: unknown; stack?: unknown; message?: unknown };
  if (e.matcherResult !== undefined || e.code === "ERR_ASSERTION") return "failed";
  if (/assertion/i.test(String(e.name ?? "") + (error.constructor?.name ?? "")))
    return "failed";
  // jest-circus replaces node:assert and chai errors with a plain {message} object.
  return e.stack === undefined && typeof e.message === "string" ? "failed" : "broken";
}
const contentTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".html": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".zip": "application/zip",
};
export function contentTypeOf(filename: string): string {
  return contentTypes[extname(filename).toLowerCase()] ?? "application/octet-stream";
}
