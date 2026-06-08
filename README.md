# jobsuche-cli

A TypeScript **API client** and **command-line interface** for the
[Bundesagentur für Arbeit Jobsuche API](https://jobsuche.api.bund.dev/)
(`rest.arbeitsagentur.de/jobboerse/jobsuche-service`) — Germany's largest **job
database**: search listings and fetch full job details.

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed search params, listing summaries and the client options.
- **Auth handled** — sends the static, publicly-documented `X-API-Key` automatically; override with `--api-key`.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.

## Authentication

The Jobsuche API requires a static, publicly-documented `X-API-Key`
(`jobboerse-jobsuche`). This client sends it **by default**, so no setup is
needed. Override it with `--api-key`, the `JOBSUCHE_API_KEY` env var, or the
`apiKey` client option.

## Requirements

- Node.js **>= 20** (uses the stable built-in test runner, ESM and top-level `await`).

## Install

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link` / global install:
jobsuche --help
```

---

## CLI usage

Every command prints pretty JSON to stdout (`--compact` for a single line).

### Global options

| Option | Description |
| --- | --- |
| `--base-url <url>` | API base URL (default `https://rest.arbeitsagentur.de`) |
| `--api-key <key>` | override the `X-API-Key` (env `JOBSUCHE_API_KEY`); a blank/whitespace value is ignored and the default key is used |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line |

Credential headers (`X-API-Key` / `Authorization` / `Cookie`) are **not**
forwarded if the API redirects to a different origin, so the key cannot leak to
a third-party host. Same-origin redirects keep them.

Global options are accepted either before or after the command, e.g. both
`jobsuche --compact search --was Informatiker` and
`jobsuche search --was Informatiker --compact` work.

### Commands

```text
search [--was <kw>] [--wo <loc>] [--berufsfeld] [--arbeitgeber]
       [--umkreis <km>] [--veroeffentlicht-seit <days>] [--zeitarbeit]
       [--angebotsart <code>] [--page <n>] [--size <n>]
details <refnr>           full job details (the refnr is base64-encoded for you)
```

### Examples

```bash
# Software jobs in Berlin
jobsuche search --was Informatiker --wo Berlin --size 10

# Within 50 km, published in the last 7 days
jobsuche search --was Pflege --wo "München" --umkreis 50 --veroeffentlicht-seit 7

# Details for a listing (refnr from a search result)
jobsuche details 10001-1002716922-S
```

Exit codes: `0` success; `2` for usage errors (bad flag/value, missing command);
`3` on any `401`/`403` from the API (typically a key problem, but a
resource-level forbidden or quota/rate reason also lands here — the server's
`detail` is surfaced when present); `4` on a `404` from the API; `1` for any
other error, including network/transport failures and JSON parse failures.

---

## Library usage

```ts
import { JobsucheClient, JobsucheApiError } from "@maschinenlesbar.org/jobsuche-cli";

const client = new JobsucheClient(); // sends the public X-API-Key by default

const page = await client.search({ was: "Informatiker", wo: "Berlin", size: 10 });
const first = page.stellenangebote[0];
const detail = first ? await client.details(first.refnr) : undefined;

// Override the key if you have your own:
const custom = new JobsucheClient({ apiKey: "my-key" });

try {
  await client.details("does-not-exist");
} catch (err) {
  if (err instanceof JobsucheApiError) console.error(err.status, err.detail);
}
```

### Client options

```ts
new JobsucheClient({
  apiKey: "jobboerse-jobsuche",   // X-API-Key (defaults to the public key)
  baseUrl: "https://rest.arbeitsagentur.de",
  timeoutMs: 15_000,
  maxRetries: 3,
  maxResponseBytes: 50 << 20,
  userAgent: "my-app/1.0",
  transport: customTransport,
});
```

### Methods

`client.search(params)` and `client.details(refnr)`. `details` takes a
reference number (`refnr`, e.g. `"10001-1002716922-S"` or a purely numeric
`"1002716922"`) and base64-encodes it into the API's `encryptedJobCode` for you.
An already-encoded `encryptedJobCode` is detected (by exact base64 round-trip,
not charset sniffing) and passed through unchanged. An empty/whitespace `refnr`
is rejected before any request.

---

## Architecture

```
src/
  client/
    types.ts     # Stellenangebot / JobSearchResult + search params
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects (strips creds cross-origin), default headers (auth), decoding, errors
    errors.ts    # JobsucheError / JobsucheApiError / JobsucheNetworkError / JobsucheParseError
    client.ts    # JobsucheClient — search + details over the engine (injects X-API-Key)
  cli/
    io.ts        # injectable I/O seam (stdout/stderr) + injectable env
    shared.ts    # option parsers, global-option resolver (incl. --api-key), JSON renderer
    commands/    # search / details
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The engine accepts `defaultHeaders` that are merged into every request — the seam used to inject the
  `X-API-Key`. The CLI surfaces it as `--api-key` (or the `JOBSUCHE_API_KEY` env var).
- The HTTP layer is a single `Transport` function; the default uses `node:http`/`node:https` and tests inject a mock.
- The CLI is built around injectable `CliDeps`, so the whole program can be driven in-process by tests.

---

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, and redirect handling (incl. credential-header stripping on cross-origin redirects) — mocked transport.
- **`client.test.ts`** — the X-API-Key header, search params and the refnr base64 encoding (incl. hyphenless numeric refnrs and empty-refnr rejection) — mocked transport.
- **`cli.test.ts`** — command parsing, `--api-key` / `JOBSUCHE_API_KEY` precedence, 401/403 and other exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

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
