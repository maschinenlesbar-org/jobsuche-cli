// Input validation shared by the library and the CLI. Every rule about what a
// request may contain lives in src/client as a pure `…Problem(value)` function: it
// returns the reason a value is invalid, or undefined when the value is fine. The
// client enforces a rule with assertValid before any request; the CLI's commander
// value-parsers call the same function and turn the reason into a usage error, so
// the rule exists exactly once.

import { JobsucheValidationError, cutText, quoteValue, redactUrl } from "./errors.js";
import type { JobSearchParams } from "./types.js";

/** Why `value` is invalid, or `undefined` if it is valid. */
export type Problem<T = string> = (value: T) => string | undefined;

/**
 * Throw a JobsucheValidationError (`Invalid <name>: <reason>`) when `problem`
 * finds something wrong with `value`; otherwise return `value` unchanged.
 *
 * Client methods that return a promise call this inside an `async` body, so a
 * rejected input surfaces as a rejected promise rather than a synchronous throw,
 * and no request is sent. Constructors call it directly and throw.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) {
    throw new JobsucheValidationError(`Invalid ${name}: ${reason}`);
  }
  return value;
}

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which URLSearchParams would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it is empty, or holds only whitespace,
 * control and format characters (a zero-width space, a soft hyphen) and combining marks. Such
 * a value reads as "no filter" upstream, or matches nothing, so it is refused as blank.
 */
