// The use cases of the skills as library functions, built on the client: each composes the
// client's calls and carries the traps the skills document, so no caller (the CLI, the MCP
// server's use-case tools, a library user) has to know them.
// - findJobs: a shortlist for a candidate: searched with the right filters, de-duplicated,
//   sorted by distance or freshness, the top picks enriched with their details
//   (jobsuche-job-hunt);
// - watchEmployer: one employer's open listings as a recruiting profile, its registered name
//   resolved when the one given finds nothing, and what is new or gone since a snapshot
//   (jobsuche-employer-watch);
// - scanMarket: a labour-market overview from the search's facets alone, which count the whole
//   matching set (jobsuche-market-scan);
// - searchJobs: one page of listings in the API's order.
//
// Traps that hold for all of them: the API never fails on a place it doesn't know (it searches
// nothing there, or around another town: `place` says so); on no match `ergebnisliste` and
// `facetten` are absent, not empty; temp-agency listings are included unless excluded, and every
// answer says which; a facet lists at most the top 100 labels, in alphabetical order, not ranked.
// Ambiguity is reported, never guessed; an empty answer says what was searched and what to change.

import type { JobsucheClient } from "./client.js";
import { JobsucheApiError, JobsucheValidationError } from "./errors.js";
import type { JobDetails, JobSearchParams, JobSearchResult, JsonObject, Stellenangebot } from "./types.js";
import { MAX_UMKREIS, MAX_VEROEFFENTLICHT_SEIT, normalizeText, textProblem, type Angebotsart } from "./validate.js";

/** What every operation answers: ok, ambiguous (ask which), or empty (with the reason). */
export type OperationStatus = "ok" | "ambiguous" | "empty";

// --- Shared ----------------------------------------------------------------------------------

/** The offer types (`angebotsart`) by name. */
export const OFFER_TYPES = { job: 1, "self-employment": 2, apprenticeship: 4, internship: 34 } as const satisfies Record<string, Angebotsart>;
export type OfferType = keyof typeof OFFER_TYPES;

/** Temp-agency (Zeitarbeit) listings: with the rest (the API's default), left out, or only those. */
export type TempAgencies = "include" | "exclude" | "only";

/** The filters every search operation takes. */
export interface JobFilters {
  /** A job title or keyword (`was`). */
  what?: string | undefined;
  /** An occupational field (`berufsfeld`), a wider net than `what`. */
  field?: string | undefined;
  /** A place or postcode (`wo`). */
  where?: string | undefined;
  /** Kilometres around `where` (`umkreis`, 0–200). */
  radiusKm?: number | undefined;
  /** Published within the last N days (`veroeffentlichtseit`, 0–100). */
  publishedWithinDays?: number | undefined;
  offerType?: OfferType | undefined;
  /** The employer's registered name, matched exactly and case-sensitively (`arbeitgeber`). */
  employer?: string | undefined;
  /** Default "include", as the API. */
  tempAgencies?: TempAgencies | undefined;
}

/** The filters as an answer echoes them (`searched`): only those given. */
export type Searched = Partial<Record<keyof JobFilters, string | number>>;

/** The page size the operations read with: the most the API answers in one page. */
export const PAGE_SIZE = 100;

/** The search parameters for `filters`, checked: a usage error before any request. */
export function searchParams(filters: JobFilters): JobSearchParams {
  const text = (name: string, value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const problem = textProblem(value);
    if (problem !== undefined) throw new JobsucheValidationError(`Invalid ${name}: ${problem}`);
    return normalizeText(value);
  };
  const where = text("where", filters.where);
  if (filters.radiusKm !== undefined && where === undefined) {
    throw new JobsucheValidationError("radiusKm needs where: the radius is measured around that place.");
  }
  if (filters.radiusKm !== undefined && !(Number.isInteger(filters.radiusKm) && filters.radiusKm >= 0 && filters.radiusKm <= MAX_UMKREIS)) {
    throw new JobsucheValidationError(`Invalid radiusKm: expected a whole number from 0 to ${MAX_UMKREIS}.`);
  }
  const days = filters.publishedWithinDays;
  if (days !== undefined && !(Number.isInteger(days) && days >= 0 && days <= MAX_VEROEFFENTLICHT_SEIT)) {
    throw new JobsucheValidationError(`Invalid publishedWithinDays: expected a whole number from 0 to ${MAX_VEROEFFENTLICHT_SEIT}.`);
  }
  if (filters.offerType !== undefined && !(filters.offerType in OFFER_TYPES)) {
    throw new JobsucheValidationError(`Invalid offerType: expected one of ${Object.keys(OFFER_TYPES).join(", ")}.`);
  }
  const temp = filters.tempAgencies ?? "include";
  if (!["include", "exclude", "only"].includes(temp)) throw new JobsucheValidationError("Invalid tempAgencies: expected include, exclude or only.");
  return {
    was: text("what", filters.what),
    berufsfeld: text("field", filters.field),
    wo: where,
    umkreis: filters.radiusKm,
    veroeffentlichtseit: days,
    angebotsart: filters.offerType === undefined ? undefined : OFFER_TYPES[filters.offerType],
    arbeitgeber: text("employer", filters.employer),
    zeitarbeit: temp === "include" ? undefined : temp === "only",
  };
}

