// Answers of the live Jobsuche API (rest.arbeitsagentur.de), recorded 2026-11-20 between 02:23 and
// 02:30 CET and cut down: each facet to its top labels (the API lists up to 100, alphabetically),
// the listings to the first few. Employer hashes (arbeitgeberKundennummerHash) are dropped.

/** GET /pc/v6/jobs?was=Pflege&wo=Berlin&umkreis=25&size=0: facets only (market scan). */
export const MARKET_PFLEGE_BERLIN = {
  "maxErgebnisse": 6406,
  "page": 1,
  "size": 0,
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
    "befristung": {
      "counts": {
        "1": 256,
        "2": 4052,
        "3": 2098
      },
      "maxCount": 6406
    },
    "verguetung": {
      "counts": {
        "jahr": 814,
        "stunde": 1335
      },
      "maxCount": 6406
    },
    "externestellenboersen": {
      "counts": {
        "false": 6001,
        "true": 405
      },
      "maxCount": 6406
    },
    "behinderung": {
      "counts": {
        "false": 3842,
        "true": 61
      },
      "maxCount": 6406
    },
    "pav": {
      "counts": {
        "false": 4801,
        "true": 1605
      },
      "maxCount": 6406
    },
    "berufsfeld": {
      "counts": {
        "Altenpflege": 916,
        "Bauplanung und -überwachung, Architektur": 108,
        "Büro und Sekretariat": 275,
        "Einkauf und Vertrieb": 147,
        "Erziehung, Sozialarbeit, Heilerziehungspflege": 301,
        "Fahrzeugführung im Straßenverkehr": 187,
        "Gartenbau": 150,
        "Krankenpflege, Rettungsdienst und Geburtshilfe": 1243,
        "Rechnungswesen, Controlling und Revision": 167,
        "Reinigung": 134,
        "Unternehmensorganisation und -strategie": 127,
        "Verkauf (ohne Produktspezialisierung)": 272
      },
      "maxCount": 6406
    },
    "arbeitsort": {
      "counts": {
        "Schönefeld bei Berlin": 74,
        "Bernau bei Berlin": 109,
        "Berlin": 5618,
        "Blankenfelde-Mahlow": 47,
        "Stahnsdorf": 29,
        "Hoppegarten (Mark)": 37,
        "Ahrensfelde bei Berlin": 38,
        "Neuenhagen bei Berlin": 36,
        "Kleinmachnow": 52,
        "Großbeeren": 49,
        "Teltow": 51,
        "Hennigsdorf": 82
      },
      "maxCount": 6406
    },
    "veroeffentlichtseit": {
      "counts": {
        "0": 3,
        "1": 221,
        "7": 1027,
        "14": 1898,
        "28": 2864,
        "alle": 6406
      },
      "maxCount": 6406
    },
    "ausbildungsart": {
      "counts": {
        "0": 302,
        "1": 1,
        "2": 7
      },
      "maxCount": 6406
    },
    "schulbildung": {
      "counts": {
        "0": 6121,
        "1": 6124,
        "2": 6238,
        "3": 6380,
        "4": 6390,
        "5": 6392,
        "6": 6406,
        "11": 6125,
        "12": 6278
      },
      "maxCount": 6406
    },
    "arbeitsort_plz": {
      "counts": {
        "10115": 202,
        "10117": 356,
        "10365": 79,
        "10587": 132,
        "10789": 92,
        "12163": 213,
        "12489": 114,
        "12681": 438,
        "13347": 235,
        "14532": 80,
        "16321": 106,
        "16761": 80
      },
      "maxCount": 6406
    },
    "arbeitgeber": {
      "counts": {
        "Actief Personalmanagement GmbH Berlin": 18,
        "Arena Personal Mgmt. GmbH": 18,
        "Aretia Personalservice GmbH": 11,
        "Bezirksamt Neukölln von Berlin Steuerungsdienst - SE Personal": 11,
        "DIS AG": 49,
        "Der Rote Punkt Medizinische Personalvermittlung med Heike Müller-Weging": 12,
        "Deutsche Bahn AG": 51,
        "Dirk Rossmann GmbH": 42,
        "EPOS Personaldienstleistungen GmbH-Berlin": 10,
        "Go.med Personaldienstleistung GmbH": 65,
        "Happy Personalservice GmbH": 37,
        "IndiCare Personalservice GmbH": 11,
        "Neo Temp GmbH": 62,
        "P-MedConsulting Medical Care Personalberatung Grit Frömel": 12,
        "PerZukunft Arbeitsvermittlung GmbH & Co. KG": 873,
        "PricewaterhouseCoopers GmbH WPG": 49,
        "Querfurth Personalmanagement": 15,
        "REWE Markt GmbH ZwNL Ost": 187,
        "RIW Personalservice GmbH (NL Berlin Promedi)": 17,
        "TEMPTON Personaldienstleistungen GmbH": 16,
        "Tempton Personaldienstleistungen GmbH": 50,
        "Time Tec Personalservice GmbH": 57,
        "VIF Personal Vermittlung in Fe stanstellung": 12,
        "Vitanas GmbH & Co. KGaA Verwaltung": 55,
        "Vivantes Netzwerk für Gesundheit GmbH": 158,
        "biac Personalservice GmbH NL Medizin/ Soziales": 10
      },
      "maxCount": 6406
    },
    "beruf": {
      "counts": {
        "Altenpflegehelfer/in": 376,
        "Altenpfleger/in": 682,
        "Berufskraftfahrer/in": 149,
        "Betreuungskraft / Alltagsbegleiter/in": 172,
        "Bürokaufmann/-frau": 147,
        "Gesundheits- und Krankenpflegehelfer/in": 216,
        "Gesundheits- und Krankenpfleger/in": 489,
        "Krankenschwester/-pfleger": 181,
        "Pflegedienstleiter/in": 202,
        "Pflegefachmann/-frau (Altenpflege)": 452,
        "Pflegefachmann/-frau (Ausbildung)": 316,
        "Pflegefachmann/-frau (Gesundheits- und Krankenpflege)": 324
      },
      "maxCount": 6406
    },
    "homeoffice": {
      "counts": {
        "prozentual": 60,
        "nv_false": 60,
        "nv_true": 280
      },
      "maxCount": 6406
    },
    "ausbildungsverguetung": {
      "counts": {
        "monat": 63
      },
      "maxCount": 6406
    },
    "branche": {
      "counts": {
        "1": 221,
        "6": 97,
        "7": 1244,
        "9": 377,
        "11": 109,
        "13": 615,
        "18": 106,
        "22": 99,
        "23": 142,
        "27": 1269,
        "28": 1169,
        "29": 116
      },
      "maxCount": 6406
    },
    "angebotsart": {
      "counts": {
        "1": 6004,
        "2": 20,
        "4": 310,
        "34": 72
      },
      "maxCount": 6406
    },
    "quereinstieg": {
      "counts": {
        "false": 5909,
        "true": 497
      },
      "maxCount": 6406
    },
    "arbeitszeit": {
      "counts": {
        "mj": 71,
        "snw": 946,
        "tz": 2278,
        "vz": 5365
      },
      "maxCount": 6406
    },
    "eintrittsdatum": {
      "counts": {
        "10_01_01-now": 5475,
        "26_11_01-26_12_01": 3779,
        "26_12_01-27_01_01": 407,
        "27_01_01-27_02_01": 170,
        "27_02_01-27_03_01": 28,
        "27_03_01-27_04_01": 20,
        "27_04_01-27_05_01": 57,
        "27_05_01-27_06_01": 20,
        "27_08_01-27_09_01": 103,
        "27_09_01-27_10_01": 54,
        "27_10_01-27_11_01": 33,
        "27_11_01-27_12_01": 5
      },
      "maxCount": 6406
    },
    "zeitarbeit": {
      "counts": {
        "false": 5492,
        "true": 914
      },
      "maxCount": 6406
    }
  }
};

