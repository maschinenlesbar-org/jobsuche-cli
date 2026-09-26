import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { API_KEY_ENV_VAR, KEY_SOURCE_URL, obtainKey, shellQuoteSingle } from "../../client/obtain-key.js";
import type { GlobalOptions } from "../shared.js";

/**
 * `obtain-key` — fetch the public X-API-Key and print it.
 *
 * Deliberately does NOT build a client: it must work before a key exists, which
 * is the whole point. stdout carries only the key (so `$(...)` composes), while
 * the provenance note goes to stderr.
 */
export function registerObtainKeyCommands(program: Command, deps: CliDeps): void {
  program
    .command("obtain-key")
    .description(
      "Obtain the public X-API-Key this API requires and print it. The key is " +
        "published by the Bundesagentur für Arbeit and is not a secret; none is " +
        "bundled with this package, so it is read from the source at run time.",
    )
    .option("--export", `print "export ${API_KEY_ENV_VAR}=<key>" for use with eval`)
    .action(async (...args: unknown[]) => {
      const command = args[args.length - 1] as Command;
      const global = command.optsWithGlobals() as GlobalOptions;
      const { key, sourceUrl } = await obtainKey({
        ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
        ...(global.timeout !== undefined ? { timeoutMs: global.timeout } : {}),
        ...(global.maxResponseBytes !== undefined ? { maxResponseBytes: global.maxResponseBytes } : {}),
        ...(global.userAgent !== undefined ? { userAgent: global.userAgent } : {}),
      });
      deps.io.err(`Obtained the public key from ${sourceUrl}`);
      deps.io.out(
        command.opts()["export"] ? `export ${API_KEY_ENV_VAR}=${shellQuoteSingle(key)}` : key,
      );
    });
}

export { KEY_SOURCE_URL };
