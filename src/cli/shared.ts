// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the two result-rendering paths (JSON and raw download).

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { JobsucheClientOptions } from "../client/client.js";

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

/** Build a commander value-parser for a non-negative integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
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
 * too: the client drops it, so the search would silently run unfiltered.
 */
export function parseTextArg(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Must not be blank.");
  }
  if (/^--?[^\s]/.test(value)) {
    throw new InvalidArgumentError(
      `looks like a missing value — "${value}" is the next option, consumed because ` +
        "this one was left without a value. Supply the intended search term.",
    );
  }
  return value;
}

/**
 * Why a value cannot be sent in an HTTP header — a C0 control other than tab, DEL,
 * or a character above U+00FF (what Node's header validation refuses) — or
 * undefined when it can.
 */
function headerProblem(value: string): string | undefined {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
}

/**
 * commander value-parser for a header value (`--user-agent`): not blank, and
 * sendable — no control characters (tab is fine), nothing above U+00FF. Without
 * this, Node's "Invalid character in header content" surfaced as an
 * "Unexpected error" (exit 1) at request time.
 */
export function parseHeaderValue(value: string): string {
  if (value.trim() === "") throw new InvalidArgumentError("Must not be blank.");
  const problem = headerProblem(value);
  if (problem) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * commander value-parser for `--api-key`: a blank value stays allowed (it is
 * ignored and JOBSUCHE_API_KEY is used, as documented), anything else must be
 * sendable as a header.
 */
export function parseApiKey(value: string): string {
  const problem = value.trim() === "" ? undefined : headerProblem(value);
  if (problem) throw new InvalidArgumentError(problem);
  return value;
}

/** commander value-parser for a required id: rejects "" and whitespace only. */
export function parseNonBlank(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Must not be blank.");
  }
  return value;
}

/**
 * commander value-parser for `--base-url`. Rejects a malformed URL or an
 * unsupported protocol up front (as a usage error) instead of letting it fail
 * late inside the transport with a generic runtime error.
 */
export function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError(`Invalid URL: "${value}".`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgumentError(`Unsupported protocol "${url.protocol}" (use http: or https:).`);
  }
  // The API path is appended to the base URL as a string, so a query would end up
  // in front of it and a fragment would swallow the path and every filter.
  if (/[?#]/.test(value)) {
    throw new InvalidArgumentError("A base URL cannot have a query (?) or fragment (#).");
  }
  return value;
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
 * `env` (defaulting to `process.env`) supplies the `JOBSUCHE_API_KEY` fallback.
 * Precedence: an explicit, non-empty `--api-key` (in `global.apiKey`) wins;
 * otherwise a non-empty (trimmed) `JOBSUCHE_API_KEY` seeds the key; otherwise
 * no key is set and the `X-API-Key` header is omitted (the API then answers
 * 401/403). No key is bundled — obtain the public one via
 * the `obtain-key` command. A blank/whitespace `--api-key` is ignored (mirrors
 * the env path) rather than forwarded as an empty header.
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

  const flagKey = global.apiKey?.trim();
  if (flagKey) {
    options.apiKey = flagKey;
  } else {
    const envKey = env["JOBSUCHE_API_KEY"]?.trim();
    if (envKey) options.apiKey = envKey;
  }
  return options;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  deps.io.out(text);
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
    const client = deps.createClient(toEngineOptions(global, deps.env ?? process.env));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
