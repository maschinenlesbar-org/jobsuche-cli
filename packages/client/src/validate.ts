// Input validation shared by the library and the CLI. Every rule about what a
// request may contain lives in src/client as a pure `…Problem(value)` function: it
// returns the reason a value is invalid, or undefined when the value is fine. The
// client enforces a rule with assertValid before any request; the CLI's commander
// value-parsers call the same function and turn the reason into a usage error, so
// the rule exists exactly once.

import { JobsucheValidationError, cutForMessage, cutText, redactUrl } from "./errors.js";
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

/** True for a string that is empty or only whitespace. */
export function isBlank(value: string): boolean {
  return value.trim() === "";
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
    return `Invalid URL: "${cutForMessage(redactUrl(value))}".`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported protocol "${cutForMessage(url.protocol)}" (use http: or https:).`;
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
  allowUnknownParams?: boolean;
}

/**
 * Why `key` is not a search parameter, or undefined. `__proto__` and `constructor`
 * are never parameters (a `JSON.parse`d object can carry them as own keys).
 */
export function searchParamKeyProblem(key: string, allowUnknown = false): string | undefined {
  if ((SEARCH_PARAMS as readonly string[]).includes(key)) return undefined;
  if (key === "__proto__" || key === "constructor" || key === "prototype") return `"${cutForMessage(key)}" is not a search parameter.`;
  if (allowUnknown) return undefined;
  return (
    `Unknown search parameter "${cutForMessage(key)}" (the API ignores it and returns the unfiltered set). ` +
    `Known: ${SEARCH_PARAMS.join(", ")}; pass { allowUnknownParams: true } to send it anyway.`
  );
}

/**
 * Check search parameters before any request. `undefined` (or `null`) means "not
 * set". A given `was`, `wo`, `berufsfeld` or `arbeitgeber` must not be blank
 * (nonBlankProblem): leave a filter out to search without it. `umkreis` must be an
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
    if ((SEARCH_PARAMS as readonly string[]).includes(key) || value === undefined || value === null) continue;
    // An unknown parameter sent on request: one scalar, as for the known ones.
    const scalar = typeof value === "string" ? !isBlank(value) : typeof value === "boolean" || Number.isFinite(value);
    if (!scalar) {
      throw new JobsucheValidationError(`Invalid ${key}: Expected one non-blank string, a finite number or a boolean.`);
    }
  }
  for (const name of TEXT_FILTERS) {
    const value = params[name];
    if (value !== undefined && value !== null) assertValid(name, value, nonBlankProblem);
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
 * A reference number (or encoded code) for `details()`: a string that is not blank.
 * A number, `undefined` or an object used to fail as a raw TypeError.
 */
export const refnrProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a reference number (a string such as 10001-1002716922-S).";
  return isBlank(value) ? "Must not be blank." : undefined;
};
