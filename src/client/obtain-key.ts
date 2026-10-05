// Obtain the public `X-API-Key` the Jobsuche API requires.
//
// No key ships with this package (see client.ts). The Bundesagentur für Arbeit
// publishes a single static key for public use, and this module reads it at run
// time from the document that publishes it — so a rotated key needs no release
// of this CLI.
//
// The value is deliberately *public*, not a secret: printing it, putting it in
// an environment variable and showing it to the user are all intended. What this
// module must never do is invent one, or fall back to a stale literal compiled
// into the package.
//
// The fetch goes through the same `Transport` seam as every other request, so it
// honours --timeout/--max-response-bytes/--user-agent and is testable in-process
// without a network. Like the API client it has a 30 s timeout and a 100 MiB size
// cap by default, so a stalled source cannot hang
// `eval "$(jobsuche obtain-key --export)"`.

import type { Transport } from "./http.js";
import { nodeHttpTransport } from "./http.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  decodeBody,
  exchange,
  functionOption,
  headerValue,
  intOption,
  followedElsewhere,
  networkError,
  secretScrubber,
  splitUserinfo,
  type ExchangeResponse,
} from "./engine.js";
import { assertValid, headerValueProblem, httpUrlProblem } from "./validate.js";
import { JobsucheError, JobsucheParseError, credentialsIn, redactUrl } from "./errors.js";

/** The environment variable the client and CLI read the key from. */
export const API_KEY_ENV_VAR = "JOBSUCHE_API_KEY";

/**
 * Authoritative, plain-text source of the public key. The rendered
 * jobsuche.api.bund.dev docs are generated from this README, and the docs site
 * itself is a JS SPA — so the README is the machine-readable source.
 */
export const KEY_SOURCE_URL =
  "https://raw.githubusercontent.com/bundesAPI/jobsuche-api/main/README.md";

/**
 * Between a label and its value, on one line: Markdown emphasis, quotes and blanks
 * around a required `:` or `=` — so `**clientId:** <key>`, `"client_id": "<key>"`,
 * `client_id=<key>` and the curl examples' `X-API-Key: <key>` all match, while
 * prose ("die clientId als Header-Parameter 'X-API-Key'") does not.
 */
const SEPARATOR = String.raw`[ \t"'\x60*]*[:=][ \t"'\x60*]*`;
/** The value: up to the next blank, quote, backtick or emphasis. */
const VALUE = String.raw`([^\s"'\x60*]+)`;

/** The documented value: the BA `clientId` (also spelt `client_id`). */
const CLIENT_ID_PATTERN = new RegExp(String.raw`client_?id${SEPARATOR}${VALUE}`, "gi");
/** Fallback: the value sent as an `X-API-Key` header in the curl examples. */
const X_API_KEY_PATTERN = new RegExp(String.raw`X-API-Key${SEPARATOR}${VALUE}`, "gi");

/**
 * What a key looks like: letters, digits, `.`, `_` and `-`. A placeholder such as
 * `<your-key>` or `$KEY`, or a value carrying control characters, is not a key —
 * it is skipped rather than printed (and never reaches the terminal raw).
 */
const KEY_SHAPE = /^[A-Za-z0-9._-]+$/;

