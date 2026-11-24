// The skills' use cases (src/operations.ts) against recorded answers (recorded.ts): each trap the
// skills document is a test here. No request reaches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JobsucheClient } from "../src/client.js";
import { JobsucheParseError, JobsucheValidationError } from "../src/errors.js";
import type { HttpRequest } from "../src/http.js";
import { findJobs, listing, scanMarket, searchJobs, watchEmployer } from "../src/operations.js";
import type { JobSearchResult, Stellenangebot } from "../src/types.js";
import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";
import {
  DETAILS_10000_1183204759_S,
  EMPLOYER_DEUTSCHE_BAHN_AG,
  EMPLOYER_DEUTSCHE_BAHN_NO_MATCH,
  HUNT_DATA_ENGINEER_MUENCHEN,
  MARKET_PFLEGE_BERLIN,
  WAS_DEUTSCHE_BAHN,
} from "./recorded.js";

const params = (request: HttpRequest): URLSearchParams => new URL(request.url).searchParams;
const searches = (mock: MockTransport): URLSearchParams[] => mock.calls.filter((r) => r.url.includes("/pc/v6/jobs")).map(params);
const detailsCalls = (mock: MockTransport): HttpRequest[] => mock.calls.filter((r) => r.url.includes("/pc/v4/jobdetails/"));

/** A mock of the search and details endpoints: `search` answers by the request's parameters. */
function api(search: (query: URLSearchParams) => unknown, details: (refnr: string) => unknown = () => DETAILS_10000_1183204759_S): MockTransport {
  return makeMockTransport((request) => {
    const url = new URL(request.url);
    const code = url.pathname.match(/\/pc\/v4\/jobdetails\/([^/]+)$/)?.[1];
    if (code !== undefined) {
      const answer = details(Buffer.from(decodeURIComponent(code), "base64").toString("utf8"));
      return answer === undefined ? jsonResponse({ message: "not found" }, 404) : jsonResponse(answer);
    }
    return jsonResponse(search(url.searchParams));
  });
}

const client = (mock: MockTransport): JobsucheClient => new JobsucheClient({ transport: mock.transport, apiKey: "test-key-only" });
const hunt = (): JobSearchResult => structuredClone(HUNT_DATA_ENGINEER_MUENCHEN) as JobSearchResult;
const noMatch = (wo?: string): JobSearchResult => ({ maxErgebnisse: 0, page: 1, size: 100, ...(wo === undefined ? {} : { woOutput: { bereinigterOrt: wo, suchmodus: "UMKREISSUCHE" } }) });

// --- findJobs ---------------------------------------------------------------------------------

