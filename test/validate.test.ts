import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
import { JobsucheError, JobsucheValidationError } from "../src/client/errors.js";
import * as lib from "../src/index.js";
import { run } from "../src/cli/run.js";
import type { JobsucheClient } from "../src/client/client.js";
import type { HttpResponse } from "../src/client/http.js";
import { parity } from "./helpers.js";

const notBlank: Problem = (v) => (v.trim() === "" ? "Must not be blank." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("was", "Informatiker", notBlank), "Informatiker");
});

test("assertValid throws JobsucheValidationError naming the input and the reason", () => {
  assert.throws(
    () => assertValid("was", " ", notBlank),
    (err) =>
      err instanceof JobsucheValidationError &&
      err instanceof JobsucheError &&
      err.name === "JobsucheValidationError" &&
      err.message === "Invalid was: Must not be blank.",
  );
});

test("the validation layer is exported from the package root", () => {
  assert.equal(lib.assertValid, assertValid);
  assert.equal(lib.JobsucheValidationError, JobsucheValidationError);
});

test("run() maps a JobsucheValidationError from an action to exit 2 with 'Error: <message>'", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const fake = {
    search: async () => assertValid("was", " ", notBlank),
  } as unknown as JobsucheClient;
  const code = await run(["search"], {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: () => fake,
    env: {},
  });
  assert.equal(code, 2);
  assert.deepEqual(err, ["Error: Invalid was: Must not be blank."]);
  assert.deepEqual(out, []);
});

test("run() maps a JobsucheValidationError from the client constructor to exit 2", async () => {
  const err: string[] = [];
  const code = await run(["search", "--was", "x"], {
    io: { out: () => {}, err: (s) => err.push(s) },
    createClient: () => {
      throw new JobsucheValidationError("Invalid timeoutMs: Expected a non-negative integer.");
    },
    env: {},
  });
  assert.equal(code, 2);
  assert.deepEqual(err, ["Error: Invalid timeoutMs: Expected a non-negative integer."]);
});

test("parity() drives the same input through the CLI and the library on one transport", async () => {
  const { cli, lib: l } = await parity(
    ["--api-key", "k", "search", "--was", "Informatiker"],
    (transport) => new lib.JobsucheClient({ transport, apiKey: "k" }).search({ was: "Informatiker" }),
  );
  assert.equal(cli.code, 0);
  assert.equal(l.ok, true);
  assert.equal(cli.requests.length, 1);
  assert.deepEqual(l.requests, cli.requests);
});

// ---- Finding #2 (PAT-9): blank free-text filters -----------------------------

/** Both sides reject the input and neither sends a request. */
function assertBothReject(
  r: Awaited<ReturnType<typeof parity>>,
  libMessage: string,
): void {
  assert.equal(r.cli.code, 2, r.cli.err);
  assert.deepEqual(r.cli.requests, []);
  assert.equal(r.lib.ok, false);
  assert.ok(r.lib.error instanceof JobsucheValidationError, String(r.lib.error));
  assert.equal((r.lib.error as Error).message, libMessage);
  assert.deepEqual(r.lib.requests, []);
}

for (const field of ["was", "wo", "berufsfeld", "arbeitgeber"] as const) {
  for (const blank of ["", "  ", "\t"]) {
    test(`parity: a blank ${field} (${JSON.stringify(blank)}) is rejected by CLI and library alike`, async () => {
      const r = await parity(
        field === "was" ? ["search", `--was=${blank}`] : ["search", "--was", "Dev", `--${field}=${blank}`],
        (transport) =>
          new lib.JobsucheClient({ transport }).search({
            ...(field === "was" ? {} : { was: "Dev" }),
            [field]: blank,
          }),
      );
      assertBothReject(r, `Invalid ${field}: Must not be blank.`);
    });
  }
}

test("validateSearchParams rejects a blank string filter and accepts undefined", () => {
  assert.throws(
    () => lib.validateSearchParams({ wo: " " }),
    (err) => err instanceof JobsucheValidationError && err.message === "Invalid wo: Must not be blank.",
  );
  assert.doesNotThrow(() => lib.validateSearchParams({ was: "Dev", wo: undefined }));
});

test("nonBlankProblem names a blank value and accepts any other", () => {
  assert.equal(lib.nonBlankProblem(""), "Must not be blank.");
  assert.equal(lib.nonBlankProblem(" \t "), "Must not be blank.");
  assert.equal(lib.nonBlankProblem(" Dev "), undefined);
});

