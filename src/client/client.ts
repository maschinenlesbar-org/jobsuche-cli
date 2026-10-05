// JobsucheClient — a typed client over the open Jobsuche API of the
// Bundesagentur für Arbeit (rest.arbeitsagentur.de/jobboerse/jobsuche-service).
//
// Auth: the API requires a static, publicly-documented `X-API-Key` header. The
// key is NOT bundled with this client — pass it via `apiKey` (the CLI maps this
// to `--api-key` / the JOBSUCHE_API_KEY env var). When no key is supplied the
// header is omitted and the API answers 401/403. The public key can be fetched
// at run time via obtainKey() / the CLI's `obtain-key` command.
//
//   client.search({ was: "Informatiker", wo: "Berlin", size: 10 })
//   client.details(stellenangebot.referenznummer)
//
// Search uses /pc/v6/jobs (the upstream's documented search step; /pc/v4/jobs
// answers an empty 403 since 2026-09), details /pc/v4/jobdetails.

import { RequestEngine, type EngineOptions } from "./engine.js";
import { JobsucheError, JobsucheParseError } from "./errors.js";
import { sanitizeServerText } from "./engine.js";
import {
  assertValid,
  headerValueProblem,
  jobDetailsProblem,
  searchResultProblem,
  validateSearchParams,
  type Problem,
} from "./validate.js";
import type { QueryParams } from "./query.js";
import type { JobSearchResult, JobDetails, JobSearchParams } from "./types.js";

const SERVICE = "/jobboerse/jobsuche-service";
/**
 * Shape of a reference number once base64-decoded. Refnrs are made of digits,
 * letters and hyphens (e.g. "10001-1002716922-S", and real listings contain
 * lowercase hex such as "14225-dafcdd47aabe512d-S"). A purely numeric refnr such
 * as "1002716922" is also valid. Used to distinguish a refnr from an
 * already-base64-encoded `encryptedJobCode`.
 */
const REFNR_PATTERN = /^[A-Za-z0-9-]+$/;

/** Options for the Jobsuche client (engine options plus the API key). */
export interface JobsucheClientOptions extends EngineOptions {
  /**
   * The `X-API-Key` to send. No key is bundled; when omitted (or blank) the
   * header is not sent. Surrounding whitespace (e.g. the trailing newline of a key
   * read from a file) is trimmed; a key with an inner control character or a
   * character above U+00FF is rejected (JobsucheValidationError). Obtain the
   * public key with obtainKey() (see obtain-key.ts).
   */
  apiKey?: string;
}

/**
 * Drop the parameters the caller did not set (`undefined`/`null`), so only the
 * ones meaningfully set are sent. A blank string never gets here:
 * validateSearchParams rejects it first.
 */
function prune(params: Record<string, unknown>): QueryParams {
  const out: QueryParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out[k] = v as QueryParams[string];
  }
  return out;
}

/**
 * `value` as `T` when `problem` finds nothing wrong with it, else a JobsucheParseError
 * (`Unexpected response from <path>: not a <what> (<reason>)`): a 2xx body without
 * the documented shape is never handed on as data.
 */
function checked<T>(path: string, value: unknown, problem: Problem<unknown>, what: string): T {
  const reason = problem(value);
  if (reason !== undefined) {
    throw new JobsucheParseError(`Unexpected response from ${path}: not a ${what} (${sanitizeServerText(reason)}).`);
  }
  return value as T;
}

export class JobsucheClient {
  private readonly engine: RequestEngine;

  constructor(options: JobsucheClientOptions = {}) {
    const { apiKey, ...engineOptions } = options;
    // Normalised once, here: the key is trimmed, a blank one means "no key" (the
    // header is omitted; none is ever defaulted), and the trimmed key is what is
    // checked and sent.
    const key = apiKey?.trim() || undefined;
    // A key Node cannot send as a header (an inner CR/LF, other controls, above
    // U+00FF) fails here with a typed error instead of at request time.
    if (key !== undefined) assertValid("apiKey", key, headerValueProblem);
    this.engine = new RequestEngine({
      ...engineOptions,
      defaultHeaders: {
        ...(key ? { "X-API-Key": key } : {}),
        ...engineOptions.defaultHeaders,
      },
    });
  }

  /**
   * Search job listings (`/pc/v6/jobs`). The listings are in `ergebnisliste`,
   * which is absent when nothing matched (or `size` is 0).
   *
   * Rejects with a JobsucheParseError when a 2xx body is not a search result
   * (searchResultProblem): `null`, `{}`, an array or an error envelope is never
   * returned as "nothing found".
   *
   * Rejects with a JobsucheValidationError, before any request, when the
   * parameters break a rule of validateSearchParams (e.g. a blank `was`, which
   * would otherwise run the search unfiltered).
   */
  async search(params: JobSearchParams = {}): Promise<JobSearchResult> {
    validateSearchParams(params);
    const path = `${SERVICE}/pc/v6/jobs`;
    return checked(path, await this.engine.getJson<unknown>(path, prune({ ...params })), searchResultProblem, "search result");
  }

  /**
   * Full details for one job.
   *
   * @param refnr A reference number (`refnr`), e.g. `"10001-1002716922-S"` or a
   *   purely numeric `"1002716922"`, as returned in a search result's
   *   `referenznummer` field. It is base64-encoded into the API's `encryptedJobCode` for you.
   *
   *   As a convenience, an already-base64-encoded `encryptedJobCode` is passed
   *   through unchanged. Detection is exact (not charset sniffing): the input is
   *   only treated as pre-encoded when base64-decoding it yields a string that
   *   matches the refnr pattern and re-encodes to the original — so a refnr such
   *   as `"1002716922"`, which is NOT base64 of a refnr, is correctly encoded.
   */
  async details(refnr: string): Promise<JobDetails> {
    const trimmed = refnr.trim();
    if (trimmed.length === 0) {
      throw new JobsucheError("details() requires a non-empty reference number (refnr).");
    }
    const code = this.isEncodedCode(trimmed)
      ? trimmed
      : Buffer.from(trimmed, "utf8").toString("base64");
    const path = `${SERVICE}/pc/v4/jobdetails/${encodeURIComponent(code)}`;
    return checked(path, await this.engine.getJson<unknown>(path), jobDetailsProblem, "job listing");
  }

  /**
   * True only when `value` is already a base64-encoded `encryptedJobCode`.
   *
   * A refnr is never base64 of itself, so charset sniffing produces false
   * positives (e.g. the numeric refnr "1002716922" is valid base64 charset).
   * Instead we round-trip: decode as base64 and accept only if the decoded bytes
   * (a) re-encode to exactly the input and (b) look like a plausible refnr. This
   * cannot misclassify a raw refnr as encoded.
   */
  private isEncodedCode(value: string): boolean {
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value) return false;
    return REFNR_PATTERN.test(decoded.toString("utf8"));
  }
}
