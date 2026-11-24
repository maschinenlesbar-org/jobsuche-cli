# jobsuche-mcp

An [MCP](https://modelcontextprotocol.io/) server for the [Jobsuche](https://jobsuche.api.bund.dev/)
of the Bundesagentur für Arbeit (BA), Germany's largest job database: a ranked shortlist of
openings for a candidate, one employer's openings and what is new there, a labour-market overview
for a role in a region, and any listing in full, as tools for AI agents. Read-only. The API needs
its public key, which the server finds by itself (see API key). The data is the BA's and not open
data (see Licence).

It is the MCP side of [jobsuche-cli](https://github.com/maschinenlesbar-org/jobsuche-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/jobsuche-mcp
```

This installs the **`jobsuche-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/jobsuche-mcp:latest
```

## API key

The API wants an `X-API-Key`: one public value, the same for everyone, published with the API's
community documentation. **No key is bundled.** The server takes it, at the first tool call, from:

1. `JOBSUCHE_API_KEY` in its environment (what an MCP client's config sets);
2. else the key stored with `jobsuche config set api-key` (the CLI's credentials file,
   `$XDG_CONFIG_HOME/jobsuche/credentials`, else `~/.config/jobsuche/credentials`; a file others
   can read is refused, naming the fix);
3. else it obtains the published key from the
   [bundesAPI/jobsuche-api README](https://github.com/bundesAPI/jobsuche-api), as
   `jobsuche obtain-key` does, so a rotated key needs no new release.

One INFO record on stderr says which, never the key. The key is replaced with `***` in every log
record, result and error (a key shorter than 16 characters only where it stands whole, not inside a
longer word of the data). The server takes no key on its command line. A lookup that fails (the
README unreachable) is that call's error, and the next call tries again. In a container without
network access to GitHub, pass the key: `docker run -i --rm -e JOBSUCHE_API_KEY ghcr.io/…`.

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add jobsuche -- jobsuche-mcp
# or with the image:
claude mcp add jobsuche -- docker run -i --rm ghcr.io/maschinenlesbar-org/jobsuche-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "jobsuche": { "command": "jobsuche-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "jobsuche": { "type": "stdio", "command": "jobsuche-mcp" } } }
```

To set the key yourself, add `"env": { "JOBSUCHE_API_KEY": "…" }` to the entry (the value
`jobsuche obtain-key` prints).

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
jobsuche-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http jobsuche http://127.0.0.1:3000/mcp
```

The key is public, so HTTP needs no authentication for it. In a container, publish the port on
loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/jobsuche-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/jobsuche-cli/releases) instead of
`latest`: `…/jobsuche-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/jobsuche-mcp:<version> --repo maschinenlesbar-org/jobsuche-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `findJobs` | Jobs for a candidate: one search of up to 100 listings, re-posts merged (the direct posting kept), nearest first with a place or newest first, the top picks with their details (pay when stated, home office, working time, contract, start, where to apply). |
| `watchEmployer` | One employer's openings as a profile (top places, occupations and fields, freshness, apprenticeships, the newest listings), its registered name resolved from a loose one; with an earlier answer's reference numbers, what is new and what is gone. |
| `scanMarket` | A labour-market overview from one request without listings: total demand, top employers (agencies marked), places, occupations, fields, pay cadence, contract and working-time mix, home office, freshness. |
| `searchJobs` | Listings in the API's own order, a slice at a time (offset, limit), with the same filters. |
| `getJob` | One listing in full by its reference number: the description, pay, working time, contract, places, where to apply, and its link on the BA's job board. |

The tools carry the API's traps so a model doesn't have to: the API never fails on a place it
doesn't know (it searches nothing there, or around another town, so every distance is from
there), and the answer says so instead of reading as "no jobs"; on no match the list and the
facets are missing, not empty; temp-agency listings are included unless excluded, and every answer
says which; the employer filter is the registered name, exact and case-sensitive ("Siemens AG",
not "Siemens"), so a loose name is resolved through the listings that mention it, or asked back
when it may mean several; the facets list at most 100 labels alphabetically, so they are ranked
here; the freshness counts are cumulative and "today" is its own bucket; staffing and placement
agencies, which top many employer rankings, are marked; a listing gone since the search says so.

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from (whole, never cut like the data; an answer a redirect fetched from another
host says so there: "… (answered by https://other.example after a redirect)", and a WARN record
names both) and the data licence. A text over 2000 characters (over 20 000 in `getJob`, whose
description is the whole ad, with where to apply at its end) is cut and ends in `…[cut, N
characters in all]`, and the answer says `truncated`. An answer over `--max-result-chars` first
loses entries from the end of its page (then `nextOffset` says where to go on), then has its longest
texts cut further (each with that mark) or, when that isn't enough, its other lists shortened
(`reason` names them); a list keeps its first entry, `notes` stay whole, and the answer says
`truncated`. One that can't be cut down so far is a tool error that says to ask for less. A failure
is a tool error that says what to change (one over 5000 characters loses its middle, never its end,
where the reason is); the gateway's empty 403 (a wrong key, a refused network, now and then a valid
key) says what to check.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API host (default https://rest.arbeitsagentur.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one of
  those origins gets CORS (its preflight answered, the answers readable). With `--auth-token-file
  <path>` every request must send `Authorization: Bearer <token>` (the file holds one token of at
  least 32 characters, mode 600, owned by the user the server runs as, a regular file (a FIFO is
  refused at once, never waited on); read once at start; `(umask 077; openssl rand -hex 32 >
  mcp-token)` makes one); anything else is answered 401. Exposed beyond localhost (it logs a warning
  then), it belongs behind a proxy that authenticates or at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses the requests to a host that answers HTTP 429 (as long as its Retry-After
  asks, at most 30 s; those to another host go on), and stops a tool call after its deadline (a tool
  that has read part of its answer by then may answer with that part, and says so). A tool answers
  with one request (`findJobs` adds one per enriched pick, at most 5; `watchEmployer` reads more
  pages only to compare with a snapshot). A request those limits would hold longer than it or its
  call may wait is not sent: the call fails at once, naming the limit and when to ask again (and the
  log says so).
- **Results are data.** Text from the API, keys included, is cleaned (control, bidi, zero-width, tag
  and other invisible characters removed, but an emoji keeps its joiners; the API key echoed with
  one inside is still replaced; a key that cleaning makes equal to another stays, as `name~2`), but
  it is still other people's text (the employers' ads): a model can be told things in it. The server
  can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new connection
  and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal ends it at
  once. On stdio a signal ends it at once; when stdin ends, it first answers the requests it has
  read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/jobsuche-cli/blob/main/LICENSING.md)).
Data: the listings are the Bundesagentur für Arbeit's, served live; this is **not open data**.
The BA asserts copyright and restricts use to job placement, its terms forbid robots and similar
automated access, and the ads are the employers' content and may hold personal data (contact
names and addresses, with GDPR obligations of their own). Use it for a personal job search; don't
redistribute the data or use it commercially without the BA's permission
([terms](https://www.arbeitsagentur.de/en/terms-of-use),
[DATA_LICENSE.md](https://github.com/maschinenlesbar-org/jobsuche-cli/blob/main/DATA_LICENSE.md)).
Every result carries this note in its `licence` field. We provide the tool, not the data: running
the server as a service for others may need the BA's permission.
