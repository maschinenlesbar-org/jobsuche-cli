// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { JobsucheClient as Client } from "../src/client/client.js";
import {
  JobsucheError as BaseError,
  JobsucheParseError as ParseError,
  JobsucheValidationError as ValidationError,
} from "../src/client/errors.js";
import { obtainKey } from "../src/client/obtain-key.js";
import type { JobSearchParams } from "../src/client/types.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.search({ was: "x" });
const textBody = (text: string): unknown => ({ maxErgebnisse: 1, ergebnisliste: [{ referenznummer: "10001-1-S", stellenangebotsTitel: text }] });
const readText = (result: unknown): string =>
  (result as { ergebnisliste: Array<{ stellenangebotsTitel: string }> }).ergebnisliste[0]!.stellenangebotsTitel;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). */
const malformedBodies: unknown[] = [
  null,
  {},
  [],
  "text",
  42,
  { message: "quota exceeded" },
  { error: "rate limited" },
  { maxErgebnisse: "1" },
  { maxErgebnisse: 1, ergebnisliste: null },
  { maxErgebnisse: 1, ergebnisliste: [null] },
  { maxErgebnisse: 1, ergebnisliste: [{ stellenangebotsTitel: "no refnr" }] },
];
/**
 * A transport that never reaches the network: a call that slips past validation must
 * fail here (as a network error, which the test reports) rather than hit the live API.
 */
const offline = async (): Promise<never> => {
  throw new Error("this test makes no request");
};
const C = (options: Record<string, unknown> = {}): Client =>
  new Client({ transport: offline, maxRetries: 0, ...options } as ConstructorParameters<typeof Client>[0]);
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["search(5)", () => C().search(5 as unknown as JobSearchParams)],
  ["search('was=x')", () => C().search("was=x" as unknown as JobSearchParams)],
  ["search({ was: {} })", () => C().search({ was: {} as unknown as string })],
  ["search({ umkreis: NaN })", () => C().search({ umkreis: Number.NaN })],
  ["search({ was: ['a', 'b'] })", () => C().search({ was: ["a", "b"] as unknown as string })],
  ["search({ zeitarbeit: 'false' })", () => C().search({ zeitarbeit: "false" as unknown as boolean })],
  ["search({ page: 0 })", () => C().search({ page: 0 })],
  ["details({})", () => C().details({} as unknown as string)],
  ["details(undefined)", () => C().details(undefined as unknown as string)],
  ["details(5)", () => C().details(5 as unknown as string)],
  ["details('')", () => C().details("")],
  ["timeoutMs: 'x'", () => C({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => C({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => C({ maxRetries: 1.5 })],
  ["baseUrl: 5", () => C({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => C({ userAgent: {} as unknown as string })],
  ["apiKey: {}", () => C({ apiKey: {} as unknown as string })],
  ["apiKey: 5", () => C({ apiKey: 5 as unknown as string })],
  ["defaultHeaders: 'x'", () => C({ defaultHeaders: "x" as unknown as Record<string, string> })],
  ["defaultHeaders: { X: 5 }", () => C({ defaultHeaders: { X: 5 as unknown as string } })],
  ["transport: 'fetch'", () => C({ transport: "fetch" as unknown as never })],
  ["sleep: 5", () => C({ sleep: 5 as unknown as never })],
  ["new Client('x')", () => new Client("x" as unknown as ConstructorParameters<typeof Client>[0])],
  ["obtainKey({ sourceUrl: 5 })", () => obtainKey({ sourceUrl: 5 as unknown as string, transport: offline })],
  ["obtainKey({ sourceUrl: 'ftp://h' })", () => obtainKey({ sourceUrl: "ftp://h", transport: offline })],
  ["obtainKey({ timeoutMs: -1 })", () => obtainKey({ timeoutMs: -1, transport: offline })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
