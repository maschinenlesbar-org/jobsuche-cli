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
const first = page.ergebnisliste?.[0]; // absent when nothing matched
const detail = first ? await client.details(first.referenznummer) : undefined;

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

`client.search(params)` (`/pc/v6/jobs`; the listings are `ergebnisliste`, keyed by
`referenznummer`) and `client.details(refnr)` (`/pc/v4/jobdetails`). `details` takes a
reference number (`refnr`, e.g. `"10001-1002716922-S"` or a purely numeric
`"1002716922"`) and base64-encodes it into the API's `encryptedJobCode` for you.
An already-encoded `encryptedJobCode` is detected (by exact base64 round-trip,
not charset sniffing) and passed through unchanged. An empty/whitespace `refnr`
is rejected before any request.

### What the library rejects

The client checks its input before any request and rejects with a
`JobsucheValidationError` (`Invalid <name>: <reason>`); the CLI applies the same
rules (exit `2`). The checks are exported from the package root, so a caller can
run them up front.

- **Blank search filters.** `search()` rejects a `was`, `wo`, `berufsfeld` or
  `arbeitgeber` that is empty or only whitespace (`validateSearchParams`,
  `nonBlankProblem`): dropping it would silently widen the search or run it
  unfiltered. Leave a filter out (`undefined`) to not filter by it.
- **Numeric search parameters out of range.** `veroeffentlichtseit` must be an
  integer `0`..`MAX_VEROEFFENTLICHT_SEIT` (100; the API ignores a larger value and
  returns the unfiltered set), `angebotsart` one of `ANGEBOTSART_CODES` (1, 2, 4, 34;
  any other code gets a false empty result), `page` an integer `>= 1` (the API
  answers `page=0` with HTTP 400), and `umkreis` and `size` non-negative integers.
  `NaN`, `Infinity` and fractions are rejected too (`validateSearchParams`,
  `intRangeProblem`, `angebotsartProblem`). The CLI's `--veroeffentlicht-seit`,
  `--angebotsart` and `--page` parsers use the same constants and rules.
- **Unknown search parameters.** `search()` rejects a key that is not one of
  `SEARCH_PARAMS` (`searchParamKeyProblem`): the API ignores a name it doesn't
  know (`wos`, `Was`, `extra`) and answers with the unfiltered set. A filter the
  client does not model (`befristung`, `arbeitszeit`, from the facets) can still be
  sent with `search(params, { allowUnknownParams: true })`, as one string, number
  or boolean; `__proto__` and `constructor` never. The CLI makes a repeated option
  (`--wo Berlin --wo Hamburg`, `onceOnly`) and `--zeitarbeit` with
  `--no-zeitarbeit` usage errors instead of "last one wins".
  `test/conformance-p10-strict-filters.test.ts` is the shared check.
- **Wrong-typed input.** `search()` takes an object (a string or a number used to
  run the search unfiltered); a text filter must be a string, `zeitarbeit` a
  boolean (`"false"` used to be sent as given). `details()` takes a non-blank
  string (`refnrProblem`; `undefined`, a number or an object used to fail as a raw
  `TypeError`). The client and `obtainKey()` take an options object (or nothing);
  `apiKey` must be a string, `defaultHeaders` an object, `transport` and `sleep`
  functions. Every such input is a `JobsucheValidationError`, never a raw
  `TypeError` or `RangeError`.
- **Engine options out of range** (constructor, and `obtainKey()`): see *Engine
  option ranges* below.
- **A malformed base URL** (constructor). `baseUrl` must be an absolute http(s)
  URL, checked on the raw value: no surrounding or inner whitespace or control
  characters (`new URL()` would silently trim them, while the engine appends paths
  to the raw string), no query and no fragment (`baseUrlProblem`,
  `validateBaseUrl`). Only `undefined` selects `DEFAULT_BASE_URL`. `obtainKey()`
  checks its `sourceUrl` with the same rule, a query allowed (`httpUrlProblem`).
  A path prefix and userinfo are fine, but a `%` in the userinfo must start a
  valid escape (`%25` for a literal one): Node decodes it for the Authorization
  header and would otherwise fail at request time. Userinfo is never echoed in a
  message. The
  CLI's `--base-url` parser calls the same rule. This is a configuration error, not
  a `JobsucheNetworkError`: the default transport keeps that class for its per-hop
  scheme check, which also covers redirect targets.
- **An API key that cannot be sent** (constructor). `apiKey` is trimmed first; a
  blank key means "no key", and a key with an inner control character or a
  character above U+00FF is rejected (`headerValueProblem`).
