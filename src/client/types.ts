// Domain types for the Bundesagentur für Arbeit Jobsuche API
// (rest.arbeitsagentur.de/jobboerse/jobsuche-service).

import type { Angebotsart } from "./validate.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A postal address inside a work location. */
export interface Adresse {
  strasse?: string;
  hausnummer?: string;
  plz?: string;
  ort?: string;
  region?: string;
  land?: string;
}

/** One work location of a listing (`stellenlokationen[]`). */
export interface Stellenlokation {
  adresse?: Adresse;
  /** Latitude. */
  breite?: number;
  /** Longitude. */
  laenge?: number;
}

/** A date range (`von`/`bis`, `YYYY-MM-DD`). */
export interface Zeitraum {
  von?: string;
  bis?: string;
}

/**
 * One job listing (summary) from the `/pc/v6/jobs` search. It uses the same field
 * names as the `details` payload (`referenznummer`, `stellenangebotsTitel`,
 * `firma`, `externeURL`, …). Full detail (description, contact) is fetched via
 * `details`.
 */
export interface Stellenangebot {
  /** Reference number (refnr); the input to `details`. */
  referenznummer: string;
  stellenangebotsTitel?: string;
  /** Employer name. */
  firma?: string;
  /** Normalised occupation. */
  hauptberuf?: string;
  alleBerufe?: string[];
  /** Offer type, e.g. `"ARBEIT"`, `"AUSBILDUNG"`. */
  stellenangebotsart?: string;
  /** Work location(s); usually one. */
  stellenlokationen?: Stellenlokation[];
  /** Distance in km from the searched location (`wo`), when one was given. */
  entfernung?: number;
  /** Current publication period; `von` is the date the listing went (back) online. */
  veroeffentlichungszeitraum?: Zeitraum;
  /** Date of the first publication (`YYYY-MM-DD`). */
  datumErsteVeroeffentlichung?: string;
  /** Last-modification timestamp. */
  aenderungsdatum?: string;
  /** Desired start. */
  eintrittszeitraum?: Zeitraum;
  /** Present when the listing points at an external (third-party) posting. */
  externeURL?: string;
  homeofficemoeglich?: boolean;
  /** Salary range, when stated. */
  gehaltsspanneVon?: number;
  gehaltsspanneBis?: number;
  /** Fixed salary, when stated. */
  festgehalt?: number;
  /** The live API sends more keys (working-time flags, pay type, …). */
  [key: string]: unknown;
}

/**
 * Response of the jobs search endpoint (`/pc/v6/jobs`). `ergebnisliste` is
 * absent (not `[]`) when nothing matched or when `size` is 0, and `facetten` is
 * absent when nothing matched.
 */
export interface JobSearchResult {
  ergebnisliste?: Stellenangebot[];
  maxErgebnisse?: number;
  page?: number;
  size?: number;
  facetten?: JsonObject;
  /** Echo of the resolved location (`wo`) the API searched against. */
  woOutput?: JsonObject;
}

/** Full single-job payload — kept as a faithful raw object. */
export type JobDetails = JsonObject;

/**
 * Parameters for the jobs search endpoint. `search()` checks them before any
 * request (validateSearchParams); leave a parameter out (`undefined`) to not
 * filter by it.
 */
export interface JobSearchParams {
  /** "was" — job title / keyword; not blank. */
  was?: string;
  /** "wo" — location; not blank. */
  wo?: string;
  /** Occupational field; not blank. */
  berufsfeld?: string;
  /** Employer name; not blank. */
  arbeitgeber?: string;
  /** Radius in km around `wo`; a non-negative integer. */
  umkreis?: number;
  /**
   * Published within the last N days: an integer 0..`MAX_VEROEFFENTLICHT_SEIT`
   * (100). The API would silently ignore a larger value.
   */
  veroeffentlichtseit?: number;
  /**
   * Temp-work (Zeitarbeit) listings: omitted = included with the rest, `true` =
   * only temp-work listings, `false` = none.
   */
  zeitarbeit?: boolean;
  /**
   * Offer type code, one of `ANGEBOTSART_CODES`: 1 job, 2 self-employment,
   * 4 apprenticeship/dual study, 34 internship/trainee.
   */
  angebotsart?: Angebotsart;
  /** 1-based page; an integer >= 1 (the API answers 0 with HTTP 400). */
  page?: number;
  /** Page size; a non-negative integer. */
  size?: number;
}
