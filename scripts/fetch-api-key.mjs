#!/usr/bin/env node
// Fetch the public Jobsuche `X-API-Key` from the authoritative upstream source.
//
// The key is NOT bundled with the client or the CLI (see src/client/client.ts).
// This script exists so a key can be obtained out-of-band when one is genuinely
// needed — i.e. for CI / local integration runs that hit the live API. It MUST
// NOT be wired into the CLI or any production code path: resolve the key here,
// outside the program, and hand it in via `--api-key` or the JOBSUCHE_API_KEY
// environment variable. Typical CI usage:
//
//   JOBSUCHE_API_KEY="$(node scripts/fetch-api-key.mjs)" npm test
//
// Source: the bundesAPI README is what the rendered jobsuche.api.bund.dev docs
// are generated from, and it carries the key in plain text (the docs site is a
// JS SPA, so the README is the machine-readable source). Scraped with a simple
// regex on purpose — no HTML parser, no dependencies.

import { fileURLToPath } from "node:url";
import process from "node:process";

/** Authoritative, plain-text source of the public key. */
export const SOURCE_URL =
  "https://raw.githubusercontent.com/bundesAPI/jobsuche-api/main/README.md";

/** `X-API-Key: <value>` as documented in the README's curl examples. */
const KEY_PATTERN = /X-API-Key:\s*([^\s"'`]+)/i;

/**
 * Fetch the source and scrape the public `X-API-Key`. Throws on a non-OK
 * response or when no key can be found (so callers/CI fail loudly).
 */
export async function fetchApiKey() {
  const res = await fetch(SOURCE_URL, {
    headers: { "User-Agent": "jobsuche-cli fetch-api-key" },
  });
  if (!res.ok) {
    throw new Error(`Could not fetch ${SOURCE_URL}: HTTP ${res.status}`);
  }
  const text = await res.text();
  const match = text.match(KEY_PATTERN);
  if (!match) {
    throw new Error(`No X-API-Key found in ${SOURCE_URL}`);
  }
  return match[1];
}

// Run as a script: print just the key to stdout (so it composes in shells and
// CI), or the error to stderr with a non-zero exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write((await fetchApiKey()) + "\n");
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