test("search() rejects a blank filter asynchronously, without throwing synchronously", () => {
  const client = new lib.JobsucheClient({ transport: async () => ({ status: 200, headers: {}, body: Buffer.from("{}") }) });
  const p = client.search({ was: "" });
  assert.ok(p instanceof Promise);
  return assert.rejects(p, JobsucheValidationError);
});

// ---- Finding #1 (PAT-11, PAT-12, PAT-24): numeric search parameters ----------

const numericCases: Array<[string[], Record<string, number>, string]> = [
  [["--veroeffentlicht-seit=101"], { veroeffentlichtseit: 101 }, "Invalid veroeffentlichtseit: Must be <= 100."],
  [["--veroeffentlicht-seit=365"], { veroeffentlichtseit: 365 }, "Invalid veroeffentlichtseit: Must be <= 100."],
  [["--veroeffentlicht-seit=1.5"], { veroeffentlichtseit: 1.5 }, "Invalid veroeffentlichtseit: Expected a non-negative integer."],
  [["--angebotsart=3"], { angebotsart: 3 }, "Invalid angebotsart: Unknown code 3: valid codes are 1, 2, 4, 34 (1 job, 2 self-employment, 4 apprenticeship/dual study, 34 internship/trainee)."],
  [["--angebotsart=0"], { angebotsart: 0 }, "Invalid angebotsart: Unknown code 0: valid codes are 1, 2, 4, 34 (1 job, 2 self-employment, 4 apprenticeship/dual study, 34 internship/trainee)."],
  [["--page=0"], { page: 0 }, "Invalid page: Must be >= 1."],
  [["--page=NaN"], { page: NaN }, "Invalid page: Expected a non-negative integer."],
  [["--umkreis=-5"], { umkreis: -5 }, "Invalid umkreis: Expected a non-negative integer."],
  [["--umkreis=Infinity"], { umkreis: Infinity }, "Invalid umkreis: Expected a non-negative integer."],
  [["--size=1.5"], { size: 1.5 }, "Invalid size: Expected a non-negative integer."],
  [["--size=-1"], { size: -1 }, "Invalid size: Expected a non-negative integer."],
];

for (const [flags, params, message] of numericCases) {
  test(`parity: search ${flags.join(" ")} is rejected by CLI and library alike`, async () => {
    const r = await parity(["search", "--was", "Dev", ...flags], (transport) =>
      new lib.JobsucheClient({ transport }).search({ was: "Dev", ...params } as lib.JobSearchParams),
    );
    assertBothReject(r, message);
  });
}

test("parity: the boundary values 100, 34 and page 1 send the same request on both sides", async () => {
  const r = await parity(
    ["search", "--was", "Dev", "--veroeffentlicht-seit=100", "--angebotsart=34", "--page=1", "--umkreis=0", "--size=0"],
    (transport) =>
      new lib.JobsucheClient({ transport }).search({
        was: "Dev",
        umkreis: 0,
        veroeffentlichtseit: 100,
        angebotsart: 34,
        page: 1,
        size: 0,
      }),
  );
  assert.equal(r.cli.code, 0, r.cli.err);
  assert.equal(r.lib.ok, true);
  assert.equal(r.cli.requests.length, 1);
  assert.deepEqual(r.lib.requests, r.cli.requests);
});

test("the CLI keeps its --angebotsart wording over the library rule", async () => {
  const r = await parity(["search", "--angebotsart=3"], () => undefined);
  assert.match(r.cli.err, /Unknown --angebotsart code 3: valid codes are 1, 2, 4, 34/);
});

test("the search bounds and codes are exported library constants", () => {
  assert.equal(lib.MAX_VEROEFFENTLICHT_SEIT, 100);
  assert.deepEqual(lib.ANGEBOTSART_CODES, [1, 2, 4, 34]);
});

test("intRangeProblem accepts safe integers in range and names what is wrong otherwise", () => {
  const p = lib.intRangeProblem(1, 100);
  assert.equal(p(1), undefined);
  assert.equal(p(100), undefined);
  assert.equal(p(0), "Must be >= 1.");
  assert.equal(p(101), "Must be <= 100.");
  assert.equal(p(1.5), "Expected a non-negative integer.");
  assert.equal(p(NaN), "Expected a non-negative integer.");
  const nonNegative = lib.intRangeProblem(0, Number.MAX_SAFE_INTEGER);
  assert.equal(nonNegative(0), undefined);
  assert.equal(nonNegative(-1), "Expected a non-negative integer.");
  assert.equal(nonNegative(Infinity), "Expected a non-negative integer.");
  assert.equal(nonNegative(2 ** 53), "Expected a non-negative integer.");
});

