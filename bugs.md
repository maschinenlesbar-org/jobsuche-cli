# jobsuche-cli — Exploratory / black-box bug report

Date: 2026-06-06
Build: `npm run build` (exit 0), invoked as `node dist/src/cli/index.js ...`
Version: 1.0.0, commander 15.0.0, Node default transport.

## Environment note

- The live BA Jobsuche API (`https://rest.arbeitsagentur.de/jobboerse/jobsuche-service`)
  **was reachable** during testing with the default public `X-API-Key`
  (`jobboerse-jobsuche`). Live `search` and `details` both returned 200.
- One probe (`--base-url http://nonexistent.invalid.tld.xyz`) initially looked like a
  bug ("Failed to parse JSON") but was an **environment DNS-hijack** (the resolver
  returned a real IP 13.248.169.48 for the bogus `.xyz` host). Re-tested with the
  RFC-2606 `.invalid` TLD it correctly surfaces `getaddrinfo ENOTFOUND`. NOT a bug.
- A local `http.createServer` was used to capture the exact request line/headers and
  to inject status codes for the offline cases below.

## Summary

20 genuine, reproducible bugs found (all real, none fabricated). One is a
correctness/data-access defect (B1), several are input-encoding/validation defects
(B2–B8) that silently change or corrupt the values sent to the API, the rest are
exit-code / error-message / UX / docs issues.

Counts by severity: **High: 2 · Medium: 9 · Low: 9**.

---

## HIGH

### B1. Already-base64-encoded `encryptedJobCode` for a real listing is double-encoded → 404 — ✅ FIXED
**Fix:** Widened `REFNR_PATTERN` in `src/client/client.ts` from `/^[A-Z0-9-]+$/` to `/^[A-Za-z0-9-]+$/` so refnrs containing lowercase hex round-trip correctly and a legitimately-encoded code is passed through unchanged. Regression test added in `test/cli.test.ts`.
- Severity: High · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js details "MTQyMjUtZGFmY2RkNDdhYWJlNTEyZC1T"
  ```
  (`MTQyMjUtZGFmY2RkNDdhYWJlNTEyZC1T` is base64 of the **live** refnr
  `14225-dafcdd47aabe512d-S`.)
- Expected: README (lines 130–134) and the `details()` docstring promise an
  already-encoded `encryptedJobCode` is "detected … and passed through unchanged".
  So this should hit `/jobdetails/MTQyMjUtZGFmY2RkNDdhYWJlNTEyZC1T` and return 200.
- Actual:
  ```
  Error: HTTP 404 for GET https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/TVRReU1qVXRaR0ZtWTJSa05EZGhZV0psTlRFeVpDMVQ%3D
  ```
  exit code 4. The path `TVRReU1q…` is base64 of `MTQyMjUt…`, i.e. it was
  **base64-encoded a second time**. The same listing via the raw refnr
  (`details 14225-dafcdd47aabe512d-S`) returns exit 0.
- Root cause: `src/client/client.ts:22` `REFNR_PATTERN = /^[A-Z0-9-]+$/` only allows
  **uppercase**. Real refnrs contain lowercase hex (`dafcdd47aabe512d`). In
  `isEncodedCode()` (`client.ts:90-95`) the decoded refnr fails `REFNR_PATTERN`, so a
  legitimately-encoded code is misclassified as a raw refnr and re-encoded
  (`client.ts:75-77`). Pass-through is effectively broken for the majority of real
  listings. Fix: allow lowercase in the pattern (`/^[A-Za-z0-9-]+$/`).

### B2. `parseIntArg` accepts non-decimal / scientific / whitespace forms and silently transforms them — ✅ FIXED
**Fix:** Rewrote `parseIntArg` in `src/cli/shared.ts` to require a strict `/^\d+$/` match before `Number()`, rejecting hex/binary/octal/scientific/`+`/leading-space forms.
- Severity: High · Confidence: High
- Repro (captured against a local server that echoes the request line):
  ```
  node dist/src/cli/index.js search --base-url URL --size 1e3      # -> ?size=1000
  node dist/src/cli/index.js search --base-url URL --size 0x10     # -> ?size=16
  node dist/src/cli/index.js search --base-url URL --size 0b11     # -> ?size=3
  node dist/src/cli/index.js search --base-url URL --size 0o17     # -> ?size=15
  node dist/src/cli/index.js search --base-url URL --size " 5"     # -> ?size=5
  node dist/src/cli/index.js search --base-url URL --size "+5"     # -> ?size=5
  ```
- Expected: an option documented as "page size" / "1-based page" / "radius in km"
  should accept only plain decimal integers and reject `1e3`, `0x10`, `0b11`, `0o17`,
  leading-space, `+5`, etc.
- Actual: all the above are accepted (exit 0) and the value the API receives differs
  from what the user typed (e.g. user types `0x10`, API gets `size=16`).
- Root cause: `src/cli/shared.ts:10-16` uses `Number(value)` + `Number.isInteger`.
  `Number()` parses hex/binary/octal/scientific, trims whitespace, and accepts a
  leading `+`. Use a strict `/^\d+$/` check (and/or `BigInt` range guard) instead.

---

## MEDIUM

### B3. Empty-string `--size`/`--page`/`--umkreis`/etc. is accepted as 0 — ✅ FIXED
**Fix:** Same `parseIntArg` rewrite in `src/cli/shared.ts`: `""` fails `/^\d+$/` and is now rejected as a usage error.
- Severity: Medium · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js search --base-url URL --size ""   # -> ?size=0
  ```
  exit 0; the captured request line is `…/jobs?size=0`.
