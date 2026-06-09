// JobsucheClient — a typed client over the open Jobsuche API of the
// Bundesagentur für Arbeit (rest.arbeitsagentur.de/jobboerse/jobsuche-service).
//
// Auth: the API requires a static, publicly-documented `X-API-Key` header. The
// key is NOT bundled with this client — pass it via `apiKey` (the CLI maps this
// to `--api-key` / the JOBSUCHE_API_KEY env var). When no key is supplied the
// header is omitted and the API answers 401/403. The public key can be fetched
// out-of-band for CI / live testing via scripts/fetch-api-key.mjs.
//
//   client.search({ was: "Informatiker", wo: "Berlin", size: 10 })
//   client.details(stellenangebot.refnr)

import { RequestEngine, type EngineOptions } from "./engine.js";
import { JobsucheError } from "./errors.js";
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
   * header is not sent. Obtain the public key via scripts/fetch-api-key.mjs.
   */
  apiKey?: string;
}

/**
 * Drop values that should not be sent so only the parameters the caller
 * meaningfully set survive: `undefined`/`null` and empty / whitespace-only
 * strings (an empty `--was ""` is treated as "not provided", not as `was=`,
 * which the live API rejects with HTTP 400).
 */
function prune(params: Record<string, unknown>): QueryParams {
  const out: QueryParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim().length === 0) continue;
    out[k] = v as QueryParams[string];
  }
  return out;
}

export class JobsucheClient {
  private readonly engine: RequestEngine;

  constructor(options: JobsucheClientOptions = {}) {
    const { apiKey, ...engineOptions } = options;
    // Only send X-API-Key when a non-blank key was supplied; never default one.
    const key = apiKey?.trim() ? apiKey : undefined;
    this.engine = new RequestEngine({
      ...engineOptions,
      defaultHeaders: {
        ...(key ? { "X-API-Key": key } : {}),
        ...engineOptions.defaultHeaders,
      },
    });
  }

  /** Search job listings. */
  search(params: JobSearchParams = {}): Promise<JobSearchResult> {
    return this.engine.getJson(`${SERVICE}/pc/v4/jobs`, prune({ ...params }));
  }

  /**
   * Full details for one job.
   *
   * @param refnr A reference number (`refnr`), e.g. `"10001-1002716922-S"` or a
   *   purely numeric `"1002716922"`, as returned in a search result's `refnr`
   *   field. It is base64-encoded into the API's `encryptedJobCode` for you.
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
    return this.engine.getJson<JobDetails>(`${SERVICE}/pc/v4/jobdetails/${encodeURIComponent(code)}`);
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
