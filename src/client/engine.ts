// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  assertValid,
  baseUrlProblem,
  headerNameProblem,
  headerValueProblem,
  intRangeProblem,
} from "./validate.js";
import { JobsucheApiError, JobsucheParseError, redactUrl } from "./errors.js";

export const DEFAULT_BASE_URL = "https://rest.arbeitsagentur.de";
/** The User-Agent sent when none is given (by the engine and by obtainKey). */
export const DEFAULT_USER_AGENT = "jobsuche-cli";

/** Most retries `maxRetries` may ask for. */
export const MAX_RETRIES = 10;

/** Most redirects `maxRedirects` may ask the engine to follow. */
export const MAX_REDIRECTS = 10;

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /**
   * Base URL of the API, an absolute http(s) URL without surrounding whitespace,
   * control characters, query or fragment (baseUrlProblem). Defaults to
   * https://rest.arbeitsagentur.de
   */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /**
   * Value of the User-Agent header; defaults to `DEFAULT_USER_AGENT`. Must be a
   * valid header value (headerValueProblem): a blank one is rejected, not replaced.
   */
  userAgent?: string;
  /**
   * Extra headers sent on every request (e.g. an API key). Names must be HTTP
   * tokens and values valid header values (headerNameProblem, headerValueProblem).
   */
  defaultHeaders?: Record<string, string>;
  /**
   * Per-request timeout in milliseconds, a non-negative integer (0 disables;
   * capped at MAX_TIMEOUT_MS, 2^31 - 1 ms). Defaults to 30000.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses, an integer
   * 0..`MAX_RETRIES` (10). Defaults to 2.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly: `retryDelayMs *
   * attempt`), an integer 0..`MAX_RETRY_AFTER_MS` (30 000). Defaults to 200. A
   * `Retry-After` header can lengthen a wait (up to `MAX_RETRY_AFTER_MS`), never
   * shorten it; a longer one is not retried at all.
   */
  retryDelayMs?: number;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow, an integer
   * 0..`MAX_REDIRECTS` (10). Defaults to 5. Any other 3xx, one with a missing or
   * malformed Location, and one past this limit surface as a JobsucheApiError
   * naming the target.
   */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint), a non-negative integer. Defaults to 100 MiB;
   * set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The redirect statuses the engine follows. 300 (a choice for the user), 304 (a
 * cache answer to a conditional request this client never sends) and 305/306
 * (deprecated) are not redirects to follow; they surface as a JobsucheApiError.
 */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once, naming the requested wait: retrying early would only land inside the window
 * the server asked us to wait out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), any other date format — so the caller falls back to its own
 * backoff. The strict patterns matter: `Date.parse` alone would read `"1.5"` as a
 * date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/** Default per-request timeout in milliseconds (the client's and obtain-key's). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default response-size cap in bytes (the client's and obtain-key's). */
export const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

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
 * message is printed to stderr (display spoofing, title changes). This only covers
 * text that flows into an error message; the CLI's JSON output is escaped separately
 * (escapeControlChars in cli/shared.ts), since `JSON.stringify` alone leaves DEL and
 * the C1 range raw. The API key lives in a request header and
 * is never part of this text, so it cannot leak here.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    // Drop C0 (except the whitespace 0x09-0x0d, folded below), DEL, C1 and the
    // bidi controls (a U+202E override reorders what the terminal shows).
    if (n <= 8 || (n >= 0x0e && n <= 0x1f) || (n >= 0x7f && n <= 0x9f) || isBidiControl(n)) continue;
    out += ch;
  }
  // One line: newlines, tabs and U+2028/2029 become one space, so server text
  // cannot forge an extra "Error:" line on stderr.
  return out.replace(/\s+/g, " ").trim();
}

/**
 * The Unicode bidirectional controls (ALM, LRM, RLM, LRE/RLE/PDF/LRO/RLO,
 * LRI/RLI/FSI/PDI). Invisible, but they reorder the text around them, so server
 * text using them can spoof what a terminal shows.
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Check a base URL (baseUrlProblem) and return it with trailing slashes stripped,
 * or throw a JobsucheValidationError (`Invalid baseUrl: <reason>`) — a
 * configuration error, not a network one. The default transport still gates the
 * scheme on every hop (redirects included); this gate covers a library
 * consumer's custom transport, which does no such check.
 */
export function validateBaseUrl(raw: string): string {
  return assertValid("baseUrl", raw, baseUrlProblem).replace(/\/+$/, "");
}

/**
 * The rest.arbeitsagentur.de gateway reports errors as
 * `{"timestamp", "logref", "messages": [{"code", "path", "detail"}]}` — e.g. a 400
 * `page: Wert ungültig (EINGABEN_UNVOLLSTAENDIG_ODER_FEHLERHAFT)` or a 404
 * `STELLENANGEBOT_NICHT_GEFUNDEN`. Render each entry as `path: detail (code)`,
 * leaving out what is missing, joined with "; "; undefined when nothing usable.
 */
