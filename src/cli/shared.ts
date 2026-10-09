// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the two result-rendering paths (JSON and raw download).

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import type { JobsucheClientOptions } from "../client/client.js";
import { JobsucheError, JobsucheValidationError } from "../client/errors.js";
import { API_KEY_ENV_VAR } from "../client/obtain-key.js";
import { API_KEY_PHRASE, DEFAULT_BASE_URL, cleartextProblem, isBidiControl } from "../client/engine.js";
import { baseUrlProblem, headerValueProblem, intRangeProblem, nonBlankProblem } from "../client/validate.js";

/** The name the API key is stored under in the credentials file (`jobsuche config set api-key`). */
export const API_KEY_CREDENTIAL = "api-key";

/**
 * The API key kept in the credentials file (`jobsuche config set api-key`), or
 * undefined when none is stored or `deps` carry no credentials file. Reading it may
 * throw a JobsucheError (a file others can read, a link, invalid JSON), so it is read
 * only when neither `--api-key` nor `JOBSUCHE_API_KEY` gave a key.
 */
export function storedApiKey(deps: CliDeps): string | undefined {
  return deps.credentials?.().get(API_KEY_CREDENTIAL);
}

/**
 * commander value-parser: a non-negative decimal integer.
 *
 * Only a plain run of ASCII digits is accepted. `Number()` would otherwise
 * silently accept (and transform) hex/binary/octal/scientific forms, a leading
 * `+`, surrounding whitespace and the empty string, sending the API a value
 * different from what the user typed. The result must also be a safe integer so
 * very large inputs cannot lose precision.
 */
export function parseIntArg(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Integer is too large.");
  }
  return n;
}

/**
 * Build a commander value-parser for a non-negative integer constrained to
 * [min, max] (the library's intRangeProblem).
 */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  const problem = intRangeProblem(min, max);
  return (value: string) => {
    const n = parseIntArg(value);
    const reason = problem(n);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
    return n;
  };
}

/**
 * commander value-parser for a free-text option. Rejects a value that looks like
 * another option flag (e.g. `--was --wo`): without this, commander silently
 * consumes the following flag as the value and the real error never mentions the
 * starved option.
 *
 * Every dash-leading value is refused, with no escape hatch. commander hands this
 * parser the same string for `--was -x` and `--was=-x`, so the two cannot be told
 * apart here, and `--was -- -x` merely makes the value `--`. (A `--` *does* work
 * for a positional argument, which is a different case — see lobbyregister-cli's
 * `search` query.) No job title, place, occupational field or employer name is
 * searched with a leading dash, so nothing legitimate is lost.
 *
 * A blank value ("" or whitespace, often an unset shell variable) is rejected
 * too, by the library's nonBlankProblem (the client rejects it the same way).
 */
export function parseTextArg(value: string): string {
  const blank = nonBlankProblem(value);
  if (blank !== undefined) throw new InvalidArgumentError(blank);
  if (/^--?[^\s]/.test(value)) {
    throw new InvalidArgumentError(
      `looks like a missing value — "${value}" is the next option, consumed because ` +
        "this one was left without a value. Supply the intended search term.",
    );
  }
  return value;
}

/**
 * commander value-parser for a header value (`--user-agent`): the library's
 * headerValueProblem — not blank, and sendable (no control characters but tab,
 * nothing above U+00FF). The client rejects the same values.
 */