- **Header values that cannot be sent** (constructor, and `obtainKey()`).
  `userAgent` and every `defaultHeaders` value must be non-blank, free of C0
  control characters (tab allowed) and DEL, and within Latin-1
  (`headerValueProblem`); header names must be HTTP tokens (`headerNameProblem`).
  Only `undefined` selects `DEFAULT_USER_AGENT`, in the client and in
  `obtainKey()` alike; a blank `userAgent` is rejected rather than replaced. The
  CLI's `--user-agent` parser calls the same rule.

## Authentication internals

The API requires a static, publicly-documented `X-API-Key` (`jobboerse-jobsuche`)
on every request. The key is **not bundled** — pass it via `apiKey` (library),
`--api-key` (CLI), or the `JOBSUCHE_API_KEY` env var. Precedence is
**`--api-key` > env var**; a blank/whitespace key is treated as absent (header
omitted), and the API then answers `401`/`403`. The `JobsucheClient` constructor
owns the key's normalisation: it trims the key (a key read from a file keeps its
trailing newline), checks the trimmed key with `headerValueProblem` and sends it,
so `apiKey`, `--api-key` and `JOBSUCHE_API_KEY` give the same `X-API-Key` header or
the same `JobsucheValidationError` (CLI exit `2`). The CLI only resolves the
precedence.

Prefer the `JOBSUCHE_API_KEY` env var over `--api-key`: a value passed on the
command line is visible to other local users through the process table (`ps`) and
is recorded in shell history. The customary key for this API is public, so the
exposure is low, but the env var is the recommended path and the `--help` text
says so. The key is only ever carried as a request header — never placed in a URL,
log line, error message, or output — and is stripped on a cross-origin redirect.

**Secrets in the CLI's output** (`withRedactedOutput` and `usageErrorMask` in
`run.ts`). Commander echoes a rejected value in its usage errors and names an
unknown command, surplus argument or unknown option as typed, so `run()` wraps
`deps.io` first. The userinfo of every URL-like argument (`credentialsIn`, which
finds it whether the value parses or not, then `redactCredentials`) becomes `***@`
on stdout and stderr; the `--api-key` value and the `JOBSUCHE_API_KEY` value become
`***` on stderr (`redactSecrets`) — not on stdout, where `obtain-key` prints the
key. Commander's own error text additionally masks every argv token that is not a
short value, a lower-case word or an option name (`OrgKey-55` → `Org…`, a URL →
the URL without userinfo), so a key pasted where a command belongs is never
echoed; an `--api-key` value there is `***`. An invalid `JOBSUCHE_API_KEY` is
reported as `Invalid JOBSUCHE_API_KEY: <reason>`, without the value.
`test/conformance-p1-cli-redaction.test.ts` is the shared check (ten passwords,
seven URL shapes, every echo path, plus the key by flag, by environment and typed
without its flag).

The key is publicly documented and can be fetched out-of-band (for CI or local
live testing — never from production) with the bundled script:

```bash
npm run obtain-key                                      # prints the current public key
JOBSUCHE_API_KEY="$(npm run --silent obtain-key)" jobsuche search --was Informatiker
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
    types.ts     # Stellenangebot / JobSearchResult (the /pc/v6/jobs shape) + search params
    query.ts     # dependency-free query-string builder
    validate.ts  # input rules (Problem functions) + assertValid, shared by library and CLI
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects (strips creds cross-origin), default headers (auth), decoding, errors
    errors.ts    # JobsucheError / JobsucheApiError / JobsucheNetworkError / JobsucheParseError / JobsucheValidationError
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

**The transport contract is enforced by the engine** (`exchange()` in
`engine.ts`, used for every hop and by `obtainKey()`), so the documented limits
hold for any transport a library user writes (`fetch`, a node:http wrapper, a
test double), not only the built-in one:

- `timeoutMs`: the request carries an `AbortSignal` (`HttpRequest.signal`) that
  fires at the deadline; the call rejects then (`JobsucheNetworkError`) whether
  the transport stops or not.
- `maxResponseBytes`: checked on the body that came back; the message names the
  option and the CLI flag.
- Response shapes: `headers` may be a plain object with names in any case, a
  `Headers` instance or a `Map` (read lower-cased); `body` may be a Buffer, any
  ArrayBuffer view (a `Uint8Array`, from any realm), an ArrayBuffer or a string.
  A missing or non-HTTP status, no headers or no body is a `JobsucheNetworkError`.
- Whatever a transport throws (a `TypeError: fetch failed`, a string, `null`, a
  synchronous throw) becomes a `JobsucheNetworkError` naming the request, the
  original as `cause`.
- A reset connection (`ECONNRESET`, `EPIPE`, `ECONNABORTED`, undici's
  `UND_ERR_SOCKET`, anywhere in the `cause` chain; `isTransientNetworkError`) is
  retried like a 503 for a GET, within `maxRetries`. A refused connection, a DNS
  failure or a timeout is not.
- `transport` and `sleep` must be functions (else `JobsucheValidationError`).

`test/conformance-p5-transport-contract.test.ts` is the shared check;
`test/conformance-p8-p9-p13-responses-and-errors.test.ts` covers the charset, the
response shapes and the wrong-typed inputs.

**Secrets in library objects and errors.** The engine keeps the base URL and the
default headers (the `X-API-Key`) in real `#private` fields, so `console.log`,
`util.inspect` and `JSON.stringify` of a client never show the key or a
base-URL password. Server and transport text is scrubbed of them before it
reaches an error (`secretScrubber`, `scrubCause`): an error body that echoes the
request, a transport message such as fetch's "Request cannot be constructed from
a URL that includes credentials: http://user:pw@…", and the `cause` chain. URLs
in messages go through `redactUrl`, which also cuts the userinfo out of a value
that doesn't parse. `obtainKey()` names a `user:password@` source as `***@` in its
errors and in `sourceUrl`. `test/conformance-p2-library-redaction.test.ts` is the
shared check.

