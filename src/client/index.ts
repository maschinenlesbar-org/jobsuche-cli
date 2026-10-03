// Public entry point for the API client library.

export { JobsucheClient } from "./client.js";
export type { JobsucheClientOptions } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { obtainKey, API_KEY_ENV_VAR, KEY_SOURCE_URL, MAX_KEY_SOURCE_REDIRECTS } from "./obtain-key.js";
export type { ObtainKeyOptions, ObtainedKey } from "./obtain-key.js";
export { buildQueryString } from "./query.js";
export {
  ANGEBOTSART_CODES,
  angebotsartProblem,
  assertValid,
  intRangeProblem,
  isBlank,
  MAX_VEROEFFENTLICHT_SEIT,
  nonBlankProblem,
  TEXT_FILTERS,
  validateSearchParams,
} from "./validate.js";
export type { Angebotsart, Problem } from "./validate.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  JobsucheError,
  JobsucheApiError,
  JobsucheNetworkError,
  JobsucheParseError,
  JobsucheValidationError,
  redactUrl,
} from "./errors.js";

export * from "./types.js";
