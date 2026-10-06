// Public entry point for the API client library.

export { JobsucheClient } from "./client.js";
export type { JobsucheClientOptions } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  cleartextCredentialsProblem,
  decodeBody,
  exchange,
  followedElsewhere,
  originOf,
  splitUserinfo,
  intOption,
  isTransientNetworkError,
  networkError,
  MAX_REDIRECTS,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  validateBaseUrl,
} from "./engine.js";
export type { CredentialsDropped, EngineOptions, ExchangeResponse, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport, sizeLimitMessage } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { obtainKey, keyFormatProblem, API_KEY_ENV_VAR, KEY_SOURCE_URL, MAX_KEY_SOURCE_REDIRECTS } from "./obtain-key.js";
export type { ObtainKeyOptions, ObtainedKey } from "./obtain-key.js";
export { buildQueryString } from "./query.js";
export {
  ANGEBOTSART_CODES,
  angebotsartProblem,
  assertValid,
  baseUrlProblem,
  headerNameProblem,
  headerValueProblem,
  httpUrlProblem,
  intRangeProblem,
  isBlank,
  isPlainObject,
  jobDetailsProblem,
  MAX_VEROEFFENTLICHT_SEIT,
  nonBlankProblem,
  refnrProblem,
  SEARCH_PARAMS,
  searchParamKeyProblem,
  searchResultProblem,
  TEXT_FILTERS,
  validateSearchParams,
} from "./validate.js";
export type { Angebotsart, Problem, SearchOptions } from "./validate.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  JobsucheError,
  JobsucheApiError,
  JobsucheNetworkError,
  JobsucheParseError,
  JobsucheValidationError,
  credentialsDroppedHint,
  credentialsIn,
  redactCredentials,
  redactSecrets,
  redactUrl,
} from "./errors.js";

export * from "./types.js";
