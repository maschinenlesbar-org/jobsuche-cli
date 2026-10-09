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
An already-encoded `encryptedJobCode` is detected (by exact base64 round-trip to
a refnr: a digit first, then printable ASCII, so the `_` and `:` of live refnrs
pass too; not charset sniffing) and passed through unchanged. An empty/whitespace `refnr`
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
  answers `page=0` with HTTP 400), `umkreis` an integer `0`..`MAX_UMKREIS` (200; the
  API answers 201 and above with HTTP 400), and `size` a non-negative integer.
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
`--api-key` (CLI), the `JOBSUCHE_API_KEY` env var, or the CLI's credentials file.
Precedence is **`--api-key` > env var > the credentials file > none**; a
blank/whitespace key is treated as absent (header
omitted), and the API then answers `401`/`403`. The `JobsucheClient` constructor
owns the key's normalisation: it trims the key (a key read from a file keeps its
trailing newline), checks the trimmed key with `headerValueProblem` and sends it,
so `apiKey`, `--api-key` and `JOBSUCHE_API_KEY` give the same `X-API-Key` header or
the same `JobsucheValidationError` (CLI exit `2`). The CLI only resolves the
precedence.

The credentials file is the CLI's, not the library's: `src/cli/credentials.ts`
(`CredentialStore`, the same mechanism as openka-cli's `ka config`) and `jobsuche config`
(`src/cli/commands/config.ts`). The file is `$XDG_CONFIG_HOME/jobsuche/credentials`, else
`~/.config/jobsuche/credentials`: JSON, mode 0600 in a 0700 directory, replaced atomically;
a link, another user's file or one others can read is refused with a `JobsucheError`
naming the fix (exit `1`), and `set`/`unset` refuse a `jobsuche/` directory that is a
link, whose target the chmod to 0700 would change. It reaches the CLI through `CliDeps.credentials`, which only
`defaultDeps` sets, so a test that does not ask for one never reads the user's file;
`action()` (`src/cli/shared.ts`) reads it only when neither the flag nor the env var gave
a key, so `obtain-key` never reads it and a problem with it never blocks a key given
another way. It reads through `CredentialStore.usable` (trimmed; a hand-edited value
`config set` would refuse — `credentialProblem`: blank, whitespace or control characters
inside, or what the library's header rule refuses — is an error naming the file, exit
`1`), and `config get`/`config list` read through the same check (`config list` also
refuses a name that is not a credential name, `usableNames`). When the key comes from
the file, `action()` records the file's path in `CliDeps.storedKeyPath`, so the 401/403
ERROR names the source of the key that was sent — the file by its path, `JOBSUCHE_API_KEY`
or `--api-key` — and the empty-403 hint knows a key was sent. `config set` and `config
unset` change the file by one writer at a time (`credentials.lock` beside it, created
exclusively, waited for up to 2 s, taken over after 30 s). `config set` reads
through `CliIO.readSecret` (`readSecretFrom`: raw mode without echo on a terminal, the
whole input from a pipe, at most 64 KiB either way, `MAX_SECRET_BYTES`), never from
argv — on a terminal it drops escape sequences (arrow keys, bracketed-paste markers),
keeps every other character (so a tab is refused, as from a pipe) and refuses a paste
with more after its first line break — and checks the
value with `credentialProblem` (`credentialValueProblem` and the client's
`headerValueProblem`).

Prefer the `JOBSUCHE_API_KEY` env var over `--api-key`: a value passed on the
command line is visible to other local users through the process table (`ps`) and
is recorded in shell history. The customary key for this API is public, so the
exposure is low, but the env var is the recommended path and the `--help` text
says so. The key is only ever carried as a request header — never placed in a URL,
log line, error message, or output — and is stripped on a cross-origin redirect.

**Secrets in the CLI's output** (`redactionFor`, `withRedactedOutput` and
`usageErrorMask` in `run.ts`). Commander echoes a rejected value in its usage errors
and names an unknown command, surplus argument or unknown option as typed, so `run()`
wraps `deps.io` first and gives the log the stderr redactor, applied to each message.
The userinfo of every URL argument (`credentialsIn`, which finds it whether the value
parses or not, then `redactCredentials`) becomes `***@` on stdout and stderr. Only a
value that starts with a scheme counts (a bare `a:b@c` is a search text, a place or a
User-Agent as often as a credential), except as the `--base-url` value; the `--api-key` value and the `JOBSUCHE_API_KEY` value become
`***` on stderr (`redactSecrets`) — not on stdout, where `obtain-key` prints the
key. The forms a server echoes a userinfo back in are replaced too: the `Basic` value
and the decoded `user:password` on stdout and stderr, the password alone (4 characters
or more) on stderr only, since it may well occur in the data. A key read from the
credentials file becomes a secret of the run the moment it is
read (`deps.addSecret`, by `action()`, `config get` and `config set`), like the flag and
the env value. `config get --reveal` alone writes through the unredacted stdout
(`io.outRaw`): the value as stored is what was asked for, and the run's redaction (a
credential from a flag that happens to occur in it) would hand a script a wrong value. Commander's own error text additionally masks every argv token that is not a
short value, a lower-case word or an option name (`OrgKey-55` → `Org…`, a URL →
the URL without userinfo), so a key pasted where a command belongs is never
echoed; an `--api-key` value there is `***`. The value of `--log-format`, a format
name, is shown as typed (the record escapes it). An invalid `JOBSUCHE_API_KEY` is
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

