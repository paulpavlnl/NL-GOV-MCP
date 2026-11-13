/**
 * FORK (docs/FORK.md): rechterprofiel. Een feitelijk profiel van een rechtsprekend
 * persoon: functies en nevenbetrekkingen uit het openbare nevenfunctieregister van de
 * Rechtspraak, plus gepubliceerde uitspraken waarin die persoon in de samenstelling staat.
 *
 * - Register: www.rechtspraak.nl/registers/nevenfunctieregister/zoeken?searchterm=… en
 *   …/details/<id> worden aan de serverkant gerenderd; de gegevens staan als JSON in
 *   <script id="rnl-state"> (neroSearchResults, neroRechterlijkeAmbtenaarDetails).
 * - Uitspraken: het register noemt geen uitspraken. Gezocht wordt in de volledige tekst
 *   (uitspraken.rechtspraak.nl/api/zoek) op "<voorletters> <achternaam>"; elke treffer
 *   wordt getoetst aan de loopbaan uit het register (gerecht en periode) en, voor de
 *   eerste treffers, aan de samenstelling in de tekst ("gewezen/gedaan door mr. …").
 * Alleen feiten; geen oordeel over de persoon.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MCPRecord, ToolResult } from "../types.js";
import { getText, postJson } from "../utils/http.js";
import { errorResponse, mapSourceError, successResponse, toMcpToolPayload } from "../utils/response.js";

const REGISTER = "https://www.rechtspraak.nl/registers/nevenfunctieregister";
const ZOEK_API = "https://uitspraken.rechtspraak.nl/api/zoek";
const CONTENT = "https://data.rechtspraak.nl/uitspraken/content";
// Geen nagebootste browser-identiteit: de zoeker van rechtspraak.nl weigert die (HTTP 403).

export interface Beroep { functie: string; instantie: string; ingangsdatum?: string; einddatum?: string; opmerkingen?: string }
export interface Nevenbetrekking { [k: string]: unknown }
export interface RegisterDetail {
  samengesteldeNaam: string;
  actieveBeroepsgegevens?: Beroep[];
  historieBeroepsgegevens?: Beroep[];
  beroepsgegevensBuitenRM?: Beroep[];
  vervultGeenNevenbetrekkingen?: boolean;
  heeftGeenOpgaveNevenbetrekkingen?: boolean;
  huidigeNevenbetrekkingen?: Nevenbetrekking[];
  voorgaandeNevenbetrekkingen?: Nevenbetrekking[];
  voorgaandeBetrekkingen?: Nevenbetrekking[];
}
export interface RegisterTreffer { id: string; samengesteldeNaam: string; actieveBeroepsgegevens?: Beroep[] }

/** De JSON uit <script id="rnl-state">. */
export function rnlState(html: string): Record<string, unknown> {
  const m = /<script[^>]*id="rnl-state"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("nevenfunctieregister: geen gegevens in de pagina (opbouw gewijzigd?)");
  return JSON.parse(m[1]) as Record<string, unknown>;
}

async function registerPagina(pad: string): Promise<Record<string, unknown>> {
  const { data } = await getText(`${REGISTER}${pad}`, { connector: "rechtspraak", timeoutMs: 25_000, retries: 2, cacheTtlMs: 6 * 3600_000, headers: { Accept: "text/html" } });
  return rnlState(data);
}

export async function zoekRegister(naam: string): Promise<RegisterTreffer[]> {
  const s = await registerPagina(`/zoeken?searchterm=${encodeURIComponent(naam)}`);
  return (s.neroSearchResults as RegisterTreffer[] | undefined) ?? [];
}

export async function registerDetail(id: string): Promise<RegisterDetail> {
  const s = await registerPagina(`/details/${encodeURIComponent(id)}`);
  const d = s.neroRechterlijkeAmbtenaarDetails as RegisterDetail | undefined;
  if (!d?.samengesteldeNaam) throw Object.assign(new Error(`geen persoon met id ${id} in het nevenfunctieregister`), { status: 404 });
  return d;
}

const TITELS = /^(?:(?:mr|drs|dr|prof|ir|ing|bc|mw|dhr)\.?\s+|(?:LL\.?M\.?|M\.?A\.?|MSc|BSc|LLB|PhD|MBA)\b\s*)+/i;

