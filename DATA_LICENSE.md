# Data license

> **This tool does not include, host, or redistribute any data.**
> `jobsuche-cli` is a *client*. It only accesses data served live by the
> **Bundesagentur für Arbeit (BA)**. That data is the BA's and is governed by
> **the BA's** terms, summarized below. The license of this CLI's own source code
> is a separate matter — see [LICENSING.md](LICENSING.md).

> [!WARNING]
> **This data is not open data.** The BA asserts full copyright, restricts use to
> job-placement purposes, and its terms forbid automated/robot access. Treat
> results as suitable for personal lookup only. Do **not** redistribute the data
> or use it commercially without the BA's prior permission.

| | |
|---|---|
| **Data provider** | Bundesagentur für Arbeit (German Federal Employment Agency) |
| **API / source** | `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service` · docs: https://jobsuche.api.bund.dev/ |
| **Data license** | **Proprietary / restricted.** No `dl-de`/Creative Commons/open license applies. |
| **Authoritative terms** | https://www.arbeitsagentur.de/datenschutz (Nutzungsbedingungen; EN: https://www.arbeitsagentur.de/en/terms-of-use) |
| **Attribution** | No license to attribute under; a source credit does not make reuse compliant. |
| **Commercial use** | Prohibited / restricted to placement purposes. |
| **Redistribution / modification** | Not granted; terms forbid "robots, web spiders or similar technologies". |

## Notes & caveats

- The BA's Nutzungsbedingungen assert full copyright and restrict use to
  job-placement-related purposes. The BA publicly objected (2021) to the API
  being openly documented, while conceding listings are "basically publicly
  accessible" — a genuine legal grey zone that it has not enforced.
- Job ads are **third-party employer content**; the BA holds only a "simple right"
  for placement purposes and cannot pass redistribution rights downstream.
- Records may contain **personal data** (employer contacts/emails) — handling it
  triggers GDPR/DSGVO obligations independent of copyright.
- This CLI consumes a **community-documented** endpoint; the static API key is a
  client identifier, not a grant of reuse rights. Listings are volatile (expire).

## Sources

- https://www.arbeitsagentur.de/en/terms-of-use — BA terms (copyright, no-robots, restricted use)
- https://netzpolitik.org/2021/open-data-arbeitsagentur-kaempft-gegen-offene-schnittstelle/ — BA's stated objections
- https://github.com/bundesAPI/jobsuche-api — community docs (no data license declared)

---

*Good-faith summary compiled 2026-06-16; not legal advice. The provider's terms
are authoritative and can change — verify at the source. Do not rely on this data
for commercial use or redistribution without the BA's permission.*