/** The filters' names, in the order `searched` lists them. */
const FILTER_KEYS: readonly (keyof JobFilters)[] = ["what", "field", "where", "radiusKm", "publishedWithinDays", "offerType", "employer", "tempAgencies"];

/** The filters given, for `searched`. */
function searchedOf(filters: JobFilters): Searched {
  const out: Searched = {};
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (typeof value === "string") out[key] = normalizeText(value);
    else if (typeof value === "number") out[key] = value;
  }
  return out;
}

/** What the temp-agency setting did, in words. */
function tempAgenciesNote(temp: TempAgencies | undefined): string {
  return temp === "exclude" ? "excluded" : temp === "only" ? "only temp-agency listings" : "included (the API's default)";
}

/** What the API did with `where`, when that is not simply the place asked for. */
export interface PlaceNote {
  /** The place the API searched around (`woOutput.bereinigterOrt`). */
  searchedAround?: string;
  /** False when the API did not recognise the place and searched nothing there. */
  recognised: boolean;
  /** What to tell the user, or to change. */
  note: string;
}

function placeNote(client: JobsucheClient, where: string | undefined, result: JobSearchResult): PlaceNote | undefined {
  const note = client.woNote(where, result);
  if (note === undefined) return undefined;
  const recognised = result.woOutput?.suchmodus !== "UNGUELTIG";
  const around = typeof result.woOutput?.bereinigterOrt === "string" ? result.woOutput.bereinigterOrt : undefined;
  return { recognised, ...(around === undefined ? {} : { searchedAround: around }), note: note.replace(/^the API/, "The API").replace(/--wo/, "where") };
}

/** The listing on the job board of the Bundesagentur für Arbeit. */
export function jobboerseUrl(refnr: string): string {
  return `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(refnr)}`;
}

/** One listing, short: what a shortlist or a profile shows of it. */
export interface Listing {
  /** The reference number: the input to getJob / `details`. */
  refnr: string;
  title?: string;
  occupation?: string;
  employer?: string;
  city?: string;
  postcode?: string;
  /** More places the listing names (a listing can name several). */
  otherPlaces?: number;
  /** Kilometres from the searched place (only with `where`). */
  distanceKm?: number;
  /** The current publication date (YYYY-MM-DD). */
  published?: string;
  /** The first publication, when earlier (a re-published listing). */
  firstPublished?: string;
  /** The desired start. */
  start?: string;
  /** ARBEIT, AUSBILDUNG, SELBSTAENDIGKEIT, … */
  offerType?: string;
  homeOffice?: boolean;
  salaryFrom?: number;
  salaryTo?: number;
  fixedSalary?: number;
  /** The posting on a third-party board, when it lives there (a re-post signal). */
  externalUrl?: string;
  /** The listing on the Bundesagentur's job board. */
  url: string;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** A search listing in short. Missing fields stay missing ("not given"), never null. */
export function listing(entry: Stellenangebot): Listing {
  const places = Array.isArray(entry.stellenlokationen) ? entry.stellenlokationen : [];
  const address = places[0]?.adresse;
  const published = str(entry.veroeffentlichungszeitraum?.von);
  const first = str(entry.datumErsteVeroeffentlichung);
  const out: Listing = { refnr: entry.referenznummer, url: jobboerseUrl(entry.referenznummer) };
  const set = <K extends keyof Listing>(key: K, value: Listing[K] | undefined): void => {
    if (value !== undefined) out[key] = value;
  };
  set("title", str(entry.stellenangebotsTitel));
  set("occupation", str(entry.hauptberuf));
  set("employer", str(entry.firma));
  set("city", str(address?.ort));
  set("postcode", str(address?.plz));
  if (places.length > 1) out.otherPlaces = places.length - 1;
  set("distanceKm", num(entry.entfernung));
  set("published", published);
  if (first !== undefined && first !== published) out.firstPublished = first;
  set("start", str(entry.eintrittszeitraum?.von));
  set("offerType", str(entry.stellenangebotsart));
  if (typeof entry.homeofficemoeglich === "boolean") out.homeOffice = entry.homeofficemoeglich;
  set("salaryFrom", num(entry.gehaltsspanneVon));
  set("salaryTo", num(entry.gehaltsspanneBis));
  set("fixedSalary", num(entry.festgehalt));
  set("externalUrl", str(entry.externeURL));
  // `url` last, after the fields: the order a reader expects.
  const { url, ...rest } = out;
  return { ...rest, url } as Listing;
}

/** A facet's labels ranked by count (the API lists them alphabetically), the top `top`. */
export interface RankedFacet {
  top: { label: string; count: number }[];
  /** How many labels the API listed (at most 100: the long tail is cut by the API). */
  listed: number;
}

function counts(facets: JsonObject | undefined, name: string): Record<string, number> {
  const facet = facets?.[name];
  const raw = facet !== null && typeof facet === "object" && !Array.isArray(facet) ? (facet as JsonObject)["counts"] : undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [label, count] of Object.entries(raw)) if (typeof count === "number" && Number.isFinite(count)) out[label] = count;
  return out;
}

