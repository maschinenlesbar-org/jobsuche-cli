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
> | zeitarbeit | `--zeitarbeit` / `--no-zeitarbeit` – only / no temp-work agencies |
> | angebotsart | `--angebotsart` – offer type code |
> | Stellenangebot | job listing / offer |
> | Stellenlokation | work location |

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
antwortet mit 401/403. Umgebende Leerzeichen werden auf jedem Weg entfernt, ein leerer Key
gilt als nicht angegeben. Für CI und Live-Tests lässt sich der öffentliche Key separat (nie
mit dem CLI-Befehl `obtain-key` abrufen (`npm run obtain-key` in einem
gebauten Checkout); er liest ihn zur Laufzeit aus der Veröffentlichungsquelle.

---

## Endpoints

**Suche (`/pc/v6/jobs`).** Liefert eine Seite mit Kurzfassungen der Stellenangebote, die zu
den Suchparametern passen. CLI: `search`. Bibliothek: `client.search(params)`. (Das ältere
`/pc/v4/jobs` antwortet seit 2026-09 auch mit dem richtigen Key mit einem leeren 403; die
Upstream-Dokumentation nennt `/pc/v6/jobs` als Suchschritt.)

**Details (`/pc/v4/jobdetails/{encryptedJobCode}`).** Liefert den vollständigen Datensatz
eines einzelnen Stellenangebots, adressiert über seinen `encryptedJobCode`. CLI: `details`.
Bibliothek: `client.details(refnr)`.

---

## Ressourcen und Kennungen

**Stellenangebot.** Eine einzelne Stellenanzeige. In einem Suchergebnis ist es eine
Kurzfassung mit `referenznummer`, `stellenangebotsTitel`, `firma`, `hauptberuf`,
`stellenlokationen`, `entfernung`, Veröffentlichungs- und Eintrittsdatum, oft Gehalts- und
Homeoffice-Angaben sowie optional `externeURL` – dieselben Feldnamen wie im Datensatz von
`details`. Die vollständige Beschreibung wird separat über `details` abgerufen.
(`Stellenangebot` in `src/client/types.ts`.)

**refnr / referenznummer.** Die stabile Kennung (Referenznummer) eines Stellenangebots, die
jedes Suchergebnis im Feld `referenznummer` liefert (in älteren API-Versionen und in der Hilfe
dieser CLI `refnr` genannt) – z. B. `10001-1002716922-S`, die Hex-Form
`14225-dafcdd47aabe512d-S` oder eine rein numerische `1002716922`. Sie besteht aus
Ziffern, Buchstaben und Bindestrichen; rund 15 % der Stellenangebote enthalten außerdem `_`
oder `:` (`13635-dc8d6fe5_JB5255995-S`, `17296-0008159:01-S`). Das ist das Argument, das Sie
an `details` übergeben.

**encryptedJobCode.** Die Form, die eine `refnr` in der URL von `details` haben muss: die
Base64-Kodierung der `refnr`. Der Client kodiert die `refnr` für Sie; ein bereits
Base64-kodierter Code wird erkannt (über einen exakten Base64-Roundtrip, der eine `refnr`
ergibt – eine Ziffer vorn, dann druckbare Zeichen –, nicht anhand des Zeichensatzes) und
unverändert durchgereicht, welche Zeichen die `refnr` auch enthält.

**Stellenlokation.** Ein Eintrag im Array `stellenlokationen` eines Stellenangebots:
`adresse` (`strasse`, `hausnummer`, `plz` Postleitzahl, `ort` Stadt oder Gemeinde, `region`,
`land` Staat) sowie `breite`/`laenge` (Breiten- und Längengrad). `entfernung` am
Stellenangebot ist die Entfernung in km vom gesuchten Ort, vorhanden, wenn `wo` angegeben war.

**firma / arbeitgeber.** Die im Stellenangebot genannte einstellende Organisation
(`firma`); `arbeitgeber` ist der Suchfilter (`--arbeitgeber`) und die Arbeitgeber-Facette.
Der Filter vergleicht den registrierten Namen exakt und unter Beachtung der Groß- und
Kleinschreibung (live geprüft: `"Siemens AG"` 72 Stellenangebote, `"Siemens"` und
`"siemens ag"` keine); die Schlüssel der Facette sind genau diese Namen.

**hauptberuf / berufsfeld.** `hauptberuf` ist der Beruf eines Stellenangebots (`alleBerufe`
nennt alle); `berufsfeld` ist eine übergeordnete Kategorie, die sich als Suchfilter nutzen
lässt (`--berufsfeld`).

---

## Suchparameter

**was.** Berufsbezeichnung oder Stichwort als Freitext (`--was`). Ein leerer oder nur
aus Leerzeichen bestehender Wert wird vor jeder Anfrage zurückgewiesen, ebenso bei `wo`,
`berufsfeld` und `arbeitgeber`: von der CLI als Bedienfehler, vom Bibliotheks-Client mit
einem `JobsucheValidationError`. Ließe man ihn weg, liefe die Suche stillschweigend
ungefiltert, und ein leeres `was=` lehnt die Live-API mit HTTP 400 ab. Wer ohne einen
Filter suchen will, lässt ihn weg.

**wo.** Der Ort, in dem oder um den herum gesucht wird (`--wo`). Die API gibt den
aufgelösten Ort im Ergebnis als `woOutput` zurück: `bereinigterOrt` (der verwendete Ort) und
`suchmodus` (`UMKREISSUCHE`, `ORTSUCHE` oder `UNGUELTIG`, wenn sie den Ort nicht erkannt hat).
Sie lehnt keinen Ort ab: Ein Tippfehler wird stillschweigend korrigiert (`Berln` → `Berlin`),
ein verstümmelter Name kann zu einem anderen Ort werden (`Hambrugxx Nord` →
`Tackesdorf-Nord`, 150 km entfernt), und ein unbekannter ergibt `UNGUELTIG` und ein leeres
Ergebnis. Die CLI gibt in diesen Fällen eine Warnung auf stderr aus (`woNote` in der
Bibliothek); eine Postleitzahl ist eindeutig.

**umkreis.** Suchradius in Kilometern um `wo` (`--umkreis`), `0`–`200`: Einen größeren
Radius beantwortet die API mit HTTP 400, deshalb lehnen CLI und Bibliothek ihn vor jeder
Anfrage ab. `0` sucht nur im Ort selbst (`suchmodus` `ORTSUCHE`).

**veroeffentlichtseit.** Beschränkt die Ergebnisse auf Stellenangebote, die in den letzten
N Tagen veröffentlicht wurden (`--veroeffentlicht-seit`), `0` bis `100`
(`MAX_VEROEFFENTLICHT_SEIT`). Einen größeren Wert ignoriert die API stillschweigend (es kommt
die ungefilterte Menge zurück), deshalb weist die CLI ihn als Bedienfehler zurück und der
Bibliotheks-Client mit einem `JobsucheValidationError`.

**zeitarbeit.** Stellenangebote von Zeitarbeits- bzw. Personaldienstleistungsfirmen. Ohne
Parameter sind sie zusammen mit allen anderen enthalten; `zeitarbeit=true` (`--zeitarbeit`)
liefert **nur** sie, `zeitarbeit=false` (`--no-zeitarbeit`) lässt sie weg. Live geprüft: Die
beiden Trefferzahlen ergeben zusammen die ohne Parameter. Beide Flags zusammen sind ein
Aufruffehler, und die Bibliothek nimmt nur `true` oder `false`.

**angebotsart.** Ein numerischer Code für die Art des Angebots
(`--angebotsart`): `1` Arbeit, `2` Selbstständigkeit, `4` Ausbildung bzw. Duales
Studium, `34` Praktikum bzw. Trainee. Das sind die Codes aus der OpenAPI-Spezifikation
von bundesAPI (`ANGEBOTSART_CODES`); jeden anderen Code weist die CLI als Bedienfehler zurück
und der Bibliotheks-Client mit einem `JobsucheValidationError`, weil die API darauf mit einem
leeren Ergebnis antwortet.

**page / size.** Paginierung: `page` beginnt bei 1 (auf `page=0` antwortet die API mit
HTTP 400, deshalb weisen CLI und Bibliotheks-Client es zurück), `size` ist die Seitengröße
(`--page`, `--size`), eine nicht-negative ganze Zahl.

---

## Ergebnishülle

**JobSearchResult.** Die Antwort der Suche: `ergebnisliste` (das Array der
Stellenangebote), `maxErgebnisse` (Gesamtzahl der Treffer), `page`, `size`, `facetten`
(Aggregations-Facetten) und `woOutput` (der Ort, in dem die API tatsächlich gesucht hat).
(`JobSearchResult` in `src/client/types.ts`.)

**ergebnisliste.** Das Array der `Stellenangebot`-Kurzfassungen auf einer Ergebnisseite. Es
fehlt (statt `[]`), wenn nichts gefunden wurde oder bei `--size 0`; ohne Treffer fehlt auch
`facetten`.

**maxErgebnisse.** Die Gesamtzahl passender Stellenangebote über alle Seiten. Jede
Suchantwort enthält sie, auch als `0`; ein `200`-Body ohne sie (`null`, `{}`, eine
Fehlerhülle eines Proxys) wird als Parse-Fehler abgelehnt, Exit-Code `1`, statt als
„nichts gefunden“ gelesen zu werden. Eine `details`-Antwort muss ihre `referenznummer`
enthalten.

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
**503** zurückgeben; der Client wiederholt diese Anfragen automatisch (`--max-retries`,
Standard `2`, höchstens `10`) und wartet dabei das `Retry-After` des Servers ab, wenn es
höchstens 30 s verlangt, sonst einen linearen Backoff. Ein längeres `Retry-After` wird
nicht wiederholt: Die Fehlermeldung nennt die verlangte Wartezeit.

**Entfernen von Zugangsdaten bei Weiterleitungen.** Zugangsdaten (der `X-API-Key`, ein
`user:passwort@` in der Basis-URL, `Authorization`, `Cookie`) gehen nur an den Origin der
Basis-URL. Leitet die API auf ein anderes Schema, einen anderen Host oder Port weiter – auch
`http:` → `https:` auf demselben Host –, werden sie für den Rest der Kette verworfen, damit der
Key nicht an fremde Hosts gelangt. Bei Weiterleitungen innerhalb desselben Origins bleiben sie
erhalten. Antwortet das Ziel dann mit `401`/`403`, sagt die Fehlermeldung, dass die
Weiterleitung den Key verworfen hat (bei `http:` → `https:`: „use an https base URL“), statt
den Key zu beschuldigen.

---

> **Bibliothek und Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `JobsucheClient`, Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> Query-Builder – stehen jetzt in **[DEVELOPING.md](DEVELOPING.md)** (englisch).
