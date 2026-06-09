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

/**
 * commander value-parser for a free-text option. Rejects a value that looks like
 * another option flag (e.g. `--was --wo`): without this, commander silently
 * consumes the following flag as the value and the real error never mentions the
 * starved option. Use `--` to pass a literal value that begins with `--`.
 */
export function parseTextArg(value: string): string {
  if (/^--?[^\s]/.test(value)) {
    throw new InvalidArgumentError(
      `looks like a missing value (received "${value}"). ` +
        `Use -- before a value that starts with a dash.`,
    );
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
 * scripts/fetch-api-key.mjs. A blank/whitespace `--api-key` is ignored (mirrors
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

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
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