/** The facet `name` ranked, highest count first (ties by label), its first `top` labels. */
export function rankFacet(facets: JsonObject | undefined, name: string, top: number): RankedFacet {
  const entries = Object.entries(counts(facets, name)).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
  return { top: entries.slice(0, top).map(([label, count]) => ({ label, count })), listed: entries.length };
}

/**
 * How fresh the matches are, from the `veroeffentlichtseit` facet. Its counts are cumulative
 * (`7` includes everything from the last 7 days, `alle` is the total), and "today" is the `0`
 * bucket, not `1` (`1` counts yesterday's too); a bucket the API leaves out is 0.
 */
export interface Freshness {
  today: number;
  sinceYesterday: number;
  last7Days: number;
  last14Days: number;
  last28Days: number;
  all: number;
}

function freshness(facets: JsonObject | undefined, total: number): Freshness | undefined {
  const c = counts(facets, "veroeffentlichtseit");
  if (Object.keys(c).length === 0) return undefined;
  return { today: c["0"] ?? 0, sinceYesterday: c["1"] ?? 0, last7Days: c["7"] ?? 0, last14Days: c["14"] ?? 0, last28Days: c["28"] ?? 0, all: c["alle"] ?? total };
}

/** The `ergebnisliste` of a result: absent on no match or with size 0, which is not an error. */
function listingsOf(result: JobSearchResult): Stellenangebot[] {
  return Array.isArray(result.ergebnisliste) ? result.ergebnisliste : [];
}

const fold = (text: string): string => text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/** Why `value` is not a whole number from `min` to `max`, as a usage error. */
function whole(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max) throw new JobsucheValidationError(`Invalid ${name}: expected a whole number from ${min} to ${max}.`);
  return n;
}

const newestFirst = (a: Listing, b: Listing): number => (b.published ?? "").localeCompare(a.published ?? "") || (a.employer ?? "").localeCompare(b.employer ?? "");

// --- findJobs (jobsuche-job-hunt) ------------------------------------------------------------

/** What a pick's details add (`details`), in short. */
export interface PickDetails {
  description?: string;
  /** True when the description was cut: getJob has it whole. */
  descriptionCut?: boolean;
  salaryFrom?: number;
  salaryTo?: number;
  /** The pay statement (`verguetungsangabe`), e.g. JAHRESGEHALT, KEINE_ANGABEN. */
  pay?: string;
  homeOffice?: boolean;
  homeOfficeType?: string;
  workingTime?: string[];
  /** `vertragsdauer`: UNBEFRISTET, BEFRISTET, KEINE_ANGABE. */
  contract?: string;
  start?: string;
  suitableForCareerChangers?: boolean;
  /** Where to apply: the third-party posting, else the partner's page, else the listing on the BA's job board. */
  applyUrl?: string;
}

export interface FindJobsInput extends JobFilters {
  /** "distance" (needs `where`; the default with it) or "newest" (the default without). */
  sortBy?: "distance" | "newest" | undefined;
  /** Picks on the shortlist (1–25, default 10). */
  limit?: number | undefined;
  /** How many of the top picks get their details (0–5, default 3): one request each. */
  details?: number | undefined;
}

export interface JobShortlist {
  status: OperationStatus;
  searched: Searched;
  tempAgencies: string;
  /** Every match of the search (`maxErgebnisse`). */
  total: number;
  place?: PlaceNote;
  /** How many listings were read and ranked (the first page of up to 100). */
  read?: number;
  /** Re-posts merged: the same title, employer and city. */
  duplicatesMerged?: number;
  sortedBy?: "distance" | "newest";
  picks?: (Listing & { details?: PickDetails; detailsError?: string })[];
  /** Matches not on the shortlist (re-posts included). */
  more?: number;
  reason?: string;
}

/** The longest description a pick carries; getJob has it whole. */
export const PICK_DESCRIPTION_LENGTH = 1200;

