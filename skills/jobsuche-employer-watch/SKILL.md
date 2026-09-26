---
name: jobsuche-employer-watch
description: >
  Track a specific employer's open vacancies in Germany using the jobsuche-cli.
  Trigger when the user asks "what's Deutsche Bahn hiring right now?", "show all
  open roles at SAP near Walldorf", "is a company hiring in a city?", "new
  postings at an employer this week", "where is a company recruiting and for
  what". Pulls all of one employer's listings, breaks them down by location,
  role and freshness, and (re-run) flags what's new since last time.
compatibility: >
  Requires the `jobsuche` CLI (npm package @maschinenlesbar.org/jobsuche-cli) on
  PATH, installed by the user; the skill never installs it. Uses jq for JSON
  filtering. Network access to rest.arbeitsagentur.de. Needs the public API key
  via --api-key or JOBSUCHE_API_KEY (`jobsuche obtain-key` prints it).
---

# Jobsuche Employer Watch

Give a focused picture of **one employer's current hiring**: how many roles are
open, where, for what, how fresh — and, on a repeat run, **what's new since last
time**. Turns the raw per-listing JSON into a recruiting profile of a single
company.

## Tooling

This skill drives the `jobsuche` command. **Before anything else, validate it is available** — run `command -v jobsuche` (or `jobsuche --version`). If it is not on your PATH, STOP and inform the user that the `jobsuche` CLI (`@maschinenlesbar.org/jobsuche-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

**API key — obtain it once, then reuse it.** The API needs a static `X-API-Key`. **None is
bundled**, and it is **not a secret**: one public value, the same for everyone. Finding it is
not the user's job either. If `JOBSUCHE_API_KEY` is already set in the environment, use that;
otherwise obtain it with the CLI's own command:

```bash
jobsuche obtain-key
```

It prints the key on stdout (the "obtained from …" note goes to stderr) and reads it from the
published upstream source, so a rotated key needs no new release. **Keep that value for the
rest of the session** and put it on every later call — a shell `export` does not survive
between separate commands:

```bash
JOBSUCHE_API_KEY="<the key obtain-key printed>" jobsuche --compact search --was Informatiker
```

Say which key you used when you report back — it is public, not a credential to hide. If
`obtain-key` exits non-zero, stop and tell the user; never guess a key or hard-code one.

**If a call exits `3` with `HTTP 403`, the cause is ambiguous.** The gateway at
`rest.arbeitsagentur.de` sends the same empty-body 403 for a wrong or missing key as when
it refuses the network you are on, and now and then for a valid key, so the response can't
tell you which. If the CLI's hint says no key was sent, pass it. Otherwise re-check the key
against `jobsuche obtain-key` (it reads the
[bundesAPI/jobsuche-api](https://github.com/bundesAPI/jobsuche-api) README), retry once, and
if it still fails, tell the user to try from another network.

Always `--compact`.

## Step 1 — Resolve the employer name

`--arbeitgeber` matches against the employer's **registered name as the API
stores it**, so the exact spelling matters (e.g. `"Deutsche Bahn AG"`,
`"SAP SE"`). If you're unsure of the exact form:

- Run a keyword search and read back the listings' `firma` values, **or**
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

The listings are in `ergebnisliste`. Per-listing fields that matter:
`stellenangebotsTitel`, `hauptberuf`, `firma`, `referenznummer` (the refnr),
`stellenlokationen[0].adresse.ort` / `.plz` (an array — a listing can name several
places), `entfernung` (km, a number, only with `--wo`),
`veroeffentlichungszeitraum.von` (current publication date, `YYYY-MM-DD`),
`eintrittszeitraum.von`, `externeURL`.

> **Traps.**
> - `--arbeitgeber` is name-matched and can be **fuzzy/partial** — it may pull in
>   sibling entities or miss a posting filed under a slightly different name.
>   Sanity-check the `firma` values in the results and report the matched
>   spellings.
> - **No matches ⇒ the `ergebnisliste` key is absent** (not `[]`), and no
>   `facetten`. Report "no open listings for that employer/scope" — broaden or
>   re-check the spelling — rather than erroring on a missing key.
> - Address fields can be missing — render "address not given".

## Step 3 — Build the profile

Aggregate the listings into a recruiting snapshot:

- **By location** — count per `stellenlokationen[0].adresse.ort` (and/or `plz`);
  show top cities.
- **By role/field** — group similar `hauptberuf`/`stellenangebotsTitel`; surface
  what they're hiring for most.
- **By freshness** — bucket `veroeffentlichungszeitraum.von` into today / last 7
  / last 30 days.
- **Apprenticeships** — optionally split with a second `--angebotsart 4` run to
  separate Ausbildung from regular vacancies.

```bash
jobsuche --compact search --arbeitgeber "Deutsche Bahn AG" --size 100 \
  | jq '.ergebnisliste // [] | group_by(.stellenlokationen[0].adresse.ort)
        | map({ort: .[0].stellenlokationen[0].adresse.ort, count: length}) | sort_by(-.count)'
```

## Step 4 — "What's new" mode (monitoring)

When the user wants to *track* an employer over time (re-run weekly, "anything
new at X?"):

1. Each run, capture the set of `referenznummer` values (and dates) for that employer/scope
   — write them to a small JSON/text file the user keeps (e.g.
   `~/.jobsuche-watch-<employer>.json`).
2. On the next run, diff the new `referenznummer` set against the saved one:
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
- Offer follow-ups: full detail on any opening (`details <referenznummer>`, brings
  the description / contact / how-to-apply), or a full job-hunt shortlist
  (**jobsuche-job-hunt**).
- Don't claim a hire/fill from a vanished `referenznummer` — say "no longer listed".
