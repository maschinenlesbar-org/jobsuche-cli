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
import { DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS, assertHttpScheme } from "./engine.js";
import { JobsucheError, JobsucheParseError } from "./errors.js";

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

export interface ObtainKeyOptions {
  /** Injectable transport; defaults to the built-in node:http/https one. */
  transport?: Transport;
  /** Override the source document (tests, mirrors). */
  sourceUrl?: string;
  /**
   * Time limit per request in milliseconds, whole response included. Defaults to
   * `DEFAULT_TIMEOUT_MS` (30 s), like the API client; 0 disables it.
   */
  timeoutMs?: number;
  /**
   * Cap on the response body in bytes. Defaults to `DEFAULT_MAX_RESPONSE_BYTES`
   * (100 MiB), like the API client; 0 disables it.
   */
  maxResponseBytes?: number;
  /** User-Agent header; a blank value falls back to the default. */
  userAgent?: string;
}

export interface ObtainedKey {
  /** The public key, ready to put in `API_KEY_ENV_VAR`. */
  key: string;
  /** Where it was read from, so callers can cite it. */
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
  // Same gate as the engine: a custom transport must never get a file:/ftp: URL.
  assertHttpScheme(sourceUrl);
  const transport = options.transport ?? nodeHttpTransport;
  // The request gets the client's limits: a source that stalls, or streams
  // without end, must not hang the command or exhaust memory.
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const response = await transport({
    method: "GET",
    url: sourceUrl,
    headers: {
      Accept: "text/plain, text/markdown;q=0.9, */*;q=0.8",
      "User-Agent": options.userAgent?.trim() ? options.userAgent : "jobsuche-cli",
    },
    ...(timeoutMs > 0 ? { timeoutMs } : {}),
    ...(maxResponseBytes > 0 ? { maxResponseBytes } : {}),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new JobsucheError(
      `Could not read the key source ${sourceUrl} (HTTP ${response.status}). ` +
        `Retry, or copy the key from github.com/bundesAPI/jobsuche-api by hand.`,
    );
  }

  const text = response.body.toString("utf8");
  // The `clientId` is the documented value and wins; an `X-API-Key` example is
  // the fallback. When the document states more than one distinct key — two
  // clientIds, or an X-API-Key that contradicts the clientId — it is ambiguous,
  // and guessing would be worse than failing.
  const clientIds = findKeys(text, CLIENT_ID_PATTERN);
  const headerKeys = findKeys(text, X_API_KEY_PATTERN);
  const conflicting = [...new Set([...clientIds, ...headerKeys])];
  if (conflicting.length > 1) {
    throw new JobsucheError(
      `The key source ${sourceUrl} states conflicting keys (${conflicting.join(", ")}). ` +
        `Check it by hand before relying on this command.`,
    );
  }
  const key = conflicting[0];
  if (!key) {
    throw new JobsucheParseError(
      `No X-API-Key found at ${sourceUrl}. The upstream document may have changed ` +
        `format or stopped publishing the key — check it by hand before relying on this command.`,
    );
  }
  return { key, sourceUrl };
}

/**
 * Quote a value for safe use inside a POSIX `export VAR=...` line, so
 * `eval "$(... obtain-key --export)"` cannot execute anything the source
 * document smuggled in.
 */
export function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
