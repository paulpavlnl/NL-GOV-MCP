# Eigen uitbreidingen in deze fork (paulpavlnl)

Deze fork volgt [WAINUTAI/NL-GOV-MCP](https://github.com/WAINUTAI/NL-GOV-MCP). Eigen uitbreidingen staan zo veel mogelijk in eigen bestanden, zodat nieuwe commits van WAINUTAI er niet mee botsen.

## EU-rechtspraak en -wetgeving (`eurlex_tekst_get`)

| Bestand | Inhoud |
| --- | --- |
| `src/fork/eu-tekst.ts` | Herkenning (ECLI:EU:C/T/F, CELEX 6…CJ/CC/CO/TJ…, zaaknummers C-478/03, "zaak 287/86", wetgeving 3…L/R/D en citaten "Richtlijn 2001/23/EG", "Verordening (EU) 2016/679"), HTML naar regels, randnummers, dictum, artikelen en overwegingen, taalherkenning, zoekterm en citaatcontrole. |
| `src/fork/eu-bron.ts` | CELLAR SPARQL (owl:sameAs tussen resource/ecli, resource/celex en resource/case), metadata, tekst via content negotiation (Accept-Language: nl), met als terugval EUR-Lex HTML, de Nederlandse pdf en een andere taal (met melding). Time-outs 25–35 s, één herhaling. |
| `src/fork/eu-tools.ts` | De tool `eurlex_tekst_get` en de functie die `nl_gov_ask` gebruikt voor een ECLI:EU in een vraag. |
| `tests/fork-eu.test.ts`, `tests/helpers/eu-fixtures.ts` | Offline tests. |
| `tests/fork-eu.live.test.ts` | Live tests tegen CELLAR (`npm run test:acceptance -- tests/fork-eu.live.test.ts`). |
| `tests/fork-eu-guard.test.ts` | Bewaakt de koppelingen hieronder. |

### Koppelingen in upstream-bestanden

Alleen deze regels (gemarkeerd met `FORK`) staan in bestanden van WAINUTAI:

- `src/tools.ts`: `import { registerEuForkTools } from "./fork/eu-tools.js";` en `const euTekstResult = registerEuForkTools(server, { config, TOOL_ANNOTATIONS, lido });` met `euTekstResult` als eerste veld van `registerNlGovAsk(server, { … })`.
- `src/router/nl-gov-ask.ts`: het optionele veld `euTekstResult` in `NlGovAskDeps`, `const { euTekstResult } = deps;` en het blok aan het begin van de route `ecli_buitenland`.

### Na een upstream-sync

De workflow *Upstream sync (WAINUTAI)* voert de tests uit, dus ook `tests/fork-eu-guard.test.ts`, en controleert apart of de koppelingen er nog zijn. Ontbreekt er een, dan staat dat in de pull request. Zet de gemarkeerde regels dan terug voordat je merget. Bij een merge-conflict in `src/tools.ts` of `src/router/nl-gov-ask.ts`: neem de versie van WAINUTAI en voeg de `FORK`-regels opnieuw toe.

`tests/router-new-routes.test.ts` (van WAINUTAI) is op één punt aangepast, gemarkeerd met `FORK`: een EU-ECLI wordt eerst in CELLAR opgezocht. Lukt dat niet, dan blijft het oorspronkelijke antwoord (met de EUR-Lex-link) staan.

## LiDO: artikelen die get-id niet kent (`src/fork/lido-artikel.ts`)

LiDO's get-id vindt geen object voor "6:162" in BW Boek 6 (LiDO kent daar "162") en voor artikelen met hoofdstuknummering zoals "3:4" Awb. `lido_verwijzingen` en `lido_verwijzingen_lijst` gaven daardoor 0 verwijzingen voor de meest geciteerde artikelen. De terugval leest label-id en inwerkingtreding uit de BWB-toestand en bouwt daarmee het LiDO-object. Koppeling in upstream-code: het statische veld `artikelFallback` en het blok in `resolveBwb` van `src/sources/lido.ts` (gemarkeerd `FORK`); geïnstalleerd vanuit `registerEuForkTools`.

## LiDO-relaties van elk soort document (`lido_relaties`, `src/fork/lido-relaties.ts`)

Alle relaties die LiDO heeft voor één overheidsdocument: rechtspraak (ECLI:NL/EU), wet of regeling (BWBR: wet, AMvB, ministeriële regeling, beleidsregel, verdrag), één artikel (`wet` + `artikel`, bijv. BW 6:162, Awb 3:4), EU-wetgeving (CELEX) of Staatsblad/Staatscourant. Via LiDO's services (`get-links`), per documenttype gegroepeerd, met richting, verdeling per instantie en jaar, en filters `type`, `instantie`, `jaar` (ook gecombineerd: het totaal met filter komt uit het facet van één filter, dat de andere al meetelt). Zonder typefilter wordt de nieuwste rechtspraak apart opgehaald en vooraan in `documenten.Jurisprudentie` gezet. `id` mag ook een Juriconnect-verwijzing zijn (`jci1.3:c:BWBR0005537&artikel=3:4`, `jci1.31:c:BWBR0005289&boek=6&artikel=162`). De `#`-scheidingstekens in CELLAR-titels worden vervangen. Decentrale regelgeving (CVDR) zit niet in LiDO; de tool zegt dat. Geregistreerd vanuit `registerEuForkTools`, dus zonder extra koppeling in upstream-bestanden.

## Woo-documenten (`woo_zoeken`, `woo_document_get`, `woo_index`; `src/fork/woo.ts`, `src/fork/woo-index.ts`)

- `woo_zoeken`: open.overheid.nl (KOOP, DiWoo-metadata) via `open.overheid.nl/overheid/openbaarmakingen/api/v0/zoek`: zoektekst, organisatie (herhaalbaar = of/of), documentsoort, informatiecategorie, thema, datum (`publicatiedatumVan`/`Tot` als dd-mm-jjjj), paginering; facetten met de exacte filternamen in de access_note.
- `woo_document_get`: tekst van één document (PDF naar tekst), uit open.overheid.nl (`…/api/v0/documenten/{id}`) of een PDF op de eigen website van een bestuursorgaan (gevonden met `woo_index`); optioneel alleen passages met een zoekterm.
- `woo_index`: de Woo-index uit het Register van Overheidsorganisaties (`api-organisaties.overheid.nl/v1/overheidsorganisaties/{tooi}/woo`, dezelfde gegevens als organisaties.overheid.nl/woo en open.overheid.nl/verwijzingen): per informatiecategorie waar het orgaan publiceert. De tool volgt die links: lijst-API's achter de pagina (uwv.nl: `fetch-results`, POST `{cluster:n}`), gewone HTML-links, op diepte 2 de bijlagen (PDF's) van gevonden subpagina's, en de zoekvragen naar zoek.officielebekendmakingen.nl via SRU (met de zoekterm). Raadsinformatiesystemen verwijzen naar `ori_search`. Alleen openbare webadressen worden opgehaald (geen IP-adressen, localhost of interne namen). Vergelijkt met het aantal documenten op open.overheid.nl.

