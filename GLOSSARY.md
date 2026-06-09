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
> | zeitarbeit | `--zeitarbeit` — temp-work agencies |
> | angebotsart | `--angebotsart` — offer type code |
> | Stellenangebot | job listing / offer |
> | Arbeitsort | work location |

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
(never from the CLI) via `scripts/fetch-api-key.mjs` (`npm run fetch-key`).

---

## Endpoints

**Search (`/pc/v4/jobs`).** Returns a page of job-listing summaries matching the
search parameters. CLI: `search`. Library: `client.search(params)`.

**Details (`/pc/v4/jobdetails/{encryptedJobCode}`).** Returns the full payload
for a single listing, addressed by its `encryptedJobCode`. CLI: `details`.
Library: `client.details(refnr)`.

---

## Resources & identifiers

**Stellenangebot (job listing / offer).** One job posting. In a search result it
is a summary carrying `beruf`, `titel`, `refnr`, `arbeitgeber`, `arbeitsort`,
publication/entry dates and an optional `externeUrl`. Full detail is fetched
separately via `details`. (`Stellenangebot` in `src/client/types.ts`.)

**refnr (reference number).** The stable identifier of a listing, returned in
each search result's `refnr` field — e.g. `10001-1002716922-S`, the hex form
`14225-dafcdd47aabe512d-S`, or a purely numeric `1002716922`. It is made of
digits, letters and hyphens. This is the argument you pass to `details`.

**encryptedJobCode.** The form a `refnr` must take in the `details` URL: the
base64 encoding of the `refnr`. The client base64-encodes the `refnr` for you;
an already-base64-encoded code is detected (by an exact base64 round-trip, not
charset sniffing) and passed through unchanged.

**hashId.** An additional listing identifier the API stamps on a `Stellenangebot`.

**Arbeitsort (work location).** The location of a listing as the API serialises
it: `plz` (postal code), `ort` (city/town), `strasse` (street), `region`, `land`
(country), `koordinaten` (`lat`/`lon`), and `entfernung` (distance in km from the
searched location, present only on radius searches).

**Arbeitgeber (employer).** The hiring organisation named on a listing; also a
search filter (`--arbeitgeber`).

**beruf / berufsfeld.** `beruf` is the occupation/job title on a listing;
`berufsfeld` (occupational field) is a broader category usable as a search
filter (`--berufsfeld`).

---

## Search parameters

**was.** Free-text job title or keyword (`--was`). An empty/whitespace value is
treated as "not provided" (the live API rejects an empty `was=` with HTTP 400).

**wo.** The location to search in or around (`--wo`). The API echoes the resolved
location back as `woOutput` in the result.

**umkreis.** Search radius in kilometres around `wo` (`--umkreis`).

**veroeffentlichtseit (published since).** Restrict results to listings published
within the last N days (`--veroeffentlicht-seit`).

**zeitarbeit (temp work).** Boolean flag to include temporary-work / staffing
agencies (`--zeitarbeit`).

**angebotsart (offer type).** A numeric code selecting the kind of offer
(`--angebotsart`), e.g. a regular job vacancy vs. a self-employment, trainee or
secondment posting. Passed through verbatim to the API.

**page / size.** Pagination: `page` is 1-based, `size` is the page size
(`--page`, `--size`).

---

## Result envelope

**JobSearchResult.** The search response: `stellenangebote` (the array of
listings), `maxErgebnisse` (total number of matches), `page`, `size`, `facetten`
(aggregation facets), and `woOutput` (the location the API actually searched).
(`JobSearchResult` in `src/client/types.ts`.)

**stellenangebote.** The array of `Stellenangebot` summaries on a result page.

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
