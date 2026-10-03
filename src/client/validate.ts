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
export const nonBlankProblem: Problem = (value) =>
  isBlank(value) ? "Must not be blank." : undefined;

/** The free-text search filters, which must not be blank when given. */
export const TEXT_FILTERS = ["was", "wo", "berufsfeld", "arbeitgeber"] as const;

/**
 * Check search parameters before any request. `undefined` (or `null`) means "not
 * set". A given `was`, `wo`, `berufsfeld` or `arbeitgeber` must not be blank
 * (nonBlankProblem): leave a filter out to search without it. Throws a
 * JobsucheValidationError naming the parameter; returns `params` unchanged.
 */
export function validateSearchParams(params: JobSearchParams): JobSearchParams {
  for (const name of TEXT_FILTERS) {
    const value = params[name];
    if (typeof value === "string") assertValid(name, value, nonBlankProblem);
  }
  return params;
}