`obtainKey()` (the `obtain-key` command) reads the key from the upstream
[bundesAPI README](https://github.com/bundesAPI/jobsuche-api) at run time. It
accepts only a value in the documented key format (`keyFormatProblem`:
lower-case letters and digits in hyphen-joined words, 8–64 characters, as the
published key has always been) and never a placeholder (`YOUR-API-KEY.`,
`your-api-key`, `xxx`, `...`, `e.g.`), a flag (`-`, `--help`), `<key>`, `$KEY` or a
value with control characters: such a value is skipped, and a source that states
no real key makes the command fail (non-zero exit, nothing on stdout) rather than
print a non-key that would make every request fail as the ambiguous empty 403.
After a same-origin redirect, the result (and the CLI's stderr note) names the
document the key was actually read from.

**Redirect safety.** When the API issues a redirect that crosses an origin
boundary (a different scheme, host, or port — `http:` → `https:` included), the
client **drops the credentials** (`X-API-Key`, the base URL's userinfo,
`Authorization`, `Cookie`) for the rest of the chain, so your key is never
forwarded to another host; see *Credentials per hop* below. Same-origin redirects
keep the key.

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
    io.ts        # injectable I/O seam (stdout/stderr, secret prompt) + injectable env + credentials file, the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
    credentials.ts # CredentialStore — the credentials file behind `jobsuche config`
    shared.ts    # option parsers, global-option resolver (incl. --api-key), JSON renderer
    commands/    # search / details, obtain-key, config
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
reaches an error (`secretScrubber`, `scrubCause`), together with the forms a server
echoes a userinfo back in (the `Basic` value, the decoded `user:password`, the
password alone from 4 characters: `echoedCredentialForms`): an error body that echoes the
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
A base URL on plain `http:` to a host other than loopback (`localhost`, `127.0.0.0/8`,
`::1`) gets one stderr warning per run, before the first request (`cleartextProblem`,
exported), a `WARN` record of `jobsuche.http`: `requests to <host> are sent unencrypted (http:, not https:)`, or naming
"the API key" / "the base URL's credentials" when they travel — never their value. Help,
version and usage errors never warn; `cleartextCredentialsProblem` stays as a deprecated
alias.
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
and cut at 500 characters ("…"; a quoted error envelope or body snippet at 200), never
inside a surrogate pair (`cutText`), so the message stays well-formed; any other value
an own message quotes from a server answer or the user's input (a redirect target, a
charset or Content-Type, a search parameter name, a base URL, the places of the `--wo`
note) is cut at `MAX_QUOTED_LENGTH` (200, `cutForMessage`), so `err.message` stays
bounded for a library caller, and so a hostile or buggy body cannot flood stderr or
a CI log; `JobsucheApiError.body` keeps the full text.

**What the API did with `wo`.** The API never fails on a place: it corrects a
typo, may resolve a garbled name to another town, or answers `suchmodus:
"UNGUELTIG"` with an empty result — all HTTP 200. `woNote(wo, result)` (in
`client.ts`, exported) returns a sentence when the place used
(`woOutput.bereinigterOrt`) neither contains nor is contained in the `wo` asked
for (NFC, case-insensitive, blanks collapsed), or when it was not recognised; the
`search` command logs it as a `WARN` record of `jobsuche.api` on stderr and keeps exit `0`.

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
an injectable `env` (for `JOBSUCHE_API_KEY`) and an optional `credentials` store
(`jobsuche config`; only `defaultDeps` sets it). Lets the whole CLI run in
tests with a mocked client and captured output — no subprocess.

**Closed pipes.** The bin shim installs `handleOutputErrors()` (in `io.ts`) before
`run()`. An EPIPE on stdout (`| head`, `| jq` exiting early) exits `0` at once,
quietly; an EPIPE on stderr is ignored, so a failed run keeps its exit code — a
usage error piped through `2>&1 | head` still exits `2`. Any other stdout write error
is an ERROR record of `jobsuche.output` (`Could not write to stdout: …`, in the format
argv asks for: `processLogger`) and exits `1`; any other stderr write error exits `1`. `test/conformance-p7-pipes-exit-codes.test.ts` spawns the built bin to
check both.

**Input validation.** [`validate.ts`](src/client/validate.ts) — the library owns
every rule about what a request may contain. A rule is a pure, exported
`…Problem(value)` function that returns the reason a value is invalid (or
`undefined`); `assertValid(name, value, problem)` turns a reason into a
`JobsucheValidationError` with the message `Invalid <name>: <reason>`. Client
methods check their input before any request, and a method that returns a promise
rejects rather than throwing synchronously. The CLI's value-parsers call the same
functions, and `run.ts` maps a `JobsucheValidationError` to exit `2`
(an `ERROR` record of `jobsuche.cli`), so CLI and library accept and reject the same inputs.

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
- **`obtain-key.test.ts`** — the key source parser (the documented key format, placeholders, conflicting keys), redirects, limits and the `--export` line.
- **`io.test.ts`** — `handleOutputErrors` (EPIPE on stdout and stderr).
- **`log.test.ts`** — the record helpers of `src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`); the CLI-level checks are P23's.
- **`config.test.ts`** — `jobsuche config` and the credentials file in a temporary directory: set/get/list/unset, no value from argv, flag > env > file precedence, a file others can read refused only when needed, links, invalid JSON, `readSecretFrom` on a pipe.

