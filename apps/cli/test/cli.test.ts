import { test } from "node:test";
import assert from "node:assert/strict";
import { redactionFor, run } from "../src/cli/run.js";
import { renderJson } from "../src/cli/shared.js";
import { JobsucheClient } from "@maschinenlesbar.org/jobsuche-client/internal/client";
import { JobsucheNetworkError, credentialsIn } from "@maschinenlesbar.org/jobsuche-client/internal/errors";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/jobsuche-client/internal/http";
import { makeMockTransport, jsonResponse, okResponse, rawResponse, untimed } from "./helpers.js";
import { V6_SEARCH } from "@maschinenlesbar.org/jobsuche-client/test/fixtures";

const SERVICE = "/jobboerse/jobsuche-service";

function makeCli(
  responder: (req: HttpRequest) => HttpResponse,
  env: Record<string, string | undefined> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    createClient: (opts) => new JobsucheClient({ ...opts, transport: mt.transport }),
    env,
  };
  return { deps, out, err, mt };
}

test("search builds the query and sends no key when none is configured", async () => {
  const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
  const code = await run(["search", "--was", "Informatiker", "--size", "5"], cli.deps);
  assert.equal(code, 0);
  const req = cli.mt.last();
  // No key is bundled: without --api-key/env the header is omitted.
  assert.equal(req.headers?.["X-API-Key"], undefined);
  const url = new URL(req.url);
  assert.equal(url.pathname, `${SERVICE}/pc/v6/jobs`);
  assert.equal(url.searchParams.get("was"), "Informatiker");
});

test("--api-key overrides the header", async () => {
  const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
  await run(["--api-key", "custom", "search", "--was", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "custom");
});

test("JOBSUCHE_API_KEY seeds the X-API-Key header", async () => {
  const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }), { JOBSUCHE_API_KEY: "env-key" });
  await run(["search", "--was", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "env-key");
});

test("--api-key overrides JOBSUCHE_API_KEY", async () => {
  const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }), { JOBSUCHE_API_KEY: "env-key" });
  await run(["--api-key", "flag-key", "search", "--was", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "flag-key");
});

test("an all-whitespace JOBSUCHE_API_KEY is ignored (no header sent)", async () => {
  const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }), { JOBSUCHE_API_KEY: "   " });
  await run(["search", "--was", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], undefined);
});

test("a 401 maps to exit code 3 with an actionable message", async () => {
  const cli = makeCli(() => jsonResponse({}, 401));
  const code = await run(["details", "a-b-c"], cli.deps);
  assert.equal(code, 3);
  assert.match(cli.err.join("\n"), /request rejected.*JOBSUCHE_API_KEY/s);
});

test("a 403 with a server detail surfaces that detail (not a blanket key message)", async () => {
  const cli = makeCli(() => jsonResponse({ detail: "quota exceeded" }, 403));
  const code = await run(["details", "a-b-c"], cli.deps);
  assert.equal(code, 3);
  assert.match(cli.err.join("\n"), /quota exceeded/);
});

test("a 403 maps to exit code 3", async () => {
  const cli = makeCli(() => jsonResponse({}, 403));
  const code = await run(["details", "a-b-c"], cli.deps);
  assert.equal(code, 3);
});

test("an empty-body 403 hint names a wrong key, a refused network and a passing refusal", async () => {
  // The gateway sends text/plain with a one-space body for a wrong key too.
  const cli = makeCli(() => rawResponse(" ", "text/plain", 403), { JOBSUCHE_API_KEY: "k" });
  const code = await run(["search", "--was", "x"], cli.deps);
  assert.equal(code, 3);
  const err = cli.err.join("\n");
  assert.match(err, /JOBSUCHE_API_KEY/);
  assert.match(err, /wrong key, a refused network and a passing refusal/);
  assert.match(err, /jobsuche obtain-key/);
});

test("an empty-body 403 without a key says no key was sent", async () => {
  const cli = makeCli(() => rawResponse(" ", "text/plain", 403));
  const code = await run(["search", "--was", "x"], cli.deps);
  assert.equal(code, 3);
  const err = cli.err.join("\n");
  assert.match(err, /no X-API-Key was sent/);
  assert.doesNotMatch(err, /refused network/);
});

