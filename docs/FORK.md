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
