// Domain types for the Bundesagentur für Arbeit Jobsuche API
// (rest.arbeitsagentur.de/jobboerse/jobsuche-service).

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A work location as the API serialises it. */
export interface Arbeitsort {
  plz?: string;
  ort?: string;
  strasse?: string;
  region?: string;
  land?: string;
  koordinaten?: { lat?: number; lon?: number };
}

/** One job listing (summary). Full detail is fetched via `details`. */
export interface Stellenangebot {
  beruf?: string;
  titel?: string;
  /** Reference number; base64 of this is the id for `details`. */
  refnr: string;
  arbeitgeber?: string;
  arbeitsort?: Arbeitsort;
  aktuelleVeroeffentlichungsdatum?: string;
  eintrittsdatum?: string;
  hashId?: string;
}

/** Response of the jobs search endpoint. */
export interface JobSearchResult {
  stellenangebote: Stellenangebot[];
  maxErgebnisse?: number;
  page?: number;
  size?: number;
  facetten?: JsonObject;
}

/** Full single-job payload — kept as a faithful raw object. */
export type JobDetails = JsonObject;

/** Parameters for the jobs search endpoint. */
export interface JobSearchParams {
  /** "was" — job title / keyword. */
  was?: string;
  /** "wo" — location. */
  wo?: string;
  berufsfeld?: string;
  arbeitgeber?: string;
  /** Radius in km around `wo`. */
  umkreis?: number;
  /** Published within the last N days. */
  veroeffentlichtseit?: number;
  /** Include temp-work agencies. */
  zeitarbeit?: boolean;
  /** Offer type code(s). */
  angebotsart?: number;
  /** 1-based page. */
  page?: number;
  /** Page size. */
  size?: number;
}
