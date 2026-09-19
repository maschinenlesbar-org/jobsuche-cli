# Glossar

Ein Nachschlagewerk für die Fachbegriffe und projektspezifischen Begriffe, die in
`jobsuche-cli` verwendet werden. Die Jobsuche-Fachdomäne ist deutsch; dieses Glossar nennt
neben dem deutschen Feld- bzw. Parameternamen, den die API bei der Übertragung verwendet,
den englischen Begriff aus CLI und Bibliothek (sofern es einen gibt).

> **Übersetzungstabelle** (deutsche Namen der API → CLI-Flag / englischer Begriff):
>
> | Deutsch (API) | CLI-Flag / englischer Begriff |
> | --- | --- |
> | was | `--was` – job title / keyword |
> | wo | `--wo` – location |
> | berufsfeld | `--berufsfeld` – occupational field |
> | arbeitgeber | `--arbeitgeber` – employer |
> | umkreis | `--umkreis` – radius (km) |
> | veroeffentlichtseit | `--veroeffentlicht-seit` – published since (days) |
> | zeitarbeit | `--zeitarbeit` – temp-work agencies |
> | angebotsart | `--angebotsart` – offer type code |
> | Stellenangebot | job listing / offer |
> | Arbeitsort | work location |

---

## Die Jobsuche-API

**Bundesagentur für Arbeit (BA).** Sie betreibt den öffentlichen Stellensuchdienst, auf dem
dieses Tool aufsetzt.