**Default headers.** The engine merges `defaultHeaders` into every request —
the seam that injects `X-API-Key`. Because no default key is bundled, the CLI
omits the header entirely when neither `--api-key` nor `JOBSUCHE_API_KEY` is
set.

**Credentials per hop.** The engine attaches the credentials itself, per hop:
the credential headers (`X-API-Key`, `Authorization`, `Cookie`) and the base
URL's userinfo, sent as `Authorization: Basic` (`splitUserinfo`) — a transport
never sees a URL with userinfo. They go to the start URL's origin only: a
same-origin redirect (a relative or an absolute `Location`) keeps them; one to
another scheme, host or port drops them for the rest of the chain, `http:` →
`https:` on the same host included, and `RawResponse.credentialsDropped` /
`JobsucheApiError.credentialsDropped` record where. A `401`/`403` after that names
the redirect (`credentialsDroppedHint`: "use an https base URL (…)" for
http→https), and the CLI prints that instead of its key hints (still exit `3`).
`HttpRequest.redirect` is `"manual"`: a transport must not follow redirects
(`fetch(url, { redirect: req.redirect })`). If it does and reports the final URL
(`HttpResponse.url`, fetch's `response.url`) on another origin, the request fails
as a `JobsucheNetworkError` (`followedElsewhere`) instead of being trusted; a
transport that follows redirects and reports nothing cannot be detected, so pass
`redirect` through. A non-http(s) `Location` (`file:`, `data:`) is never followed.
`obtainKey()` applies the same rules to its source (same-origin redirects only).
The CLI warns on stderr when a key or userinfo would go to a plain-`http` host
other than loopback (`cleartextCredentialsProblem`).
`test/conformance-p3-redirect-credentials.test.ts` is the shared check.

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are
retried automatically, up to `maxRetries` / `--max-retries` (default 2, at most
`MAX_RETRIES`, 10). `JobsucheApiError` exposes `isRetryable` (true for
`429`/`503`). Each retry waits `retryDelayMs * attempt` (linear; `retryDelayMs`
defaults to 200 and is at most `MAX_RETRY_AFTER_MS`, 30 000), or the server's
`Retry-After` when that is longer (`parseRetryAfter`: delay-seconds or an
IMF-fixdate; a malformed value falls back to the backoff). A `Retry-After` can
lengthen a wait, never shorten it, so `Retry-After: 0` or a date in the past is
no zero-delay burst. One above `MAX_RETRY_AFTER_MS` is **not retried at all**: the
`JobsucheApiError` surfaces at once and its message names the requested wait
("the server asked to wait 3600 s (Retry-After) … retrying sooner won't help").
Until 0.2.0 this repo ignored `Retry-After` (11 requests in 11 s against a
server asking for an hour); it now follows the portfolio default, failing early
above the cap rather than waiting it, because the BA gateway should not be asked
again inside the window it named.
`test/conformance-p6-retry-policy.test.ts` is the shared check.

**Server text in messages** (an error `detail`) is stripped of control characters
and cut at 500 characters ("…"), so a hostile or buggy body cannot flood stderr or
a CI log; `JobsucheApiError.body` keeps the full text.

**Response shape.** `search()` and `details()` check a 2xx body before returning
it (`searchResultProblem`, `jobDetailsProblem` in `validate.ts`): a search
result is an object with an integer `maxErgebnisse` and, when present, an
`ergebnisliste` array of listings with a string `referenznummer`; a listing is an
object with a string `referenznummer`. Anything else — `null`, `{}`, an array, an
error envelope such as `{"message": "quota exceeded"}` — is a `JobsucheParseError`
(CLI exit `1`) quoting what the server said, never data or "nothing found".

**Charset.** A body is decoded by the charset its `Content-Type` names (UTF-8
when it names none; `decodeBody`, a `TextDecoder`), so an `iso-8859-1` answer
keeps its umlauts and a byte order mark added by a proxy is dropped instead of
breaking `JSON.parse`. An unknown charset label is a `JobsucheParseError` naming
it. `obtainKey()` decodes its source the same way.

**maxResponseBytes.** A cap on the response body size in bytes (`0` = unlimited;
default 100 MiB), guarding against unbounded responses.

**Engine option ranges.** The `RequestEngine` constructor (and so
`new JobsucheClient(...)`) throws a `JobsucheValidationError` for a numeric option
that is not an integer in its range: `maxRetries` `0`..`MAX_RETRIES` (10),
`maxRedirects` `0`..`MAX_REDIRECTS` (10), `timeoutMs` and `maxResponseBytes` any
non-negative integer, `retryDelayMs` `0`..`MAX_RETRY_AFTER_MS`
(`intOption`, `intRangeProblem`); a `timeoutMs` above `MAX_TIMEOUT_MS` stays
allowed and is capped at it.
`obtainKey()` applies the same rule to its `timeoutMs` and `maxResponseBytes`. A
`NaN`, negative or fractional value would otherwise silently disable the timeout or
the size cap, and `Infinity` would retry without end. The CLI's `--max-retries`
parser uses the same constant and rule.

**RawResponse.** The engine's raw-response shape (`data`/`contentType`/`status`)
— exported for completeness; the job endpoints return decoded JSON.

**Query builder.** [`buildQueryString`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, dates as ISO-8601, and encodes spaces as `%20` (not `+`).

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`)
and an injectable `env` (for `JOBSUCHE_API_KEY`). Lets the whole CLI run in
tests with a mocked client and captured output — no subprocess.

**Closed pipes.** The bin shim installs `handleOutputErrors()` (in `io.ts`) before
`run()`. An EPIPE on stdout (`| head`, `| jq` exiting early) exits `0` at once,
quietly; an EPIPE on stderr is ignored, so a failed run keeps its exit code — a
usage error piped through `2>&1 | head` still exits `2`. Any other write error
exits `1`. `test/conformance-p7-pipes-exit-codes.test.ts` spawns the built bin to
check both.

**Input validation.** [`validate.ts`](src/client/validate.ts) — the library owns
every rule about what a request may contain. A rule is a pure, exported
`…Problem(value)` function that returns the reason a value is invalid (or
`undefined`); `assertValid(name, value, problem)` turns a reason into a
`JobsucheValidationError` with the message `Invalid <name>: <reason>`. Client
methods check their input before any request, and a method that returns a promise
rejects rather than throwing synchronously. The CLI's value-parsers call the same
functions, and `run.ts` maps a `JobsucheValidationError` to exit `2`
(`Error: <message>`), so CLI and library accept and reject the same inputs.

**Error types.** [`errors.ts`](src/client/errors.ts): `JobsucheApiError`
(non-2xx, carries `status`/`detail`/`url`/`body`, with an `isRetryable` getter
for 429/503; `detail` comes from the body's `detail`/`message`, or from the
gateway's `messages: [{code, path, detail}]` as `path: detail (code)`), `JobsucheNetworkError` (transport failure/timeout),
`JobsucheParseError` (bad JSON), `JobsucheValidationError` (an input rejected
before any request, including a bad base URL or client option), all extending
`JobsucheError`.

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
- **`validate.test.ts`** — `assertValid`, the exit-2 mapping of `JobsucheValidationError`, and the CLI ↔ library parity tests. `parity()` in `test/helpers.ts` runs one input through `run()` and through the library on one recording mock transport; a parity test asserts both reject without a request, or both send the identical request.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/jobsuche-cli/> in English and
<https://maschinenlesbar-org.github.io/jobsuche-cli/de/> in German — is built from `site/` with
[Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components and
[Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/jobsuche-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
