// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { TextDecoder } from "node:util";
import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  assertValid,
  baseUrlProblem,
  headerNameProblem,
  headerValueProblem,
  intRangeProblem,
} from "./validate.js";
import {
  JobsucheApiError,
  JobsucheError,
  JobsucheNetworkError,
  JobsucheParseError,
  JobsucheValidationError,
  credentialsIn,
  cutForMessage,
  cutText,
  redactCredentials,
  redactSecrets,
  redactUrl,
} from "./errors.js";

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
  /** The URL that answered, after any redirects, without userinfo. */
  url: string;
  /**
   * Set when a redirect led to another origin (another scheme, host or port), so the
   * credentials (the API key, the base URL's userinfo) were not sent to the server
   * that answered: the origins before and after that hop.
   */
  credentialsDropped?: CredentialsDropped;
}

/** Where a redirect left the origin the credentials belong to. */
export interface CredentialsDropped {
  /** The origin that received the credentials. */
  from: string;
  /** The other origin the redirect led to, which did not. */
  to: string;
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
   * Per-request timeout in milliseconds, whole response included, a non-negative
   * integer (0 disables; capped at MAX_TIMEOUT_MS, 2^31 - 1 ms). Defaults to 30000.
   * Enforced by the engine for every transport: the transport gets an AbortSignal
   * that fires at the deadline, and the call fails then either way.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses and reset
   * connections (`isTransientNetworkError`; GET/HEAD only), an integer
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
   * set to 0 for no limit. Checked on the body of every transport.
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

/** Return a copy of `headers` with all credential headers removed. */
function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * `url` without its userinfo, and the `Authorization: Basic` value the userinfo
 * stands for (undefined without one). The engine (and `obtainKey`) attach
 * credentials per hop themselves, so a transport never sees a URL with userinfo:
 * Node's http would turn it into a Basic header on every hop, and `fetch` refuses
 * such a URL. A URL that does not parse is returned as is, for the transport to
 * report.
 */
export function splitUserinfo(url: string): { url: string; basic: string | undefined } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, basic: undefined };
  }
  if (parsed.username === "" && parsed.password === "") return { url, basic: undefined };
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const pair = `${decode(parsed.username)}:${decode(parsed.password)}`;
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.href, basic: `Basic ${Buffer.from(pair, "latin1").toString("base64")}` };
}

/** The origin of `url` (scheme, host and port), or undefined when it does not parse. */
export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * A NetworkError when a transport's reported final URL (`HttpResponse.url`, fetch's
 * `response.url`) is on another origin than the request's: the transport followed a
 * redirect itself, to a host the caller never checked — with credential headers,
 * since fetch strips Authorization across origins but not X-API-Key or Cookie.
 * Undefined when the transport reports no URL or the same origin.
 */
export function followedElsewhere(method: string, url: string, reported: unknown): JobsucheNetworkError | undefined {
  if (typeof reported !== "string" || reported === "" || originOf(reported) === originOf(url)) return undefined;
  return new JobsucheNetworkError(
    `${method} ${redactUrl(url)} failed: the transport followed a redirect to ` +
      `${originOf(reported) ?? "an unparseable URL"}, another origin. A transport must not ` +
      `follow redirects (HttpRequest.redirect is "manual"); the engine follows them and ` +
      `decides where credentials may go.`,
  );
}

/** The phrase for the API key in `cleartextProblem`'s sentence (as the CLI passes it). */
export const API_KEY_PHRASE = "the API key";

/** The phrase `cleartextProblem` uses for a base URL's `user:password@`. */
const USERINFO_PHRASE = "the base URL's credentials";

