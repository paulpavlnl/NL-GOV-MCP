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
