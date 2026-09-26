import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { JobsucheApiError, JobsucheNetworkError, JobsucheParseError } from "../src/client/errors.js";
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
      // ...while the printable characters are preserved.
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

test("the engine rejects a non-http(s) base URL before any request, even with a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org", "not a url"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () =>
        new RequestEngine({
          baseUrl,
          transport: mt.transport,
          defaultHeaders: { "X-API-Key": "test-key" },
        }),
      JobsucheNetworkError,
      baseUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});

// The gateway's error body is {"messages": [{code, path, detail}]}; it used to be
// ignored, so every 400 and 404 came without a reason.
test("the gateway's messages[] become the error detail", async () => {
  const cases: [number, unknown, string][] = [
    [
      400,
      {
        timestamp: "2026-09-26T07:51:33.813567259Z",
        logref: "7242a133",
        messages: [{ code: "EINGABEN_UNVOLLSTAENDIG_ODER_FEHLERHAFT", path: "page", detail: "Wert ungültig" }],
      },
      "page: Wert ungültig (EINGABEN_UNVOLLSTAENDIG_ODER_FEHLERHAFT)",
    ],
    [404, { timestamp: "t", messages: [{ code: "STELLENANGEBOT_NICHT_GEFUNDEN" }] }, "STELLENANGEBOT_NICHT_GEFUNDEN"],
    [400, { messages: [{ detail: "a" }, null, "x", { path: "p" }, { path: "q", detail: "b" }] }, "a; q: b"],
  ];
  for (const [status, body, detail] of cases) {
    const mt = makeMockTransport(() => jsonResponse(body, status));
    const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport, maxRetries: 0 });
    await assert.rejects(
      () => e.getJson("/x"),
      (err: unknown) => {
        assert.ok(err instanceof JobsucheApiError);
        assert.equal(err.detail, detail);
        assert.match(err.message, new RegExp(`: ${detail.replace(/[()]/g, "\\$&")}$`));
        return true;
      },
    );
  }
});

test("messages[] text is stripped of control characters", async () => {
  const mt = makeMockTransport(() => jsonResponse({ messages: [{ code: `C${ESC}[2J`, detail: `d${BEL}` }] }, 400));
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), (err: unknown) => err instanceof JobsucheApiError && err.detail === "d (C[2J)");
});

test("the engine rejects a base URL with a query or fragment", () => {
  for (const baseUrl of ["https://example.test/?x=1", "https://example.test/a#f"]) {
    assert.throws(() => new RequestEngine({ baseUrl }), /must not contain a query or fragment/, baseUrl);
  }
});

test("base-URL errors redact userinfo", () => {
  assert.throws(() => new RequestEngine({ baseUrl: "ftp://u:pw@example.test" }), (err: unknown) => {
    assert.ok(err instanceof JobsucheNetworkError);
    assert.doesNotMatch(err.message, /pw/);
    return true;
  });
  assert.throws(() => new RequestEngine({ baseUrl: "https://u:pw@example.test/?q" }), (err: unknown) => {
    assert.ok(err instanceof JobsucheNetworkError);
    assert.doesNotMatch(err.message, /pw/);
    assert.match(err.message, /\*\*\*@example\.test/);
    return true;
  });
});

// A redirect loop ended in a bare "HTTP 302 for GET …" once maxRedirects ran out.
test("a redirect loop names the target and the limit", async () => {
  const mt = makeMockTransport(() => redirect("/loop"));
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/loop"),
    (err: unknown) => {
      assert.ok(err instanceof JobsucheApiError);
      assert.equal(err.status, 302);
      assert.equal(err.location, "https://example.test/loop");
      assert.equal(
        err.message,
        "HTTP 302 for GET https://example.test/loop: redirect to https://example.test/loop not followed (stopped after 5 redirects)",
      );
      return true;
    },
  );
  assert.equal(mt.calls.length, 6);
});

test("300/304/305, a missing and a malformed Location are not followed and say why", async () => {
  const cases: [number, Record<string, string>, RegExp][] = [
    [300, { location: "/x" }, /HTTP 300 .*: redirect to https:\/\/example\.test\/x not followed$/],
    [305, { location: "http://proxy.test/" }, /redirect to http:\/\/proxy\.test\/ not followed$/],
    [302, {}, /redirect not followed \(no Location header\)$/],
    [302, { location: "http://[bad" }, /redirect to http:\/\/\[bad not followed$/],
  ];
  for (const [status, headers, message] of cases) {
    const mt = makeMockTransport(() => ({ status, headers, body: Buffer.alloc(0) }));
    const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
    await assert.rejects(() => e.getJson("/x"), (err: unknown) => err instanceof JobsucheApiError && message.test(err.message));
    assert.equal(mt.calls.length, 1);
  }
});

test("server text on stderr drops bidi controls and stays on one line", async () => {
  const RLO = String.fromCharCode(0x202e);
  const mt = makeMockTransport(() => jsonResponse({ detail: `a${RLO}b\nError: forged\u2028c` }, 500));
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport, maxRetries: 0 });
  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => err instanceof JobsucheApiError && err.detail === "ab Error: forged c",
  );
});
