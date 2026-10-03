import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
import { JobsucheError, JobsucheValidationError } from "../src/client/errors.js";
import * as lib from "../src/index.js";
import { run } from "../src/cli/run.js";
import type { JobsucheClient } from "../src/client/client.js";
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