/** GET /pc/v6/jobs?was=Data%20Engineer&wo=M%C3%BCnchen&umkreis=30&size=100: the first 10 listings. */
export const HUNT_DATA_ENGINEER_MUENCHEN = {
  "ergebnisliste": [
    {
      "stellenangebotsart": "SELBSTAENDIGKEIT",
      "stellenangebotsTitel": "Data Engineer",
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2026-11-23"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "KEINE_ANGABE",
      "stellenlokationen": [
        {
          "adresse": {
            "strasse": "Landshuter Allee",
            "hausnummer": "12-14",
            "plz": "80637",
            "ort": "München",
            "region": "BAYERN",
            "land": "DEUTSCHLAND"
          },
          "breite": 48.1484534,
          "laenge": 11.5373018
        }
      ],
      "homeofficemoeglich": true,
      "homeofficetyp": "NACH_VEREINBARUNG",
      "veroeffentlichungszeitraum": {
        "von": "2026-11-02"
      },
      "datumErsteVeroeffentlichung": "2025-02-10",
      "aenderungsdatum": "2026-11-02T08:37:59.246",
      "hauptberuf": "Data Engineer",
      "alternativBeruf1": "Informatiker/in",
      "firma": "alfatraining Bildungszentrum GmbH",
      "referenznummer": "10000-1183204759-S",
      "entfernung": 2,
      "alleBerufe": [
        "Data Engineer",
        "Informatiker/in"
      ]
    },
    {
      "stellenangebotsart": "ARBEIT",
      "stellenangebotsTitel": "Senior Data Engineer (m/w/d)",
      "quereinstiegGeeignet": false,
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": false,
      "arbeitszeitTeilzeitNachmittag": false,
      "arbeitszeitTeilzeitVormittag": false,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2026-11-13"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "UNBEFRISTET",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "plz": "81667",
            "ort": "München",
            "region": "BAYERN",
            "land": "DEUTSCHLAND"
          },
          "breite": 48.1311337,
          "laenge": 11.5996045
        }
      ],
      "homeofficemoeglich": false,
      "chiffrenummer": "34984796",
      "veroeffentlichungszeitraum": {
        "von": "2026-11-12"
      },
      "datumErsteVeroeffentlichung": "2026-11-12",
      "aenderungsdatum": "2026-11-13T07:10:00.781",
      "externeURL": "https://www.persy.jobs/persy/l/job-jppm9-b",
      "hauptberuf": "Data Engineer",
      "firma": "Real I.S. AG Gesellschaft für Immobilien Assetmanagement",
      "referenznummer": "12288-4996063592-S",
      "entfernung": 3,
      "alleBerufe": [
        "Data Engineer"
      ]
    },
    {
      "stellenangebotsart": "ARBEIT",
      "stellenangebotsTitel": "Principal Data Engineer (m/w/d)",
      "quereinstiegGeeignet": false,
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": false,
      "arbeitszeitTeilzeitNachmittag": false,
      "arbeitszeitTeilzeitVormittag": false,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2026-10-26"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "UNBEFRISTET",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "plz": "80637",
            "ort": "München",
            "region": "BAYERN",
            "land": "DEUTSCHLAND"
          },
          "breite": 48.1607027,
          "laenge": 11.5380108
        }
      ],
      "homeofficemoeglich": false,
      "chiffrenummer": "1632703",
      "veroeffentlichungszeitraum": {
        "von": "2026-10-26"
      },
      "datumErsteVeroeffentlichung": "2026-10-26",
      "aenderungsdatum": "2026-10-26T17:13:44.057",
      "externeURL": "https://www.jobexport.de/job/5283017.html?exp=81&cid=fa2f5bda-b0d9-4dfc-8950-3f22cb89a30e",
      "hauptberuf": "Data Engineer",
      "firma": "Alexander Thamm GmbH",
      "referenznummer": "13635-fa2f5bda_JB5283017-S",
      "entfernung": 3,
      "alleBerufe": [
        "Data Engineer"
      ]
    },
    {
      "stellenangebotsart": "ARBEIT",
      "stellenangebotsTitel": "Senior Data Engineer (m/w/d)",
      "quereinstiegGeeignet": false,
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": false,
      "arbeitszeitTeilzeitNachmittag": false,
      "arbeitszeitTeilzeitVormittag": false,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2026-10-26"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "UNBEFRISTET",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "plz": "80637",
            "ort": "München",
            "region": "BAYERN",
            "land": "DEUTSCHLAND"
          },
          "breite": 48.1607027,
          "laenge": 11.5380108
        }
      ],
      "homeofficemoeglich": false,
      "chiffrenummer": "249711",
      "veroeffentlichungszeitraum": {
        "von": "2026-10-26"
      },
      "datumErsteVeroeffentlichung": "2026-10-26",
      "aenderungsdatum": "2026-10-26T14:14:14.657",
      "externeURL": "https://www.jobexport.de/job/5282732.html?exp=81&cid=b9645f9d-fff3-4fb8-bb53-4f1d0934f98c",
      "hauptberuf": "Data Engineer",
      "firma": "Alexander Thamm GmbH",
      "referenznummer": "13635-b9645f9d_JB5282732-S",
      "entfernung": 3,
      "alleBerufe": [
        "Data Engineer"
      ]
    },
    {
      "stellenangebotsart": "ARBEIT",
      "stellenangebotsTitel": "Senior Data Engineer (w/m/d)",
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": false,
      "arbeitszeitTeilzeitNachmittag": false,
      "arbeitszeitTeilzeitVormittag": false,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2026-11-16"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "UNBEFRISTET",
      "stellenlokationen": [
        {
          "adresse": {
            "strasse": "Westendstr.",
            "hausnummer": "199",
            "plz": "80686",
            "ort": "München",
            "region": "BAYERN",
            "land": "DEUTSCHLAND"
          },
          "breite": 48.132891,
          "laenge": 11.5210575
        }
      ],
      "homeofficemoeglich": true,
      "homeofficetyp": "NACH_VEREINBARUNG",
      "chiffrenummer": "8573",
      "veroeffentlichungszeitraum": {
        "von": "2026-11-13"
      },
      "datumErsteVeroeffentlichung": "2026-11-13",
      "aenderungsdatum": "2026-11-16T12:54:49.453",
      "hauptberuf": "Data Engineer",
      "alternativBeruf1": "Informatiker/in",
      "firma": "TÜV SÜD AG",
      "referenznummer": "10001-1004009397-S",
      "entfernung": 4,
      "alleBerufe": [
        "Data Engineer",
        "Informatiker/in"
      ]
    },
    {
      "stellenangebotsart": "ARBEIT",
      "stellenangebotsTitel": "KI Data Engineer (w/m/d)",
      "quereinstiegGeeignet": false,
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": false,
      "arbeitszeitTeilzeitNachmittag": false,
      "arbeitszeitTeilzeitVormittag": false,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": false,
      "eintrittszeitraum": {
        "von": "2026-11-18"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "KEINE_ANGABE",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "plz": "80331",
            "ort": "München",
            "region": "BAYERN",
            "land": "DEUTSCHLAND"
          },
          "breite": 48.1355827,
          "laenge": 11.5739758
        }
      ],
      "homeofficemoeglich": true,
      "homeofficetyp": "NACH_VEREINBARUNG",
      "chiffrenummer": "294261",
      "veroeffentlichungszeitraum": {
        "von": "2026-11-18"
      },
      "datumErsteVeroeffentlichung": "2026-11-17",
      "aenderungsdatum": "2026-11-18T07:02:33.934",
      "externeURL": "https://www.get-in-it.de/jobsuche/p294261?utm_source=arbeitsagentur&utm_medium=organic&utm_campaign=launch-basic",
      "hauptberuf": "Datenbankentwickler/in",
      "firma": "Syngenio",
      "referenznummer": "13644-294261-S",
      "entfernung": 1,
      "alleBerufe": [
        "Datenbankentwickler/in"
      ]
    },
    {
      "stellenangebotsart": "ARBEIT",
      "stellenangebotsTitel": "Senior Data Engineer* / Machine Learning Engineer*",
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": false,
      "arbeitszeitTeilzeitNachmittag": false,
      "arbeitszeitTeilzeitVormittag": false,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2026-11-02"
      },
      "verguetungsangabe": "JAHRESGEHALT",
      "artDerVerguetung": "GEHALTSSPANNE",
      "gehaltsspanneVon": 70000,
      "gehaltsspanneBis": 85000,
      "vertragsdauer": "KEINE_ANGABE",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "ort": "München",
            "region": "BAYERN",
            "land": "DEUTSCHLAND"
          },
          "breite": 48.1521044,
          "laenge": 11.5502024
        }
      ],
      "chiffrenummer": "r5333",
      "veroeffentlichungszeitraum": {
        "von": "2026-01-21"
      },
      "datumErsteVeroeffentlichung": "2025-05-22",
      "aenderungsdatum": "2026-11-02T07:34:15.521",
      "hauptberuf": "Data Engineer",
      "firma": "inovex GmbH",
      "referenznummer": "16752-r5333-S",
      "entfernung": 2,
      "alleBerufe": [
        "Data Engineer"
      ]
    },
    {
      "stellenangebotsart": "ARBEIT",
      "stellenangebotsTitel": "Senior Software Engineer Data (m/w/d/x)",
      "quereinstiegGeeignet": false,
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": false,
      "arbeitszeitTeilzeitNachmittag": false,
      "arbeitszeitTeilzeitVormittag": false,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2026-09-01"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "KEINE_ANGABE",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "plz": "80335",
            "ort": "München",
            "region": "BAYERN",
            "land": "DEUTSCHLAND"
          },
          "breite": 48.1450237,
          "laenge": 11.5540846
        }
      ],
      "homeofficemoeglich": false,
      "chiffrenummer": "702557",
      "veroeffentlichungszeitraum": {
        "von": "2026-07-12"
      },
      "datumErsteVeroeffentlichung": "2026-07-12",
      "aenderungsdatum": "2026-07-13T12:01:19.396",
      "hauptberuf": "Data Engineer",
      "firma": "Deutsche Telekom AG",
      "referenznummer": "12444-563465374108906-DT-S",
      "entfernung": 1,
      "alleBerufe": [
        "Data Engineer"
      ]
    },
    {
      "stellenangebotsart": "ARBEIT",
      "stellenangebotsTitel": "Data Engineer - Künstliche Intelligenz  (m/w/d)",
      "quereinstiegGeeignet": false,
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": false,
      "arbeitszeitTeilzeitNachmittag": false,
      "arbeitszeitTeilzeitVormittag": false,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": false,
      "eintrittszeitraum": {
        "von": "2026-11-18"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "KEINE_ANGABE",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "plz": "80331",
            "ort": "München",
            "region": "BAYERN",
            "land": "DEUTSCHLAND"
          },
          "breite": 48.1355827,
          "laenge": 11.5739758
        }
      ],
      "homeofficemoeglich": false,
      "chiffrenummer": "295850",
      "veroeffentlichungszeitraum": {
        "von": "2026-11-18"
      },
      "datumErsteVeroeffentlichung": "2026-11-17",
      "aenderungsdatum": "2026-11-18T07:02:36.556",
      "externeURL": "https://www.get-in-it.de/jobsuche/p295850?utm_source=arbeitsagentur&utm_medium=organic&utm_campaign=launch-basic",
      "hauptberuf": "Datenbankentwickler/in",
      "firma": "NorCom",
      "referenznummer": "13644-295850-S",
      "entfernung": 1,
      "alleBerufe": [
        "Datenbankentwickler/in"
      ]
    },
    {
      "stellenangebotsart": "ARBEIT",
      "stellenangebotsTitel": "Senior Data Engineer (m/w/d) Snowflake & SAS",
      "quereinstiegGeeignet": false,
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": false,
      "arbeitszeitTeilzeitNachmittag": false,
      "arbeitszeitTeilzeitVormittag": false,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2026-11-14"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "UNBEFRISTET",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "plz": "85774",
            "ort": "Unterföhring",
            "region": "BAYERN",
            "land": "DEUTSCHLAND"
          },
          "breite": 48.1892138,
          "laenge": 11.6548397
        }
      ],
      "homeofficemoeglich": false,
      "chiffrenummer": "35253904",
      "veroeffentlichungszeitraum": {
        "von": "2026-11-13"
      },
      "datumErsteVeroeffentlichung": "2026-11-13",
      "aenderungsdatum": "2026-11-13T18:05:53.542",
      "externeURL": "https://www.persy.jobs/persy/l/job-jvlti-b",
      "hauptberuf": "Data Engineer",
      "firma": "YER",
      "referenznummer": "12288-4998136470-S",
      "entfernung": 8,
      "alleBerufe": [
        "Data Engineer"
      ]
    }
  ],
  "maxErgebnisse": 141,
  "page": 1,
  "size": 100,
  "woOutput": {
    "bereinigterOrt": "München",
    "suchmodus": "UMKREISSUCHE",
    "koordinaten": [
      {
        "lat": 48.1476759,
        "lon": 11.5695622
      }
    ]
  },
  "facetten": {
    "verguetung": {
      "counts": {
        "jahr": 16
      },
      "maxCount": 141
    },
    "befristung": {
      "counts": {
        "1": 6,
        "2": 91,
        "3": 44
      },
      "maxCount": 141
    },
    "externestellenboersen": {
      "counts": {
        "false": 115,
        "true": 26
      },
      "maxCount": 141
    },
    "behinderung": {
      "counts": {
        "false": 103,
        "true": 9
      },
      "maxCount": 141
    },
    "berufsfeld": {
      "counts": {
        "Elektrotechnik": 19,
        "IT-Netzwerktechnik, -Administration, -Organisation": 19,
        "Informatik": 60,
        "Softwareentwicklung und Programmierung": 19,
        "Technische Produktionsplanung und -steuerung": 4
      },
      "maxCount": 141
    },
    "pav": {
      "counts": {
        "false": 134,
        "true": 7
      },
      "maxCount": 141
    },
    "topberuf": {
      "counts": {
        "Data Engineer": 38,
        "KI-Engineer": 8,
        "Data Scientist": 9,
        "Ingenieur/in - Elektrotechnik": 16,
        "Informatiker/in": 11
      },
      "maxCount": 141
    },
    "arbeitsort": {
      "counts": {
        "Unterföhring": 3,
        "Gilching": 4,
        "Neubiberg": 5,
        "Garching bei München": 3,
        "München": 113
      },
      "maxCount": 141
    },
    "veroeffentlichtseit": {
      "counts": {
        "1": 3,
        "7": 41,
        "14": 61,
        "28": 88,
        "alle": 141
      },
      "maxCount": 141
    },
    "schulbildung": {
      "counts": {
        "0": 141,
        "1": 141,
        "2": 141,
        "3": 141,
        "4": 141
      },
      "maxCount": 141
    },
    "arbeitsort_plz": {
      "counts": {
        "10117": 15,
        "80331": 11,
        "80335": 11,
        "80636": 21,
        "80807": 20
      },
      "maxCount": 141
    },
    "arbeitgeber": {
      "counts": {
        "Akkodis Germany Tech Experts GmbH": 21,
        "Apple Technology Engineering B.V. & Co. KG": 7,
        "EY Consulting GmbH": 4,
        "Google Germany GmbH": 15,
        "Infineon Technologies AG": 4
      },
      "maxCount": 141
    },
    "beruf": {
      "counts": {
        "Cloud-Architect": 8,
        "Data Engineer": 38,
        "Data Scientist": 9,
        "Informatiker/in": 11,
        "Ingenieur/in - Elektrotechnik": 16
      },
      "maxCount": 141
    },
    "homeoffice": {
      "counts": {
        "prozentual": 7,
        "nv_false": 7,
        "nv_true": 22
      },
      "maxCount": 141
    },
    "angebotsart": {
      "counts": {
        "1": 138,
        "2": 2,
        "34": 1
      },
      "maxCount": 141
    },
    "branche": {
      "counts": {
        "3": 5,
        "9": 4,
        "11": 42,
        "13": 13,
        "28": 35
      },
      "maxCount": 141
    },
    "quereinstieg": {
      "counts": {
        "false": 141
      },
      "maxCount": 141
    },
    "arbeitszeit": {
      "counts": {
        "tz": 2,
        "vz": 118
      },
      "maxCount": 141
    },
    "eintrittsdatum": {
      "counts": {
        "10_01_01-now": 109,
        "26_11_01-26_12_01": 83,
        "26_12_01-27_01_01": 21,
        "27_01_01-27_02_01": 3,
        "27_02_01-27_03_01": 4
      },
      "maxCount": 141
    },
    "zeitarbeit": {
      "counts": {
        "false": 110,
        "true": 31
      },
      "maxCount": 141
    },
    "topberufsfeld": {
      "counts": {
        "Informatik": 60,
        "Softwareentwicklung und Programmierung": 19,
        "IT-Netzwerktechnik, -Administration, -Organisation": 19,
        "Elektrotechnik": 19,
        "Technische Produktionsplanung und -steuerung": 4
      },
      "maxCount": 141
    }
  }
};