test("angebotsartProblem accepts exactly the documented codes", () => {
  for (const code of [1, 2, 4, 34]) assert.equal(lib.angebotsartProblem(code), undefined);
  for (const code of [0, 3, 5, 1.5, NaN]) assert.match(lib.angebotsartProblem(code) ?? "", /^Unknown code /);
});

// ---- Finding #4 (PAT-8): engine numeric limits --------------------------------

const engineCases: Array<[string[], Record<string, number>, string]> = [
  [["--timeout=-1"], { timeoutMs: -1 }, "Invalid timeoutMs: Expected a non-negative integer."],
  [["--timeout=NaN"], { timeoutMs: NaN }, "Invalid timeoutMs: Expected a non-negative integer."],
  [["--timeout=1.5"], { timeoutMs: 1.5 }, "Invalid timeoutMs: Expected a non-negative integer."],
  [["--max-response-bytes=-1"], { maxResponseBytes: -1 }, "Invalid maxResponseBytes: Expected a non-negative integer."],
  [["--max-retries=Infinity"], { maxRetries: Infinity }, "Invalid maxRetries: Expected a non-negative integer."],
  [["--max-retries=1.5"], { maxRetries: 1.5 }, "Invalid maxRetries: Expected a non-negative integer."],
  [["--max-retries=11"], { maxRetries: 11 }, "Invalid maxRetries: Must be <= 10."],
];

for (const [flags, options, message] of engineCases) {
  test(`parity: ${flags.join(" ")} is rejected by CLI and library alike`, async () => {
    const r = await parity([...flags, "search", "--was", "Dev"], (transport) =>
      new lib.JobsucheClient({ transport, ...options }).search({ was: "Dev" }),
    );
    assertBothReject(r, message);
  });
}

const KEY_DOC = "**clientId:** jobboerse-jobsuche";
const keySource = (): HttpResponse => ({
  status: 200,
  headers: { "content-type": "text/plain" },
  body: Buffer.from(KEY_DOC),
});

for (const [flags, options, message] of [
  [["--timeout=-1"], { timeoutMs: -1 }, "Invalid timeoutMs: Expected a non-negative integer."],
  [["--max-response-bytes=-1"], { maxResponseBytes: -1 }, "Invalid maxResponseBytes: Expected a non-negative integer."],
] as Array<[string[], Record<string, number>, string]>) {
  test(`parity: obtain-key ${flags.join(" ")} is rejected by CLI and obtainKey() alike`, async () => {
    const r = await parity([...flags, "obtain-key"], (transport) => lib.obtainKey({ transport, ...options }), {
      responder: keySource,
    });
    assertBothReject(r, message);
  });
}

test("parity: --max-retries 10 and --timeout 0 are accepted on both sides", async () => {
  const r = await parity(["--max-retries=10", "--timeout=0", "search", "--was", "Dev"], (transport) =>
    new lib.JobsucheClient({ transport, maxRetries: 10, timeoutMs: 0 }).search({ was: "Dev" }),
  );
  assert.equal(r.cli.code, 0, r.cli.err);
  assert.equal(r.lib.ok, true);
  assert.deepEqual(r.lib.requests, r.cli.requests);
});

test("the engine range-checks maxRedirects and retryDelayMs, and accepts the bounds", () => {
  assert.equal(lib.MAX_RETRIES, 10);
  assert.equal(lib.MAX_REDIRECTS, 10);
  assert.throws(() => new lib.RequestEngine({ maxRedirects: 11 }), /^JobsucheValidationError: Invalid maxRedirects: Must be <= 10\.$/);
  assert.throws(() => new lib.RequestEngine({ maxRedirects: NaN }), JobsucheValidationError);
  assert.throws(() => new lib.RequestEngine({ retryDelayMs: -1 }), /Invalid retryDelayMs/);
  assert.doesNotThrow(
    () =>
      new lib.RequestEngine({
        timeoutMs: lib.MAX_TIMEOUT_MS,
        maxRetries: 0,
        maxRedirects: 10,
        retryDelayMs: 0,
        maxResponseBytes: 0,
      }),
  );
  // Above MAX_TIMEOUT_MS the transport caps the timer (documented), so it stays allowed.
  assert.doesNotThrow(() => new lib.RequestEngine({ timeoutMs: lib.MAX_TIMEOUT_MS + 1 }));
});

test("intOption returns the fallback for undefined and checks any given value", () => {
  assert.equal(lib.intOption("maxRetries", undefined, 10, 2), 2);
  assert.equal(lib.intOption("maxRetries", 3, 10, 2), 3);
  assert.throws(() => lib.intOption("maxRetries", -1, 10, 2), /Invalid maxRetries: Expected a non-negative integer\./);
});

