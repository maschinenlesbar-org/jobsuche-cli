import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { JobsucheApiError, JobsucheParseError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("jobboerse/"), "https://example.test/jobboerse/");
  assert.equal(
    e.buildUrl("/x", { a: "1", b: ["2", "3"] }),
    "https://example.test/x?a=1&b=2&b=3",
  );
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
});

test("getJson throws JobsucheParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), JobsucheParseError);
});

test("a 503 is retried up to maxRetries then surfaces as JobsucheApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async () => {},
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof JobsucheApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

function redirect(location: string, status = 302) {
  return { status, headers: { location }, body: Buffer.alloc(0) };
}

test("a redirect is followed and decoded", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? redirect("/moved") : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
  assert.equal(new URL(mt.last().url).pathname, "/moved");
});

test("a same-origin redirect keeps the X-API-Key header", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1
      ? redirect("https://example.test/elsewhere")
      : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({
    baseUrl: "https://example.test",
    transport: mt.transport,
    defaultHeaders: { "X-API-Key": "secret-key" },
  });
  await e.getJson("/x");
  // The second (redirected) request is to the same origin and must keep the key.
  assert.equal(mt.last().headers?.["X-API-Key"], "secret-key");
});

test("a cross-origin redirect strips credential headers", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1
      ? redirect("https://evil.test/steal")
      : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({
    baseUrl: "https://example.test",
    transport: mt.transport,
    defaultHeaders: { "X-API-Key": "secret-key", Authorization: "Bearer t", Cookie: "s=1" },
  });
  await e.getJson("/x");
  const last = mt.last();
  assert.equal(new URL(last.url).host, "evil.test");
  // None of the credential headers may be forwarded cross-origin.
  assert.equal(last.headers?.["X-API-Key"], undefined);
  assert.equal(last.headers?.["Authorization"], undefined);
  assert.equal(last.headers?.["Cookie"], undefined);
  // Non-credential headers are still present.
  assert.equal(last.headers?.["Accept"], "application/json");
});

// Control characters are built from char codes so no raw control bytes ever
// appear in this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1 = String.fromCharCode(0x9b); // a C1 control (CSI)
const DEL = String.fromCharCode(0x7f);

/** True if the string contains any C0/C1 control char except tab/newline. */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
  });
}

test("error detail is stripped of terminal control characters", async () => {
  // ESC + C1 + BEL + DEL interleaved with printable text.
  const evil = `boom${ESC}[31mred${BEL}${C1}2J${DEL}!`;
  const mt = makeMockTransport(() => jsonResponse({ detail: evil }, 500));
  const e = new RequestEngine({
    baseUrl: "https://example.test",
    transport: mt.transport,
    maxRetries: 0,
  });

  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof JobsucheApiError);
      // The control bytes are gone from both the structured detail and the
      // human-readable message that run.ts prints to stderr...
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      // ...while the printable characters are preserved (tab/newline kept too).
      assert.equal(err.detail, "boom[31mred2J!");
      return true;
    },
  );
});

test("a non-JSON content type is stripped of control chars in the parse error", async () => {
  const evilType = `text/html${ESC}[2K`;
  const mt = makeMockTransport(() =>
    rawResponse(`<html>${BEL}bad</html>`, evilType),
  );
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });

  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof JobsucheParseError);
      assert.ok(!hasControlChars(err.message));
      const cause = err.cause instanceof Error ? err.cause.message : "";
      assert.ok(!hasControlChars(cause));
      return true;
    },
  );
});
