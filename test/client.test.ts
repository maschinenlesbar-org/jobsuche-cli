import { test } from "node:test";
import assert from "node:assert/strict";
import { JobsucheClient } from "../src/client/client.js";
import { JobsucheApiError, JobsucheError, JobsucheNetworkError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";
import { V6_NO_MATCH, V6_SEARCH } from "./fixtures.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>, apiKey?: string): JobsucheClient {
  return new JobsucheClient({ transport: mt.transport, ...(apiKey ? { apiKey } : {}) });
}

const SERVICE = "/jobboerse/jobsuche-service";

test("search forwards the supplied X-API-Key and params", async () => {
  const mt = constantJson({ ergebnisliste: [] });
  await clientWith(mt, "test-key").search({ was: "Informatiker", wo: "Berlin", size: 10 });
  const req = mt.last();
  assert.equal(req.headers?.["X-API-Key"], "test-key");
  const url = new URL(req.url);
  assert.equal(url.pathname, `${SERVICE}/pc/v6/jobs`);
  assert.equal(url.searchParams.get("was"), "Informatiker");
  assert.equal(url.searchParams.get("wo"), "Berlin");
  assert.equal(url.searchParams.get("size"), "10");
});

test("no X-API-Key header is sent when no key is supplied (no bundled default)", async () => {
  const mt = constantJson({ ergebnisliste: [] });
  await clientWith(mt).search();
  assert.equal(mt.last().headers?.["X-API-Key"], undefined);
});

test("a custom apiKey sets the header", async () => {
  const mt = constantJson({ ergebnisliste: [] });
  await clientWith(mt, "my-key").search();
  assert.equal(mt.last().headers?.["X-API-Key"], "my-key");
});

test("details base64-encodes a refnr", async () => {
  const mt = constantJson({});
  await clientWith(mt).details("10001-1002716922-S");
  assert.equal(
    new URL(mt.last().url).pathname,
    `${SERVICE}/pc/v4/jobdetails/MTAwMDEtMTAwMjcxNjkyMi1T`,
  );
});

test("details passes an already-encoded code through unchanged", async () => {
  const mt = constantJson({});
  await clientWith(mt).details("MTAwMDEtMTAwMjcxNjkyMi1T");
  assert.equal(
    new URL(mt.last().url).pathname,
    `${SERVICE}/pc/v4/jobdetails/MTAwMDEtMTAwMjcxNjkyMi1T`,
  );
});

test("details base64-encodes a hyphenless numeric refnr (no false-positive passthrough)", async () => {
  const mt = constantJson({});
  await clientWith(mt).details("1002716922");
  // "1002716922" is a refnr, NOT base64; it must be encoded to "MTAwMjcxNjkyMg==".
  assert.equal(
    new URL(mt.last().url).pathname,
    `${SERVICE}/pc/v4/jobdetails/${encodeURIComponent("MTAwMjcxNjkyMg==")}`,
  );
});

test("details rejects an empty / whitespace refnr before requesting", async () => {
  const mt = constantJson({});
  await assert.rejects(() => clientWith(mt).details("   "), JobsucheError);
  assert.equal(mt.calls.length, 0);
});

test("a 404 raises JobsucheApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({}, 404));
  await assert.rejects(
    () => clientWith(mt).details("x-y-z"),
    (err) => err instanceof JobsucheApiError && err.status === 404,
  );
});

test("the client rejects a non-http(s) base URL, so a custom transport never sees it with the key", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = constantJson({ ergebnisliste: [] });
    assert.throws(
      () => new JobsucheClient({ baseUrl, transport: mt.transport, apiKey: "test-key" }),
      JobsucheNetworkError,
      baseUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});

// /pc/v4/jobs answers an empty 403 even with the right key (2026-09); search uses
// the upstream's documented /pc/v6/jobs, whose listings are `ergebnisliste`
// entries keyed by `referenznummer` (the same field names as details).
test("search reads the v6 envelope, and a listing's referenznummer feeds details", async () => {
  const mt = makeMockTransport((req) =>
    new URL(req.url).pathname.endsWith("/pc/v6/jobs") ? jsonResponse(V6_SEARCH) : jsonResponse({}),
  );
  const client = clientWith(mt, "k");
  const page = await client.search({ was: "Informatiker", wo: "Berlin", size: 1 });
  assert.equal(page.maxErgebnisse, 286);
  const first = page.ergebnisliste?.[0];
  assert.ok(first);
  assert.equal(first.referenznummer, "14225-d678889039fc0001-S");
  assert.equal(first.firma, "Bundesinstitut für Risikobewertung (BfR)");
  assert.equal(first.stellenlokationen?.[0]?.adresse?.ort, "Berlin");
  assert.equal(first.entfernung, 9);
  await client.details(first.referenznummer);
  assert.equal(
    new URL(mt.last().url).pathname,
    `${SERVICE}/pc/v4/jobdetails/${Buffer.from("14225-d678889039fc0001-S").toString("base64")}`,
  );
});

test("a no-match v6 search has no ergebnisliste", async () => {
  const mt = constantJson(V6_NO_MATCH);
  const page = await clientWith(mt).search({ was: "Xyzzyqwvbnm" });
  assert.equal(page.maxErgebnisse, 0);
  assert.equal(page.ergebnisliste, undefined);
});
