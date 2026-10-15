/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. European Court of Human Rights (HUDOC):
 * - ehrm_zoeken: the HUDOC search service (query/results) with filters for respondent state, article,
 *   document type, Grand Chamber, importance, date and language.
 * - ehrm_uitspraak_get: one judgment, decision or advisory opinion by ECLI, HUDOC link/itemid or
 *   application number; the text (docx → html conversion) divided the way the Court writes: procedure,
 *   facts, legal framework, per complaint the parties' submissions (applicant, Government, third
 *   parties) and the Court's assessment (general principles, application), the operative part and the
 *   separate opinions. With what the judgment means for the Netherlands (res judicata for the respondent
 *   State, res interpretata for all others; final or not) and, through LiDO, the Dutch rulings citing it.
 * Registered from registerEuForkTools.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MCPRecord } from "../types.js";
import { errorResponse, mapSourceError, nowIso, successResponse, toMcpToolPayload } from "../utils/response.js";
import { decodeEntities, htmlNaarTekst } from "./juridische-bronnen.js";
import { httpFetch } from "./geschilbeslechting.js";
import { lidoRelaties, type LidoRelatiesResult } from "./lido-relaties.js";

type Fetcher = typeof httpFetch;
type Lido = (ecli: string) => Promise<Pick<LidoRelatiesResult, "bekend" | "totaal" | "perInstantie" | "rechtspraak" | "items" | "portalUrl">>;

export const HUDOC_BASE = "https://hudoc.echr.coe.int";
const HUDOC_QUERY = `${HUDOC_BASE}/app/query/results`;
export const HUDOC_BODY = (id: string) => `${HUDOC_BASE}/app/conversion/docx/html/body?library=ECHR&id=${id}`;
export const HUDOC_URL = (id: string) => `${HUDOC_BASE}/eng?i=${id}`;
/** HUDOC's firewall refuses a full browser user agent (and custom ones) but accepts this one. */
export const HUDOC_HEADERS = { "User-Agent": "Mozilla/5.0" };
const VELDEN = "itemid,docname,appno,ecli,respondent,kpdate,judgementdate,doctype,doctypebranch,documentcollectionid2,languageisocode,importance,article,conclusion,violation,nonviolation,separateopinion,scl";

export type HudocDoc = Record<string, string | null | undefined>;

/** HUDOC query; HUDOC wants sort and start, and free-text queries also hit press releases (doctype PR). */
export function hudocQueryUrl(query: string, o: { select?: string; start?: number; length?: number; sort?: string } = {}): string {
  const u = new URL(HUDOC_QUERY);
  u.searchParams.set("query", `contentsitename:ECHR AND ${query} AND NOT (doctype:"PR")`);
  u.searchParams.set("select", o.select ?? VELDEN);
  u.searchParams.set("sort", o.sort ?? "kpdate Descending");
  u.searchParams.set("start", String(o.start ?? 0));
  u.searchParams.set("length", String(o.length ?? 20));
  return u.toString();
}

/** ECLI, HUDOC link/itemid or application number from a reference. */
export function hudocRef(input: string): { ecli?: string; itemid?: string; appno?: string } | null {
  const s = String(input ?? "").trim();
  let m: RegExpExecArray | null;
  if ((m = /ECLI:CE:ECHR:\d{4}:\d{4}[A-Z]{3}\d{9}/i.exec(s))) return { ecli: m[0].toUpperCase() };
  if ((m = /(?:[?&]i=|itemid(?:%22|")\s*(?::|%3A)\s*(?:\[|%5B)\s*(?:%22|"))(\d{3}-\d{3,7}(?:-\d+)?)/i.exec(s)) || (m = /^\s*(00[1-3]-\d{3,7}(?:-\d+)?)\s*$/.exec(s))) return { itemid: m[1] };
  if ((m = /\b(\d{1,6}\/\d{2})\b/.exec(s))) return { appno: m[1] };
  return null;
}

export function hudocIdQuery(ref: { ecli?: string; itemid?: string; appno?: string }): string {
  if (ref.itemid) return `(itemid:"${ref.itemid}")`;
  if (ref.ecli) return `(ecli:"${ref.ecli}")`;
  return `(appno:"${ref.appno}")`;
}

export const hudocSoort = (d: HudocDoc): string => {
  const c = String(d.documentcollectionid2 ?? "");
  return /ADVISORYOPINIONS/.test(c) ? "advies" : /JUDGMENTS/.test(c) ? "arrest" : /DECISIONS/.test(c) ? "beslissing" : /CLIN/.test(c) ? "samenvatting (Legal Summary)" : /COMMUNICATEDCASES/.test(c) ? "gecommuniceerde zaak" : /RESOLUTIONS|EXECUTION/.test(c) ? "uitvoering" : "overig";
};
const TAAL: Record<string, number> = { ENG: 0, FRE: 1 };

