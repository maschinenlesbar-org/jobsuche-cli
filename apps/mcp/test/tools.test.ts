// This server's tools against a mock of the Jobsuche API (the client's answers recorded live on
// 2026-11-20), with the skills' traps as cases: each tool answers through the protocol (its
// structuredContent checked by the SDK against its output schema); a place the API didn't
// recognise is empty, not "no jobs"; a loose employer name is resolved or reported as ambiguous;
// the market comes from one size-0 request; a gone listing is empty with the reason; a refused key
// says what to check; every request carries the key and every result the BA's terms. The rules
// every server follows are the conformance tests (M1–M11).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { TOOLS } from "../src/mcp/tools.js";
import { connect } from "./harness.js";
import { KEY_SOURCE_URL } from "@maschinenlesbar.org/jobsuche-client/internal/obtain-key";
import type { HttpResponse } from "../src/mcp/api.js";
import { EMPLOYER_DEUTSCHE_BAHN_AG, EMPLOYER_DEUTSCHE_BAHN_NO_MATCH, jobsucheApi, jsonResponse, makeMockTransport, MARKET_PFLEGE_BERLIN, NO_MATCH, TEST_KEY, WAS_DEUTSCHE_BAHN } from "./helpers.js";

const API = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service";
const query = (url: string): URLSearchParams => new URL(url).searchParams;

test("five tools: the three use cases, then a page of listings and one listing", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["findJobs", "watchEmployer", "scanMarket", "searchJobs", "getJob"]);
});

test("findJobs: a ranked shortlist with details, its request as the source, the key sent, the BA's terms", async () => {
  const upstream = jobsucheApi();
  const connection = await connect({ transport: upstream });
  const result = await connection.call("findJobs", { what: "Data Engineer", where: "München", radiusKm: 30, limit: 3, details: 1 });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.equal(content["total"], 141);
  assert.equal(content["sortedBy"], "distance");
  const picks = content["picks"] as { distanceKm: number; details?: { pay: string }; url: string }[];
  assert.equal(picks.length, 3);
  assert.equal(picks[0]?.details?.pay, "KEINE_ANGABEN");
  assert.equal(content["source"], `${API}/pc/v6/jobs?was=Data%20Engineer&wo=M%C3%BCnchen&umkreis=30&page=1&size=100`);
  assert.match(String(content["licence"]), /^Quelle: Bundesagentur für Arbeit \(BA\), Jobsuche\. Not open data.*https:\/\/www\.arbeitsagentur\.de\/en\/terms-of-use/);
  assert.equal(upstream.calls.length, 2, "the search and one details request");
  assert.ok(upstream.calls.every((request) => request.headers?.["X-API-Key"] === TEST_KEY));
  await connection.close();
});

test("findJobs: a place the API didn't recognise is empty with that reason; a radius without a place is refused before any request", async () => {
  const upstream = jobsucheApi({ search: () => ({ maxErgebnisse: 0, woOutput: { suchmodus: "UNGUELTIG" } }) });
  const connection = await connect({ transport: upstream });
  const content = (await connection.call("findJobs", { what: "Pflege", where: "Qwxzy" })).structuredContent ?? {};
  assert.equal(content["status"], "empty");
  assert.match(String(content["reason"]), /did not recognise the place "Qwxzy"/);
  const before = upstream.calls.length;
  const refused = await connection.call("findJobs", { what: "Pflege", radiusKm: 30 });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]?.text ?? "", /radiusKm needs where/);
  assert.equal(upstream.calls.length, before);
  await connection.close();
});

