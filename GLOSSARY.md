# Glossary

A reference for the domain concepts and project-specific terms used throughout
`jobsuche-cli`. The Jobsuche domain is German; this glossary gives the English
term used in the CLI/library (where one exists) alongside the original German
field/parameter name the API uses on the wire.

> **Translation table** (the API's German names → CLI flag / English term):
>
> | German (API) | CLI flag / English term |
> | --- | --- |
> | was | `--was` — job title / keyword |
> | wo | `--wo` — location |
> | berufsfeld | `--berufsfeld` — occupational field |
> | arbeitgeber | `--arbeitgeber` — employer |
> | umkreis | `--umkreis` — radius (km) |
> | veroeffentlichtseit | `--veroeffentlicht-seit` — published since (days) |
> | zeitarbeit | `--zeitarbeit` / `--no-zeitarbeit` — only / no temp-work agencies |
> | angebotsart | `--angebotsart` — offer type code |
> | Stellenangebot | job listing / offer |
> | Stellenlokation | work location |

---

## The Jobsuche API

**Bundesagentur für Arbeit (BA).** Germany's Federal Employment Agency. It runs
the public job-search service this tool wraps.

**Jobsuche API.** The open REST API behind the BA's job board — Germany's largest
job database. Base URL `https://rest.arbeitsagentur.de`, service path
`/jobboerse/jobsuche-service`. Documented at
[jobsuche.api.bund.dev](https://jobsuche.api.bund.dev/). This tool implements its
two open, read-only endpoints (search + details).

**X-API-Key.** The API requires a static, publicly-documented API key
(`jobboerse-jobsuche`) on every request. It is not a secret, but it is **not
bundled** with the client — supply it via `--api-key`, the `JOBSUCHE_API_KEY` env
var, or the `apiKey` client option, else the header is omitted and the API
answers 401/403. For CI / live testing the public key can be fetched out-of-band
with the CLI's own `obtain-key` command (`npm run obtain-key` in a built
checkout), which reads it from the upstream source at run time.

---

## Endpoints

**Search (`/pc/v6/jobs`).** Returns a page of job-listing summaries matching the
search parameters. CLI: `search`. Library: `client.search(params)`. (The older
`/pc/v4/jobs` answers an empty 403 even with the right key since 2026-09; the
upstream documents `/pc/v6/jobs` as the search step.)

**Details (`/pc/v4/jobdetails/{encryptedJobCode}`).** Returns the full payload
for a single listing, addressed by its `encryptedJobCode`. CLI: `details`.
Library: `client.details(refnr)`.

---

## Resources & identifiers

**Stellenangebot (job listing / offer).** One job posting. In a search result it
is a summary carrying `referenznummer`, `stellenangebotsTitel`, `firma`,
`hauptberuf`, `stellenlokationen`, `entfernung`, publication/entry dates, often
salary and home-office flags, and an optional `externeURL` — the same field names
as the `details` payload. The full description is fetched separately via
`details`. (`Stellenangebot` in `src/client/types.ts`.)

**refnr / referenznummer (reference number).** The stable identifier of a
listing, returned in each search result's `referenznummer` field (called `refnr`
in older API versions and in this CLI's help) — e.g. `10001-1002716922-S`, the hex form
`14225-dafcdd47aabe512d-S`, or a purely numeric `1002716922`. It is made of
digits, letters and hyphens. This is the argument you pass to `details`.

**encryptedJobCode.** The form a `refnr` must take in the `details` URL: the
base64 encoding of the `refnr`. The client base64-encodes the `refnr` for you;
an already-base64-encoded code is detected (by an exact base64 round-trip, not
charset sniffing) and passed through unchanged.

**Stellenlokation (work location).** One entry of a listing's
`stellenlokationen` array: `adresse` (`strasse`, `hausnummer`, `plz` postal code,
`ort` city/town, `region`, `land` country) plus `breite`/`laenge`
(latitude/longitude). A listing's `entfernung` is the distance in km from the
searched location, present when `wo` was given.

**firma / arbeitgeber (employer).** The hiring organisation named on a listing
(`firma`); `arbeitgeber` is the search filter (`--arbeitgeber`) and the employer
facet.

**hauptberuf / berufsfeld.** `hauptberuf` is the occupation on a listing
(`alleBerufe` lists every one); `berufsfeld` (occupational field) is a broader
category usable as a search filter (`--berufsfeld`).

---

## Search parameters

**was.** Free-text job title or keyword (`--was`). The CLI rejects an
empty/whitespace value as a usage error (as it does for `--wo`, `--berufsfeld` and
`--arbeitgeber`); the library client omits one rather than sending it (the live API
rejects an empty `was=` with HTTP 400).

**wo.** The location to search in or around (`--wo`). The API echoes the resolved
location back as `woOutput` in the result.

**umkreis.** Search radius in kilometres around `wo` (`--umkreis`).

**veroeffentlichtseit (published since).** Restrict results to listings published
within the last N days (`--veroeffentlicht-seit`), `0` to `100`. The API silently
ignores a larger value (the unfiltered set comes back), so the CLI rejects it as a
usage error.

**zeitarbeit (temp work).** Temporary-work / staffing-agency listings. By default
(no parameter) they are included with the rest; `zeitarbeit=true`
(`--zeitarbeit`) returns **only** them, `zeitarbeit=false` (`--no-zeitarbeit`)
leaves them out. Checked live: the two counts add up to the default's.

**angebotsart (offer type).** A numeric code selecting the kind of offer
(`--angebotsart`): `1` job vacancy (Arbeit), `2` self-employment
(Selbstständigkeit), `4` apprenticeship or dual study (Ausbildung / Duales
Studium), `34` internship or trainee post (Praktikum / Trainee). These are the
codes in the upstream bundesAPI OpenAPI spec; the CLI rejects any other code as a
usage error, since the API answers one with an empty result.

**page / size.** Pagination: `page` is 1-based (the API answers `page=0` with
HTTP 400, so the CLI rejects it), `size` is the page size (`--page`, `--size`).

---

## Result envelope

**JobSearchResult.** The search response: `ergebnisliste` (the array of
listings), `maxErgebnisse` (total number of matches), `page`, `size`, `facetten`
(aggregation facets), and `woOutput` (the location the API actually searched).
(`JobSearchResult` in `src/client/types.ts`.)

**ergebnisliste.** The array of `Stellenangebot` summaries on a result page. It
is absent (not `[]`) when nothing matched or with `--size 0`; on no match
`facetten` is absent too.

**maxErgebnisse.** The total count of matching listings across all pages.

**facetten (facets).** Aggregated counts the API returns alongside results (e.g.
by location or employer), surfaced as a raw object.

**JobDetails.** The full single-job payload from the `details` endpoint, kept as
a faithful raw JSON object rather than a narrowed type.

---

## Search & API concepts

**Public, no-auth (read-only).** Only the open `GET` search and details endpoints
are implemented. The static `X-API-Key` is not a credential a user must obtain.

**Rate limiting / transient errors.** The API may return **429** (too many
requests) or **503**; the client retries these automatically with linear backoff
(`--max-retries`, default `2`).

**Credential stripping on redirect.** Credential headers (`X-API-Key`,
`Authorization`, `Cookie`) are dropped if the API redirects to a different origin,
so the key cannot leak to a third-party host. Same-origin redirects keep them.

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `JobsucheClient`, the request engine, transport, retry/backoff, error
> types, query builder — now live in **[DEVELOPING.md](DEVELOPING.md)**.
