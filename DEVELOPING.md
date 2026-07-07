# Developing & integrating

This document covers `jobsuche-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`jobsuche`) and a typed API client
(`JobsucheClient`) for the
[Bundesagentur für Arbeit Jobsuche API](https://jobsuche.api.bund.dev/)
(`rest.arbeitsagentur.de/jobboerse/jobsuche-service`).

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed search params, listing summaries and the client options.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
jobsuche --help
```

## Library usage

```ts
import { JobsucheClient, JobsucheApiError } from "@maschinenlesbar.org/jobsuche-cli";

const client = new JobsucheClient({ apiKey: "jobboerse-jobsuche" });

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
  apiKey: "jobboerse-jobsuche",   // X-API-Key — required; no default is bundled
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

## Authentication internals

The API requires a static, publicly-documented `X-API-Key` (`jobboerse-jobsuche`)
on every request. The key is **not bundled** — pass it via `apiKey` (library),
`--api-key` (CLI), or the `JOBSUCHE_API_KEY` env var. Precedence is
**`--api-key` > env var**; a blank/whitespace key is treated as absent (header
omitted), and the API then answers `401`/`403`.

Prefer the `JOBSUCHE_API_KEY` env var over `--api-key`: a value passed on the
command line is visible to other local users through the process table (`ps`) and
is recorded in shell history. The customary key for this API is public, so the
exposure is low, but the env var is the recommended path and the `--help` text
says so. The key is only ever carried as a request header — never placed in a URL,
log line, error message, or output — and is stripped on a cross-origin redirect.

The key is publicly documented and can be fetched out-of-band (for CI or local
live testing — never from production) with the bundled script:

```bash
npm run fetch-key                                       # prints the current public key
JOBSUCHE_API_KEY="$(npm run --silent fetch-key)" jobsuche search --was Informatiker
```

The script scrapes the key from the upstream
[bundesAPI README](https://github.com/bundesAPI/jobsuche-api); it is a
dev/CI tool only and is not part of the published package.

**Redirect safety.** When the API issues a redirect that crosses an origin
boundary (a different scheme, host, or port), the client **strips credential
headers** (`X-API-Key`, `Authorization`, `Cookie`) before following it, so your
key is never forwarded to another host. Same-origin redirects keep the key.

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

- The engine accepts `defaultHeaders` that are merged into every request — the seam used to inject the `X-API-Key`. The CLI surfaces it as `--api-key` (or the `JOBSUCHE_API_KEY` env var, read through the injectable `deps.env`).
- On a cross-origin redirect the engine strips credential headers (`X-API-Key`/`Authorization`/`Cookie`) so the key never leaks to another host.
- The HTTP layer is a single `Transport` function; the default uses `node:http`/`node:https` and tests inject a mock.
- The CLI is built around injectable `CliDeps`, so the whole program can be driven in-process by tests.

### Library / technical terms

**API client.** [`JobsucheClient`](src/client/client.ts) — the typed wrapper
over the API (`search` + `details`). Usable as a library independently of the
CLI.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, follows redirects (stripping
credentials cross-origin), decodes JSON/raw responses and maps errors. Sits
between the client and the transport. `DEFAULT_BASE_URL` is
`https://rest.arbeitsagentur.de`. Caps response size (`maxResponseBytes`,
default 100 MiB) to defend against memory exhaustion.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default (`nodeHttpTransport`) uses
Node's built-in `http`/`https`; tests inject a mock. This is the only HTTP seam.

**Default headers.** The engine merges `defaultHeaders` into every request —
the seam that injects `X-API-Key`. Because no default key is bundled, the CLI
omits the header entirely when neither `--api-key` nor `JOBSUCHE_API_KEY` is
set.

**Cross-origin credential stripping.** When the API issues a redirect that
crosses an origin boundary (different scheme, host, or port), the engine strips
credential headers (`X-API-Key`, `Authorization`, `Cookie`) before following it,
so the key is never forwarded to another host. Same-origin redirects keep the key.

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are
retried automatically with backoff, up to `--max-retries`. `JobsucheApiError`
exposes `isRetryable` (true for `429`/`503`). **Divergence from the portfolio
default:** this repo uses linear backoff only (`retryDelayMs * attempt`) and does
**not** honour a `Retry-After` header — the retry count is bounded by
`--max-retries` (default 2), so there is no runaway, but the client is not as
polite to the server's stated cool-off as the shared convention would be.

**maxResponseBytes.** A cap on the response body size in bytes (`0` = unlimited;
default 100 MiB), guarding against unbounded responses.

**RawResponse.** The engine's raw-response shape (`data`/`contentType`/`status`)
— exported for completeness; the job endpoints return decoded JSON.

**Query builder.** [`buildQueryString`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, dates as ISO-8601, and encodes spaces as `%20` (not `+`).

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`)
and an injectable `env` (for `JOBSUCHE_API_KEY`). Lets the whole CLI run in
tests with a mocked client and captured output — no subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `JobsucheApiError`
(non-2xx, carries `status`/`detail`/`url`/`body`, with an `isRetryable` getter
for 429/503), `JobsucheNetworkError` (transport failure/timeout),
`JobsucheParseError` (bad JSON), all extending `JobsucheError`.

**refnr / encryptedJobCode.** `details` accepts a `refnr` (e.g.
`"10001-1002716922-S"` or purely numeric `"1002716922"`) and base64-encodes it
into the API's `encryptedJobCode`. An already-encoded code is detected by an
exact base64 round-trip (not charset sniffing) and passed through unchanged.

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

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
