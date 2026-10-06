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
answers 401/403. Surrounding whitespace is trimmed and a blank key counts as none,
on every path. For CI / live testing the public key can be fetched out-of-band
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
digits, letters and hyphens, and some 15 % of live listings also have `_` or `:`
(`13635-dc8d6fe5_JB5255995-S`, `17296-0008159:01-S`). This is the argument you
pass to `details`.

**encryptedJobCode.** The form a `refnr` must take in the `details` URL: the
base64 encoding of the `refnr`. The client base64-encodes the `refnr` for you;
an already-base64-encoded code is detected (by an exact base64 round-trip that
decodes to a refnr — a digit first, then printable characters — not charset
sniffing) and passed through unchanged, whatever characters the refnr has.

**Stellenlokation (work location).** One entry of a listing's
`stellenlokationen` array: `adresse` (`strasse`, `hausnummer`, `plz` postal code,
`ort` city/town, `region`, `land` country) plus `breite`/`laenge`
(latitude/longitude). A listing's `entfernung` is the distance in km from the
searched location, present when `wo` was given.

**firma / arbeitgeber (employer).** The hiring organisation named on a listing
(`firma`); `arbeitgeber` is the search filter (`--arbeitgeber`) and the employer
facet. The filter matches the registered name exactly and case-sensitively
(checked live: `"Siemens AG"` 72 listings, `"Siemens"` and `"siemens ag"` none);
the facet's keys are those exact names.

**hauptberuf / berufsfeld.** `hauptberuf` is the occupation on a listing
(`alleBerufe` lists every one); `berufsfeld` (occupational field) is a broader
category usable as a search filter (`--berufsfeld`).

---

## Search parameters

**was.** Free-text job title or keyword (`--was`). An empty/whitespace value is
rejected before any request, as it is for `wo`, `berufsfeld` and `arbeitgeber`: the
CLI makes it a usage error, the library client a `JobsucheValidationError`. Dropping
it would silently run the search unfiltered, and sending it gets HTTP 400 from the
live API (an empty `was=`). Leave a filter out to search without it.

**wo.** The location to search in or around (`--wo`). The API echoes the resolved
location back as `woOutput` in the result: `bereinigterOrt` (the place it used) and
`suchmodus` (`UMKREISSUCHE`, `ORTSUCHE`, or `UNGUELTIG` when it did not recognise
the place). It never rejects a place: a typo is corrected silently (`Berln` →
`Berlin`), a garbled name can resolve to another town (`Hambrugxx Nord` →
`Tackesdorf-Nord`, 150 km away), and an unknown one gives `UNGUELTIG` and an empty
result. The CLI prints a warning on stderr in those cases (`woNote` in the
library); a postcode is unambiguous.

**umkreis.** Search radius in kilometres around `wo` (`--umkreis`), `0`–`200`: the
API answers a larger radius with HTTP 400, so the CLI and the library reject it
before any request. `0` searches the place itself (`suchmodus` `ORTSUCHE`).

**veroeffentlichtseit (published since).** Restrict results to listings published
within the last N days (`--veroeffentlicht-seit`), `0` to `100`
(`MAX_VEROEFFENTLICHT_SEIT`). The API silently ignores a larger value (the unfiltered
set comes back), so the CLI rejects it as a usage error and the library client with a
`JobsucheValidationError`.

**zeitarbeit (temp work).** Temporary-work / staffing-agency listings. By default
(no parameter) they are included with the rest; `zeitarbeit=true`
(`--zeitarbeit`) returns **only** them, `zeitarbeit=false` (`--no-zeitarbeit`)
leaves them out. Checked live: the two counts add up to the default's. Giving both
flags is a usage error, and the library takes only `true` or `false`.

**angebotsart (offer type).** A numeric code selecting the kind of offer
(`--angebotsart`): `1` job vacancy (Arbeit), `2` self-employment
(Selbstständigkeit), `4` apprenticeship or dual study (Ausbildung / Duales
Studium), `34` internship or trainee post (Praktikum / Trainee). These are the
codes in the upstream bundesAPI OpenAPI spec (`ANGEBOTSART_CODES`); the CLI rejects
any other code as a usage error and the library client with a
`JobsucheValidationError`, since the API answers one with an empty result.

**page / size.** Pagination: `page` is 1-based (the API answers `page=0` with
HTTP 400, so the CLI and the library client reject it), `size` is the page size
(`--page`, `--size`), a non-negative integer.

---

## Result envelope

**JobSearchResult.** The search response: `ergebnisliste` (the array of
listings), `maxErgebnisse` (total number of matches), `page`, `size`, `facetten`
(aggregation facets), and `woOutput` (the location the API actually searched).
(`JobSearchResult` in `src/client/types.ts`.)

**ergebnisliste.** The array of `Stellenangebot` summaries on a result page. It
is absent (not `[]`) when nothing matched or with `--size 0`; on no match
`facetten` is absent too.

**maxErgebnisse.** The total count of matching listings across all pages. Every
search answer has it, `0` included; a `200` body without it (`null`, `{}`, an
error envelope from a proxy) is rejected as a parse error, exit `1`, rather than
read as "nothing matched". A `details` answer must carry its `referenznummer`.

**facetten (facets).** Aggregated counts the API returns alongside results (e.g.
by location or employer), surfaced as a raw object.

**JobDetails.** The full single-job payload from the `details` endpoint, kept as
a faithful raw JSON object rather than a narrowed type.

---

## Search & API concepts

**Public, no-auth (read-only).** Only the open `GET` search and details endpoints
are implemented. The static `X-API-Key` is not a credential a user must obtain.

**Rate limiting / transient errors.** The API may return **429** (too many
requests) or **503**; the client retries these automatically (`--max-retries`,
default `2`, at most `10`), waiting the server's `Retry-After` when it asks for up
to 30 s, else a linear backoff. A longer `Retry-After` is not retried: the error
names the wait.

**Credential stripping on redirect.** Credentials (the `X-API-Key`, a base URL's
`user:password@`, `Authorization`, `Cookie`) go only to the base URL's origin.
They are dropped for the rest of the chain if the API redirects to another scheme,
host or port — `http:` → `https:` on the same host included — so the key cannot
leak to a third-party host. Same-origin redirects keep them. If the target then
answers `401`/`403`, the error says the redirect dropped the key (for `http:` →
`https:`: "use an https base URL") instead of blaming the key.

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `JobsucheClient`, the request engine, transport, retry/backoff, error
> types, query builder — now live in **[DEVELOPING.md](DEVELOPING.md)**.
