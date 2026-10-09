import { InvalidArgumentError, type Command } from "commander";
import { logOf, type CliDeps } from "../io.js";
import { action, onceOnly, parseBoundedInt, parseIntArg, parseNonBlank, parseTextArg, renderJson } from "../shared.js";
import type { JobSearchParams } from "../../client/types.js";
import { woNote } from "../../client/client.js";
import {
  MAX_UMKREIS,
  MAX_VEROEFFENTLICHT_SEIT,
  angebotsartProblem,
  type Angebotsart,
} from "../../client/validate.js";

/** --angebotsart: an integer that is one of the library's ANGEBOTSART_CODES. */
function parseAngebotsart(value: string): Angebotsart {
  const n = parseIntArg(value);
  const reason = angebotsartProblem(n);
  if (reason !== undefined) {
    // The library's reason, worded with the flag name.
    throw new InvalidArgumentError(reason.replace(/^Unknown code/, "Unknown --angebotsart code"));
  }
  return n as Angebotsart;
}

export function registerJobCommands(program: Command, deps: CliDeps): void {
  // Every search option takes one value: a repeated one is a usage error (commander
  // would keep the last silently, e.g. `--wo Berlin --wo Hamburg` searched Hamburg).
  const seen = new Set<string>();
  const once = <T>(flag: string, parse: (value: string) => T): ((value: string) => T) => onceOnly(seen, flag, parse);
  const search = program
    .command("search")
    .description("Search job listings")
    .option("--was <text>", "job title / keyword (was)", once("--was", parseTextArg))
    .option("--wo <text>", "location (wo)", once("--wo", parseTextArg))
    .option("--berufsfeld <text>", "occupational field", once("--berufsfeld", parseTextArg))
    .option("--arbeitgeber <text>", "employer name, exact and case-sensitive (e.g. \"Siemens AG\")", once("--arbeitgeber", parseTextArg))
    .option(
      "--umkreis <km>",
      `radius in km around the location (0-${MAX_UMKREIS})`,
      once("--umkreis", parseBoundedInt(0, MAX_UMKREIS)),
    )
    // The API accepts 0..100 days and silently ignores a larger value (the whole
    // unfiltered set comes back), so the library rejects it, and so does this parser.
    .option(
      "--veroeffentlicht-seit <days>",
      `published within the last N days (0-${MAX_VEROEFFENTLICHT_SEIT})`,
      once("--veroeffentlicht-seit", parseBoundedInt(0, MAX_VEROEFFENTLICHT_SEIT)),
    )
    // The API's zeitarbeit parameter is a three-way switch: absent = temp-work
    // (Zeitarbeit) listings mixed in with the rest, true = only those, false =
    // none (checked live 2026-09-26: true + false = absent). Both flags are
    // declared, so neither is set by default; giving both is a usage error.
    .option("--zeitarbeit", "only temp-work agency listings (default: included with the rest)")
    .option("--no-zeitarbeit", "leave out temp-work agency listings")
    .option(
      "--angebotsart <code>",
      "offer type code: 1 job, 2 self-employment, 4 apprenticeship/dual study, 34 internship/trainee",
      once("--angebotsart", parseAngebotsart),
    )
    .option("--page <n>", "1-based page (1 or more)", once("--page", parseBoundedInt(1, Number.MAX_SAFE_INTEGER)))
    .option("--size <n>", "page size", once("--size", parseIntArg));
  // commander keeps the last of --zeitarbeit / --no-zeitarbeit silently; they ask for
  // opposite things, so both together is a usage error.
  const zeitarbeit = new Set<string>();
  for (const flag of ["zeitarbeit", "no-zeitarbeit"]) {
    search.on(`option:${flag}`, () => {
      zeitarbeit.add(flag);
      if (zeitarbeit.size === 2) {
        search.error("error: --zeitarbeit and --no-zeitarbeit ask for opposite things; give one of them.", {
          exitCode: 2,
          code: "commander.conflictingOption",
        });
      }
    });
  }
  search
    .action(
      action(deps, async ({ client, global, opts }) => {
        const params: JobSearchParams = {
          was: opts["was"] as string | undefined,
          wo: opts["wo"] as string | undefined,
          berufsfeld: opts["berufsfeld"] as string | undefined,
          arbeitgeber: opts["arbeitgeber"] as string | undefined,
          umkreis: opts["umkreis"] as number | undefined,
          veroeffentlichtseit: opts["veroeffentlichtSeit"] as number | undefined,
          zeitarbeit: opts["zeitarbeit"] as boolean | undefined,
          angebotsart: opts["angebotsart"] as Angebotsart | undefined,
          page: opts["page"] as number | undefined,
          size: opts["size"] as number | undefined,
        };
        const result = await client.search(params);
        renderJson(deps, global, result);
        // The API answers an unknown or garbled --wo with exit-0 data about another
        // town, or with nothing; say so (stderr, exit code unchanged).
        const note = woNote(params.wo, result);
        if (note !== undefined) logOf(deps).warn("api", note);
      }),
    );

  program
    .command("details")
    .description("Full job details by reference number (refnr) or encoded code")
    // A blank reference (often an unset shell variable) is a usage error here,
    // before the client's own check would make it a runtime error (exit 1).
    .argument("<refnrOrCode>", "reference number (referenznummer) or encoded code", parseNonBlank)
    .action(
      action(deps, async ({ client, global }, [ref]) => {
        renderJson(deps, global, await client.details(ref!));
      }),
    );
}
