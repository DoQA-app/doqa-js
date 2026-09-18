import { fetch, Agent, ProxyAgent, FormData } from "undici";
import type { ClientConfig } from "./types";

const connectFailures = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);
function errorCode(error: unknown): string | undefined {
  for (let e = error as { code?: string; cause?: unknown; errors?: unknown[] } | undefined; e; e = e.cause as typeof e) {
    if (typeof e.code === "string") return e.code;
    const nested = e.errors?.map(errorCode).find(Boolean);
    if (nested) return nested;
  }
  return undefined;
}

/** `status` is the HTTP status, or 0 when DoQA did not answer. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class Client {
  private failures = 0;
  private openUntil = 0;
  private dispatcher: Agent | ProxyAgent;
  private base: string;
  constructor(readonly config: ClientConfig) {
    const tls = { rejectUnauthorized: config.certValidation !== false };
    this.dispatcher = config.proxy
      ? new ProxyAgent({
          uri: /^[a-z][a-z0-9+.-]*:\/\//i.test(config.proxy) ? config.proxy : `http://${config.proxy}`,
          requestTls: tls,
          proxyTls: tls,
          connectTimeout: config.requestTimeoutMs,
        })
      : new Agent({ connect: { ...tls, timeout: config.requestTimeoutMs } });
    this.base = String(config.url ?? "")
      .replace(/\/+$/, "")
      .replace(/\/api$/i, "");
  }
  async close(): Promise<void> {
    await this.dispatcher.close();
  }
  private redact(text: string): string {
    const token = String(this.config.token ?? "");
    return token ? text.split(token).join("***") : text;
  }
  async request(
    path: string,
    data: Record<string, unknown> = {},
    method = "POST",
    safe = false,
    form?: FormData,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.base}/api/autotests/${path}`);
    const label = `${method} ${url.origin}${url.pathname}`;
    const halfOpen = this.openUntil !== 0 && Date.now() >= this.openUntil;
    if (Date.now() < this.openUntil)
      throw new ApiError(`${label} -> skipped: DoQA circuit breaker is open`, 0);
    const body = {
      token: this.config.token,
      space_id: this.config.spaceId,
      ...data,
    };
    if (method === "GET")
      for (const [k, v] of Object.entries(body))
        if (v != null) url.searchParams.set(k, String(v));
    if (form) {
      form.set("token", String(this.config.token));
      form.set("space_id", String(this.config.spaceId));
    }
    const attempts = halfOpen ? 1 : Math.max(1, this.config.retries);
    for (let attempt = 0; ; attempt++) {
      let failure: ApiError;
      let retry = safe || method === "GET";
      try {
        const response = await fetch(url, {
          method,
          dispatcher: this.dispatcher,
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
          headers:
            form || method === "GET"
              ? { Accept: "application/json" }
              : {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
          body: method === "GET" ? undefined : (form ?? JSON.stringify(body)),
          redirect: "error",
        });
        if (response.ok) {
          const payload: unknown = await response.json();
          if (!payload || typeof payload !== "object" || Array.isArray(payload))
            throw new Error("the response is not a JSON object");
          this.failures = 0;
          this.openUntil = 0;
          return payload as Record<string, unknown>;
        }
        retry = response.status === 429 || (retry && response.status >= 500);
        const text = await response.text().catch(() => "");
        failure = new ApiError(
          `${label} -> ${response.status}: ${this.redact(text).slice(0, 500)}`,
          response.status,
        );
      } catch (error) {
        const code = errorCode(error);
        // A request that never reached DoQA is safe to repeat even when it is not idempotent.
        retry ||= code !== undefined && connectFailures.has(code);
        failure = new ApiError(
          `${label} -> no response (${this.redact(code ?? (error as Error).message)})`,
          0,
        );
      }
      if (retry && attempt + 1 < attempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.config.retryBackoffMs * 2 ** attempt),
        );
        continue;
      }
      if (++this.failures >= 5 || halfOpen) this.openUntil = Date.now() + 30000;
      throw failure;
    }
  }
}
