// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { JobsucheClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { MAX_RETRIES } from "../client/engine.js";
import { onceOnly, parseApiKey, parseBaseUrl, parseBoundedInt, parseHeaderValue, parseIntArg } from "./shared.js";
import { registerJobCommands } from "./commands/jobs.js";
import { registerObtainKeyCommands } from "./commands/obtain-key.js";
import { registerConfigCommands } from "./commands/config.js";
import { DEFAULT_LOG_FORMAT, logFormatProblem } from "./log.js";
import { CredentialStore } from "./credentials.js";
import { nodeHttpTransport } from "../client/http.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new JobsucheClient(options),
  transport: nodeHttpTransport,
  credentials: () => CredentialStore.fromEnv(process.env),
};

/** commander value-parser for `--log-format`. */
function parseLogFormat(value: string): string {
  const problem = logFormatProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();
  // Every option takes one value: a repeated one is a usage error, not "last one wins".
  const seen = new Set<string>();
  const once = <T>(flag: string, parse: (value: string) => T): ((value: string) => T) => onceOnly(seen, flag, parse);

  program
    .name("jobsuche")
    .description(
      "CLI for the Bundesagentur für Arbeit Jobsuche API " +
        "(rest.arbeitsagentur.de/jobboerse/jobsuche-service). Requires an X-API-Key: " +
        "pass --api-key, set JOBSUCHE_API_KEY, or store it once with " +
        "`jobsuche config set api-key`. No key is bundled — run " +
        "`jobsuche obtain-key` to fetch the published public one.",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", once("--base-url", parseBaseUrl), "https://rest.arbeitsagentur.de")
    .option(
      "--api-key <key>",
      "X-API-Key header value. Prefer JOBSUCHE_API_KEY or `jobsuche config set api-key`: " +
        "an --api-key argument is visible to other local users via the process table and shell history.",
      once("--api-key", parseApiKey),
    )
    .option("--timeout <ms>", "per-request timeout in milliseconds", once("--timeout", parseBoundedInt(0, MAX_TIMEOUT_MS)))
    .option("--user-agent <ua>", "User-Agent header value", once("--user-agent", parseHeaderValue))
    .option(
      "--max-retries <n>",
      `retries for transient 429/503 responses (0-${MAX_RETRIES})`,
      once("--max-retries", parseBoundedInt(0, MAX_RETRIES)),
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      once("--max-response-bytes", parseIntArg),
    )
    .option(
      "--log-format <format>",
      `how errors, warnings and notes are written to stderr: text (log4j style: time, level, [topic], message) or jsonl (one JSON object per line: ts, level, topic, msg); default ${DEFAULT_LOG_FORMAT}`,
      once("--log-format", parseLogFormat),
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  // The API key may also come from the JOBSUCHE_API_KEY environment variable or the
  // credentials file. Both fallbacks are resolved at action time — the env var in
  // toEngineOptions() (reading deps.env), the file in action() (reading
  // deps.credentials) — so precedence is --api-key > JOBSUCHE_API_KEY > the
  // credentials file > none, and both paths stay injectable/testable.

  registerObtainKeyCommands(program, deps);
  registerConfigCommands(program, deps);
  registerJobCommands(program, deps);

  return program;
}
