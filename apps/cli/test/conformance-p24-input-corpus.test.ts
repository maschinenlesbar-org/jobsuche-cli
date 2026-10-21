// Conformance test P24 (trend analysis 2026-10-21): an input is canonicalised or refused, never
// sent raw. One corpus of tricky values goes through every text filter and every id the repo
// declares, on the CLI and in the library. Either both refuse it before any request (exit 2,
// the validation error), or both send the same request with the value in canonical form: a
// text without surrounding whitespace, in composed Unicode, never blank; an id as the adapter
// canonicalises it, never empty, a dot segment or with a "/". Each value here was once sent raw
// by some *-cli and matched nothing, or the wrong thing, with exit 0. Shared across the *-cli
// repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/jobsuche-client/internal/http";

// ---- adapter (per repo) -------------------------------------------------------------
import type { Transport } from "@maschinenlesbar.org/jobsuche-client/internal/http";
import { okResponse, parity as repoParity } from "./helpers.js";
/** The exit code of a usage error in this repo. */
const USAGE_EXIT = 2;
import { JobsucheClient as Client } from "@maschinenlesbar.org/jobsuche-client/internal/client";
interface Input {
  name: string;
  /** CLI argv that sends `value`. */
  argv: (value: string) => string[];
  /** The same in the library. */
  lib: (client: Client, value: string) => Promise<unknown>;
  /** The value as it went out, read from the request URL (null when it wasn't sent). */
  sent: (url: URL) => string | null;
}
/**
 * Every text filter (sent as a query parameter): `was`, `wo`, `berufsfeld` and `arbeitgeber`
 * (TEXT_FILTERS). `umkreis`, `veroeffentlichtseit`, `angebotsart`, `page` and `size` are numbers
 * or codes, checked by P10, not text.
 */
const textInputs: Input[] = [
  { name: "search --was", argv: (v) => ["search", "--was", v], lib: (c, v) => c.search({ was: v }), sent: (u) => u.searchParams.get("was") },
  { name: "search --wo", argv: (v) => ["search", "--wo", v], lib: (c, v) => c.search({ wo: v }), sent: (u) => u.searchParams.get("wo") },
  { name: "search --berufsfeld", argv: (v) => ["search", "--berufsfeld", v], lib: (c, v) => c.search({ berufsfeld: v }), sent: (u) => u.searchParams.get("berufsfeld") },
  { name: "search --arbeitgeber", argv: (v) => ["search", "--arbeitgeber", v], lib: (c, v) => c.search({ arbeitgeber: v }), sent: (u) => u.searchParams.get("arbeitgeber") },
];
/**
 * Every id that goes into a request path: the reference number of `details`, which goes out
 * base64-encoded as the API's `encryptedJobCode` (an already-encoded code passes unchanged).
 */
const idInputs: Input[] = [
  { name: "details", argv: (v) => ["details", v], lib: (c, v) => c.details(v), sent: (u) => decodeURIComponent(u.pathname.slice(u.pathname.lastIndexOf("/") + 1)) },
];
/**
 * The id as the repo sends it: the trimmed reference number, base64-encoded unless it already is
 * an encoded refnr (an exact round trip to a digit followed by printable ASCII), as details() does.
 * So "." or "a1/../a2" never reaches the path as a dot segment or a slash.
 */
const canonicalId = (value: string): string => {
  const trimmed = value.trim();
  const decoded = Buffer.from(trimmed, "base64").toString("latin1");
  const encoded = /^[0-9][\x21-\x7e]*$/.test(decoded) && Buffer.from(decoded, "latin1").toString("base64") === trimmed;
  return encoded ? trimmed : Buffer.from(trimmed, "utf8").toString("base64");
};
/** A valid answer to any of these requests: an empty search result, or a job listing. */
const respond = (req: HttpRequest): HttpResponse => okResponse(req);
/**
 * The shared body's parity(argv, call, responder) over this repo's parity(argv, call, { responder }),
 * with the library's error as { name, message }, as the shared body reads it.
 */
async function parity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder?: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
) {
  const o = await repoParity(argv, call, responder === undefined ? {} : { responder });
  const e = o.lib.error;
  const error = e === undefined ? undefined : e instanceof Error ? { name: e.constructor.name, message: e.message } : { name: typeof e, message: String(e) };
  return { cli: o.cli, lib: { ok: o.lib.ok, value: o.lib.value, error, requests: o.lib.requests } };
}
// --------------------------------------------------------------------------------------

const TEXT_CORPUS = [
  "Müller", "Müller", "  Müller  ", " Müller ", "Müller\n", "\tMüller", "a  b", "Å",
  "ﬁ", "x".repeat(5000), "", " ", " ", "\n\t", "　",
];
const ID_CORPUS = ["a1", " a1 ", "a1\n", " a1", ".", "..", " .. ", "a1/../a2", "a1/", "/a1", "", "  ", "%2e%2e", "a b"];

type Outcome = Awaited<ReturnType<typeof parity>>;

/** Both sides refused before any request, or both sent the same requests. Returns the one sent URL, if any. */
function sameOutcome(o: Outcome, label: string): URL | undefined {
  if (o.cli.code === USAGE_EXIT) {
    assert.deepEqual(o.cli.requests, [], `${label}: the CLI refused but sent a request`);
    assert.equal(o.lib.ok, false, `${label}: the CLI refused, the library resolved`);
    assert.deepEqual(o.lib.requests, [], `${label}: the library sent a request`);
    assert.match(o.lib.error?.name ?? "", /ValidationError$/, `${label}: ${String(o.lib.error)}`);
    return undefined;
  }
  assert.equal(o.cli.code, 0, `${label}: CLI exit ${o.cli.code}: ${o.cli.err}`);
  assert.equal(o.lib.ok, true, `${label}: the library rejected: ${String(o.lib.error)}`);
  assert.deepEqual(o.lib.requests.map((r) => r.url), o.cli.requests.map((r) => r.url), `${label}: different requests`);
  assert.equal(o.cli.requests.length, 1, label);
  return new URL(o.cli.requests[0]!.url);
}

test("P24: a text filter is sent trimmed and in composed Unicode, or refused; never blank", async () => {
  for (const input of textInputs) {
    for (const value of TEXT_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value.length > 20 ? `${value.slice(0, 20)}…` : value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      if (value.trim() === "") {
        assert.equal(url, undefined, `${label}: a blank value was sent (it reads as "no filter")`);
        continue;
      }
      if (url === undefined) continue;
      const sent = input.sent(url);
      assert.ok(sent !== null && sent !== "", `${label}: not sent`);
      const canonical = [value.trim().normalize("NFC"), value.trim().normalize("NFKC")];
      assert.ok(canonical.includes(sent), `${label}: sent ${JSON.stringify(sent)}`);
    }
  }
});

test("P24: an id is sent in its canonical form, or refused; never empty, a dot segment or with a slash", async () => {
  for (const input of idInputs) {
    for (const value of ID_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      const id = canonicalId(value);
      if (id === "" || id === "." || id === ".." || id.includes("/")) {
        assert.equal(url, undefined, `${label}: sent although it would re-target the request`);
        continue;
      }
      if (url === undefined) continue;
      assert.equal(input.sent(url), id, label);
    }
  }
});