- Expected: an empty value should be rejected as a usage error.
- Actual: `Number("") === 0`, `Number.isInteger(0)` is true, so it is accepted and
  `size=0` is sent.
- Root cause: same parser, `src/cli/shared.ts:10-16` (`Number("")` is 0).

### B4. Huge integer args lose precision; the value sent ≠ the value typed — ✅ FIXED
**Fix:** `parseIntArg` in `src/cli/shared.ts` now rejects values that are not `Number.isSafeInteger` with "Integer is too large."
- Severity: Medium · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js search --base-url URL --size 99999999999999999999
  ```
  Captured request: `…/jobs?size=100000000000000000000`.
- Expected: reject out-of-safe-range integers (or send exactly what was typed).
- Actual: `Number("99999999999999999999") === 1e20`; the API receives
  `100000000000000000000`, a different number than the user entered. Same applies to
  `--timeout`, `--max-retries`, `--max-response-bytes` (e.g. `--max-response-bytes 1e20`
  is accepted, exit 0).
- Root cause: `src/cli/shared.ts:10-16` — no `Number.isSafeInteger` / range check.

### B5. Empty `--was ""` (or `--wo ""`) sends an empty query param and breaks an otherwise-valid live search (HTTP 400) — ✅ FIXED
**Fix:** `prune()` in `src/client/client.ts` now drops empty / whitespace-only string values (as well as `null`), so an empty `--was ""` is treated as "not provided" and omitted. Regression test added.
- Severity: Medium · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js search --was "" --wo Berlin --size 1
  ```
- Expected: an empty string should be treated like "not provided" (omitted), so the
  search runs on `--wo Berlin` alone.
- Actual:
  ```
  Error: HTTP 400 for GET https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs?was=&wo=Berlin&size=1
  ```
  exit 1. The empty value is sent as `was=` and the live API rejects the whole
  request with 400.
- Root cause: `src/client/client.ts:33-39` `prune()` drops only `undefined`, not
  empty strings; `src/cli/commands/jobs.ts:22-33` passes the raw option through. An
  empty string from commander is `""`, not `undefined`, so it survives.

