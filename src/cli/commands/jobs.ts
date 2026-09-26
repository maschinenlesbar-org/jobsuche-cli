import { InvalidArgumentError, type Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, parseBoundedInt, parseIntArg, parseNonBlank, parseTextArg, renderJson } from "../shared.js";

/** The API's documented upper bound for veroeffentlichtseit (days). */
const MAX_VEROEFFENTLICHT_SEIT = 100;

/**
 * The documented angebotsart codes: 1 Arbeit, 2 Selbstständigkeit, 4 Ausbildung /
 * Duales Studium, 34 Praktikum / Trainee. Any other code returns an empty result
 * (live: angebotsart=3 → maxErgebnisse 0), which reads as "nothing there".
 */
const ANGEBOTSART_CODES = [1, 2, 4, 34];

function parseAngebotsart(value: string): number {
  const n = parseIntArg(value);
  if (!ANGEBOTSART_CODES.includes(n)) {
    throw new InvalidArgumentError(
      `Unknown --angebotsart code ${n}: valid codes are ${ANGEBOTSART_CODES.join(", ")} ` +
        "(1 job, 2 self-employment, 4 apprenticeship/dual study, 34 internship/trainee).",
    );
  }
  return n;
}
import type { JobSearchParams } from "../../client/types.js";

export function registerJobCommands(program: Command, deps: CliDeps): void {
  program
    .command("search")
    .description("Search job listings")
    .option("--was <text>", "job title / keyword (was)", parseTextArg)
    .option("--wo <text>", "location (wo)", parseTextArg)
    .option("--berufsfeld <text>", "occupational field", parseTextArg)
    .option("--arbeitgeber <text>", "employer name", parseTextArg)
    .option("--umkreis <km>", "radius in km around the location", parseIntArg)
    // The API accepts 0..100 days and silently ignores a larger value (the whole
    // unfiltered set comes back), so reject it here.
    .option(
      "--veroeffentlicht-seit <days>",
      "published within the last N days (0-100)",
      parseBoundedInt(0, MAX_VEROEFFENTLICHT_SEIT),
    )
    // The API's zeitarbeit parameter is a three-way switch: absent = temp-work
    // (Zeitarbeit) listings mixed in with the rest, true = only those, false =
    // none (checked live 2026-09-26: true + false = absent). Both flags are
    // declared, so neither is set by default.
    .option("--zeitarbeit", "only temp-work agency listings (default: included with the rest)")
    .option("--no-zeitarbeit", "leave out temp-work agency listings")
    .option(
      "--angebotsart <code>",
      "offer type code: 1 job, 2 self-employment, 4 apprenticeship/dual study, 34 internship/trainee",
      parseAngebotsart,
    )
    .option("--page <n>", "1-based page (1 or more)", parseBoundedInt(1, Number.MAX_SAFE_INTEGER))
    .option("--size <n>", "page size", parseIntArg)
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
          angebotsart: opts["angebotsart"] as number | undefined,
          page: opts["page"] as number | undefined,
          size: opts["size"] as number | undefined,
        };
        renderJson(deps, global, await client.search(params));
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
