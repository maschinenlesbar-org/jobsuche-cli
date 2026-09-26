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
compatibility: >
  Requires the `jobsuche` CLI (npm package @maschinenlesbar.org/jobsuche-cli) on
  PATH, installed by the user; the skill never installs it. Uses jq for JSON
  filtering. Network access to rest.arbeitsagentur.de. Needs the public API key
  via --api-key or JOBSUCHE_API_KEY (`jobsuche obtain-key` prints it).
---

# Jobsuche Job Hunt

Turn a "find me jobs doing X near Y" request into a **short, ranked shortlist of
real openings** the user can act on — sorted by what matters (distance,
freshness), de-duplicated, and enriched with the full detail (salary, home-office,
how to apply) the search summary doesn't carry.

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

## Step 1 — Search with the right filters

```bash
jobsuche --compact search --was "Data Engineer" --wo München --umkreis 30 \
  --veroeffentlicht-seit 14 --size 50
```

Map the request to flags:

- `--was <role/keyword>` for a specific title; `--berufsfeld <field>` for a broad
  category (use one or the other; `--berufsfeld` casts wider).
- `--wo <city>` + `--umkreis <km>` for "near me" (with `--wo` every listing
  carries its **distance** `entfernung`, see Step 3).
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

The response is `{ ergebnisliste, maxErgebnisse, page, size, woOutput,
facetten }`. Each `ergebnisliste[]` entry is a **summary** with:

| Field | Meaning |
|---|---|
| `stellenangebotsTitel` | Job title (e.g. `"Informatiker (m/w/d)"`) |
| `hauptberuf` | Normalised occupation (e.g. `"Informatiker/in"`) |
| `firma` | Employer name |
| `referenznummer` | Stable id (the refnr) — the input to `details` and the de-dup/apply key |
| `stellenlokationen[0].adresse.ort` / `.plz` / `.strasse` | City / postal code / street (an **array** — a listing can name several places) |
| `stellenlokationen[0].breite` / `.laenge` | Latitude / longitude of the workplace |
| `entfernung` | **Distance in km** (a number); only present when `--wo` was given |
| `veroeffentlichungszeitraum.von` | Current publication date (`YYYY-MM-DD`) — sort key for freshness |
| `datumErsteVeroeffentlichung` | First publication date (older when a listing was re-published) |
| `aenderungsdatum` | Last-modified time |
| `eintrittszeitraum.von` | Desired start date |
| `gehaltsspanneVon` / `gehaltsspanneBis` / `festgehalt` | Salary, **when stated** (often absent) |
| `homeofficemoeglich` | Home office possible |
| `externeURL` | Present when the posting lives on a third-party board — the main **duplicate / re-post signal** (see Step 3) |

> **Traps.**
> - On a **no-match search the `ergebnisliste` key is absent entirely** (not
>   `[]`), and `facetten` is missing too. Treat a missing key as "no results" and
>   suggest broadening — don't let `jq` blow up (`.ergebnisliste // []`).
> - Address fields can be missing — show "address not given", never `null`.
> - Summaries do **not** carry the description or contact details — those only
>   come from `details` (Step 4). Salary is on the summary only when stated;
>   don't claim one you haven't seen.

## Step 3 — Rank and de-duplicate

1. **De-dupe.** The same job is often re-posted. Collapse entries with the same
   `(stellenangebotsTitel, firma, stellenlokationen[0].adresse.ort)` triple; among
   duplicates keep the one **without** `externeURL` (the direct/BA posting) if
   present, else the newest by `veroeffentlichungszeitraum.von`. Note how many you
   merged.
2. **Sort** by what the user cares about:
   - search with `--wo` → ascending `entfernung`, nearest first;
   - otherwise → newest `veroeffentlichungszeitraum.von` first.
   Break ties with freshness, then employer.
3. **Trim** to a shortlist (~5–10). The rest is a count.

```bash
jobsuche --compact search --was Pflege --wo München --umkreis 50 --size 50 \
  | jq -r '.ergebnisliste // []
           | sort_by(.entfernung)
           | .[:10][] | "\(.entfernung)km  \(.stellenangebotsTitel) — \(.firma), \(.stellenlokationen[0].adresse.ort)  [\(.referenznummer)]"'
```

## Step 4 — Enrich the top picks with `details`

Summaries are thin. For the shortlist (or the few the user is interested in),
fetch full detail by `referenznummer` — the CLI base64-encodes it for the API:

```bash
jobsuche --compact details 14225-dafcdd47aabe512d-S
```

The detail payload uses the **same field names** as the summary and adds more. The useful ones:

| Detail field | Meaning |
|---|---|
| `stellenangebotsTitel` | Title |
| `firma` | Employer |
| `stellenangebotsBeschreibung` | Full free-text description (tasks, requirements, benefits) |
| `gehaltsspanneVon` / `gehaltsspanneBis` | **Salary range**, when stated — the real pay figure |
| `verguetungsangabe` / `artDerVerguetung` | Pay statement / cadence |
| `homeofficemoeglich` / `homeofficetyp` | Remote work allowed + type |
| `arbeitszeitVollzeit` / `arbeitszeitTeilzeit*` | Full-/part-time, shift flags |
| `vertragsdauer` / `befristung` | Permanent vs fixed-term |
| `eintrittszeitraum` | When they want someone to start |
| `quereinstiegGeeignet` | Suitable for career-changers |
| `stellenlokationen` | Structured work location(s) |
| `externeURL` / `allianzpartnerUrl` | Where to apply |
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