// ---- Finding #5 (PAT-5): User-Agent and other header values -------------------

const uaCases: Array<[string, string]> = [
  ["", "Invalid userAgent: Must not be blank."],
  ["   ", "Invalid userAgent: Must not be blank."],
  ["a\r\nX: y", "Invalid userAgent: Value contains control characters."],
  ["a\u0000b", "Invalid userAgent: Value contains control characters."],
  ["a\u007fb", "Invalid userAgent: Value contains control characters."],
  ["x€", "Invalid userAgent: Value contains characters outside Latin-1 (above U+00FF)."],
];

for (const [ua, message] of uaCases) {
  test(`parity: --user-agent ${JSON.stringify(ua)} is rejected by CLI and library alike`, async () => {
    const r = await parity([`--user-agent=${ua}`, "search", "--was", "Dev"], (transport) =>
      new lib.JobsucheClient({ transport, userAgent: ua }).search({ was: "Dev" }),
    );
    assertBothReject(r, message);
  });

  test(`parity: obtain-key --user-agent ${JSON.stringify(ua)} is rejected by CLI and obtainKey() alike`, async () => {
    const r = await parity([`--user-agent=${ua}`, "obtain-key"], (transport) => lib.obtainKey({ transport, userAgent: ua }), {
      responder: keySource,
    });
    assertBothReject(r, message);
  });
}

test("parity: a padded, tabbed or Latin-1 User-Agent is sent as given on both sides", async () => {
  for (const ua of [" pad ", "a\tb", "café"]) {
    const r = await parity([`--user-agent=${ua}`, "search", "--was", "Dev"], (transport) =>
      new lib.JobsucheClient({ transport, userAgent: ua }).search({ was: "Dev" }),
    );
    assert.equal(r.cli.code, 0, r.cli.err);
    assert.equal(r.lib.ok, true);
    assert.equal(r.cli.requests[0]?.headers?.["User-Agent"], ua);
    assert.deepEqual(r.lib.requests, r.cli.requests);
  }
});

test("obtainKey() sends DEFAULT_USER_AGENT when no userAgent is given", async () => {
  const sent: string[] = [];
  await lib.obtainKey({
    transport: async (req) => {
      sent.push(req.headers?.["User-Agent"] ?? "");
      return keySource();
    },
  });
  assert.deepEqual(sent, [lib.DEFAULT_USER_AGENT]);
});

test("the engine checks defaultHeaders names and values", () => {
  assert.throws(() => new lib.RequestEngine({ defaultHeaders: { "X-A": "a\nb" } }), /^JobsucheValidationError: Invalid header X-A: Value contains control characters\.$/);
  assert.throws(() => new lib.RequestEngine({ defaultHeaders: { "Bad Name": "v" } }), /Invalid header name/);
  assert.doesNotThrow(() => new lib.RequestEngine({ defaultHeaders: { "X-A": "v" } }));
});

test("headerValueProblem accepts tab and Latin-1 and names what a header cannot carry", () => {
  assert.equal(lib.headerValueProblem("a\tbÿ"), undefined);
  assert.equal(lib.headerValueProblem(" "), "Must not be blank.");
  assert.equal(lib.headerValueProblem("a\nb"), "Value contains control characters.");
  assert.equal(lib.headerValueProblem("Ā"), "Value contains characters outside Latin-1 (above U+00FF).");
  assert.equal(lib.headerNameProblem("X-API-Key"), undefined);
  assert.match(lib.headerNameProblem("a b") ?? "", /HTTP header name/);
});

// ---- Finding #3 (PAT-6): the API key is trimmed by the library ----------------

for (const key of [" test-key ", "test-key\n", "test-key\r\n", "\ntest-key", "\ttest-key\t"]) {
  test(`parity: API key ${JSON.stringify(key)} sends the same trimmed X-API-Key from flag, env and library`, async () => {
    const lib1 = (transport: lib.Transport) => new lib.JobsucheClient({ transport, apiKey: key }).search({ was: "Dev" });
    const viaFlag = await parity(["--api-key", key, "search", "--was", "Dev"], lib1);
    const viaEnv = await parity(["search", "--was", "Dev"], lib1, { env: { JOBSUCHE_API_KEY: key } });
    for (const r of [viaFlag, viaEnv]) {
      assert.equal(r.cli.code, 0, r.cli.err);
      assert.equal(r.lib.ok, true);
      assert.equal(r.cli.requests[0]?.headers?.["X-API-Key"], "test-key");
      assert.deepEqual(r.lib.requests, r.cli.requests);
    }
  });
}

