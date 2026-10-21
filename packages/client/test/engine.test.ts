import { test } from "node:test";
import { TextDecoder } from "node:util";
import assert from "node:assert/strict";
import {
  RequestEngine,
  bigIntegerKeysOption,
  cleartextCredentialsProblem,
  cleartextProblem,
  firstInexactNumber,
  scanNumbers,
} from "../src/engine.js";
import { JobsucheClient, woNote } from "../src/client.js";
import {
  JobsucheApiError,
  JobsucheNetworkError,
  JobsucheParseError,
  JobsucheValidationError,
  cutText,
  toWellFormed,
} from "../src/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { nodeHttpTransport, type HttpResponse } from "../src/http.js";

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

test("the engine rejects a non-http(s) base URL as a validation error before any request, even with a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org", "not a url"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () =>
        new RequestEngine({
          baseUrl,
          transport: mt.transport,
          defaultHeaders: { "X-API-Key": "test-key" },
        }),
      (err: unknown) => err instanceof JobsucheValidationError && !(err instanceof JobsucheNetworkError),
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
    assert.throws(
      () => new RequestEngine({ baseUrl }),
      /^JobsucheValidationError: Invalid baseUrl: A base URL cannot have a query \(\?\) or fragment \(#\)\.$/,
      baseUrl,
    );
  }
});

test("base-URL errors never echo userinfo", () => {
  for (const baseUrl of ["ftp://u:pw@example.test", "https://u:pw@example.test/?q", "https://u:pw@exa mple.test"]) {
    assert.throws(() => new RequestEngine({ baseUrl }), (err: unknown) => {
      assert.ok(err instanceof JobsucheValidationError);
      assert.doesNotMatch(err.message, /pw/);
      return true;
    });
  }
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

test("getJson decodes the body by its declared charset and drops a BOM", async () => {
  const text = { ort: "München" };
  const latin1 = makeMockTransport(() => rawResponse(Buffer.from(JSON.stringify(text), "latin1"), "application/json; charset=ISO-8859-1"));
  assert.deepEqual(await new RequestEngine({ transport: latin1.transport }).getJson("/x"), text);
  const bom = makeMockTransport(() => rawResponse(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(text))]), "application/json"));
  assert.deepEqual(await new RequestEngine({ transport: bom.transport }).getJson("/x"), text);
  const unknown = makeMockTransport(() => rawResponse("{}", "application/json; charset=x-no-such"));
  await assert.rejects(new RequestEngine({ transport: unknown.transport }).getJson("/x"), (e: unknown) => e instanceof JobsucheParseError && /x-no-such/.test(e.message));
});

test("cleartextProblem names the host and each secret, never its value; the deprecated alias keeps its shape", () => {
  assert.equal(cleartextProblem("http://[::1]:8080"), undefined);
  assert.equal(cleartextProblem("http://127.1"), undefined);
  assert.equal(cleartextProblem("not a url"), undefined);
  assert.equal(
    cleartextProblem("http://u:pw@mirror.example:8080", ["the API key"]),
    "the API key and the base URL's credentials are sent unencrypted to mirror.example:8080 (http:, not https:)",
  );
  assert.equal(cleartextProblem("http://mirror.example", ["the API key"]), "the API key is sent unencrypted to mirror.example (http:, not https:)");
  assert.equal(cleartextCredentialsProblem("http://mirror.example", false), undefined);
  assert.equal(
    cleartextCredentialsProblem("http://mirror.example", true),
    "The API key is sent unencrypted to mirror.example (http:, not https:).",
  );
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("a server detail cut at 500 characters keeps the message well-formed", async () => {
  const detail = "a" + "\u{1f600}".repeat(400);
  const engine = new RequestEngine({ transport: async () => ({ status: 500, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ detail })) }) });
  await assert.rejects(engine.getJson("/x"), (err: Error) => {
    assert.equal(toWellFormed(err.message), err.message);
    assert.match(err.message, /…$/);
    return true;
  });
});

test("an error envelope's text cut at 200 characters keeps the parse error well-formed", async () => {
  const message = "a" + "\u{1f600}".repeat(400);
  const engine = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(message) }) });
  await assert.rejects(engine.getJson("/x"), (err: Error) => {
    const cause = (err.cause as Error).message;
    assert.equal(toWellFormed(cause), cause);
    return true;
  });
});