/** GET /pc/v6/jobs?arbeitgeber=Deutsche%20Bahn%20AG&size=100: the first 6 listings. The arbeitgeber facet counts nationwide (the filter does not apply to its own facet). */
export const EMPLOYER_DEUTSCHE_BAHN_AG = {
  "ergebnisliste": [
    {
      "stellenangebotsart": "ARBEIT",
      "stellenangebotsTitel": "Ingenieur:in als Referent:in Radsätze",
      "quereinstiegGeeignet": false,
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": true,
      "arbeitszeitTeilzeitNachmittag": true,
      "arbeitszeitTeilzeitVormittag": true,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2026-11-20"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "KEINE_ANGABE",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "plz": "32425",
            "ort": "Minden, Westfalen",
            "region": "NORDRHEIN_WESTFALEN",
            "land": "DEUTSCHLAND"
          },
          "breite": 52.3341599,
          "laenge": 8.8965968
        }
      ],
      "homeofficemoeglich": false,
      "chiffrenummer": "567237",
      "veroeffentlichungszeitraum": {
        "von": "2026-11-19"
      },
      "datumErsteVeroeffentlichung": "2026-11-19",
      "aenderungsdatum": "2026-11-19T17:37:21.171",
      "hauptberuf": "Ingenieur/in - Maschinenbau",
      "firma": "Deutsche Bahn AG",
      "referenznummer": "12456-1560492-3-S",
      "alleBerufe": [
        "Ingenieur/in - Maschinenbau"
      ]
    },
    {
      "stellenangebotsart": "ARBEIT",
      "stellenangebotsTitel": "Referent:in strategische Beschaffung",
      "quereinstiegGeeignet": false,
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": true,
      "arbeitszeitTeilzeitNachmittag": true,
      "arbeitszeitTeilzeitVormittag": true,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2026-11-20"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "KEINE_ANGABE",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "plz": "10789",
            "ort": "Berlin",
            "region": "BERLIN",
            "land": "DEUTSCHLAND"
          },
          "breite": 52.5015865,
          "laenge": 13.3374446
        }
      ],
      "homeofficemoeglich": false,
      "chiffrenummer": "573107",
      "veroeffentlichungszeitraum": {
        "von": "2026-11-19"
      },
      "datumErsteVeroeffentlichung": "2026-11-19",
      "aenderungsdatum": "2026-11-19T17:37:21.047",
      "hauptberuf": "Betriebswirt/in (Hochschule)",
      "firma": "Deutsche Bahn AG",
      "referenznummer": "12456-1598208-3-S",
      "alleBerufe": [
        "Betriebswirt/in (Hochschule)"
      ]
    },
    {
      "stellenangebotsart": "AUSBILDUNG",
      "ausbildungsart": "AUSBILDUNG",
      "stellenangebotsTitel": "Ausbildung Elektroniker:in für Betriebstechnik 2027",
      "quereinstiegGeeignet": false,
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": false,
      "arbeitszeitTeilzeitNachmittag": false,
      "arbeitszeitTeilzeitVormittag": false,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2027-08-01"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "KEINE_ANGABE",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "plz": "36179",
            "ort": "Bebra",
            "region": "HESSEN",
            "land": "DEUTSCHLAND"
          },
          "breite": 50.9833592,
          "laenge": 9.8285645
        }
      ],
      "homeofficemoeglich": false,
      "chiffrenummer": "577558",
      "veroeffentlichungszeitraum": {
        "von": "2026-11-19"
      },
      "datumErsteVeroeffentlichung": "2026-11-19",
      "aenderungsdatum": "2026-11-19T17:37:20.932",
      "hauptberuf": "Elektroniker/in - Betriebstechnik",
      "firma": "Deutsche Bahn AG",
      "referenznummer": "12456-1600516-2-S",
      "alleBerufe": [
        "Elektroniker/in - Betriebstechnik"
      ]
    },
    {
      "stellenangebotsart": "AUSBILDUNG",
      "ausbildungsart": "DUALES_STUDIUM",
      "studienform": "PRAXISINTEGRIEREND",
      "stellenangebotsTitel": "Duales Studium BWL Dienstleistungsmanagement 2027 (w/m/d)",
      "quereinstiegGeeignet": false,
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": false,
      "arbeitszeitTeilzeitNachmittag": false,
      "arbeitszeitTeilzeitVormittag": false,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2027-09-01"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "KEINE_ANGABE",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "plz": "30159",
            "ort": "Hannover",
            "region": "NIEDERSACHSEN",
            "land": "DEUTSCHLAND"
          },
          "breite": 52.3745549,
          "laenge": 9.7401119
        }
      ],
      "homeofficemoeglich": false,
      "chiffrenummer": "573298",
      "veroeffentlichungszeitraum": {
        "von": "2026-11-19"
      },
      "datumErsteVeroeffentlichung": "2026-11-19",
      "aenderungsdatum": "2026-11-19T17:37:20.814",
      "studiengang": "Bachelor of Arts - BWL - Dienstleistungsmanagement",
      "firma": "Deutsche Bahn AG",
      "referenznummer": "12456-1624400-2-S"
    },
    {
      "stellenangebotsart": "ARBEIT",
      "stellenangebotsTitel": "Auftragsplaner:in und Auftragsplanersteller:in (STE) Leit- und Sicherungstechnik",
      "quereinstiegGeeignet": false,
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": true,
      "arbeitszeitTeilzeitNachmittag": true,
      "arbeitszeitTeilzeitVormittag": true,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2026-11-20"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "UNBEFRISTET",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "plz": "22767",
            "ort": "Hamburg",
            "region": "HAMBURG",
            "land": "DEUTSCHLAND"
          },
          "breite": 53.5514038,
          "laenge": 9.9465345
        }
      ],
      "homeofficemoeglich": false,
      "chiffrenummer": "587936",
      "veroeffentlichungszeitraum": {
        "von": "2026-11-19"
      },
      "datumErsteVeroeffentlichung": "2026-11-19",
      "aenderungsdatum": "2026-11-19T17:37:20.700",
      "hauptberuf": "Betriebsplaner/in",
      "firma": "Deutsche Bahn AG",
      "referenznummer": "12456-1654970-1-S",
      "alleBerufe": [
        "Betriebsplaner/in"
      ]
    },
    {
      "stellenangebotsart": "ARBEIT",
      "stellenangebotsTitel": "Operative:r Einkäufer:in Infrastruktur / Dienstleistungen",
      "quereinstiegGeeignet": false,
      "arbeitszeitSchichtNachtWochenende": false,
      "arbeitszeitTeilzeitAbend": false,
      "arbeitszeitTeilzeitNachmittag": false,
      "arbeitszeitTeilzeitVormittag": false,
      "arbeitszeitTeilzeitFlexibel": false,
      "arbeitszeitVollzeit": true,
      "eintrittszeitraum": {
        "von": "2026-11-20"
      },
      "verguetungsangabe": "KEINE_ANGABEN",
      "vertragsdauer": "UNBEFRISTET",
      "istGeringfuegigeBeschaeftigung": false,
      "stellenlokationen": [
        {
          "adresse": {
            "plz": "63452",
            "ort": "Hanau",
            "region": "HESSEN",
            "land": "DEUTSCHLAND"
          },
          "breite": 50.1445355,
          "laenge": 8.9264481
        },
        {
          "adresse": {
            "plz": "46045",
            "ort": "Oberhausen, Rheinland",
            "region": "NORDRHEIN_WESTFALEN",
            "land": "DEUTSCHLAND"
          },
          "breite": 51.4667443,
          "laenge": 6.8603729
        }
      ],
      "homeofficemoeglich": false,
      "chiffrenummer": "582301",
      "veroeffentlichungszeitraum": {
        "von": "2026-11-19"
      },
      "datumErsteVeroeffentlichung": "2026-11-19",
      "aenderungsdatum": "2026-11-19T17:37:20.581",
      "hauptberuf": "Industriekaufmann/-frau",
      "firma": "Deutsche Bahn AG",
      "referenznummer": "12456-1655664-1-S",
      "alleBerufe": [
        "Industriekaufmann/-frau"
      ]
    }
  ],
  "maxErgebnisse": 3536,
  "page": 1,
  "size": 100,
  "facetten": {
    "befristung": {
      "counts": {
        "1": 116,
        "2": 1564,
        "3": 1856
      },
      "maxCount": 3536
    },
    "verguetung": {
      "counts": {
        "jahr": 4
      },
      "maxCount": 3536
    },
    "externestellenboersen": {
      "counts": {
        "false": 3127,
        "true": 409
      },
      "maxCount": 3536
    },
    "behinderung": {
      "counts": {
        "false": 3530
      },
      "maxCount": 3536
    },
    "berufsfeld": {
      "counts": {
        "Bauplanung und -überwachung, Architektur": 312,
        "Elektrotechnik": 275,
        "Energietechnik": 419,
        "Fahrzeugführung im Eisenbahnverkehr": 184,
        "Fahrzeugführung im Straßenverkehr": 152,
        "Mechatronik und Automatisierungstechnik": 299,
        "Tiefbau": 388,
        "Überwachung und Steuerung des Verkehrsbetriebs": 322
      },
      "maxCount": 3536
    },
    "pav": {
      "counts": {
        "false": 3536
      },
      "maxCount": 3536
    },
    "arbeitsort": {
      "counts": {
        "Berlin": 296,
        "Frankfurt am Main": 182,
        "Hamburg": 161,
        "Hannover": 122,
        "Karlsruhe, Baden": 137,
        "München": 280,
        "Nürnberg, Mittelfranken": 152,
        "Stuttgart": 139
      },
      "maxCount": 3536
    },
    "ausbildungsart": {
      "counts": {
        "0": 1330,
        "1": 35,
        "2": 114
      },
      "maxCount": 3536
    },
    "veroeffentlichtseit": {
      "counts": {
        "1": 79,
        "7": 247,
        "14": 508,
        "28": 825,
        "alle": 3536
      },
      "maxCount": 3536
    },
    "schulbildung": {
      "counts": {
        "0": 2413,
        "1": 2413,
        "2": 3370,
        "3": 3398,
        "4": 3398,
        "5": 3528,
        "6": 3536,
        "12": 3370
      },
      "maxCount": 3536
    },
    "arbeitsort_plz": {
      "counts": {
        "10789": 268,
        "22767": 136,
        "30159": 111,
        "60313": 182,
        "70173": 139,
        "76137": 136,
        "80809": 255,
        "90461": 132
      },
      "maxCount": 3536
    },
    "arbeitgeber": {
      "counts": {
        "ALDI SÜD Dienstleistungs- SE & Co. oHG": 5182,
        "DIS AG Germany": 5089,
        "Deutsche Bahn AG": 3536,
        "Lidl Dienstleistung GmbH & Co. KG": 18940,
        "Netto Marken-Discount Stiftung & Co. KG": 25819,
        "PerZukunft Arbeitsvermittlung GmbH & Co. KG": 7135,
        "Randstad Deutschland": 9518,
        "Sanovetis GmbH": 9847,
        "TEDi GmbH & Co. KG": 5922
      },
      "maxCount": 1011742
    },
    "beruf": {
      "counts": {
        "Eisenbahner/in - Betriebsdienst - Lokführer/in und Transport": 183,
        "Eisenbahner/in - Zugverkehrssteuerung": 296,
        "Elektroniker/in - Betriebstechnik": 334,
        "Gleisbauer/in": 320,
        "Industriemechaniker/in": 99,
        "Ingenieur/in - Bau": 267,
        "Ingenieur/in - Elektrotechnik": 177,
        "Mechatroniker/in": 294
      },
      "maxCount": 3536
    },
    "angebotsart": {
      "counts": {
        "1": 1960,
        "4": 1479,
        "34": 97
      },
      "maxCount": 3536
    },
    "branche": {
      "counts": {
        "13": 3127
      },
      "maxCount": 3536
    },
    "quereinstieg": {
      "counts": {
        "false": 3428,
        "true": 108
      },
      "maxCount": 3536
    },
    "arbeitszeit": {
      "counts": {
        "mj": 1,
        "snw": 2,
        "tz": 653,
        "vz": 3506
      },
      "maxCount": 3536
    },
    "eintrittsdatum": {
      "counts": {
        "10_01_01-now": 2030,
        "26_11_01-26_12_01": 1724,
        "27_01_01-27_02_01": 73,
        "27_02_01-27_03_01": 29,
        "27_03_01-27_04_01": 24,
        "27_08_01-27_09_01": 455,
        "27_09_01-27_10_01": 847,
        "27_10_01-27_11_01": 36
      },
      "maxCount": 3536
    },
    "zeitarbeit": {
      "counts": {
        "false": 3536
      },
      "maxCount": 3536
    }
  }
};

