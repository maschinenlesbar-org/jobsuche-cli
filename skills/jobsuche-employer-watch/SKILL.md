---
name: jobsuche-employer-watch
description: >
  Track a specific employer's open vacancies in Germany using the jobsuche-cli.
  Trigger when the user asks "what's Deutsche Bahn hiring right now?", "show all
  open roles at SAP near Walldorf", "is <company> hiring in <city>?", "new
  postings at <employer> this week", "where is <company> recruiting and for
  what". Pulls all of one employer's listings, breaks them down by location,
  role and freshness, and (re-run) flags what's new since last time.
version: 1.0.0
userInvocable: true
---

# Jobsuche Employer Watch

Give a focused picture of **one employer's current hiring**: how many roles are
open, where, for what, how fresh — and, on a repeat run, **what's new since last
time**. Turns the raw per-listing JSON into a recruiting profile of a single
company.

## Tooling

This skill drives the `jobsuche` command. **Before anything else, validate it is available** — run `command -v jobsuche` (or `jobsuche --version`). If it is not on your PATH, STOP and inform the user that the `jobsuche` CLI (`@maschinenlesbar.org/jobsuche-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**API key (required).** Supply the static `X-API-Key` via `JOBSUCHE_API_KEY`
(preferred) or `--api-key`. The public value is `jobboerse-jobsuche` (see
[bundesAPI/jobsuche-api](https://github.com/bundesAPI/jobsuche-api)). Without it
the CLI exits `3`. Set it once:

```bash
export JOBSUCHE_API_KEY="jobboerse-jobsuche"
```

Always `--compact`.

## Step 1 — Resolve the employer name

`--arbeitgeber` matches against the employer's **registered name as the API
stores it**, so the exact spelling matters (e.g. `"Deutsche Bahn AG"`,
`"SAP SE"`). If you're unsure of the exact form:

- Run a keyword search and read back the `arbeitgeber` values, **or**
- Run a market scan (see **jobsuche-market-scan**, `--size 0`) and look at the
  `facetten.arbeitgeber.counts` keys — those are the exact registered names with
  posting counts. Pick the right one, then watch it.

A company often appears under **several legal entities** (e.g. `Deutsche Bahn AG`
vs `DB Netz AG` vs `DB Regio AG`). Decide with the user whether to watch one
entity or the whole group (run each name and merge), and say which you did.

## Step 2 — Pull the employer's listings

```bash
jobsuche --compact search --arbeitgeber "Deutsche Bahn AG" --size 100
```

- Add `--wo <city> --umkreis <km>` to scope to a region; omit for nationwide.
- Add `--veroeffentlicht-seit <days>` for "new this week/month".
- Add `--zeitarbeit` only if you want their temp-agency postings too (off by
  default).
- `maxErgebnisse` is the true total; if it exceeds `--size`, either raise `--size`
  or page with `--page` (1-based) and concatenate before analysing. For a
  breakdown-only view, a cheap `--size 0` gives `maxErgebnisse` + `facetten`
  (top locations, fields, freshness) without downloading every listing.

Per-listing fields that matter (summary shape): `titel`, `beruf`, `refnr`,
`arbeitsort.ort` / `.plz`, `arbeitsort.entfernung` (string km, radius only),
`aktuelleVeroeffentlichungsdatum` (`YYYY-MM-DD`), `eintrittsdatum`, `externeUrl`.

> **Traps.**
> - `--arbeitgeber` is name-matched and can be **fuzzy/partial** — it may pull in
>   sibling entities or miss a posting filed under a slightly different name.
>   Sanity-check the `arbeitgeber` values in the results and report the matched
>   spellings.
> - **No matches ⇒ the `stellenangebote` key is absent** (not `[]`), and no
>   `facetten`. Report "no open listings for that employer/scope" — broaden or
>   re-check the spelling — rather than erroring on a missing key.
> - `entfernung` is a **string**; `tonumber` it before sorting.
> - `arbeitsort.strasse` can be the literal `"null"` — render "address not given".

## Step 3 — Build the profile

Aggregate the listings into a recruiting snapshot:

- **By location** — count per `arbeitsort.ort` (and/or `plz`); show top cities.
- **By role/field** — group similar `beruf`/`titel`; surface what they're hiring
  for most.
- **By freshness** — bucket `aktuelleVeroeffentlichungsdatum` into today / last 7
  / last 30 days.
- **Apprenticeships** — optionally split with a second `--angebotsart 4` run to
  separate Ausbildung from regular vacancies.

```bash
jobsuche --compact search --arbeitgeber "Deutsche Bahn AG" --size 100 \
  | jq '.stellenangebote | group_by(.arbeitsort.ort)
        | map({ort: .[0].arbeitsort.ort, count: length}) | sort_by(-.count)'
```

## Step 4 — "What's new" mode (monitoring)

When the user wants to *track* an employer over time (re-run weekly, "anything
new at X?"):

1. Each run, capture the set of `refnr` values (and dates) for that employer/scope
   — write them to a small JSON/text file the user keeps (e.g.
   `~/.jobsuche-watch-<employer>.json`).
2. On the next run, diff the new `refnr` set against the saved one:
   - **New** = refnrs present now but not before → these are fresh openings.
   - **Gone** = refnrs saved but absent now → likely filled/expired.
3. Report only the **new** ones (with title/location/date), give a count for the
   rest, and overwrite the saved set.

If no prior snapshot exists, say so and fall back to
`--veroeffentlicht-seit <days>` as a proxy for "recent" on the first run.

## Step 5 — Present

```
Deutsche Bahn AG — 316 open listings (matched: "Deutsche Bahn AG"; excl. temp agencies)

Top locations   Frankfurt am Main 41 · Berlin 33 · München 22 · …
Hiring for      Elektroniker:in 28 · Projektingenieur:in 19 · Lokführer:in 14 · …
Freshness       12 today · 58 last 7d · 190 last 30d

New since your last check (3):
  • (Senior) Projektingenieur:in Brückenbau — Frankfurt am Main, posted today
  • Referent:in Technikmanagement — Frankfurt am Main, posted 2026-06-10
  • Elektroniker:in Energieanlagen — Eschborn, posted 2026-06-09
```

Rules:
- Lead with the employer, the total, the matched spelling(s), and temp-work in/out.
- Give the location / role / freshness breakdowns as ranked counts, not raw lists.
- In watch mode, lead with **what's new**; everything else is a count.
- Note if results span multiple legal entities and whether you merged them.
- Offer follow-ups: full detail on any opening (`details <refnr>`, brings salary /
  description / how-to-apply), or a full job-hunt shortlist
  (**jobsuche-job-hunt**).
- Don't claim a hire/fill from a vanished `refnr` — say "no longer listed".
