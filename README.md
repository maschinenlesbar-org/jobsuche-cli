# jobsuche-cli

[![CI](https://github.com/maschinenlesbar-org/jobsuche-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/jobsuche-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/jobsuche-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/jobsuche-cli/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/maschinenlesbar-org/jobsuche-cli)](https://github.com/maschinenlesbar-org/jobsuche-cli/releases/latest)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/jobsuche-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/jobsuche-cli)

Search Germany's federal **job database** from your terminal. `jobsuche` is a
small command-line tool over the
[Bundesagentur für Arbeit Jobsuche API](https://jobsuche.api.bund.dev/)
(`rest.arbeitsagentur.de/jobboerse/jobsuche-service`): find job listings by
keyword, location, radius or employer, and fetch the full record for any posting
— as clean JSON you can pipe straight into
[`jq`](https://jqlang.github.io/jq/).

- **Just two commands** — `search` and `details`.
- **Clean JSON output** — pretty-printed by default, `--compact` for one-line/scripting.
- **Needs one short setup step** — supply the public, freely available API key once (see [Authentication](#authentication) below).
- **Full-detail lookups** — pass a `refnr` from any search result; the CLI base64-encodes it for the API automatically.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/jobsuche-cli
```

This installs the **`jobsuche`** command. Requires **Node.js 20+**.

Check it works:

```bash
jobsuche --help
```

## Authentication

The Jobsuche API requires a static, publicly-documented `X-API-Key`
(`jobboerse-jobsuche`). **The key is not bundled** — you supply it once via the
`JOBSUCHE_API_KEY` environment variable or per-call via `--api-key`. With no key
the header is omitted and the API answers `401`/`403` (exit code `3`).

The public key is documented in the upstream
[bundesAPI/jobsuche-api](https://github.com/bundesAPI/jobsuche-api) repository.
Set it in your shell profile for a seamless experience:

```bash
export JOBSUCHE_API_KEY="jobboerse-jobsuche"
```

Or fetch and export it in one step (handy for CI):

```bash
export JOBSUCHE_API_KEY="$(npm run --silent fetch-key --prefix $(npm root -g)/@maschinenlesbar.org/jobsuche-cli 2>/dev/null || echo jobboerse-jobsuche)"
```

Precedence is `--api-key` > `JOBSUCHE_API_KEY` env var. A blank/whitespace key
is ignored (no header sent).

## Quickstart

With the key set in your environment, your first search:

```bash
jobsuche search --was Informatiker --wo Berlin --size 10
```

`--was` is the keyword/title, `--wo` the location. The result is a JSON object
with `stellenangebote` (the listings array), `maxErgebnisse` (total matches),
`page` and `size`. Pull out just the titles with `jq`:

```bash
jobsuche search --was Informatiker --wo Berlin --size 10 \
  | jq '[.stellenangebote[] | {titel, arbeitgeber, ort: .arbeitsort.ort}]'
```

Take a listing's `refnr` from those results and fetch its full record:

```bash
jobsuche details 10001-1002716922-S
```

## Commands

```text
search   [filters…]     search job listings
details  <refnr>        full details for one listing
```

### `search` filters

| Flag | Meaning |
| --- | --- |
| `--was <text>` | job title / keyword (*was*) |
| `--wo <text>` | location (*wo*) |
| `--umkreis <km>` | radius in km around `--wo` (*Umkreis*) |
| `--berufsfeld <text>` | occupational field (*Berufsfeld*) |
| `--arbeitgeber <text>` | employer name (*Arbeitgeber*) |
| `--veroeffentlicht-seit <days>` | published within the last N days |
| `--angebotsart <code>` | offer type code, e.g. `1` regular vacancy, `4` apprenticeship |
| `--zeitarbeit` | include temp-work / staffing agencies |
| `--page <n>` | 1-based page index |
| `--size <n>` | page size |

The flag names mirror the API's German field names — the
**[Glossary](GLOSSARY.md)** decodes every one.

### `details <refnr>`

Pass the `refnr` from any search result (e.g. `10001-1002716922-S`, a hex form
like `14225-dafcdd47aabe512d-S`, or a purely numeric `1002716922`). The CLI
base64-encodes it into the API's `encryptedJobCode` for you. An
already-encoded code is also accepted and passed through unchanged.

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# Jobs within 50 km of a city
jobsuche search --was Pflegefachkraft --wo "München" --umkreis 50

# Only listings published in the last 7 days
jobsuche search --was Data --wo Hamburg --veroeffentlicht-seit 7

# Regular vacancies vs. apprenticeships (angebotsart code)
jobsuche search --was Mechatroniker --wo Stuttgart --angebotsart 1
jobsuche search --was Mechatroniker --wo Stuttgart --angebotsart 4

# Page through a large result set (1-based pages)
jobsuche search --was Kaufmann --size 25 --page 1
jobsuche search --was Kaufmann --size 25 --page 2

# Search at a specific employer
jobsuche search --arbeitgeber "Deutsche Bahn AG" --wo Frankfurt --umkreis 30
```

## Output & scripting

Every command prints **pretty JSON to stdout**. Errors and diagnostics go to
stderr, so piping stdout into `jq` stays clean.

```bash
# How many total matches for a query?
jobsuche search --was Pflege --wo Berlin | jq '.maxErgebnisse'

# Sort radius results by distance
jobsuche search --was Pflege --wo "München" --umkreis 50 \
  | jq '.stellenangebote | sort_by(.arbeitsort.entfernung)
        | .[] | {titel, ort: .arbeitsort.ort, km: .arbeitsort.entfernung}'

# Chain search → details without copy-pasting a refnr
jobsuche details "$(jobsuche search --was Informatiker --wo Berlin --size 1 \
  | jq -r '.stellenangebote[0].refnr')"
```

Use `--compact` for single-line JSON in pipelines and logs:

```bash
jobsuche --compact search --was Informatiker --size 5
```

`--compact` (and every global option) works **before or after** the command —
both `jobsuche --compact search …` and `jobsuche search … --compact` do the
same thing.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | success (also `--help` / `--version`) |
| `2` | bad usage / invalid argument (nothing was sent) |
| `3` | request rejected (`401`/`403`) — usually a missing or wrong API key |
| `4` | listing not found (`404`) |
| `1` | any other error (network/transport failure, JSON parse error, etc.) |

## Troubleshooting

- **`command not found: jobsuche`** — the global npm bin directory isn't on
  your `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/jobsuche-cli …`.
- **Exit `3` / "request rejected"** — the API declined the request. The most
  common cause is a missing or incorrect key. Check that `JOBSUCHE_API_KEY` is
  set and non-empty, or pass `--api-key` explicitly. The public key is
  `jobboerse-jobsuche` (see [bundesAPI/jobsuche-api](https://github.com/bundesAPI/jobsuche-api)).
- **Exit `4` / "not found"** — the listing no longer exists. Listings expire;
  re-run a fresh `search` to get current `refnr` values.
- **Exit `1` / "Network error"** — connectivity, DNS, or a timeout. Try again
  or raise the limit with `--timeout 60000`.
- **Empty `stellenangebote`** — the search matched nothing; broaden `--was`,
  widen `--umkreis`, or drop filters.

## Global options

These apply to every command and may be given before *or* after it:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--api-key <key>` | Override or supply the `X-API-Key` (env `JOBSUCHE_API_KEY`) |
| `--base-url <url>` | API base URL (default `https://rest.arbeitsagentur.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

### Advanced — pointing at a proxy or staging host

If you need to point at a proxy or staging server instead of the live API:

```bash
jobsuche --base-url https://proxy.internal.example search --was Pflege
```

If the API redirects across an origin boundary (different scheme/host/port),
the tool **strips your key** before following, so it never leaks to another
host.

## Learn more

- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every flag and domain term explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
