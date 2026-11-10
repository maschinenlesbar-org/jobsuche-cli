// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { constants } from "node:buffer";
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
  JobsucheResponseTooLargeError,
  JobsucheValidationError,
  credentialsIn,
  cutForMessage,
  cutText,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
  redactUrl,
  quoteValue,
  TextBuilder,
} from "./errors.js";

// quoteValue lives with the other message helpers (validate.ts quotes refused values with it).
export { quoteValue } from "./errors.js";

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
  baseUrl?: string | undefined;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport | undefined;
  /**
   * Value of the User-Agent header; defaults to `DEFAULT_USER_AGENT`. Must be a
   * valid header value (headerValueProblem): a blank one is rejected, not replaced.
   */
  userAgent?: string | undefined;
  /**
   * Extra headers sent on every request (e.g. an API key). Names must be HTTP
   * tokens and values valid header values (headerNameProblem, headerValueProblem).
   */
  defaultHeaders?: Record<string, string> | undefined;
  /**
   * Per-request timeout in milliseconds, whole response included, a non-negative
   * integer (0 disables; capped at MAX_TIMEOUT_MS, 2^31 - 1 ms). Defaults to 30000.
   * Enforced by the engine for every transport: the transport gets an AbortSignal
   * that fires at the deadline, and the call fails then either way.
   */
  timeoutMs?: number | undefined;
  /**
   * Number of automatic retries for transient (429/503) responses and reset
   * connections (`isTransientNetworkError`; GET/HEAD only), an integer
   * 0..`MAX_RETRIES` (10). Defaults to 2.
   */
  maxRetries?: number | undefined;
  /**
   * Base backoff between retries in milliseconds (grows linearly: `retryDelayMs *
   * attempt`), an integer 0..`MAX_RETRY_AFTER_MS` (30 000). Defaults to 200. A
   * `Retry-After` header can lengthen a wait (up to `MAX_RETRY_AFTER_MS`), never
   * shorten it; a longer one is not retried at all.
   */
  retryDelayMs?: number | undefined;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow, an integer
   * 0..`MAX_REDIRECTS` (10). Defaults to 5. Any other 3xx, one with a missing or
   * malformed Location, and one past this limit surface as a JobsucheApiError
   * naming the target.
   */
  maxRedirects?: number | undefined;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint), a non-negative integer. Defaults to 100 MiB;
   * set to 0 for no limit. Checked on the body of every transport.
   */
  maxResponseBytes?: number | undefined;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Called once per retry, right before the backoff sleep, for each retried 429/503
   * and reset connection; never when there is no retry. A throw is swallowed.
   */
  onRetry?: ((event: RetryEvent) => void) | undefined;
  /**
   * Called when an answer is delivered changed: bytes that are not valid in its charset, or
   * lone surrogates written as JSON escapes, were replaced with U+FFFD (the message names the
   * request and the count). Not an error: one bad character never sinks a whole answer. A
   * throw is swallowed.
   */
  onWarning?: ((message: string) => void) | undefined;
  /**
   * Member names whose number value is a big integer the answer must keep exactly: each is
   * delivered as its exact decimal literal, as a string, whatever its size. Every other number
   * keeps the rule: exact, or a JobsucheParseError. This API needs none, so the client
   * declares none.
   */
  bigIntegerKeys?: ReadonlySet<string> | undefined;
}