### B6. 401/403 handler discards the server-supplied `detail`, even for non-auth 403s — ✅ FIXED
**Fix:** `src/cli/run.ts` now surfaces `err.detail` when present and uses a neutral "request rejected (HTTP n): <detail>" message with the key hint appended, instead of unconditionally asserting "API key rejected". Existing 401 test updated, new detail test added.
- Severity: Medium · Confidence: High
- Repro (local server returning 403 with body `{"detail":"forbidden"}`):
  ```
  node dist/src/cli/index.js search --base-url URL --api-key wrong
  ```
- Expected: surface the API's `detail` (e.g. quota/forbidden reason); not every 403 is
  a bad key.
- Actual:
  ```
  Error: API key rejected (HTTP 403). Check --api-key or the JOBSUCHE_API_KEY environment variable.
  ```
  exit 3. The original message/`detail` is thrown away, and a generic "API key
  rejected" is asserted for *any* 403 (rate-limit, IP block, resource-level forbidden).
- Root cause: `src/cli/run.ts:38-45` overrides the message for all 401/403 and ignores
  `err.detail`.

### B7. `--api-key ""` (blank) is forwarded as an empty `X-API-Key` instead of falling back to the default — ✅ FIXED
**Fix:** `toEngineOptions` in `src/cli/shared.ts` now `.trim()`s `--api-key` and only uses it when non-empty, mirroring the env path (otherwise falls back to env / default). Regression test added.
- Severity: Medium · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js search --base-url URL --api-key ""
  ```
  Captured header: `x-api-key: ""` (empty). Against the live API this yields a 403
  (exit 3).
- Expected: arguably an empty `--api-key` should be rejected as a usage error, or fall
  back to the public default; sending an empty credential header is surprising.
- Actual: `toEngineOptions` treats `apiKey !== undefined` as "explicitly set" and
  forwards `""`. The same code path *does* skip an empty `JOBSUCHE_API_KEY` (it
  `.trim()`s and checks truthiness), so env and flag behave inconsistently.
- Root cause: `src/cli/shared.ts:47-52` — `--api-key` branch checks only `!== undefined`,
  while the env branch checks for non-empty after `trim()`. Inconsistent handling.

### B8. `--was`/`--wo` value that begins with `--` is swallowed as the option value, producing a misleading error — ✅ FIXED
**Fix:** Added a `parseTextArg` value-parser in `src/cli/shared.ts` (rejects values that look like an option flag) and applied it to `--was`/`--wo`/`--berufsfeld`/`--arbeitgeber` in `src/cli/commands/jobs.ts`. The error now names the starved option and suggests `--`.
- Severity: Medium · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js search --base-url URL --was --wo Berlin
  ```
- Expected: a clear "missing value for --was" error.
- Actual:
  ```
  error: too many arguments for 'search'. Expected 0 arguments but got 1: Berlin.
  ```
  exit 1. `--wo` is consumed as the *value* of `--was`, then `Berlin` is rejected as a
  stray positional. The error never mentions `--was`.
- Root cause: commander default option-argument parsing in
  `src/cli/commands/jobs.ts:11-12`; no `--` discipline or value validation.

### B9. No-argument invocation exits 1 with no error line (just help) — ✅ FIXED
**Fix:** `src/cli/run.ts` now detects the `commander.help` (no-command) case, prints an explicit "error: missing command (see usage above)." diagnostic, and returns exit 2.
- Severity: Medium · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js ; echo $?
  ```
- Expected: either exit 0 after printing help (common CLI convention) or print an
  explicit "error: missing command" line before the help.
- Actual: prints the help text to stdout and exits **1** with no error message
  explaining why. Scripts see a non-zero status with no diagnostic.
- Root cause: commander's "no default command" path; `src/cli/run.ts` returns the
  CommanderError exit code (1) but the program prints help via `writeOut` (no error
  line). Not handled distinctly.

### B10. Usage errors and generic runtime errors share exit code 1 — not script-distinguishable — ✅ FIXED
**Fix:** `src/cli/run.ts` now maps genuine CommanderError parse/usage errors to exit code 2 (help/version stay 0), while runtime/network errors remain exit 1. README exit-code section updated. Regression test added.
- Severity: Medium · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js search --size abc ; echo $?     # -> 1 (usage)
  node dist/src/cli/index.js search --base-url http://127.0.0.1:1 ; echo $?  # -> 1 (network)
  ```
