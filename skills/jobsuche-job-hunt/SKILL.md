---
name: jobsuche-job-hunt
description: >
  Find, rank and enrich job listings for a candidate using the jobsuche-cli.
  Trigger when the user asks "find me nursing jobs near Munich", "what data-
  engineer roles are open in Berlin?", "show recent jobs within 30 km of Köln",
  "apprenticeships for mechatronics in Stuttgart", "best fresh openings I could
  apply to". Searches with the right filters, sorts by distance/freshness,
  removes duplicate re-posts, and pulls full details (salary, home-office,
  description, how to apply) for the top picks.
version: 1.0.0
userInvocable: true
---

# Jobsuche Job Hunt

Turn a "find me jobs doing X near Y" request into a **short, ranked shortlist of
real openings** the user can act on — sorted by what matters (distance,
freshness), de-duplicated, and enriched with the full detail (salary, home-office,
how to apply) the search summary doesn't carry.

## Tooling

This skill drives the `jobsuche` command. **Before anything else, validate it is available** — run `command -v jobsuche` (or `jobsuche --version`). If it is not on your PATH, STOP and inform the user that the `jobsuche` CLI (`@maschinenlesbar.org/jobsuche-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**API key (required).** Supply the static `X-API-Key` via `JOBSUCHE_API_KEY`
(preferred) or `--api-key`. The public value is `jobboerse-jobsuche` (see
[bundesAPI/jobsuche-api](https://github.com/bundesAPI/jobsuche-api)). Without it
the CLI exits `3` (`401`/`403`). Set it once:

```bash
export JOBSUCHE_API_KEY="jobboerse-jobsuche"
```

Always `--compact`.

## Step 1 — Search with the right filters

```bash
jobsuche --compact search --was "Data Engineer" --wo München --umkreis 30 \
  --veroeffentlicht-seit 14 --size 50
```

Map the request to flags:

- `--was <role/keyword>` for a specific title; `--berufsfeld <field>` for a broad
  category (use one or the other; `--berufsfeld` casts wider).
- `--wo <city>` + `--umkreis <km>` for "near me" (a radius **also adds a per-
  listing distance**, see Step 3). Without `--umkreis` you get only the exact place.
- `--veroeffentlicht-seit <days>` to keep it fresh (7/14/30 are good defaults for
  an active hunt).
- `--angebotsart <code>` for offer type: `1` = regular vacancy, `4` =
  apprenticeship / dual-study. Use `4` whenever the user says
  "Ausbildung"/apprenticeship/trainee.
- `--arbeitgeber "<name>"` to restrict to one company (or use
  **jobsuche-employer-watch**).
- `--zeitarbeit` to *include* temp/staffing agencies (off by default — most job
  hunters want it off; mention you excluded them).
- `--size 50` to get a decent pool to rank in one call; page with `--page` only if
  `maxErgebnisse` >> what you fetched and the user wants more.

Check `maxErgebnisse` first: too many → tighten (`--umkreis` down,
`--veroeffentlicht-seit` shorter, more specific `--was`); too few → broaden.

## Step 2 — The result envelope and per-listing fields

The response is `{ stellenangebote, maxErgebnisse, page, size, woOutput,
facetten }`. Each `stellenangebote[]` entry is a **summary** with:

| Field | Meaning |
|---|---|
| `titel` | Job title (e.g. `"Informatiker (m/w/d)"`) |
| `beruf` | Normalised occupation (e.g. `"Informatiker/in"`) |
| `arbeitgeber` | Employer name |
| `refnr` | Stable id — the input to `details` and the de-dup/apply key |
| `arbeitsort.ort` / `.plz` / `.strasse` | City / postal code / street |
| `arbeitsort.entfernung` | **Distance in km — a STRING** (e.g. `"5"`); only present on radius searches. `Number()` it before sorting. |
| `arbeitsort.koordinaten` | `{ lat, lon }` of the workplace |
| `aktuelleVeroeffentlichungsdatum` | Publication date (`YYYY-MM-DD`) — sort key for freshness |
| `modifikationsTimestamp` | Last-modified time |
| `eintrittsdatum` | Desired start date |
| `externeUrl` | Present when the posting lives on a third-party board — the main **duplicate / re-post signal** (see Step 3) |

> **Traps.**
> - `entfernung` is a **string**; sorting it lexically puts `"10"` before `"5"`.
>   Always `(.arbeitsort.entfernung | tonumber)`.
> - On a **no-match search the `stellenangebote` key is absent entirely** (not
>   `[]`), and `facetten` is missing too. Treat a missing key as "no results" and
>   suggest broadening — don't let `jq` blow up.
> - `arbeitsort.strasse` is sometimes the literal string `"null"` — show "address
>   not given", never the word "null".
> - Summaries do **not** carry salary, description, or home-office — those only
>   come from `details` (Step 4). Don't claim a salary you haven't fetched.

## Step 3 — Rank and de-duplicate

1. **De-dupe.** The same job is often re-posted. Collapse entries with the same
   `(titel, arbeitgeber, arbeitsort.ort)` triple; among duplicates keep the one
   **without** `externeUrl` (the direct/BA posting) if present, else the newest by
   `aktuelleVeroeffentlichungsdatum`. Note how many you merged.
2. **Sort** by what the user cares about:
   - radius search → ascending `entfernung` (numeric), nearest first;
   - otherwise → newest `aktuelleVeroeffentlichungsdatum` first.
   Break ties with freshness, then employer.
3. **Trim** to a shortlist (~5–10). The rest is a count.

```bash
jobsuche --compact search --was Pflege --wo München --umkreis 50 --size 50 \
  | jq -r '.stellenangebote
           | sort_by(.arbeitsort.entfernung | tonumber)
           | .[:10][] | "\(.arbeitsort.entfernung)km  \(.titel) — \(.arbeitgeber), \(.arbeitsort.ort)  [\(.refnr)]"'
```

## Step 4 — Enrich the top picks with `details`

Summaries are thin. For the shortlist (or the few the user is interested in),
fetch full detail by `refnr` — the CLI base64-encodes it for the API:

```bash
jobsuche --compact details 14225-dafcdd47aabe512d-S
```

The detail payload uses **different field names** from the summary. The useful ones:

| Detail field | Meaning |
|---|---|
| `stellenangebotsTitel` | Title (detail's spelling, not `titel`) |
| `firma` | Employer (detail uses `firma`, **not** `arbeitgeber`) |
| `stellenangebotsBeschreibung` | Full free-text description (tasks, requirements, benefits) |
| `gehaltsspanneVon` / `gehaltsspanneBis` | **Salary range**, when stated — the real pay figure |
| `verguetungsangabe` / `artDerVerguetung` | Pay statement / cadence |
| `homeofficemoeglich` / `homeofficetyp` | Remote work allowed + type |
| `arbeitszeitVollzeit` / `arbeitszeitTeilzeit*` | Full-/part-time, shift flags |
| `vertragsdauer` / `befristung` | Permanent vs fixed-term |
| `eintrittszeitraum` | When they want someone to start |
| `quereinstiegGeeignet` | Suitable for career-changers |
| `stellenlokationen` | Structured work location(s) |
| `externeURL` / `allianzpartnerUrl` | Where to apply (note: detail spells it `externeURL`, summary `externeUrl`) |
| `referenznummer` | The refnr again |

> Salary fields are often absent — most German postings omit pay. Say "salary not
> stated" rather than guessing. Don't fetch `details` for every result (it's one
> request each) — only for the shortlist or on request.

## Step 5 — Present the shortlist

```
Data-Engineer roles within 30 km of München, last 14 days
312 matches (temp agencies excluded) — 8 after de-duping re-posts. Top picks:

1. ⭐ Data Engineer (m/w/d) — BMW AG, München · 0 km · posted 2 days ago
     Permanent · full-time · home office possible · €65k–80k
     Apply: bmw.de/… (refnr 10001-100…-S)
2.   Senior Data Engineer — Allianz, Unterföhring · 8 km · posted today
     Salary not stated · hybrid
   …
(+304 more — say "more" to widen)
```

Rules:
- Lead with `maxErgebnisse`, the scope, and how many you kept after de-duping.
- Per pick: title, employer, city + **distance**, **freshness** (days since
  publication), and — for enriched ones — salary, contract, home-office, and a
  way to apply (`externeURL` / the refnr for the BA listing).
- Mark `entfernung` numeric and human ("3 km", "posted today").
- If you de-duped or excluded temp agencies, say so in one line.
- Offer the next step: full description of any pick, more results
  (`--page`/wider radius), or a market overview (**jobsuche-market-scan**).
- Never invent salary, remote policy, or "easy apply" the data doesn't show.