/** Distinct key-shaped values the pattern finds, in document order. */
function findKeys(text: string, pattern: RegExp): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const key = match[1];
    if (key !== undefined && KEY_SHAPE.test(key) && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Same-origin redirects the key-source request follows (e.g. a renamed repository). */
export const MAX_KEY_SOURCE_REDIRECTS = 5;

/** The redirect statuses followed, as in the API client. */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface ObtainKeyOptions {
  /** Injectable transport; defaults to the built-in node:http/https one. */
  transport?: Transport;
  /**
   * Override the source document (tests, mirrors): an absolute http(s) URL
   * (httpUrlProblem), else a JobsucheValidationError.
   */
  sourceUrl?: string;
  /**
   * Time limit per request in milliseconds, whole response included, a
   * non-negative integer. Defaults to `DEFAULT_TIMEOUT_MS` (30 s), like the API
   * client; 0 disables it.
   */
  timeoutMs?: number;
  /**
   * Cap on the response body in bytes, a non-negative integer. Defaults to
   * `DEFAULT_MAX_RESPONSE_BYTES` (100 MiB), like the API client; 0 disables it.
   */
  maxResponseBytes?: number;
  /**
   * User-Agent header; defaults to `DEFAULT_USER_AGENT`. Must be a valid header
   * value (headerValueProblem), as for the API client: a blank one is rejected.
   */
  userAgent?: string;
}

export interface ObtainedKey {
  /** The public key, ready to put in `API_KEY_ENV_VAR`. */
  key: string;
  /**
   * Where it was read from (after any redirect), so callers can cite it; a
   * `user:password@` part is shown as `***@`.
   */
  sourceUrl: string;
}

/**
 * Fetch the public key from its upstream source.
 *
 * Throws (rather than returning a placeholder) when the source is unreachable or
 * no longer states a key, so a caller never proceeds with a made-up value.
 */
export async function obtainKey(options: ObtainKeyOptions = {}): Promise<ObtainedKey> {
  const sourceUrl = options.sourceUrl ?? KEY_SOURCE_URL;
  // Same rule as the engine's base URL (a query is fine here): a custom transport
  // must never get a file:/ftp: URL.
  assertValid("sourceUrl", sourceUrl, httpUrlProblem);
  const transport = functionOption("transport", options.transport, nodeHttpTransport);
  // The request gets the client's limits: a source that stalls, or streams
  // without end, must not hang the command or exhaust memory.
  // Range-checked like the engine's options (intOption): a negative or NaN value
  // must not silently mean "no limit".
  const timeoutMs = intOption("timeoutMs", options.timeoutMs, Number.MAX_SAFE_INTEGER, DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = intOption(
    "maxResponseBytes",
    options.maxResponseBytes,
    Number.MAX_SAFE_INTEGER,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  const userAgent =
    options.userAgent === undefined
      ? DEFAULT_USER_AGENT
      : assertValid("userAgent", options.userAgent, headerValueProblem);

  // raw.githubusercontent.com answers a renamed repository or branch with a
  // redirect, so follow a few — same origin only: the key is trusted because of
  // where it is published, and a hop to another host is not followed.
  // A source behind Basic auth (a private mirror) gets its userinfo as an
  // Authorization header, never in the URL the transport sees; with same-origin
  // redirects only, it never leaves that origin.
  const start = splitUserinfo(sourceUrl);
  const scrub = secretScrubber(credentialsIn(sourceUrl), []);
  let url = start.url;
  let response: ExchangeResponse;
  for (let redirects = 0; ; redirects += 1) {
    // Through the engine's exchange(): the time limit and the size cap hold for any
    // transport, and whatever it throws or returns becomes a JobsucheNetworkError.
    try {
      response = await exchange(
        transport,
        {
          method: "GET",
          url,
          headers: {
            Accept: "text/plain, text/markdown;q=0.9, */*;q=0.8",
            "User-Agent": userAgent,
            ...(start.basic !== undefined ? { Authorization: start.basic } : {}),
          },
          redirect: "manual",
          ...(timeoutMs > 0 ? { timeoutMs } : {}),
          ...(maxResponseBytes > 0 ? { maxResponseBytes } : {}),
        },
        { timeoutMs, maxResponseBytes },
      );
    } catch (cause) {
      // A source behind Basic auth is never named with its password.
      throw networkError("GET", url, cause, scrub);
    }
    // A transport that followed a redirect to another host itself read the key from a
    // document this function would not trust (and would cite the wrong source).
    const elsewhere = followedElsewhere("GET", url, response.url);
    if (elsewhere !== undefined) throw elsewhere;
    if (!FOLLOWED_REDIRECTS.has(response.status) || redirects >= MAX_KEY_SOURCE_REDIRECTS) break;
    const next = resolveLocation(headerValue(response.headers["location"]), url);
    if (next === undefined || next.origin !== new URL(url).origin) break;
    url = next.href;
  }

  if (response.status < 200 || response.status >= 300) {
    throw new JobsucheError(
      `Could not read the key source ${redactUrl(url)} (HTTP ${response.status}). ` +
        `Retry, or copy the key from github.com/bundesAPI/jobsuche-api by hand.`,
    );
  }

  const text = decodeBody(response.body, String(headerValue(response.headers["content-type"]) ?? ""), redactUrl(url));
  // The `clientId` is the documented value and wins; an `X-API-Key` example is
  // the fallback. When the document states more than one distinct key — two
  // clientIds, or an X-API-Key that contradicts the clientId — it is ambiguous,
  // and guessing would be worse than failing.
  const clientIds = findKeys(text, CLIENT_ID_PATTERN);
  const headerKeys = findKeys(text, X_API_KEY_PATTERN);
  const conflicting = [...new Set([...clientIds, ...headerKeys])];
  if (conflicting.length > 1) {
    throw new JobsucheError(
      `The key source ${redactUrl(url)} states conflicting keys (${conflicting.join(", ")}). ` +
        `Check it by hand before relying on this command.`,
    );
  }
  const key = conflicting[0];
  if (!key) {
    throw new JobsucheParseError(
      `No X-API-Key found at ${redactUrl(url)}. The upstream document may have changed ` +
        `format or stopped publishing the key — check it by hand before relying on this command.`,
    );
  }
  return { key, sourceUrl: redactUrl(url) };
}

/** Resolve a Location header against the request URL; undefined if missing or malformed. */
function resolveLocation(value: string | undefined, base: string): URL | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    return new URL(value, base);
  } catch {
    return undefined;
  }
}

/**
 * Quote a value for safe use inside a POSIX `export VAR=...` line, so
 * `eval "$(... obtain-key --export)"` cannot execute anything the source
 * document smuggled in.
 */
export function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