export function parseHeaderValue(value: string): string {
  const problem = headerValueProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * commander value-parser for `--api-key`: a blank value stays allowed (it is
 * ignored and JOBSUCHE_API_KEY is used, as documented), anything else must be
 * sendable as a header once trimmed — the client trims the key, so a trailing
 * newline is accepted here as it is from the env var.
 */
export function parseApiKey(value: string): string {
  const key = value.trim();
  const problem = key === "" ? undefined : headerValueProblem(key);
  if (problem) throw new InvalidArgumentError(problem);
  return value;
}

/** commander value-parser for a required id: rejects "" and whitespace only (nonBlankProblem). */
export function parseNonBlank(value: string): string {
  const blank = nonBlankProblem(value);
  if (blank !== undefined) throw new InvalidArgumentError(blank);
  return value;
}

/**
 * commander value-parser for `--base-url`: the library's baseUrlProblem (an
 * absolute http(s) URL, no surrounding whitespace, control characters, query or
 * fragment), so a bad value is a usage error at parse time. The client applies
 * the same rule.
 */
export function parseBaseUrl(value: string): string {
  const problem = baseUrlProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * Wrap a commander value-parser so the option may be given only once per run:
 * commander keeps the last of a repeated option silently (`--wo Berlin --wo
 * Hamburg` searched Hamburg), and every option of this CLI takes one value. `seen`
 * is the per-program set of flags already parsed.
 */
export function onceOnly<T>(seen: Set<string>, flag: string, parse: (value: string) => T): (value: string) => T {
  return (value: string) => {
    if (seen.has(flag)) {
      throw new InvalidArgumentError(`${flag} is given more than once; it takes one value, so give it once.`);
    }
    seen.add(flag);
    return parse(value);
  };
}

export interface GlobalOptions {
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/**
 * Translate resolved global CLI options into client options.
 *
 * `env` (defaulting to `process.env`) supplies the `JOBSUCHE_API_KEY` fallback; a
 * value there that cannot be sent is a JobsucheValidationError naming the variable.
 * Precedence: a non-blank `--api-key` (in `global.apiKey`) wins; otherwise a
 * non-blank `JOBSUCHE_API_KEY` seeds the key; otherwise no key is set here — `action()`
 * then reads the credentials file (`jobsuche config set api-key`) — and without one
 * there either the `X-API-Key` header is omitted (the API then answers 401/403). No key is
 * bundled — obtain the public one via the `obtain-key` command. A blank/whitespace
 * `--api-key` is ignored (mirrors the env path) rather than forwarded. Only the
 * precedence is resolved here: the key is passed as given, and the client trims
 * and checks it.
 */
export function toEngineOptions(
  global: GlobalOptions,
  env: Record<string, string | undefined> = process.env,
): JobsucheClientOptions {
  const options: JobsucheClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;

  const flagKey = global.apiKey;
  const envKey = env["JOBSUCHE_API_KEY"];
  if (flagKey?.trim()) {
    options.apiKey = flagKey;
  } else if (envKey?.trim()) {
    // The client would reject it as "Invalid apiKey"; name the variable the user set,
    // perhaps long ago in a profile. The reason never repeats the value.
    const problem = headerValueProblem(envKey.trim());
    if (problem !== undefined) throw new JobsucheValidationError(`Invalid ${API_KEY_ENV_VAR}: ${problem}`);
    options.apiKey = envKey;
  }
  return options;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. Bidi controls (U+202E RIGHT-TO-LEFT OVERRIDE …)
 * and U+2028/U+2029 are escaped too: they reorder or break the displayed text, so a
 * job title or employer name could spoof what the terminal shows. The output is
 * server data, so escape them; the result is equivalent, valid JSON (these
 * characters only occur inside strings). Checked by char code so the source stays
 * free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if ((c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || isBidiControl(c)) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, but a value nested too deeply for its recursion (V8 throws
 * RangeError "Maximum call stack size exceeded") becomes a JobsucheError with a
 * message the user can act on. JSON.parse is iterative, so such a body parses.
 */
export function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    throw new JobsucheError(
      compact
        ? "The response is nested too deeply to print."
        : "The response is nested too deeply to pretty-print; try --compact.",
    );
  }
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  deps.io.out(escapeControlChars(stringifyJson(value, global.compact === true)));
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const options = toEngineOptions(global, deps.env ?? process.env);
    // flag > JOBSUCHE_API_KEY > the credentials file (`jobsuche config set api-key`) >
    // none. The file is read only here, when no key came from the first two, so a
    // problem with it never stands in the way of a key given another way.
    if (options.apiKey === undefined) {
      const stored = storedApiKey(deps);
      if (stored !== undefined) options.apiKey = stored;
    }
    const client = deps.createClient(options);
    // Built first, so a key the client rejects is a usage error before any warning. One
    // warning per run, before the first request, when the base URL is plain http: to a host
    // other than loopback; help, version and usage errors never get here.
    const cleartext = cleartextProblem(
      options.baseUrl ?? DEFAULT_BASE_URL,
      options.apiKey !== undefined ? [API_KEY_PHRASE] : [],
    );
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
