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
// honours --timeout/--user-agent and is testable in-process without a network.

import type { Transport } from "./http.js";
import { nodeHttpTransport } from "./http.js";
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

/** `X-API-Key: <value>` as documented in the source's curl examples. */
const KEY_PATTERN = /X-API-Key:\s*([^\s"'`]+)/i;

export interface ObtainKeyOptions {
  /** Injectable transport; defaults to the built-in node:http/https one. */
  transport?: Transport;
  /** Override the source document (tests, mirrors). */
  sourceUrl?: string;
  timeoutMs?: number;
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
  const transport = options.transport ?? nodeHttpTransport;

  const response = await transport({
    method: "GET",
    url: sourceUrl,
    headers: {
      Accept: "text/plain, text/markdown;q=0.9, */*;q=0.8",
      "User-Agent": options.userAgent ?? "jobsuche-cli",
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new JobsucheError(
      `Could not read the key source ${sourceUrl} (HTTP ${response.status}). ` +
        `Retry, or copy the key from github.com/bundesAPI/jobsuche-api by hand.`,
    );
  }

  const key = KEY_PATTERN.exec(response.body.toString("utf8"))?.[1]?.trim();
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