Geregistreerd vanuit `registerEuForkTools`. Eén koppeling in upstream-code: de drie connectornamen `open_overheid`, `woo_index` en `woo_index_sites` in `src/utils/connector-runtime.ts` (gemarkeerd `FORK`; valt die bij een sync weg, dan faalt `tests/connector-runtime.test.ts`). Tests: `tests/fork-woo.test.ts`.

## Uitvoeringsinformatie, Woo-jurisprudentie en ANBI (`src/fork/juridische-bronnen.ts`)

Gevonden bij een scan van data.overheid.nl op bronnen voor juristen die de upstream-tools niet dekken:

- `puc_zoeken` / `puc_document_get`: PUC Open Data (puc.overheid.nl, KOOP): SVB Beleidsregels, IND werkinstructies en informatieberichten, RSJ-uitspraken, NZa-beleidsregels, ministeriële en Defensie publicaties. Zoekpagina's (`/{portaal}/zoeken/resultaat/q/{term}/p/{n}/[gdlv/1/]`) en documentpagina's (`/doc/PUC_…[/{versie}]`): tekst, versie en geldigheid, kenmerk en relaties (Juriconnect-artikelen, ECLI's, Staatscourant). PUC antwoordt alleen vanuit Europa (de Render-server staat in Frankfurt).
- `woo_jurisprudentie_zoeken`: de Woo-jurisprudentiedatabase van het ACOI (woo-wijzer.acoi.nl) via de JSON-RPC van de site (`/wh_services/acoi/jurisprudentie/`, `SearchJurisprudentie`): zoekterm, instantie, weigeringsgrond (art. 5.1/5.2/5.3 Woo), periode, pagina.
- `anbi_zoeken`: het ANBI-register van de Belastingdienst (open data, `anbi.zip` met XML), 12 uur gecachet; status (ook culturele ANBI) op een peildatum.

Niet gebouwd: het openbaar register van de Huurcommissie (portaal zonder open koppelvlak) en de toevoegingscijfers van de Raad voor Rechtsbijstand (alleen statistiek). Connectorcategorieën `puc`, `acoi`, `anbi` in het FORK-blok van `src/utils/connector-runtime.ts`. Tests: `tests/fork-juridische-bronnen.test.ts`.

## Uitspraken buiten rechtspraak.nl (`src/fork/geschilbeslechting.ts`)

- `raadvanstate_zoeken`: de zoekfunctie van raadvanstate.nl met haar eigen filters (rechtsgebied, proceduresoort zoals grote kamer, conclusie staatsraad A-G en overzichtsuitspraak, type, jaar). Alle uitspraken staan ook op rechtspraak.nl (steekproef oktober 2026: 18/18; per jaar heeft rechtspraak.nl evenveel of meer ECLI:NL:RVS); de tool geeft de ECLI, de tekst lees je via rechtspraak.nl.
- `crm_oordelen_zoeken`: oordelen van het College voor de Rechten van de Mens (filters discriminatiegrond, terrein, uitkomst, jaar; namen worden op het formulier van de site opgezocht).
- `onderwijsgeschillen_zoeken`: onderwijsgeschillen.nl via de publieke Algolia-zoeksleutel van de site zelf (commissie, onderwerp, jaar; facetten in de access_note).
- `geschillencommissie_zoeken`: De Geschillencommissie (commissie, jaar).
- `raad_van_arbitrage_zoeken`: Raad van Arbitrage in bouwgeschillen, een arbitrage-instituut (geen rechter): zoekformulier met sessiecookie, resultaten met PDF-link. Vrijwel niet op rechtspraak.nl (2025: ca. 9 van 193 vonnissen met ECLI:NL:RVAB).
- `mfn_tuchtrecht_zoeken`: MfN-register Tuchtrecht Updates (mediators; Tuchtcommissie M-…, College van Beroep B-…, annotaties).
- `geschil_uitspraak_get`: leest één uitspraak van deze sites (HTML of PDF, bij MfN ook de bron-PDF), optioneel alleen passages met een zoekterm.

Rolverdeling: NL-GOV-MCP vindt en leest; de verwijzingscontroleur (verify_legal_reference) controleert bestaan, r.o., citaat en bewering. Connectorcategorie `geschillen` in het FORK-blok van `src/utils/connector-runtime.ts`. Tests: `tests/fork-geschilbeslechting.test.ts`.

## Verdragen (`verdragen_zoeken`, `verdrag_get`, `hcch_verdrag_get`; `src/fork/verdragen.ts`)

- `verdragen_zoeken`: de Verdragenbank (verdragenbank.overheid.nl, BZ/KOOP), alle verdragen die het Koninkrijk binden. Vrije tekst via de KOOP-SRU (`repository.overheid.nl/sru`, `c.product-area==vd`, volledige gegevens: "apostille" vindt het Apostilleverdrag ook al staat dat woord niet in de Nederlandse titel); of de zoekfunctie van de site met haar filters: titel, onderwerp (`topic`), partij (`party`), Nederland depositaris; of de lijst van de Haagse Conferentie (`/nl/Verdrag/HaagseConferentie`).
- `verdrag_get`: het verdragsrecord als XML (`repository.overheid.nl/frbr/vd/{nr}/1/xml-nl/{nr}.xml`): titel, afkorting, sluiting, status per Koninkrijksdeel, Tractatenblad, goedkeuringswet, BWBV-id van de geconsolideerde tekst (lezen met `wetten_bwb_tekst`), partijen (ondertekening, ratificatie, inwerkingtreding, opzegging, voorbehouden met tekst en bezwaren daartegen, gebiedsdelen), bezwaren tegen toetreding, aangewezen autoriteiten, depositaire mededelingen en notificaties (Nederland is depositaris van de Haagse verdragen). Met `partij` alles over die ene partij.
- `hcch_verdrag_get`: hcch.net. Zonder `cid` de lijst: de pagina met verdragen plus de hoofdverdragen uit de *specialised sections* (apostille, service, evidence, child abduction, child support …; die staan niet op de lijstpagina), 24 uur gecachet. Met `cid` de officiële Engelse tekst, of één artikel, met links naar de HCCH-statustabel, centrale autoriteiten en de pdf's.

Geen koppeling in upstream-code behalve de registratie in `eu-tools.ts`. Tests: `tests/fork-verdragen.test.ts`.

## EHRM (`ehrm_zoeken`, `ehrm_uitspraak_get`; `src/fork/ehrm.ts`)

- `ehrm_zoeken`: de zoekdienst van HUDOC (`hudoc.echr.coe.int/app/query/results`; `sort` en `start` zijn verplicht, anders een 404). Filters: vrije tekst, verwerende staat (`respondent`, ISO-code; Nederlandse en Engelse namen worden omgezet), artikel, collectie (`documentcollectionid2`: JUDGMENTS, DECISIONS, ADVISORYOPINIONS, CLIN), Grote Kamer (`doctypebranch`), belang (`importance`), datum (`kpdate`) en taal (ENG, FRE, DUT voor de Nederlandse vertalingen/samenvattingen). Persberichten (`doctype:"PR"`) worden altijd uitgesloten: vrije tekst vindt ze anders ook, zelfs met een collectiefilter.
- `ehrm_uitspraak_get`: kiest bij een ECLI, itemid of verzoeknummer het arrest (Engels, anders Frans; Grote Kamer voor Kamer) en haalt de tekst via `app/conversion/docx/html/body`. De indeling volgt de koppen van het Hof: procedure, inleiding, feiten, rechtskader, klacht, standpunten (verzoeker, regering, derde-belanghebbende), beoordeling (algemene beginselen, toepassing, art. 41, art. 46), beslissing (na "FOR THESE REASONS", tot "Done in"), afzonderlijke meningen (na de beslissing, eigen nummering). De inhoudsopgave van Grote-Kamerarresten wordt overgeslagen (de tekst begint bij "sitting as a … Chamber"); een alinea is een regel die met het volgende nummer begint (ook "6 . On …"). Betekenis voor Nederland: res judicata als Nederland verwerende staat is, anders res interpretata; definitief of niet (tekst "is final" / "will become final", ouderdom, later Grote-Kamerarrest op hetzelfde verzoeknummer); beslissing en Protocol 16-advies. Nederlandse uitspraken die het arrest noemen via `lidoRelaties` op de ECLI.
- HUDOC weigert een volledige browser-user-agent (en eigen user-agents) met 403; deze module stuurt `User-Agent: Mozilla/5.0`.

Geen koppeling in upstream-code behalve de registratie in `eu-tools.ts`. Tests: `tests/fork-ehrm.test.ts`.

## Kifid, AP en open vakliteratuur (`src/fork/geschilbeslechting.ts`, `src/fork/toezicht.ts`, `src/fork/literatuur.ts`)

- `kifid_zoeken`: de zoek-API van kifid.nl (`/api/Search/SearchDecision/`, met slash, anders een 301). Datum in .NET-ticks; `pdfContent` bevat de volledige tekst, waaruit nummer, aard (bindend/niet-bindend advies), uitkomst en passages komen. De PDF is ook te lezen met `geschil_uitspraak_get`.
- `ap_documenten_zoeken` / `ap_document_get`: autoriteitpersoonsgegevens.nl (Drupal): `/documenten?keys=…&document_type[N]=N&page=` (0-based), kaarten `article.node-publication-card`, besluit als PDF onder `/system/files?file=…`. Een F5-firewall weigert sommige servers ("The requested URL was rejected"); de tools melden dat en verwijzen naar `officiele_bekendmakingen_search`, `woo_zoeken` en `rechtspraak_search_ecli`. De firewall wordt niet omzeild.
- `literatuur_zoeken`:
  - OpenAlex: `title_and_abstract.search` tenzij `zoeken_in: alles`; `type:!dataset`; OAPEN/DOAB als `locations.source.id`. Een eventuele `api_key` wordt nooit in de uitvoer opgenomen (`zonderSleutel`).
  - OpenAIRE Graph API v1 (`researchProducts`): `fos=0505 law`, `countryCode`, `instanceType=Doctoral thesis`, `bestOpenAccessRightLabel=OPEN`. Peer review staat in `instances[].refereed`. Zonder token 60 verzoeken per uur, met token 7200. Het token komt via client credentials (`OPENAIRE_CLIENT_ID`/`_SECRET`, aai.openaire.eu) of een refresh token (`OPENAIRE_REFRESH_TOKEN`, een maand geldig) en wordt 55 minuten bewaard.
  - CORE v3: de volledige tekst staat per output (`/outputs/{id}`).
  - `vakgebied: recht_eerst` (standaard): eerst binnen Recht (OpenAlex-subveld 3308, OpenAIRE fos 0505). Geeft dat minder dan 5 resultaten, dan wordt aangevuld met werken buiten Recht, gemarkeerd `vakgebied: "buiten Recht geclassificeerd"`.
- `literatuur_document_get`: probeert alle open vindplaatsen (PDF, `citation_pdf_url` op de repositoriumpagina) en valt op DOI terug op CORE. Een OpenAIRE-id met DOI gaat via OpenAlex.

Geen koppeling in upstream-code behalve de registratie in `eu-tools.ts` en de cachecategorieën `ap` en `literatuur`. Tests: `tests/fork-literatuur-toezicht.test.ts`.

## Wetsgeschiedenis (`wetsgeschiedenis_get`; `src/fork/wetsgeschiedenis.ts`)

- **Artikel**: wordt opgezocht in de BWB (`WettenBwbSource.tekst` en `BwbArtikelSource.getArtikel`, zoals `lido_relaties`), om de label-id te krijgen.
- **WTI**: de wetstechnische informatie (`repository.officiele-overheidspublicaties.nl/bwb/{id}/{id}.WTI`, BW Boek 7 is ongeveer 8 MB). Onder `<wijzigingen>` staat per `<regelingelement label-id>` per versie: datum, betreft (nieuw of wijziging), dossiernummer en Staatsblad (`urlidentifier`). Aanhangige wetsvoorstellen (`betreft` Aanhangig) staan op het niveau van `<regeling>` en gelden dus voor de hele wet.
- **Dossierkeuze**: de wet die het artikel invoerde gaat altijd mee, daarna de nieuwste wijzigingen (`max_dossiers`).
- **Kamerstukken**: uit de KOOP-SRU (`c.product-area==officielepublicaties and w.dossiernummer==… and w.publicatienaam==Kamerstuk`). De soort volgt uit het deel van de titel na de puntkomma.
- **Passages**: alleen in de kernstukken (MvT, RvS-advies en nader rapport, NnavV, nota van wijziging, memorie van antwoord), gevonden op het artikelnummer zoals Kamerstukken het schrijven ("artikel 7:669", "artikel 669", "art. 3:4"). De dossiers met de meeste treffers staan bovenaan.
- **Vóór 1995**: stukken van vóór 1995 staan niet bij KOOP; de tool verwijst dan naar Staten-Generaal Digitaal.

Tests: `tests/fork-wetsgeschiedenis.test.ts`.

## Richtlijnen van de rechtspraak (`rechtspraak_richtlijnen`; `src/fork/richtlijnen.ts`)

- **Bron**: de pagina's onder rechtspraak.nl/voor-advocaten-en-juristen/reglementen-procedures-en-formulieren; die worden op de server gerenderd, met pdf-links. Bewust geen strafrecht.
- **Titel**: is de linktekst alleen een geldigheid ("geldig vanaf 1 juli 2026"), dan is de titel de alinea erboven die op een dubbele punt eindigt, of anders de kop.
- **Geldigheid**: komt uit de titel ("geldig juli 2025-juni 2026", "per 1 februari 2026", "1 april 2017 - 1 februari 2026"). Per reeks (titel zonder datum) is de geldende versie de laatste die vóór de peildatum begon en niet is afgelopen.
- **Archief**: is een pagina per jaar ingedeeld (alimentatienormen: "Aangepast Rapport Alimentatienormen 2026"), dan telt alleen het laatste jaar tot de peildatum; de oudere secties zijn archief.

Tests: `tests/fork-richtlijnen.test.ts`.

## Zoeken in uitspraken via Open Data (`rechtspraak_zoeken_open_data`; `src/fork/rechtspraak-open-data.ts`)

- **Aanleiding**: sinds oktober 2026 weigert uitspraken.rechtspraak.nl/api/zoek (de zoekfunctie achter de website, die `rechtspraak_search_ecli` van WAINUTAI gebruikt) deze server met "Request Rejected" (HTTP 403, F5-firewall). Ophalen op ECLI via data.rechtspraak.nl werkt wel.
- **Bron**: de ECLI-index van Open Data van de Rechtspraak, `https://data.rechtspraak.nl/uitspraken/zoeken` (technische documentatie v1.15, § 4). Filters: `creator` (instantie), `subject` (rechtsgebied), `date` (uitspraakdatum, van en tot), `modified`, `return=DOC`, `sort=DESC`, `max` (≤ 1000), `from`. Geen zoeken op woorden; elke treffer bevat de inhoudsindicatie. Hoogstens 10 verzoeken per seconde; de module vraagt één pagina tegelijk met 150 ms pauze, standaard 5 pagina's (5000 uitspraken), hoogstens 10.
- **Zoeken op woorden**: in de inhoudsindicaties van de gelezen uitspraken; eerst uitspraken met alle woorden, bij te weinig treffers die met de meeste (gemarkeerd `gedeeltelijke_match`). Zonder opgegeven rechtsgebied wordt het uit de zoekwoorden afgeleid ("ontslag" → arbeidsrecht, "kinderalimentatie" → personen- en familierecht). Waardelijsten (rechtsgebieden, instanties) staan in de module, overgenomen van data.rechtspraak.nl/Waardelijst.
- **Volledige tekst** (`volledige_tekst: true`): leest daarnaast de hele tekst van de nieuwste uitspraken binnen de filters waarvan de inhoudsindicatie de woorden mist (`max_documenten`, standaard 100, hoogstens 300; 3 tegelijk met 300 ms pauze, onder de 10 verzoeken per seconde). Treffers krijgen `gevonden_in: "volledige tekst"` en de passage.
- **Proceduresoort** (`procedure`: kort geding, hoger beroep, cassatie, voorlopige voorziening, verzet, beschikking, …): de Open Data-index kent dat filter niet, dus per kandidaat in volgorde de metadata (`content?return=META`, enkele kB) tot er genoeg zijn, hoogstens 300. Labels zoals in de waardelijst Proceduresoorten; "kort geding" past ook op "Hoger beroep kort geding".
- **Terugval**: `installRechtspraakOpenData()` laat `RechtspraakSource.searchEcli` bij een fout van de websitezoekfunctie via Open Data zoeken, dus ook `rechtspraak_search_ecli` en `nl_gov_ask`. Werkt de websitezoekfunctie weer, dan gebruikt die tool haar weer vanzelf.

### Koppelingen in upstream-bestanden

- `src/sources/rechtspraak.ts`: `connector: "rechtspraak_zoek", // FORK` in de `postJson` van `searchEcli`: een eigen circuit, zodat weigeringen van de websitezoekfunctie het ophalen bij data.rechtspraak.nl niet blokkeren.
- `src/utils/connector-runtime.ts`: de categorieën `rechtspraak_zoek` en `rechtspraak_open_data` (gemarkeerd `FORK`).
- De terugval vervangt `RechtspraakSource.prototype.searchEcli`; hernoemt WAINUTAI die methode, dan faalt `tests/rechtspraak-open-data.test.ts` en meldt de upstream-sync het.

Tests: `tests/rechtspraak-open-data.test.ts` (offline, met bewaking van de koppelingen); live: `npx tsx scripts/live-rechtspraak-zoeken.ts`.

## Parameteraliassen (`src/fork/aliassen.ts`)

Andere namen voor parameters, zodat een aanroep met de verwachte naam werkt in plaats van te falen of stil te worden genegeerd: `officiele_bekendmakingen_record_get` `id` → `identifier`; `rechtspraak_zoeken_open_data` `zoekterm` → `query`; `lido_relaties` `ecli` → `id`; `literatuur_document_get` `id`/`doi` → `werk`; `verdrag_get` `id`/`nummer` → `verdrag`. Toegepast op elke tool door de `registerTool`-wrapper van `installHallucinatieBeveiliging`: het alias komt in het schema, een verplicht doel wordt optioneel en ontbreekt het toch, dan een nette fout. `hcch_verdrag_get` neemt `verdrag` (verdragsnummer of titelwoorden) en `nummer` zelf (`src/fork/verdragen.ts`): nummer → cid uit de full-text-pagina's (eens per dag), meerdere of geen treffers → fout met de kandidaten, nooit stil de hele lijst. Tests: `tests/fork-aliassen.test.ts`.

`wetsgeschiedenis_get` met `zoekterm` zoekt ook synoniemen van de wetgever (uitzonderingsclausule = exceptieclausule, ontsnappingsclausule, correctieclausule; …) en laat woorden over een regeleinde lopen; geen enkele treffer met de term → de passages over het artikelnummer, gemarkeerd `gevonden_op`. Kan geen enkel stuk worden opgehaald, dan een fout met `retry_after` in plaats van "geen passage".

`mapSourceError` (`src/utils/response.ts`, gemarkeerd `FORK`) geeft bij een time-out en een netwerk- of serverfout `retry_after: 30` mee.

## LiDO en Rechtspraak bij storingen (`src/fork/lido-robuust.ts`, `src/fork/bron-fouten.ts`, `src/fork/bron-gezondheid.ts`)

Aanleiding: op 21 en 28-10-2026 gaf `lido_relaties` "LiDO request failed" (en daarna `circuit_open`), terwijl Verwijzingscontrole dezelfde ECLI wel ophaalde; `rechtspraak_get_by_ecli` gaf soms "fetch failed". Een netwerkfout verloor zijn oorzaak, kwam niet in de log, werd één keer na 0,5 s herhaald en drie fouten op één ECLI zetten de circuit breaker vijf minuten open.

- Elke LiDO-serviceaanroep (`LIDO_VERZOEK`, ook in `src/sources/lido.ts`, regel gemarkeerd `FORK`): headers van Verwijzingscontrole, 20 s per verzoek, 3 herhalingen na 2, 5 en 10 s (ook bij 429, 5xx en netwerkfouten), cache van 24 uur per URL. IPv4 eerst (`dns.setDefaultResultOrder`).
- `src/utils/http.ts` (`FORK`): optie `retryDelaysMs`; een netwerkfout draagt de echte oorzaak (`fetch failed (ETIMEDOUT: connect ETIMEDOUT …)`, per adres bij een AggregateError) en elke mislukte poging komt als `source_request_failed` in de log.
- `src/utils/connector-runtime.ts` (`FORK`, `CIRCUIT_PER_CONNECTOR`): voor `lido`, `lido_portaal` en `rechtspraak` gaat de breaker pas open na 5 verschillende mislukte endpoints (dezelfde ECLI telt één keer) en is hij na 60 s half-open.
- `mapSourceError` geeft in `details` ook `code` en `oorzaak`.
- Falen de services, dan leest `lido_relaties` de portaallijst (`spiegel-lijstweergave`, één pagina, de richting die het portaal toont, zonder labels en facetten); `bron` is dan `lido-portaal` en de access_note zegt waarom. Een BWB-id zonder artikel heeft get-id nodig en valt niet terug.
- `rechtspraak_get_by_ecli`: eerst het oude directe verzoek; gooit dat of geeft het 5xx/429, dan de route van `rechtspraak_uitspraak_get` (gedeelde client, 3 herhalingen); `bron` zegt welke.
- Tool `bronnen_status`: test nu, zonder cache, LiDO-services, LiDO-portaal, de content-service en de Open Data-index, met status, tijd, oorzaak en breakerstand.

Tests: `tests/lido-robuust.test.ts`; live tegen de draaiende server (standaard de Funnel-URL, `LIVE_MCP_URL` om te wijzigen): `npx vitest run --config vitest.live.config.ts tests/lido-robuust.live.test.ts` (ECLI:NL:CRVB:2021:2984, ECLI:NL:CRVB:2024:2331, BWBR0005537 art. 7:2).

## Sleutels op de eigen computers (`src/load-env.ts`, `scripts/update-local.mjs`)

Deze repository is openbaar, dus de sleutels van de bronnen van de fork (`OPENALEX_API_KEY`, `CORE_API_KEY`, `OPENAIRE_CLIENT_ID`, `OPENAIRE_CLIENT_SECRET`) staan er niet in.

- **Op Render** staan ze als omgevingsvariabelen.
- **Op de eigen computers** leest `load-env` ze uit `bronsleutels.env` in de privé-repo `verwijzingscontrole` (of `verwijzingscontrole-en-uitbreiding`) naast deze map. `update-lokaal` werkt die repo mee bij, dus er hoeft niets te worden ingevoerd.
- **Voorrang**: een sleutel uit dat bestand vult alleen aan wat nog niet is gezet. Een lege waarde telt als niet gezet. Een eigen `.env` en de omgeving gaan voor.

## Diagnose, geldigheid, bekende valkuilen en foutlog (`src/fork/hallucinatie.ts`, `src/fork/foutlog.ts`)

Fouten van het taalmodel bij het opzoeken van juridische bronnen opvangen en ervan leren (Zeno, "The hallucination trap", sept. 2026). Dezelfde aanpak als in de verwijzingscontroleur (`diagnose.js`, `foutlog.js` daar).

- **Waar**: `bwb_artikel_tekst`, `wetten_bwb_tekst`, `wetten_bwb_search` (als de zoekvraag een artikel noemt: "artikel 843a Rv"), `rechtspraak_get_by_ecli` en `rechtspraak_uitspraak_get`. De resultaten krijgen bovenaan extra velden; de tools zelf in `src/tools.ts` zijn niet gewijzigd.
- **`diagnose`** bij een lege of mislukte opzoeking: `wet_onbekend` (met `suggesties`), `artikel_bestaat_niet_in_geldende_versie` (met `vervallen_per`, `wijzigingswet` en de versies uit de WTI, of `nog_niet_in_werking` met `in_werking_per`), `artikel_bestond_nooit` (in geen enkele versie in de WTI), `ecli_onbekend`, `ecli_zonder_tekst`, `toolfout` (met de foutmelding). Of een artikel eerder bestond, komt uit de wetstechnische informatie (`<datum label="Artikel 843a">`, `betreft` nieuw/wijziging/vervallen), een uur gecachet.
- **`geldigheid`** op de peildatum (`peildatum`; bij `bwb_artikel_tekst` ook `datum`): `geldend`, `vervallen` (datum), `gewijzigd_sinds_peildatum` (datum, door de versie van vandaag te vergelijken) of `nog_niet_in_werking`.
- **`bekende_valkuil`**: uit `data/bekende-valkuilen.json` (hetzelfde bestand als `bekende-valkuilen.json` in de verwijzingscontroleur: wijzig beide), ook als de BWB niet bereikbaar is. Nu: art. 843a Rv (vervallen per 1-1-2025, Stb. 2024, 62 en 72; opvolger art. 194-195a Rv; overgangsrecht art. XIIA). Alleen opnemen wat in de officiële bron is gelezen, met vindplaats.
- **Foutlog**: elke aanroep van elke tool telt mee (tabel `aanroepen`, zonder inhoud); elke diagnose, niet-geldende uitkomst of valkuil wordt één regel in `foutlog_nl_gov_mcp` (tijdstip, server `render` of `lokaal-<computernaam>`, tool, verwijzing, invoer zonder vrije tekst, uitkomst, diagnose, peildatum). Nooit een zoekterm of andere vrije tekst. Centrale Postgres via `FOUTLOG_DATABASE_URL` (Render: omgevingsvariabele; pc's: `bronsleutels.env` in de verwijzingscontroleur), lokale kopie en wachtrij in `%USERPROFILE%\mcp-lokaal\foutlog\`. Synchronisatie, `foutlog_rapport` en `npm run hertest-foutlog` zitten in de verwijzingscontroleur. Logging is asynchroon met time-out; een fout geeft alleen een waarschuwing op stderr.
- **Koppeling in upstream-code**: twee regels in `src/server.ts` (gemarkeerd `FORK`): de import en `installHallucinatieBeveiliging(server)` vóór `registerTools(server)`. Die vervangt `server.registerTool` door een omhulsel dat telt, de vijf tools aanvult en de tooldescripties uitbreidt (en `peildatum` toevoegt aan `bwb_artikel_tekst`). Plus het veld `status` in `src/sources/bwb-artikel.ts`. De workflow *Upstream sync* controleert de koppeling.

Tests: `tests/fork-hallucinatie.test.ts` (tien patronen als regressietest, offline).

## Nachtelijke update en upstream-sync met meldingen in Workflowy

- `scripts/nachtelijke-update.mjs`: de geplande taak *MCP nachtelijke update* (door `update-lokaal.cmd` ingesteld, 03:30, ook later als de computer uit stond). Alleen als er iets bij te werken is: Claude sluiten, `update-local.mjs` (pull, install, build, terugdraaien bij een fout), rooktest per server (stdio: initialize en tools/list), Claude weer starten. Buiten 01:00-06:00 wordt een draaiende Claude nooit gesloten. Een fout wordt een taak in de Workflowy-Inbox met de computer en de oorzaak (`scripts/meld-workflowy.mjs`, `WORKFLOWY_API_KEY` uit `bronsleutels.env`).
- `.github/workflows/upstream-sync.yml`: dagelijks; slagen type-check, build, alle tests en de controle van de fork-koppelingen, dan gaat de merge automatisch naar `main` (melding in Workflowy). Anders niets op `main`, een pull request op `upstream-sync` (of de conflicten in de samenvatting van de run) en een taak in Workflowy. Secret `WORKFLOWY_API_KEY`.
