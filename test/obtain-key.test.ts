// `obtain-key`: the command that fetches the public X-API-Key at run time.
// No key is bundled, so this path must never invent one — every failure mode
// below asserts that it fails loudly instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { JobsucheClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { API_KEY_ENV_VAR, KEY_SOURCE_URL, obtainKey } from "../src/client/obtain-key.js";
import { JobsucheError, JobsucheParseError } from "../src/client/errors.js";
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

test("a quote-free shell payload is still inert inside single quotes", async () => {
  const cli = makeCli(() => rawResponse("X-API-Key: a$(id)b", "text/plain"));
  const code = await run(["obtain-key", "--export"], cli.deps);
  assert.equal(code, 0);
  // Single-quoted, so `eval` treats $(id) as literal text, not a substitution.
  assert.equal(cli.out[0], `export ${API_KEY_ENV_VAR}='a$(id)b'`);
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