export function describeMessages(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const parts: string[] = [];
  for (const m of messages) {
    if (m === null || typeof m !== "object") continue;
    const { code, path, detail } = m as { code?: unknown; path?: unknown; detail?: unknown };
    const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    const where = text(path);
    const what = text(detail);
    const id = text(code);
    const head = what ? (where ? `${where}: ${what}` : what) : "";
    const part = head ? (id ? `${head} (${id})` : head) : id;
    if (part) parts.push(part);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/**
 * A numeric engine option: `fallback` when undefined, else an integer in 0..max,
 * or a JobsucheValidationError (`Invalid <name>: ...`). A negative, NaN or
 * fractional value would otherwise silently disable the timeout or the size cap,
 * and an unbounded maxRetries would keep retrying. Exported so side fetchers
 * (obtainKey) apply the same rule.
 */
export function intOption(name: string, value: number | undefined, max: number, fallback: number): number {
  return value === undefined ? fallback : assertValid(name, value, intRangeProblem(0, max));
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
    // Checked on the raw value, before the trailing-slash strip; only `undefined`
    // selects the default.
    this.baseUrl = options.baseUrl === undefined ? DEFAULT_BASE_URL : validateBaseUrl(options.baseUrl);
    this.transport = options.transport ?? nodeHttpTransport;
    // Header values are checked here, not only by the CLI: a CR/LF would reach a
    // custom transport as an injected header, and the default transport would fail
    // late. Only `undefined` selects the default User-Agent.
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertValid("userAgent", options.userAgent, headerValueProblem);
    this.defaultHeaders = options.defaultHeaders ?? {};
    for (const [name, value] of Object.entries(this.defaultHeaders)) {
      assertValid("header name", name, headerNameProblem);
      assertValid(`header ${name}`, value, headerValueProblem);
    }
    // Range-checked, not only by the CLI. A timeout above MAX_TIMEOUT_MS stays
    // allowed: the transport caps the timer at MAX_TIMEOUT_MS (documented).
    const unbounded = Number.MAX_SAFE_INTEGER;
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, unbounded, DEFAULT_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, MAX_RETRIES, 2);
    // Bounded like the Retry-After cap: a longer base delay would outlast any wait the
    // server may ask for.
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, MAX_RETRY_AFTER_MS, 200);
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, MAX_REDIRECTS, 5);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      unbounded,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
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
      let retryAfterTooLong: number | undefined;
      if (retryable && attempt < this.maxRetries) {
        // Back off linearly (retryDelayMs * attempt). A Retry-After header can ask for
        // longer, never for less: `Retry-After: 0` or a date in the past would turn the
        // retries into a zero-delay burst against a server that has just asked for less
        // load. One beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces
        // at once and names the wait, since retrying sooner would only land inside it.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          const backoff = this.retryDelayMs * attempt;
          await this.sleep(retryAfter === undefined ? backoff : Math.max(retryAfter, backoff));
          continue;
        }
        retryAfterTooLong = retryAfter;
      }

      // Follow redirects, resolving the Location relative to the current URL.
      const locationHeader = response.headers["location"];
      const location = typeof locationHeader === "string" ? locationHeader : undefined;
      const target = FOLLOWED_REDIRECTS.has(status) ? resolveLocation(location, url) : undefined;
      if (target !== undefined && redirects >= this.maxRedirects) {
        // A loop (or a long chain): say how far it got rather than a bare 3xx.
        // (With maxRedirects 0 nothing was followed; the plain text says enough.)
        throw this.toApiError(method, url, status, response.body, location, redirects || undefined);
      }
      if (target !== undefined) {
        const current = new URL(url);
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
      // Any other 3xx — not a followed status, or no usable Location — falls
      // through and surfaces as a JobsucheApiError naming the target.

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body, location, undefined, retryAfterTooLong);
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

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
    redirectsFollowed?: number,
    retryAfterMs?: number,
  ): JobsucheApiError {
    const text = body.toString("utf8");
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown; messages?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
      else if (parsed) detail = describeMessages(parsed.messages);
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body and ends up in the Error.message that
    // run.ts prints to stderr; strip control characters so a hostile endpoint
    // cannot inject terminal escape sequences via that message.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    // Name the target of a redirect that was not followed.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, locationHeader) : undefined;
    return new JobsucheApiError({
      status,
      url,
      method,
      body: text,
      detail,
      ...(location !== undefined ? { location } : {}),
      ...(redirectsFollowed !== undefined ? { redirectsFollowed } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
}

/** Resolve a Location header against the current URL; undefined if missing or malformed. */
function resolveLocation(location: string | undefined, base: string): URL | undefined {
  if (location === undefined || location === "") return undefined;
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, userinfo redacted, control characters stripped (it is server text bound for
 * stderr). An unparseable value is shown sanitised as it came.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  const resolved = resolveLocation(location, requestUrl);
  const clean = sanitizeServerText(resolved ? redactUrl(resolved.href) : location).trim();
  return clean === "" ? undefined : clean;
}