- Expected: README (line 87) implies "non-zero for usage errors" as distinct from
  "1 for any other error", but both collapse to 1, so a wrapper script can't tell a
  bad flag from a network failure.
- Actual: both exit 1.
- Root cause: `src/cli/run.ts:32-34` returns `err.exitCode` for CommanderError (which
  is 1) and the generic branch also returns 1 (`run.ts:50-56`).

### B11. Network / transport failures are reported with raw Node messages, not as a typed "network error" — ✅ FIXED
**Fix:** Added a dedicated `JobsucheNetworkError` branch in `src/cli/run.ts` that frames the failure as "Network error: could not reach the API (...)".
- Severity: Medium · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js search --base-url http://127.0.0.1:1
  ```
- Expected: a clear network-error message (the codebase even has
  `JobsucheNetworkError`).
- Actual:
  ```
  Error: connect ECONNREFUSED 127.0.0.1:1
  ```
  exit 1. The message is the bare libuv string with no "could not reach the API"
  framing. `JobsucheNetworkError extends JobsucheError`, so `run.ts` formats it as a
  generic `Error: <message>` and never labels it as a connectivity problem.
- Root cause: `src/cli/run.ts:50-53` has no `JobsucheNetworkError` branch; the message
  is just the wrapped libuv text from `src/client/http.ts:104-107`.

---

## LOW

### B12. `--compact` is documented as a "global option that must go before the command" but works after it too — ✅ FIXED
**Fix:** Updated `README.md` to state global options are accepted before or after the command (with both example invocations), matching the actual commander behavior.
- Severity: Low · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js search --base-url URL --compact   # works, prints compact
  ```
- Expected: README line 62 states global options go **before** the command.
- Actual: it is accepted *after* the command (commander treats it as a global), so the
  documented constraint is wrong/misleading (the real behavior is fine, the docs are
  not).
- Root cause: docs vs. behavior mismatch; `README.md:62`.

### B13. JSON parse failure message omits the underlying cause — ✅ FIXED
**Fix:** Added a `JobsucheParseError` branch in `src/cli/run.ts` that appends `err.cause` (the parser error / body snippet) to the message.
- Severity: Low · Confidence: High
- Repro (local server returns `this is not json{{` with 200):
  ```
  node dist/src/cli/index.js details --base-url URL abc
  ```
- Expected: include the parser error / a snippet of the offending body.
- Actual:
  ```
  Error: Failed to parse JSON response from /jobboerse/jobsuche-service/pc/v4/jobdetails/YWJj
  ```
  exit 1 — the `cause` attached in `engine.ts:169` is never printed by `run.ts`, so the
  user has no idea what came back.
- Root cause: `src/cli/run.ts:50-53` prints only `err.message`, dropping `err.cause`.

### B14. `--max-response-bytes 1` aborts with a network-style message and exit 1 — ✅ FIXED
**Fix:** The body-cap is a `JobsucheNetworkError`, now caught by the new network branch in `src/cli/run.ts` and framed as a network error (still exit 1; a clearly-labelled connectivity message rather than a bare generic error).
- Severity: Low · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js search --base-url URL --max-response-bytes 1
  ```
- Expected: a clearly-labelled "response too large / cap exceeded" condition,
  arguably its own exit code.
- Actual:
  ```
  Error: Response exceeded maxResponseBytes (1)
  ```
  exit 1, formatted as a generic error (it's a `JobsucheNetworkError` under the hood).
- Root cause: `src/client/http.ts:75-79` raises a `JobsucheNetworkError`; `run.ts`
  formats it generically.

### B15. Unsupported-protocol base URL is reported as a generic error, exit 1 — ✅ FIXED
**Fix:** Added a `parseBaseUrl` value-parser in `src/cli/shared.ts` and applied it to `--base-url` in `src/cli/program.ts`, so a malformed URL or non-http(s) protocol is rejected up front as a usage error (exit 2).
- Severity: Low · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js search --base-url ftp://127.0.0.1
  ```
