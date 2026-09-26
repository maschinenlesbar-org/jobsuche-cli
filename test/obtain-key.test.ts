// `obtain-key`: the command that fetches the public X-API-Key at run time.
// No key is bundled, so this path must never invent one — every failure mode
// below asserts that it fails loudly instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { JobsucheClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { API_KEY_ENV_VAR, KEY_SOURCE_URL, obtainKey, shellQuoteSingle } from "../src/client/obtain-key.js";
import { JobsucheError, JobsucheNetworkError, JobsucheParseError } from "../src/client/errors.js";
import { makeMockTransport, rawResponse } from "./helpers.js";

const README = [
  "# jobsuche-api",
  "",
  "```bash",
  'curl -H "X-API-Key: jobboerse-jobsuche" https://rest.arbeitsagentur.de/...',
  "```",
].join("\n");

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new JobsucheClient({ ...opts, transport: mt.transport }),
    env: {},
    transport: mt.transport,
  };
  return { deps, out, err, mt };
}

test("obtainKey reads the key from the published source", async () => {
  const mt = makeMockTransport(() => rawResponse(README, "text/plain"));
  const result = await obtainKey({ transport: mt.transport });
  assert.equal(result.key, "jobboerse-jobsuche");
  assert.equal(result.sourceUrl, KEY_SOURCE_URL);
  assert.equal(mt.last().url, KEY_SOURCE_URL);
  assert.equal(mt.last().method, "GET");
});

test("obtainKey throws when the source is unreachable", async () => {
  const mt = makeMockTransport(() => rawResponse("nope", "text/plain", 503));
  await assert.rejects(() => obtainKey({ transport: mt.transport }), JobsucheError);
});

test("obtainKey throws when the source no longer states a key", async () => {
  const mt = makeMockTransport(() => rawResponse("# readme with no key", "text/plain"));
  await assert.rejects(() => obtainKey({ transport: mt.transport }), JobsucheParseError);
});

test("obtain-key prints only the key on stdout, provenance on stderr", async () => {
  const cli = makeCli(() => rawResponse(README, "text/plain"));
  const code = await run(["obtain-key"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, ["jobboerse-jobsuche"]);
  assert.match(cli.err.join("\n"), new RegExp(KEY_SOURCE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("obtain-key --export emits a quoted, eval-safe export line", async () => {
  const cli = makeCli(() => rawResponse(README, "text/plain"));
  const code = await run(["obtain-key", "--export"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, [`export ${API_KEY_ENV_VAR}='jobboerse-jobsuche'`]);
});

test("a quote in the source truncates the value rather than escaping into the shell", async () => {
  // The key pattern accepts no whitespace, quote or backtick, so a payload that
  // needs any of them cannot even be captured.
  const cli = makeCli(() => rawResponse(`X-API-Key: a'$(touch /tmp/pwned)'b`, "text/plain"));
  const code = await run(["obtain-key", "--export"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.out[0], `export ${API_KEY_ENV_VAR}='a'`);
});

test("a quote-free shell payload is not taken for a key", async () => {
  const cli = makeCli(() => rawResponse("X-API-Key: a$(id)b", "text/plain"));
  const code = await run(["obtain-key", "--export"], cli.deps);
  assert.notEqual(code, 0);
  assert.deepEqual(cli.out, []);
});

test("shellQuoteSingle keeps a payload inert inside single quotes", () => {
  // Single-quoted, so `eval` treats $(id) as literal text, not a substitution.
  assert.equal(shellQuoteSingle("a$(id)b"), "'a$(id)b'");
  assert.equal(shellQuoteSingle("a'b"), `'a'\\''b'`);
});

// The pattern took the first non-blank token after "X-API-Key:", so control
// characters reached the terminal and a placeholder example was printed as the key.
test("obtainKey skips placeholders and control characters", async () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  for (const bad of [`X-API-Key: ${ESC}]0;PWN${BEL}abc`, "X-API-Key: <key>", "curl -H X-API-Key: $KEY"]) {
    const mt = makeMockTransport(() => rawResponse(bad, "text/plain"));
    await assert.rejects(() => obtainKey({ transport: mt.transport }), JobsucheParseError, bad);
    const withReal = makeMockTransport(() => rawResponse(`${bad}\n${README}`, "text/plain"));
    assert.equal((await obtainKey({ transport: withReal.transport })).key, "jobboerse-jobsuche", bad);
  }
});

test("obtainKey reads the README's clientId line and ignores prose", async () => {
  const doc = [
    "Die Authentifizierung funktioniert über die clientId:",
    "",
    "**clientId:** jobboerse-jobsuche",
    "",
    "Bei folgenden GET-requests ist die clientId als Header-Parameter 'X-API-Key' zu übergeben.",
    'Falls client_id nicht funktioniert kann man stattdessen "X-API-KEY: jobboerse-jobsuche" verwenden',
    README,
  ].join("\n");
  const mt = makeMockTransport(() => rawResponse(doc, "text/plain"));
  assert.equal((await obtainKey({ transport: mt.transport })).key, "jobboerse-jobsuche");
});

test("obtainKey refuses a source that states two different keys", async () => {
  const mt = makeMockTransport(() => rawResponse(`**clientId:** one-key\n${README}`, "text/plain"));
  await assert.rejects(() => obtainKey({ transport: mt.transport }), /conflicting keys \(one-key, jobboerse-jobsuche\)/);
});

test("obtain-key needs no configured key and sends none", async () => {
  const cli = makeCli(() => rawResponse(README, "text/plain"));
  const code = await run(["obtain-key"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], undefined);
});

test("a failing obtain-key exits non-zero rather than printing a guess", async () => {
  const cli = makeCli(() => rawResponse("", "text/plain", 404));
  const code = await run(["obtain-key"], cli.deps);
  assert.notEqual(code, 0);
  assert.deepEqual(cli.out, []);
});

test("obtainKey rejects a non-http(s) source URL before the transport sees it", async () => {
  for (const sourceUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => rawResponse(README, "text/plain"));
    await assert.rejects(() => obtainKey({ transport: mt.transport, sourceUrl }), JobsucheNetworkError);
    assert.equal(mt.calls.length, 0);
  }
});

// obtain-key had no timeout unless --timeout was given and no size cap at all,
// so a stalled or endless source hung `eval "$(jobsuche obtain-key --export)"`.
test("obtainKey applies the client's default timeout and size cap", async () => {
  const mt = makeMockTransport(() => rawResponse(README, "text/plain"));
  await obtainKey({ transport: mt.transport });
  assert.equal(mt.last().timeoutMs, 30_000);
  assert.equal(mt.last().maxResponseBytes, 100 * 1024 * 1024);
});

test("obtainKey takes explicit limits, and 0 turns one off", async () => {
  const mt = makeMockTransport(() => rawResponse(README, "text/plain"));
  await obtainKey({ transport: mt.transport, timeoutMs: 5, maxResponseBytes: 10 });
  assert.equal(mt.last().timeoutMs, 5);
  assert.equal(mt.last().maxResponseBytes, 10);
  await obtainKey({ transport: mt.transport, timeoutMs: 0, maxResponseBytes: 0 });
  assert.equal("timeoutMs" in mt.last(), false);
  assert.equal("maxResponseBytes" in mt.last(), false);
});

test("obtain-key passes --timeout and --max-response-bytes to the request", async () => {
  const cli = makeCli(() => rawResponse(README, "text/plain"));
  assert.equal(await run(["--timeout", "1234", "--max-response-bytes", "10", "obtain-key"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 1234);
  assert.equal(cli.mt.last().maxResponseBytes, 10);
});
