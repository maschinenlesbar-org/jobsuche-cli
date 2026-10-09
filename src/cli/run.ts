// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { DEFAULT_LOG_FORMAT, createLogger, logFormatFromArgv, type LogFormat, type Logger } from "./log.js";
import type { GlobalOptions } from "./shared.js";
import { sanitizeServerText } from "../client/engine.js";
import {
  JobsucheApiError,
  JobsucheError,
  JobsucheNetworkError,
  JobsucheParseError,
  JobsucheValidationError,
  credentialsIn,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
  redactUrl,
} from "../client/errors.js";
import { API_KEY_ENV_VAR } from "../client/obtain-key.js";
import { CredentialsError } from "./credentials.js";

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(
  command: Command,
  deps: CliDeps,
  mask: (text: string) => string,
  state: { errorLogged: boolean } = { errorLogged: false },
): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => writeCommanderErr(command, deps, state, str),
    // Commander's own errors echo what was typed: an unknown command, surplus
    // arguments, an unknown option, a rejected option value. Mask what may be a secret.
    outputError: (str, write) => write(mask(str)),
  });
  for (const child of command.commands) configureTree(child, deps, mask, state);
}

/** `jobsuche config`: the command's name with its parents'. */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c !== null; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

/**
 * commander's stderr output as log records, one per line. Its `error: …` is an ERROR of
 * `cli`, with a following `(Did you mean …?)` line appended to that same record; the
 * help it shows after an error is one INFO record per non-blank line. The program or a
 * command group run without its subcommand makes commander show the help as an error
 * (exit 1, so 2 here) with no `error:` line: an ERROR record "missing command:
 * `jobsuche config <subcommand>`" comes first, so every failed run has one.
 */
function writeCommanderErr(command: Command, deps: CliDeps, state: { errorLogged: boolean }, str: string): void {
  const log = logOf(deps);
  const text = str.replace(/\n$/, "");
  // The blank line commander writes between an error and the help it shows after.
  if (text.trim() === "") return;
  if (text.startsWith("error: ")) {
    state.errorLogged = true;
    log.error("cli", text.slice("error: ".length).replace(/\n(\(Did you mean .*\?\))$/, " $1"));
    return;
  }
  if (!state.errorLogged) {
    state.errorLogged = true;
    log.error("cli", `missing command: \`${commandPath(command)} <subcommand>\``);
  }
  for (const line of text.split("\n")) if (line.trim() !== "") log.info("cli", line.trimEnd());
}

/** The names (long and short) of every option in the tree that requires a value. */
function valueOptionsOf(command: Command, names: Set<string> = new Set()): Set<string> {
  for (const option of command.options) {
    if (!option.required) continue;
    if (option.long !== undefined) names.add(option.long);
    if (option.short !== undefined) names.add(option.short);
  }
  for (const child of command.commands) valueOptionsOf(child, names);
  return names;
}

/** The options whose value is a secret on its own (no `@` to anchor a redaction on). */
const SECRET_FLAGS = ["--api-key"];

/**
 * The options whose value is the base URL: a `user:password@host` given there without
 * its scheme is still a credential (anywhere else a bare `a:b@c` is not).
 */
const BASE_URL_FLAGS = ["--base-url"];

/** The values of the `flags` in `argv`, in both forms (`--flag value`, `--flag=value`). */
function flagValues(argv: readonly string[], flags: readonly string[]): string[] {
  const found: string[] = [];
  argv.forEach((token, i) => {
    const next = argv[i + 1];
    if (flags.includes(token) && next !== undefined) found.push(next);
    const eq = token.indexOf("=");
    if (eq > 0 && flags.includes(token.slice(0, eq))) found.push(token.slice(eq + 1));
  });
  return found;
}

/**
 * The options whose rejected value commander's usage error shows as typed: a format
 * name, never the place a key is typed into by mistake. The record escapes it.
 */
const SHOWN_FLAGS = ["--log-format"];

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
 * itself without userinfo), except the value of `--log-format` (`SHOWN_FLAGS`). Applied to
 * commander's error text only; help and the CLI's own messages are not touched.
 */
