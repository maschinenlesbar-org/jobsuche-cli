# jobsuche-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for German
job-market intelligence, all powered by the **[jobsuche](README.md)** CLI over the open
[Bundesagentur für Arbeit Jobsuche API](https://jobsuche.api.bund.dev/)
(`rest.arbeitsagentur.de`) — Germany's largest job database.

Each skill teaches Claude how to drive the `jobsuche` CLI to answer a specific, real-world
question — "who's hiring nurses in Berlin?", "find me data-engineer roles near Munich", "what's
Deutsche Bahn recruiting right now?" — and to report the answer with evidence rather than
guesswork. They encode the parts that are easy to get wrong (the facet-only `--size 0` scan,
the *missing* `ergebnisliste` key on no-match, locations being an array, what only `details`
carries) so Claude doesn't have to rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **jobsuche-market-scan** | Reads the API's facet aggregations (one cheap `--size 0` call) into a market overview: total demand, top hiring employers, where the jobs are, salary cadence, home-office share, freshness. | "who's hiring Pflege in Berlin?", "what's the market for data engineers in Munich?" |
| **jobsuche-job-hunt** | Searches with the right filters, sorts by distance/freshness, de-duplicates re-posts, and enriches the top picks with full detail (salary, home-office, how to apply). | "find nursing jobs near Munich", "recent data roles within 30 km of Köln" |
| **jobsuche-employer-watch** | Pulls one employer's openings, breaks them down by location/role/freshness, and (re-run) flags what's new since last time. | "what's Deutsche Bahn hiring?", "new postings at SAP this week" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `jobsuche` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/jobsuche-cli   # installs the `jobsuche` bin
  ```
- **An API key.** The Jobsuche API needs a static `X-API-Key` that is **not bundled** with
  the CLI. It is public, not a secret, and you do not have to go and find it — the CLI
  obtains it from the upstream source that publishes it:
  ```bash
  eval "$(jobsuche obtain-key --export)"        # this shell
  jobsuche obtain-key --export >> ~/.zshrc      # or keep it for later
  ```
  You can also supply it yourself via `JOBSUCHE_API_KEY` or `--api-key`.
  With no key the API answers `401`/`403` and the CLI exits `3`. An empty-body `403`
  looks the same for a wrong key and for a network the service refuses, so if the key
  matches the bundesAPI README, try from another network.

## Installation

### Plugin marketplace (recommended)

The skills are published as the `jobsuche` plugin in the
[maschinenlesbar.org plugin marketplace](https://github.com/maschinenlesbar-org/plugins),
which lists the plugins for all maschinenlesbar.org CLIs. Installation is two commands
inside Claude Code:

```
/plugin marketplace add maschinenlesbar-org/plugins
/plugin install jobsuche@maschinenlesbar
```

The first command registers the marketplace (once, for all maschinenlesbar.org
plugins); the second installs the `jobsuche` plugin, which bundles all three skills.
Update later with `/plugin marketplace update maschinenlesbar`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/jobsuche-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/jobsuche-job-hunt/SKILL.md`. Start a new Claude Code session and the skills are
picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> Who's hiring nurses within 50 km of Berlin, and which employers post the most?

> Find me data-engineer roles near Munich from the last two weeks, nearest first.

> What's Deutsche Bahn recruiting in Frankfurt right now — anything new this week?

You can also invoke a skill explicitly with its slash command, e.g. `/jobsuche-market-scan`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`jobsuche` subcommands to call, in what order, and how to interpret the JSON. The skills
encode the non-obvious parts of this API, for example:

- **`--size 0` returns the facets with zero listings** — the cheap way to describe a whole
  market (total demand, top employers, locations, salary cadence, freshness) without paging
  through thousands of records (see **jobsuche-market-scan**);
- a **no-match search omits the `ergebnisliste` key entirely** (it is *not* `[]`) and also
  drops `facetten` — naive `jq '.ergebnisliste[]'` errors; treat a missing key as "no
  results" and broaden;
- a listing's place is an **array** (`stellenlokationen[].adresse`), and its distance
  `entfernung` (km) is only there when the search had a `--wo` (see **jobsuche-job-hunt**);
- search summaries and the `details` payload share field names — employer `firma`, title
  `stellenangebotsTitel`, id `referenznummer`, apply link `externeURL` — but only `details`
  carries the description; salary (`gehaltsspanneVon`/`gehaltsspanneBis`, `festgehalt`) is
  often absent — most German postings omit pay;
- the default search **includes temp-work agencies** (`--no-zeitarbeit` drops them;
  `--zeitarbeit` keeps **only** them), and **recruitment/placement agencies** still top the
  employer facet for many fields — they are not the end employer;
- `--arbeitgeber` is name-matched and fuzzy; a company often spans several legal entities
  (`Deutsche Bahn AG` vs `DB Netz AG` …) — sanity-check the matched names
  (see **jobsuche-employer-watch**).

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.
