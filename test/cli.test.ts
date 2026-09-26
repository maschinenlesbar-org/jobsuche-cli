import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { JobsucheClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import { V6_SEARCH } from "./fixtures.js";

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
  const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }));
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
  const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }));
  await run(["--api-key", "custom", "search", "--was", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "custom");
});

test("JOBSUCHE_API_KEY seeds the X-API-Key header", async () => {
  const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }), { JOBSUCHE_API_KEY: "env-key" });
  await run(["search", "--was", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "env-key");
});

test("--api-key overrides JOBSUCHE_API_KEY", async () => {
  const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }), { JOBSUCHE_API_KEY: "env-key" });
  await run(["--api-key", "flag-key", "search", "--was", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "flag-key");
});

test("an all-whitespace JOBSUCHE_API_KEY is ignored (no header sent)", async () => {
  const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }), { JOBSUCHE_API_KEY: "   " });
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
  const cli = makeCli(() => jsonResponse({}));
  await run(["details", "1002716922"], cli.deps);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    `${SERVICE}/pc/v4/jobdetails/MTAwMjcxNjkyMg%3D%3D`,
  );
});

test("search forwards --angebotsart", async () => {
  const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }));
  await run(["search", "--was", "x", "--angebotsart", "1"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("angebotsart"), "1");
});

test("details encodes the refnr", async () => {
  const cli = makeCli(() => jsonResponse({}));
  await run(["details", "10001-1002716922-S"], cli.deps);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    `${SERVICE}/pc/v4/jobdetails/MTAwMDEtMTAwMjcxNjkyMi1T`,
  );
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = { titel: `Informatiker${controls}`, arbeitgeber: String.fromCharCode(0x1b) + "[31m" };
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
  const cli = makeCli(() => jsonResponse({}));
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
    const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }));
    const code = await run(["--api-key", "dummy", "search", flag, value, "--wo", "Berlin"], cli.deps);
    assert.notEqual(code, 0);
    assert.equal(code, 2);
    assert.deepEqual(cli.out, []);
    assert.match(cli.err.join("\n"), /Must not be blank/);
    assert.equal(cli.mt.calls.length, 0);
  });
}

test("a blank --api-key sends no header (no bundled default) (B7)", async () => {
  const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }));
  await run(["--api-key", "", "search", "--was", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], undefined);
});

test("a bad integer flag is a usage error (exit 2), distinct from runtime errors (B10)", async () => {
  const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }));
  const code = await run(["search", "--size", "0x10"], cli.deps);
  assert.equal(code, 2);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }));
  assert.equal(await run(["--timeout", "2147483647", "search", "--was", "x"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse({ ergebnisliste: [] }));
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
  const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }));
  const code = await run(["search", "--was", "--wo", "Berlin"], cli.deps);
  assert.equal(code, 2);
  assert.deepEqual(cli.out, []);
  assert.match(cli.err.join("\n"), /is the next option, consumed because/);
  // No request should have been made at all.
  assert.equal(cli.mt.calls.length, 0);
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
    const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }));
    assert.equal(await run(["search", "--was", "x", ...args], cli.deps), 0);
    assert.equal(new URL(cli.mt.last().url).searchParams.get("zeitarbeit"), expected);
  });
}

// The API ignores veroeffentlichtseit above 100 and returns the unfiltered set.
test("--veroeffentlicht-seit accepts 0..100 and rejects 101 before any request", async () => {
  for (const days of ["0", "100"]) {
    const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }));
    assert.equal(await run(["search", "--veroeffentlicht-seit", days], cli.deps), 0);
    assert.equal(new URL(cli.mt.last().url).searchParams.get("veroeffentlichtseit"), days);
  }
  const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }));
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
  assert.match(err, /Failed to parse JSON response/);
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
    const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }));
    assert.equal(await run(["search", flag, value], cli.deps), 2);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  });
}