export function usageErrorMask(argv: readonly string[]): (text: string) => string {
  const secrets = new Set<string>();
  const shown = new Set<string>();
  const others = new Set<string>();
  argv.forEach((token, i) => {
    if (SECRET_FLAGS.includes(token) && argv[i + 1] !== undefined) secrets.add(argv[i + 1] as string);
    if (SHOWN_FLAGS.includes(token) && argv[i + 1] !== undefined) shown.add(argv[i + 1] as string);
    const eq = token.indexOf("=");
    if (token.startsWith("-") && eq > 0) {
      const value = token.slice(eq + 1);
      if (SECRET_FLAGS.includes(token.slice(0, eq))) secrets.add(value);
      else if (SHOWN_FLAGS.includes(token.slice(0, eq))) shown.add(value);
      else if (!echoable(value)) others.add(value);
    } else if (!echoable(token)) {
      others.add(token);
    }
  });
  for (const value of shown) others.delete(value);
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

/** The secrets of a run, and the two ways they are replaced. */
export interface Redaction {
  /** stdout text: the userinfo of every URL-like argument replaced (`***@`). */
  out(text: string): string;
  /** stderr text, a record's message: that, and every secret value replaced (`***`). */
  err(text: string): string;
  /**
   * Make `value` a secret of the run from now on (on stderr), like a flag or env value:
   * for a secret the run learns after argv, such as the key read from the credentials file.
   */
  addSecret(value: string): void;
}

/**
 * The secrets of the run in `argv` and `env`. Commander echoes rejected values in its
 * usage errors, and a library message may name a URL, so whatever path a secret takes
 * to the terminal it is replaced:
 *
 * - the userinfo of every URL argument, `--opt=value` value and of the key variable
 *   (as `credentialsIn` finds it, parseable or not; only a value that starts with a
 *   scheme counts, except as the `--base-url` value) becomes `***@`, on
 *   stdout and stderr, and so do the forms a server echoes it back in: the `Basic`
 *   value and the decoded `user:password` (`echoedCredentialForms`) become `***`, the
 *   password alone (4 characters or more) on stderr only, as it may occur in the data;
 * - the value of `--api-key` (both forms) and the `JOBSUCHE_API_KEY` value become
 *   `***` on stderr. Not on stdout: `obtain-key` prints the key there, and it may
 *   well be the one already in `JOBSUCHE_API_KEY`.
 *
 * A pattern alone can't delimit a password with spaces, quotes, `#`, `?` or `/`; the
 * exact strings can. Without secrets the text passes through unchanged.
 */
export function redactionFor(argv: readonly string[], env: Record<string, string | undefined>): Redaction {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const envKey = env[API_KEY_ENV_VAR] ?? "";
  const userinfo = new Set<string>();
  const encodedUserinfo = new Set<string>();
  const passwords = new Set<string>();
  const keys = new Set<string>();
  // A base URL typed without its scheme is read as if it had one.
  const baseUrls = flagValues(argv, BASE_URL_FLAGS).map((value) => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`));
  for (const source of [...values, envKey, ...baseUrls]) {
    for (const secret of credentialsIn(source)) {
      userinfo.add(secret);
      userinfo.add(JSON.stringify(secret).slice(1, -1));
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) encodedUserinfo.add(encoded);
      // What a server echoes back: the Basic value and the decoded user:password on
      // stdout and stderr, the password alone (it may well occur in the data) on stderr.
      const [basic, pair, password] = echoedCredentialForms(secret);
      if (basic !== undefined) encodedUserinfo.add(basic);
      if (pair !== undefined) for (const form of [pair, JSON.stringify(pair).slice(1, -1)]) encodedUserinfo.add(form);
      if (password !== undefined) passwords.add(password);
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
  for (const password of passwords) addKey(password);
  for (const value of flagValues(argv, SECRET_FLAGS)) addKey(value);
  const urlList = [...userinfo];
  // Longest first, so a key is never left half-replaced by one of its own substrings.
  const sortedKeys = (): string[] => [...keys].sort((a, b) => b.length - a.length);
  let keyList = sortedKeys();
  // Longest first too: a pair is replaced before a shorter form inside it.
  const encodedList = [...encodedUserinfo].sort((a, b) => b.length - a.length);
  const out = (text: string): string => redactSecrets(redactCredentials(text, urlList), encodedList);
  return {
    out,
    err: (text) => redactSecrets(out(text), keyList),
    addSecret: (value) => {
      addKey(value);
      keyList = sortedKeys();
    },
  };
}

/**
 * `deps` that keep the secrets of this run (`redactionFor`) out of everything they
 * print: `io.out` is redacted, and the log (`deps.log`) replaces them in each record's
 * message before formatting it, then writes to the raw `io.err`, so the frame is never
 * touched. `io.err` itself is redacted too, for anything that writes to stderr without
 * the log.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const redaction = redactionFor(argv, deps.env ?? process.env);
  const { out, err } = deps.io;
  return {
    ...deps,
    io: { ...deps.io, out: (text) => out(redaction.out(text)), outRaw: deps.io.outRaw ?? out, err: (text) => err(redaction.err(text)) },
    addSecret: redaction.addSecret,
    log: createLogger({
      format: logFormatFromArgv(argv),
      write: err,
      redact: redaction.err,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  };
}

/**
 * Where the key this run sent came from, as the 401/403 hint names it, or undefined
 * when none was sent. The precedence is `toEngineOptions`'s and `action()`'s: a
 * non-blank `--api-key`, then a non-blank `JOBSUCHE_API_KEY`, then the credentials file
 * (`deps.storedKeyPath`, set only when its key was used).
 */
function keySource(program: Command, deps: CliDeps): string | undefined {
  if (deps.storedKeyPath !== undefined) {
    return (
      `the API key stored in ${deps.storedKeyPath}: \`jobsuche obtain-key | jobsuche config set api-key\` ` +
      `stores the current one (--api-key and ${API_KEY_ENV_VAR} take precedence over the file)`
    );
  }
  if ((program.opts() as GlobalOptions).apiKey?.trim()) return "the key from --api-key";
  if ((deps.env ?? process.env)[API_KEY_ENV_VAR]?.trim()) return `the key from the ${API_KEY_ENV_VAR} environment variable`;
  return undefined;
}

