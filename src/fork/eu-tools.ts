/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. Registers eurlex_tekst_get and
 * builds its result, which nl_gov_ask also uses for an EU ECLI in a question.
 * The only hooks in upstream files are one import plus one call in
 * src/tools.ts and the optional euTekstResult dependency of nl_gov_ask;
 * tests/fork-eu-guard.test.ts fails when an upstream merge drops them.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, MCPRecord, ToolResult } from "../types.js";
import type { LidoSource } from "../sources/lido.js";
import { errorResponse, mapSourceError, nowIso, successResponse, toMcpToolPayload } from "../utils/response.js";
import { installLidoArtikelFallback, lidoObjectFromArtikel } from "./lido-artikel.js";
import { groepeerPerType, lidoLookups, lidoRelaties, parseJci } from "./lido-relaties.js";
import { registerWooTools } from "./woo.js";
import { registerJuridischeBronnen } from "./juridische-bronnen.js";
import { registerGeschilbeslechting } from "./geschilbeslechting.js";
import { registerVerdragen } from "./verdragen.js";
import { registerEhrm } from "./ehrm.js";
import { registerLiteratuur } from "./literatuur.js";
import { registerToezicht } from "./toezicht.js";
import { registerWetsgeschiedenis } from "./wetsgeschiedenis.js";
import { registerRichtlijnen } from "./richtlijnen.js";
import { registerRechtspraakOpenData } from "./rechtspraak-open-data.js";
import { registerBronGezondheid } from "./bron-gezondheid.js";
import { installLidoNetwerk } from "./lido-robuust.js";
import { WettenBwbSource } from "../sources/wetten-bwb.js";
import { BwbArtikelSource } from "../sources/bwb-artikel.js";
import { CELLAR_CELEX, CELLAR_SPARQL, EURLEX_NL, EuTekstSource, type EuMetadata, type EuTekst } from "./eu-bron.js";
import {
  analyseUitspraak,
  analyseWetgeving,
  checkCitaat,
  hasEuReference,
  parseEuReferences,
  parseEuSectie,
  randnummerBereik,
  searchUnits,
  TAAL_NAAM,
  type EuEenheid,
} from "./eu-tekst.js";

export const EU_TEKST_DEFAULT_CHARS = 12_000;
export const EU_TEKST_MAX_CHARS = 50_000;
const TOC_MAX = 80;
const ARTIKEL_LIST_MAX = 250;

export interface EuTekstArgs {
  id: string;
  sectie?: string;
  zoekterm?: string;
  citaat?: string;
  max_chars: number;
  lido?: boolean;
}

const ACCESS_NOTE_BASE =
  "Bron: CELLAR/EUR-Lex (Publicatiebureau van de EU). Resolutie via CELLAR SPARQL (owl:sameAs tussen resource/ecli, resource/celex en resource/case); " +
  "tekst via content negotiation op resource/celex (Accept-Language: nl). Alleen de in het Publicatieblad/de Jurisprudentie bekendgemaakte tekst is authentiek.";

function prov(endpoint: string, query_params: Record<string, string>, n: number) {
  return { tool: "eurlex_tekst_get", endpoint, query_params, timestamp: nowIso(), returned_results: n, total_results: n };
}

function cut(text: string, max: number): { tekst: string; ingekort: boolean } {
  return text.length > max ? { tekst: `${text.slice(0, max)}…`, ingekort: true } : { tekst: text, ingekort: false };
}