test("own messages quote a server or user value at most 200 characters long (L3)", async () => {
  const long = "x".repeat(5000);
  const redirect = new RequestEngine({ maxRedirects: 0, transport: async () => ({ status: 302, headers: { location: `https://other.example/${long}` }, body: Buffer.alloc(0) }) });
  await assert.rejects(redirect.getJson("/x"), (err: Error) => err.message.length < 400 && /redirect to https:\/\/other\.example\/x+… not followed/.test(err.message));
  const html = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": `text/${long}` }, body: Buffer.from("<html>") }) });
  await assert.rejects(html.getJson("/x"), (err: Error) => err.message.length < 400 && /Content-Type "text\/x+…"/.test(err.message));
  const charset = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": `application/json; charset=${long}` }, body: Buffer.from("{}") }) });
  await assert.rejects(charset.getJson("/x"), (err: Error) => err.message.length < 400 && /charset "x+…"/.test(err.message));
  const client = new JobsucheClient({ transport: async () => ({ status: 200, headers: {}, body: Buffer.from("{}") }) });
  await assert.rejects(client.search({ [long]: "1" } as never), (err: Error) => err.message.length < 600 && /Unknown search parameter "x{200}"…/.test(err.message));
});

test("the --wo note quotes the place asked for and the place used at most 200 characters long (L3)", () => {
  const note = woNote("Heidelberg" + "x".repeat(5000), { maxErgebnisse: 0, woOutput: { bereinigterOrt: "Bonn" + "y".repeat(5000) } } as never) ?? "";
  assert.match(note, /searched around "Bonny+…" for --wo "Heidelbergx+…"/);
  assert.ok(note.length < 600, `${note.length}`);
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  const basic = Buffer.from("alice:pa ss-pw", "latin1").toString("base64");
  const body = JSON.stringify({ detail: `no: Basic ${basic} / alice:pa ss-pw / pa ss-pw` });
  const engine = new RequestEngine({
    baseUrl: "https://alice:pa%20ss-pw@mirror.test",
    transport: async () => ({ status: 401, headers: { "content-type": "application/json" }, body: Buffer.from(body) }),
  });
  await assert.rejects(engine.getJson("/x"), (err: JobsucheApiError) => {
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    return true;
  });
});

test("onRetry is called once per retry, with the event fields, right before the sleep", async () => {
  const log: string[] = [];
  const events: unknown[] = [];
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ < 2
      ? { status: 503, headers: n === 1 ? { "retry-after": "2" } : {}, body: Buffer.from("{}") }
      : jsonResponse({ ok: 1 }),
  );
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://user:pw@example.test",
    maxRetries: 3,
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRetry: (ev) => {
      events.push(ev);
      log.push("retry");
    },
  });
  await e.request("GET", "/x");
  assert.deepEqual(log, ["retry", "sleep 2000", "retry", "sleep 400"]);
  assert.deepEqual(events, [
    { retry: 1, maxRetries: 3, delayMs: 2000, status: 503, url: "https://example.test/x" },
    { retry: 2, maxRetries: 3, delayMs: 400, status: 503, url: "https://example.test/x" },
  ]);
});

test("onRetry reports a reset connection without a status", async () => {
  let n = 0;
  const events: unknown[] = [];
  const mt = makeMockTransport(() => {
    if (n++ === 0) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {}, onRetry: (ev) => void events.push(ev) });
  await e.request("GET", "/x");
  assert.equal(events.length, 1);
  assert.equal((events[0] as { status?: number }).status, undefined);
  assert.equal((events[0] as { retry: number }).retry, 1);
});

test("a throw in onRetry is swallowed", async () => {
  let n = 0;
  const mt = makeMockTransport(() => (n++ === 0 ? { status: 503, headers: {}, body: Buffer.from("{}") } : jsonResponse({ ok: 1 })));
  const e = new RequestEngine({
    transport: mt.transport,
    sleep: async () => {},
    onRetry: () => {
      throw new Error("boom");
    },
  });
  await e.request("GET", "/x");
  assert.equal(mt.calls.length, 2);
});

test("onRetry is never called without a retry", async () => {
  const events: unknown[] = [];
  const onRetry = (ev: unknown) => void events.push(ev);
  const ok = new RequestEngine({ transport: makeMockTransport(() => jsonResponse({})).transport, sleep: async () => {}, onRetry });
  await ok.request("GET", "/x");
  const notFound = new RequestEngine({
    transport: makeMockTransport(() => jsonResponse({ detail: "no" }, 404)).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(notFound.request("GET", "/x"), JobsucheApiError);
  // retries exhausted: the last 503 is an error, not a retry
  const down = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: {}, body: Buffer.from("{}") })).transport,
    maxRetries: 1,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(down.request("GET", "/x"), JobsucheApiError);
  assert.equal(events.length, 1);
  // a Retry-After over the cap is not retried
  const long = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: { "retry-after": "999999" }, body: Buffer.from("{}") })).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(long.request("GET", "/x"), JobsucheApiError);
  assert.equal(events.length, 1);
});

test("onRetry must be a function", () => {
  assert.throws(() => new RequestEngine({ onRetry: 5 as never }), JobsucheValidationError);
});