/** GET /pc/v6/jobs?arbeitgeber=Deutsche%20Bahn&size=5: no match (not the registered name); the arbeitgeber facet is the nationwide top. */
export const EMPLOYER_DEUTSCHE_BAHN_NO_MATCH = {
  "maxErgebnisse": 0,
  "page": 1,
  "size": 5,
  "facetten": {
    "arbeitgeber": {
      "counts": {
        "ALDI SÜD Dienstleistungs- SE & Co. oHG": 5182,
        "DIS AG Germany": 5089,
        "Deutsche Bahn AG": 3536,
        "Lidl Dienstleistung GmbH & Co. KG": 18940,
        "Netto Marken-Discount Stiftung & Co. KG": 25819,
        "PerZukunft Arbeitsvermittlung GmbH & Co. KG": 7135,
        "Randstad Deutschland": 9518,
        "Sanovetis GmbH": 9847,
        "TEDi GmbH & Co. KG": 5922
      },
      "maxCount": 1011739
    }
  }
};

/** GET /pc/v6/jobs?was=Deutsche%20Bahn&size=0: the employers among the listings that mention it (arbeitgeber facet only). */
export const WAS_DEUTSCHE_BAHN = {
  "maxErgebnisse": 4007,
  "page": 1,
  "size": 0,
  "facetten": {
    "arbeitgeber": {
      "counts": {
        "Akzent Personaldienstleistungen Mitte GmbH": 35,
        "Asklepios Nordseeklinik Westerland GmbH": 15,
        "BEV Bundeseisenbahnvermögen": 1,
        "BLS Bahndienstleistungen u. Service GmbH": 1,
        "Bundeseisenbahnvermögen Dienststelle Nord": 1,
        "DB Zeitarbeit GmbH": 13,
        "Deutsche Bahn AG": 3536,
        "EBB Emser Bahnbau GmbH": 5,
        "Ingenieurgruppe IVV GmbH & Co. KG": 14,
        "Knappschaft-Bahn-See KdöR": 5,
        "Paul-Ehrlich-Klinik Knappschaft-Bahn-See": 3,
        "Stölting Service Group GmbH": 31,
        "VIEBAHN Stahl- und Metallbau GmbH & Co. KG": 4,
        "trans regio - Deutsche Regionalbahn GmbH": 5
      },
      "maxCount": 4007
    }
  }
};

