import { test } from "node:test";
import assert from "node:assert/strict";
import { JobsucheClient, woNote } from "../src/client.js";
import { JobsucheApiError, JobsucheError, JobsucheNetworkError, JobsucheParseError, JobsucheValidationError } from "../src/errors.js";
import { makeMockTransport, jsonResponse, constantJson, okResponse, rawResponse } from "./helpers.js";
import { RequestEngine } from "../src/engine.js";
import { V6_NO_MATCH, V6_SEARCH } from "./fixtures.js";
import { isBlank } from "../src/validate.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>, apiKey?: string): JobsucheClient {
  return new JobsucheClient({ transport: mt.transport, ...(apiKey ? { apiKey } : {}) });
}

const SERVICE = "/jobboerse/jobsuche-service";

test("search forwards the supplied X-API-Key and params", async () => {
  const mt = constantJson({ maxErgebnisse: 0, ergebnisliste: [] });
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
  const mt = constantJson({ maxErgebnisse: 0, ergebnisliste: [] });
  await clientWith(mt).search();
  assert.equal(mt.last().headers?.["X-API-Key"], undefined);
});

test("a custom apiKey sets the header", async () => {
  const mt = constantJson({ maxErgebnisse: 0, ergebnisliste: [] });
  await clientWith(mt, "my-key").search();
  assert.equal(mt.last().headers?.["X-API-Key"], "my-key");
});

test("details base64-encodes a refnr", async () => {
  const mt = makeMockTransport(okResponse);
  await clientWith(mt).details("10001-1002716922-S");
  assert.equal(
    new URL(mt.last().url).pathname,
    `${SERVICE}/pc/v4/jobdetails/MTAwMDEtMTAwMjcxNjkyMi1T`,
  );
});

test("details passes an already-encoded code through unchanged", async () => {
  const mt = makeMockTransport(okResponse);
  await clientWith(mt).details("MTAwMDEtMTAwMjcxNjkyMi1T");
  assert.equal(
    new URL(mt.last().url).pathname,
    `${SERVICE}/pc/v4/jobdetails/MTAwMDEtMTAwMjcxNjkyMi1T`,
  );
});

test("details base64-encodes a hyphenless numeric refnr (no false-positive passthrough)", async () => {
  const mt = makeMockTransport(okResponse);
  await clientWith(mt).details("1002716922");
  // "1002716922" is a refnr, NOT base64; it must be encoded to "MTAwMjcxNjkyMg==".
  assert.equal(
    new URL(mt.last().url).pathname,
    `${SERVICE}/pc/v4/jobdetails/${encodeURIComponent("MTAwMjcxNjkyMg==")}`,
  );
});

