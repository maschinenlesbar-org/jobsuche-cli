// Compile-time checks of the exported library types, and the runtime rule they describe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobsucheClient, KEY_SOURCE_URL, obtainKey } from "../src/index.js";
import { EMPTY_SEARCH, jsonResponse, makeMockTransport, rawResponse } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ apiKey: process.env.JOBSUCHE_API_KEY }` fails to compile
  // against an option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "jobsuche-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        "import {",
        "  JobsucheClient,",
        "  type JobsucheClientOptions,",
        "  type JobSearchParams,",
        "  type EngineOptions,",
        "  type ObtainKeyOptions,",
        "  type SearchOptions,",
        `} from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const a: JobsucheClientOptions = allUndefined<JobsucheClientOptions>();",
        "export const b: EngineOptions = allUndefined<EngineOptions>();",
        "export const c: JobSearchParams = allUndefined<JobSearchParams>();",
        "export const d: SearchOptions = allUndefined<SearchOptions>();",
        "export const e: ObtainKeyOptions = allUndefined<ObtainKeyOptions>();",
        "export const client = new JobsucheClient({ apiKey: process.env.JOBSUCHE_API_KEY, timeoutMs: 15_000 });",
        "export const page = client.search({ was: process.env.WAS, wo: process.env.WO, size: 10 });",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = makeMockTransport(() => jsonResponse(EMPTY_SEARCH));
  const client = new JobsucheClient({
    apiKey: undefined,
    baseUrl: undefined,
    userAgent: undefined,
    defaultHeaders: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.search(
    {
      was: undefined, wo: undefined, berufsfeld: undefined, arbeitgeber: undefined, umkreis: undefined,
      veroeffentlichtseit: undefined, zeitarbeit: undefined, angebotsart: undefined, page: undefined, size: undefined,
    },
    { allowUnknownParams: undefined },
  );
  assert.equal(mt.last().url, "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs");
  const headers = mt.last().headers ?? {};
  assert.equal(headers["User-Agent"], "jobsuche-cli");
  assert.equal(Object.keys(headers).some((h) => h.toLowerCase() === "x-api-key"), false);

  const doc = makeMockTransport(() => rawResponse('curl -H "X-API-Key: jobboerse-jobsuche" https://x', "text/plain"));
  const got = await obtainKey({
    sourceUrl: undefined,
    timeoutMs: undefined,
    userAgent: undefined,
    maxResponseBytes: undefined,
    transport: doc.transport,
  });
  assert.equal(got.key, "jobboerse-jobsuche");
  assert.equal(doc.last().url, KEY_SOURCE_URL);
});
