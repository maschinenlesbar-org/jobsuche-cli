# Usage

Real, use-case-driven examples for the `jobsuche` CLI — a command-line client
for the [Bundesagentur für Arbeit Jobsuche API](https://jobsuche.api.bund.dev/)
(Germany's largest job database). It exposes the API's two read-only endpoints:
**search** job listings (`Stellenangebote`) by keyword/location/radius, and
fetch **full job details** by reference number (`refnr`).

Every command prints pretty JSON to stdout (use `--compact` for a single line),
so the examples pipe to [`jq`](https://jqlang.github.io/jq/) where it helps.

## Install

```bash
npm i -g @maschinenlesbar.org/jobsuche-cli
```

The installed binary is **`jobsuche`**. Without a global install you can run the
built CLI directly with `node dist/src/cli/index.js` (substitute that for
`jobsuche` in any example below). The API's public `X-API-Key` is sent
automatically, so no credentials setup is needed.

## Use cases

### 1. Find jobs by keyword and city

Quickest way to see what's available for a role in a place.

```bash
jobsuche search --was Informatiker --wo Berlin --size 10
```

`--was` is the keyword/title, `--wo` the location, `--size` caps the page size.
The result is a `JobSearchResult` object: `stellenangebote` (the listings),
plus `maxErgebnisse` (total matches), `page` and `size`.

### 2. Search within a radius of a location

Catch listings in the surrounding area, not just the exact city.

```bash
jobsuche search --was Pflegefachkraft --wo "München" --umkreis 50
```

`--umkreis` is the radius in km around `--wo`. Radius results carry a per-listing
`arbeitsort.entfernung` (distance in km) you can sort on:

```bash
jobsuche search --was Pflegefachkraft --wo "München" --umkreis 50 \
  | jq '.stellenangebote | sort_by(.arbeitsort.entfernung)
        | .[] | {titel, ort: .arbeitsort.ort, km: .arbeitsort.entfernung}'
```

### 3. Only recently published listings

Skip stale postings — show what went live in the last week.

```bash
jobsuche search --was Data --wo Hamburg --veroeffentlicht-seit 7
```

`--veroeffentlicht-seit <days>` filters to listings published within the last N
days. Combine with `--umkreis` for a tight, fresh local search.

### 4. Page through a large result set

Total matches can run into the thousands; walk them a page at a time.

```bash
# page 1
jobsuche search --was Projektmanager --size 25 --page 1
# page 2
jobsuche search --was Projektmanager --size 25 --page 2
```

`--page` is 1-based and `--size` is the page size. Check `maxErgebnisse` against
`page * size` to know when you have reached the end:

```bash
jobsuche search --was Projektmanager --size 25 --page 1 \
  | jq '{total: .maxErgebnisse, page, size, returned: (.stellenangebote | length)}'
```

### 5. Extract just the reference numbers

Get a clean list of `refnr` values to feed into `details` (use case 7).

```bash
jobsuche search --was Elektroniker --wo Köln --size 20 \
  | jq -r '.stellenangebote[].refnr'
```

`refnr` (e.g. `10001-1002716922-S`) is the stable id for each listing and the
input for the `details` command.

### 6. Filter by offer type (Angebotsart)

Separate regular job vacancies from apprenticeships/trainee postings.

```bash
# regular job vacancies (Arbeit)
jobsuche search --was Mechatroniker --wo Stuttgart --angebotsart 1

# apprenticeships / dual-study (Ausbildung)
jobsuche search --was Mechatroniker --wo Stuttgart --angebotsart 4
```

`--angebotsart <code>` takes the API's numeric offer-type code and is passed
through verbatim (e.g. `1` regular vacancy, `4` apprenticeship/dual-study).

### 7. Fetch full details for a listing

Get the complete payload for one job — description, contact, dates, and more.

```bash
jobsuche details 14225-dafcdd47aabe512d-S
```

Pass the `refnr` from any search result; the CLI base64-encodes it into the
API's `encryptedJobCode` for you. A purely numeric `refnr` (e.g. `1002716922`)
or an already-encoded code also works. Exit code `4` means the listing was not
found (`404`).

### 8. Search jobs at a specific employer

Narrow to one company's openings in a region.

```bash
jobsuche search --arbeitgeber "Deutsche Bahn AG" --wo Frankfurt --umkreis 30
```

`--arbeitgeber` filters by employer name (matched against the full registered
name, so use the exact spelling, e.g. `"Deutsche Bahn AG"`). Pull a quick
title-and-city overview:

```bash
jobsuche search --arbeitgeber "Deutsche Bahn AG" --wo Frankfurt --umkreis 30 \
  | jq -r '.stellenangebote[] | "\(.titel) — \(.arbeitsort.ort)"'
```

### 9. Browse an occupational field, including temp-work agencies

Cast a wider net across a whole field and don't exclude staffing agencies.

```bash
jobsuche search --berufsfeld "Altenpflege" --wo Leipzig \
  --umkreis 40 --zeitarbeit
```

`--berufsfeld` searches a broad occupational category (vs. the more specific
`--was`); `--zeitarbeit` is a boolean flag that includes temp-work / staffing
agencies in the results.

### 10. Search → pick first result → fetch its details (one-liner)

Chain a search straight into a detail lookup without copy-pasting a `refnr`.

```bash
jobsuche details "$(jobsuche search --was Informatiker --wo Berlin --size 1 \
  | jq -r '.stellenangebote[0].refnr')"
```

Useful in scripts. Add `--compact` to either call for single-line JSON when
feeding another tool.

## Global options

These apply to every command and may be given before or after the command name
(e.g. both `jobsuche --compact search …` and `jobsuche search … --compact`):

| Option | Description |
| --- | --- |
| `--base-url <url>` | API base URL (default `https://rest.arbeitsagentur.de`) |
| `--api-key <key>` | override the `X-API-Key` (env `JOBSUCHE_API_KEY`); blank/whitespace is ignored and the default public key is used |
| `--timeout <ms>` | per-request timeout in milliseconds |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | retries for transient `429`/`503` responses |
| `--max-response-bytes <n>` | cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | print JSON on a single line instead of pretty-printed |
| `-V, --version` | print the version |
| `-h, --help` | show help (also `jobsuche <command> --help`) |

Exit codes: `0` success; `2` usage errors (bad flag/value, missing command);
`3` on `401`/`403`; `4` on `404`; `1` for any other error (network, parse, etc.).