test("details rejects an empty / whitespace refnr before requesting", async () => {
  const mt = makeMockTransport(okResponse);
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
    const mt = constantJson({ maxErgebnisse: 0, ergebnisliste: [] });
    assert.throws(
      () => new JobsucheClient({ baseUrl, transport: mt.transport, apiKey: "test-key" }),
      JobsucheValidationError,
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
    new URL(req.url).pathname.endsWith("/pc/v6/jobs") ? jsonResponse(V6_SEARCH) : okResponse(req),
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

// 2026-10-05 sweep, 03 Bug 2: a proxy or captive portal answering 200 with other JSON
// was printed as data (exit 0), and `.ergebnisliste // [] | length` read it as 0 hits.
test("a 2xx body that is not a search result or a listing is a parse error", async () => {
  const notSearch: unknown[] = [
    null, {}, [], "text", 42,
    { error: "rate limited" }, { message: "quota exceeded" },
    { maxErgebnisse: "1" }, { maxErgebnisse: -1 },
    { maxErgebnisse: 1, ergebnisliste: null }, { maxErgebnisse: 1, ergebnisliste: [null] },
    { maxErgebnisse: 1, ergebnisliste: [{ titel: "no refnr" }] },
    { maxErgebnisse: 0, woOutput: "Berlin" },
  ];
  for (const body of notSearch) {
    const c = new JobsucheClient({ transport: constantJson(body).transport, maxRetries: 0 });
    await assert.rejects(c.search({ was: "x" }), JobsucheParseError, JSON.stringify(body));
  }
  for (const body of [null, {}, [], { messages: [{ detail: "kaputt" }] }]) {
    const c = new JobsucheClient({ transport: constantJson(body).transport, maxRetries: 0 });
    await assert.rejects(c.details("10001-1-S"), JobsucheParseError, JSON.stringify(body));
  }
  // The server's own words are quoted.
  const said = new JobsucheClient({ transport: constantJson({ message: "quota exceeded" }).transport });
  await assert.rejects(said.search(), /not a search result \(no maxErgebnisse count; the server said: quota exceeded\)/);
  // The error names the request (D9): method and URL, with the query that was sent.
  await assert.rejects(said.search({ was: "Koch" }), (err: Error) =>
    err.message.startsWith("GET https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs?was=Koch: unexpected response shape: not a search result"));
  const listing = new JobsucheClient({ transport: constantJson({}).transport });
  await assert.rejects(listing.details("10001-1-S"), (err: Error) =>
    err.message === "GET https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/MTAwMDEtMS1T: unexpected response shape: not a job listing (no referenznummer).");
});

// 2026-10-05 sweep, 04 question 1: an unknown parameter (a typo such as `wos`) went to
// the API, which ignores it and returns the unfiltered set. It is rejected now, with an
// opt-out for filters the client does not model.
test("search() sends an unknown parameter only with allowUnknownParams", async () => {
  const mt = makeMockTransport(okResponse);
  const c = new JobsucheClient({ transport: mt.transport });
  await assert.rejects(c.search({ befristung: "1" } as never), JobsucheValidationError);
  assert.equal(mt.calls.length, 0);
  await c.search({ was: "Dev", befristung: "1" } as never, { allowUnknownParams: true });
  assert.equal(new URL(mt.last().url).searchParams.get("befristung"), "1");
  for (const bad of [JSON.parse('{"__proto__": 1}'), { constructor: "x" }, { befristung: ["1", "2"] }]) {
    await assert.rejects(c.search(bad as never, { allowUnknownParams: true }), JobsucheValidationError, JSON.stringify(bad));
  }
});

// 2026-10-05 sweep, 02 Bug 1: the encoded form of a refnr with "_" or ":" (15 % of live
// listings) was encoded a second time, and the API answered 404 for a listing that exists.
test("details passes the encoded form of a refnr with _ or : through unchanged", async () => {
  for (const refnr of ["13635-dc8d6fe5_JB5255995-S", "14795-70453_124092-S", "17296-0008159:01-S", "14225-ec7257e47df354d8-S"]) {
    const encoded = Buffer.from(refnr).toString("base64");
    for (const input of [refnr, encoded]) {
      const mt = makeMockTransport(okResponse);
      await clientWith(mt).details(input);
      assert.equal(new URL(mt.last().url).pathname, `${SERVICE}/pc/v4/jobdetails/${encodeURIComponent(encoded)}`, input);
    }
  }
  // Raw numeric refnrs of every length still get encoded (they never decode to a refnr).
  for (const refnr of ["12345678", "1002716922", "100271692212"]) {
    const mt = makeMockTransport(okResponse);
    await clientWith(mt).details(refnr);
    assert.equal(new URL(mt.last().url).pathname, `${SERVICE}/pc/v4/jobdetails/${encodeURIComponent(Buffer.from(refnr).toString("base64"))}`, refnr);
  }
});

// 2026-10-05 sweep, 02 Bug 3: a misspelt --wo silently searched another town
// (Hambrugxx Nord → Tackesdorf-Nord) or nothing (suchmodus UNGUELTIG), exit 0.
test("woNote names an unrecognised or substituted place, not a correction in kind", async () => {
  const at = (bereinigterOrt?: string, suchmodus = "UMKREISSUCHE") => ({ maxErgebnisse: 1, woOutput: { ...(bereinigterOrt ? { bereinigterOrt } : {}), suchmodus } });
  assert.match(woNote("Qqqqzzzz", at(undefined, "UNGUELTIG")) ?? "", /did not recognise the place "Qqqqzzzz"/);
  assert.match(woNote("Hambrugxx Nord", at("Tackesdorf-Nord")) ?? "", /searched around "Tackesdorf-Nord" for --wo "Hambrugxx Nord"/);
  assert.match(woNote("Berln", at("Berlin")) ?? "", /searched around "Berlin"/);
  for (const [wo, resolved] of [["Berlin", "Berlin"], ["berlin", "Berlin"], ["10115", "10115"], ["Frankfurt", "Frankfurt am Main"], ["München", "München"], ["Hamburg-Altona", "Hamburg"]] as const) {
    assert.equal(woNote(wo, at(resolved)), undefined, `${wo} → ${resolved}`);
  }
  assert.equal(woNote(undefined, at(undefined, "UNGUELTIG")), undefined);
  assert.equal(woNote("Berlin", { maxErgebnisse: 0 }), undefined);
});

test("the text filters go out trimmed and in composed Unicode; a blank one is refused (K6)", async () => {
  const decomposed = "München"; // u + U+0308, as pasted from a macOS file name
  const mt = makeMockTransport(okResponse);
  const client = new JobsucheClient({ transport: mt.transport });
  await client.search({ was: "  Bäcker\n", wo: ` ${decomposed}\t`, berufsfeld: " Informatik ", arbeitgeber: " Siemens AG　" });
  const sent = new URL(mt.last().url).searchParams;
  assert.equal(sent.get("was"), "Bäcker");
  assert.equal(sent.get("wo"), "München");
  assert.equal(sent.get("berufsfeld"), "Informatik");
  assert.equal(sent.get("arbeitgeber"), "Siemens AG");
  // Inner whitespace is kept.
  await client.search({ was: " Fach  informatiker " });
  assert.equal(new URL(mt.last().url).searchParams.get("was"), "Fach  informatiker");
  const count = mt.calls.length;
  for (const name of ["was", "wo", "berufsfeld", "arbeitgeber"] as const) {
    for (const blank of ["", " ", " ", "\n\t", "　"]) {
      await assert.rejects(client.search({ [name]: blank }), JobsucheValidationError, `${name} ${JSON.stringify(blank)}`);
    }
  }
  assert.equal(mt.calls.length, count);
});

test("a parameter sent with allowUnknownParams is checked too: its name a token, a string value text (D8)", async () => {
  const mt = makeMockTransport(okResponse);
  const c = new JobsucheClient({ transport: mt.transport });
  await c.search({ befristung: " 1\n" } as never, { allowUnknownParams: true });
  assert.equal(new URL(mt.last().url).searchParams.get("befristung"), "1");
  await assert.rejects(c.search({ "be​fristung": "1" } as never, { allowUnknownParams: true }), /Invalid search parameter: "be\\u200bfristung" contains an invisible/);
  await assert.rejects(c.search({ befristung: "​" } as never, { allowUnknownParams: true }), /Invalid befristung: Must not be blank\./);
  await assert.rejects(c.search({ befristung: "a­b" } as never, { allowUnknownParams: true }), /Invalid befristung: "a\\u00adb" contains an invisible character \(U\+00AD\)\./);
  assert.equal(mt.calls.length, 1);
  // A value of only invisible characters or combining marks is blank.
  for (const blank of ["", " ", "​", "­", "́̈", "\u0085"]) assert.equal(isBlank(blank), true, JSON.stringify(blank));
  assert.equal(isBlank("a​"), false);
});

test("an error body keeps its spelling unless a credential hides behind an escape (security audit class D)", async () => {
  const base = "https://alice:s3cret-pw@mirror.example";
  const bodyOf = async (body: string): Promise<string> => {
    const e = new RequestEngine({ baseUrl: base, transport: async () => rawResponse(body, "application/json", 500), maxRetries: 0 });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof JobsucheApiError, String(err));
    return err.body;
  };
  // No credential, or one spelled as sent: the body as sent (scrubbed), escapes kept.
  assert.equal(await bodyOf('{"m":"caf\\u00e9 \\"x\\""}'), '{"m":"caf\\u00e9 \\"x\\""}');
  assert.equal(await bodyOf('{"m":"pw s3cret-pw \\u00e9"}'), '{"m":"pw *** \\u00e9"}');
  // Escaped: written again decoded, scrubbed in that spelling.
  assert.equal(await bodyOf('{"m":"pw s3cret\\u002dpw \\u00e9"}'), '{"m":"pw *** é"}');
  // Not JSON: nobody decodes it, it stays as sent.
  assert.equal(await bodyOf("pw s3cret\\u002dpw"), "pw s3cret\\u002dpw");
});

test("a value quoted from an answer is scrubbed before it is cut, so no part of a credential stays (security audit class D)", async () => {
  const pw = "s3cret-Pw-long";
  const key = "Zq9x-k3y-Wv77-test";
  const e = new RequestEngine({ baseUrl: `https://alice:${pw}@mirror.example`, defaultHeaders: { "X-API-Key": key } });
  for (const at of [0, 190, 195, 199]) {
    for (const secret of [pw, key]) {
      const quoted = e.quoteServerValue(`${"x".repeat(at)}${secret}${"y".repeat(600)}`);
      assert.ok(!quoted.includes(secret.slice(0, 6)), `${at}: ${quoted}`);
    }
  }
  assert.equal(new RequestEngine().quoteServerValue('a"b'), '"a\\"b"');
  // A 2xx error envelope the shape check quotes ("the server said: …", cut at 200) and the place
  // a search names (woNote, cut at 200): scrubbed before the cut, so no prefix of the key or the
  // password stays, also where the cut fell inside one.
  for (const at of [0, 190, 195]) {
    for (const secret of [pw, key]) {
      const said = `${"x".repeat(at)}${secret}`;
      for (const [answer, call] of [
        [{ message: said }, (c: JobsucheClient) => c.search({ was: "x" })],
        [{ messages: [{ detail: said }] }, (c: JobsucheClient) => c.details("10001-1002716922-S")],
      ] as const) {
        const c = new JobsucheClient({ apiKey: key, baseUrl: `https://alice:${pw}@mirror.example`, transport: async () => jsonResponse(answer) });
        const err = await call(c).catch((caught: unknown) => caught);
        assert.ok(err instanceof JobsucheParseError && /the server said/.test(err.message), String(err));
        assert.ok(!err.message.includes(secret.slice(0, 6)), err.message);
      }
      const c = new JobsucheClient({ apiKey: key, baseUrl: `https://alice:${pw}@mirror.example` });
      const note = c.woNote("Berlin", { maxErgebnisse: 0, woOutput: { bereinigterOrt: said } } as never) ?? "";
      assert.match(note, /searched around/);
      assert.ok(!note.includes(secret.slice(0, 6)), note);
    }
  }
});

test("an echo of the request URL as sent is scrubbed, a short password too (security audit class D)", async () => {
  // Typed raw; WHATWG spells it `p%22%C3%A4` in the URL, which a server echoes.
  const e = new RequestEngine({
    baseUrl: 'https://alice:p"ä@mirror.example',
    transport: async () => rawResponse(JSON.stringify({ message: "no access: https://alice:p%22%C3%A4@mirror.example/x" }), "application/json", 403),
  });
  const err = await e.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof JobsucheApiError, String(err));
  for (const text of [err.message, err.detail ?? "", err.body]) {
    assert.ok(!text.includes("p%22%C3%A4@") && !text.includes('p"ä@'), text);
  }
});

test("the API key and the base URL's Basic value echoed with JSON escapes are scrubbed from the message, the detail and the decoded body (security audit class D)", async () => {
  const key = "Zq9x-k3y-Wv77-test";
  const pw = "pä\"s's-W0rd";
  const escaped = (text: string): string => `"${[...text].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`;
  const basics = [Buffer.from(`alice:${pw}`, "latin1").toString("base64"), Buffer.from(`alice:${pw}`, "utf8").toString("base64")];
  for (const echo of [escaped(key), escaped(`bad key ${key}`), ...basics.map((b) => escaped(`Basic ${b}`)), JSON.stringify(`Basic ${basics[1]}`)]) {
    for (const body of [`{"message":${echo}}`, `{"detail":${echo}}`, `{"messages":[{"code":"X","detail":${echo}}]}`]) {
      const c = new JobsucheClient({
        apiKey: key,
        baseUrl: `https://alice:${encodeURIComponent(pw)}@mirror.example`,
        transport: async () => rawResponse(body, "application/json", 401),
      });
      const err = await c.search({ was: "x" }).catch((caught: unknown) => caught);
      assert.ok(err instanceof JobsucheApiError && err.status === 401, String(err));
      const decoded = JSON.stringify(JSON.parse(err.body));
      for (const text of [err.message, err.detail ?? "", err.body, decoded]) {
        for (const secret of [key, ...basics]) assert.ok(!text.includes(secret), `${body}: ${text}`);
      }
    }
  }
  // An X-API-Key with an inner space is scrubbed whole, not from its second word on.
  const spaced = "Zq9xWv first-part";
  const c = new JobsucheClient({ apiKey: spaced, transport: async () => jsonResponse({ message: `bad key ${spaced}` }, 401) });
  const err = await c.search({ was: "x" }).catch((caught: unknown) => caught);
  assert.ok(err instanceof JobsucheApiError, String(err));
  assert.ok(!err.message.includes("Zq9xWv"), err.message);
  // And the password percent-encoded, as a server puts it into a URL it quotes.
  const encoded = encodeURIComponent(pw);
  const d = new JobsucheClient({
    baseUrl: `https://alice:${encoded}@mirror.example`,
    transport: async () => rawResponse(JSON.stringify({ message: `log in again: /login?pw=${encoded}` }), "application/json", 401),
  });
  const err2 = await d.search({ was: "x" }).catch((caught: unknown) => caught);
  assert.ok(err2 instanceof JobsucheApiError, String(err2));
  for (const text of [err2.message, err2.detail ?? "", err2.body]) assert.ok(!text.includes(encoded), text);
});

test("a number literal, a Content-Type and a body snippet a message quotes are scrubbed (security audit class D)", async () => {
  const pw = "12345678";
  const c = (body: string, type: string): JobsucheClient =>
    new JobsucheClient({ baseUrl: `https://alice:${pw}@mirror.example`, transport: async () => rawResponse(body, type) });
  const inexact = await c(`{"maxErgebnisse":9007199254740993${pw}}`, "application/json").search({ was: "x" }).catch((caught: unknown) => caught);
  assert.ok(inexact instanceof JobsucheParseError && /cannot be represented exactly/.test(inexact.message), String(inexact));
  assert.ok(!inexact.message.includes(pw), inexact.message);
  const html = await c("<html>", `text/x-${pw}; charset=utf-8`).search({ was: "x" }).catch((caught: unknown) => caught);
  assert.ok(html instanceof JobsucheParseError && /expected a JSON answer/.test(html.message), String(html));
  assert.ok(!html.message.includes(pw), html.message);
  const charset = await c("{}", `application/json; charset=x-${pw}`).search({ was: "x" }).catch((caught: unknown) => caught);
  assert.ok(charset instanceof JobsucheParseError && /unsupported response charset/.test(charset.message), String(charset));
  assert.ok(!charset.message.includes(pw), charset.message);
  // The snippet of a non-JSON body is scrubbed before its cut at 200: no prefix of the password.
  const long = "s3cret-Pw-long";
  for (const at of [190, 195]) {
    const e = new JobsucheClient({ baseUrl: `https://alice:${long}@mirror.example`, transport: async () => rawResponse(`${"x".repeat(at)}${long}`, "text/html") });
    const err = await e.search({ was: "x" }).catch((caught: unknown) => caught);
    assert.ok(err instanceof JobsucheParseError, String(err));
    const cause = err.cause instanceof Error ? err.cause.message : "";
    assert.ok(!cause.includes("s3cret"), cause);
  }
});

test("a credential or the API key echoed in a redirect's Location never names the request in a message (security audit class D2)", async () => {
  // A password with characters a URL's query percent-encodes in a spelling of its own (`'` as %27).
  const pw = "pä\"s's-W0rd";
  const key = "Zq9x-k3y-Wv77-test";
  const basic = Buffer.from(`alice:${pw}`, "utf8").toString("base64");
  const secrets = [pw, `alice:${pw}`, basic, key];
  const percentDecoded = (text: string): string =>
    text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  const base = `https://alice:${encodeURIComponent(pw)}@mirror.example`;
  const locations = [
    `https://elsewhere.example/login?user=alice&pw=${encodeURIComponent(pw)}`,
    `https://elsewhere.example/login?pw=${pw}`,
    `https://elsewhere.example/${encodeURIComponent(`alice:${pw}`)}/x`,
    `https://elsewhere.example/auth?basic=${basic}`,
    `/relative/${pw}`,
    `https://elsewhere.example/k?apikey=${key}`,
  ];
  for (const location of locations) {
    // Every request answered with a 302 there: the redirect limit, naming the last request and target.
    const retried: string[] = [];
    const looping = new JobsucheClient({
      apiKey: key,
      baseUrl: base,
      maxRetries: 0,
      transport: async () => ({ status: 302, headers: { location }, body: Buffer.alloc(0) }),
    });
    const loop = await looping.search({ was: "x" }).catch((caught: unknown) => caught);
    assert.ok(loop instanceof JobsucheApiError && /^HTTP 302 .*\(stopped after 5 redirects\)$/.test(loop.message), String(loop));
    // One redirect, then a 401, a reset, an invalid answer and a 503 retried once: the request
    // named (and the one onRetry is told about) is the followed one.
    for (const after of ["401", "reset", "invalid", "503"] as const) {
      let calls = 0;
      const once = new JobsucheClient({
        apiKey: key,
        baseUrl: base,
        maxRetries: after === "503" ? 1 : 0,
        retryDelayMs: 0,
        sleep: async () => {},
        onRetry: (event) => retried.push(event.url),
        transport: async (req) => {
          calls += 1;
          if (calls === 1) return { status: 302, headers: { location }, body: Buffer.alloc(0) };
          // A transport's text names the URL it was given.
          if (after === "reset") throw Object.assign(new Error(`socket hang up (${req.url})`), { code: "ECONNRESET" });
          if (after === "invalid") return { status: 99, headers: {}, body: Buffer.alloc(0) };
          return rawResponse("{}", "application/json", after === "503" ? 503 : 401);
        },
      });
      const err = await once.search({ was: "x" }).catch((caught: unknown) => caught);
      assert.ok(err instanceof JobsucheApiError || err instanceof JobsucheNetworkError, String(err));
      const e = err as JobsucheApiError;
      const seen = percentDecoded([e.message, e.url ?? "", e.location ?? "", JSON.stringify(e.credentialsDropped ?? {})].join("\n"));
      for (const secret of secrets) assert.ok(!seen.includes(secret), `${location} ${after}: ${seen}`);
    }
    const seen = percentDecoded([loop.message, loop.url, loop.location ?? "", ...retried].join("\n"));
    assert.ok(retried.length > 0);
    for (const secret of secrets) assert.ok(!seen.includes(secret), `${location}: ${seen}`);
  }
});