/** The result of eurlex_tekst_get as a ToolResult (also used by nl_gov_ask). */
export async function euTekstResult(source: EuTekstSource, lido: Pick<LidoSource, "references"> | undefined, args: EuTekstArgs): Promise<ToolResult> {
  const refs = parseEuReferences(args.id);
  const query: Record<string, string> = { id: args.id, max_chars: String(args.max_chars), ...(args.sectie ? { sectie: args.sectie } : {}), ...(args.zoekterm ? { zoekterm: args.zoekterm } : {}), ...(args.citaat ? { citaat: args.citaat.slice(0, 200) } : {}) };
  if (!hasEuReference(refs)) {
    return errorResponse({
      error: "unexpected",
      message: `Geen EU-verwijzing herkend in '${args.id.slice(0, 120)}'.`,
      suggestion: "Geef een ECLI (ECLI:EU:C:2005:321), CELEX (62003CJ0478, 32001L0023, 32016R0679), zaaknummer (C-478/03, T-12/19, 'zaak 287/86') of citaat ('Richtlijn 2001/23/EG', 'Verordening (EU) 2016/679').",
    });
  }
  const sectie = args.sectie?.trim() ? parseEuSectie(args.sectie) : null;
  if (args.sectie?.trim() && !sectie) {
    return errorResponse({ error: "unexpected", message: `Sectie '${args.sectie.slice(0, 80)}' niet begrepen.`, suggestion: "Gebruik een randnummer ('39', 'punt 39', '39-44'), 'dictum', 'artikel 3' of 'overweging 12'." });
  }

  try {
    const res = await source.resolve(refs);
    if (!res.celex) {
      return successResponse({
        summary: `${args.id.slice(0, 100)}: niet gevonden in CELLAR`,
        records: [],
        provenance: prov(CELLAR_SPARQL, query, 0),
        access_note: `${ACCESS_NOTE_BASE} CELLAR kent ${res.identificaties.map((i) => i.invoer).join(", ")} niet: het document bestaat niet (of het nummer is verkeerd geschreven). Controleer de identificatie of zoek met eurlex_search.`,
      });
    }
    const [meta, tekst, lidoOut] = await Promise.all([
      source.metadata(res.celex),
      source.text(res.celex),
      args.lido === false || !lido ? Promise.resolve(undefined) : lidoCounts(lido, res.celex, refs.eclis),
    ]);
    return buildResult({ args, query, res, meta, tekst, lidoOut, celex: res.celex, sectie });
  } catch (e) {
    return mapSourceError(e, "CELLAR/EUR-Lex", EURLEX_NL + (refs.caseCelex[0] ?? refs.legislationCelex[0] ?? ""));
  }
}