test("a number the answer's JSON cannot carry exactly is a parse error, never a changed value (K1)", async () => {
  const path = "/jobboerse/jobsuche-service/pc/v6/jobs";
  const body = (n: string) => `{"maxErgebnisse":${n},"ergebnisliste":[{"referenznummer":"9007199254740993","entfernung":1}]}`;
  for (const n of [
    "1e400", "-1e400", "12345678901234567890", "9007199254740993",
    "12345678901234567890.0", "9007199254740993e0", "90071992547409930E-1", "9007199254740992.5",
    "-9007199254740992.5", "1e-400", "-0.0001e-399", "123456789012345678901234567890",
    // Subnormal: below the smallest normal double a double has fewer digits (D4).
    "3e-324", "4e-324", "-4.9e-324", "1.2345678901234567e-310", "2.225073858507201e-309",
  ]) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    await assert.rejects(e.getJson(path), (err) => {
      assert.ok(err instanceof JobsucheParseError, n);
      assert.equal(err.message, `GET https://rest.arbeitsagentur.de${path}: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // What a double carries exactly (or as JSON means it) passes, digits inside strings included.
  const ok: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53],
    ["90071992547409920E-1", 2 ** 53], ["1.2e21", 1.2e21], ["1e21", 1e21], ["0", 0], ["-0", -0], ["0.0e-500", 0],
    ["0e5", 0], ["1.00000000000000001", 1], ["5e-324", 5e-324], ["1e2", 100], ["1.10", 1.1], ["0.1", 0.1],
    // A double a server printed in its shortest form reads back as that double and prints as the
    // same number: not a changed value, though the decimal is not the double's exact binary value.
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1E23", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
    ["4.35e30", 4.35e30],
    // A subnormal printed as written, and the smallest normal double (D4).
    ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308],
  ];
  for (const [n, value] of ok) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    const got = await e.getJson<{ maxErgebnisse: number }>(path);
    assert.equal(got.maxErgebnisse, value, n);
  }
});

test("a timeout, the size cap, a refused connection and a DNS failure name the request (K3)", async () => {
  // They said only "Request exceeded the 20ms deadline", "Response exceeded maxResponseBytes (…)" and
  // "connect ECONNREFUSED 127.0.0.1:9", where a reset says "GET <url> failed: socket hang up".
  const path = "/jobboerse/jobsuche-service/pc/v6/jobs";
  const url = `http://127.0.0.1:9${path}`;
  const original = new JobsucheNetworkError("getaddrinfo ENOTFOUND rest.invalid");
  const cases: Array<[string, ConstructorParameters<typeof RequestEngine>[0], RegExp]> = [
    ["engine deadline", { transport: () => new Promise<HttpResponse>(() => {}), timeoutMs: 20 }, /^Request exceeded the 20ms deadline$/],
    ["size cap", { transport: async () => rawResponse("x".repeat(100), "application/json"), maxResponseBytes: 10 }, /^Response exceeded maxResponseBytes \(10/],
    ["refused", { transport: async () => { throw new JobsucheNetworkError("connect ECONNREFUSED 127.0.0.1:9"); } }, /^connect ECONNREFUSED 127\.0\.0\.1:9$/],
    ["dns", { transport: async () => { throw original; } }, /^getaddrinfo ENOTFOUND rest\.invalid$/],
  ];
  for (const [name, options, reason] of cases) {
    // The engine sends the userinfo as a header, never in the URL: the message has none.
    const e = new RequestEngine({ baseUrl: "http://user:secret@127.0.0.1:9", maxRetries: 0, ...options });
    await assert.rejects(e.getJson(path), (err) => {
      assert.ok(err instanceof JobsucheNetworkError, name);
      assert.ok(err.message.startsWith(`GET ${url} failed: `), `${name}: ${err.message}`);
      assert.match(err.message.replace(/^GET \S+ failed: /, ""), reason, name);
      assert.doesNotMatch(err.message, /secret/, name);
      if (name === "dns") assert.equal(err.cause, original);
      return true;
    });
  }
  // A message that names the request already is not prefixed twice.
  const named = new RequestEngine({
    baseUrl: "http://127.0.0.1:9",
    transport: async () => { throw new JobsucheNetworkError(`GET ${url} failed: x`); },
  });
  await assert.rejects(named.getJson(path), { message: `GET ${url} failed: x` });
});

test("the default transport's refused connection names the request (K3)", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const e = new RequestEngine({ baseUrl: `http://127.0.0.1:${port}`, transport: nodeHttpTransport, maxRetries: 0 });
  await assert.rejects(e.getJson("/x"), (err) => {
    assert.ok(err instanceof JobsucheNetworkError);
    assert.match(err.message, new RegExp(`^GET http://127\\.0\\.0\\.1:${port}/x failed: connect ECONNREFUSED`));
    assert.ok(err.cause instanceof Error);
    return true;
  });
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  // With it as the prototype, its "content-type" was read as the answer's (an unknown charset).
  const headers = JSON.parse('{"__proto__":{"content-type":"application/json; charset=x-no-such-charset"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await e.getJson("/x"), { a: 1 });
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("an answer error names the request: method and URL, userinfo redacted (D9)", async () => {
  const answers: Array<[string, () => HttpResponse]> = [
    ["not valid JSON", () => rawResponse("<html>", "application/json")],
    ["expected a JSON answer", () => rawResponse("<html>", "text/html")],
    ["empty response body", () => rawResponse(" ", "application/json")],
    ["cannot be represented exactly", () => rawResponse('{"n":1e400}', "application/json")],
    ["unsupported response charset", () => rawResponse("{}", "application/json; charset=x-bogus")],
  ];
  const base = new URL("https://rest.arbeitsagentur.de");
  base.username = "alice";
  base.password = "s3cret";
  for (const [what, respond] of answers) {
    const e = new RequestEngine({ baseUrl: base.href.replace(/\/$/, ""), transport: makeMockTransport(respond).transport });
    await assert.rejects(e.getJson("/items", { q: "x" }), (err: unknown) => {
      assert.ok(err instanceof JobsucheParseError, what);
      assert.ok(err.message.startsWith(`GET ${base.protocol}//***@${base.host}`), err.message);
      assert.ok(err.message.includes("/items?q=x: ") && err.message.includes(what), err.message);
      assert.ok(!err.message.includes("s3cret"), err.message);
      return true;
    });
  }
  // A non-JSON answer names its Content-Type, so it reads as an upstream page, not a client bug.
  const html = new RequestEngine({ transport: makeMockTransport(() => rawResponse("<html>", "text/html; charset=utf-8")).transport });
  await assert.rejects(html.getJson("/x"), (err: Error) =>
    err.message === 'GET https://rest.arbeitsagentur.de/x: expected a JSON answer, got Content-Type "text/html; charset=utf-8".');
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A lone surrogate written as an escape (high alone, low alone); a real pair and an escaped backslash stay.
    ["lone escapes", Buffer.from('{"a":"x\\ud800y","b":"\\udc00","c":"\\ud83d\\ude00","d":"\\\\ud800"}'), "application/json", { a: "x\ufffdy", b: "\ufffd", c: "\u{1f600}", d: "\\ud800" }, 2],
    // A lone surrogate in a member name.
    ["lone in a key", Buffer.from('{"\\udbff":1}'), "application/json", { "\ufffd": 1 }, 1],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","b":"\ufffd"}')]), "application/json", { a: "\ufffd\ufffd", b: "\ufffd" }, 2],
    // A byte undefined in a single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xa5]), Buffer.from('"}')]), "application/json; charset=iso-8859-3", { a: "\ufffd" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.getJson("/items", { q: "x" });
    assert.deepEqual(value, expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `GET https://rest.arbeitsagentur.de/items?q=x: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => rawResponse('{"a":"\\u00fc\ufffd"}', "application/json")).transport });
  assert.deepEqual(await ok.getJson("/x"), { a: "ü\ufffd" });
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => rawResponse('"\\ud800"', "application/json")).transport });
  assert.equal(await throwing.getJson("/x"), "\ufffd");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), JobsucheValidationError);
});

test("an answer longer than V8's longest string is a JobsucheParseError naming the request, not a plain Error (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length.
  const huge = Buffer.from('{"referenznummer":"x"}                 ');
  const tooLong = Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input !== undefined && input.byteLength === huge.length) throw tooLong;
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === huge.length && args[0] === "utf8") throw tooLong;
    return toString.apply(this, args);
  });
  const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "application/json")).transport });
  await assert.rejects(e.getJson("/items", { q: "x" }), (err: unknown) => {
    assert.ok(err instanceof JobsucheParseError, String(err));
    assert.equal(
      err.message,
      `GET https://rest.arbeitsagentur.de/items?q=x: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters).`,
    );
    return true;
  });
  // An error status with such a body is still the API error, without the unreadable body.
  const failing = new RequestEngine({ maxResponseBytes: 0, maxRetries: 0, transport: makeMockTransport(() => rawResponse(huge, "text/plain", 500)).transport });
  await assert.rejects(failing.getJson("/x"), (err: unknown) => err instanceof JobsucheApiError && err.status === 500 && err.body === "");
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson("/x"), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson("/x"), /not valid JSON/);
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof JobsucheValidationError && err.message === "Invalid bigIntegerKeys: Expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
  // The client declares none: the API's answers carry no number past 2^53.
});
