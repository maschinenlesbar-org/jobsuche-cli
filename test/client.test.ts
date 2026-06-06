import { test } from "node:test";
import assert from "node:assert/strict";
import { JobsucheClient, DEFAULT_API_KEY } from "../src/client/client.js";
import { JobsucheApiError, JobsucheError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>, apiKey?: string): JobsucheClient {
  return new JobsucheClient({ transport: mt.transport, ...(apiKey ? { apiKey } : {}) });
}

const SERVICE = "/jobboerse/jobsuche-service";

test("search sends the default X-API-Key header and params", async () => {
  const mt = constantJson({ stellenangebote: [] });
  await clientWith(mt).search({ was: "Informatiker", wo: "Berlin", size: 10 });
  const req = mt.last();
  assert.equal(req.headers?.["X-API-Key"], DEFAULT_API_KEY);
  const url = new URL(req.url);
  assert.equal(url.pathname, `${SERVICE}/pc/v4/jobs`);
  assert.equal(url.searchParams.get("was"), "Informatiker");
  assert.equal(url.searchParams.get("wo"), "Berlin");
  assert.equal(url.searchParams.get("size"), "10");
});

test("a custom apiKey overrides the default header", async () => {
  const mt = constantJson({ stellenangebote: [] });
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