/**
 * Why requests to `baseUrl` would cross the network unencrypted, or `undefined`.
 *
 * Returns `undefined` for an `https:` URL, for one that does not parse, and for the
 * loopback interface (`localhost`, `127.0.0.0/8`, `::1`). For any other plain `http:`
 * URL it returns one sentence (no `warning: ` prefix) naming the host (`url.host`: host
 * and port, never the userinfo) and what secret travels with the requests: `secrets`
 * are noun phrases such as `"the API key"`, and a `user:password@` in the URL adds
 * "the base URL's credentials". The secrets themselves are never in the sentence. Not
 * an error (a mirror on a trusted network is a legitimate setup), so the CLI logs it
 * as a `WARN` record of `jobsuche.http` (once per run, before the first request).
 *
 * - `requests to <host> are sent unencrypted (http:, not https:)`
 * - `the base URL's credentials are sent unencrypted to <host> (http:, not https:)`
 * - `the API key and the base URL's credentials are sent unencrypted to <host> (http:, not https:)`
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // The WHATWG parser normalises IPv4 (`127.1`, `0x7f.0.0.1`) to dotted decimal.
  if (host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host)) return undefined;
  const named = [...secrets];
  if (url.username !== "" || url.password !== "") named.push(USERINFO_PHRASE);
  if (named.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const subject =
    named.length === 1 ? named[0]! : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]!}`;
  const verb = named.length === 1 && named[0] !== USERINFO_PHRASE ? "is" : "are";
  return `${subject} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
}

/**
 * @deprecated Use {@link cleartextProblem}, which also warns when no secret is sent.
 * Kept for library callers: the same check with {@link API_KEY_PHRASE} as the secret
 * when `hasKey`, in the old shape (capitalised, ending in "."), and still `undefined`
 * when neither a key nor a `user:password@` would be sent.
 */
