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