/** What `EngineOptions.onRetry` is told about one retry. */
export interface RetryEvent {
  /** Which retry this is, counting from 1. */
  retry: number;
  /** The most retries this request may make (`maxRetries`). */
  maxRetries: number;
  /** How long the engine waits before sending the request again. */
  delayMs: number;
  /** The HTTP status that caused the retry; absent for a reset connection. */
  status?: number;
  /** The URL being retried, userinfo redacted (after a redirect, credentials echoed in it scrubbed). */
  url: string;
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
 * The most server text (in UTF-16 units) `sanitizeServerText` reads; a longer text is cut first.
 * Every message keeps far less of it (MAX_DETAIL_LENGTH, 500 characters), and cleaning all of a
 * 16 MB error detail, one string node per character, exhausted a small heap.
 */
const MAX_SERVER_TEXT = 16 * 1024;

/**
 * A whole terminal escape sequence: a CSI (`ESC [` or the 8-bit U+009B, parameters,
 * intermediates, final byte), a terminated control string (OSC/DCS/SOS/PM/APC, `ESC ]` …
 * up to BEL or ST, or their 8-bit forms) or a short `ESC` sequence. Dropping only the
 * control bytes left the printable rest behind (`ESC ] 0 ; title BEL` became `]0;title`).
 * An unterminated control string is left to the per-character filter, so it cannot
 * swallow the rest of the message. A control string's body ends at an ESC or at another
 * introducer: with the introducers allowed inside it, an unterminated run of them was matched
 * from each one to the end of the text, quadratic (100 000 × U+009D took 16 s). Written with
 * escapes, so the source holds no control bytes.
 */
const ESCAPE_SEQUENCE =
  /(?:\u001b\[|\u009b)[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]|(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[^\u0007\u001b\u0090\u0098\u009c-\u009f]*(?:\u0007|\u001b\\|\u009c)|\u001b[\u0020-\u002f]*[\u0030-\u007e]/g;

/**
 * What `sanitizeServerText` drops once the escape sequences are gone: the C0 controls but the
 * whitespace ones (TAB to CR), DEL, the C1 controls, and every format character (General
 * Category Cf: bidi controls, zero-width characters, U+00AD, U+FEFF, …).
 */
const DROPPED_CHAR = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\p{Cf}]/gu;

/**
 * Make a string that originates in an attacker-controlled response — the error `detail`,
 * an echoed Content-Type or charset, a redirect target, a transport's text — safe to print
 * into an error message on stderr:
 *
 * - Whole escape sequences (CSI, OSC and other control strings) are dropped first,
 *   then any remaining C0 and C1 controls and DEL. `JSON.parse` decodes a JSON-escaped ESC
 *   into a real ESC byte; printed raw, a hostile or MITM'd endpoint could drive ANSI/OSC
 *   sequences into the terminal (title spoofing, screen clearing, hidden output).
 * - Unicode format characters (General Category Cf) are dropped: the bidi controls
 *   (isBidiControl), so server text cannot reorder the visible message, and the
 *   invisible ones — zero-width space/joiners, word joiner, soft hyphen, BOM — so
 *   two messages that look identical are identical.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line and a server
 *   cannot forge an `Error:` line of its own.
 * - Only the first MAX_SERVER_TEXT (16 384) units are read, and every step is a linear
 *   regex replace: a hostile error body costs neither seconds nor the heap. A caller that
 *   scrubs credentials does so first, so a cut never splits one.
 *
 * The CLI's JSON output is escaped separately (escapeControlChars in cli/shared.ts), since
 * `JSON.stringify` alone leaves DEL, the C1 range and the bidi controls raw. Written with
 * escapes so no raw control byte appears in this source.
 */
export function sanitizeServerText(text: string): string {
  return cutText(text, MAX_SERVER_TEXT).replace(ESCAPE_SEQUENCE, "").replace(DROPPED_CHAR, "").replace(/\s+/g, " ").trim();
}

/**
 * Longest server text (in characters) kept for an error message (a `detail`). A longer
 * one is cut and ends in "…", so a hostile or buggy body cannot flood stderr or a CI
 * log with one huge line. `JobsucheApiError.body` keeps the full text.
 */
const MAX_DETAIL_LENGTH = 500;

/**
 * `form` and its spelling in a URL (`encodeURIComponent`): a server that puts a credential into
 * a URL, a redirect's Location, percent-encodes it. A form that has no such spelling (a lone
 * surrogate) is kept as it is.
 */
export function urlSpellings(form: string): string[] {
  try {
    return [form, encodeURIComponent(form)];
  } catch {
    return [form];
  }
}

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
  // A record built from an answer has no prototype: a header named `__proto__` is an own
  // entry like any other, never the record's prototype (whose entries would read as headers).
  const record = Object.create(null) as Record<string, string | string[] | undefined>;
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
    throw new JobsucheResponseTooLargeError(sizeLimitMessage(limits.maxResponseBytes), limits.maxResponseBytes);
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
 * A transport failure as a `JobsucheNetworkError` reading `<METHOD> <url> failed:
 * <reason>` (userinfo redacted). The default transport rejects with one already (its
 * text scrubbed, the request named in front, the original as `cause`); an injected one may throw anything
 * (a TypeError from fetch, a string, null), which is wrapped naming the request, with
 * the original as `cause`, so every failure stays a `JobsucheError`. `scrub` removes
 * the caller's secrets from the message and the cause chain: fetch's "Request cannot be
 * constructed from a URL that includes credentials: http://user:pw@…" carries them.
 * `shown` is the request as messages name it (after a redirect, the Location with the
 * secrets scrubbed as sent, then resolved: `RequestEngine`'s `shownTarget`); a text that
 * names the URL the transport was given has it replaced by `shown`.
 */
export function networkError(
  method: string,
  url: string,
  cause: unknown,
  scrub: (text: string) => string = (text) => text,
  shown: string = redactUrl(url),
): JobsucheError {
  const sent = redactUrl(url);
  const named = (text: string): string => scrub(sent === shown ? text : text.split(sent).join(shown));
  if (cause instanceof JobsucheNetworkError) {
    // The default transport's own errors (a timeout, the size cap, a refused connection,
    // a DNS failure) and exchange()'s deadline and size cap carry no URL: name the
    // request, as for a reset, with the original as the cause. One that names it
    // already (followedElsewhere) is passed on, scrubbed.
    const message = named(cause.message);
    const prefix = `${method} ${shown} failed: `;
    // The size cap keeps its class (and the cap): the API answered, which the CLI says.
    const rebuilt = (text: string, options?: { cause?: unknown }): JobsucheNetworkError =>
      cause instanceof JobsucheResponseTooLargeError
        ? new JobsucheResponseTooLargeError(text, cause.maxResponseBytes, options)
        : new JobsucheNetworkError(text, options);
    if (message.startsWith(prefix)) {
      const inner = scrubCause(cause.cause, scrub);
      if (message === cause.message && inner === cause.cause) return cause;
      return rebuilt(message, inner === undefined ? undefined : { cause: inner });
    }
    return rebuilt(`${prefix}${message}`, { cause: scrubCause(cause, scrub) });
  }
  if (cause instanceof JobsucheError) return cause;
  const reason =
    cause instanceof Error && cause.message.trim() !== ""
      ? cause.message
      : typeof cause === "string" && cause.trim() !== ""
        ? cause
        : "the transport failed without a message";
  return new JobsucheNetworkError(
    `${method} ${shown} failed: ${sanitizeServerText(named(redactUrl(reason)))}`,
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
  /**
   * Secrets without an `@` to anchor on, as `#scrub` replaces them: the API key (the whole value
   * of a credential header, and its secret part after a scheme such as `Bearer`) and the forms a
   * server echoes the base URL's userinfo in (the Basic value, in Latin-1 as the engine sends it
   * and in UTF-8 as most servers spell it, the decoded `user:password`, the password alone;
   * `echoedCredentialForms`), each also percent-encoded as in a URL, longest first.
   */
  readonly #secrets: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;
  private readonly onWarning: ((message: string) => void) | undefined;
  /** `EngineOptions.bigIntegerKeys`, copied. */
  readonly bigIntegerKeys: ReadonlySet<string>;

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
    // The userinfo as typed and as sent (WHATWG percent-encodes some of its characters: a server
    // that echoes the request URL echoes that spelling).
    const userinfos = [...new Set([...credentialsIn(this.#baseUrl), ...credentialsIn(new URL(this.#baseUrl).href)])];
    // A credential header's value whole (an X-API-Key with an inner space included) and its
    // secret part (`Bearer <token>` → the token). And the forms a server echoes a base URL's
    // userinfo in: the Basic value (Latin-1 as the engine sends it, UTF-8 as Node's http and
    // most servers spell it), the decoded `user:password`, the password alone. Each also as a
    // URL spells it (a redirect's Location).
    const echoed = userinfos.map(echoedCredentialForms);
    this.#secrets = [
      ...new Set(
        Object.entries(this.#defaultHeaders)
          .filter(([name]) => CREDENTIAL_HEADERS.has(name.toLowerCase()))
          .flatMap(([, value]) => [value.trim(), value.replace(/^\S+\s+(?=\S)/, "").trim()])
          .concat(echoed.flat())
          .concat(echoed.flatMap(([, pair]) => (pair === undefined ? [] : [Buffer.from(pair, "utf8").toString("base64")])))
          .flatMap(urlSpellings),
      ),
    ]
      // Longest first, so a password never leaves half of the user:password around it.
      .sort((a, b) => b.length - a.length);
    this.#scrub = secretScrubber(userinfos, this.#secrets);
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
    this.onRetry =
      options.onRetry === undefined ? undefined : functionOption("onRetry", options.onRetry, () => {});
    this.onWarning =
      options.onWarning === undefined ? undefined : functionOption("onWarning", options.onWarning, () => {});
    this.bigIntegerKeys = bigIntegerKeysOption(options.bigIntegerKeys);
  }

  /** Tell `onWarning` about an answer delivered changed. A throwing callback never breaks the request. */
  private warn(message: string): void {
    try {
      this.onWarning?.(message);
    } catch {
      // a logging hook is no reason to fail the request
    }
  }

  /**
   * Tell `onRetry` about a retry (`url` as messages show it: userinfo redacted, after a redirect
   * the credentials and the key echoed in it scrubbed), then wait. A throwing callback never
   * breaks the request.
   */
  private async backOff(attempt: number, delayMs: number, url: string, status?: number): Promise<void> {
    try {
      this.onRetry?.({
        retry: attempt,
        maxRetries: this.maxRetries,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        url,
      });
    } catch {
      // a logging hook is no reason to fail the request
    }
    await this.sleep(delayMs);
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * The request URL as error messages show it: absolute (so a message names the host
   * that gave a bad answer, which matters with a custom base URL), userinfo redacted
   * and cut at 500 characters.
   */
  describeUrl(path: string, query?: QueryParams): string {
    return cutForMessage(redactUrl(this.buildUrl(path, query)), MAX_DETAIL_LENGTH);
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
    // The URL as messages name it: after a redirect, the Location as the server sent it with the
    // credentials and the key scrubbed, then resolved (`shownTarget`). Resolving first would
    // percent-encode an echoed password in a new spelling (`'` as `%27` in a query) no scrub matches.
    let shown = redactUrl(url);

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
          await this.backOff(attempt, this.retryDelayMs * attempt, shown);
          continue;
        }
        throw networkError(method, url, cause, this.#scrub, shown);
      }
      const elsewhere = followedElsewhere(method, url, response.url);
      if (elsewhere !== undefined) throw networkError(method, url, elsewhere, this.#scrub, shown);

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
          await this.backOff(attempt, retryAfter === undefined ? backoff : Math.max(retryAfter, backoff), shown, status);
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
        throw this.toApiError(method, shown, status, response.body, { location, redirectsFollowed: redirects || undefined, dropped });
      }
      if (next !== undefined) {
        // SECURITY: the credentials belong to the start URL's origin. A redirect to
        // another scheme, host or port drops them for the rest of the chain — http→https
        // on the same host included, as the key must not be re-sent on a hop the user
        // did not choose. A Location's own userinfo is never used.
        next.username = "";
        next.password = "";
        if (hasCredentials && dropped === undefined && next.origin !== credentialOrigin) {
          dropped = { from: originOf(url) ?? "", to: sanitizeServerText(this.#scrub(next.origin)) };
        }
        shown = this.shownTarget(location as string, shown);
        url = next.href;
        redirects += 1;
        continue;
      }
      // Any other 3xx — not a followed status, or no usable Location — falls
      // through and surfaces as a JobsucheApiError naming the target.

      // Scrubbed at the source: it is the server's, and a message may quote it (or its charset).
      const contentType = this.#scrub(String(headerValue(response.headers["content-type"]) ?? ""));
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, shown, status, response.body, { location, dropped, retryAfterMs: retryAfterTooLong });
      }

      return { data: response.body, contentType, status, url, ...(dropped !== undefined ? { credentialsDropped: dropped } : {}) };
    }
  }

  /**
   * Perform a GET expecting JSON and parse it into `T`. Every error about the answer names
   * the request (`GET <url>: …`, userinfo redacted).
   *
   * The text is never changed silently: bytes that are not valid in the charset, and lone
   * surrogates written as JSON escapes (`\ud800`), are replaced with U+FFFD, so the result is
   * well-formed text (`jq` rejects a lone surrogate, and with it the whole output), and
   * `onWarning` is told how many. One bad character never sinks a whole answer.
   */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const request = `GET ${this.describeUrl(path, query)}`;
    const decoded = decodeBody(res.data, res.contentType, request);
    const text = decoded.text;
    // Guard against a 200 that is not actually JSON (e.g. an HTML error/landing
    // page from a misconfigured --base-url that resolves to an unexpected host).
    // Inspecting the Content-Type yields a clearer message than a raw parse error.
    const isJsonType = /\bjson\b/i.test(res.contentType);
    if (!isJsonType && res.contentType) {
      // Both the echoed Content-Type and the body snippet are server-controlled and
      // are printed to stderr by run.ts; strip control chars so a hostile endpoint
      // cannot inject terminal escape sequences via the parse-error message.
      // Scrubbed before the cut, so a secret straddling it leaves no prefix.
      const snippet = sanitizeServerText(cutText(this.#scrub(text), 200));
      throw new JobsucheParseError(
        `${request}: expected a JSON answer, got Content-Type "${cutForMessage(sanitizeServerText(res.contentType))}".`,
        { cause: snippet ? new Error(snippet) : undefined },
      );
    }
    // A broken answer, not "no results": printed as nothing with exit 0, it would let a
    // script carry on as if the API had found nothing.
    if (text.trim() === "") throw new JobsucheParseError(`${request}: empty response body.`);
    const repaired = wellFormedEscapes(text);
    // Declared big integers are quoted first, so JSON.parse delivers them exactly.
    const { json, inexact } = scanNumbers(repaired.json, this.bigIntegerKeys);
    let parsed: T;
    try {
      parsed = JSON.parse(json) as T;
    } catch (cause) {
      throw new JobsucheParseError(`${request}: the answer is not valid JSON.`, { cause: scrubCause(cause, this.#scrub) });
    }
    // JSON.parse rounds and overflows numbers silently: refuse the answer rather than
    // hand on a changed value.
    if (inexact !== undefined) {
      throw new JobsucheParseError(`${request}: the number ${cutForMessage(this.#scrub(inexact))} cannot be represented exactly.`);
    }
    const replaced = decoded.replaced + repaired.replaced;
    if (replaced > 0) {
      this.warn(
        `${request}: ${replaced} ${replaced === 1 ? "character" : "characters"} of the answer ${replaced === 1 ? "was" : "were"} ` +
          "not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.",
      );
    }
    return parsed;
  }

  /** Perform a GET returning the raw bytes (image / binary downloads). */
  async getRaw(path: string, accept: string, query?: QueryParams): Promise<RawResponse> {
    return this.request("GET", path, { query, accept });
  }

  /**
   * An error body, already scrubbed as sent, as `JobsucheApiError.body` keeps it: when it is
   * JSON with an escape in it, checked decoded too. An escape (`\"`, `\u00e4`) hides an echoed
   * credential or API key from the scrub of the text as sent, while a caller who parses the body
   * sees it. Such a body is kept as the decoded JSON written again (`JSON.stringify`, one spelling
   * per character) with the secret scrubbed in that spelling. A body that doesn't parse is text
   * nobody decodes, and stays as sent; one too deeply nested to write again is left out ("").
   */
  private scrubBody(scrubbed: string): string {
    if (this.#secrets.length === 0 || !scrubbed.includes("\\")) return scrubbed;
    let decoded: unknown;
    try {
      decoded = JSON.parse(scrubbed);
    } catch {
      return scrubbed;
    }
    let rewritten: string;
    try {
      rewritten = JSON.stringify(decoded);
    } catch {
      return "";
    }
    const spelled = this.#secrets.map((form) => JSON.stringify(form).slice(1, -1));
    return spelled.some((form) => form.trim().length >= 4 && rewritten.includes(form)) ? redactSecrets(rewritten, spelled) : scrubbed;
  }

  /**
   * `value`, a string from an answer, with the base URL's credentials and the API key replaced by
   * `***`: a 2xx answer can echo them as well as an error body. API code puts a server value into
   * a message or an error's fields with this, and quotes it with {@link quoteServerValue}.
   */
  scrubServerValue(value: string): string {
    return this.#scrub(value);
  }

  /**
   * A value from an answer quoted for an error message (`quoteValue`, cut at `max` characters),
   * the base URL's credentials and the API key scrubbed first, before the cut, so no part of one
   * stays. API code quotes server values with this.
   */
  quoteServerValue(value: string, max?: number): string {
    return quoteValue(this.#scrub(value), max);
  }

  /**
   * A redirect's `Location` as messages name it: the credentials and the API key scrubbed as sent,
   * before resolving it against `from` (the current request as shown) percent-encodes what is
   * left of them in a new spelling; then userinfo redacted and control and format characters
   * dropped (`sanitizeServerText`). A value that doesn't resolve is shown cleaned as it came.
   */
  private shownTarget(location: string, from: string): string {
    const sent = this.#scrub(location);
    let target: string;
    try {
      target = redactUrl(new URL(sent, from).href);
    } catch {
      target = redactUrl(sent);
    }
    return sanitizeServerText(target);
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
    // The body is server text: an error page may echo the request URL or its headers. One too
    // large to be a string (maxResponseBytes lifted) is left out: the status is the error.
    let raw = "";
    try {
      raw = body.toString("utf8");
    } catch (err) {
      if (!isStringTooLong(err)) throw err;
    }
    const text = this.#scrub(raw);
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
    // cannot inject terminal escape sequences via that message. It is scrubbed again once
    // decoded: a JSON-escaped echo (`\"`, `\u00e4`) of a credential or the API key passed the
    // scrub of the body as sent.
    if (detail !== undefined) detail = cleanDetail(this.#scrub(detail));
    // Name the target of a redirect that was not followed.
    const location =
      status >= 300 && status < 400 && locationHeader ? this.shownTarget(locationHeader, url) || undefined : undefined;
    return new JobsucheApiError({
      status,
      url,
      method,
      body: this.scrubBody(text),
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
 * is a `JobsucheParseError` naming it and `request` (`GET <url>`). Bytes that are not
 * valid in the charset become U+FFFD, and `replaced` counts them: exactly for UTF-8 and the
 * single-byte charsets; for UTF-16 a U+FFFD the server sent counts too. Shared with obtainKey().
 */
export function decodeBody(body: Buffer, contentType: string, request: string): { text: string; replaced: number } {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset, { fatal: true });
  } catch {
    throw new JobsucheParseError(`${request}: unsupported response charset "${cutForMessage(sanitizeServerText(charset))}".`);
  }
  try {
    return { text: decoder.decode(body), replaced: 0 };
  } catch (err) {
    if (isStringTooLong(err)) throw tooLargeForText(request, body);
    // Not valid in the charset: decode with replacement, and count what was replaced.
    let text: string;
    try {
      text = new TextDecoder(decoder.encoding).decode(body);
    } catch (again) {
      if (isStringTooLong(again)) throw tooLargeForText(request, body);
      throw again;
    }
    const sent = decoder.encoding === "utf-8" ? countBytes(body, REPLACEMENT_UTF8) : 0;
    return { text, replaced: countChar(text, 0xfffd) - sent };
  }
}

/** V8's longest string (2^29 − 24 characters on 64-bit). */
const MAX_STRING_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * True for V8's error for a string past its longest one (2^29 − 24 characters on 64-bit): a body
 * of 512 MB and more, possible once `maxResponseBytes` is lifted, can't be decoded into one.
 */
function isStringTooLong(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ERR_STRING_TOO_LONG";
}

/** The parse error for a body too large to decode: it used to escape as a plain Error ("Unexpected error"). */
function tooLargeForText(request: string, body: Buffer): JobsucheParseError {
  return new JobsucheParseError(
    `${request}: the answer is too large to read as text (${body.byteLength} bytes; the longest string is ${MAX_STRING_LENGTH} characters).`,
  );
}

/** U+FFFD in UTF-8. */
const REPLACEMENT_UTF8 = Buffer.from([0xef, 0xbf, 0xbd]);

/** How often `needle` occurs in `body`. */
function countBytes(body: Buffer, needle: Buffer): number {
  let n = 0;
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** How often the UTF-16 unit `code` occurs in `text`. */
function countChar(text: string, code: number): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === code) n++;
  return n;
}

/** A JSON escape of a surrogate, `\uD800`–`\uDFFF`, anywhere in a text (a cheap pre-check). */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** The value of the four hex digits of a `\uXXXX` escape whose `u` is at `at`, or -1. */
function escapeAt(json: string, at: number): number {
  if (json.charCodeAt(at) !== 0x75) return -1;
  const hex = json.slice(at + 1, at + 5);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : -1;
}

/**
 * `json` (decoded answer text) with every lone surrogate written as a JSON escape (`\ud800` not
 * followed by a low-surrogate escape, or a `\udc00` not preceded by a high one) rewritten as
 * `\ufffd`, and how many. JSON.parse would make such an escape half a character, which a JSON
 * printer writes back as `\ud800` and `jq` refuses (the whole output with it). A raw lone
 * surrogate cannot occur: TextDecoder never makes one. One linear pass, and only when the text
 * holds a surrogate escape at all; the text is copied only when one is lone.
 */
function wellFormedEscapes(json: string): { json: string; replaced: number } {
  if (!SURROGATE_ESCAPE.test(json)) return { json, replaced: 0 };
  const out = new TextBuilder();
  let copied = 0;
  let replaced = 0;
  for (let i = 0; i < json.length; i++) {
    if (json.charCodeAt(i) !== 0x5c) continue;
    const code = escapeAt(json, i + 1);
    if (code < 0xd800 || code > 0xdfff) {
      i++; // an escape of another kind (\", \\, \n, \u0041): skip its second character
      continue;
    }
    const pairedLow = code <= 0xdbff && json.charCodeAt(i + 6) === 0x5c && isLowSurrogate(escapeAt(json, i + 7));
    if (pairedLow) {
      i += 11;
      continue;
    }
    out.push(json.slice(copied, i), "\\ufffd");
    copied = i + 6;
    replaced++;
    i += 5;
  }
  if (replaced === 0) return { json, replaced };
  out.push(json.slice(copied));
  return { json: out.toString(), replaced };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
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

/** A JSON number token, matched at a given position (sticky). */
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The smallest positive normal double, 2^-1022. Below it a double has fewer significant digits. */
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * Whether the double `value` (finite) prints as the number `literal` wrote, checked where a
 * double can be off in its leading digits: past 2^53, where every double is an integer, at 0,
 * which a literal too small for a double becomes, and below the smallest normal double, where a
 * subnormal has fewer significant digits (`3e-324` becomes `5e-324`). There the CLI prints
 * `String(value)`, the shortest decimal that reads back as the same double: `12345678901234567890`
 * prints as `12345678901234567000`, a changed value, while `1E23`, `1.7976931348623157E308` or
 * `5e-324` (a double a server printed in its own shortest form) print as the same number.
 */
function exactAtTheEdges(literal: string, value: number): boolean {
  const size = Math.abs(value);
  if (value !== 0 && size <= Number.MAX_SAFE_INTEGER && size >= MIN_NORMAL) return true;
  const written = decimalOf(literal);
  if (value === 0) return written.digits === "";
  const printed = decimalOf(String(value));
  return written.negative === printed.negative && written.digits === printed.digits && written.exponent === printed.exponent;
}

/** A decimal literal as sign, significant digits (no leading or trailing zeros) and exponent: digits × 10^exponent. */
function decimalOf(text: string): { negative: boolean; digits: string; exponent: number } {
  const [, sign = "", whole = "", fraction = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) ?? [];
  // The zeros are counted with index loops: `/0+$/` tried a match at every zero of a run that
  // doesn't end the text, quadratic in the run, and one `1.<64 000 zeros>1e300` in an answer held
  // the CLI for seconds, past --timeout (the scan runs once the answer is in).
  const all = whole + fraction;
  let start = 0;
  while (start < all.length && all.charCodeAt(start) === 0x30) start++;
  let end = all.length;
  while (end > start && all.charCodeAt(end - 1) === 0x30) end--;
  return { negative: sign === "-", digits: all.slice(start, end), exponent: Number(exp) - fraction.length + (all.length - end) };
}

/** A JSON number token as the grammar allows it, matched at a given position (sticky). */
const STRICT_JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** What {@link scanNumbers} found in a JSON text. */
interface NumberScan {
  /** The text with each declared member's number value quoted; the input itself when there was none. */
  json: string;
  /** The first undeclared number literal JSON.parse cannot carry exactly, or undefined. */
  inexact: string | undefined;
}

/** Whether the member name `json` holds between `start` and `end` (its quotes) is one of `keys`, compared in place. */
function isDeclared(json: string, start: number, end: number, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (end - start - 1 === key.length && json.startsWith(key, start + 1)) return true;
  }
  return false;
}

/** The index of the first character at or after `i` that is not JSON whitespace. */
function skipSpace(json: string, i: number): number {
  for (; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
  }
  return i;
}

/**
 * One linear pass over `json` (the text of an answer) that skips strings and looks at every
 * number literal:
 * - the value of a member named in `bigIntegerKeys` is quoted, as written (`"_version_":
 *   1858054135406919680` becomes `"_version_":"1858054135406919680"`), so JSON.parse delivers
 *   it exactly as a string, whatever its size. Only a literal the JSON grammar allows is quoted,
 *   so a malformed one (`01`) still fails JSON.parse;
 * - any other number is checked as {@link firstInexactNumber} says, and the first one JSON.parse
 *   cannot carry exactly is reported in `inexact`.
 * Nothing is allocated per value: a member name is compared in place (only a name written with
 * an escape is decoded), and the text is copied only when a declared member is found. No
 * reviver, which would recurse per nesting level and overflow on deep data.
 */
export function scanNumbers(json: string, bigIntegerKeys: ReadonlySet<string> = NO_KEYS): NumberScan {
  const keys = bigIntegerKeys.size === 0 ? undefined : [...bigIntegerKeys];
  let inexact: string | undefined;
  let out: TextBuilder | undefined;
  let copied = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c === 0x22) {
      // a string: skip to its closing quote, past escapes
      const start = i;
      let escaped = false;
      for (i++; i < json.length; i++) {
        const d = json.charCodeAt(i);
        if (d === 0x5c) {
          escaped = true;
          i++;
        } else if (d === 0x22) break;
      }
      if (keys === undefined) continue;
      // A member name is a string followed by a colon; is it a declared one with a number value?
      const colon = skipSpace(json, i + 1);
      if (json.charCodeAt(colon) !== 0x3a) continue;
      if (!(escaped ? bigIntegerKeys.has(decodedName(json.slice(start, i + 1))) : isDeclared(json, start, i, keys))) continue;
      const at = skipSpace(json, colon + 1);
      STRICT_JSON_NUMBER.lastIndex = at;
      const literal = STRICT_JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      out ??= new TextBuilder();
      out.push(json.slice(copied, at), '"', literal, '"');
      copied = at + literal.length;
      i = copied - 1;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      JSON_NUMBER.lastIndex = i;
      const literal = JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      const value = Number(literal);
      if (inexact === undefined && (!Number.isFinite(value) || !exactAtTheEdges(literal, value))) {
        inexact = literal;
        if (keys === undefined) break;
      }
      i += literal.length - 1;
    }
  }
  if (out === undefined) return { json, inexact };
  out.push(json.slice(copied));
  return { json: out.toString(), inexact };
}

/** A member name written with an escape, decoded; a name JSON.parse can't read matches nothing. */
function decodedName(quoted: string): string {
  try {
    return String(JSON.parse(quoted));
  } catch {
    return "";
  }
}

/**
 * The first number literal in `json` (JSON that parsed) that JSON.parse cannot carry exactly, or
 * undefined: one out of a double's range (`1e400` became Infinity, printed as `null`), one past
 * 2^53 that it rounds, in any form (`12345678901234567890`, `12345678901234567890.0`,
 * `9007199254740993e0`, `9007199254740992.5`), a non-zero one too small for a double
 * (`1e-400` became 0), and a subnormal one that does not print as written (`3e-324` became
 * `5e-324`). Below 2^53 and above the subnormal range a decimal fraction keeps a double's usual
 * precision, as JSON means it. {@link scanNumbers} without declared members.
 */
export function firstInexactNumber(json: string): string | undefined {
  return scanNumbers(json).inexact;
}

/** No declared big-integer members (`EngineOptions.bigIntegerKeys` left out). */
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Read the `bigIntegerKeys` option: `undefined` gives none; a set or list of non-empty strings is
 * copied; anything else throws a JobsucheValidationError.
 */
export function bigIntegerKeysOption(value: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (value === undefined) return NO_KEYS;
  const iterable = typeof value === "object" && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
  const names = iterable ? [...(value as Iterable<unknown>)] : [];
  if (!iterable || names.some((key) => typeof key !== "string" || key === "")) {
    throw new JobsucheValidationError("Invalid bigIntegerKeys: Expected a set of non-empty member names.");
  }
  return new Set(names as string[]);
}