/** Judgment or opinion before decision, English before French before translations, Grand Chamber first, then newest. */
export function kiesHudocDocument(docs: HudocDoc[]): { gekozen: HudocDoc | null; andere: Array<Record<string, unknown>> } {
  const rang = (d: HudocDoc) => { const s = hudocSoort(d); return (s === "arrest" || s === "advies" ? 0 : s === "beslissing" ? 10 : 50) + (TAAL[d.languageisocode ?? ""] ?? 3) + (d.doctypebranch === "GRANDCHAMBER" ? 0 : 0.5); };
  const kand = docs.filter((d) => /^00[13]-/.test(d.itemid ?? ""));
  const gekozen = [...kand].sort((a, b) => rang(a) - rang(b) || String(b.kpdate).localeCompare(String(a.kpdate)))[0] ?? null;
  const andere = docs.filter((d) => d !== gekozen).map((d) => ({ itemid: d.itemid, titel: d.docname, soort: hudocSoort(d), taal: d.languageisocode, datum: String(d.kpdate ?? "").slice(0, 10), kamer: d.doctypebranch, url: HUDOC_URL(String(d.itemid)) }));
  return { gekozen, andere };
}

const STAAT: Record<string, string> = { NLD: "Nederland", BEL: "België", DEU: "Duitsland", FRA: "Frankrijk", GBR: "Verenigd Koninkrijk", TUR: "Turkije", RUS: "Rusland", ITA: "Italië", ESP: "Spanje", POL: "Polen", UKR: "Oekraïne", PRT: "Portugal", AUT: "Oostenrijk", CHE: "Zwitserland", GRC: "Griekenland", ROU: "Roemenië", HUN: "Hongarije", SWE: "Zweden", NOR: "Noorwegen", DNK: "Denemarken", FIN: "Finland", IRL: "Ierland", LUX: "Luxemburg", CZE: "Tsjechië", SVK: "Slowakije", SVN: "Slovenië", HRV: "Kroatië", BGR: "Bulgarije", LTU: "Litouwen", LVA: "Letland", EST: "Estland", MLT: "Malta", CYP: "Cyprus", ISL: "IJsland", LIE: "Liechtenstein", MCO: "Monaco", SMR: "San Marino", AND: "Andorra", ALB: "Albanië", ARM: "Armenië", AZE: "Azerbeidzjan", GEO: "Georgië", MDA: "Moldavië", MNE: "Montenegro", MKD: "Noord-Macedonië", SRB: "Servië", BIH: "Bosnië en Herzegovina" };
const STAAT_EN: Record<string, string> = { NETHERLANDS: "NLD", BELGIUM: "BEL", GERMANY: "DEU", FRANCE: "FRA", "UNITED KINGDOM": "GBR", TURKEY: "TUR", "TÜRKIYE": "TUR", TURKIYE: "TUR", RUSSIA: "RUS", ITALY: "ITA", SPAIN: "ESP", POLAND: "POL", UKRAINE: "UKR", SWITZERLAND: "CHE", GREECE: "GRC", ROMANIA: "ROU", HUNGARY: "HUN", SWEDEN: "SWE", NORWAY: "NOR", DENMARK: "DNK", AUSTRIA: "AUT", IRELAND: "IRL", "CZECH REPUBLIC": "CZE", CZECHIA: "CZE", CROATIA: "HRV", BULGARIA: "BGR" };
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().trim();
/** 'Nederland', 'Netherlands', 'NLD' → 'NLD'. */
export function staatCode(input: string): string | null {
  const f = fold(input);
  if (/^[A-Z]{3}$/.test(f) && STAAT[f]) return f;
  const nl = Object.entries(STAAT).find(([, n]) => fold(n) === f);
  if (nl) return nl[0];
  return STAAT_EN[f.replace(/^THE /, "")] ?? null;
}

/**
 * What the ruling means for the Netherlands. A final judgment binds the respondent State (art. 46 ECHR);
 * the Court's interpretation of the Convention applies to all States parties (res interpretata), and Dutch
 * courts follow it (art. 93 and 94 Constitution). The real question is its relevance for Dutch practice.
 */
