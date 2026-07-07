// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { JobsucheApiError, JobsucheParseError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://rest.arbeitsagentur.de";
const DEFAULT_USER_AGENT = "jobsuche-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to https://rest.arbeitsagentur.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request (e.g. an API key). */
  defaultHeaders?: Record<string, string>;
  /** Per-request timeout in milliseconds (0 disables). */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly). */
  retryDelayMs?: number;
  /** Number of HTTP redirects (301/302/303/307/308) to follow. Defaults to 5. */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Header names that carry credentials and MUST NOT be forwarded across an
 * origin boundary on a redirect. Matched case-insensitively.
 */
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "cookie"]);

/** True when two URLs share scheme + host (incl. port) — i.e. the same origin. */
function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

/** Return a copy of `headers` with all credential headers removed. */
function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Strip control characters (all C0/C1 controls except tab and newline, plus DEL)
 * from a string that originates in an attacker-controlled response — the error
 * `detail` and the echoed Content-Type. `JSON.parse` decodes an escaped ESC in an
 * error body into a real ESC byte, so without this a hostile or MITM-controlled endpoint
 * could drive ANSI/OSC terminal escape sequences into the user's terminal when the
 * message is printed to stderr (display spoofing, title changes). The success path
 * is already safe because `JSON.stringify` escapes these; this only needs to cover
 * text that flows into an error message. The API key lives in a request header and
 * is never part of this text, so it cannot leak here.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    // Drop C0 (except tab 0x09 / newline 0x0a), DEL and C1; keep everything else.
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    let url = this.buildUrl(path, options.query);
    let headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
      ...this.defaultHeaders,
    };

    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      const response = await this.transport({
        method,
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(this.retryDelayMs * attempt);
        continue;
      }

      // Follow redirects, resolving the Location relative to the current URL.
      if (status >= 300 && status < 400 && redirects < this.maxRedirects) {
        const location = response.headers["location"];
        if (typeof location === "string" && location.length > 0) {
          const current = new URL(url);
          const target = new URL(location, current); // can point at ANY host
          // Security: when the redirect crosses an origin boundary, drop
          // credential headers (Authorization / X-API-Key / Cookie) so they are
          // never forwarded to a host the original request did not authenticate
          // to. Same-origin redirects keep the full header set.
          if (!sameOrigin(target, current)) {
            headers = stripCredentialHeaders(headers);
          }
          url = target.toString();
          redirects += 1;
          continue;
        }
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = res.data.toString("utf8");
    // Guard against a 200 that is not actually JSON (e.g. an HTML error/landing
    // page from a misconfigured --base-url that resolves to an unexpected host).
    // Inspecting the Content-Type yields a clearer message than a raw parse error.
    const isJsonType = /\bjson\b/i.test(res.contentType);
    if (!isJsonType && res.contentType) {
      // Both the echoed Content-Type and the body snippet are server-controlled and
      // are printed to stderr by run.ts; strip control chars so a hostile endpoint
      // cannot inject terminal escape sequences via the parse-error message.
      const snippet = sanitizeServerText(text.slice(0, 200));
      throw new JobsucheParseError(
        `Expected a JSON response from ${path} but got Content-Type "${sanitizeServerText(res.contentType)}"`,
        { cause: snippet ? new Error(snippet) : undefined },
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new JobsucheParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  /** Perform a GET returning the raw bytes (image / binary downloads). */
  async getRaw(path: string, accept: string, query?: QueryParams): Promise<RawResponse> {
    return this.request("GET", path, { query, accept });
  }

  private toApiError(method: string, url: string, status: number, body: Buffer): JobsucheApiError {
    const text = body.toString("utf8");
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body and ends up in the Error.message that
    // run.ts prints to stderr; strip control characters so a hostile endpoint
    // cannot inject terminal escape sequences via that message.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    return new JobsucheApiError({ status, url, method, body: text, detail });
  }
}