test("parity: an API key with an inner newline is rejected from flag, env and library alike", async () => {
  const libCall = (transport: lib.Transport) => new lib.JobsucheClient({ transport, apiKey: "a\nb" }).search({ was: "Dev" });
  const viaFlag = await parity(["--api-key", "a\nb", "search", "--was", "Dev"], libCall);
  const viaEnv = await parity(["search", "--was", "Dev"], libCall, { env: { JOBSUCHE_API_KEY: "a\nb" } });
  for (const r of [viaFlag, viaEnv]) assertBothReject(r, "Invalid apiKey: Value contains control characters.");
  assert.equal(viaEnv.cli.err, "Error: Invalid apiKey: Value contains control characters.");
});

test("a blank API key is no key on every path", async () => {
  const libCall = (transport: lib.Transport) => new lib.JobsucheClient({ transport, apiKey: "   " }).search({ was: "Dev" });
  const r = await parity(["--api-key", "   ", "search", "--was", "Dev"], libCall, { env: { JOBSUCHE_API_KEY: "  " } });
  assert.equal(r.cli.code, 0, r.cli.err);
  assert.equal(r.cli.requests[0]?.headers?.["X-API-Key"], undefined);
  assert.deepEqual(r.lib.requests, r.cli.requests);
});

// ---- Finding #6 (PAT-2, PAT-1): one base-URL rule, a validation error ---------

const baseUrlCases: Array<[string, string]> = [
  ["ftp://x.example", 'Invalid baseUrl: Unsupported protocol "ftp:" (use http: or https:).'],
  ["", 'Invalid baseUrl: Invalid URL: "".'],
  ["   ", "Invalid baseUrl: A base URL cannot have surrounding whitespace."],
  ["not a url", "Invalid baseUrl: A base URL cannot contain whitespace or control characters."],
  ["notaurl", 'Invalid baseUrl: Invalid URL: "notaurl".'],
  ["https://x.example/?q=1", "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#)."],
  ["https://x.example/#f", "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#)."],
  ["https://x.example/ ", "Invalid baseUrl: A base URL cannot have surrounding whitespace."],
  [" https://x.example", "Invalid baseUrl: A base URL cannot have surrounding whitespace."],
  ["https://x.example/p\tq", "Invalid baseUrl: A base URL cannot contain whitespace or control characters."],
];

for (const [baseUrl, message] of baseUrlCases) {
  test(`parity: base URL ${JSON.stringify(baseUrl)} is rejected by CLI and library alike`, async () => {
    const r = await parity([`--base-url=${baseUrl}`, "search", "--was", "x"], (transport) =>
      new lib.JobsucheClient({ baseUrl, transport, apiKey: "test-key" }).search({ was: "x" }),
    );
    assertBothReject(r, message);
    assert.ok(!(r.lib.error instanceof lib.JobsucheNetworkError));
    // The CLI's parser reports the library's reason.
    assert.ok(r.cli.err.includes(message.replace(/^Invalid baseUrl: /, "")), r.cli.err);
  });
}

test("parity: a base URL with a path prefix and trailing slashes sends the same request on both sides", async () => {
  const baseUrl = "https://x.example/api//";
  const r = await parity([`--base-url=${baseUrl}`, "search", "--was", "x"], (transport) =>
    new lib.JobsucheClient({ baseUrl, transport }).search({ was: "x" }),
  );
  assert.equal(r.cli.code, 0, r.cli.err);
  assert.equal(r.cli.requests[0]?.url, "https://x.example/api/jobboerse/jobsuche-service/pc/v6/jobs?was=x");
  assert.deepEqual(r.lib.requests, r.cli.requests);
});

test("validateBaseUrl strips trailing slashes and redacts userinfo from its reasons", () => {
  assert.equal(lib.validateBaseUrl("https://x.example/api//"), "https://x.example/api");
  assert.equal(lib.baseUrlProblem("https://u:pw@x.example/p"), undefined);
  assert.throws(
    () => lib.validateBaseUrl("ftp://u:pw@x.example"),
    (err) => err instanceof JobsucheValidationError && !/pw/.test((err as Error).message),
  );
});

test("obtainKey() rejects a non-http(s) sourceUrl as a validation error, before any request", async () => {
  let calls = 0;
  await assert.rejects(
    () => lib.obtainKey({ sourceUrl: "ftp://x.example/k", transport: async () => (calls++, keySource()) }),
    /^JobsucheValidationError: Invalid sourceUrl: Unsupported protocol "ftp:" \(use http: or https:\)\.$/,
  );
  assert.equal(calls, 0);
});
