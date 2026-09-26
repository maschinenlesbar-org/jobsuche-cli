// Responses recorded from the live API (rest.arbeitsagentur.de) on 2026-09-26,
// trimmed to one listing and two facets. Search is /pc/v6/jobs: the listings are
// in `ergebnisliste`, keyed by `referenznummer`; on no match that key (and
// `facetten`) is absent.

/** GET /pc/v6/jobs?was=Informatiker&wo=Berlin&size=2 (trimmed). */
export const V6_SEARCH = {
  "ergebnisliste": [
    {
      "stellenangebotsart": "ARBEIT",
      "stellenangebotsTitel": "Informatiker (m/w/d)",
      "quereinstiegGeeignet": false,
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": false,
      "arbeitszeitTeilzeitNachmittag": false,
      "arbeitszeitTeilzeitVormittag": false,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2026-09-14"
      },
      "verguetungsangabe": "JAHRESGEHALT",
      "artDerVerguetung": "GEHALTSSPANNE",
      "gehaltsspanneVon": 60772.4,
      "gehaltsspanneBis": 87110,
      "vertragsdauer": "KEINE_ANGABE",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "strasse": "Max-Dohrn-Str.",
            "hausnummer": "8-10",
            "plz": "10589",
            "ort": "Berlin",
            "region": "BERLIN",
            "land": "DEUTSCHLAND"
          },
          "breite": 52.530795,
          "laenge": 13.296708
        }
      ],
      "homeofficemoeglich": true,
      "homeofficetyp": "NACH_VEREINBARUNG",
      "veroeffentlichungszeitraum": {
        "von": "2026-09-14"
      },
      "datumErsteVeroeffentlichung": "2026-08-31",
      "aenderungsdatum": "2026-09-14T07:57:38.033",
      "externeURL": "https://www.jobvector.de/job/informatiker-d678889039fc0001/?utm_source=arbeitsagentur&utm_medium=partner&utm_campaign=tmcfdae_job_jid270134&utm_content=b2c&utm_term=tmf8eca_uicc9a664b",
      "hauptberuf": "Informatiker/in",
      "firma": "Bundesinstitut für Risikobewertung (BfR)",
      "referenznummer": "14225-d678889039fc0001-S",
      "entfernung": 9,
      "alleBerufe": [
        "Informatiker/in"
      ]
    }
  ],
  "maxErgebnisse": 286,
  "page": 1,
  "size": 1,
  "woOutput": {
    "bereinigterOrt": "Berlin",
    "suchmodus": "UMKREISSUCHE",
    "koordinaten": [
      {
        "lat": 52.5112613,
        "lon": 13.4255145
      }
    ]
  },
  "facetten": {
    "arbeitsort": {
      "counts": {
        "Berlin": 271
      },
      "maxCount": 286
    },
    "zeitarbeit": {
      "counts": {
        "false": 273,
        "true": 13
      },
      "maxCount": 286
    }
  }
};

/** GET /pc/v6/jobs?was=Xyzzyqwvbnm&wo=Berlin&size=2 — nothing matched. */
export const V6_NO_MATCH = {
  "maxErgebnisse": 0,
  "page": 1,
  "size": 2,
  "woOutput": {
    "bereinigterOrt": "Berlin",
    "suchmodus": "UMKREISSUCHE",
    "koordinaten": [
      {
        "lat": 52.5112613,
        "lon": 13.4255145
      }
    ]
  }
};
