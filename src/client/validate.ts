// Input validation shared by the library and the CLI. Every rule about what a
// request may contain lives in src/client as a pure `…Problem(value)` function: it
// returns the reason a value is invalid, or undefined when the value is fine. The
// client enforces a rule with assertValid before any request; the CLI's commander
// value-parsers call the same function and turn the reason into a usage error, so
// the rule exists exactly once.

import { JobsucheValidationError } from "./errors.js";
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
  ["umkreis", intRangeProblem(0, Number.MAX_SAFE_INTEGER)],
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

/** An HTTP header name: an RFC 9110 token. */
export const headerNameProblem: Problem = (name) =>
  typeof name === "string" && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
    ? undefined
    : "Expected an HTTP header name (letters, digits and !#$%&'*+-.^_`|~).";

/** The free-text search filters, which must not be blank when given. */
export const TEXT_FILTERS = ["was", "wo", "berufsfeld", "arbeitgeber"] as const;

/**
 * Check search parameters before any request. `undefined` (or `null`) means "not
 * set". A given `was`, `wo`, `berufsfeld` or `arbeitgeber` must not be blank
 * (nonBlankProblem): leave a filter out to search without it. `umkreis` and `size`
 * must be non-negative integers, `veroeffentlichtseit` an integer
 * 0..MAX_VEROEFFENTLICHT_SEIT, `angebotsart` one of ANGEBOTSART_CODES and `page`
 * an integer >= 1 (the API answers `page=0` with HTTP 400). Throws a
 * JobsucheValidationError naming the parameter; returns `params` unchanged.
 */
export function validateSearchParams(params: JobSearchParams): JobSearchParams {
  for (const name of TEXT_FILTERS) {
    const value = params[name];
    if (value !== undefined && value !== null) assertValid(name, value, nonBlankProblem);
  }
  for (const [name, problem] of NUMERIC_PARAMS) {
    const value = params[name];
    if (value !== undefined && value !== null) assertValid(name, value as number, problem);
  }
  return params;
}
