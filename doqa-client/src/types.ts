/** HTTP transport settings; independent of test frameworks and reporting modes. */
export interface ClientConfig {
  url?: string;
  token?: string;
  spaceId?: string | number;
  proxy?: string;
  certValidation?: boolean;
  requestTimeoutMs: number;
  retries: number;
  retryBackoffMs: number;
}
