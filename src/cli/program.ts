// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { JobsucheClient } from "../client/client.js";
import { parseIntArg } from "./shared.js";
import { registerJobCommands } from "./commands/jobs.js";

export const VERSION = "1.0.0";

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new JobsucheClient(options),
};

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("jobsuche")
    .description(
      "CLI for the Bundesagentur für Arbeit Jobsuche API " +
        "(rest.arbeitsagentur.de/jobboerse/jobsuche-service). Uses the public X-API-Key by default.",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", "https://rest.arbeitsagentur.de")
    .option("--api-key <key>", "override the X-API-Key header (env: JOBSUCHE_API_KEY)")
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseIntArg)
    .option("--user-agent <ua>", "User-Agent header value")
    .option("--max-retries <n>", "retries for transient 429/503 responses", parseIntArg)
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  // The API key may also come from the JOBSUCHE_API_KEY environment variable.
  // That fallback is resolved at action time in toEngineOptions() (reading
  // deps.env), so an explicit --api-key always overrides it and the env path
  // stays injectable/testable.

  registerJobCommands(program, deps);

  return program;
}