test("search prints the v6 response unchanged", async () => {
  const cli = makeCli(() => jsonResponse(V6_SEARCH));
  const code = await run(["--compact", "search", "--was", "Informatiker", "--wo", "Berlin"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, `${SERVICE}/pc/v6/jobs`);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), V6_SEARCH);
});

test("a 403 with a server detail gets no network hint", async () => {
  const cli = makeCli(() => jsonResponse({ detail: "quota exceeded" }, 403));
  await run(["details", "a-b-c"], cli.deps);
  assert.doesNotMatch(cli.err.join("\n"), /refused network/);
});

test("details encodes a hyphenless numeric refnr", async () => {
  const cli = makeCli(okResponse);
  await run(["details", "1002716922"], cli.deps);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    `${SERVICE}/pc/v4/jobdetails/MTAwMjcxNjkyMg%3D%3D`,
  );
});

test("search forwards --angebotsart", async () => {
  const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
  await run(["search", "--was", "x", "--angebotsart", "1"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("angebotsart"), "1");
});

test("details encodes the refnr", async () => {
  const cli = makeCli(okResponse);
  await run(["details", "10001-1002716922-S"], cli.deps);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    `${SERVICE}/pc/v4/jobdetails/MTAwMDEtMTAwMjcxNjkyMi1T`,
  );
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = { referenznummer: "10001-1002716922-S", titel: `Informatiker${controls}`, arbeitgeber: String.fromCharCode(0x1b) + "[31m" };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "details", "10001-1002716922-S"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) =>
      c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f,
    );
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Informatiker\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["details", "a-b-c"], cli.deps);
  assert.equal(code, 4);
});

test("an already-encoded lowercase-hex refnr is passed through unchanged (B1)", async () => {
  const cli = makeCli(okResponse);
  // base64 of the live refnr "14225-dafcdd47aabe512d-S"
  const encoded = "MTQyMjUtZGFmY2RkNDdhYWJlNTEyZC1T";
  await run(["details", encoded], cli.deps);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    `${SERVICE}/pc/v4/jobdetails/${encoded}`,
  );
});

// A blank search term, place, field or employer (often an unset shell variable)
// was silently dropped, so the search ran unfiltered and exited 0. Each is now a
// usage error before any request.
for (const [flag, value] of [
  ["--was", ""],
  ["--was", "   "],
  ["--wo", ""],
  ["--berufsfeld", ""],
  ["--arbeitgeber", ""],
] as const) {
  test(`a blank ${flag} (${JSON.stringify(value)}) is a usage error, not an unfiltered search`, async () => {
    const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
    const code = await run(["--api-key", "dummy", "search", flag, value, "--wo", "Berlin"], cli.deps);
    assert.notEqual(code, 0);
    assert.equal(code, 2);
    assert.deepEqual(cli.out, []);
    assert.match(cli.err.join("\n"), /Must not be blank/);
    assert.equal(cli.mt.calls.length, 0);
  });
}

test("a blank --api-key sends no header (no bundled default) (B7)", async () => {
  const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
  await run(["--api-key", "", "search", "--was", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], undefined);
});

