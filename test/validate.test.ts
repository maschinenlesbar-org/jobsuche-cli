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