const WORKING_TIME: [string, string][] = [
  ["arbeitszeitVollzeit", "full-time"],
  ["arbeitszeitTeilzeitVormittag", "part-time mornings"],
  ["arbeitszeitTeilzeitNachmittag", "part-time afternoons"],
  ["arbeitszeitTeilzeitAbend", "part-time evenings"],
  ["arbeitszeitTeilzeitFlexibel", "part-time flexible"],
  ["arbeitszeitSchichtNachtWochenende", "shifts, nights or weekends"],
  ["arbeitszeitHeimTelearbeit", "home or telework"],
  ["arbeitszeitMinijob", "minijob"],
];

/** The BA's home page, which its own listings name as their partner (`allianzpartnerUrl`). */
const BA_HOME = /^https?:\/\/(?:www\.)?arbeitsagentur\.de\/?$/i;

/** A listing's details in short (`details`). */
export function pickDetails(details: JobDetails): PickDetails {
  const out: PickDetails = {};
  const description = str(details["stellenangebotsBeschreibung"]);
  if (description !== undefined) {
    const cut = description.length > PICK_DESCRIPTION_LENGTH;
    out.description = cut ? `${description.slice(0, PICK_DESCRIPTION_LENGTH)}…` : description;
    if (cut) out.descriptionCut = true;
  }
  const from = num(details["gehaltsspanneVon"]);
  const to = num(details["gehaltsspanneBis"]);
  if (from !== undefined) out.salaryFrom = from;
  if (to !== undefined) out.salaryTo = to;
  const pay = str(details["verguetungsangabe"]);
  if (pay !== undefined) out.pay = pay;
  if (typeof details["homeofficemoeglich"] === "boolean") out.homeOffice = details["homeofficemoeglich"];
  const homeType = str(details["homeofficetyp"]);
  if (homeType !== undefined) out.homeOfficeType = homeType;
  const time = WORKING_TIME.filter(([key]) => details[key] === true).map(([, label]) => label);
  if (time.length > 0) out.workingTime = time;
  const contract = str(details["vertragsdauer"]);
  if (contract !== undefined) out.contract = contract;
  const start = details["eintrittszeitraum"];
  const von = start !== null && typeof start === "object" && !Array.isArray(start) ? str(start["von"]) : undefined;
  if (von !== undefined) out.start = von;
  if (typeof details["quereinstiegGeeignet"] === "boolean") out.suitableForCareerChangers = details["quereinstiegGeeignet"];
  // A listing of the BA's own names the BA's home page as its partner: the listing's page on the
  // job board is where to apply then.
  const partner = str(details["allianzpartnerUrl"]);
  const refnr = str(details["referenznummer"]);
  const apply = str(details["externeURL"]) ?? (partner !== undefined && !BA_HOME.test(partner) ? partner : refnr === undefined ? undefined : jobboerseUrl(refnr));
  if (apply !== undefined) out.applyUrl = apply;
  return out;
}

/**
 * A shortlist for a candidate: one search (the first page of up to 100), re-posts merged (the
 * same title, employer and first city: the direct posting, without `externeURL`, is kept, else
 * the newest), sorted by distance with `where` (ties: newest, then employer) or newest first, the
 * first `limit` kept; the top `details` picks get their details (salary, home office, contract,
 * how to apply), one request each. A place the API did not recognise is `empty` (nothing was
 * searched there), one it replaced is in `place`.
 */
