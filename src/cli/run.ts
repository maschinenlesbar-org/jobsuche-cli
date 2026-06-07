// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import {
  JobsucheApiError,
  JobsucheError,
  JobsucheNetworkError,
  JobsucheParseError,
} from "../client/errors.js";

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const program = buildProgram(deps);
  configureTree(program, deps);

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // An explicit --help / --version request is a success.
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
        return 0;
      }
      // Invoked with no command at all: commander has already printed help.
      // Treat it as a usage error with an explicit diagnostic so scripts get a
      // distinct, documented exit code (2) rather than a bare, message-less 1.
      if (err.code === "commander.help") {
        deps.io.err("error: missing command (see usage above).");
        return 2;
      }
      // Genuine parse / usage errors (unknown option, bad value, missing
      // argument, ...) get a dedicated exit code (2) so a wrapper script can
      // tell a bad invocation from a runtime/network failure (which exit 1).
      return 2;
    }
    if (err instanceof JobsucheApiError) {
      // Map a few notable statuses to distinct exit codes for scripting.
      if (err.status === 401 || err.status === 403) {
        // 401/403 is usually a key problem, but a resource-level forbidden or a
        // quota/rate reason can also land here. Surface the server-supplied
        // `detail` when present instead of unconditionally blaming the key, and
        // always append the actionable key hint.
        const reason = err.detail ? `: ${err.detail}` : "";
        deps.io.err(
          `Error: request rejected (HTTP ${err.status})${reason}. ` +
            `If this is an auth problem, check --api-key or the ` +
            `JOBSUCHE_API_KEY environment variable.`,
        );
        return 3;
      }
      deps.io.err(`Error: ${err.message}`);
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof JobsucheNetworkError) {
      // Transport-level failure (DNS, refused connection, timeout, body cap).
      // Frame it as a connectivity problem rather than a bare libuv string.
      deps.io.err(`Network error: could not reach the API (${err.message}).`);
      return 1;
    }
    if (err instanceof JobsucheParseError) {
      // Include the underlying parser cause / offending detail so the user can
      // see what actually came back instead of an opaque "Failed to parse".
      const cause = err.cause instanceof Error ? err.cause.message : err.cause;
      const causePart = cause ? ` (${cause})` : "";
      deps.io.err(`Error: ${err.message}${causePart}`);
      return 1;
    }
    if (err instanceof JobsucheError) {
      deps.io.err(`Error: ${err.message}`);
      return 1;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
