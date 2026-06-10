---
name: jobsuche-market-scan
description: >
  Produce a labour-market overview for a role or field in a German region using
  the jobsuche-cli — top hiring employers, where the jobs are, salary cadence,
  home-office share, contract types and how fresh the market is. Trigger when the
  user asks "who's hiring nurses in Berlin?", "what does the job market for data
  engineers in Munich look like?", "which companies post the most X jobs?",
  "is there demand for Y around Hamburg?", "how many openings for Z and where".
  Reads the API's facet aggregations instead of paging through thousands of
  listings.
version: 1.0.0
userInvocable: true
---

# Jobsuche Market Scan

Answer "what does the market for *this role* in *this region* look like?" — total
demand, the top hiring employers, where the jobs concentrate, salary cadence,
home-office availability and freshness — **from a single cheap call**, instead of
downloading thousands of individual listings.

## Tooling

This skill drives the `jobsuche` command. **Before anything else, validate it is available** — run `command -v jobsuche` (or `jobsuche --version`). If it is not on your PATH, STOP and inform the user that the `jobsuche` CLI (`@maschinenlesbar.org/jobsuche-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**API key (required).** The API needs a static, publicly-documented `X-API-Key`.
It is **not bundled**. Supply it via the `JOBSUCHE_API_KEY` env var (preferred) or
`--api-key`. The public value is `jobboerse-jobsuche` (documented in the upstream
[bundesAPI/jobsuche-api](https://github.com/bundesAPI/jobsuche-api) repo). With no
key the API answers `401`/`403` and the CLI exits `3`. Set it once:

```bash
export JOBSUCHE_API_KEY="jobboerse-jobsuche"
```

Always pass `--compact` so output is one line for `jq`.

## Step 1 — The key move: ask for facets, not listings

The market picture lives in the response's **`facetten`** object — aggregate
counts the API computes over the *entire* matching set, not just the current page.
So request **`--size 0`**: you get `maxErgebnisse` (total demand) and the full
`facetten`, with **zero** listing records downloaded. This is the whole point of
this skill — one tiny call describes thousands of jobs.

```bash
jobsuche --compact search --was Pflege --wo Berlin --umkreis 50 --size 0
```

Choose the search axis to match the question:

- A specific role/title → `--was` (e.g. `Pflege`, "Data Engineer").
- A broad field → `--berufsfeld` (e.g. `Altenpflege`) — wider net than `--was`.
- Add `--wo` + `--umkreis <km>` to scope a region (a radius of 30–50 km captures
  a metro area; omit `--wo` for a nationwide scan).
- Add `--zeitarbeit` to *include* staffing/temp agencies (excluded by default);
  for a "real employer" picture, leave it off and say so.

## Step 2 — Read the facets

`maxErgebnisse` is total demand. Each facet is `{ "counts": { <label>: <n> },
"maxCount": <total> }`. The ones worth reporting:

| Facet | Tells you |
|---|---|
| `arbeitgeber` | **Top hiring employers** by open-posting count — the headline of any "who's hiring" answer. Big lists; rank and take the top ~10. |
| `arbeitsort` / `arbeitsort_plz` | Where the jobs are (city / postal code) — concentration and hotspots. |
| `berufsfeld` | Which occupational fields the matches span — shows how broad/narrow the role is. |
| `branche` | Industry sectors hiring for it. |
| `verguetung` | Salary cadence: counts of listings quoting `jahr` (annual) vs `stunde` (hourly) — a rough white-/blue-collar and seniority signal. |
| `ausbildungsverguetung` | Apprenticeship-pay listings (training-market signal). |
| `homeoffice` | Remote availability: `prozentual` (some %), `nv_true`/`nv_false` (not specified). Compute the remote-friendly share. |
| `befristung` | Contract type: permanent vs fixed-term (codes — `1`/`2`/`3`). |
| `arbeitszeit` | Full-time vs part-time mix. |
| `veroeffentlichtseit` | **Freshness histogram** — cumulative counts at `0/1/7/14/28` days and `alle` (all). How active/churny the market is right now. |
| `zeitarbeit` | Share that are temp-agency postings. |
| `quereinstieg` | Openings flagged suitable for career-changers. |

Extract the headline facets with `jq`, e.g. top employers:

```bash
jobsuche --compact search --was Pflege --wo Berlin --umkreis 50 --size 0 \
  | jq '.facetten.arbeitgeber.counts | to_entries | sort_by(-.value)
        | .[:10] | map("\(.value)  \(.key)") '
```

> **Traps.**
> - `--size 0` is intentional and supported: it returns the facets with **no**
>   listings. Do not page through results to build these counts — the facets
>   already aggregate the whole set.
> - When `maxErgebnisse` is `0` the response has **no `stellenangebote` key at
>   all** (not `[]`) and **no `facetten`** — report "no demand found, broaden the
>   search" rather than letting `jq` error on a missing key.
> - `veroeffentlichtseit` counts are **cumulative** (`7` includes everything from
>   the last 7 days, `alle` = the total), not per-bucket — derive deltas if you
>   want "new in the last day vs week".
> - Facet employer/location labels are the API's raw strings (e.g.
>   `"50Hertz Transmission GmbH AD Berlin"`); show them verbatim.
> - The default search **excludes** temp-work agencies (`zeitarbeit`) — note
>   that, or add `--zeitarbeit`, before claiming an employer ranking is
>   exhaustive. Even so, **recruitment / placement agencies** (e.g.
>   `… Personalservice`, `… Arbeitsvermittlung`) still rank near the top of
>   `facetten.arbeitgeber` for many fields — they are not the end employer. Flag
>   them as agencies rather than presenting them as "the biggest hirer".

## Step 3 — Brief the user

Lead with the total, then the rankings — numbers, not raw JSON:

```
Pflege within 50 km of Berlin — 9,192 open listings (temp agencies excluded)

Top hiring employers
   453  Vivantes …
   37   50Hertz Transmission GmbH
   25   AGAPLESION Bethanien Diakonie gGmbH
   …
Where           Berlin 6,100 · Potsdam 453 · Oranienburg 120 · …
Salary quoted   hourly 2,620 · annual 1,012 (rest not stated)
Home office     271 list some remote, 35 none specified
Freshness       146 in last 28 days, 45 in last 7, 13 today — active market
```

Rules:
- Lead with `maxErgebnisse` and the scope (role, region+radius, temp-work in/out).
- Rank employers and locations; cap at ~10 and say "of N" for the long tail.
- Translate cadence/contract facets into plain language; don't dump code keys.
- Call out anything notable (one employer dominating; market concentrated in one
  city; mostly fixed-term; strong remote share).
- Offer the obvious follow-ups: drill into a specific employer
  (**jobsuche-employer-watch**) or pull and rank actual listings to apply to
  (**jobsuche-job-hunt**). Don't enumerate listings here — that's not this skill.
- Don't invent a salary range: `verguetung` only tells you the *cadence* quoted,
  not amounts. Concrete pay lives on individual `details` (`gehaltsspanneVon/Bis`).