export function cleartextCredentialsProblem(baseUrl: string, hasKey: boolean): string | undefined {
  const problem = cleartextProblem(baseUrl, hasKey ? [API_KEY_PHRASE] : []);
  if (problem === undefined || problem.startsWith("requests to ")) return undefined;
  return `${problem.charAt(0).toUpperCase()}${problem.slice(1)}.`;
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
 * Longest server text (in characters) kept for an error message (a `detail`). A longer
 * one is cut and ends in "…", so a hostile or buggy body cannot flood stderr or a CI
 * log with one huge line. `JobsucheApiError.body` keeps the full text.
 */
const MAX_DETAIL_LENGTH = 500;

/** sanitizeServerText, then cut at MAX_DETAIL_LENGTH characters (never inside a surrogate pair). */
function cleanDetail(text: string): string {
  const clean = sanitizeServerText(text);
  return cutForMessage(clean, MAX_DETAIL_LENGTH);
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

/** A transport's answer as the engine reads it: lower-case headers, a Buffer body. */
export interface ExchangeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** The final URL the transport reported (`HttpResponse.url`), if any. */
  url?: string;
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) {
    return "body is not a Buffer, Uint8Array, other ArrayBuffer view, ArrayBuffer or string";
  }
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by
 * internal slot, not `instanceof`, so a value from another realm (a vm context, a Jest
 * test) counts. A string is read as UTF-8. Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") {
    return Buffer.from(value as ArrayBuffer);
  }
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names, as the engine reads
 * them. A transport built on `fetch` naturally returns its `Headers` object, which
 * passes as an object but has no plain properties: the engine then saw no Location,
 * Retry-After or Content-Type at all. Such an object (anything with `get` and
 * `forEach`, a `Map` included) is copied into a record; a plain record gets its names
 * lower-cased (Node's transport does that already, a custom one may not).
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  const record: Record<string, string | string[] | undefined> = {};
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    (h.forEach as (cb: (value: string, name: string) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/** A single header value (the first of a repeated one), or undefined. */
export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * True for a failure caused by a reset or aborted connection (`ECONNRESET`, `EPIPE`,
 * `ECONNABORTED`, undici's `UND_ERR_SOCKET`, anywhere in the `cause` chain), which the
 * engine retries like a 503 — whichever transport raised it. A refused connection, a
 * DNS failure or a timeout is not transient in that sense and is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return hasTransientCode(err);
}

/**
 * Read a function option: `undefined` gives the default; anything else that is not a
 * function is a JobsucheValidationError. A string `transport` used to fail at the first
 * request as a raw TypeError, and a bad `sleep` on the first retry.
 */
export function functionOption<F>(name: string, value: F | undefined, fallback: F): F {
  if (value === undefined) return fallback;
  if (typeof value !== "function") {
    throw new JobsucheValidationError(`Invalid ${name}: Expected a function, got ${typeof value}.`);
  }
  return value;
}

/**
 * One exchange through a transport, with the client's limits enforced whatever the
 * transport does — used by the engine for every hop and by `obtainKey`:
 *
 * - `timeoutMs` (0 = none): the transport gets an AbortSignal that fires at the
 *   deadline, and the call rejects then whether the transport stops or not;
 * - `maxResponseBytes` (0 = none): checked on the body that came back;
 * - the response must have an HTTP status, a headers object and a byte body (see
 *   HttpResponse); headers come back lower-cased, the body as a Buffer.
 *
 * A thrown value (a synchronous throw included) and a malformed response reject; the
 * caller turns them into a JobsucheNetworkError (`networkError`).
 */
export async function exchange(
  transport: Transport,
  request: HttpRequest,
  limits: { timeoutMs: number; maxResponseBytes: number },
): Promise<ExchangeResponse> {
  const call = (signal?: AbortSignal): Promise<HttpResponse> =>
    Promise.resolve().then(() => transport(signal === undefined ? request : { ...request, signal }));
  let raw: unknown;
  if (limits.timeoutMs === 0) {
    raw = await call();
  } else {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new JobsucheNetworkError(`Request exceeded the ${limits.timeoutMs}ms deadline`);
        controller.abort(err);
        reject(err);
      }, Math.min(limits.timeoutMs, MAX_TIMEOUT_MS));
    });
    try {
      raw = await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
  // An injected transport may resolve with anything; a malformed HttpResponse would
  // otherwise surface later as a raw TypeError, outside the JobsucheError contract.
  const invalid = responseProblem(raw);
  if (invalid !== undefined) {
    throw new JobsucheNetworkError(`the transport returned an invalid response (${invalid})`);
  }
  const response = raw as HttpResponse;
  const body = bodyBytes(response.body) as Buffer;
  // The size cap holds whatever the transport did: the default one aborts early, a
  // custom one may have read everything.
  if (limits.maxResponseBytes > 0 && body.byteLength > limits.maxResponseBytes) {
    throw new JobsucheNetworkError(sizeLimitMessage(limits.maxResponseBytes));
  }
  const reported = (response as { url?: unknown }).url;
  return {
    status: response.status,
    headers: plainHeaders(response.headers),
    body,
    ...(typeof reported === "string" ? { url: reported } : {}),
  };
}

/**
 * A function that removes known secrets from text: the userinfo `credentials` (raw
 * and percent-decoded, see `credentialsIn`) become `***@`, each of `secrets` (an API
 * key, which has no `@` to anchor on) becomes `***`.
 */
export function secretScrubber(credentials: readonly string[], secrets: readonly string[]): (text: string) => string {
  const userinfo = credentials.flatMap((raw) => {
    try {
      return [raw, decodeURIComponent(raw)];
    } catch {
      return [raw];
    }
  });
  return (text) => redactSecrets(redactCredentials(text, userinfo), secrets);
}

/**
 * A transport failure as the `cause` of the error the library raises: the original
 * when its text carries no secret, otherwise a copy with them scrubbed (message,
 * `code` and the cause chain kept), so logging the error with its causes can't
 * reveal the base URL's password or the key.
 */
export function scrubCause(cause: unknown, scrub: (text: string) => string, depth = 0): unknown {
  if (depth > 5) return cause;
  if (typeof cause === "string") return scrub(cause);
  if (!(cause instanceof Error)) return cause;
  const inner = scrubCause(cause.cause, scrub, depth + 1);
  const message = scrub(cause.message);
  const stack = cause.stack ?? "";
  if (message === cause.message && inner === cause.cause && scrub(stack) === stack) return cause;
  const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
  copy.name = cause.name;
  const code = (cause as { code?: unknown }).code;
  if (code !== undefined) Object.assign(copy, { code });
  return copy;
}

/**
 * A transport failure as a `JobsucheNetworkError`. The default transport rejects with
 * one already (passed through, its text scrubbed); an injected one may throw anything
 * (a TypeError from fetch, a string, null), which is wrapped naming the request, with
 * the original as `cause`, so every failure stays a `JobsucheError`. `scrub` removes
 * the caller's secrets from the message and the cause chain: fetch's "Request cannot be
 * constructed from a URL that includes credentials: http://user:pw@…" carries them.
 */
export function networkError(
  method: string,
  url: string,
  cause: unknown,
  scrub: (text: string) => string = (text) => text,
): JobsucheError {
  if (cause instanceof JobsucheNetworkError) {
    const message = scrub(cause.message);
    const inner = scrubCause(cause.cause, scrub);
    if (message === cause.message && inner === cause.cause) return cause;
    return new JobsucheNetworkError(message, inner === undefined ? undefined : { cause: inner });
  }
  if (cause instanceof JobsucheError) return cause;
  const reason =
    cause instanceof Error && cause.message.trim() !== ""
      ? cause.message
      : typeof cause === "string" && cause.trim() !== ""
        ? cause
        : "the transport failed without a message";
  return new JobsucheNetworkError(
    `${method} ${redactUrl(url)} failed: ${sanitizeServerText(scrub(redactUrl(reason)))}`,
    { cause: scrubCause(cause, scrub) },
  );
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  // Real private fields (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show them, so a password in the base URL or the
  // API key in the default headers can't be logged by accident.
  readonly #baseUrl: string;
  readonly #defaultHeaders: Record<string, string>;
  /** Removes the base URL's userinfo and the credential header values from text. */
  readonly #scrub: (text: string) => string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options".
    options = options ?? {};
    // Checked on the raw value, before the trailing-slash strip; only `undefined`
    // selects the default.
    this.#baseUrl = options.baseUrl === undefined ? DEFAULT_BASE_URL : validateBaseUrl(options.baseUrl);
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
    // Header values are checked here, not only by the CLI: a CR/LF would reach a
    // custom transport as an injected header, and the default transport would fail
    // late. Only `undefined` selects the default User-Agent.
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertValid("userAgent", options.userAgent, headerValueProblem);
    if (
      options.defaultHeaders !== undefined &&
      (typeof options.defaultHeaders !== "object" || options.defaultHeaders === null || Array.isArray(options.defaultHeaders))
    ) {
      throw new JobsucheValidationError("Invalid defaultHeaders: Expected an object of header names and values.");
    }
    this.#defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    for (const [name, value] of Object.entries(this.#defaultHeaders)) {
      assertValid("header name", name, headerNameProblem);
      assertValid(`header ${name}`, value, headerValueProblem);
    }
    // The secret part of a credential header (`X-API-Key: <key>`, `Bearer <token>`).
    const secrets = Object.entries(this.#defaultHeaders)
      .filter(([name]) => CREDENTIAL_HEADERS.has(name.toLowerCase()))
      .map(([, value]) => value.replace(/^\S+\s+(?=\S)/, "").trim());
    this.#scrub = secretScrubber(credentialsIn(this.#baseUrl), secrets);
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
    this.sleep = functionOption("sleep", options.sleep, realSleep);
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    const all: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
      ...this.#defaultHeaders,
    };
    // Credentials — the credential headers (X-API-Key, Authorization, Cookie) and the
    // base URL's userinfo, sent as `Authorization: Basic` unless an Authorization header
    // is already set — are attached per hop, never baked into the URL the transport
    // sees. They go to the start URL's origin only: a redirect to the same origin (a
    // relative or an absolute Location) keeps them, one to another scheme, host or port
    // drops them for the rest of the chain, and the result says so.
    const plain = stripCredentialHeaders(all);
    const credentials: Record<string, string> = {};
    for (const [name, value] of Object.entries(all)) if (!(name in plain)) credentials[name] = value;
    const start = splitUserinfo(this.buildUrl(path, options.query));
    if (start.basic !== undefined && !Object.keys(credentials).some((n) => n.toLowerCase() === "authorization")) {
      credentials["Authorization"] = start.basic;
    }
    const hasCredentials = Object.keys(credentials).length > 0;
    const credentialOrigin = originOf(start.url);
    let dropped: CredentialsDropped | undefined;
    let url = start.url;

    // Only an idempotent request is sent again: request() is public, and a POST re-sent
    // after a reset or a 503 may be applied twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      const sendCredentials = dropped === undefined && originOf(url) === credentialOrigin;
      const headers = sendCredentials ? { ...plain, ...credentials } : plain;
      let response: ExchangeResponse;
      try {
        response = await exchange(
          this.transport,
          {
            method,
            url,
            headers,
            redirect: "manual",
            timeoutMs: this.timeoutMs,
            ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
          },
          { timeoutMs: this.timeoutMs, maxResponseBytes: this.maxResponseBytes },
        );
      } catch (cause) {
        // A connection the server (or a gateway) reset is the network-level twin of a
        // 503: retry the GET like one, whichever transport reported it. Timeouts are
        // not retried — a slow upstream should not be asked again at once.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        throw networkError(method, url, cause, this.#scrub);
      }
      const elsewhere = followedElsewhere(method, url, response.url);
      if (elsewhere !== undefined) throw elsewhere;

      const status = response.status;
      const retryable = status === 429 || status === 503;
      let retryAfterTooLong: number | undefined;
      if (idempotent && retryable && attempt < this.maxRetries) {
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

      // Follow redirects, resolving the Location relative to the current URL. Only an
      // http(s) target is followed: a file:, data: or javascript: one never reaches the
      // transport, and surfaces below as a JobsucheApiError naming it.
      const location = headerValue(response.headers["location"]);
      const target = FOLLOWED_REDIRECTS.has(status) ? resolveLocation(location, url) : undefined;
      const next = target !== undefined && /^https?:$/.test(target.protocol) ? target : undefined;
      if (next !== undefined && redirects >= this.maxRedirects) {
        // A loop (or a long chain): say how far it got rather than a bare 3xx.
        // (With maxRedirects 0 nothing was followed; the plain text says enough.)
        throw this.toApiError(method, url, status, response.body, { location, redirectsFollowed: redirects || undefined, dropped });
      }
      if (next !== undefined) {
        // SECURITY: the credentials belong to the start URL's origin. A redirect to
        // another scheme, host or port drops them for the rest of the chain — http→https
        // on the same host included, as the key must not be re-sent on a hop the user
        // did not choose. A Location's own userinfo is never used.
        next.username = "";
        next.password = "";
        if (hasCredentials && dropped === undefined && next.origin !== credentialOrigin) {
          dropped = { from: originOf(url) ?? "", to: next.origin };
        }
        url = next.href;
        redirects += 1;
        continue;
      }
      // Any other 3xx — not a followed status, or no usable Location — falls
      // through and surfaces as a JobsucheApiError naming the target.

      const contentType = String(headerValue(response.headers["content-type"]) ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body, { location, dropped, retryAfterMs: retryAfterTooLong });
      }

      return { data: response.body, contentType, status, url, ...(dropped !== undefined ? { credentialsDropped: dropped } : {}) };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = decodeBody(res.data, res.contentType, path);
    // Guard against a 200 that is not actually JSON (e.g. an HTML error/landing
    // page from a misconfigured --base-url that resolves to an unexpected host).
    // Inspecting the Content-Type yields a clearer message than a raw parse error.
    const isJsonType = /\bjson\b/i.test(res.contentType);
    if (!isJsonType && res.contentType) {
      // Both the echoed Content-Type and the body snippet are server-controlled and
      // are printed to stderr by run.ts; strip control chars so a hostile endpoint
      // cannot inject terminal escape sequences via the parse-error message.
      const snippet = sanitizeServerText(this.#scrub(cutText(text, 200)));
      throw new JobsucheParseError(
        `Expected a JSON response from ${path} but got Content-Type "${cutForMessage(sanitizeServerText(res.contentType))}"`,
        { cause: snippet ? new Error(snippet) : undefined },
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new JobsucheParseError(`Failed to parse JSON response from ${path}`, { cause: scrubCause(cause, this.#scrub) });
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
    extra: {
      location?: string | undefined;
      redirectsFollowed?: number | undefined;
      dropped?: CredentialsDropped | undefined;
      retryAfterMs?: number | undefined;
    } = {},
  ): JobsucheApiError {
    const { location: locationHeader, redirectsFollowed, dropped, retryAfterMs } = extra;
    // The body is server text: an error page may echo the request URL or its headers.
    const text = this.#scrub(body.toString("utf8"));
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
    if (detail !== undefined) detail = cleanDetail(detail);
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
      ...(dropped !== undefined ? { credentialsDropped: dropped } : {}),
    });
  }
}

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none). TextDecoder drops a leading byte order mark, which Buffer#toString keeps and
 * JSON.parse then rejects, so a BOM added by a proxy cannot turn a valid answer into
 * a parse error, and an `iso-8859-1` body keeps its umlauts. An unknown charset label
 * is a `JobsucheParseError` naming it and `where`.
 */
export function decodeBody(body: Buffer, contentType: string, where: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new JobsucheParseError(`Unsupported response charset "${cutForMessage(sanitizeServerText(charset))}" from ${where}.`);
  }
  return decoder.decode(body);
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