export async function findJobs(client: JobsucheClient, input: FindJobsInput): Promise<JobShortlist> {
  const params = searchParams(input);
  const limit = whole("limit", input.limit, 10, 1, 25);
  const detailCount = whole("details", input.details, 3, 0, 5);
  const sortBy = input.sortBy ?? (params.wo === undefined ? "newest" : "distance");
  if (sortBy !== "distance" && sortBy !== "newest") throw new JobsucheValidationError("Invalid sortBy: expected distance or newest.");
  if (sortBy === "distance" && params.wo === undefined) throw new JobsucheValidationError("sortBy distance needs where: distances are measured from that place.");
  const searched = searchedOf(input);
  const temp = tempAgenciesNote(input.tempAgencies);
  const result = await client.search({ ...params, page: 1, size: PAGE_SIZE });
  const total = result.maxErgebnisse ?? 0;
  const place = placeNote(client, params.wo, result);
  if (place?.recognised === false) return { status: "empty", searched, tempAgencies: temp, total, place, reason: place.note };
  const all = listingsOf(result).map(listing);
  if (all.length === 0) {
    return {
      status: "empty",
      searched,
      tempAgencies: temp,
      total,
      ...(place === undefined ? {} : { place }),
      reason: "Nothing matched. Broaden: a shorter or more general what (or field instead), a larger radiusKm, more publishedWithinDays, or fewer filters.",
    };
  }
  const kept = new Map<string, Listing>();
  for (const entry of all) {
    const key = [entry.title, entry.employer, entry.city].map((part) => fold(part ?? "")).join("\u0000");
    const before = kept.get(key);
    if (before === undefined) kept.set(key, entry);
    else if ((before.externalUrl !== undefined && entry.externalUrl === undefined) || ((before.externalUrl === undefined) === (entry.externalUrl === undefined) && (entry.published ?? "") > (before.published ?? ""))) kept.set(key, entry);
  }
  const ranked = [...kept.values()].sort(sortBy === "distance" ? (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || newestFirst(a, b) : newestFirst);
  const picks: (Listing & { details?: PickDetails; detailsError?: string })[] = ranked.slice(0, limit);
  for (let i = 0; i < Math.min(detailCount, picks.length); i++) {
    const pick = picks[i] as Listing;
    try {
      picks[i] = { ...pick, details: pickDetails(await client.details(pick.refnr)) };
    } catch (err) {
      // An expired listing (404) is a note on that pick, not the end of the shortlist.
      if (!(err instanceof JobsucheApiError && err.status === 404)) throw err;
      picks[i] = { ...pick, detailsError: "No details: the listing is gone (withdrawn or filled) since the search." };
    }
  }
  return {
    status: "ok",
    searched,
    tempAgencies: temp,
    total,
    ...(place === undefined ? {} : { place }),
    read: all.length,
    duplicatesMerged: all.length - kept.size,
    sortedBy: sortBy,
    picks,
    more: Math.max(0, total - picks.length),
  };
}

// --- watchEmployer (jobsuche-employer-watch) -------------------------------------------------

export interface WatchEmployerInput extends Omit<JobFilters, "employer" | "what" | "field"> {
  /** The employer's registered name ("Deutsche Bahn AG"), or the name as the user says it. */
  employer: string;
  /** Reference numbers from an earlier run (a snapshot): what is new and what is gone. */
  known?: readonly string[] | undefined;
  /** Listings shown, newest first (1–50, default 20). */
  limit?: number | undefined;
  /** Pages of 100 read for a snapshot comparison (1–20, default 10). */
  maxPages?: number | undefined;
}

export interface EmployerCandidate {
  name: string;
  /** Listings under that name among those mentioning the text (the API's facet count). */
  listings: number;
}

export interface EmployerProfile {
  status: OperationStatus;
  /** The exact registered name searched. */
  employer: string;
  /** The name as given, when it found nothing and was resolved to `employer`. */
  resolvedFrom?: string;
  searched: Searched;
  tempAgencies: string;
  total: number;
  place?: PlaceNote;
  byPlace?: RankedFacet;
  byOccupation?: RankedFacet;
  byField?: RankedFacet;
  freshness?: Freshness;
  /** Apprenticeship and dual-study listings among them. */
  apprenticeships?: number;
  /** Listings read (pages of 100); `complete` when that is all of them. */
  read?: number;
  complete?: boolean;
  /** The newest listings read. */
  listings?: Listing[];
  /** With `known`: listings not in it (newest first, up to `limit`), and how many. */
  new?: Listing[];
  newCount?: number;
  /** With `known` and every listing read: reference numbers no longer listed (filled or expired: unknown which). */
  gone?: string[];
  goneCount?: number;
  /** Every reference number read: the snapshot to pass as `known` next time. */
  refnrs?: string[];
  candidates?: EmployerCandidate[];
  reason?: string;
}

/** True when every word of `text` starts a word of `name` (case and Unicode form aside). */
function namesIt(name: string, text: string): boolean {
  const words = fold(name).split(/[\s\-–—,.()&/"+]+/).filter((w) => w !== "");
  return fold(text)
    .split(/[\s\-–—,.()&/"+]+/)
    .filter((w) => w !== "")
    .every((w) => words.some((word) => word.startsWith(w)));
}

/**
 * The registered names that `text` may mean: the employers among the listings that mention it
 * (a keyword search's `arbeitgeber` facet, nationwide), whose name has every word of `text` at
 * the start of one of its words. A name equal to `text` apart from case wins alone.
 */
async function employerCandidates(client: JobsucheClient, text: string): Promise<EmployerCandidate[]> {
  const result = await client.search({ was: text, size: 0 });
  const names = Object.entries(counts(result.facetten, "arbeitgeber"));
  const same = names.filter(([name]) => fold(name) === fold(text));
  const found = same.length > 0 ? same : names.filter(([name]) => namesIt(name, text));
  return found.map(([name, listings]) => ({ name, listings })).sort((a, b) => b.listings - a.listings || a.name.localeCompare(b.name));
}

/**
 * One employer's open listings as a recruiting profile: where (top places), what (top
 * occupations and fields), how fresh, how many apprenticeships — from the search's facets, which
 * count every listing — and the newest listings. The API matches `arbeitgeber` exactly and
 * case-sensitively ("Siemens AG", not "Siemens"): when the name finds nothing, the registered
 * names the text may mean are looked up; one is used (`resolvedFrom` says so), several are
 * `ambiguous` with the candidates (ask which; a group of legal entities is several names), none
 * is `empty` with what to try. With `known` (a snapshot's reference numbers) the listings are
 * read page by page (up to `maxPages`) and compared: new ones, and with every listing read, gone
 * ones.
 */
export async function watchEmployer(client: JobsucheClient, input: WatchEmployerInput): Promise<EmployerProfile> {
  const filters: JobFilters = { ...input, employer: input.employer };
  const params = searchParams(filters);
  const asked = params.arbeitgeber ?? "";
  const limit = whole("limit", input.limit, 20, 1, 50);
  const maxPages = whole("maxPages", input.maxPages, 10, 1, 20);
  const known = input.known === undefined ? undefined : new Set(input.known.map((refnr) => refnr.trim()));
  const temp = tempAgenciesNote(input.tempAgencies);
  const searchedFor = (employer: string): Searched => searchedOf({ ...input, employer });

  let employer = asked;
  let first = await client.search({ ...params, page: 1, size: PAGE_SIZE });
  let resolvedFrom: string | undefined;
  const place = placeNote(client, params.wo, first);
  if (place?.recognised === false) {
    return { status: "empty", employer, searched: searchedFor(employer), tempAgencies: temp, total: 0, place, reason: place.note };
  }
  if ((first.maxErgebnisse ?? 0) === 0) {
    const candidates = (await employerCandidates(client, asked)).filter((c) => c.name !== asked);
    if (candidates.length > 1) {
      return {
        status: "ambiguous",
        employer: asked,
        searched: searchedFor(asked),
        tempAgencies: temp,
        total: 0,
        candidates: candidates.slice(0, 20),
        reason:
          `No listing under the exact name "${asked}" (the API matches the registered name exactly and case-sensitively). ` +
          "These registered names may be meant: ask which, or watch several and say so (a group often lists under several legal entities).",
      };
    }
    if (candidates.length === 0) {
      return {
        status: "empty",
        employer: asked,
        searched: searchedFor(asked),
        tempAgencies: temp,
        total: 0,
        ...(place === undefined ? {} : { place }),
        reason:
          `No listing under the exact name "${asked}", and no registered employer name among the listings that mention it has its words. ` +
          'The API matches the registered name exactly and case-sensitively ("Siemens AG", not "Siemens"): try the full legal name, or findJobs with what set to the name and read the employers. Zero hits on a short name is a spelling problem, not proof the employer has no openings.',
      };
    }
    resolvedFrom = asked;
    employer = (candidates[0] as EmployerCandidate).name;
    first = await client.search({ ...params, arbeitgeber: employer, page: 1, size: PAGE_SIZE });
    if ((first.maxErgebnisse ?? 0) === 0) {
      return {
        status: "empty",
        employer,
        resolvedFrom,
        searched: searchedFor(employer),
        tempAgencies: temp,
        total: 0,
        ...(place === undefined ? {} : { place }),
        reason: `"${asked}" is registered as "${employer}" (${(candidates[0] as EmployerCandidate).listings} listings nationwide), but none matches the other filters (place, radius, days, offer type, temp agencies). Widen them.`,
      };
    }
  }
  const total = first.maxErgebnisse ?? 0;
  const read = listingsOf(first).map(listing);
  if (known !== undefined) {
    for (let page = 2; page <= maxPages && read.length < total; page++) {
      const next = listingsOf(await client.search({ ...params, arbeitgeber: employer, page, size: PAGE_SIZE })).map(listing);
      if (next.length === 0) break;
      read.push(...next);
    }
  }
  const complete = read.length >= total;
  const newest = [...read].sort(newestFirst);
  const facets = first.facetten;
  const apprenticeships = counts(facets, "angebotsart")["4"];
  const profile: EmployerProfile = {
    status: "ok",
    employer,
    ...(resolvedFrom === undefined ? {} : { resolvedFrom }),
    searched: searchedFor(employer),
    tempAgencies: temp,
    total,
    ...(place === undefined ? {} : { place }),
    byPlace: rankFacet(facets, "arbeitsort", 10),
    byOccupation: rankFacet(facets, "beruf", 10),
    byField: rankFacet(facets, "berufsfeld", 10),
    ...(freshness(facets, total) === undefined ? {} : { freshness: freshness(facets, total) as Freshness }),
    ...(apprenticeships === undefined ? {} : { apprenticeships }),
    read: read.length,
    complete,
    listings: newest.slice(0, limit),
  };
  if (known !== undefined) {
    const now = new Set(read.map((entry) => entry.refnr));
    const fresh = newest.filter((entry) => !known.has(entry.refnr));
    profile.new = fresh.slice(0, limit);
    profile.newCount = fresh.length;
    if (complete) {
      const gone = [...known].filter((refnr) => refnr !== "" && !now.has(refnr));
      profile.gone = gone.slice(0, 100);
      profile.goneCount = gone.length;
    } else {
      profile.reason = `Only ${read.length} of ${total} listings were read (maxPages ${maxPages}): new ones are among those read, and what is gone can't be told.`;
    }
    delete profile.listings;
  }
  profile.refnrs = read.map((entry) => entry.refnr);
  return profile;
}

// --- scanMarket (jobsuche-market-scan) -------------------------------------------------------

export interface MarketScanInput extends JobFilters {
  /** Labels per ranking (1–25, default 10). */
  top?: number | undefined;
}

export interface MarketScan {
  status: OperationStatus;
  searched: Searched;
  tempAgencies: string;
  /** Every match: the total demand. */
  total: number;
  place?: PlaceNote;
  /** Top employers by open listings; `agencyLike` marks a name that reads as a staffing or placement agency. */
  topEmployers?: { top: { label: string; count: number; agencyLike?: true }[]; listed: number };
  places?: RankedFacet;
  occupations?: RankedFacet;
  fields?: RankedFacet;
  /** Listings that quote pay, by cadence (amounts are only on a listing's details). */
  payQuoted?: { annual: number; hourly: number; notStated: number };
  /** Apprenticeship listings quoting a monthly training pay. */
  apprenticeshipPayQuoted?: number;
  /** The `homeoffice` facet as the API counts it. */
  homeOffice?: Record<string, number>;
  contract?: { fixedTerm: number; permanent: number; otherCode3: number };
  workingTime?: { fullTime: number; partTime: number; shiftsNightsWeekends: number; homeOrTelework: number; minijob: number };
  freshness?: Freshness;
  offerTypes?: Record<OfferType, number>;
  tempAgencyListings?: number;
  /** Listings of private placement agencies (`pav`). */
  privatePlacementListings?: number;
  careerChangerListings?: number;
  reason?: string;
}

/** A name that reads as a staffing or placement agency: not the end employer. */
const AGENCY_NAME = /personal(?:dienst|management|service|vermittlung|leasing|partner|agentur)|personaldienstleist|zeitarbeit|arbeitsvermittlung|arbeitnehmerüberlassung|recruit|staffing|randstad|adecco|manpower|tempton|\bdis ag\b|hays\b|ärztevermittlung|fachkräfte für deutschland/i;

/**
 * A labour-market overview from one search with size 0: the API counts the whole matching set in
 * its facets, so no listing is downloaded and nothing is paged. Each ranking is sorted by count
 * (the API lists labels alphabetically) and holds at most the API's top 100. Staffing and
 * placement agencies rank high in many fields: their names are marked `agencyLike`, the
 * temp-agency and private-placement counts are given. "Today" is the freshness facet's 0 bucket.
 */
export async function scanMarket(client: JobsucheClient, input: MarketScanInput): Promise<MarketScan> {
  const params = searchParams(input);
  const top = whole("top", input.top, 10, 1, 25);
  const searched = searchedOf(input);
  const temp = tempAgenciesNote(input.tempAgencies);
  const result = await client.search({ ...params, page: 1, size: 0 });
  const total = result.maxErgebnisse ?? 0;
  const place = placeNote(client, params.wo, result);
  if (place?.recognised === false) return { status: "empty", searched, tempAgencies: temp, total, place, reason: place.note };
  if (total === 0) {
    return {
      status: "empty",
      searched,
      tempAgencies: temp,
      total,
      ...(place === undefined ? {} : { place }),
      reason: "No listing matches, so there is no market to describe. Broaden: field instead of what, a larger radiusKm, no publishedWithinDays, or fewer filters.",
    };
  }
  const f = result.facetten;
  const c = (name: string): Record<string, number> => counts(f, name);
  const employers = rankFacet(f, "arbeitgeber", top);
  const pay = c("verguetung");
  const contract = c("befristung");
  const time = c("arbeitszeit");
  const offers = c("angebotsart");
  const homeOffice = c("homeoffice");
  const fresh = freshness(f, total);
  const yes = (name: string): number | undefined => c(name)["true"];
  const scan: MarketScan = {
    status: "ok",
    searched,
    tempAgencies: temp,
    total,
    ...(place === undefined ? {} : { place }),
    topEmployers: { top: employers.top.map((entry) => (AGENCY_NAME.test(entry.label) ? { ...entry, agencyLike: true as const } : entry)), listed: employers.listed },
    places: rankFacet(f, "arbeitsort", top),
    occupations: rankFacet(f, "beruf", top),
    fields: rankFacet(f, "berufsfeld", top),
    payQuoted: { annual: pay["jahr"] ?? 0, hourly: pay["stunde"] ?? 0, notStated: Math.max(0, total - (pay["jahr"] ?? 0) - (pay["stunde"] ?? 0)) },
    ...(c("ausbildungsverguetung")["monat"] === undefined ? {} : { apprenticeshipPayQuoted: c("ausbildungsverguetung")["monat"] as number }),
    ...(Object.keys(homeOffice).length === 0 ? {} : { homeOffice }),
    contract: { fixedTerm: contract["1"] ?? 0, permanent: contract["2"] ?? 0, otherCode3: contract["3"] ?? 0 },
    workingTime: { fullTime: time["vz"] ?? 0, partTime: time["tz"] ?? 0, shiftsNightsWeekends: time["snw"] ?? 0, homeOrTelework: time["ho"] ?? 0, minijob: time["mj"] ?? 0 },
    ...(fresh === undefined ? {} : { freshness: fresh }),
    offerTypes: { job: offers["1"] ?? 0, "self-employment": offers["2"] ?? 0, apprenticeship: offers["4"] ?? 0, internship: offers["34"] ?? 0 },
    ...(yes("zeitarbeit") === undefined ? {} : { tempAgencyListings: yes("zeitarbeit") as number }),
    ...(yes("pav") === undefined ? {} : { privatePlacementListings: yes("pav") as number }),
    ...(yes("quereinstieg") === undefined ? {} : { careerChangerListings: yes("quereinstieg") as number }),
  };
  return scan;
}

// --- searchJobs (a slice of listings) -------------------------------------------------------

export interface SearchJobsInput extends JobFilters {
  /** Where the slice starts, 0-based (default 0). */
  offset?: number | undefined;
  /** Listings in the slice (1–100, default 25). */
  limit?: number | undefined;
}

export interface JobPage {
  status: OperationStatus;
  searched: Searched;
  tempAgencies: string;
  total: number;
  place?: PlaceNote;
  offset: number;
  listings?: Listing[];
  /** Where the next slice starts, when there are more matches the API lists. */
  nextOffset?: number;
  reason?: string;
}

/**
 * The most matches the API lists: it answers pages up to the 100th of 100 and refuses the next
 * ("Ergebnismenge überschritten", HTTP 400). The rest of a larger search is reached by narrowing it.
 */
export const MAX_LISTED = 10_000;

/** The furthest offset searchJobs reads from: the last match the API lists. */
export const MAX_OFFSET = MAX_LISTED - 1;

/**
 * Listings `offset` to `offset + limit` in the API's order, short; `nextOffset` when there are
 * more. Read in the API's pages of 100: one request, or two when the slice spans a page border.
 * A slice ends at the API's last listed match (MAX_LISTED): no page beyond it is asked for, and
 * `reason` says that the rest is reached by narrowing the search.
 */
export async function searchJobs(client: JobsucheClient, input: SearchJobsInput): Promise<JobPage> {
  const params = searchParams(input);
  const offset = whole("offset", input.offset, 0, 0, MAX_OFFSET);
  const limit = whole("limit", input.limit, 25, 1, PAGE_SIZE);
  const searched = searchedOf(input);
  const temp = tempAgenciesNote(input.tempAgencies);
  const end = Math.min(offset + limit, MAX_LISTED);
  const firstPage = Math.floor(offset / PAGE_SIZE) + 1;
  const lastPage = Math.floor((end - 1) / PAGE_SIZE) + 1;
  const result = await client.search({ ...params, page: firstPage, size: PAGE_SIZE });
  const total = result.maxErgebnisse ?? 0;
  const place = placeNote(client, params.wo, result);
  if (place?.recognised === false) return { status: "empty", searched, tempAgencies: temp, total, offset, place, reason: place.note };
  const read = listingsOf(result);
  if (lastPage > firstPage && read.length === PAGE_SIZE && firstPage * PAGE_SIZE < total) {
    read.push(...listingsOf(await client.search({ ...params, page: lastPage, size: PAGE_SIZE })));
  }
  const start = offset - (firstPage - 1) * PAGE_SIZE;
  const listings = read.slice(start, start + (end - offset)).map(listing);
  if (listings.length === 0) {
    return {
      status: "empty",
      searched,
      tempAgencies: temp,
      total,
      offset,
      ...(place === undefined ? {} : { place }),
      reason: total > 0 ? `offset ${offset} is past the last match (${total}).` : "Nothing matched. Broaden: fewer or more general filters, a larger radiusKm.",
    };
  }
  const next = offset + listings.length;
  const beyond = next >= MAX_LISTED && total > MAX_LISTED;
  return {
    status: "ok",
    searched,
    tempAgencies: temp,
    total,
    ...(place === undefined ? {} : { place }),
    offset,
    listings,
    ...(next < Math.min(total, MAX_LISTED) ? { nextOffset: next } : {}),
    ...(beyond ? { reason: `The API lists no further than its 10,000th match (of ${total}): narrow the search (place, radiusKm, publishedWithinDays, offerType) to reach the others.` } : {}),
  };
}