test("a bad integer flag is a usage error (exit 2), distinct from runtime errors (B10)", async () => {
  const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
  const code = await run(["search", "--size", "0x10"], cli.deps);
  assert.equal(code, 2);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
  assert.equal(await run(["--timeout", "2147483647", "search", "--was", "x"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
  assert.equal(await run(["--timeout", "2147483648", "search", "--was", "x"], over.deps), 2);
  assert.equal(over.mt.calls.length, 0); // rejected before any request
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
});

test("a non-JSON 200 response surfaces the Content-Type (B16)", async () => {
  const cli = makeCli(() => ({
    status: 200,
    headers: { "content-type": "text/html" },
    body: Buffer.from("<html>nope</html>"),
  }));
  const code = await run(["search", "--was", "x"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /text\/html/);
});

test("a starved free-text option is a usage error, not a silent search", async () => {
  // `--was --wo Berlin` makes commander hand "--wo" to --was as its value; the
  // location filter is then never applied. Fail loudly instead of quietly
  // searching for something the user never asked for.
  const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
  const code = await run(["search", "--was", "--wo", "Berlin"], cli.deps);
  assert.equal(code, 2);
  assert.deepEqual(cli.out, []);
  assert.match(cli.err.join("\n"), /is the next option, consumed because/);
  // No request should have been made at all.
  assert.equal(cli.mt.calls.length, 0);
});

// 2026-10-21 sweep, 01 Bug 1: the dash guard tested the raw value, and the library trims
// afterwards, so `--was " -Koch"` sent was=-Koch: the very value the rule refuses.
test("the dash guard judges the value as it is sent: a padded dash-leading value is refused too", async () => {
  for (const value of ["-Koch", " -Koch", "\t-Koch", "\n--wo", " --base-url=http://evil.example", "\u00a0-x"]) {
    const cli = makeCli(okResponse);
    assert.equal(await run(["search", "--was", value], cli.deps), 2, JSON.stringify(value));
    assert.equal(cli.mt.calls.length, 0, JSON.stringify(value));
    assert.match(untimed(cli.err.join("\n")), /^ERROR \[jobsuche\.cli\] .*looks like a missing value/, JSON.stringify(value));
  }
  // A dash inside the value, or a lone one, is a search text like any other.
  for (const value of ["Koch -Lehrling", "Mit-Arbeiter", "-"]) {
    const cli = makeCli(okResponse);
    assert.equal(await run(["search", "--was", value], cli.deps), 0, JSON.stringify(value));
    assert.equal(new URL(cli.mt.last().url).searchParams.get("was"), value);
  }
});

// zeitarbeit=true returns only temp-work listings and the default already
// includes them (live: 2231 + 6033 = 8264), so --zeitarbeit narrows and
// --no-zeitarbeit is the way to leave them out.
for (const [args, expected] of [
  [[], null],
  [["--zeitarbeit"], "true"],
  [["--no-zeitarbeit"], "false"],
] as const) {
  test(`search ${args.join(" ") || "(no zeitarbeit flag)"} sends zeitarbeit=${expected}`, async () => {
    const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
    assert.equal(await run(["search", "--was", "x", ...args], cli.deps), 0);
    assert.equal(new URL(cli.mt.last().url).searchParams.get("zeitarbeit"), expected);
  });
}

// The API ignores veroeffentlichtseit above 100 and returns the unfiltered set.
test("--veroeffentlicht-seit accepts 0..100 and rejects 101 before any request", async () => {
  for (const days of ["0", "100"]) {
    const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
    assert.equal(await run(["search", "--veroeffentlicht-seit", days], cli.deps), 0);
    assert.equal(new URL(cli.mt.last().url).searchParams.get("veroeffentlichtseit"), days);
  }
  const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
  assert.equal(await run(["search", "--veroeffentlicht-seit", "101"], cli.deps), 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Must be <= 100/);
});

// Since Node 20 the JSON.parse error quotes the offending body; it reached
// stderr raw, so a server could send an OSC title-set sequence to the terminal.
test("a JSON parse error does not pass the body's control characters to stderr", async () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const cli = makeCli(() => rawResponse(`${ESC}]0;TITLE${BEL}${ESC}[31m not json`, "application/json"));
  assert.equal(await run(["search", "--was", "x"], cli.deps), 1);
  const err = cli.err.join("\n");
  assert.match(err, /GET https:\/\/rest\.arbeitsagentur\.de\/jobboerse\/jobsuche-service\/pc\/v6\/jobs\?was=x: the answer is not valid JSON/);
  assert.match(err, /TITLE/);
  assert.equal([...err].filter((c) => c.charCodeAt(0) < 0x20 && c !== "\n").length, 0);
});

// --page 0 reached the API (HTTP 400) and an undocumented --angebotsart code
// silently returned nothing; both are usage errors now.
for (const [flag, value, message] of [
  ["--page", "0", /Must be >= 1/],
  ["--angebotsart", "3", /Unknown --angebotsart code 3: valid codes are 1, 2, 4, 34/],
  ["--angebotsart", "0", /Unknown --angebotsart code 0/],
] as const) {
  test(`${flag} ${value} is a usage error before any request`, async () => {
    const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
    assert.equal(await run(["search", flag, value], cli.deps), 2);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  });
}

test("every documented --angebotsart code and --page 1 are accepted", async () => {
  for (const code of ["1", "2", "4", "34"]) {
    const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
    assert.equal(await run(["search", "--angebotsart", code, "--page", "1"], cli.deps), 0);
    assert.equal(new URL(cli.mt.last().url).searchParams.get("angebotsart"), code);
  }
});

// A blank reference exited 1 from the client's check; it is a usage error.
for (const ref of ["", "   "]) {
  test(`details ${JSON.stringify(ref)} is a usage error (exit 2) before any request`, async () => {
    const cli = makeCli(okResponse);
    assert.equal(await run(["details", ref], cli.deps), 2);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /Must not be blank/);
  });
}

// `jobsuche help` printed help, then "missing command", and exited 2.
for (const [argv, code] of [
  [["help"], 0],
  [["help", "search"], 0],
  [["search", "--help"], 0],
  [["--version"], 0],
  [[], 2],
  [["help", "nope"], 2],
] as const) {
  test(`jobsuche ${argv.join(" ") || "(no arguments)"} exits ${code}`, async () => {
    const cli = makeCli(okResponse);
    assert.equal(await run([...argv], cli.deps), code);
    assert.equal(cli.mt.calls.length, 0);
    if (code === 0) assert.doesNotMatch(cli.err.join("\n"), /missing command/);
  });
}

// With "#frag" every filter ended up in the fragment and an unfiltered search ran.
for (const baseUrl of ["http://127.0.0.1:1/echo?x=1", "http://127.0.0.1:1/echo#frag", "http://127.0.0.1:1/?"]) {
  test(`--base-url ${baseUrl} is a usage error`, async () => {
    const cli = makeCli(okResponse);
    assert.equal(await run(["--base-url", baseUrl, "search", "--was", "x"], cli.deps), 2);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /cannot have a query \(\?\) or fragment \(#\)/);
  });
}

test("a base URL with a path prefix still works", async () => {
  const cli = makeCli(okResponse);
  assert.equal(await run(["--base-url", "https://mirror.example/ba/", "search", "--was", "x"], cli.deps), 0);
  assert.equal(new URL(cli.mt.last().url).pathname, `/ba${SERVICE}/pc/v6/jobs`);
});

// A password in --base-url was printed with every error (CI logs).
test("a password in --base-url is not echoed in an error, but still sent", async () => {
  const cli = makeCli(() => jsonResponse({ detail: "nope" }, 404));
  assert.equal(await run(["--base-url", "http://user:s3cret@127.0.0.1:1/e", "search", "--was", "x"], cli.deps), 4);
  const err = cli.err.join("\n");
  assert.doesNotMatch(err, /s3cret|user:/);
  assert.match(err, /http:\/\/127\.0\.0\.1:1\/e\/jobboerse/);
  // The engine sends the userinfo as Basic auth, per hop; the transport never sees it in the URL.
  assert.doesNotMatch(cli.mt.last().url, /s3cret/);
  assert.equal(cli.mt.last().headers?.["Authorization"], `Basic ${Buffer.from("user:s3cret").toString("base64")}`);
});

// CR/LF and non-Latin-1 in --api-key / --user-agent failed at request time as
// "Unexpected error: Invalid character in header content" (exit 1).
for (const [flag, value, message] of [
  ["--api-key", "a\nb", /control characters/],
  ["--api-key", "k\u0100", /outside Latin-1/],
  ["--user-agent", "ua\r\nX-Injected: 1", /control characters/],
  ["--user-agent", "ua\u2603", /outside Latin-1/],
  ["--user-agent", " ", /Must not be blank/],
] as const) {
  test(`${flag} ${JSON.stringify(value)} is a usage error before any request`, async () => {
    const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }));
    assert.equal(await run([flag, value, "search", "--was", "x"], cli.deps), 2);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  });
}

