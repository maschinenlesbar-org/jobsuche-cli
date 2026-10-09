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
import { JobsucheParseError, JobsucheValidationError, cutForMessage } from "./errors.js";
import { sanitizeServerText } from "./engine.js";
import {
  assertValid,
  headerValueProblem,
  isPlainObject,
  jobDetailsProblem,
  refnrProblem,
  searchResultProblem,
  validateSearchParams,
  type Problem,
  type SearchOptions,
} from "./validate.js";
import type { QueryParams } from "./query.js";
import type { JobSearchResult, JobDetails, JobSearchParams } from "./types.js";

const SERVICE = "/jobboerse/jobsuche-service";
/**
 * Shape of a reference number once base64-decoded: a digit first, then printable
 * ASCII without blanks. Live refnrs are digits, letters and hyphens
 * ("10001-1002716922-S", "14225-dafcdd47aabe512d-S", a purely numeric
 * "1002716922"), and 15 % of them also contain "_" or ":"
 * ("13635-dc8d6fe5_JB5255995-S", "17296-0008159:01-S"), so the alphabet is not
 * narrowed further. Used to tell a refnr from an already-base64-encoded
 * `encryptedJobCode`: a raw refnr never passes as one, since it contains a "-"
 * (outside the base64 alphabet) or, when purely numeric, decodes to bytes above
 * 0x7f.
 */
const REFNR_PATTERN = /^[0-9][\x21-\x7e]*$/;

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
    // A JavaScript caller may pass null for "no options"; anything else must be an object.
    options = options ?? {};
    if (!isPlainObject(options as unknown)) throw new JobsucheValidationError("Invalid options: Expected an object.");
    const { apiKey, ...engineOptions } = options;
    if (engineOptions.defaultHeaders !== undefined && !isPlainObject(engineOptions.defaultHeaders as unknown)) {
      throw new JobsucheValidationError("Invalid defaultHeaders: Expected an object of header names and values.");
    }
    if (apiKey !== undefined && typeof apiKey !== "string") {
      throw new JobsucheValidationError("Invalid apiKey: Expected a string.");
    }
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
   * Also rejects a parameter name that is not one of `SEARCH_PARAMS` (the API
   * ignores an unknown one and returns the unfiltered set), unless
   * `options.allowUnknownParams` is set.
   *
   * Rejects with a JobsucheParseError when a 2xx body is not a search result
   * (searchResultProblem): `null`, `{}`, an array or an error envelope is never
   * returned as "nothing found".
   *
   * Rejects with a JobsucheValidationError, before any request, when the
   * parameters break a rule of validateSearchParams (e.g. a blank `was`, which
   * would otherwise run the search unfiltered).
   */
  async search(params: JobSearchParams = {}, options: SearchOptions = {}): Promise<JobSearchResult> {
    validateSearchParams(params, options);
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
    const trimmed = (assertValid("refnr", refnr as unknown, refnrProblem) as string).trim();
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

/** `text` in NFC, lower-cased, with blanks collapsed, for comparing two place names. */
function placeKey(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * What a search did with its `wo`, when that is not the place asked for — or
 * undefined. The API never fails on a place it doesn't know: it answers
 * `woOutput.suchmodus` `"UNGUELTIG"` with an empty result, which reads as "no jobs
 * there", and it silently searches around another town for a garbled name
 * (`Hambrugxx Nord` → `Tackesdorf-Nord`, 307 listings 150 km from Hamburg), so every
 * `entfernung` is measured from the wrong place. Returns a sentence for the caller
 * to show (the CLI prints it as a warning on stderr):
 *
 * - `UNGUELTIG`: the place was not recognised and nothing was searched there;
 * - a `bereinigterOrt` that neither contains nor is contained in `wo` (compared
 *   case-insensitively, NFC, blanks collapsed): the API searched around that place
 *   instead. A correction such as `Berln` → `Berlin` is named the same way; a
 *   postcode or `Frankfurt` → `Frankfurt am Main` is not.
 */
export function woNote(wo: string | undefined, result: JobSearchResult): string | undefined {
  if (wo === undefined || wo.trim() === "" || !isPlainObject(result as unknown)) return undefined;
  const out = result.woOutput;
  if (!isPlainObject(out as unknown)) return undefined;
  const asked = sanitizeServerText(wo);
  if (out?.suchmodus === "UNGUELTIG") {
    return (
      `the API did not recognise the place "${cutForMessage(asked)}" (woOutput.suchmodus UNGUELTIG), so nothing ` +
      `was searched there: an empty result does not mean "no jobs". Check the spelling or use a postcode.`
    );
  }
  const resolved = typeof out?.bereinigterOrt === "string" ? sanitizeServerText(out.bereinigterOrt) : "";
  if (resolved === "") return undefined;
  const a = placeKey(asked);
  const b = placeKey(resolved);
  if (a.includes(b) || b.includes(a)) return undefined;
  return (
    `the API searched around "${cutForMessage(resolved)}" for --wo "${cutForMessage(asked)}" (woOutput.bereinigterOrt); ` +
    `distances (entfernung) are from there. Check that this is the place you meant.`
  );
}
