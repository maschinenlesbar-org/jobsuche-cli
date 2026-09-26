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