export function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be sent as a text filter, or undefined when it can. Refused, before any
 * request, as the API would match nothing or everything:
 * - a value that is blank once trimmed (Unicode whitespace, U+00A0 included), or that holds only
 *   invisible characters and combining marks (`isBlank`): an empty filter reads as "no filter"
 *   upstream, which answers with the whole unfiltered set;
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the search find
 *   nothing.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Must not be blank.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is an id, a code or
 * a parameter name: a value the API compares exactly. The rules apply to the value with
 * surrounding whitespace trimmed, as it is sent ({@link normalizeToken}): not blank (and not only
 * invisible characters or combining marks), no lone surrogate, and no control or format character
 * at all (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an invisible character in
 * an id only ever makes it match nothing. The reason quotes the value visibly.
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Must not be blank.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list value, as typed: each item is checked (`listProblem`) and
 * canonicalised (`normalizeToken`) on its own, so `"a1, a2"` sends `a2`, and `"a1,,a2"`, `"a1,"`
 * and `","` are refused rather than sent as an empty item (which an API may read as "no
 * filter"). This API takes no list; exported for library callers, as the kit has it.
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all (an empty list reads as "no filter"), or an item that `itemProblem` refuses (by
 * default {@link tokenProblem}: a blank item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

/**
 * A free-text value as the API should get it: without surrounding whitespace (U+00A0
 * and U+3000 included; a value pasted with a trailing space or newline) and in composed
 * Unicode, NFC (a decomposed "München", u plus U+0308 as pasted from a macOS file name).
 * Inner whitespace is kept. Applied to the text filters (`TEXT_FILTERS`: `was`, `wo`,
 * `berufsfeld`, `arbeitgeber`) and to the string value of a parameter sent with
 * `allowUnknownParams` by `normalizeSearchParams`; the reference number goes out as
 * `normalizeToken` makes it (the same, checked as a token). Check it with
 * {@link textProblem} first.
 */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * Search parameters with each text filter (`TEXT_FILTERS`) that is a string, and the string
 * value of every other parameter (one sent with `allowUnknownParams`), in its canonical form
 * (normalizeText); everything else unchanged. Returns a new object, or `params` itself when it
 * is not an object (validateSearchParams then refuses it). `search()` applies it before
 * validateSearchParams, so a value that is blank once trimmed is still refused before any
 * request.
 */
export function normalizeSearchParams(params: JobSearchParams): JobSearchParams {
  if (!isPlainObject(params as unknown)) return params;
  const out: JobSearchParams = { ...params };
  for (const [name, value] of Object.entries(params as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    // A name from the caller's object: defined, never assigned, so `__proto__` stays an own
    // key (validateSearchParams refuses it) and never becomes the prototype.
    Object.defineProperty(out, name, { value: normalizeText(value), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * A blank value ("" or whitespace, often an unset shell variable or an empty form
 * field) is invalid: the API treats a missing filter as no filter, so a blank
 * filter would silently widen the search or run it unfiltered.
 */
export const nonBlankProblem: Problem = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  return isBlank(value) ? "Must not be blank." : undefined;
};

/**
 * An integer in min..max: a safe integer (NaN, Infinity and fractions are
 * invalid). The reasons match the CLI's integer parsers: "Expected a non-negative
 * integer." for a non-integer (or a negative value when min is 0), else
 * "Must be >= min." / "Must be <= max.".
 */
export function intRangeProblem(min: number, max: number): Problem<number> {
  return (n) => {
    if (typeof n !== "number" || !Number.isSafeInteger(n) || (min === 0 && n < 0)) {
      return "Expected a non-negative integer.";
    }
    if (n < min) return `Must be >= ${min}.`;
    if (n > max) return `Must be <= ${max}.`;
    return undefined;
  };
}

/**
 * The upper bound for `veroeffentlichtseit` (days). The API silently ignores a
 * larger value and returns the unfiltered set.
 */
export const MAX_VEROEFFENTLICHT_SEIT = 100;

/**
 * The largest `umkreis` (km) the API takes: 200 is answered, 201 and above get HTTP
 * 400 `umkreis: Wert ungültig` (checked live 2026-10-05).
 */
export const MAX_UMKREIS = 200;

/**
 * The documented `angebotsart` codes: 1 Arbeit (job), 2 Selbstständigkeit
 * (self-employment), 4 Ausbildung / Duales Studium (apprenticeship / dual study),
 * 34 Praktikum / Trainee (internship / trainee). Any other code returns an empty
 * result (live: angebotsart=3 → maxErgebnisse 0), which reads as "nothing there".
 */
export const ANGEBOTSART_CODES = [1, 2, 4, 34] as const;

/** One of the documented offer-type codes (ANGEBOTSART_CODES). */
export type Angebotsart = (typeof ANGEBOTSART_CODES)[number];

/** `angebotsart` must be one of ANGEBOTSART_CODES. */
export const angebotsartProblem: Problem<number> = (code) =>
  (ANGEBOTSART_CODES as readonly unknown[]).includes(code)
    ? undefined
    : `Unknown code ${code}: valid codes are ${ANGEBOTSART_CODES.join(", ")} ` +
      "(1 job, 2 self-employment, 4 apprenticeship/dual study, 34 internship/trainee).";

/** The numeric search parameters and their rules. */
const NUMERIC_PARAMS: ReadonlyArray<[keyof JobSearchParams, Problem<number>]> = [
  ["umkreis", intRangeProblem(0, MAX_UMKREIS)],
  ["veroeffentlichtseit", intRangeProblem(0, MAX_VEROEFFENTLICHT_SEIT)],
  ["angebotsart", angebotsartProblem],
  ["page", intRangeProblem(1, Number.MAX_SAFE_INTEGER)],
  ["size", intRangeProblem(0, Number.MAX_SAFE_INTEGER)],
];

/**
 * A value that can be sent in an HTTP header (User-Agent, any defaultHeaders
 * value): not blank, no C0 control character other than tab, no DEL, nothing
 * above U+00FF. Node's HTTP layer would otherwise refuse it at request time, and
 * a custom transport would receive a CR/LF that injects a header. Checked by char
 * code so the source stays free of control bytes.
 */
export const headerValueProblem: Problem = (value) => {
  const blank = nonBlankProblem(value);
  if (blank !== undefined) return blank;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/**
 * An absolute http(s) URL, checked on the RAW value: new URL() silently trims
 * surrounding whitespace and drops tab/CR/LF, but the engine appends request
 * paths to the raw string, so a padded value would request `/%20/...` or reach a
 * custom transport unparsed. Userinfo is allowed, but a "%" in it must start a
 * valid escape (`%25` for a literal one); it is redacted from the reasons.
 */
export const httpUrlProblem: Problem = (value) => {
  if (typeof value !== "string") return "Expected an absolute http(s) URL.";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return "A base URL cannot contain whitespace or control characters.";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `Invalid URL: ${quoteValue(redactUrl(value))}.`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported protocol ${quoteValue(url.protocol)} (use http: or https:).`;
  }
  // The userinfo is decoded for the Authorization header; a "%" that isn't an escape
  // would only fail at request time ("URI malformed"), as a network error.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};

/**
 * A base URL (`baseUrl`, `--base-url`): an http(s) URL (httpUrlProblem) without a
 * query or fragment. Request paths are appended to the base URL as a string, so a
 * query would end up in front of them and a fragment would swallow the path and
 * every filter.
 */
export const baseUrlProblem: Problem = (value) => {
  const problem = httpUrlProblem(value);
  if (problem !== undefined) return problem;
  return /[?#]/.test(value) ? "A base URL cannot have a query (?) or fragment (#)." : undefined;
};

/** An HTTP header name: an RFC 9110 token. */
export const headerNameProblem: Problem = (name) =>
  typeof name === "string" && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
    ? undefined
    : "Expected an HTTP header name (letters, digits and !#$%&'*+-.^_`|~).";

/** The free-text search filters, which must not be blank when given. */
export const TEXT_FILTERS = ["was", "wo", "berufsfeld", "arbeitgeber"] as const;

/** Every parameter `search()` takes (JobSearchParams). */
export const SEARCH_PARAMS = [
  ...TEXT_FILTERS,
  "umkreis",
  "veroeffentlichtseit",
  "zeitarbeit",
  "angebotsart",
  "page",
  "size",
] as const;

/** Options for `search()`. */
export interface SearchOptions {
  /**
   * Send parameter names that are not in `SEARCH_PARAMS` — for a filter the API
   * offers that this client does not model (its facets show `befristung`,
   * `arbeitszeit`, …). Default `false`: an unknown name is rejected, because the API
   * ignores one it doesn't know (a typo such as `wos`) and returns the unfiltered set.
   * Such a value must still be a string, a finite number or a boolean.
   */
  allowUnknownParams?: boolean | undefined;
}

/**
 * Why `key` is not a search parameter, or undefined. `__proto__` and `constructor`
 * are never parameters (a `JSON.parse`d object can carry them as own keys).
 */
export function searchParamKeyProblem(key: string, allowUnknown = false): string | undefined {
  if ((SEARCH_PARAMS as readonly string[]).includes(key)) return undefined;
  if (key === "__proto__" || key === "constructor" || key === "prototype") return `${quoteValue(key)} is not a search parameter.`;
  if (allowUnknown) return undefined;
  return (
    `Unknown search parameter ${quoteValue(key)} (the API ignores it and returns the unfiltered set). ` +
    `Known: ${SEARCH_PARAMS.join(", ")}; pass { allowUnknownParams: true } to send it anyway.`
  );
}

/**
 * Check search parameters before any request. `undefined` (or `null`) means "not
 * set". A given `was`, `wo`, `berufsfeld` or `arbeitgeber` must be text (textProblem: not
 * blank, nothing invisible): leave a filter out to search without it. An unknown parameter's
 * name must be a token and its string value text. `umkreis` must be an
 * integer 0..MAX_UMKREIS (200), `size` a non-negative integer, `veroeffentlichtseit` an integer
 * 0..MAX_VEROEFFENTLICHT_SEIT, `angebotsart` one of ANGEBOTSART_CODES and `page`
 * an integer >= 1 (the API answers `page=0` with HTTP 400), `zeitarbeit` a boolean;
 * `params` itself must be an object, and every key one of `SEARCH_PARAMS` unless
 * `options.allowUnknownParams` is set (`__proto__` and `constructor` never). Throws
 * a JobsucheValidationError naming the parameter; returns `params` unchanged.
 */
export function validateSearchParams(params: JobSearchParams, options: SearchOptions = {}): JobSearchParams {
  // A JavaScript caller may pass anything; a string or a number used to be read as
  // "no filters" and run the search unfiltered.
  if (!isPlainObject(params as unknown)) {
    throw new JobsucheValidationError("Invalid search parameters: Expected an object of parameters.");
  }
  if (!isPlainObject((options ?? {}) as unknown)) {
    throw new JobsucheValidationError("Invalid search options: Expected an object, e.g. { allowUnknownParams: true }.");
  }
  const allowUnknown = options?.allowUnknownParams === true;
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    const problem = searchParamKeyProblem(key, allowUnknown);
    if (problem !== undefined) throw new JobsucheValidationError(`Invalid search parameter: ${problem}`);
    if ((SEARCH_PARAMS as readonly string[]).includes(key)) continue;
    // An unknown parameter sent on request: its name a token, one scalar as for the known ones,
    // a string value text.
    const name = tokenProblem(key);
    if (name !== undefined) throw new JobsucheValidationError(`Invalid search parameter: ${name}`);
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      assertValid(key, value, textProblem);
    } else if (typeof value !== "boolean" && !Number.isFinite(value)) {
      throw new JobsucheValidationError(`Invalid ${key}: Expected one non-blank string, a finite number or a boolean.`);
    }
  }
  for (const name of TEXT_FILTERS) {
    const value = params[name];
    if (value !== undefined && value !== null) assertValid(name, value, textProblem);
  }
  for (const [name, problem] of NUMERIC_PARAMS) {
    const value = params[name];
    if (value !== undefined && value !== null) assertValid(name, value as number, problem);
  }
  // A string such as "false" or "nein" was sent as given.
  if (params.zeitarbeit !== undefined && params.zeitarbeit !== null && typeof params.zeitarbeit !== "boolean") {
    throw new JobsucheValidationError("Invalid zeitarbeit: Expected true or false.");
  }
  return params;
}

/** True for a non-null object that is not an array (a JSON object). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The text an error envelope carries (`message`, `error`, `detail`, or the gateway's
 * `messages[].detail`), cut to 200 characters (never inside a surrogate pair), for a parse error to quote; undefined
 * when there is none. Server text: control characters are stripped by the caller.
 */
function envelopeText(value: Record<string, unknown>): string | undefined {
  for (const key of ["message", "error", "detail"]) {
    const v = value[key];
    if (typeof v === "string" && v.trim() !== "") return cutText(v.trim(), 200);
  }
  const messages = value["messages"];
  if (Array.isArray(messages)) {
    const texts = messages
      .map((m) => (isPlainObject(m) && typeof m["detail"] === "string" ? m["detail"] : undefined))
      .filter((t): t is string => t !== undefined && t.trim() !== "");
    if (texts.length > 0) return cutText(texts.join("; "), 200);
  }
  return undefined;
}

/**
 * Why a 2xx body is not a `/pc/v6/jobs` search result, or undefined. The documented
 * shape: a JSON object with `maxErgebnisse` (a non-negative integer, present even
 * when nothing matched), `ergebnisliste` absent or an array of listings that each
 * have a string `referenznummer`, and `page`/`size` numbers and `woOutput`/
 * `facetten` objects when present. `null`, `{}`, an array or an error envelope
 * (`{"message": "quota exceeded"}` from a proxy) is not "nothing found".
 */
export const searchResultProblem: Problem<unknown> = (value) => {
  if (!isPlainObject(value)) return `expected a JSON object, got ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}`;
  const said = envelopeText(value);
  const max = value["maxErgebnisse"];
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 0) {
    return `no maxErgebnisse count${said !== undefined ? `; the server said: ${said}` : ""}`;
  }
  const list = value["ergebnisliste"];
  if (list !== undefined) {
    if (!Array.isArray(list)) return "ergebnisliste is not an array";
    if (!list.every((item) => isPlainObject(item) && typeof item["referenznummer"] === "string")) {
      return "a listing in ergebnisliste has no referenznummer";
    }
  }
  for (const key of ["page", "size"]) {
    if (value[key] !== undefined && typeof value[key] !== "number") return `${key} is not a number`;
  }
  for (const key of ["woOutput", "facetten"]) {
    if (value[key] !== undefined && !isPlainObject(value[key])) return `${key} is not an object`;
  }
  return undefined;
};

/**
 * Why a 2xx body is not a `/pc/v4/jobdetails` record, or undefined: it must be a JSON
 * object with a string `referenznummer` (every live record has one). `{}`, `null` or
 * an error envelope is not a listing.
 */
export const jobDetailsProblem: Problem<unknown> = (value) => {
  if (!isPlainObject(value)) return `expected a JSON object, got ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}`;
  if (typeof value["referenznummer"] !== "string") {
    const said = envelopeText(value);
    return `no referenznummer${said !== undefined ? `; the server said: ${said}` : ""}`;
  }
  return undefined;
};

/**
 * A reference number (or encoded code) for `details()`: a string, and a token
 * (`tokenProblem`: not blank, no control, format or invisible character, no lone surrogate;
 * it goes out as `normalizeToken` makes it, trimmed and NFC, then base64-encoded). A number,
 * `undefined` or an object used to fail as a raw TypeError; a zero-width space in a pasted
 * refnr was encoded with it and answered 404.
 */
export const refnrProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a reference number (a string such as 10001-1002716922-S).";
  return tokenProblem(value);
};