test("every documented --angebotsart code and --page 1 are accepted", async () => {
  for (const code of ["1", "2", "4", "34"]) {
    const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }));
    assert.equal(await run(["search", "--angebotsart", code, "--page", "1"], cli.deps), 0);
    assert.equal(new URL(cli.mt.last().url).searchParams.get("angebotsart"), code);
  }
});

// A blank reference exited 1 from the client's check; it is a usage error.
for (const ref of ["", "   "]) {
  test(`details ${JSON.stringify(ref)} is a usage error (exit 2) before any request`, async () => {
    const cli = makeCli(() => jsonResponse({}));
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
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run([...argv], cli.deps), code);
    assert.equal(cli.mt.calls.length, 0);
    if (code === 0) assert.doesNotMatch(cli.err.join("\n"), /missing command/);
  });
}

// With "#frag" every filter ended up in the fragment and an unfiltered search ran.
for (const baseUrl of ["http://127.0.0.1:1/echo?x=1", "http://127.0.0.1:1/echo#frag", "http://127.0.0.1:1/?"]) {
  test(`--base-url ${baseUrl} is a usage error`, async () => {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(["--base-url", baseUrl, "search", "--was", "x"], cli.deps), 2);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /cannot have a query \(\?\) or fragment \(#\)/);
  });
}

test("a base URL with a path prefix still works", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--base-url", "https://mirror.example/ba/", "search", "--was", "x"], cli.deps), 0);
  assert.equal(new URL(cli.mt.last().url).pathname, `/ba${SERVICE}/pc/v6/jobs`);
});

// A password in --base-url was printed with every error (CI logs).
test("a password in --base-url is not echoed in an error, but still sent", async () => {
  const cli = makeCli(() => jsonResponse({ detail: "nope" }, 404));
  assert.equal(await run(["--base-url", "http://user:s3cret@127.0.0.1:1/e", "search", "--was", "x"], cli.deps), 4);
  const err = cli.err.join("\n");
  assert.doesNotMatch(err, /s3cret|user:/);
  assert.match(err, /http:\/\/\*\*\*@127\.0\.0\.1:1\/e\/jobboerse/);
  assert.match(cli.mt.last().url, /user:s3cret@/);
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
    const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }));
    assert.equal(await run([flag, value, "search", "--was", "x"], cli.deps), 2);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  });
}

test("a tab and Latin-1 in --user-agent are sent; a blank --api-key still falls back to the env", async () => {
  const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }), { JOBSUCHE_API_KEY: "env-key" });
  assert.equal(await run(["--user-agent", "a\tü", "--api-key", " ", "search", "--was", "x"], cli.deps), 0);
  assert.equal(cli.mt.last().headers?.["User-Agent"], "a\tü");
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "env-key");
});

test("an unsendable JOBSUCHE_API_KEY is a typed error, not an unexpected one", async () => {
  const cli = makeCli(() => jsonResponse({ ergebnisliste: [] }), { JOBSUCHE_API_KEY: "a\nb" });
  assert.equal(await run(["search", "--was", "x"], cli.deps), 1);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /^Error: Invalid apiKey: it contains control characters/);
});

// A 100 000-deep body parsed fine but overflowed JSON.stringify:
// "Unexpected error: Maximum call stack size exceeded".
test("a deeply nested response gives a clear error instead of a stack overflow", async () => {
  const depth = 200_000;
  const body = "[".repeat(depth) + "]".repeat(depth);
  const pretty = makeCli(() => rawResponse(body, "application/json"));
  assert.equal(await run(["search", "--was", "x"], pretty.deps), 1);
  assert.equal(pretty.err.join("\n"), "Error: The response is nested too deeply to pretty-print; try --compact.");

  const compact = makeCli(() => rawResponse(body, "application/json"));
  const code = await run(["--compact", "search", "--was", "x"], compact.deps);
  // Compact output may still fit the stack; if not, the message is the compact one.
  if (code !== 0) {
    assert.equal(code, 1);
    assert.equal(compact.err.join("\n"), "Error: The response is nested too deeply to print.");
  }
});