export function betekenisVoorNederland(meta: HudocDoc, tekst = "", o: { vandaag?: Date; grandeKamerArrest?: { datum: string; url: string } | null } = {}) {
  const verweerders = String(meta.respondent ?? "").split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  const nl = verweerders.includes("NLD");
  const soort = hudocSoort(meta);
  const kamer = meta.doctypebranch === "GRANDCHAMBER" ? "Grote Kamer" : meta.doctypebranch === "CHAMBER" ? "Kamer" : meta.doctypebranch === "COMMITTEE" ? "Comité" : meta.doctypebranch ?? undefined;
  const definitief = /judgment is final|arrêt est définitif/i.test(tekst) ? true : /will become final|deviendra définitif/i.test(tekst) ? false : meta.doctypebranch === "GRANDCHAMBER" || meta.doctypebranch === "COMMITTEE" ? true : undefined;
  const r: string[] = [];
  if (soort === "advies") r.push("Advies op grond van Protocol 16: niet bindend (art. 5 Protocol 16), wel gezaghebbende uitleg.");
  else if (nl) r.push("Nederland is verwerende staat: een definitief arrest bindt Nederland (art. 46 lid 1 EVRM, res judicata); de uitvoering staat onder toezicht van het Comité van Ministers.");
  else r.push(`Nederland is geen partij (verwerende staat: ${verweerders.map((v) => STAAT[v] ?? v).join(", ") || "onbekend"}). Het arrest bindt Nederland niet als zodanig, maar de uitleg van het EVRM die het Hof geeft geldt voor alle verdragsstaten (res interpretata); Nederlandse rechters volgen die uitleg (art. 93 en 94 Grondwet). Beoordeel de relevantie voor de Nederlandse praktijk: de algemene beginselen zijn doorgaans direct bruikbaar, de toepassing hangt af van het recht en de feiten van de verwerende staat.`);
  if (soort === "beslissing") r.push("Dit is een beslissing (meestal over de ontvankelijkheid), geen arrest over de zaak zelf: minder gezag dan een arrest.");
  const dagen = meta.kpdate ? ((o.vandaag ?? new Date()).getTime() - new Date(String(meta.kpdate)).getTime()) / 864e5 : null;
  if (soort === "arrest" && definitief === false && o.grandeKamerArrest) r.push(`Na dit Kamerarrest heeft de Grote Kamer geoordeeld (${o.grandeKamerArrest.datum}, ${o.grandeKamerArrest.url}): dat arrest is bepalend.`);
  else if (soort === "arrest" && definitief === false && dagen !== null && dagen > 100) r.push("Kamerarrest van meer dan drie maanden oud zonder Grote-Kamerarrest in HUDOC: vrijwel zeker definitief (art. 44 lid 2 EVRM); een eventuele afwijzing van het verwijzingsverzoek staat niet altijd in HUDOC.");
  else if (soort === "arrest" && definitief === false) r.push("Kamerarrest dat nog niet definitief is: het wordt definitief na drie maanden, tenzij verwijzing naar de Grote Kamer wordt gevraagd en toegestaan (art. 43 en 44 EVRM). Controleer of er een verwijzingsverzoek loopt.");
  if (kamer === "Grote Kamer") r.push("Grote Kamer: het meeste gezag.");
  if (String(meta.importance) === "1") r.push("Door het Hof aangemerkt als belangrijke uitspraak (importance 1 / key case).");
  return { verwerende_staat: verweerders, nederland_partij: nl, soort, kamer, definitief, toelichting: r.join(" ") };
}

// ---------- dividing the text ----------