/** GET /pc/v4/jobdetails/<base64 of 10000-1183204759-S>. */
export const DETAILS_10000_1183204759_S = {
  "stellenangebotsart": "SELBSTAENDIGKEIT",
  "stellenangebotsTitel": "Data Engineer",
  "stellenangebotsBeschreibung": "Lehrauftrag auf freiberuflicher Basis: Vermittlung von Fachwissen rund um die Zusammenführung, Aufbereitung, Anreicherung und Weitergabe von Daten.\n\nBeauftragungsbeginn: 23.11.2026, 21.12.2026 (und weitere Beauftragungstermine)\nOrtsunabhängig: Homeoffice oder an einem unserer Standorte\n\nDauer: 4 Wochen\nUnterrichtszeiten: Mo-Fr 8:30-15:35 Uhr, in Wochen mit Feiertagen an den anderen Tagen bis 17:10 Uhr\n\nWIR, alfatraining, suchen SIE!\n\nalfatraining® ist ein arbeitsmarktorientiertes Bildungsunternehmen, das berufliche Weiterbildungsprogramme über moderne Videotechnik anbietet.\n\nZu unserem Unternehmensfilm geht´s hier entlang:\nhttps://www.alfatraining.de/lernen-mit-alfatraining\n\nGeben Sie Ihr Expertenwissen weiter und gestalten Sie die Weiterbildung der neuesten Generation!\n\nIhr Einsatzbereich\n\nSie unterrichten Personen mit abgeschlossenem Studium in der Informatik, Wirtschaftsinformatik, Mathematik oder vergleichbarer Qualifikation.\n\nQualifizierte Vermittlung der folgenden Bereiche:\n\n- Grundlagen Business Intelligence\n-       Künstliche Intelligenz (KI) im Arbeitsprozess\n- Anforderungsmanagement\n- Datenbanken\n- Data Warehouse\n- ETL\n- Projektarbeit\n\nWeitere Informationen finden Sie unter:\nhttps://www.alfatraining.de/kurse/weiterbildung-data-engineer\n\nIhr Profil\n\n- Ausbildung oder Studium und praktische Expertise\n- Erfahrung als Trainer (w/m/d) vorteilhaft\n- Kenntnisse im Videopräsenzunterricht optional\n\nIhre Vorteile\n\n- Lehraufträge auf freiberuflicher Basis in einem expandierenden Unternehmen\n- Attraktive Beauftragungszeiten\n- wohnortnahe Einsatzmöglichkeiten oder bequem im Homeoffice mit unserer modernen Videokonferenzsoftware alfaview®\n\nIhre Bewerbung als Freelancer\n\nDamit wir Ihre Bewerbung so schnell wie möglich bearbeiten können, senden Sie uns Ihre aussagekräftiges Dienstleisterprofil (inkl. beruflichem Werdegang, Kompetenzen, Zertifizierungen und Nachweisen) bitte ausschließlich über unser Bewerbungsformular: https://www.alfatraining.de/dozierende-bewerbungsformular.\n\nBitte achten Sie darauf, uns Ihre Unterlagen im pdf- Format zu senden.\n\nGerne prüfen wir Ihre Unterlagen und nehmen Sie in unseren Dienstleisterpool auf. Bitte beachten Sie, dass Ihre Daten bis auf Widerruf bei uns gespeichert werden, um Sie auch für künftige Einsätze berücksichtigen zu können. Der Widerruf kann jederzeit an dozenten@alfatraining.de erfolgen.\n\nKontakt\n\nalfatraining Bildungszentrum GmbH\nLisa Fischer | Yohana Kineselassie | Selina Niederelz | Mina Rahmat | Janine Sommer\nKriegsstraße 100\n76133 Karlsruhe\n\nTel: 0721 35450-380 oder -381\nE-Mail: dozenten@alfatraining.de\n\nWir freuen uns auf Ihre Bewerbung!",
  "arbeitszeitVollzeit": true,
  "eintrittszeitraum": {
    "von": "2026-11-23"
  },
  "verguetungsangabe": "KEINE_ANGABEN",
  "vertragsdauer": "KEINE_ANGABE",
  "stellenlokationen": [
    {
      "adresse": {
        "strasse": "Graf-Adolf-Str.",
        "hausnummer": "67",
        "plz": "40210",
        "ort": "Düsseldorf",
        "region": "NORDRHEIN_WESTFALEN",
        "land": "DEUTSCHLAND"
      },
      "breite": 51.2189116,
      "laenge": 6.7866524
    },
    {
      "adresse": {
        "strasse": "Hellweg",
        "hausnummer": "8",
        "plz": "44787",
        "ort": "Bochum",
        "region": "NORDRHEIN_WESTFALEN",
        "land": "DEUTSCHLAND"
      },
      "breite": 51.47989915100004,
      "laenge": 7.22023452500008
    },
    {
      "adresse": {
        "strasse": "Frankfurter Allee",
        "hausnummer": "73",
        "plz": "10247",
        "ort": "Berlin",
        "region": "BERLIN",
        "land": "DEUTSCHLAND"
      },
      "breite": 52.51442479700006,
      "laenge": 13.46545199500008
    },
    {
      "adresse": {
        "strasse": "Landshuter Allee",
        "hausnummer": "12-14",
        "plz": "80637",
        "ort": "München",
        "region": "BAYERN",
        "land": "DEUTSCHLAND"
      },
      "breite": 48.1484534,
      "laenge": 11.5373018
    },
    {
      "adresse": {
        "strasse": "Friedrichstraße",
        "hausnummer": "13",
        "plz": "70174",
        "ort": "Stuttgart",
        "region": "BADEN_WUERTTEMBERG",
        "land": "DEUTSCHLAND"
      },
      "breite": 48.7821815,
      "laenge": 9.1775379
    },
    {
      "adresse": {
        "strasse": "Kriegsstraße",
        "hausnummer": "100",
        "plz": "76133",
        "ort": "Karlsruhe, Baden",
        "region": "BADEN_WUERTTEMBERG",
        "land": "DEUTSCHLAND"
      },
      "breite": 49.0057197,
      "laenge": 8.4049084
    },
    {
      "adresse": {
        "strasse": "Hammerbrookstraße",
        "hausnummer": "93",
        "plz": "20097",
        "ort": "Hamburg",
        "region": "HAMBURG",
        "land": "DEUTSCHLAND"
      },
      "breite": 53.5451794,
      "laenge": 10.0252962
    },
    {
      "adresse": {
        "strasse": "Eschersheimer Landstraße",
        "hausnummer": "10",
        "plz": "60322",
        "ort": "Frankfurt am Main",
        "region": "HESSEN",
        "land": "DEUTSCHLAND"
      },
      "breite": 50.11920082200004,
      "laenge": 8.678446318000056
    },
    {
      "adresse": {
        "strasse": "Rudolphstraße",
        "hausnummer": "30",
        "plz": "90489",
        "ort": "Nürnberg, Mittelfranken",
        "region": "BAYERN",
        "land": "DEUTSCHLAND"
      },
      "breite": 49.4588199,
      "laenge": 11.0926777
    },
    {
      "adresse": {
        "strasse": "Eintrachtweg",
        "hausnummer": "19",
        "plz": "30173",
        "ort": "Hannover",
        "region": "NIEDERSACHSEN",
        "land": "DEUTSCHLAND"
      },
      "breite": 52.3652302,
      "laenge": 9.7776358
    }
  ],
  "homeofficemoeglich": true,
  "homeofficetyp": "NACH_VEREINBARUNG",
  "veroeffentlichungszeitraum": {
    "von": "2026-11-02"
  },
  "datumErsteVeroeffentlichung": "2025-02-10",
  "aenderungsdatum": "2026-11-02T08:37:59.246",
  "istBetreut": false,
  "hauptberuf": "Data Engineer",
  "alternativBeruf1": "Informatiker/in",
  "firma": "alfatraining Bildungszentrum GmbH",
  "allianzpartnerUrl": "http://www.arbeitsagentur.de",
  "allianzpartnerName": "arbeitsagentur.de",
  "referenznummer": "10000-1183204759-S"
};