/**
 * The log for what happens outside `run()`, in the bin shim: a stdout write error
 * (`handleOutputErrors`) and Node's process warnings. Its format is the one argv asks
 * for (`logFormatFromArgv`), and it replaces the secrets of argv and `env` like the
 * run's own log; it writes to the raw stderr.
 */
export function processLogger(argv: readonly string[], env: Record<string, string | undefined> = process.env): Logger {
  return createLogger({
    format: logFormatFromArgv(argv),
    write: (line) => process.stderr.write(line + "\n"),
    redact: redactionFor(argv, env).err,
  });
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  // The log replaces the secrets of the run in every message, in either format.
  deps = withRedactedOutput(deps, argv);
  const program = buildProgram(deps);
  configureTree(program, deps, usageErrorMask(argv));
  // For the records of a parse error: the scan of argv, now knowing which options take
  // a value, as commander reads them.
  const log = deps.log;
  if (log !== undefined) log.format = logFormatFromArgv(argv, valueOptionsOf(program));
  // One source for the format once commander has parsed argv: its value, not the scan
  // of argv (an option's value can look like --log-format; `--` ends the scan, not
  // commander's parse of a value). Ancestors' hooks run first, so this precedes every
  // other preAction check.
  program.hook("preAction", (_program, actionCommand) => {
    const format = (actionCommand.optsWithGlobals() as { logFormat?: LogFormat }).logFormat;
    if (log !== undefined) log.format = format ?? DEFAULT_LOG_FORMAT;
  });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    const log = logOf(deps);
    if (err instanceof CommanderError) {
      // An explicit --help / --version request is a success.
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
        return 0;
      }
      // The `help` / `help <cmd>` subcommand also throws "commander.help", but with
      // exitCode 0; only help shown for a missing command carries exitCode 1.
      if (err.exitCode === 0) return 0;
      // Invoked with no command at all, or a group without its subcommand: commander has
      // already shown the help, after the "missing command" ERROR (writeCommanderErr).
      // A usage error, so scripts get a distinct, documented exit code (2) rather than a
      // bare, message-less 1.
      if (err.code === "commander.help") return 2;
      // Genuine parse / usage errors (unknown option, bad value, missing
      // argument, ...) get a dedicated exit code (2) so a wrapper script can
      // tell a bad invocation from a runtime/network failure (which exit 1).
      return 2;
    }
    if (err instanceof JobsucheValidationError) {
      // An input the library rejected before any request (a search parameter or a
      // client option): the same usage-error exit code as a rejected flag value.
      log.error("cli", err.message);
      return 2;
    }
    if (err instanceof JobsucheApiError) {
      // Map a few notable statuses to distinct exit codes for scripting.
      if (err.status === 401 || err.status === 403) {
        // A redirect to another origin (an http: base URL answered with https: is the
        // usual case) dropped the key: the message says so and what to do, and the
        // key itself is fine, so no key hint.
        if (err.credentialsDropped !== undefined) {
          log.error("api", `request rejected (HTTP ${err.status}): ${err.message.replace(/^HTTP \d+ for \S+ \S+: /, "")}.`);
          return 3;
        }
        // 401/403 is usually a key problem, but a resource-level forbidden or a
        // quota/rate reason can also land here. Surface the server-supplied
        // `detail` when present instead of unconditionally blaming the key, and
        // always append the actionable key hint.
        const reason = err.detail ? `: ${err.detail}` : "";
        // Name where the key that was sent came from, so the user checks that one and not
        // one of three candidates; without a key, every way to supply one.
        const source = keySource(program, deps);
        log.error(
          "api",
          `request rejected (HTTP ${err.status})${reason}. If this is an auth problem, check ` +
            (source !== undefined
              ? `${source}.`
              : `--api-key, the ${API_KEY_ENV_VAR} environment variable or the key stored with ` +
                "`jobsuche config set api-key`."),
        );
        // The rest.arbeitsagentur.de gateway answers a wrong or missing key with
        // the same detail-less 403 (text/plain, one-space body) that it uses when
        // it refuses the caller's network, and now and then for a valid key too,
        // so the response can't tell them apart. Say whether a key was sent.
        if (err.status === 403 && !err.detail) {
          log.info(
            "api",
            source !== undefined
              ? "an empty 403 looks the same for a wrong key, a refused network and a " +
                  "passing refusal the gateway sometimes sends for a valid key. Check the key " +
                  "against `jobsuche obtain-key`; if it matches, retry once, then try from " +
                  "another network."
              : "no X-API-Key was sent. Pass --api-key, set JOBSUCHE_API_KEY or store it " +
                  "with `jobsuche config set api-key` (`jobsuche obtain-key` prints the published key).",
          );
        }
        return 3;
      }
      log.error("api", err.message);
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof JobsucheNetworkError) {
      // Transport-level failure (DNS, refused connection, timeout, body cap).
      // Frame it as a connectivity problem rather than a bare libuv string.
      log.error("http", `could not reach the API (${err.message}).`);
      return 1;
    }
    if (err instanceof JobsucheParseError) {
      // Include the underlying parser cause / offending detail so the user can
      // see what actually came back instead of an opaque "Failed to parse".
      // JSON.parse's message quotes the body (server-controlled), so strip
      // control characters before it reaches the terminal.
      const cause = err.cause instanceof Error ? err.cause.message : err.cause;
      const causePart = cause ? ` (${sanitizeServerText(String(cause))})` : "";
      // A malformed answer (bad JSON, the wrong shape or content type, an unknown
      // charset) is the API's answer as much as an error status is.
      log.error("api", `${err.message}${causePart}`);
      return 1;
    }
    if (err instanceof JobsucheError) {
      // The credentials file and the config commands have an area of their own.
      log.error(err instanceof CredentialsError ? "config" : "cli", err.message);
      return 1;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