/** Voorletters en achternaam uit "mr. drs. T.J. Sleeswijk Visser-De Boer". */
export function splitNaam(samengesteld: string): { voorletters: string; achternaam: string; hoofdnaam: string } {
  let rest = samengesteld.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4; i++) rest = rest.replace(TITELS, "").trim();
  rest = rest.replace(/,?\s*(?:LL\.?M\.?|M\.?A\.?|MSc|BSc|LLB|PhD|MBA)\.?$/i, "").trim();
  const m = /^((?:[A-Z][a-z]{0,2}\.\s?)+)\s*(.+)$/.exec(rest);
  const voorletters = m ? m[1].replace(/\s+/g, "") : "";
  const achternaam = (m ? m[2] : rest).trim();
  // Hoofdnaam: het deel vóór een koppelteken (eigen naam bij een dubbele achternaam).
  const hoofdnaam = achternaam.split(/\s*[-–]\s*/)[0].trim();
  return { voorletters, achternaam, hoofdnaam };
}

/** Vergelijkbare vorm: kleine letters, zonder accenten, één soort streepje en spatie. */
export function vouw(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[‐-―]/g, "-").replace(/['’`]/g, "'").replace(/\s+/g, " ").toLowerCase().trim();
}

/** Gerechtsnaam vergelijkbaar maken: oude namen naar de huidige. */
export function gerechtSleutel(naam: string): string {
  return vouw(naam).replace(/'s-gravenhage/g, "den haag").replace(/'s-hertogenbosch/g, "den bosch").replace(/^gerechtshof\s+/, "hof ").replace(/^rechtbank\s+/, "rb ");
}

export interface Aanstelling { functie: string; instantie: string; van?: string; tot?: string }

export function loopbaan(d: RegisterDetail): Aanstelling[] {
  const rij = (b: Beroep): Aanstelling => ({ functie: b.functie, instantie: b.instantie, van: b.ingangsdatum, tot: b.einddatum || undefined });
  return [...(d.actieveBeroepsgegevens ?? []).map(rij), ...(d.historieBeroepsgegevens ?? []).map(rij)];
}

/** Valt een uitspraak (gerecht, datum JJJJ-MM-DD) binnen een aanstelling uit het register? */
export function binnenLoopbaan(aanstellingen: Aanstelling[], gerecht: string, datum: string | undefined): Aanstelling | undefined {
  const g = gerechtSleutel(gerecht);
  return aanstellingen.find((a) => {
    const ag = gerechtSleutel(a.instantie);
    if (!(ag === g || g.startsWith(ag) || ag.startsWith(g))) return false;
    if (!datum) return true;
    return (!a.van || datum >= a.van) && (!a.tot || datum <= a.tot);
  });
}

/** Zoekt in de tekst de zin met de samenstelling en kijkt of de naam erin staat. */
export function samenstelling(tekst: string, hoofdnaam: string, voorletters: string): { gevonden: boolean; rol?: string; zin?: string; wraking?: boolean } {
  const plat = tekst.replace(/\s+/g, " ");
  const h = vouw(hoofdnaam);
  // Vast venster na "door": afkortingen als "mr." maken zinsgrenzen onbetrouwbaar.
  const zinnen = plat.match(/(?:gewezen|gedaan|gegeven|vastgesteld|uitgesproken|behandeld)\s+door\s+[\s\S]{0,350}/gi) ?? [];
  const samenstellingZin = plat.match(/samenstelling[:\s][\s\S]{0,400}/gi) ?? [];
  for (const z of [...zinnen, ...samenstellingZin]) {
    const v = vouw(z);
    const i = v.indexOf(h);
    if (i < 0) continue;
    // Voorletters moeten, als ze er staan, kloppen (voorkomt naamgenoten in dezelfde zin).
    const ervoor = v.slice(Math.max(0, i - 25), i);
    const vl = vouw(voorletters);
    if (vl && /[a-z]\.\s?[a-z]?\.?\s*$/.test(ervoor) && !ervoor.replace(/\s/g, "").endsWith(vl.replace(/\s/g, ""))) continue;
    const na = v.slice(i, i + 160);
    const rol = /^[^,]*,\s*(voorzitter|senior rechter|rechter-plaatsvervanger|raadsheer-plaatsvervanger|kinderrechter|kantonrechter|rechter-commissaris|raadsheer|rechter|lid|staatsraad|griffier)/.exec(na)?.[1];
    return { gevonden: true, rol, zin: z.trim().slice(0, 400) };
  }
  // Niet in de samenstelling: is het een wrakingszaak over deze rechter?
  const vp = vouw(plat);
  let j = vp.indexOf(h);
  while (j >= 0) {
    if (/wrak/.test(vp.slice(Math.max(0, j - 160), j))) return { gevonden: false, wraking: true };
    j = vp.indexOf(h, j + h.length);
  }
  return { gevonden: false };
}

interface ApiTreffer { TitelEmphasis?: string; Titel?: string; Tekstfragment?: string; Uitspraakdatum?: string; Rechtsgebieden?: string[]; Proceduresoorten?: string[]; DeeplinkUrl?: string }

async function zoekUitspraken(term: string, max: number): Promise<{ items: ApiTreffer[]; totaal: number }> {
  const items: ApiTreffer[] = [];
  let totaal = 0;
  for (let start = 0; start < max; start += 50) {
    const payload = { StartRow: start, PageSize: Math.min(50, max - start), ShouldReturnHighlights: false, ShouldCountFacets: false, SortOrder: "UitspraakDatumDesc", SearchTerms: [{ Term: term, Field: "AlleVelden" }], Contentsoorten: [], Rechtsgebieden: [], Instanties: [], DatumPublicatie: [], DatumUitspraak: [], Advanced: { PublicatieStatus: "AlleenGepubliceerd" }, CorrelationId: Math.random().toString(16).slice(2), Proceduresoorten: [] };
    const { data } = await postJson<{ Results?: ApiTreffer[]; ResultCount?: number }>(ZOEK_API, payload, { connector: "rechtspraak_zoek", timeoutMs: 25_000, retries: 2, headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/json" } });
    totaal = data.ResultCount ?? totaal;
    const r = data.Results ?? [];
    items.push(...r);
    if (r.length < payload.PageSize || items.length >= totaal) break;
  }
  return { items, totaal };
}

async function uitspraakTekst(ecli: string): Promise<string> {
  const { data } = await getText(`${CONTENT}?id=${encodeURIComponent(ecli)}`, { connector: "rechtspraak", timeoutMs: 25_000, retries: 2, cacheTtlMs: 24 * 3600_000 });
  return data.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&[a-z]+;/g, " ");
}

const ddmmjjjjNaarIso = (d?: string) => (d && /^\d{2}-\d{2}-\d{4}$/.test(d) ? `${d.slice(6)}-${d.slice(3, 5)}-${d.slice(0, 2)}` : undefined);

const NOTE = "Bronnen: het openbare nevenfunctieregister van de Rechtspraak (functies binnen de Rechtspraak tot zes jaar terug en nevenbetrekkingen; jaarlijks bijgewerkt) en de gepubliceerde uitspraken op rechtspraak.nl (een klein deel van alle uitspraken). Uitspraken zijn gevonden op naam in de volledige tekst; 'in_samenstelling' = de naam staat in de zin met de samenstelling ('gewezen/gedaan door mr. …'), 'binnen_loopbaan' = gerecht en datum passen bij een functie uit het register; 'wraking_van_deze_rechter' = beslissing op een wrakingsverzoek tegen deze persoon (door andere rechters). Treffers zonder beide kunnen een naamgenoot zijn of de naam in een andere rol noemen. Feiten, geen beoordeling van de persoon.";

export async function rechterProfiel(args: { naam?: string; id?: string; max_uitspraken: number; controleer: number; alleen_bevestigd: boolean }): Promise<ToolResult> {
  try {
    let id = args.id?.trim();
    if (!id) {
      const naam = args.naam?.trim();
      if (!naam) return errorResponse({ error: "unexpected", message: "naam of id ontbreekt", suggestion: "Geef een achternaam (eventueel met voorletters), of het id uit een eerdere zoekopdracht." });
      const treffers = await zoekRegister(naam);
      const v = vouw(naam);
      const exact = treffers.filter((t) => vouw(t.samengesteldeNaam).includes(v) && v.includes(" "));
      const keuze = treffers.length === 1 ? treffers : exact.length === 1 ? exact : [];
      if (keuze.length !== 1) {
        return successResponse({
          summary: treffers.length ? `${treffers.length} personen in het nevenfunctieregister voor '${naam}'; kies er één (id).` : `Niemand in het nevenfunctieregister voor '${naam}'.`,
          records: treffers.map((t) => ({ title: t.samengesteldeNaam, source_name: "nevenfunctieregister", canonical_url: `${REGISTER}/details/${t.id}`, snippet: (t.actieveBeroepsgegevens ?? []).map((b) => `${b.functie}, ${b.instantie}`).join("; "), data: { id: t.id, functies: t.actieveBeroepsgegevens ?? [] } })),
          provenance: { tool: "rechter_profiel", endpoint: `${REGISTER}/zoeken`, query_params: { naam }, timestamp: new Date().toISOString(), returned_results: treffers.length, total_results: treffers.length },
          access_note: "Roep rechter_profiel opnieuw aan met id van de juiste persoon (voorletters plus achternaam als naam werkt ook als dat één persoon oplevert). Zoeken kan op achternaam, voorletters of beide.",
        });
      }
      id = keuze[0].id;
    }

    const d = await registerDetail(id);
    const { voorletters, achternaam, hoofdnaam } = splitNaam(d.samengesteldeNaam);
    const aanstellingen = loopbaan(d);
    const term = voorletters ? `"${voorletters} ${hoofdnaam}"` : `"${hoofdnaam}"`;
    let items: ApiTreffer[] = [];
    let totaal = 0;
    let zoekFout: string | undefined;
    try {
      ({ items, totaal } = await zoekUitspraken(term, args.max_uitspraken));
    } catch (e) {
      zoekFout = e instanceof Error ? e.message : String(e);
    }

    const uitspraken = items.map((t) => {
      const ecli = String(t.TitelEmphasis ?? "").match(/ECLI:[A-Z]{2}:[A-Z0-9]+:\d{4}:[A-Z0-9.]+/i)?.[0]?.toUpperCase() ?? "";
      const gerecht = String(t.Titel ?? "").split(",")[0].trim();
      const datum = ddmmjjjjNaarIso(t.Uitspraakdatum);
      const aanstelling = binnenLoopbaan(aanstellingen, gerecht, datum);
      return { ecli, gerecht, datum, titel: t.Titel ?? "", inhoudsindicatie: t.Tekstfragment ?? "", rechtsgebieden: t.Rechtsgebieden ?? [], procedure: t.Proceduresoorten ?? [], aanstelling, samenstelling: undefined as ReturnType<typeof samenstelling> | undefined };
    }).filter((u) => u.ecli);

    // Tekstcontrole: eerst de treffers binnen de loopbaan, dan de rest, hooguit `controleer`, 3 tegelijk.
    const volgorde = [...uitspraken.filter((u) => u.aanstelling), ...uitspraken.filter((u) => !u.aanstelling)].slice(0, args.controleer);
    for (let i = 0; i < volgorde.length; i += 3) {
      await Promise.all(volgorde.slice(i, i + 3).map(async (u) => {
        try { u.samenstelling = samenstelling(await uitspraakTekst(u.ecli), hoofdnaam, voorletters); } catch { /* blijft ongecontroleerd */ }
      }));
    }

    const status = (u: (typeof uitspraken)[number]) => (u.samenstelling?.gevonden ? "in_samenstelling" : u.samenstelling?.wraking ? "wraking_van_deze_rechter" : u.samenstelling ? "niet_in_samenstelling" : u.aanstelling ? "binnen_loopbaan_ongecontroleerd" : "onzeker");
    const getoond = uitspraken.filter((u) => !args.alleen_bevestigd || u.samenstelling?.gevonden);

    const kop: MCPRecord = {
      title: `Profiel ${d.samengesteldeNaam}`,
      source_name: "nevenfunctieregister",
      canonical_url: `${REGISTER}/details/${id}`,
      snippet: (d.actieveBeroepsgegevens ?? []).map((b) => `${b.functie}, ${b.instantie} (sinds ${b.ingangsdatum})`).join("; "),
      data: {
        id,
        naam: d.samengesteldeNaam,
        huidige_functies: d.actieveBeroepsgegevens ?? [],
        eerdere_functies: d.historieBeroepsgegevens ?? [],
        functies_buiten_rechtspraak: d.beroepsgegevensBuitenRM ?? [],
        nevenbetrekkingen: d.huidigeNevenbetrekkingen ?? [],
        eerdere_nevenbetrekkingen: d.voorgaandeNevenbetrekkingen ?? [],
        eerdere_betrekkingen: d.voorgaandeBetrekkingen ?? [],
        vervult_geen_nevenbetrekkingen: d.vervultGeenNevenbetrekkingen ?? false,
        geen_opgave_nevenbetrekkingen: d.heeftGeenOpgaveNevenbetrekkingen ?? false,
        zoekterm_uitspraken: term,
      },
    };
    const records: MCPRecord[] = [kop, ...getoond.map((u) => ({
      title: `${u.ecli} · ${u.gerecht} · ${u.datum ?? ""}`,
      date: u.datum,
      source_name: "rechtspraak",
      canonical_url: `https://uitspraken.rechtspraak.nl/details?id=${u.ecli}`,
      snippet: u.inhoudsindicatie.slice(0, 400),
      data: { ecli: u.ecli, gerecht: u.gerecht, uitspraakdatum: u.datum, rechtsgebieden: u.rechtsgebieden, procedure: u.procedure, status: status(u), rol: u.samenstelling?.rol, samenstelling: u.samenstelling?.zin, binnen_loopbaan: u.aanstelling ? `${u.aanstelling.functie}, ${u.aanstelling.instantie}` : null },
    }))];

    const bevestigd = uitspraken.filter((u) => u.samenstelling?.gevonden).length;
    const nb = (d.huidigeNevenbetrekkingen ?? []).length;
    return successResponse({
      summary: `${d.samengesteldeNaam}: ${(d.actieveBeroepsgegevens ?? []).map((b) => `${b.functie}, ${b.instantie}`).join("; ") || "geen huidige functie"}; ${d.vervultGeenNevenbetrekkingen ? "geen nevenbetrekkingen" : `${nb} nevenbetrekking${nb === 1 ? "" : "en"}`}. Uitspraken op ${term}: ${totaal} in de volledige tekst, ${uitspraken.length} bekeken, ${bevestigd} met de naam in de samenstelling (${volgorde.length} teksten gecontroleerd).`,
      records,
      provenance: { tool: "rechter_profiel", endpoint: `${REGISTER}/details; ${ZOEK_API}`, query_params: { id, zoekterm: term }, timestamp: new Date().toISOString(), returned_results: records.length, total_results: totaal },
      access_note: `${zoekFout ? `UITSPRAKEN NIET OPGEHAALD: de zoeker van rechtspraak.nl gaf een fout (${zoekFout}); het registerdeel is volledig, probeer de uitspraken later opnieuw. ` : ""}${NOTE}${achternaam !== hoofdnaam ? ` Gezocht op de hoofdnaam '${hoofdnaam}' (zonder '${achternaam.slice(hoofdnaam.length).replace(/^\s*[-–]\s*/, "")}'), omdat uitspraken een dubbele naam niet altijd voluit schrijven.` : ""} Meer uitspraken: verhoog max_uitspraken (tot 500) en controleer (tot 60).`,
    });
  } catch (e) {
    if ((e as { status?: number }).status === 404) return errorResponse({ error: "unexpected", message: (e as Error).message, suggestion: "Zoek eerst op naam; gebruik dan het id uit de resultaten." });
    return mapSourceError(e, "rechtspraak");
  }
}

export function registerRechterProfiel(server: McpServer, deps: { TOOL_ANNOTATIONS: Record<string, unknown> }): void {
  server.registerTool("rechter_profiel", {
    description: "Factual profile of a Dutch judge or other rechtsprekend person: current and earlier functions (court, dates) and nevenbetrekkingen from the official nevenfunctieregister of the Rechtspraak, plus published rulings on rechtspraak.nl in which the person sits on the bench (found by name in the full text, checked against the career in the register and against the composition sentence 'gewezen door mr. …'). With a name that matches several people it returns the candidates with their id; call again with id. Facts only, no assessment of the judge.",
    inputSchema: {
      naam: z.string().optional().describe("Achternaam, voorletters, of beide, bijv. 'Visser' of 'T.J. Sleeswijk Visser'."),
      id: z.string().optional().describe("Id uit een eerdere rechter_profiel-zoekopdracht (uniek)."),
      max_uitspraken: z.number().int().min(0).max(500).default(100).describe("Hoeveel treffers uit de volledige tekst bekijken (nieuwste eerst)."),
      controleer: z.number().int().min(0).max(60).default(20).describe("Van hoeveel uitspraken de tekst te lezen om de samenstelling te controleren."),
      alleen_bevestigd: z.boolean().default(false).describe("Alleen uitspraken tonen waarin de naam in de samenstelling is gevonden."),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (args) => toMcpToolPayload(await rechterProfiel(args)));
}