**Jobsuche-API.** Die offene REST-API hinter der Jobbörse der BA – der größten
Stellendatenbank Deutschlands. Basis-URL `https://rest.arbeitsagentur.de`, Service-Pfad
`/jobboerse/jobsuche-service`. Dokumentiert unter
[jobsuche.api.bund.dev](https://jobsuche.api.bund.dev/). Dieses Tool setzt ihre beiden
offenen, rein lesenden Endpoints um (Suche + Details).

**X-API-Key.** Die API verlangt bei jeder Anfrage einen statischen, öffentlich
dokumentierten API-Key (`jobboerse-jobsuche`). Er ist nicht geheim, wird aber **nicht mit
dem Client ausgeliefert** – übergeben Sie ihn per `--api-key`, über die Umgebungsvariable
`JOBSUCHE_API_KEY` oder die Client-Option `apiKey`; andernfalls fehlt der Header und die API
antwortet mit 401/403. Für CI und Live-Tests lässt sich der öffentliche Key separat (nie
mit dem CLI-Befehl `obtain-key` abrufen (`npm run obtain-key` in einem
gebauten Checkout); er liest ihn zur Laufzeit aus der Veröffentlichungsquelle.

---

## Endpoints

**Suche (`/pc/v4/jobs`).** Liefert eine Seite mit Kurzfassungen der Stellenangebote, die zu
den Suchparametern passen. CLI: `search`. Bibliothek: `client.search(params)`.

**Details (`/pc/v4/jobdetails/{encryptedJobCode}`).** Liefert den vollständigen Datensatz
eines einzelnen Stellenangebots, adressiert über seinen `encryptedJobCode`. CLI: `details`.
Bibliothek: `client.details(refnr)`.

---

## Ressourcen und Kennungen

**Stellenangebot.** Eine einzelne Stellenanzeige. In einem Suchergebnis ist es eine
Kurzfassung mit `beruf`, `titel`, `refnr`, `arbeitgeber`, `arbeitsort`,
Veröffentlichungs- und Eintrittsdatum sowie optional `externeUrl`. Die vollständigen Angaben
werden separat über `details` abgerufen. (`Stellenangebot` in `src/client/types.ts`.)

**refnr.** Die stabile Kennung (Referenznummer) eines Stellenangebots, die jedes
Suchergebnis im Feld `refnr` liefert – z. B. `10001-1002716922-S`, die Hex-Form
`14225-dafcdd47aabe512d-S` oder eine rein numerische `1002716922`. Sie besteht aus
Ziffern, Buchstaben und Bindestrichen. Das ist das Argument, das Sie an `details` übergeben.

**encryptedJobCode.** Die Form, die eine `refnr` in der URL von `details` haben muss: die
Base64-Kodierung der `refnr`. Der Client kodiert die `refnr` für Sie; ein bereits
Base64-kodierter Code wird erkannt (über einen exakten Base64-Roundtrip, nicht anhand des
Zeichensatzes) und unverändert durchgereicht.

**hashId.** Eine zusätzliche Kennung, die die API einem `Stellenangebot` mitgibt.

**Arbeitsort.** Der Ort eines Stellenangebots, wie ihn die API serialisiert:
`plz` (Postleitzahl), `ort` (Stadt oder Gemeinde), `strasse` (Straße), `region`, `land`
(Staat), `koordinaten` (`lat`/`lon`) und `entfernung` (Entfernung in km vom gesuchten
Ort, nur bei Umkreissuchen vorhanden).

**Arbeitgeber.** Die im Stellenangebot genannte einstellende Organisation; auch ein
Suchfilter (`--arbeitgeber`).

**beruf / berufsfeld.** `beruf` ist der Beruf bzw. die Berufsbezeichnung eines
Stellenangebots; `berufsfeld` ist eine übergeordnete Kategorie, die sich als Suchfilter
nutzen lässt (`--berufsfeld`).

---

## Suchparameter

**was.** Berufsbezeichnung oder Stichwort als Freitext (`--was`). Einen leeren oder nur
aus Leerzeichen bestehenden Wert weist die CLI als Bedienfehler zurück (ebenso bei `--wo`,
`--berufsfeld` und `--arbeitgeber`); der Bibliotheks-Client lässt ihn weg, statt ihn zu
senden (die Live-API lehnt ein leeres `was=` mit HTTP 400 ab).

**wo.** Der Ort, in dem oder um den herum gesucht wird (`--wo`). Die API gibt den
aufgelösten Ort im Ergebnis als `woOutput` zurück.

**umkreis.** Suchradius in Kilometern um `wo` (`--umkreis`).

**veroeffentlichtseit.** Beschränkt die Ergebnisse auf Stellenangebote, die in den letzten
N Tagen veröffentlicht wurden (`--veroeffentlicht-seit`).

**zeitarbeit.** Boolesches Flag, um Zeitarbeits- bzw. Personaldienstleistungsfirmen
einzubeziehen (`--zeitarbeit`).

**angebotsart.** Ein numerischer Code für die Art des Angebots
(`--angebotsart`): `1` Arbeit, `2` Selbstständigkeit, `4` Ausbildung bzw. Duales
Studium, `34` Praktikum bzw. Trainee. Das sind die Codes aus der OpenAPI-Spezifikation
von bundesAPI. Wird unverändert an die API weitergegeben.

**page / size.** Paginierung: `page` beginnt bei 1, `size` ist die Seitengröße
(`--page`, `--size`).

---

## Ergebnishülle

**JobSearchResult.** Die Antwort der Suche: `stellenangebote` (das Array der
Stellenangebote), `maxErgebnisse` (Gesamtzahl der Treffer), `page`, `size`, `facetten`
(Aggregations-Facetten) und `woOutput` (der Ort, in dem die API tatsächlich gesucht hat).
(`JobSearchResult` in `src/client/types.ts`.)

**stellenangebote.** Das Array der `Stellenangebot`-Kurzfassungen auf einer Ergebnisseite.

**maxErgebnisse.** Die Gesamtzahl passender Stellenangebote über alle Seiten.

**facetten.** Aggregierte Zählungen, die die API zusätzlich zu den Ergebnissen liefert
(z. B. nach Ort oder Arbeitgeber), unverändert als Objekt durchgereicht.

**JobDetails.** Der vollständige Datensatz eines Stellenangebots vom Endpoint `details`,
originalgetreu als rohes JSON-Objekt belassen statt auf einen engeren Typ eingegrenzt.

---

## Such- und API-Konzepte

**Öffentlich, ohne Authentifizierung (nur lesend).** Nur die offenen `GET`-Endpoints für
Suche und Details sind umgesetzt. Der statische `X-API-Key` ist kein Zugangsdatum, das
Nutzer erst beantragen müssen.

**Rate-Limiting / vorübergehende Fehler.** Die API kann **429** (zu viele Anfragen) oder
**503** zurückgeben; der Client wiederholt diese Anfragen automatisch mit linearem Backoff
(`--max-retries`, Standard `2`).

**Entfernen von Zugangsdaten bei Weiterleitungen.** Header mit Zugangsdaten (`X-API-Key`,
`Authorization`, `Cookie`) werden verworfen, wenn die API auf einen anderen Origin
weiterleitet, damit der Key nicht an fremde Hosts gelangt. Bei Weiterleitungen innerhalb
desselben Origins bleiben sie erhalten.

---

> **Bibliothek und Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `JobsucheClient`, Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> Query-Builder – stehen jetzt in **[DEVELOPING.md](DEVELOPING.md)** (englisch).