test("a tab and Latin-1 in --user-agent are sent; a blank --api-key still falls back to the env", async () => {
  const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }), { JOBSUCHE_API_KEY: "env-key" });
  assert.equal(await run(["--user-agent", "a\tü", "--api-key", " ", "search", "--was", "x"], cli.deps), 0);
  assert.equal(cli.mt.last().headers?.["User-Agent"], "a\tü");
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "env-key");
});

test("an unsendable JOBSUCHE_API_KEY is a usage error, as from --api-key", async () => {
  const cli = makeCli(() => jsonResponse({ maxErgebnisse: 0, ergebnisliste: [] }), { JOBSUCHE_API_KEY: "a\nb" });
  assert.equal(await run(["search", "--was", "x"], cli.deps), 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[jobsuche\.cli\] Invalid JOBSUCHE_API_KEY: Value contains control characters\./);
});

// A 100 000-deep body parsed fine but overflowed JSON.stringify:
// "Unexpected error: Maximum call stack size exceeded".
test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7)", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't. Whether
  // the compact printer can depends on the Node version (iterative from Node 26) and the stack:
  // probed here, never assumed.
  const depth = 200_000;
  // A valid search result whose facets nest without end.
  const body = `{"maxErgebnisse":0,"facetten":{"x":${"[".repeat(depth)}${"]".repeat(depth)}}}`;
  let compactPrints = true;
  try {
    JSON.stringify(JSON.parse(body));
  } catch {
    compactPrints = false;
  }
  const pretty = makeCli(() => rawResponse(body, "application/json"));
  assert.equal(await run(["search", "--was", "x"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.equal(
    untimed(pretty.err.join("\n")),
    `ERROR [jobsuche.output] The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
  );
  const compact = makeCli(() => rawResponse(body, "application/json"));
  assert.equal(await run(["--compact", "search", "--was", "x"], compact.deps), compactPrints ? 0 : 1);
  if (compactPrints) assert.equal(compact.out.join("").length, body.length);
  else assert.equal(untimed(compact.err.join("\n")), "ERROR [jobsuche.output] The answer is nested too deeply to print.");
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeCli(okResponse);
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
});

// U+202E and U+2028 were written raw, so a title could spoof the terminal display.
test("bidi controls and U+2028/U+2029 are escaped in the JSON output", async () => {
  const served = { referenznummer: "10001-1002716922-S", stellenangebotsTitel: "a\u202eRTL\u2028b\u2029c\u2066d", firma: "\u200fX" };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "details", "10001-1002716922-S"], cli.deps), 0);
    const text = cli.out.join("\n");
    assert.doesNotMatch(text, /[\u202e\u2028\u2029\u2066\u200f]/);
    assert.match(text, /a\\u202eRTL\\u2028b\\u2029c\\u2066d/);
    assert.deepEqual(JSON.parse(text), served);
  }
});

// 2026-10-05 sweep, 01 Bug 2/3: a key pasted where a command, an argument or an
// option value belongs was echoed by commander in full.
test("usage errors mask a pasted key but still echo a mistyped command", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["OrgKey-55", "search"], /unknown command 'Org…'/],
    [["details", "10001-1-S", "OrgKey-55"], /got 2: 100…, Org…\./],
    [["search", "--apikey=my-org-key-7Hq2"], /unknown option '--apikey=my-…'/],
    [["--api-key", "OrgKey-55\u000bz", "search"], /option '--api-key <key>' argument '\*\*\*' is invalid\. Value contains control characters\./],
    [["serach"], /unknown command 'serach'/],
  ];
  for (const [argv, expected] of cases) {
    const cli = makeCli(okResponse);
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    const err = cli.err.join("\n");
    assert.match(err, expected);
    assert.doesNotMatch(err, /OrgKey-55|my-org-key-7Hq2|\u000b/);
  }
});

test("--zeitarbeit with --no-zeitarbeit, or a repeated option, is a usage error", async () => {
  for (const argv of [
    ["search", "--zeitarbeit", "--no-zeitarbeit"],
    ["search", "--no-zeitarbeit", "--zeitarbeit"],
    ["--timeout", "1000", "search", "--timeout", "2000"],
    ["search", "--wo", "Berlin", "--wo", "Hamburg"],
  ]) {
    const cli = makeCli(okResponse);
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0);
  }
});

test("search warns on stderr when the API did not search the --wo asked for, exit 0", async () => {
  const cli = makeCli(() => jsonResponse({ maxErgebnisse: 307, page: 1, size: 1, woOutput: { bereinigterOrt: "Tackesdorf-Nord", suchmodus: "UMKREISSUCHE" } }));
  assert.equal(await run(["search", "--was", "Pflege", "--wo", "Hambrugxx Nord"], cli.deps), 0);
  assert.match(untimed(cli.err.join("\n")), /^WARN  \[jobsuche\.api\] the API searched around "Tackesdorf-Nord" for --wo "Hambrugxx Nord"/);
  assert.equal(JSON.parse(cli.out.join("\n")).maxErgebnisse, 307);
  const ok = makeCli(() => jsonResponse(V6_SEARCH));
  assert.equal(await run(["search", "--wo", "Berlin"], ok.deps), 0);
  assert.deepEqual(ok.err, []);
});

test("the log format is the one commander parsed: an option's value that looks like --log-format, a repeated flag", async () => {
  const boom = () => jsonResponse({ detail: "boom" }, 500);
  // commander takes "--log-format=jsonl" as the User-Agent: the log stays text.
  const ua = makeCli(boom);
  assert.equal(await run(["--user-agent", "--log-format=jsonl", "search"], ua.deps), 1);
  assert.match(ua.err[0] ?? "", /^\S+ ERROR \[jobsuche\.api\] /);
  // commander takes "--" as the User-Agent and then parses --log-format jsonl.
  const dashes = makeCli(boom);
  assert.equal(await run(["--user-agent", "--", "--log-format", "jsonl", "search"], dashes.deps), 1);
  assert.equal((JSON.parse(dashes.err[0] ?? "") as Record<string, unknown>)["topic"], "jobsuche.api");
  // A parse error: --user-agent takes "--log-format" as its value; "jsonl" is then an unknown command, logged in text.
  const parse = makeCli(okResponse);
  assert.equal(await run(["--user-agent", "--log-format", "jsonl", "search"], parse.deps), 2);
  assert.match(parse.err[0] ?? "", /^\S+ ERROR \[jobsuche\.cli\] unknown command 'jsonl'/);
  // A repeated --log-format is refused; the refusal is in the first one's format.
  const twice = makeCli(okResponse);
  assert.equal(await run(["--log-format", "jsonl", "--log-format", "text", "search"], twice.deps), 2);
  const record = JSON.parse(twice.err[0] ?? "") as Record<string, unknown>;
  assert.equal(record["topic"], "jobsuche.cli");
  assert.match(record["msg"] as string, /--log-format is given more than once/);
});

test("a transport message that ends in a newline (OpenSSL's EPROTO) stays one record (#15)", async () => {
  for (const format of ["text", "jsonl"]) {
    const err: string[] = [];
    const deps: CliDeps = {
      io: { out: () => {}, err: (s) => err.push(s) },
      createClient: (opts) =>
        new JobsucheClient({
          ...opts,
          transport: async () => {
            // As the default transport rejects: Node's message, passed on as it is.
            throw new JobsucheNetworkError("write EPROTO 807F:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number:tlsany_meth.c:78:\n");
          },
        }),
      env: {},
    };
    assert.equal(await run(["--log-format", format, "--max-retries", "0", "search"], deps), 1);
    assert.ok(err.length > 0 && err.every((line) => !line.includes("\n") && !line.includes("\r")), err.join("\n"));
    const http = err.find((line) => line.includes("jobsuche.http")) ?? "";
    assert.match(http, /could not reach the API \(.*tlsany_meth\.c:78:\\n.*\)\./, `${format}: ${http}`);
  }
});

test("a key equal to a part of the record's frame is replaced in the message only (02-3)", async () => {
  const notFound = () => jsonResponse({ detail: "not here" }, 404);
  for (const [env, argv] of [
    [{ JOBSUCHE_API_KEY: "jobsuche" }, ["--log-format", "jsonl", "details", "10001-1"]],
    [{}, ["--api-key", "2026", "details", "10001-1"]],
    [{}, ["--api-key", "ERROR", "details", "10001-1"]],
  ] as const) {
    const cli = makeCli(notFound, { ...env });
    const fixed = { ...cli.deps, now: () => new Date("2026-10-09T04:01:39.375Z") };
    assert.equal(await run([...argv], fixed), 4);
    for (const line of cli.err) {
      if (argv[0] === "--log-format") {
        const record = JSON.parse(line) as Record<string, unknown>;
        assert.equal(record["topic"], "jobsuche.api", line);
        assert.equal(record["ts"], "2026-10-09T04:01:39.375Z", line);
      } else {
        assert.match(line, /^2026-10-09T04:01:39\.375Z ERROR \[jobsuche\.api\] /, line);
      }
    }
  }
});

test("an a:b@c argument (here a User-Agent) is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  const listing = { ...V6_SEARCH, ergebnisliste: [{ referenznummer: "10001-1", titel: "run:2026-10-09@x" }] };
  const cli = makeCli(() => jsonResponse(listing));
  assert.equal(await run(["--user-agent", "run:2026-10-09@x", "search"], cli.deps), 0);
  assert.match(cli.out.join("\n"), /"titel": "run:2026-10-09@x"/);
  assert.deepEqual(credentialsIn("run:2026-10-09@x"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
  // A search text of that shape is data too.
  const text = makeCli(() => jsonResponse(listing));
  assert.equal(await run(["search", "--was", "dev:ops@berlin"], text.deps), 0);
  assert.equal(new URL(text.mt.last().url).searchParams.get("was"), "dev:ops@berlin");
  assert.match(text.out.join("\n"), /"titel": "run:2026-10-09@x"/);
});

test("every failed run starts with an ERROR, and commander's help is one INFO record per line (#2)", async () => {
  for (const [argv, first] of [
    [[], /^ERROR \[jobsuche\.cli\] missing command: `jobsuche <subcommand>`$/],
    [["config"], /^ERROR \[jobsuche\.cli\] missing command: `jobsuche config <subcommand>`$/],
    [["help", "nope"], /^ERROR \[jobsuche\.cli\] /],
    [["serach"], /^ERROR \[jobsuche\.cli\] unknown command 'serach' \(Did you mean search\?\)$/],
  ] as const) {
    const cli = makeCli(okResponse);
    assert.equal(await run([...argv], cli.deps), 2, argv.join(" "));
    const lines = cli.err.map(untimed);
    assert.match(lines[0] ?? "", first, lines.join("\n"));
    assert.ok(lines.every((line) => !line.includes("\n") && !line.includes("\\n")), lines.join("\n"));
    assert.equal(lines.filter((line) => line.startsWith("ERROR")).length, 1, lines.join("\n"));
  }
});

test("a subcommand's value option does not swallow the program's --log-format, in a parse error too (L6)", async () => {
  // commander takes the program's --log-format out of argv first;  is left without its value.
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["search", "--was", "--log-format", "jsonl"], cli.deps);
  assert.notEqual(code, 0);
  assert.ok(cli.err.length > 0 && cli.err.every((line) => line.startsWith("{")), cli.err.join("\n"));
  assert.match((JSON.parse(cli.err[0] ?? "") as Record<string, unknown>)["msg"] as string, / <[a-z]+>' argument missing/);
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise (K4)", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli(okResponse);
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, [{ id: 1, text: huge }]);
  renderJson(deps, { compact: true }, [{ id: 1, x: [[["Stelle"]]], text: huge.slice(1) }]);
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: 1 });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("the text filters go out trimmed and composed, as the library sends them (K6)", async () => {
  const cli = makeCli(okResponse);
  const args = ["search", "--was", " Bäcker\n", "--wo", "München ", "--berufsfeld", " Informatik", "--arbeitgeber", "Siemens AG\t"];
  assert.equal(await run(args, cli.deps), 0, cli.err.join("\n"));
  const sent = new URL(cli.mt.last().url).searchParams;
  assert.equal(sent.get("was"), "Bäcker");
  assert.equal(sent.get("wo"), "München");
  assert.equal(sent.get("berufsfeld"), "Informatik");
  assert.equal(sent.get("arbeitgeber"), "Siemens AG");
  const blank = makeCli(okResponse);
  assert.equal(await run(["search", "--wo", "　"], blank.deps), 2);
  assert.equal(blank.mt.calls.length, 0);
});

test("terminal controls are escaped in chunks: the same text as one pass, across chunk edges (D7)", () => {
  const DEL = String.fromCharCode(0x7f);
  const C1 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  const LS = String.fromCharCode(0x2028);
  // Controls right before, at and after the 64 Ki edges, and a run of them.
  const text = ["a".repeat(65535), DEL, C1, "b".repeat(65534), RLO, DEL.repeat(70000), "ü😀", LS, C1].join("");
  const { deps, out } = makeCli(okResponse);
  renderJson(deps, { compact: true }, { text });
  const expected = JSON.stringify({ text }).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.equal(out[0], expected);
  assert.deepEqual(JSON.parse(out[0]!), { text });
});

// 2026-10-21 sweep, 03 Bug 3: the size cap was framed as "could not reach the API", and the
// README sent the reader to connectivity, DNS and --timeout.
test("an answer over the size cap says so and names --max-response-bytes, not 'could not reach the API'", async () => {
  const cli = makeCli(() => rawResponse("x".repeat(100), "application/json"));
  assert.equal(await run(["--max-response-bytes", "10", "details", "10001-1-S"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  const err = untimed(cli.err.join("\n"));
  assert.doesNotMatch(err, /could not reach/);
  assert.equal(
    err,
    `ERROR [jobsuche.http] GET https://rest.arbeitsagentur.de${SERVICE}/pc/v4/jobdetails/MTAwMDEtMS1T failed: ` +
      "Response exceeded maxResponseBytes (10 bytes; --max-response-bytes on the CLI). The server answered, with more than " +
      "the size cap allows: raise --max-response-bytes (0 = no limit).",
  );
  // A connection that failed is still "could not reach the API".
  const refused = makeCli(() => { throw new JobsucheNetworkError("connect ECONNREFUSED 127.0.0.1:9"); });
  assert.equal(await run(["details", "10001-1-S"], refused.deps), 1);
  assert.match(untimed(refused.err.join("\n")), /^ERROR \[jobsuche\.http\] could not reach the API \(GET .* failed: connect ECONNREFUSED/);
});

// Found in the 2026-10-21 fix round (the class of ckan-cli 7f8b5e3): a URL with a password
// given as a text filter, padded or after a dash, was not found by the redaction (it looked for
// a scheme at the start of each argument), and the library sends the value trimmed, so the
// password reached stderr in the request URL, the --wo note and the dash-guard refusal.
test("a password in a URL inside an option value is redacted on stderr, padded or not", async () => {
  const url = "https://bob:s3cretpw@host.example/";
  const argvs = [
    ["search", "--was", url], ["search", "--was", ` ${url}`], ["search", "--was", `\t${url}`], [`--was= ${url}`],
    ["search", "--was", ` -${url}`], ["search", "--wo", ` ${url}`], ["search", "--was", `Koch ${url}`],
  ].map((argv) => (argv[0] === "search" ? argv : ["search", ...argv]));
  for (const argv of argvs) {
    for (const status of [404, 200]) {
      const cli = makeCli(() =>
        status === 404
          ? jsonResponse({ messages: [{ code: "X" }] }, 404)
          : jsonResponse({ maxErgebnisse: 0, woOutput: { bereinigterOrt: "Bonn" } }),
      );
      await run(argv, cli.deps);
      const err = cli.err.join("\n");
      assert.doesNotMatch(err, /s3cretpw|bob%3As3/, `${JSON.stringify(argv)} ${status}: ${err}`);
    }
  }
});

// T15b: the URL search of T15 runs over every argument on every run. A pattern retried at every
// position took ~3 s on a 40 000-character argument without "://" and hung on 1 MB, and one slice
// per "://" held 100 000 copies of the rest; indexOf keeps it linear, at most 64 URLs per argument.
for (const [what, big] of [
  ["40 000 characters without ://", "b".repeat(40_000)],
  ["1 MB without ://", "b".repeat(1024 * 1024)],
  ["100 000 ://", "a://".repeat(100_000)],
] as const) {
  test(`the URL search of the redaction is linear: an argument of ${what} is read fast (T15b)`, () => {
    const started = performance.now();
    const redaction = redactionFor([big], {});
    assert.equal(redaction.err("no secret here"), "no secret here");
    const took = performance.now() - started;
    assert.ok(took < 1000, `${what} took ${Math.round(took)} ms`);
  });
}