test("findJobs: one search of 100, the nearest first with a place, the top picks with their details", async () => {
  const mock = api(() => hunt());
  const answer = await findJobs(client(mock), { what: "Data Engineer", where: "München", radiusKm: 30, limit: 5, details: 2 });
  assert.equal(answer.status, "ok");
  assert.equal(answer.total, 141);
  assert.equal(answer.sortedBy, "distance");
  const [search] = searches(mock);
  assert.equal(search?.get("size"), "100");
  assert.equal(search?.get("page"), "1");
  assert.equal(search?.get("zeitarbeit"), null, "temp agencies included unless excluded");
  assert.equal(answer.tempAgencies, "included (the API's default)");
  const distances = (answer.picks ?? []).map((pick) => pick.distanceKm ?? Infinity);
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
  assert.equal(answer.picks?.length, 5);
  assert.equal(detailsCalls(mock).length, 2, "details for the top 2 only: one request each");
  assert.equal(answer.picks?.[0]?.details?.pay, "KEINE_ANGABEN");
  // The BA's own listing names the BA's home page as its partner: apply on the listing's page.
  assert.equal(answer.picks?.[0]?.details?.applyUrl, "https://www.arbeitsagentur.de/jobsuche/jobdetail/10000-1183204759-S");
  assert.equal(answer.picks?.[2]?.details, undefined);
  assert.equal(answer.more, 141 - 5);
  assert.match(answer.picks?.[0]?.url ?? "", /^https:\/\/www\.arbeitsagentur\.de\/jobsuche\/jobdetail\//);
});

test("findJobs: newest first without a place; distance sorting needs a place", async () => {
  const mock = api(() => hunt());
  const answer = await findJobs(client(mock), { what: "Data Engineer", details: 0 });
  assert.equal(answer.sortedBy, "newest");
  const dates = (answer.picks ?? []).map((pick) => pick.published ?? "");
  assert.deepEqual(dates, [...dates].sort().reverse());
  await assert.rejects(findJobs(client(mock), { what: "Data Engineer", sortBy: "distance" }), JobsucheValidationError);
});

test("findJobs: re-posts (the same title, employer and city) are merged, keeping the direct posting", async () => {
  const answer0 = hunt();
  const original = answer0.ergebnisliste?.[0] as Stellenangebot;
  assert.equal(original.externeURL, undefined);
  const repost = { ...structuredClone(original), referenznummer: "99999-repost-S", externeURL: "https://board.example/job", veroeffentlichungszeitraum: { von: "2026-11-19" } };
  answer0.ergebnisliste = [repost, ...(answer0.ergebnisliste ?? [])];
  const answer = await findJobs(client(api(() => answer0)), { what: "Data Engineer", where: "München", details: 0, limit: 25 });
  assert.equal(answer.duplicatesMerged, 1);
  const refnrs = (answer.picks ?? []).map((pick) => pick.refnr);
  assert.ok(refnrs.includes(original.referenznummer) && !refnrs.includes("99999-repost-S"), "the direct posting stays, though the re-post is newer");
});

test("findJobs: no match (ergebnisliste absent) is empty with what to change, and no details are fetched", async () => {
  const mock = api(() => noMatch("Berlin"));
  const answer = await findJobs(client(mock), { what: "Xyzzyqwvbnm", where: "Berlin" });
  assert.equal(answer.status, "empty");
  assert.match(answer.reason ?? "", /Broaden/);
  assert.deepEqual(answer.searched, { what: "Xyzzyqwvbnm", where: "Berlin" });
  assert.equal(detailsCalls(mock).length, 0);
});

test("findJobs: a place the API did not recognise is empty (nothing was searched there), not 'no jobs'", async () => {
  const answer = await findJobs(client(api(() => ({ maxErgebnisse: 0, woOutput: { suchmodus: "UNGUELTIG" } }))), { what: "Pflege", where: "Qwxzy" });
  assert.equal(answer.status, "empty");
  assert.equal(answer.place?.recognised, false);
  assert.match(answer.reason ?? "", /did not recognise the place "Qwxzy"/);
});

test("findJobs: a place the API replaced is named, and every distance is from there", async () => {
  const replaced = { ...hunt(), woOutput: { bereinigterOrt: "Tackesdorf-Nord", suchmodus: "UMKREISSUCHE" } };
  const answer = await findJobs(client(api(() => replaced)), { what: "Data Engineer", where: "Hambrugxx Nord", details: 0 });
  assert.equal(answer.status, "ok");
  assert.equal(answer.place?.searchedAround, "Tackesdorf-Nord");
  assert.match(answer.place?.note ?? "", /searched around "Tackesdorf-Nord" for where "Hambrugxx Nord"/);
});

test("findJobs: temp agencies are excluded or the only ones on request, and the answer says which", async () => {
  for (const [setting, sent, said] of [["exclude", "false", "excluded"], ["only", "true", "only temp-agency listings"]] as const) {
    const mock = api(() => hunt());
    const answer = await findJobs(client(mock), { what: "Data Engineer", tempAgencies: setting, details: 0 });
    assert.equal(searches(mock)[0]?.get("zeitarbeit"), sent);
    assert.equal(answer.tempAgencies, said);
  }
});

test("findJobs: an offer type is sent as its code; a radius without a place is refused before any request", async () => {
  const mock = api(() => hunt());
  await findJobs(client(mock), { what: "Mechatroniker", where: "Stuttgart", offerType: "apprenticeship", details: 0 });
  assert.equal(searches(mock)[0]?.get("angebotsart"), "4");
  const before = mock.calls.length;
  await assert.rejects(findJobs(client(mock), { what: "Pflege", radiusKm: 30 }), /radiusKm needs where/);
  await assert.rejects(findJobs(client(mock), { what: "  " }), JobsucheValidationError);
  await assert.rejects(findJobs(client(mock), { where: "Berlin", radiusKm: 201 }), JobsucheValidationError);
  assert.equal(mock.calls.length, before);
});

test("findJobs: a pick whose listing is gone (404) carries a note; the shortlist stands", async () => {
  const mock = api(() => hunt(), () => undefined);
  const answer = await findJobs(client(mock), { what: "Data Engineer", where: "München", details: 1 });
  assert.equal(answer.status, "ok");
  assert.match(answer.picks?.[0]?.detailsError ?? "", /gone/);
});

test("findJobs: a detail request that fails (500, the gateway's empty 403, a reset) is a note on that pick; the shortlist stands", async () => {
  let n = 0;
  const mock = makeMockTransport((request) => {
    if (!request.url.includes("/pc/v4/jobdetails/")) return jsonResponse(hunt());
    n += 1;
    if (n === 2) return jsonResponse({ message: "Interner Serverfehler" }, 500);
    if (n === 3) return { status: 403, headers: { "content-type": "text/plain" }, body: Buffer.from(" ") };
    if (n === 4) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    return jsonResponse(DETAILS_10000_1183204759_S);
  });
  const answer = await findJobs(new JobsucheClient({ transport: mock.transport, apiKey: "test-key-only", maxRetries: 0 }), { what: "Data Engineer", where: "München", details: 5 });
  assert.equal(answer.status, "ok");
  const picks = answer.picks ?? [];
  assert.ok(picks[0]?.details !== undefined && picks[4]?.details !== undefined, "the others have their details");
  assert.match(picks[1]?.detailsError ?? "", /^No details: HTTP 500 .*Interner Serverfehler.*getJob/);
  assert.match(picks[2]?.detailsError ?? "", /^No details: HTTP 403 .*getJob/);
  assert.match(picks[3]?.detailsError ?? "", /^No details: .*socket hang up.*getJob/);
  assert.equal(picks[1]?.details, undefined);
});

test("listing: a missing address is left out, never null; several places are counted", () => {
  const short = listing({ referenznummer: "1-2-S", stellenlokationen: [{}, { adresse: { ort: "Köln" } }] } as Stellenangebot);
  assert.equal("city" in short, false);
  assert.equal(short.otherPlaces, 1);
  assert.ok(!JSON.stringify(short).includes("null"));
});

// --- watchEmployer ----------------------------------------------------------------------------

test("watchEmployer: the exact name gives a profile ranked by count, freshness from the cumulative buckets", async () => {
  const mock = api((query) => (query.get("arbeitgeber") === "Deutsche Bahn AG" ? EMPLOYER_DEUTSCHE_BAHN_AG : noMatch()));
  const answer = await watchEmployer(client(mock), { employer: "Deutsche Bahn AG" });
  assert.equal(answer.status, "ok");
  assert.equal(answer.total, 3536);
  assert.equal(answer.resolvedFrom, undefined);
  const places = answer.byPlace?.top.map((entry) => entry.count) ?? [];
  assert.deepEqual(places, [...places].sort((a, b) => b - a), "ranked by count, not the API's alphabetical order");
  assert.equal(answer.byPlace?.top[0]?.label, "Berlin");
  assert.deepEqual(answer.freshness, { today: 0, sinceYesterday: 79, last7Days: 247, last14Days: 508, last28Days: 825, all: 3536 }, "no 0 bucket: nothing today");
  assert.equal(answer.read, 6);
  assert.equal(answer.complete, false);
  assert.equal(searches(mock).length, 1, "no snapshot: one page");
  assert.equal(answer.refnrs?.length, 6);
});

test("watchEmployer: a name that isn't the registered one is resolved through the listings that mention it", async () => {
  const mock = api((query) => {
    if (query.get("was") === "Deutsche Bahn") return WAS_DEUTSCHE_BAHN;
    if (query.get("arbeitgeber") === "Deutsche Bahn AG") return EMPLOYER_DEUTSCHE_BAHN_AG;
    return EMPLOYER_DEUTSCHE_BAHN_NO_MATCH;
  });
  const answer = await watchEmployer(client(mock), { employer: "Deutsche Bahn" });
  assert.equal(answer.status, "ok");
  assert.equal(answer.employer, "Deutsche Bahn AG");
  assert.equal(answer.resolvedFrom, "Deutsche Bahn");
  const [first, lookup, second] = searches(mock);
  assert.equal(first?.get("arbeitgeber"), "Deutsche Bahn");
  assert.equal(lookup?.get("was"), "Deutsche Bahn");
  assert.equal(lookup?.get("size"), "0");
  assert.equal(second?.get("arbeitgeber"), "Deutsche Bahn AG");
});

test("watchEmployer: the no-match answer's own employer facet (the nationwide top) is never read as candidates", async () => {
  // The no-match answer still carries an arbeitgeber facet (the nationwide top, Deutsche Bahn AG
  // among them): candidates come only from the listings that mention the name.
  const mock = api((query) => (query.get("was") !== null ? { maxErgebnisse: 0 } : EMPLOYER_DEUTSCHE_BAHN_NO_MATCH));
  const answer = await watchEmployer(client(mock), { employer: "Deutsche Bahn" });
  assert.equal(answer.status, "empty");
  assert.match(answer.reason ?? "", /exactly and case-sensitively/);
  assert.match(answer.reason ?? "", /not proof the employer has no openings/);
});

test("watchEmployer: several registered names are ambiguous, with the candidates; none is picked", async () => {
  const mock = api((query) => (query.get("was") === "Bahn" ? WAS_DEUTSCHE_BAHN : noMatch()));
  const answer = await watchEmployer(client(mock), { employer: "Bahn" });
  assert.equal(answer.status, "ambiguous");
  const names = answer.candidates?.map((c) => c.name) ?? [];
  assert.ok(names.includes("Deutsche Bahn AG") && names.includes("Knappschaft-Bahn-See KdöR"), names.join(" | "));
  assert.ok(!names.includes("trans regio - Deutsche Regionalbahn GmbH"));
  assert.equal(names[0], "Deutsche Bahn AG", "most listings first");
  assert.equal(searches(mock).length, 2, "no profile is fetched for a guess");
});

test("watchEmployer: the exact registered name with filters that match nothing says so, not that the name is misspelt", async () => {
  const mock = api((query) => (query.get("was") !== null ? WAS_DEUTSCHE_BAHN : noMatch()));
  const answer = await watchEmployer(client(mock), { employer: "Deutsche Bahn AG", where: "Garmisch-Partenkirchen" });
  assert.equal(answer.status, "empty");
  assert.equal(answer.employer, "Deutsche Bahn AG");
  assert.equal(answer.resolvedFrom, undefined);
  assert.match(answer.reason ?? "", /"Deutsche Bahn AG" is a registered employer name \(\d+ listings nationwide\), but none matches the other filters/);
  assert.doesNotMatch(answer.reason ?? "", /spelling/);
  assert.equal(searches(mock).length, 2, "the name lookup, and no second search under the same name");
});

test("watchEmployer: a name equal to a registered one but for case wins alone", async () => {
  const mock = api((query) => {
    if (query.get("was") !== null) return WAS_DEUTSCHE_BAHN;
    return query.get("arbeitgeber") === "Deutsche Bahn AG" ? EMPLOYER_DEUTSCHE_BAHN_AG : noMatch();
  });
  const answer = await watchEmployer(client(mock), { employer: "deutsche bahn ag" });
  assert.equal(answer.status, "ok");
  assert.equal(answer.employer, "Deutsche Bahn AG");
});

test("watchEmployer: with a snapshot, every page is read; new and gone listings are told apart", async () => {
  const all = EMPLOYER_DEUTSCHE_BAHN_AG.ergebnisliste.slice(0, 5);
  const mock = api((query) => {
    const page = Number(query.get("page"));
    return { ...EMPLOYER_DEUTSCHE_BAHN_AG, maxErgebnisse: 5, ergebnisliste: all.slice((page - 1) * 3, page * 3) };
  });
  // Pages of 100 normally; the mock serves 3 per page to make two pages.
  const known = [all[0]?.referenznummer ?? "", all[1]?.referenznummer ?? "", "10001-gone-S"];
  const answer = await watchEmployer(client(mock), { employer: "Deutsche Bahn AG", known });
  assert.equal(answer.complete, true);
  assert.equal(searches(mock).length, 2);
  assert.equal(answer.newCount, 3);
  assert.deepEqual(answer.gone, ["10001-gone-S"]);
  assert.equal(answer.listings, undefined, "with a snapshot the answer leads with what is new");
});

test("watchEmployer: a snapshot over more listings than maxPages reads says it can't tell what is gone", async () => {
  const mock = api(() => EMPLOYER_DEUTSCHE_BAHN_AG);
  const answer = await watchEmployer(client(mock), { employer: "Deutsche Bahn AG", known: ["x"], maxPages: 2 });
  assert.equal(answer.complete, false);
  assert.equal(answer.gone, undefined);
  assert.match(answer.reason ?? "", /what is gone can't be told/);
});

// --- scanMarket -------------------------------------------------------------------------------

test("scanMarket: one size-0 search; the facets ranked by count, agencies marked, today is bucket 0", async () => {
  const mock = api(() => MARKET_PFLEGE_BERLIN);
  const answer = await scanMarket(client(mock), { what: "Pflege", where: "Berlin", radiusKm: 25 });
  assert.equal(mock.calls.length, 1);
  assert.equal(searches(mock)[0]?.get("size"), "0");
  assert.equal(answer.status, "ok");
  assert.equal(answer.total, 6406);
  const top = answer.topEmployers?.top ?? [];
  assert.deepEqual(top.map((e) => e.count), [...top.map((e) => e.count)].sort((a, b) => b - a));
  assert.ok(top.some((e) => e.agencyLike === true), "staffing agencies are marked");
  assert.equal(top.find((e) => e.label === "Deutsche Bahn AG")?.agencyLike, undefined);
  assert.equal(answer.freshness?.today, 3, "today is the 0 bucket");
  assert.equal(answer.freshness?.sinceYesterday, 221);
  assert.deepEqual(answer.contract, { fixedTerm: 256, permanent: 4052, otherCode3: 2098 });
  assert.deepEqual(answer.payQuoted, { annual: 814, hourly: 1335, notStated: 6406 - 814 - 1335 });
  assert.equal(answer.workingTime?.fullTime, 5365);
  assert.equal(answer.tempAgencyListings, 914);
  assert.equal(answer.privatePlacementListings, 1605);
  assert.equal(answer.offerTypes?.apprenticeship, 310);
});

test("scanMarket and watchEmployer: matches without their facets, or facets without counts, are an error, not a market of zeros", async () => {
  const withoutFacets = (answer: object): object => Object.fromEntries(Object.entries(answer).filter(([key]) => key !== "facetten"));
  const renamed = (answer: { facetten: Record<string, { counts: object }> }): object => ({
    ...answer,
    facetten: Object.fromEntries(Object.entries(answer.facetten).map(([name, facet]) => [name, { anzahl: facet.counts }])),
  });
  for (const [what, answer] of [["no facets", withoutFacets(MARKET_PFLEGE_BERLIN)], ["counts renamed", renamed(MARKET_PFLEGE_BERLIN)]] as const) {
    await assert.rejects(scanMarket(client(api(() => answer)), { what: "Pflege" }), (err: Error) => {
      assert.ok(err instanceof JobsucheParseError, `${what}: ${err.message}`);
      assert.match(err.message, /6406 matches/);
      assert.match(err.message, /arbeitgeber/);
      return true;
    });
  }
  const partly = { ...MARKET_PFLEGE_BERLIN, facetten: { ...MARKET_PFLEGE_BERLIN.facetten, befristung: { anzahl: { "1": 3 } } } };
  await assert.rejects(scanMarket(client(api(() => partly)), { what: "Pflege" }), /befristung/);
  await assert.rejects(watchEmployer(client(api(() => withoutFacets(EMPLOYER_DEUTSCHE_BAHN_AG))), { employer: "Deutsche Bahn AG" }), JobsucheParseError);
});

test("scanMarket: no demand (no ergebnisliste, no facetten) is empty with what to broaden", async () => {
  const answer = await scanMarket(client(api(() => noMatch())), { what: "Xyzzyqwvbnm" });
  assert.equal(answer.status, "empty");
  assert.match(answer.reason ?? "", /Broaden/);
});

// --- searchJobs -------------------------------------------------------------------------------

test("searchJobs: a slice in the API's order, read in pages of 100; nextOffset while there are more; past the end says so", async () => {
  const mock = api((query) => (query.get("page") === "1" ? hunt() : noMatch()));
  const first = await searchJobs(client(mock), { what: "Data Engineer", limit: 5 });
  assert.deepEqual(first.listings?.map((l) => l.refnr), HUNT_DATA_ENGINEER_MUENCHEN.ergebnisliste.slice(0, 5).map((l) => l.referenznummer));
  assert.equal(first.nextOffset, 5);
  assert.equal(searches(mock)[0]?.get("size"), "100");
  const past = await searchJobs(client(api(() => ({ ...noMatch(), maxErgebnisse: 141 }))), { what: "Data Engineer", offset: 900, limit: 10 });
  assert.equal(past.status, "empty");
  assert.match(past.reason ?? "", /past the last match \(141\)/);
});

test("searchJobs: a slice across a page border reads both pages, and only those", async () => {
  const page = (n: number) => ({ maxErgebnisse: 250, ergebnisliste: Array.from({ length: 100 }, (_, i) => ({ referenznummer: `p${n}-${i}` })) });
  const mock = api((query) => page(Number(query.get("page"))));
  const slice = await searchJobs(client(mock), { what: "Pflege", offset: 190, limit: 20 });
  assert.deepEqual(searches(mock).map((q) => q.get("page")), ["2", "3"]);
  assert.deepEqual([slice.listings?.[0]?.refnr, slice.listings?.[19]?.refnr, slice.nextOffset], ["p2-90", "p3-9", 210]);
});

test("searchJobs: the API lists no further than its 10 000th match: a slice stops there, with no nextOffset beyond it and the reason", async () => {
  const page = (n: number) =>
    n > 100 ? { status: 400, message: "Ergebnismenge überschritten" } : { maxErgebnisse: 50_000, ergebnisliste: Array.from({ length: 100 }, (_, i) => ({ referenznummer: `p${n}-${i}` })) };
  const mock = makeMockTransport((request) => {
    const n = Number(new URL(request.url).searchParams.get("page"));
    return n > 100 ? jsonResponse(page(n), 400) : jsonResponse(page(n));
  });
  const across = await searchJobs(client(mock), { what: "Pflege", offset: 9990, limit: 20 });
  assert.deepEqual(searches(mock).map((q) => q.get("page")), ["100"], "page 101 is never asked for");
  assert.equal(across.status, "ok");
  assert.deepEqual([across.listings?.length, across.listings?.[9]?.refnr, across.nextOffset], [10, "p100-99", undefined]);
  assert.match(across.reason ?? "", /no further than its 10,000th match \(of 50000\).*narrow/i);
  const last = await searchJobs(client(mock), { what: "Pflege", offset: 9950, limit: 100 });
  assert.deepEqual([last.listings?.length, last.nextOffset], [50, undefined]);
  const before = await searchJobs(client(mock), { what: "Pflege", offset: 9800, limit: 100 });
  assert.deepEqual([before.listings?.length, before.nextOffset, before.reason], [100, 9900, undefined]);
});