The **conformance tests** (`test/conformance-p*.test.ts`) are shared across the
`*-cli` repos (`.reviews/2026-10-06-fix-patterns.md` in the workspace); each is
copied as is and differs only in its adapter block at the top:

- `p1-cli-redaction` — no password or key in anything the CLI prints;
- `p2-library-redaction` — none in a logged client or error either;
- `p3-redirect-credentials` — credentials only to the base URL's origin, the http→https hint;
- `p4-p19-config-validation` — a `%` in the userinfo, help with a bad `JOBSUCHE_API_KEY`;
- `p5-transport-contract` — timeouts, size cap, body and header shapes for any transport;
- `p6-retry-policy` — `Retry-After`, never a zero-delay burst;
- `p7-pipes-exit-codes` — closed pipes (spawns the built bin);
- `p8-p9-p13-responses-and-errors` — charset, response shapes, wrong-typed input;
- `p10-strict-filters` — unknown parameters and repeated options;
- `p20-cleartext-warning` — one stderr warning for a plain-`http:` base URL (follow-up round
  2026-10-06);
- `p21-readme-links` — a relative README link points only at a file `files` ships (npmjs.com
  shows the README); every other document is linked by its absolute GitHub URL;
- `p23-log-format` — every stderr line is a log record (timestamp, level, topic),
  `--log-format text|jsonl`.

Cases that don't apply here are skipped in the adapter with the reason (no
base-URL environment variable; `obtain-key` does not verify the key).

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
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

## The log on stderr

Every diagnostic line on stderr is a log record (`src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `jobsuche.<area>`. `--log-format text` (the default)
writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`),
and a message longer than `MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a
code point and ends in `… (N more characters)`. The areas are `cli` (usage errors, commander's messages, unexpected errors), `api` (the API's answers: HTTP errors, the 401/403 hints, the `--wo` warning, and a malformed answer, a `JobsucheParseError`: bad JSON, the wrong shape or content type, an unknown charset), `http` (the connection, the cleartext warning), `config` (the credentials file and the `config` commands: what they stored or removed, and every failure of the file — `CredentialsError` —, whichever command read it; a usage error of a `config` command stays `cli`), `obtain-key` and `output` (a stdout write error). The no-echo prompt of `config set` stays plain. Code logs through `logOf(deps)` and never writes diagnostics
with `io.err` directly. `run()` builds the logger from argv before commander parses it
(`logFormatFromArgv`: the first `--log-format`, the value of an option that takes one
skipped, used only for the records of a parse error; a `preAction` hook then sets the
format commander parsed, so `--user-agent --log-format=jsonl` logs text),
so commander's own usage errors are records too: its `error: …` an ERROR of `cli` (a
`(Did you mean …?)` line joined to it), the help it shows after one an INFO record per
line, and the program or a command group run without its subcommand an ERROR "missing
command: `jobsuche config <subcommand>`" before that help, so every failed run has an
ERROR record (`writeCommanderErr`). The logger replaces the secrets of the
run (`redactionFor`) in each record's message before the record is cut and escaped, and
writes to the raw stderr, so a secret is kept out of the log in either format and the
frame (time, level, topic) is never touched — a key equal to `jobsuche`, a year or
`ERROR` cannot corrupt it. `CliDeps.now` makes the timestamps
testable. stdout carries data only. Conformance test P23 checks all of this, and its
body is shared across the *-cli repos.