test("watchEmployer: a loose name is resolved and named; several registered names are ambiguous", async () => {
  const upstream = jobsucheApi({
    search: (q) => {
      if (q.get("was") !== null) return WAS_DEUTSCHE_BAHN;
      return q.get("arbeitgeber") === "Deutsche Bahn AG" ? EMPLOYER_DEUTSCHE_BAHN_AG : EMPLOYER_DEUTSCHE_BAHN_NO_MATCH;
    },
  });
  const connection = await connect({ transport: upstream });
  const resolved = (await connection.call("watchEmployer", { employer: "Deutsche Bahn", limit: 2 })).structuredContent ?? {};
  assert.equal(resolved["status"], "ok", JSON.stringify(resolved).slice(0, 300));
  assert.deepEqual([resolved["employer"], resolved["resolvedFrom"], resolved["total"]], ["Deutsche Bahn AG", "Deutsche Bahn", 3536]);
  assert.equal((resolved["listings"] as unknown[]).length, 2);
  assert.equal((resolved["refnrs"] as unknown[]).length, 6, "the six refnrs, nothing else");
  const ambiguous = (await connection.call("watchEmployer", { employer: "Bahn" })).structuredContent ?? {};
  assert.equal(ambiguous["status"], "ambiguous");
  assert.ok((ambiguous["candidates"] as { name: string }[]).some((c) => c.name === "Deutsche Bahn AG"));
  await connection.close();
});