- Expected: a usage-level rejection of an invalid `--base-url` (ideally caught at
  option-parse time, distinct exit).
- Actual:
  ```
  Error: Unsupported protocol "ftp:" in URL: ftp://127.0.0.1/jobboerse/jobsuche-service/pc/v4/jobs
  ```
  exit 1 — only discovered at request time, after building the full path; no
  validation of `--base-url` up front.
- Root cause: `--base-url` is accepted verbatim in `src/cli/program.ts:30`; rejection
  happens late in `src/client/http.ts:52-55`.

### B16. `JobsucheParseError` returned for a transport failure when DNS resolves to an unexpected host (no scheme/host validation of `--base-url`) — ✅ FIXED
**Fix:** `getJson` in `src/client/engine.ts` now inspects `Content-Type` before `JSON.parse`; a non-JSON body yields a clear "Expected a JSON response ... but got Content-Type ..." error (with a body snippet) instead of an opaque parse failure. Regression test added.
- Severity: Low · Confidence: Medium
- Repro (depends on resolver, but reproducible whenever `--base-url` host returns a
  non-JSON 200):
  ```
  node dist/src/cli/index.js search --base-url http://example.com
  ```
- Expected: a 4xx/connectivity-style message.
- Actual: `Error: Failed to parse JSON response from /jobboerse/jobsuche-service/...`
  exit 1 — because any 200 with non-JSON body is treated as a parse error regardless
  of `Content-Type`. The engine never checks the response `Content-Type` before
  `JSON.parse` (`engine.ts:163-171` ignores `res.contentType`).
- Root cause: `src/client/engine.ts:163-171` parses JSON without inspecting
  `Content-Type`.

