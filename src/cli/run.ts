// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import { toEngineOptions, type GlobalOptions } from "./shared.js";
import { sanitizeServerText } from "../client/engine.js";
import {
  JobsucheApiError,
  JobsucheError,
  JobsucheNetworkError,
  JobsucheParseError,
  JobsucheValidationError,
  credentialsIn,
  redactCredentials,
  redactSecrets,
  redactUrl,
} from "../client/errors.js";
import { API_KEY_ENV_VAR } from "../client/obtain-key.js";

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps, mask: (text: string) => string): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
    // Commander's own errors echo what was typed: an unknown command, surplus
    // arguments, an unknown option, a rejected option value. Mask what may be a secret.
    outputError: (str, write) => write(mask(str)),
  });
  for (const child of command.commands) configureTree(child, deps, mask);
}

/** The options whose value is a secret on its own (no `@` to anchor a redaction on). */
const SECRET_FLAGS = ["--api-key"];

/**
 * Whether commander may echo an argv token as typed: a short value (up to 6
 * characters), an all-lower-case word (a mistyped command such as `serach`) or an
 * option name. Anything else — a key pasted where a command belongs, a reference
 * number, a URL — is shown as its first three characters only.
 */
function echoable(token: string): boolean {
  return token.length <= 6 || /^[a-z][a-z-]{0,19}$/.test(token) || /^--?[A-Za-z][A-Za-z0-9-]*$/.test(token);
}

/**
 * The shown form of a token that is not `echoable`: a URL without its userinfo
 * (`redactUrl`), anything else as three visible characters and "…".
 */
function maskToken(token: string): string {
  if (token.includes("://")) return sanitizeServerText(redactUrl(token));
  return `${token.slice(0, 3).replace(/[^\x21-\x7e]/g, "?")}…`;
}

/**
 * A function that masks the argv tokens commander's usage errors would echo: the
 * value of a secret flag (`--api-key`, both forms) becomes `***`, and every other
 * token, or `--opt=value` value, that is not `echoable` becomes `abc…` (a URL:
 * itself without userinfo). Applied to
 * commander's error text only; help and the CLI's own messages are not touched.
 */
export function usageErrorMask(argv: readonly string[]): (text: string) => string {
  const secrets = new Set<string>();
  const others = new Set<string>();
  argv.forEach((token, i) => {
    if (SECRET_FLAGS.includes(token) && argv[i + 1] !== undefined) secrets.add(argv[i + 1] as string);
    const eq = token.indexOf("=");
    if (token.startsWith("-") && eq > 0) {
      const value = token.slice(eq + 1);
      if (SECRET_FLAGS.includes(token.slice(0, eq))) secrets.add(value);
      else if (!echoable(value)) others.add(value);
    } else if (!echoable(token)) {
      others.add(token);
    }
  });
  for (const secret of secrets) others.delete(secret);
  const replacements = [
    ...[...secrets].filter((s) => s !== "").map((s): [string, string] => [s, "***"]),
    ...[...others].map((s): [string, string] => [s, maskToken(s)]),
  ].sort((a, b) => b[0].length - a[0].length);
  if (replacements.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const [from, to] of replacements) out = out.split(from).join(to);
    return out;
  };
}

/**
 * `deps` with an `io` that keeps the secrets of this run out of everything it
 * prints. Commander echoes rejected values in its usage errors, and a library
 * message may name a URL, so whatever path a secret takes to the terminal it is
 * replaced:
 *
 * - the userinfo of every URL-like argument, `--opt=value` value and of the key
 *   variable (as `credentialsIn` finds it, parseable or not) becomes `***@`, on
 *   stdout and stderr;
 * - the value of `--api-key` (both forms) and the `JOBSUCHE_API_KEY` value become
 *   `***` on stderr. Not on stdout: `obtain-key` prints the key there, and it may
 *   well be the one already in `JOBSUCHE_API_KEY`.
 *
 * A pattern alone can't delimit a password with spaces, quotes, `#`, `?` or `/`; the
 * exact strings can. Without secrets the output passes through unchanged.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const env = deps.env ?? process.env;
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const envKey = env[API_KEY_ENV_VAR] ?? "";
  const userinfo = new Set<string>();
  const encodedUserinfo = new Set<string>();
  const keys = new Set<string>();
  for (const source of [...argv, ...values, envKey]) {
    for (const secret of credentialsIn(source)) {
      userinfo.add(secret);
      userinfo.add(JSON.stringify(secret).slice(1, -1));
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) encodedUserinfo.add(encoded);
    }
  }
  const addKey = (value: string | undefined): void => {
    if (value === undefined) return;
    for (const form of [value, value.trim()]) {
      keys.add(form);
      keys.add(JSON.stringify(form).slice(1, -1));
    }
  };
  addKey(envKey);
  argv.forEach((token, i) => {
    if (SECRET_FLAGS.includes(token)) addKey(argv[i + 1]);
    const eq = token.indexOf("=");
    if (eq > 0 && SECRET_FLAGS.includes(token.slice(0, eq))) addKey(token.slice(eq + 1));
  });
  if (userinfo.size === 0 && [...keys].every((k) => k.trim().length < 4)) return deps;
  const urlList = [...userinfo];
  // Longest first, so a key is never left half-replaced by one of its own substrings.
  const keyList = [...keys].sort((a, b) => b.length - a.length);
  const encodedList = [...encodedUserinfo];
  const redactOut = (text: string): string => redactSecrets(redactCredentials(text, urlList), encodedList);
  const redactErr = (text: string): string => redactSecrets(redactOut(text), keyList);
  return {
    ...deps,
    io: { ...deps.io, out: (text) => deps.io.out(redactOut(text)), err: (text) => deps.io.err(redactErr(text)) },
  };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
  const program = buildProgram(deps);
  configureTree(program, deps, usageErrorMask(argv));

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // An explicit --help / --version request is a success.
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
        return 0;
      }
      // The `help` / `help <cmd>` subcommand also throws "commander.help", but with
      // exitCode 0; only help shown for a missing command carries exitCode 1.
      if (err.exitCode === 0) return 0;
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
    if (err instanceof JobsucheValidationError) {
      // An input the library rejected before any request (a search parameter or a
      // client option): the same usage-error exit code as a rejected flag value.
      deps.io.err(`Error: ${err.message}`);
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
        // The rest.arbeitsagentur.de gateway answers a wrong or missing key with
        // the same detail-less 403 (text/plain, one-space body) that it uses when
        // it refuses the caller's network, and now and then for a valid key too,
        // so the response can't tell them apart. Say whether a key was sent.
        if (err.status === 403 && !err.detail) {
          const sentKey = toEngineOptions(program.opts() as GlobalOptions, deps.env ?? process.env).apiKey !== undefined;
          deps.io.err(
            sentKey
              ? "Hint: an empty 403 looks the same for a wrong key, a refused network and a " +
                  "passing refusal the gateway sometimes sends for a valid key. Check the key " +
                  "against `jobsuche obtain-key`; if it matches, retry once, then try from " +
                  "another network."
              : "Hint: no X-API-Key was sent. Pass --api-key or set JOBSUCHE_API_KEY " +
                  "(`jobsuche obtain-key` prints the published key).",
          );
        }
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
      // JSON.parse's message quotes the body (server-controlled), so strip
      // control characters before it reaches the terminal.
      const cause = err.cause instanceof Error ? err.cause.message : err.cause;
      const causePart = cause ? ` (${sanitizeServerText(String(cause))})` : "";
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