test("watchEmployer: known refnrs give what is new", async () => {
  const listed = EMPLOYER_DEUTSCHE_BAHN_AG.ergebnisliste;
  const upstream = jobsucheApi({ search: () => ({ ...EMPLOYER_DEUTSCHE_BAHN_AG, maxErgebnisse: listed.length }) });
  const connection = await connect({ transport: upstream });
  const content = (await connection.call("watchEmployer", { employer: "Deutsche Bahn AG", known: listed.slice(1).map((l) => l.referenznummer) })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal(content["newCount"], 1);
  assert.deepEqual((content["new"] as { refnr: string }[]).map((l) => l.refnr), [listed[0]?.referenznummer]);
  assert.deepEqual(content["gone"], []);
  await connection.close();
});

test("watchEmployer: the size cap never cuts the snapshot: other lists give way, else the size error names refnrs", async () => {
  // The snapshot is passed back as known: a part of it would make every listing cut from it new
  // at the next comparison. 400 listings under a cap of 9000 characters used to lose entries from
  // refnrs, the longest list.
  const ad = (n: number) => ({ referenznummer: `10001-${n}-S`, stellenangebotsTitel: `Stelle ${n}`, firma: "Deutsche Bahn AG", veroeffentlichungszeitraum: { von: "2026-11-20" } });
  const listed = Array.from({ length: 400 }, (_, i) => ad(5000 + i));
  const upstream = jobsucheApi({
    search: (q) => {
      const page = Number(q.get("page"));
      return { ...EMPLOYER_DEUTSCHE_BAHN_AG, maxErgebnisse: listed.length, ergebnisliste: listed.slice((page - 1) * 100, page * 100) };
    },
  });
  const connection = await connect({ transport: upstream, config: { maxResultChars: 9000 } });
  const result = await connection.call("watchEmployer", { employer: "Deutsche Bahn AG" });
  const first = result.structuredContent ?? {};
  assert.equal(first["status"], "ok", result.content[0]?.text);
  assert.deepEqual([...(first["refnrs"] as string[])].sort(), listed.map((l) => l.referenznummer).sort(), "every listing of the snapshot");
  assert.ok(JSON.stringify(first).length <= 9000);
  assert.match(String(first["reason"]), /listings lost entries/, "the other list gave way");
  await connection.close();
  const tight = await connect({ transport: upstream, config: { maxResultChars: 3000 } });
  const refused = await tight.call("watchEmployer", { employer: "Deutsche Bahn AG" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]?.text ?? "", /size cap \(3000 characters.*refnrs is kept whole \(a part would be wrong data\)/);
  await tight.close();
});

test("watchEmployer: refnrs is only the snapshot; passed back, nothing is new; an earlier version's size entry in known is no listing", async () => {
  // The size cap no longer cuts the snapshot, so it needs no entry that gives its size, and a
  // known shorter than its snapshot is no longer guessed about (maybeNew).
  const ad = (n: number) => ({ referenznummer: `10001-${n}-S`, stellenangebotsTitel: `Stelle ${n}`, firma: "Deutsche Bahn AG", veroeffentlichungszeitraum: { von: "2026-11-20" } });
  let listed = Array.from({ length: 30 }, (_, i) => ad(5000 + i));
  const upstream = jobsucheApi({ search: () => ({ ...EMPLOYER_DEUTSCHE_BAHN_AG, maxErgebnisse: listed.length, ergebnisliste: listed }) });
  const connection = await connect({ transport: upstream });
  const snapshot = ((await connection.call("watchEmployer", { employer: "Deutsche Bahn AG" })).structuredContent ?? {})["refnrs"] as string[];
  assert.deepEqual([...snapshot].sort(), listed.map((l) => l.referenznummer).sort());
  const round = (await connection.call("watchEmployer", { employer: "Deutsche Bahn AG", known: snapshot })).structuredContent ?? {};
  assert.deepEqual([round["newCount"], round["goneCount"], round["maybeNew"], round["reason"]], [0, 0, undefined, undefined]);
  // A snapshot of the earlier form starts with "snapshot of N listings": not a listing, so not gone.
  listed = [ad(1000), ...listed];
  const earlier = (await connection.call("watchEmployer", { employer: "Deutsche Bahn AG", known: ["snapshot of 30 listings", ...snapshot] })).structuredContent ?? {};
  assert.deepEqual([earlier["newCount"], earlier["goneCount"], earlier["maybeNew"]], [1, 0, undefined]);
  // A list of one's own is compared as it is.
  const own = (await connection.call("watchEmployer", { employer: "Deutsche Bahn AG", known: snapshot.slice(0, 10) })).structuredContent ?? {};
  assert.deepEqual([own["newCount"], own["maybeNew"]], [21, undefined]);
  await connection.close();
});

test("scanMarket: one request of size 0; employers ranked by count, agencies marked; today is bucket 0", async () => {
  const upstream = jobsucheApi({ search: () => MARKET_PFLEGE_BERLIN });
  const connection = await connect({ transport: upstream });
  const content = (await connection.call("scanMarket", { what: "Pflege", where: "Berlin", radiusKm: 25, tempAgencies: "exclude" })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal(upstream.calls.length, 1);
  assert.equal(query(upstream.calls[0]?.url ?? "").get("size"), "0");
  assert.equal(query(upstream.calls[0]?.url ?? "").get("zeitarbeit"), "false");
  assert.equal(content["tempAgencies"], "excluded");
  const top = (content["topEmployers"] as { top: { count: number; agencyLike?: boolean }[] }).top;
  assert.deepEqual(top.map((e) => e.count), [...top.map((e) => e.count)].sort((a, b) => b - a));
  assert.ok(top.some((e) => e.agencyLike === true));
  assert.equal((content["freshness"] as { today: number }).today, 3);
  assert.equal(content["source"], `${API}/pc/v6/jobs?was=Pflege&wo=Berlin&umkreis=25&zeitarbeit=false&page=1&size=0`);
  await connection.close();
});

test("searchJobs: a slice and where the next one starts; no match is empty with what to change", async () => {
  const connection = await connect({ transport: jobsucheApi() });
  const page = (await connection.call("searchJobs", { what: "Data Engineer", limit: 5 })).structuredContent ?? {};
  assert.equal(page["status"], "ok");
  assert.equal(page["nextOffset"], 5);
  assert.equal(page["source"], `${API}/pc/v6/jobs?was=Data%20Engineer&page=1&size=100`);
  await connection.close();
  const none = await connect({ transport: jobsucheApi({ search: () => NO_MATCH }) });
  const empty = (await none.call("searchJobs", { what: "Xyzzyqwvbnm" })).structuredContent ?? {};
  assert.equal(empty["status"], "empty");
  assert.match(String(empty["reason"]), /Broaden/);
  await none.close();
});

test("getJob: the whole listing and its job-board link; a gone listing is empty with the reason, not an error", async () => {
  const connection = await connect({ transport: jobsucheApi({ details: (refnr) => (refnr === "10000-1183204759-S" ? undefined : { referenznummer: refnr, stellenangebotsTitel: "Data Engineer", stellenangebotsBeschreibung: "Alles." }) }) });
  const found = (await connection.call("getJob", { refnr: "10001-1002716922-S" })).structuredContent ?? {};
  assert.equal(found["status"], "ok");
  assert.equal((found["job"] as { stellenangebotsBeschreibung: string }).stellenangebotsBeschreibung, "Alles.");
  assert.equal(found["url"], "https://www.arbeitsagentur.de/jobsuche/jobdetail/10001-1002716922-S");
  assert.equal(found["source"], `${API}/pc/v4/jobdetails/${Buffer.from("10001-1002716922-S").toString("base64")}`);
  const gone = await connection.call("getJob", { refnr: "10000-1183204759-S" });
  assert.notEqual(gone.isError, true);
  assert.equal(gone.structuredContent?.["status"], "empty");
  assert.match(String(gone.structuredContent?.["reason"]), /gone \(filled or withdrawn/);
  await connection.close();
});

test("getJob: a long description is passed whole (the end of an ad says where to apply); only a very long one is cut, and says so", async () => {
  const apply = "Bewerbung: https://example.org/bewerbungsformular/stelle-42";
  const ad = (length: number): string => `${"Wir suchen Verstärkung. ".repeat(Math.ceil(length / 24)).slice(0, length - apply.length)}${apply}`;
  const connection = await connect({ transport: jobsucheApi({ details: (refnr) => ({ referenznummer: refnr, stellenangebotsTitel: "Dozent", stellenangebotsBeschreibung: ad(refnr.startsWith("1") ? 4239 : 30_000) }) }) });
  const long = (await connection.call("getJob", { refnr: "10000-1183204759-S" })).structuredContent ?? {};
  const description = (long["job"] as { stellenangebotsBeschreibung: string }).stellenangebotsBeschreibung;
  assert.equal(description.length, 4239);
  assert.match(description, /Bewerbung: https:\/\/example\.org\/bewerbungsformular\/stelle-42$/);
  assert.equal(long["truncated"], undefined);
  const huge = (await connection.call("getJob", { refnr: "20000-1183204759-S" })).structuredContent ?? {};
  assert.match((huge["job"] as { stellenangebotsBeschreibung: string }).stellenangebotsBeschreibung, /…\[cut, 30000 characters in all\]$/);
  assert.equal(huge["truncated"], true);
  await connection.close();
});

test("getJob given the API's base64 code answers the reference number and its link, and cites the request it made", async () => {
  const upstream = jobsucheApi({ details: (refnr) => ({ referenznummer: refnr, stellenangebotsTitel: "Pflegefachkraft" }) });
  const connection = await connect({ transport: upstream });
  const code = Buffer.from("10001-1002695250-S").toString("base64");
  const found = (await connection.call("getJob", { refnr: code })).structuredContent ?? {};
  assert.equal(found["status"], "ok");
  assert.equal(found["refnr"], "10001-1002695250-S");
  assert.equal(found["url"], "https://www.arbeitsagentur.de/jobsuche/jobdetail/10001-1002695250-S");
  assert.equal(found["source"], `${API}/pc/v4/jobdetails/${code}`);
  assert.ok(upstream.calls.at(-1)?.url.endsWith(`/pc/v4/jobdetails/${code}`), "the request made is the one cited");
  await connection.close();
});

test("getJob: a listing the API answers 410 Gone for is empty with the reason, as a 404", async () => {
  const connection = await connect({ transport: makeMockTransport(() => jsonResponse({ message: "Gone" }, 410)) });
  const gone = await connection.call("getJob", { refnr: "10001-1002716922-S" });
  assert.notEqual(gone.isError, true, gone.content[0]?.text);
  assert.equal(gone.structuredContent?.["status"], "empty");
  assert.match(String(gone.structuredContent?.["reason"]), /gone \(filled or withdrawn/);
  await connection.close();
});

test("a key lookup that fails says what to change for this server, not what to do by hand with the CLI", async () => {
  const doc = (body: string, status = 200): HttpResponse => ({ status, headers: { "content-type": "text/plain; charset=utf-8" }, body: Buffer.from(body) });
  const sources: [string, HttpResponse][] = [
    ["404", doc("gone", 404)],
    ["no key", doc("# Jobsuche\n\nno key here\n")],
    ["two keys", doc('curl -H "X-API-Key: jobboerse-jobsuche" …\ncurl -H "X-API-Key: jobboerse-other" …\n')],
  ];
  for (const [what, answer] of sources) {
    const upstream = makeMockTransport((request) => (request.url === KEY_SOURCE_URL ? answer : jsonResponse(NO_MATCH)));
    const connection = await connect({ transport: upstream, env: {} });
    const result = await connection.call("searchJobs", { what: "Pflege" });
    const text = result.content[0]?.text ?? "";
    assert.equal(result.isError, true, what);
    assert.doesNotMatch(text, /by hand|this command/, `${what}: ${text}`);
    assert.match(text, /set JOBSUCHE_API_KEY in the MCP client's configuration/, what);
    assert.match(text, /jobsuche obtain-key/, what);
    assert.match(text, /jobsuche config set api-key/, what);
    assert.match(text, /next call tries the lookup again/, what);
    await connection.close();
  }
});

test("an upstream failure says what to do: the BA's side failed or couldn't be reached, try again; nothing in the request was wrong", async () => {
  const failures: [string, () => HttpResponse, RegExp][] = [
    ["500", () => jsonResponse({ message: "Interner Serverfehler" }, 500), /HTTP 500.*failed on its side.*nothing in the request was wrong.*try again in a minute/s],
    ["502 page", () => ({ status: 502, headers: { "content-type": "text/html" }, body: Buffer.from("<html>Bad Gateway</html>") }), /HTTP 502.*failed on its side.*try again in a minute/s],
    ["refused", () => { throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" }); }, /ECONNREFUSED.*could not be reached or did not answer in time.*try again shortly/s],
  ];
  for (const [what, answer, expected] of failures) {
    const connection = await connect({ transport: makeMockTransport(answer) });
    for (const [tool, args] of [["searchJobs", { what: "Pflege" }], ["getJob", { refnr: "10001-1002716922-S" }]] as const) {
      const result = await connection.call(tool, args);
      assert.equal(result.isError, true, `${what} ${tool}`);
      assert.match(result.content[0]?.text ?? "", expected, `${what} ${tool}`);
    }
    await connection.close();
  }
});

test("the deadline's advice fits every tool: each option it names is named with the tools that take it", async () => {
  const hanging = { transport: (): Promise<never> => new Promise<never>(() => {}) };
  const connection = await connect({ transport: hanging, config: { callTimeoutMs: 30 } });
  const text = (await connection.call("getJob", { refnr: "10001-1002716922-S" })).content[0]?.text ?? "";
  await connection.close();
  assert.match(text, /took longer than .* and was stopped/);
  assert.match(text, /try again shortly/);
  assert.match(text, /JOBSUCHE_API_KEY/, "a slow key lookup at the first call is named too");
  const schemas = new Map(TOOLS.map((tool) => [tool.name, Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)]));
  const pairs = [...text.matchAll(/(\w+(?: or \w+)*) \((\w+(?:, \w+)*)\)/g)];
  assert.ok(pairs.length >= 3, text);
  for (const [, options, tools] of pairs) {
    for (const tool of (tools as string).split(", ")) {
      for (const option of (options as string).split(" or ")) assert.ok(schemas.get(tool)?.includes(option), `${tool} takes no ${option}: ${text}`);
    }
  }
  const named = new Set(pairs.flatMap(([, options]) => (options as string).split(" or ")));
  for (const option of ["details", "maxPages", "limit"]) {
    assert.ok(!new RegExp(`\\b${option}\\b`).test(text) || named.has(option), `${option} named without its tools`);
  }
});

test("a refused key (the gateway's empty 403) is a tool error that says what to check", async () => {
  const connection = await connect({ transport: makeMockTransport(() => ({ ...jsonResponse({}), status: 403, headers: { "content-type": "text/plain" }, body: Buffer.from(" ") })) });
  const result = await connection.call("searchJobs", { what: "Pflege" });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /403.*a wrong or outdated API key, a refused network.*jobsuche obtain-key/s);
  assert.ok(!(result.content[0]?.text ?? "").includes(TEST_KEY));
  await connection.close();
});
