import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { JobsucheClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

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
  const cli = makeCli(() => jsonResponse({ stellenangebote: [] }));
  const code = await run(["search", "--was", "Informatiker", "--size", "5"], cli.deps);
  assert.equal(code, 0);
  const req = cli.mt.last();
  // No key is bundled: without --api-key/env the header is omitted.
  assert.equal(req.headers?.["X-API-Key"], undefined);
  const url = new URL(req.url);
  assert.equal(url.pathname, `${SERVICE}/pc/v4/jobs`);
  assert.equal(url.searchParams.get("was"), "Informatiker");
});

test("--api-key overrides the header", async () => {
  const cli = makeCli(() => jsonResponse({ stellenangebote: [] }));
  await run(["--api-key", "custom", "search", "--was", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "custom");
});

test("JOBSUCHE_API_KEY seeds the X-API-Key header", async () => {
  const cli = makeCli(() => jsonResponse({ stellenangebote: [] }), { JOBSUCHE_API_KEY: "env-key" });
  await run(["search", "--was", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "env-key");
});

test("--api-key overrides JOBSUCHE_API_KEY", async () => {
  const cli = makeCli(() => jsonResponse({ stellenangebote: [] }), { JOBSUCHE_API_KEY: "env-key" });
  await run(["--api-key", "flag-key", "search", "--was", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "flag-key");
});

test("an all-whitespace JOBSUCHE_API_KEY is ignored (no header sent)", async () => {
  const cli = makeCli(() => jsonResponse({ stellenangebote: [] }), { JOBSUCHE_API_KEY: "   " });
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

test("details encodes a hyphenless numeric refnr", async () => {
  const cli = makeCli(() => jsonResponse({}));
  await run(["details", "1002716922"], cli.deps);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    `${SERVICE}/pc/v4/jobdetails/MTAwMjcxNjkyMg%3D%3D`,
  );
});

test("search forwards --angebotsart", async () => {
  const cli = makeCli(() => jsonResponse({ stellenangebote: [] }));
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

test("an empty --was is omitted from the query, not sent as was= (B5/B17)", async () => {
  const cli = makeCli(() => jsonResponse({ stellenangebote: [] }));
  await run(["search", "--was", "", "--wo", "Berlin"], cli.deps);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.has("was"), false);
  assert.equal(url.searchParams.get("wo"), "Berlin");
});

test("a blank --api-key sends no header (no bundled default) (B7)", async () => {
  const cli = makeCli(() => jsonResponse({ stellenangebote: [] }));
  await run(["--api-key", "", "search", "--was", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], undefined);
});

test("a bad integer flag is a usage error (exit 2), distinct from runtime errors (B10)", async () => {
  const cli = makeCli(() => jsonResponse({ stellenangebote: [] }));
  const code = await run(["search", "--size", "0x10"], cli.deps);
  assert.equal(code, 2);
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