type Kop = { soort: string; partij?: string; deel?: string };
const KOP_REGELS: Array<[RegExp, string, string?, string?]> = [
  [/separate opinion|dissenting opinion|concurring opinion|partly dissenting|partly concurring|joint opinion|declaration of judge|opinion (?:dissidente|concordante|séparée)/i, "afwijkende mening"],
  [/^for these reasons|^par ces motifs|operative provisions/i, "beslissing"],
  [/third[- ]part(?:y|ies)|intervening|intervener|commissioner for human rights|tiers intervenant/i, "standpunten", "derde-belanghebbende"],
  [/(?:the )?government(?:'|’)?s? (?:submissions|observations|arguments)?$|^\(?[a-z]\)?\s*the government$|^the government$|le gouvernement/i, "standpunten", "regering"],
  [/(?:the )?applicant(?:s)?(?:'|’)?s? (?:submissions|observations|arguments)?$|^\(?[a-z]\)?\s*the applicants?$|^the applicants?$|le requérant|la requérante|les requérants/i, "standpunten", "verzoeker"],
  [/parties(?:'|’)? (?:submissions|observations|arguments)|thèses des parties|arguments des parties/i, "standpunten"],
  [/court(?:'|’)?s assessment|appréciation de la cour/i, "beoordeling"],
  [/general principles|principes généraux/i, "beoordeling", undefined, "algemene beginselen"],
  [/application (?:of|to) (?:the|these|those)|application (?:de ces|des) principes|^application\b/i, "beoordeling", undefined, "toepassing"],
  [/^(?:[a-z]\.\s*|\([a-z]\)\s*)?(?:admissibility|merits|recevabilité|fond)$/i, "beoordeling"],
  [/article 41|just satisfaction|^damage|costs and expenses|default interest|satisfaction équitable/i, "beoordeling", undefined, "billijke genoegdoening (art. 41)"],
  [/article 46|execution of the judgment|exécution de l.arrêt/i, "beoordeling", undefined, "uitvoering (art. 46)"],
  [/relevant (?:domestic |legal |international |european )?(?:law|framework|legal framework|practice|material)|international law|legal framework|cadre juridique|droit (?:et pratique )?interne/i, "rechtskader"],
  [/the facts|circumstances of the case|en fait|les circonstances/i, "feiten"],
  [/^procedure$|^procédure$/i, "procedure"],
  [/^introduction$/i, "inleiding"],
  [/alleged violation|other alleged|sur la violation alléguée|autres violations/i, "klacht"],
  [/^the law$|^en droit$/i, "klacht"],
];

function kopNaarSoort(kop: string): Kop | null {
  const delen = kop.split(/\s{2,}|(?<=[a-z’'])\s+(?=(?:The|A\.|B\.|C\.|[IVX]+\.|\([a-z]\)|Admissibility|Merits)\b)/);
  // A merged heading ("Merits The parties’ submissions The Government"): the most specific term counts, so from the end.
  for (const deel of [...delen].reverse().concat(kop)) {
    const d = deel.replace(/^(?:[IVX]+\.|[A-H]\.|\d+\.|\([a-z]\))\s*/i, "").trim();
    for (const [re, soort, partij, deel2] of KOP_REGELS) if (re.test(d)) return { soort, ...(partij ? { partij } : {}), ...(deel2 ? { deel: deel2 } : {}) };
  }
  return null;
}

const OPINIE_KOP = /^(?:(?:JOINT|PARTLY|PARTIALLY|SEPARATE)\s+)*(?:(?:DISSENTING|CONCURRING|SEPARATE)\s+)+OPINION\b|^DECLARATION OF JUDGE|^OPINION (?:DISSIDENTE|CONCORDANTE|SÉPARÉE|EN PARTIE)|^(?:OPINION|DÉCLARATION) (?:COMMUNE )?D[EU]/;
const WEERGAVE_EN = /^(?:the (?:government|applicants?|respondent state|domestic courts?|court of appeal|supreme court|constitutional court|district court|regional court)|in (?:their|his|her) (?:observations|submissions))\b[^.]{0,80}\b(?:argued|submitted|contended|maintained|claimed|asserted|complained|considered|stated|noted that|held|found|ruled|concluded)\b/i;

export interface HudocEenheid { id: string; tekst: string; soort: string; partij?: string; deel?: string; klacht?: string; weergave?: string }

/**
 * Lines of a HUDOC document to units. Paragraphs are numbered throughout ("194. …", sometimes "6 . …");
 * a numbered line that does not follow on and is short is a heading ("1. The parties’ submissions").
 * The operative part is one unit; separate opinions number again from 1 and get their own prefix.
 */
export function hudocEenheden(regels: string[]): HudocEenheid[] {
  // The table of contents comes first; the judgment starts with the composition of the Court.
  let begin = regels.findIndex((l) => /sitting as (?:a )?(?:Grand )?Chamber|siégeant en (?:une )?(?:Grande )?Chambre|sitting as a Committee/i.test(l));
  if (begin < 0) begin = Math.max(0, regels.findIndex((l) => /^1\.\s+\S/.test(l)) - 1);
  const out: HudocEenheid[] = [];
  let soort = "procedure", partij: string | null = null, deel: string | null = null, klacht: string | null = null, last = 0, mening = 0;
  let cur: HudocEenheid | null = null, naBeslissing = false, klaar = false;
  for (const raw of regels.slice(begin)) {
    const l = raw.trim();
    if (!l) continue;
    if (klaar && !OPINIE_KOP.test(l)) continue; // signatures and the announcement of the opinions
    const m = /^(\d{1,4}) ?\.\s+(\S.*)$/.exec(l);
    const n = m ? Number(m[1]) : null;
    if (m && n === last + 1 && !(l.length <= 80 && !/[.;:”"]$/.test(l) && kopNaarSoort(m[2]))) {
      last = n;
      const id = mening ? `mening ${mening} §${n}` : String(n);
      const w = (soort === "beoordeling" || soort === "klacht") && WEERGAVE_EN.test(m[2]) ? (/court/i.test(m[2].slice(0, 40)) && !/^the government|^the applicant/i.test(m[2]) ? "oordeel nationale rechter" : "standpunt partij") : null;
      cur = { id, tekst: m[2], soort, ...(partij ? { partij } : {}), ...(deel ? { deel } : {}), ...(klacht ? { klacht } : {}), ...(w ? { weergave: w } : {}) };
      out.push(cur);
      continue;
    }
    if (naBeslissing && OPINIE_KOP.test(l)) { klaar = false; mening++; last = 0; soort = "afwijkende mening"; partij = null; deel = l.slice(0, 120); klacht = null; cur = null; continue; }
    if (naBeslissing && !mening) {
      if (/^(?:done in|fait en)\b/i.test(l)) { klaar = true; continue; }
      if (cur) cur.tekst += cur.tekst ? `\n${l}` : l;
      continue;
    }
    if (!naBeslissing && /^(?:for these reasons|par ces motifs)/i.test(l)) { naBeslissing = true; cur = { id: "beslissing", tekst: "", soort: "beslissing" }; out.push(cur); continue; }
    const kort = l.length <= 160 && !/[.;,]$/.test(l);
    const k = kort ? kopNaarSoort(l) : null;
    if (k) {
      if (k.soort === "afwijkende mening") continue;
      if (k.soort === "klacht") { klacht = /article/i.test(l) ? l.replace(/^[IVX]+\.\s*/i, "").slice(0, 140) : klacht; soort = "klacht"; partij = null; deel = null; continue; }
      if (mening) continue; // headings inside an opinion change nothing
      soort = k.soort; partij = k.partij ?? (k.soort === "standpunten" ? partij : null); deel = k.deel ?? (k.soort === "beoordeling" && deel && !/admissib|merits|recevab|fond/i.test(l) ? deel : null);
      if (k.soort === "standpunten" && !k.partij && !/submissions|observations|arguments|thèses/i.test(l)) partij = null;
      continue;
    }
    if (cur) cur.tekst += `\n${l}`;
  }
  return out;
}

/** HUDOC html to lines (one per paragraph). */
export const hudocRegels = (html: string): string[] => decodeEntities(htmlNaarTekst(String(html))).split("\n").map((l) => l.replace(/[ \s]+/g, " ").trim()).filter(Boolean);

/** Overview of the structure: consecutive paragraphs with the same label as one range. */
export function hudocStructuur(units: HudocEenheid[]): Array<Record<string, string>> {
  const out: Array<Record<string, string> & { _van: string; _tot: string }> = [];
  for (const u of units) {
    const label = { onderdeel: u.soort, ...(u.partij ? { partij: u.partij } : {}), ...(u.deel ? { deel: u.deel } : {}), ...(u.klacht ? { klacht: u.klacht } : {}) };
    const prev = out[out.length - 1];
    const key = JSON.stringify(label);
    if (prev && JSON.stringify({ onderdeel: prev.onderdeel, ...(prev.partij ? { partij: prev.partij } : {}), ...(prev.deel ? { deel: prev.deel } : {}), ...(prev.klacht ? { klacht: prev.klacht } : {}) }) === key) prev._tot = u.id;
    else out.push({ ...label, _van: u.id, _tot: u.id });
  }
  return out.map(({ _van, _tot, ...l }) => ({ alineas: _van === _tot ? _van : `${_van}–${_tot.replace(/^mening \d+ /, "")}`, ...l }));
}

const lijst = (v: unknown) => String(v ?? "").split(";").map((s) => s.trim()).filter(Boolean);
const BELANG: Record<string, string> = { 1: "1 (key case / zeer belangrijk)", 2: "2 (belangrijk)", 3: "3 (overig, toepassing bestaande rechtspraak)", 4: "4 (weinig belang)" };

export function hudocMetadata(d: HudocDoc) {
  return {
    itemid: d.itemid, ...(d.ecli ? { ecli: d.ecli } : {}), verzoeknummer: lijst(d.appno), titel: String(d.docname ?? "").replace(/\s+/g, " ").trim(), soort: hudocSoort(d),
    datum: String(d.kpdate ?? "").slice(0, 10), kamer: d.doctypebranch, taal: d.languageisocode, verwerende_staat: lijst(d.respondent),
    artikelen: lijst(d.article), conclusie: lijst(d.conclusion), ...(d.importance ? { belang: BELANG[String(d.importance)] ?? d.importance } : {}),
    afzonderlijke_meningen: String(d.separateopinion).toUpperCase() === "TRUE",
    url: HUDOC_URL(String(d.itemid)),
  };
}

const ONDERDELEN = ["procedure", "inleiding", "feiten", "rechtskader", "klacht", "standpunten", "beoordeling", "algemene beginselen", "toepassing", "beslissing", "afwijkende mening"] as const;

/** Units selected by part, paragraph range or term. */
export function kiesEenheden(units: HudocEenheid[], o: { onderdeel?: string[]; alineas?: string; zoekterm?: string }): HudocEenheid[] {
  let sel = units;
  if (o.onderdeel?.length) sel = sel.filter((u) => o.onderdeel!.some((x) => x === u.soort || x === u.deel));
  if (o.alineas) {
    const m = /^\s*(\d{1,4})\s*(?:[-–]\s*(\d{1,4}))?\s*$/.exec(o.alineas.replace(/^§+\s*/, ""));
    if (m) { const van = Number(m[1]), tot = Number(m[2] ?? m[1]); sel = sel.filter((u) => /^\d+$/.test(u.id) && Number(u.id) >= van && Number(u.id) <= tot); }
  }
  if (o.zoekterm) { const t = o.zoekterm.toLowerCase(); sel = sel.filter((u) => u.tekst.toLowerCase().includes(t)); }
  return sel;
}

const label = (u: HudocEenheid) => [u.soort, u.partij, u.deel, u.weergave ? `weergave: ${u.weergave}` : undefined].filter(Boolean).join(" – ");
export const formatEenheid = (u: HudocEenheid) => `${/^\d/.test(u.id) ? `§ ${u.id}` : u.id} [${label(u)}]\n${u.tekst}`;

// ---------- tools ----------

const rec = (title: string, url: string, date: string | undefined, snippet: string | undefined, data: Record<string, unknown>): MCPRecord => ({ source_name: "hudoc.echr.coe.int", title, canonical_url: url, ...(date ? { date } : {}), ...(snippet ? { snippet: snippet.slice(0, 400) } : {}), data });
const NOTE = "Bron: HUDOC (Europees Hof voor de Rechten van de Mens). Authentiek zijn de Engelse en Franse tekst; Nederlandse versies in HUDOC zijn vertalingen of samenvattingen (meestal van het ministerie van Buitenlandse Zaken). Citeer als oordeel van het Hof alleen uit de beoordeling of de beslissing, niet uit de standpunten van partijen of een afzonderlijke mening. Laat elke verwijzing controleren met verify_legal_reference (verwijzingscontroleur).";

const defaultLido: Lido = async (ecli) => lidoRelaties(ecli, { max: 10 });

export function registerEhrm(server: McpServer, deps: { TOOL_ANNOTATIONS: Record<string, unknown> }, f: Fetcher = httpFetch, lido: Lido = defaultLido): void {
  const json = async (url: string) => {
    const r = await f(url, { headers: { ...HUDOC_HEADERS, Accept: "application/json" } });
    if (r.status !== 200) throw new Error(`HUDOC antwoordde met HTTP ${r.status}`);
    return JSON.parse(r.text) as { resultcount?: number; results?: Array<{ columns: HudocDoc }> };
  };
  const prov = (tool: string, endpoint: string, p: Record<string, unknown>, n: number, total: number) => ({ tool, endpoint, query_params: Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])), timestamp: nowIso(), returned_results: n, total_results: total });

  server.registerTool("ehrm_zoeken", {
    description: "Search the case law of the European Court of Human Rights (HUDOC). Free text (zoekterm, English or French; quotes for a phrase), respondent State (verweerder: 'Nederland', 'Netherlands' or 'NLD'), Convention article (artikel: '8', '6-1', 'P1-1'), document type (soort: arrest, beslissing, advies, samenvatting, alle), Grand Chamber only, importance (belang: '1' = key cases), date range and language (taal: ENG, FRE, or DUT for the Dutch translations/summaries). Not only cases against the Netherlands matter: the Court's interpretation applies to all States parties. Read a ruling with ehrm_uitspraak_get.",
    inputSchema: {
      zoekterm: z.string().max(300).optional(), verweerder: z.string().max(60).optional(), artikel: z.string().max(20).optional(),
      soort: z.enum(["arrest", "beslissing", "advies", "samenvatting", "alle"]).default("arrest"), grote_kamer: z.boolean().optional(),
      belang: z.array(z.enum(["1", "2", "3", "4"])).max(4).optional(),
      van: z.string().regex(/^\d{4}(-\d{2}-\d{2})?$/).optional(), tot: z.string().regex(/^\d{4}(-\d{2}-\d{2})?$/).optional(),
      taal: z.enum(["ENG", "FRE", "DUT"]).default("ENG"), sortering: z.enum(["datum", "relevantie"]).optional(),
      pagina: z.number().int().min(1).max(100).default(1), aantal: z.number().int().min(1).max(50).default(20),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    const q: string[] = [];
    if (a.zoekterm) q.push(`(${a.zoekterm.replace(/[()]/g, " ")})`);
    if (a.verweerder) {
      const c = staatCode(a.verweerder);
      if (!c) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Staat '${a.verweerder}' niet herkend.`, suggestion: "Geef de ISO-code (NLD, BEL, DEU, TUR …) of de naam in het Nederlands of Engels." }));
      q.push(`(respondent:"${c}")`);
    }
    if (a.artikel) q.push(`(article:"${a.artikel.replace(/^(?:art(?:ikel|icle)?\.?\s*)/i, "").replace(/\s*(?:lid|§)\s*/i, "-").replace(/"/g, "")}")`);
    const coll = { arrest: "JUDGMENTS", beslissing: "DECISIONS", advies: "ADVISORYOPINIONS", samenvatting: "CLIN", alle: null }[a.soort];
    if (coll && !(a.taal === "DUT" && a.soort === "arrest")) q.push(`(documentcollectionid2:"${coll}")`);
    if (a.grote_kamer) q.push(`(doctypebranch:"GRANDCHAMBER")`);
    if (a.belang?.length) q.push(`(${a.belang.map((b) => `importance:"${b}"`).join(" OR ")})`);
    if (a.van || a.tot) q.push(`(kpdate>="${a.van ? (a.van.length === 4 ? `${a.van}-01-01` : a.van) : "1959-01-01"}T00:00:00.0Z" AND kpdate<="${a.tot ? (a.tot.length === 4 ? `${a.tot}-12-31` : a.tot) : "2100-01-01"}T00:00:00.0Z")`);
    if (a.soort !== "advies") q.push(`(languageisocode:"${a.taal}")`);
    if (!q.length) q.push(`(documentcollectionid2:"JUDGMENTS")`);
    const url = hudocQueryUrl(q.join(" AND "), { start: (a.pagina - 1) * a.aantal, length: a.aantal, sort: a.sortering === "relevantie" || (a.zoekterm && !a.sortering) ? "" : "kpdate Descending" });
    try {
      const r = await json(url);
      const docs = (r.results ?? []).map((x) => x.columns);
      const records = docs.map((d) => {
        const m = hudocMetadata(d);
        const nl = betekenisVoorNederland(d);
        return rec(m.titel || String(d.itemid), m.url, m.datum, m.conclusie.join("; ") || undefined, { ...m, nederland_partij: nl.nederland_partij, ...(d.scl ? { aantal_aangehaalde_uitspraken: lijst(d.scl).length } : {}) });
      });
      return toMcpToolPayload(successResponse({
        summary: `HUDOC: ${r.resultcount ?? records.length} documenten; ${records.length} getoond (pagina ${a.pagina})`,
        records, provenance: prov("ehrm_zoeken", url, a, records.length, r.resultcount ?? records.length),
        access_note: `${NOTE} Belang 1 = key cases. Lees een uitspraak met ehrm_uitspraak_get (itemid, ECLI of verzoeknummer): die geeft de indeling naar standpunten en beoordeling, de betekenis voor Nederland en de Nederlandse uitspraken die het arrest aanhalen.`,
      }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "HUDOC", HUDOC_BASE)); }
  });

  server.registerTool("ehrm_uitspraak_get", {
    description: "One ruling of the European Court of Human Rights from HUDOC, by ECLI (ECLI:CE:ECHR:…), HUDOC link or itemid (001-…) or application number ('36391/02', also inside a citation like 'Salduz v. Turkey [GC], no. 36391/02'). Returns the metadata (respondent State, articles, conclusion, importance, separate opinions, cited case law, other language versions), what it means for the Netherlands (binding as res judicata when the Netherlands is the respondent State, otherwise res interpretata; Chamber or Grand Chamber; final or not, and whether a Grand Chamber judgment followed), the Dutch rulings that cite it (LiDO), and a structure overview that separates the parties' submissions (applicant, Government, third parties) from the Court's assessment (general principles, application to the case), the operative part and the separate opinions. Select text with onderdeel (e.g. ['algemene beginselen'], ['standpunten'], ['afwijkende mening'], ['beslissing']), alineas ('55' or '50-60') or zoekterm.",
    inputSchema: {
      uitspraak: z.string().min(5).max(500),
      onderdeel: z.array(z.enum(ONDERDELEN)).max(6).optional(), alineas: z.string().max(20).optional(), zoekterm: z.string().max(200).optional(),
      nederlandse_rechtspraak: z.boolean().default(true), max_chars: z.number().int().min(1000).max(100_000).default(30_000),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    const ref = hudocRef(a.uitspraak);
    if (!ref) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Geen ECLI, HUDOC-itemid of verzoeknummer in '${a.uitspraak.slice(0, 80)}'.`, suggestion: "Zoek de uitspraak met ehrm_zoeken (zoekterm met de naam van de zaak)." }));
    const qUrl = hudocQueryUrl(hudocIdQuery(ref), { length: 50 });
    try {
      const docs = ((await json(qUrl)).results ?? []).map((x) => x.columns);
      const { gekozen, andere } = kiesHudocDocument(docs);
      if (!gekozen) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `HUDOC kent geen uitspraak bij ${ref.ecli ?? ref.itemid ?? `verzoeknummer ${ref.appno}`}.`, suggestion: "Controleer het nummer of zoek met ehrm_zoeken." }));
      const bodyUrl = HUDOC_BODY(String(gekozen.itemid));
      const html = (await f(bodyUrl, { headers: HUDOC_HEADERS })).text;
      const units = hudocEenheden(hudocRegels(html));
      // A Grand Chamber judgment after this Chamber judgment is the one that counts.
      let gk: { itemid: string; datum: string; url: string } | null = null;
      if (gekozen.doctypebranch === "CHAMBER" && /JUDGMENTS/.test(String(gekozen.documentcollectionid2))) {
        const nr = lijst(gekozen.appno)[0];
        const rel = ref.appno ? docs : nr ? ((await json(hudocQueryUrl(`(appno:"${nr}") AND (doctypebranch:"GRANDCHAMBER")`, { length: 10 })).catch(() => ({ results: [] }))).results ?? []).map((x) => x.columns) : [];
        const g = rel.find((d) => d.doctypebranch === "GRANDCHAMBER" && /JUDGMENTS/.test(String(d.documentcollectionid2)) && String(d.kpdate) > String(gekozen.kpdate));
        if (g) gk = { itemid: String(g.itemid), datum: String(g.kpdate).slice(0, 10), url: HUDOC_URL(String(g.itemid)) };
      }
      let nlRechtspraak: Record<string, unknown> | undefined;
      if (a.nederlandse_rechtspraak && gekozen.ecli) {
        try {
          const l = await lido(String(gekozen.ecli));
          nlRechtspraak = l.bekend
            ? { totaal: l.totaal ?? 0, per_instantie: l.perInstantie?.slice(0, 12), recent: (l.rechtspraak?.length ? l.rechtspraak : l.items).slice(0, 10).map((d) => ({ id: d.id, titel: d.titel, url: d.url })), lido: l.portalUrl, toelichting: "Nederlandse uitspraken en conclusies die dit arrest noemen (LiDO, grotendeels door de computer herkend): een aanwijzing voor de relevantie voor de Nederlandse praktijk. Verdiep met lido_relaties (filters instantie, jaar)." }
            : { totaal: 0, toelichting: "LiDO kent geen Nederlandse uitspraken die dit arrest noemen." };
        } catch (e) { nlRechtspraak = { fout: `LiDO niet bereikbaar: ${e instanceof Error ? e.message : String(e)}` }; }
      }
      const sel = a.onderdeel?.length || a.alineas || a.zoekterm ? kiesEenheden(units, a) : units;
      const tekstVol = sel.map(formatEenheid).join("\n\n");
      const tekst = tekstVol.length > a.max_chars ? `${tekstVol.slice(0, a.max_chars)}…` : tekstVol;
      const meta = hudocMetadata(gekozen);
      const dut = andere.filter((d) => d.taal === "DUT");
      const data = {
        ...meta,
        betekenis_voor_nederland: betekenisVoorNederland(gekozen, html, { grandeKamerArrest: gk }),
        ...(gk ? { grote_kamer_arrest: gk } : {}),
        ...(nlRechtspraak ? { nederlandse_rechtspraak: nlRechtspraak } : {}),
        structuur: hudocStructuur(units),
        alineas_totaal: units.filter((u) => /^\d+$/.test(u.id)).length,
        ...(sel !== units ? { selectie: { onderdeel: a.onderdeel, alineas: a.alineas, zoekterm: a.zoekterm, aantal: sel.length } } : {}),
        tekst, ingekort: tekstVol.length > a.max_chars,
        ...(gekozen.scl ? { aangehaalde_rechtspraak: lijst(gekozen.scl) } : {}),
        ...(dut.length ? { nederlandse_versie: dut.map((d) => ({ titel: d.titel, url: d.url })) } : {}),
        ...(andere.length ? { andere_documenten: andere.slice(0, 25) } : {}),
      };
      return toMcpToolPayload(successResponse({
        summary: `${gekozen.docname} (${meta.datum}, ${meta.kamer}): ${data.alineas_totaal} alinea's; ${data.betekenis_voor_nederland.nederland_partij ? "Nederland verwerende staat" : "Nederland geen partij"}${nlRechtspraak && typeof nlRechtspraak.totaal === "number" ? `; ${nlRechtspraak.totaal} Nederlandse uitspraken noemen het` : ""}`,
        records: [rec(String(gekozen.docname), meta.url, meta.datum, meta.conclusie.join("; ") || undefined, data)],
        provenance: prov("ehrm_uitspraak_get", bodyUrl, { uitspraak: a.uitspraak, onderdeel: a.onderdeel?.join(","), alineas: a.alineas, zoekterm: a.zoekterm }, 1, 1),
        access_note: `${NOTE} De indeling (structuur) volgt de koppen van het Hof; 'weergave' betekent dat het Hof in die alinea een standpunt of een nationale uitspraak weergeeft.`,
      }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "HUDOC", qUrl)); }
  });
}