async function lidoCounts(lido: Pick<LidoSource, "references">, celex: string, eclis: string[]): Promise<Record<string, unknown>> {
  // LiDO knows EU rulings by ECLI and EU legislation by CELEX.
  const id = celex.startsWith("6") ? eclis[0] : celex;
  if (!id) return { opmerking: "Geen ECLI om LiDO mee te bevragen." };
  try {
    const out = await lido.references({ id });
    const item = out.items[0] ?? {};
    return { id, total_references: item.total_references ?? null, per_type: item.per_type ?? [], portal_url: item.portal_url ?? null };
  } catch (e) {
    return { id, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

function buildResult(x: {
  args: EuTekstArgs;
  query: Record<string, string>;
  res: Awaited<ReturnType<EuTekstSource["resolve"]>>;
  meta: EuMetadata | null;
  tekst: EuTekst | { pogingen: EuTekst["pogingen"] };
  lidoOut?: Record<string, unknown>;
  celex: string;
  sectie: ReturnType<typeof parseEuSectie>;
}): ToolResult {
  const { args, res, meta, celex, sectie } = x;
  const notes: string[] = [ACCESS_NOTE_BASE];
  const isWet = celex.startsWith("3");
  const ecliFromRes = res.identificaties.find((i) => i.soort === "ecli" && i.celex.includes(celex))?.invoer;
  const data: Record<string, unknown> = {
    bestaat: true,
    soort: meta?.soort,
    ...(meta?.instantie ? { instantie: meta.instantie } : {}),
    ecli: meta?.ecli ?? ecliFromRes ?? null,
    celex,
    zaaknummer: meta?.zaaknummer ?? null,
    datum: meta?.datum ?? null,
    ...(isWet ? {} : { partijen: meta?.partijen ?? null }),
    titel: meta?.titel ?? null,
    ...(meta?.aanduiding ? { aanduiding: meta.aanduiding } : {}),
    ...(meta?.onderwerp ? { onderwerp: meta.onderwerp } : {}),
    ...(isWet ? { in_force: meta?.in_force ?? null, eli: meta?.eli ?? null } : {}),
    identificaties: res.identificaties,
    ...(res.inconsistent ? { inconsistentie: res.inconsistent } : {}),
    eurlex_url: EURLEX_NL + celex,
    cellar_url: CELLAR_CELEX + celex,
  };
  if (res.inconsistent) notes.push(`LET OP: ${res.inconsistent}`);
  const writtenEcli = res.identificaties.find((i) => i.soort === "ecli");
  if (writtenEcli && meta?.ecli && writtenEcli.invoer !== meta.ecli) notes.push(`De opgegeven ECLI ${writtenEcli.invoer} hoort volgens CELLAR bij een ander document; ${celex} heeft ECLI ${meta.ecli}.`);

  let summary = `${meta?.ecli ?? celex}${meta?.partijen ? ` (${meta.partijen})` : meta?.titel ? ` — ${meta.titel.slice(0, 120)}` : ""}`;
  if (!("lines" in x.tekst)) {
    data.tekst_beschikbaar = false;
    data.tekst_pogingen = x.tekst.pogingen;
    notes.push(`De tekst kon niet worden opgehaald (${x.tekst.pogingen.map((p) => `${p.bron}: ${p.reden ?? "?"}`).join("; ")}); metadata hierboven komt uit CELLAR. Bekijk ${EURLEX_NL + celex}.`);
    if (x.lidoOut) data.lido = x.lidoOut;
    return successResponse({ summary: `${summary}: bestaat, tekst niet beschikbaar`, records: [rec(data, meta, celex)], provenance: prov(CELLAR_SPARQL, x.query, 1), access_note: notes.join(" ") });
  }

  const t = x.tekst;
  data.tekst_bron = { url: t.url, formaat: t.formaat, taal: t.taal, pogingen: t.pogingen };
  if (t.taal !== "nl") {
    data.taal_melding = `De opgehaalde tekst is niet Nederlands maar ${TAAL_NAAM[t.taal] ?? t.taal}: er is geen Nederlandse tekst beschikbaar via CELLAR of EUR-Lex.`;
    notes.push(String(data.taal_melding));
  }
  if (t.formaat === "pdf") notes.push("Er is geen Nederlandse HTML; de tekst komt uit de pdf (opmaak en nummering kunnen afwijken).");

  let units: EuEenheid[];
  let dictum: string | undefined;
  if (isWet) {
    const w = analyseWetgeving(t.lines);
    units = [...w.overwegingen, ...w.artikelen];
    data.artikelen_aantal = w.artikelen.length;
    data.overwegingen_aantal = w.overwegingen.length;
    data.artikelen = w.artikelen.slice(0, ARTIKEL_LIST_MAX).map((a) => ({ artikel: a.id.replace(/^artikel /, ""), ...(a.titel ? { titel: a.titel } : {}) }));
    if (w.artikelen.length > ARTIKEL_LIST_MAX) notes.push(`Artikellijst ingekort tot ${ARTIKEL_LIST_MAX} van ${w.artikelen.length}.`);
    if (!w.artikelen.length) notes.push("Geen artikelen herkend in de tekst; gebruik zoekterm of citaat.");
  } else {
    const u = analyseUitspraak(t.lines, meta?.soort ?? "arrest");
    units = u.randnummers;
    dictum = u.dictum;
    data.randnummers_aantal = u.randnummers.length;
    data.randnummers = randnummerBereik(u.randnummers) ?? null;
    if (u.koppen.length) data.inhoudsopgave = u.koppen.slice(0, TOC_MAX);
    data.dictum = dictum ? cut(dictum, Math.min(args.max_chars, 8_000)).tekst : null;
    if (u.dictum_kop) data.dictum_kop = u.dictum_kop;
    if (!u.randnummers.length) notes.push("Geen randnummers herkend; zoek met zoekterm of citaat.");
    if (!dictum) notes.push(meta?.soort === "conclusie" ? "Geen kop 'Conclusie' gevonden voor het voorstel van de advocaat-generaal." : "Geen dictum herkend (geen kop 'verklaart voor recht:' of 'beslist:').");
    if (meta?.soort === "conclusie") notes.push("Dit is een conclusie van de advocaat-generaal: een advies aan het Hof, geen uitspraak; 'dictum' bevat het voorgestelde antwoord.");
  }
  const allUnits = dictum ? [...units, { id: "dictum", tekst: dictum }] : units;

  if (sectie) {
    let picked: EuEenheid[] = [];
    let label = args.sectie ?? "";
    if (sectie.soort === "dictum") picked = dictum ? [{ id: "dictum", tekst: dictum }] : [];
    else if (sectie.soort === "randnummers") picked = units.filter((u) => /^\d+$/.test(u.id) && Number(u.id) >= sectie.van && Number(u.id) <= sectie.tot), label = sectie.van === sectie.tot ? `randnummer ${sectie.van}` : `randnummers ${sectie.van}–${sectie.tot}`;
    else if (sectie.soort === "artikel") picked = units.filter((u) => u.id === `artikel ${sectie.nr}`), label = `artikel ${sectie.nr}`;
    else picked = units.filter((u) => u.id === `overweging ${sectie.nr}`), label = `overweging ${sectie.nr}`;
    const joined = picked.map((u) => `[${u.id}]${u.titel ? ` ${u.titel}` : ""}\n${u.tekst}`).join("\n\n");
    const c = cut(joined, args.max_chars);
    data.sectie = { gevraagd: args.sectie, label, bestaat: picked.length > 0, ...(sectie.soort === "randnummers" ? { gevonden: picked.map((p) => p.id) } : {}), tekst: c.tekst, ingekort: c.ingekort };
    if (!picked.length) notes.push(isWet ? `${label} komt niet voor in de tekst (${data.artikelen_aantal} artikelen, ${data.overwegingen_aantal} overwegingen).` : `${label} komt niet voor in de tekst (randnummers ${data.randnummers ?? "geen"}).`);
    summary += picked.length ? `: ${label}` : `: ${label} niet gevonden`;
  }
  if (args.zoekterm?.trim()) {
    const s = searchUnits(allUnits, args.zoekterm, args.max_chars);
    data.treffers = s.treffers;
    data.treffers_totaal = s.totaal;
    notes.push(s.totaal ? `${s.totaal} ${isWet ? "onderdelen bevatten" : "randnummers bevatten"} alle woorden van '${args.zoekterm}'${s.treffers.length < s.totaal ? `; ${s.treffers.length} getoond binnen max_chars` : ""}.` : `Geen ${isWet ? "artikel of overweging" : "randnummer"} bevat alle woorden van '${args.zoekterm}'.`);
    if (!sectie) summary += `: ${s.totaal} treffer(s) voor '${args.zoekterm}'`;
  }
  if (args.citaat?.trim()) {
    const c = checkCitaat(allUnits, args.citaat);
    data.citaat_controle = c;
    notes.push(c.gevonden ? `Het citaat komt letterlijk voor${c.vindplaats ? ` (${/^\d+$/.test(c.vindplaats) ? `randnummer ${c.vindplaats}` : c.vindplaats})` : ""} (hoofdletters, accenten en leestekens genegeerd).` : `Het citaat komt NIET letterlijk voor${c.dichtstbij ? `; het meest gelijkende onderdeel is ${c.dichtstbij.id} (${Math.round(c.dichtstbij.dekking * 100)}% van de woorden)` : ""}.`);
    summary += c.gevonden ? "; citaat gevonden" : "; citaat niet gevonden";
  }
  if (x.lidoOut) data.lido = x.lidoOut;
  return successResponse({ summary, records: [rec(data, meta, celex)], provenance: prov(CELLAR_CELEX + celex, x.query, 1), access_note: notes.join(" ") });
}

function rec(data: Record<string, unknown>, meta: EuMetadata | null, celex: string): MCPRecord {
  const title = [meta?.aanduiding ?? meta?.titel ?? celex, meta?.partijen].filter(Boolean).join(" ").slice(0, 300);
  const snippet = String(data.dictum ?? meta?.onderwerp ?? meta?.titel ?? "").slice(0, 300);
  return { source_name: "eu-cellar", title, canonical_url: EURLEX_NL + celex, data, snippet, date: meta?.datum };
}

export interface EuForkDeps {
  config: AppConfig;
  TOOL_ANNOTATIONS: Record<string, unknown>;
  lido?: Pick<LidoSource, "references">;
}

/** Registers the fork's EU tools; returns the result function for nl_gov_ask. */
export function registerEuForkTools(server: McpServer, deps: EuForkDeps): (args: EuTekstArgs) => Promise<ToolResult> {
  // Also the fork's LiDO article fallback (src/fork/lido-artikel.ts): one hook in tools.ts for both.
  installLidoArtikelFallback(deps.config);
  // And the Woo tools (src/fork/woo.ts, woo-index.ts): woo_zoeken, woo_document_get, woo_index.
  registerWooTools(server, deps);
  // And PUC, the ACOI Woo-jurisprudentie and the ANBI register (src/fork/juridische-bronnen.ts).
  registerJuridischeBronnen(server, deps);
  // And rulings outside rechtspraak.nl (src/fork/geschilbeslechting.ts): RvS-zoeken, CRM, Onderwijsgeschillen, Geschillencommissie, RvA, MfN.
  registerGeschilbeslechting(server, deps);
  registerVerdragen(server, deps);
  registerEhrm(server, deps);
  registerLiteratuur(server, deps);
  registerToezicht(server, deps);
  registerWetsgeschiedenis(server, deps);
  registerRichtlijnen(server, deps);
  // And searching rulings through Open Data van de Rechtspraak (src/fork/rechtspraak-open-data.ts), also as fallback of rechtspraak_search_ecli.
  registerRechtspraakOpenData(server, deps);
  // And robust LiDO and rechtspraak_get_by_ecli plus the health check bronnen_status (src/fork/lido-robuust.ts, src/fork/bron-gezondheid.ts).
  installLidoNetwerk();
  registerBronGezondheid(server, deps.TOOL_ANNOTATIONS);
  const source = new EuTekstSource(deps.config);
  const result = (args: EuTekstArgs) => euTekstResult(source, deps.lido, args);
  server.registerTool("eurlex_tekst_get", {
    description:
      "Check and read one EU document: a CJEU/General Court ruling, A-G opinion or order by ECLI (ECLI:EU:C:2005:321, ECLI:EU:T:…), CELEX (62003CJ0478, 61986CJ0287, 62003CC0478, 62019CO0123) or case number ('C-478/03', 'T-12/19', 'zaak 287/86'); " +
      "or EU legislation (directive, regulation, decision) by CELEX (32001L0023, 32016R0679) or citation ('Richtlijn 2001/23/EG', 'Verordening (EU) 2016/679', 'Verordening (EG) nr. 883/2004'). " +
      "Resolves through CELLAR (owl:sameAs ECLI/CELEX/case) and says whether the document exists, and whether a written ECLI belongs to the same document as the case number (inconsistentie). " +
      "Returns ECLI, CELEX, date, parties, case number, title, the dictum (operative part) and the range of randnummers; for legislation the list of articles. Text is the Dutch version (content negotiation, fallback EUR-Lex and the Dutch PDF); if no Dutch text exists the language is reported in taal_melding. " +
      "sectie returns randnummers ('39', '39-44'), 'dictum', 'artikel 3' or 'overweging 12'; zoekterm returns the paragraphs holding every word; citaat checks whether a quoted sentence occurs literally and where. Includes LiDO reference counts (lido).",
    inputSchema: {
      id: z.string().min(2).max(300).describe("ECLI, CELEX, case number or citation; several identifiers of the same document ('C-478/03, ECLI:EU:C:2005:321') are checked against each other."),
      sectie: z.string().max(100).optional().describe("'39', 'punt 39', '39-44', 'dictum', 'artikel 3', 'overweging 12'."),
      zoekterm: z.string().max(200).optional().describe("Words that must all occur in a randnummer/article (case and accents ignored)."),
      citaat: z.string().max(2000).optional().describe("A quoted sentence to check literally against the text."),
      max_chars: z.number().int().min(500).max(EU_TEKST_MAX_CHARS).default(EU_TEKST_DEFAULT_CHARS),
      lido: z.boolean().default(true).describe("Add LiDO reference counts (ECLI for rulings, CELEX for legislation)."),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (args) => toMcpToolPayload(await result(args)));
  registerLidoRelaties(server, deps);
  return result;
}

/**
 * lido_relaties: every relation LiDO holds for any kind of government document,
 * through LiDO's services (src/fork/lido-relaties.ts), grouped per document type
 * and filterable on type, issuing body and year.
 */
function registerLidoRelaties(server: McpServer, deps: EuForkDeps): void {
  const wettenBwb = new WettenBwbSource(deps.config);
  const bwbArtikel = new BwbArtikelSource(deps.config);

  /** An article's LiDO object from the BWB toestand (get-id does not know "6:162" BW or "3:4" Awb). */
  async function artikelObject(id: string | undefined, wet: string | undefined, artikel: string): Promise<{ object: string; regeling: string } | { error: string }> {
    let bwbId = id && /^BWBR\d{7}$/i.test(id.trim()) ? id.trim().toUpperCase() : undefined;
    let regeling = bwbId ?? "";
    if (!bwbId) {
      if (!wet) return { error: "Geef bij een artikel ook de wet (wet: 'BW', 'Awb', 'Wet op de ondernemingsraden') of het BWB-id (id: 'BWBR0005537')." };
      const bw = /^(?:bw|burgerlijk\s+wetboek)$/i.test(wet.trim()) ? artikel.match(/^(\d+[a-z]?):/i) : null;
      const r = await wettenBwb.tekst({ wet: bw ? `BW boek ${bw[1]}` : wet, artikel, max_chars: 500 });
      if (r.kind !== "tekst") return { error: `'${wet}' wijst niet eenduidig naar één regeling (${r.candidates.slice(0, 5).map((c) => `${c.title} [${c.identifier}]`).join("; ")}); geef het BWB-id.` };
      bwbId = r.regeling.identifier;
      regeling = r.doc.citeertitel ?? r.regeling.title ?? bwbId;
    }
    const a = await bwbArtikel.getArtikel({ bwbId, artikel });
    if (a.items.length !== 1) return { error: a.items.length ? `Artikel ${artikel} komt meer dan eens voor in ${bwbId}; geef het BWB-id van het juiste boek of deel.` : `Artikel ${artikel} niet gevonden in ${regeling} (${bwbId}).` };
    const object = lidoObjectFromArtikel(a.items[0]);
    return object ? { object, regeling: `${a.items[0].titel_regeling ?? regeling}, artikel ${a.items[0].artikel}` } : { error: `Geen LiDO-kenmerk (label-id) voor artikel ${artikel} in ${bwbId}.` };
  }

  server.registerTool("lido_relaties", {
    description:
      "Every relation LiDO (Linked Data Overheid) holds for one government document, of any kind: a ruling (ECLI:NL or ECLI:EU), a law or regulation (BWBR: wet, AMvB, ministeriële regeling, beleidsregel, verdrag), one article (id or wet plus artikel: wet 'BW' artikel '6:162', wet 'Awb' artikel '3:4'), a local regulation (CVDR), EU legislation (CELEX) or a Staatsblad/Staatscourant publication (stb-2018-401). " +
      "Use it to find the rulings and regulations that cite a provision or ruling (direction 'inkomend') and what it cites itself ('uitgaand'). Returns counts per document type, a breakdown per issuing body and year, and the documents grouped per type, newest first. " +
      "Filters: type ('Jurisprudentie', 'Wet', 'Amvb', 'Ministeriële-regeling', 'BWB Beleidsregel', 'Verdrag', ...), instantie (an issuing body as listed in per_instantie, e.g. 'Hoge Raad') and jaar ('2024'). For the leading case law on an article: type 'Jurisprudentie' with instantie the highest court of the field.",
    inputSchema: {
      id: z.string().max(300).optional().describe("ECLI, BWBR, CVDR, CELEX, stb-/stcrt-publication, LiDO URI or Juriconnect reference ('jci1.3:c:BWBR0005537&artikel=3:4'). With artikel: the BWBR of the law."),
      wet: z.string().max(200).optional().describe("Law name or abbreviation for an article ('BW', 'Awb', 'Sr', 'Wet op de ondernemingsraden'), instead of id."),
      artikel: z.string().max(60).optional().describe("Article number: '6:162' (BW, with book), '3:4' (Awb), '7:658', '350'."),
      type: z.string().max(80).optional(),
      instantie: z.string().max(120).optional(),
      jaar: z.string().regex(/^\d{4}$/).optional(),
      max: z.number().int().min(1).max(500).default(100).describe("Max documents listed (counts always cover everything)."),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async ({ id: idIn, wet, artikel: artikelIn, type, instantie, jaar, max }) => {
    // Juriconnect (jci) references name a regulation and, often, an article.
    const jci = idIn ? parseJci(idIn) : null;
    const id = jci ? jci.bwb : idIn;
    const artikel = artikelIn ?? jci?.artikel;
    const label = [id, wet, artikel ? `artikel ${artikel}` : undefined].filter(Boolean).join(" ") || "(leeg)";
    const params: Record<string, string> = Object.fromEntries(Object.entries({ id, wet, artikel, type, instantie, jaar, max: String(max) }).filter(([, v]) => v)) as Record<string, string>;
    try {
      let lidoObject: string | null = null;
      let naam: string | undefined;
      if (artikel) {
        const a = await artikelObject(id, wet, artikel);
        if ("error" in a) return toMcpToolPayload(errorResponse({ error: "unexpected", message: a.error, suggestion: "Zoek het BWB-id met wetten_bwb_search." }));
        lidoObject = a.object;
        naam = a.regeling;
      } else if (!id || !lidoLookups(id).length) {
        return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Geen LiDO-identificatie in '${label.slice(0, 100)}'.`, suggestion: "Geef id (ECLI, BWBR, CVDR, CELEX of stb-2018-401), of wet plus artikel." }));
      }
      const r = await lidoRelaties(id ?? "", { type, instantie, jaar, max, lidoObject });
      const prov = { tool: "lido_relaties", endpoint: r.endpoint, query_params: params, timestamp: nowIso(), returned_results: r.items.length, total_results: r.totaalMetFilter ?? r.totaal ?? 0 };
      if (!r.bekend) return toMcpToolPayload(successResponse({ summary: `${label}: niet bekend in LiDO`, records: [], provenance: prov, access_note: `${r.opmerking ?? ""}${r.geprobeerd ? ` Geprobeerd: ${r.geprobeerd.join(", ")}.` : ""}` }));
      const shown = r.filter ? r.totaalMetFilter : r.totaal;
      const data = {
        identifier: label,
        ...(naam ? { regeling: naam } : {}),
        bron: r.bron,
        lido_id: r.lidoId,
        titel: r.titel,
        portal_url: r.portalUrl,
        totaal: r.totaal,
        per_type: r.perType,
        ...(r.tellingen === "niet beschikbaar" ? { tellingen: r.tellingen } : {}), // FORK: totals from the get-links facets
        ...(r.filter ? { filter: r.filter, totaal_met_filter: r.totaalMetFilter } : {}),
        per_instantie: r.perInstantie?.slice(0, 20),
        per_jaar: r.perJaar?.slice(0, 15),
        getoond: r.items.length,
        volledig: r.volledig,
        documenten: groepeerPerType(r.items, r.rechtspraak),
      };
      return toMcpToolPayload(successResponse({
        summary: `${naam ?? label}: ${r.totaal} LiDO-relaties${r.filter ? `, ${shown ?? "?"} met filter ${Object.values(r.filter).join(", ")}` : ""}; ${r.items.length} getoond`,
        records: [{ source_name: "lido", title: `LiDO-relaties: ${naam ?? r.titel ?? label}`, canonical_url: r.portalUrl ?? "https://linkeddata.overheid.nl", data, snippet: r.perType?.slice(0, 5).map((t) => `${t.type}: ${t.aantal}`).join(", ") }],
        provenance: prov,
        access_note:
          (r.bron === "lido-portaal" || r.tellingen === "niet beschikbaar" ? `${r.opmerking} ` : "") +
          "Bron: LiDO-services (get-aantal-per-informatietype, get-links) van KOOP, CC0. richting: 'inkomend' = dat document verwijst naar het opgevraagde, 'uitgaand' = het opgevraagde verwijst ernaar. " +
          "Verwijzingen zijn grotendeels door de computer herkend ('Door computer herkende referentie'): een relatie zegt dát een document het noemt, niet hoe; open het document voor de inhoud. " +
          (r.volledig === false ? `Niet alles getoond: verhoog max (tot 500) of filter op type, instantie of jaar. ` : "") +
          "per_instantie en per_jaar tellen zonder hun eigen filter maar met de andere filters; de Hoge Raad heet daar 'Hoge Raad der Nederlanden', A-G-conclusies 'Parket bij de Hoge Raad'. " +
          (r.rechtspraak ? "documenten.Jurisprudentie begint met de nieuwste uitspraken, apart opgehaald omdat de gemengde lijst met wetten en regelingen kan beginnen. " : "") +
          (/^BWB[RV]\d{7}$/i.test(id ?? "") && !artikel ? "Bij een hele wet koppelt LiDO weinig: de relaties hangen aan de artikelen; vraag een artikel op (wet + artikel). " : ""),
      }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "LiDO", "https://linkeddata.overheid.nl"));
    }
  });
}