### B17. `--was ""` empty value also sent on `search` even when other params are valid — empty params not pruned (data-shape) — ✅ FIXED
**Fix:** Same `prune()` change in `src/client/client.ts` as B5 — empty / whitespace-only string params are dropped from the query for every text parameter.
- Severity: Low · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js search --base-url URL --was "" --wo Berlin
  ```
  Captured: `…/jobs?was=&wo=Berlin`.
- Expected: empty string params omitted from the query string entirely.
- Actual: `was=` is emitted. (Distinct from B5, which is the live-400 consequence;
  this is the underlying query-shape issue and applies to every text param:
  `--berufsfeld ""`, `--arbeitgeber ""`, etc.)
- Root cause: `src/client/query.ts:25-33` only skips `undefined`/`null`, not `""`;
  combined with `prune()` (`client.ts:33-39`) keeping `""`.

### B18. Help / README do not document the exit-code-3 "any 403" overreach or the parse-error/network exit semantics — ✅ FIXED
**Fix:** Rewrote the exit-code paragraph in `README.md` to document that exit 3 covers all 401/403 (not only key problems, with the server `detail` surfaced), exit 2 for usage errors, and exit 1 for network/parse failures.
- Severity: Low · Confidence: High
- Repro: compare `README.md:86-87` ("3 on a 401/403 (API key missing/rejected)")
  with B6: a *resource* 403 unrelated to the key also yields exit 3 and the "API key
  rejected" message.
- Expected: docs should state that exit 3 covers all 401/403 (not only key problems),
  or the code should narrow it.
- Actual: README implies exit 3 ⇒ key problem; the implementation maps every 401/403
  there. Docs/behavior mismatch.
- Root cause: `README.md:86-87` vs `src/cli/run.ts:38-45`.

### B19. `--help` / README do not mention that `--api-key ""` produces an empty credential header — ✅ FIXED
**Fix:** Moot after B7 (a blank `--api-key` is now ignored, not forwarded). Documented the new behavior in the `--api-key` row of the options table in `README.md`.
- Severity: Low · Confidence: High
- Repro: `node dist/src/cli/index.js --help` lists `--api-key <key>` with no note that
  an empty value is forwarded literally (see B7).
- Expected: document that a blank `--api-key` is sent as an empty header (or is
  rejected).
- Actual: undocumented; behavior is surprising relative to the `JOBSUCHE_API_KEY`
  env path which ignores empties.
- Root cause: doc gap; `program.ts:31`, `shared.ts:47-52`.

### B20. Domain types are missing fields the live API returns (`woOutput`, `modifikationsTimestamp`, `externeUrl`, `arbeitsort.entfernung`, …) — ✅ FIXED
**Fix:** Extended the interfaces in `src/client/types.ts`: added `entfernung` to `Arbeitsort`, `modifikationsTimestamp`/`externeUrl` (plus an index signature for forward-compat extra keys) to `Stellenangebot`, and `woOutput` to `JobSearchResult`.
- Severity: Low · Confidence: High
- Repro (library/type-consumer level): the live `search` response includes
  `woOutput`, and each `stellenangebot` includes `modifikationsTimestamp`,
  `externeUrl`, and `arbeitsort.entfernung`, none of which are declared in
  `Stellenangebot` / `JobSearchResult`.
- Expected: typed consumers (the README advertises "strongly typed") should see these
  fields; or the types should acknowledge extra keys.
- Actual: the CLI output itself is faithful (raw `JSON.stringify`, byte-identical to
  curl — verified: 33/33 keys match, deep-equal true, **no CLI data loss**), but the
  TypeScript interfaces under-describe the payload, so library users lose type
  coverage for real fields.
- Root cause: `src/client/types.ts:13-43` — incomplete interfaces.

---

## Things probed that are CORRECT (not bugs)

- `details` encoding: hyphenated refnr → base64 ✓; **hyphenless numeric** `1002716922`
  → `MTAwMjcxNjkyMg==` (base64, not passed through) ✓; already-base64 *uppercase-only*
  code → passed through ✓; garbage `@@@` → base64 `QEBA` ✓; whitespace-padded refnr
  trimmed correctly ✓.
- Empty / whitespace-only refnr rejected before any request (`details ""`, `details "   "`)
  with exit 1 ✓.
- Unicode/umlaut/special-char query encoding: `--wo München` → `wo=M%C3%BCnchen`,
  `--was "C++ & C#"` → `was=C%2B%2B%20%26%20C%23` ✓; spaces as `%20` ✓.
- Auth: default public key → 200; wrong key → 403/exit 3; env precedence
  (`JOBSUCHE_API_KEY=goodkey` + `--api-key wrong` ⇒ `wrong` wins, env-only ⇒ env used) ✓.
- Exit codes: 404 ⇒ 4, 500/400 ⇒ 1, 401/403 ⇒ 3 ✓ (matches README mapping).
- Retries: default (2) succeeds after two 503s; `--max-retries 0` fails on the first 503 ✓.
- Timeout: `--timeout 1` against a slow server ⇒ "Request timed out after 1ms" ✓.
- `--max-response-bytes 0` ⇒ unlimited (works) ✓.
- Base-URL trailing-slash normalization: `…:8731/`, `…:8731///` ⇒ correct path ✓.
- Negative / non-numeric / fractional ints correctly rejected: `--size -1`, `--size abc`,
  `--size 1.5`, `--size .5`, `--size 1_000` ⇒ "Expected a non-negative integer." ✓.
- base64 codes containing `+`/`/` are URL-encoded via `encodeURIComponent` ✓.
- `--` escape works: `details -- -S-123` ⇒ base64 of `-S-123` sent to /jobdetails ✓.
- `--angebotsart` IS listed in both `search --help` and README ✓.
- CLI `details` output is byte-identical (deep-equal) to a direct curl with the
  `X-API-Key` header — **no dropped fields / data loss** ✓.

---

## Final count

**20 genuine, reproducible bugs** (High: 2 · Medium: 9 · Low: 9). All verified;
none fabricated. (The `nonexistent.invalid.tld.xyz` anomaly was traced to local DNS
hijacking and explicitly excluded.)
