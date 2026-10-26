/**
 * FORK (docs/FORK.md): searching rulings through Open Data van de Rechtspraak.
 *
 * uitspraken.rechtspraak.nl/api/zoek (the website's own search, used by
 * rechtspraak_search_ecli) answers this server "Request Rejected" (HTTP 403) since
 * October 2026. The documented service is the ECLI index of data.rechtspraak.nl
 * (technische documentatie Open Data v1.15, § 4): it selects on instantie (creator),
 * rechtsgebied (subject), uitspraakdatum (date), wijzigingsdatum (modified), type and
 * return=DOC, at most 1000 entries per request and 10 requests per second, and has no
 * search on words. Each entry carries the inhoudsindicatie, so the words are matched
 * here, in the inhoudsindicaties of the entries the filters select, newest first.
 *
 * installRechtspraakOpenData() lets RechtspraakSource.searchEcli fall back to this
 * search when the website search fails; the tool rechtspraak_zoeken_open_data searches
 * here directly, with the filters. No upstream file changes beyond the FORK lines
 * listed in docs/FORK.md.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { foldText, zoektermWords } from "../sources/dso-regeltekst.js";
import { normalizeEcli, parseUitspraakXml, RechtspraakSource } from "../sources/rechtspraak.js";
import type { AppConfig, MCPRecord } from "../types.js";
import { getText, SourceRequestError } from "../utils/http.js";
import { mapSourceError, nowIso, successResponse, toMcpToolPayload } from "../utils/response.js";

const OPEN_DATA_SEARCH = "https://data.rechtspraak.nl/uitspraken/zoeken";
const OPEN_DATA_CONTENT = "https://data.rechtspraak.nl/uitspraken/content";
const DETAILS = "https://uitspraken.rechtspraak.nl/details";
const SEARCH_PAGE = "https://uitspraken.rechtspraak.nl/resultaat";

/** The rechtsgebieden of the waardelijst (data.rechtspraak.nl/Waardelijst/Rechtsgebieden). */
const RECHTSGEBIEDEN: ReadonlyArray<{ id: string; naam: string }> = [
  { id: "bestuursrecht", naam: "Bestuursrecht" },
  { id: "bestuursrecht_ambtenarenrecht", naam: "Ambtenarenrecht" },
  { id: "bestuursrecht_belastingrecht", naam: "Belastingrecht" },
  { id: "bestuursrecht_bestuursprocesrecht", naam: "Bestuursprocesrecht" },
  { id: "bestuursrecht_bestuursstrafrecht", naam: "Bestuursstrafrecht" },
  { id: "bestuursrecht_europeesBestuursrecht", naam: "Europees bestuursrecht" },
  { id: "bestuursrecht_mededingingsrecht", naam: "Mededingingsrecht (bestuursrecht)" },
  { id: "bestuursrecht_omgevingsrecht", naam: "Omgevingsrecht" },
  { id: "bestuursrecht_socialezekerheidsrecht", naam: "Socialezekerheidsrecht" },
  { id: "bestuursrecht_vreemdelingenrecht", naam: "Vreemdelingenrecht" },
  { id: "civielRecht", naam: "Civiel recht" },
  { id: "civielRecht_aanbestedingsrecht", naam: "Aanbestedingsrecht" },
  { id: "civielRecht_arbeidsrecht", naam: "Arbeidsrecht" },
  { id: "civielRecht_burgerlijkProcesrecht", naam: "Burgerlijk procesrecht" },
  { id: "civielRecht_europeesCivielRecht", naam: "Europees civiel recht" },
  { id: "civielRecht_goederenrecht", naam: "Goederenrecht" },
  { id: "civielRecht_insolventierecht", naam: "Insolventierecht" },
  { id: "civielRecht_intellectueeleigendomsrecht", naam: "Intellectueel-eigendomsrecht" },
  { id: "civielRecht_internationaalPrivaatrecht", naam: "Internationaal privaatrecht" },
  { id: "civielRecht_mededingingsrecht", naam: "Mededingingsrecht" },
  { id: "civielRecht_ondernemingsrecht", naam: "Ondernemingsrecht" },
  { id: "civielRecht_personenEnFamilierecht", naam: "Personen- en familierecht" },
  { id: "civielRecht_verbintenissenrecht", naam: "Verbintenissenrecht" },
  { id: "strafrecht", naam: "Strafrecht" },
  { id: "strafrecht_europeesStrafrecht", naam: "Europees strafrecht" },
  { id: "strafrecht_internationaalStrafrecht", naam: "Internationaal strafrecht" },
  { id: "strafrecht_materieelStrafrecht", naam: "Materieel strafrecht" },
  { id: "strafrecht_penitentiairStrafrecht", naam: "Penitentiair strafrecht" },
  { id: "strafrecht_strafprocesrecht", naam: "Strafprocesrecht" },
  { id: "internationaalPubliekrecht", naam: "Internationaal publiekrecht" },
  { id: "internationaalPubliekrecht_mensenrechten", naam: "Mensenrechten" },
  { id: "internationaalPubliekrecht_volkenrecht", naam: "Volkenrecht" },
];
const RECHTSGEBIED_URI = "http://psi.rechtspraak.nl/rechtsgebied#";

/**
 * Words in a query that point at one rechtsgebied, so a search for "ontslag op staande
 * voet" reads the arbeidsrecht rulings rather than the newest rulings of all fields.
 * A stem matches the start of a word in the query ("huur" matches "huurder").
 */
const RECHTSGEBIED_HINTS: ReadonlyArray<{ id: string; stems: string[] }> = [
  { id: "civielRecht_arbeidsrecht", stems: ["ontslag", "arbeidsovereenkomst", "arbeidsrecht", "werknemer", "werkgever", "transitievergoeding", "billijke vergoeding", "cao", "concurrentiebeding", "loonvordering", "re-integratie", "staande voet"] },
  { id: "civielRecht_personenEnFamilierecht", stems: ["alimentatie", "echtscheiding", "gezag", "omgang", "ouderschap", "kinderalimentatie", "partneralimentatie", "huwelijk", "erfrecht", "nalatenschap", "testament", "curatele", "bewind", "mentorschap", "afstamming", "ondertoezichtstelling", "uithuisplaatsing", "jeugdbescherming"] },
  { id: "civielRecht_verbintenissenrecht", stems: ["huur", "verhuur", "ontruiming", "koopovereenkomst", "aanneming", "wanprestatie", "onrechtmatige daad", "aansprakelijkheid", "dwaling", "ontbinding overeenkomst"] },
  { id: "civielRecht_insolventierecht", stems: ["faillissement", "failliet", "schuldsanering", "wsnp", "curator", "surseance"] },
  { id: "civielRecht_goederenrecht", stems: ["eigendom", "erfdienstbaarheid", "erfpacht", "hypotheek", "pandrecht", "verkrijgende verjaring", "mandeligheid"] },
  { id: "civielRecht_ondernemingsrecht", stems: ["enquete", "bestuurdersaansprakelijkheid", "aandeelhouder", "vennootschap", "ondernemingskamer"] },
  { id: "bestuursrecht_socialezekerheidsrecht", stems: ["wia", "wao", "ziektewet", "participatiewet", "bijstand", "uwv", "svb", "aow", "wajong", "wmo", "jeugdwet", "kinderbijslag", "pgb", "arbeidsongeschikt"] },
  { id: "bestuursrecht_belastingrecht", stems: ["belasting", "btw", "omzetbelasting", "woz", "naheffingsaanslag", "navorderingsaanslag", "box 3"] },
  { id: "bestuursrecht_omgevingsrecht", stems: ["omgevingsvergunning", "bestemmingsplan", "omgevingsplan", "omgevingswet", "last onder dwangsom", "bouwvergunning", "milieuvergunning", "stikstof"] },
  { id: "bestuursrecht_vreemdelingenrecht", stems: ["vreemdeling", "asiel", "verblijfsvergunning", "inreisverbod"] },
  { id: "bestuursrecht_ambtenarenrecht", stems: ["ambtenaar", "ambtenarenrecht"] },
  { id: "civielRecht_aanbestedingsrecht", stems: ["aanbesteding", "gunning", "inschrijver"] },
  { id: "civielRecht_intellectueeleigendomsrecht", stems: ["merkenrecht", "auteursrecht", "octrooi"] },
  { id: "strafrecht", stems: ["strafzaak", "verdachte", "diefstal", "mishandeling", "opiumwet", "doodslag", "moord", "oplichting", "witwassen", "tbs", "voorlopige hechtenis", "ontneming"] },
];

/** The highest courts, the gerechtshoven and the rechtbanken (waardelijst Instanties, still in existence). */
const INSTANTIES: ReadonlyArray<{ afkorting: string; naam: string; uri: string }> = [
  ["HR", "Hoge Raad", "Hoge_Raad_der_Nederlanden"],
  ["PHR", "Parket bij de Hoge Raad", "Parket_bij_de_Hoge_Raad"],
  ["RVS", "Raad van State", "Raad_van_State"],
  ["CRVB", "Centrale Raad van Beroep", "Centrale_Raad_van_Beroep"],
  ["CBB", "College van Beroep voor het bedrijfsleven", "College_van_Beroep_voor_het_bedrijfsleven"],
  ["GHAMS", "Gerechtshof Amsterdam", "Gerechtshof_Amsterdam"],
  ["GHARL", "Gerechtshof Arnhem-Leeuwarden", "Gerechtshof_Arnhem-Leeuwarden"],
  ["GHDHA", "Gerechtshof Den Haag", "Gerechtshof_Den_Haag"],
  ["GHSHE", "Gerechtshof 's-Hertogenbosch", "Gerechtshof_'s-Hertogenbosch"],
  ["RBAMS", "Rechtbank Amsterdam", "Rechtbank_Amsterdam"],
  ["RBDHA", "Rechtbank Den Haag", "Rechtbank_Den_Haag"],
  ["RBGEL", "Rechtbank Gelderland", "Rechtbank_Gelderland"],
  ["RBLIM", "Rechtbank Limburg", "Rechtbank_Limburg"],
  ["RBMNE", "Rechtbank Midden-Nederland", "Rechtbank_Midden-Nederland"],
  ["RBNHO", "Rechtbank Noord-Holland", "Rechtbank_Noord-Holland"],
  ["RBNNE", "Rechtbank Noord-Nederland", "Rechtbank_Noord-Nederland"],
  ["RBOBR", "Rechtbank Oost-Brabant", "Rechtbank_Oost-Brabant"],
  ["RBOVE", "Rechtbank Overijssel", "Rechtbank_Overijssel"],
  ["RBROT", "Rechtbank Rotterdam", "Rechtbank_Rotterdam"],
  ["RBZWB", "Rechtbank Zeeland-West-Brabant", "Rechtbank_Zeeland-West-Brabant"],
].map(([afkorting, naam, slug]) => ({ afkorting, naam, uri: `http://standaarden.overheid.nl/owms/terms/${slug}` }));

/** Entries per request (the service's maximum), and the default and largest number read per search. */
const PAGE = 1000;
const SCAN_DEFAULT = 5000;
const SCAN_MAX = 10_000;
/** The service allows at most 10 requests per second; one at a time with a pause stays well below. */
const PAUSE_MS = 150;
/** Rulings read in full per search (volledige_tekst), and metadata checks for a procedure, by default and at most. */
const FULL_TEXT_DEFAULT = 100;
const FULL_TEXT_MAX = 300;
const PROCEDURE_CHECKS_MAX = 300;
/** Documents fetched side by side, each worker pausing between requests: 3 workers stay below 10 requests per second. */
const DOC_WORKERS = 3;
const DOC_PAUSE_MS = 300;

/** fn over the items, DOC_WORKERS at a time with a pause after each request; stops early when stop() says so. */
async function paced<T, R>(items: T[], fn: (item: T) => Promise<R>, stop: () => boolean = () => false): Promise<Array<R | undefined>> {
  const out: Array<R | undefined> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch {
        out[i] = undefined;
      }
      await new Promise((r) => setTimeout(r, DOC_PAUSE_MS));
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOC_WORKERS, items.length) }, worker));
  return out;
}

/** The procedure labels of a ruling ("Kort geding", "Hoger beroep", "Beschikking"), from its metadata (return=META, a few kB). */
async function procedureLabels(ecli: string): Promise<string[]> {
  const { data } = await getText(OPEN_DATA_CONTENT, { query: { id: ecli, return: "META" }, timeoutMs: 20_000, retries: 1, connector: "rechtspraak_open_data", headers: { Accept: "application/xml" } });
  return [...data.matchAll(/<psi:procedure\b[^>]*>([^<]*)<\/psi:procedure>/g)].map((m) => decodeXmlEntities(m[1]).trim()).filter(Boolean);
}

/** The full text and the procedure labels of a ruling (metadata and document in one request). */
async function fullTextOf(ecli: string): Promise<{ text: string; procedures: string[] }> {
  const { data } = await getText(OPEN_DATA_CONTENT, { query: { id: ecli }, timeoutMs: 30_000, retries: 1, connector: "rechtspraak_open_data", headers: { Accept: "application/xml" } });
  const doc = parseUitspraakXml(data, ecli);
  return { text: doc.blocks.map((b) => b.text).join("\n"), procedures: doc.meta.procedures };
}

/** Does a procedure label match what was asked ("kort geding" matches "Kort geding" and "Hoger beroep kort geding")? */
export function procedureMatches(labels: string[], wanted: string): boolean {
  const want = foldText(wanted).replace(/\s+/g, " ").trim();
  return labels.some((l) => foldText(l).includes(want));
}

/** About 300 characters around the first query word in the text, for a hit found in the full text. */
export function passageAround(text: string, words: Array<{ word: string; stem?: string }>): string {
  const folded = foldText(text);
  let at = -1;
  for (const w of words) {
    at = folded.indexOf(w.word);
    if (at < 0 && w.stem) at = folded.indexOf(w.stem);
    if (at >= 0) break;
  }
  if (at < 0) return "";
  const from = Math.max(0, at - 120);
  return `${from ? "…" : ""}${text.slice(from, at + 180).replace(/\s+/g, " ").trim()}…`;
}

/** Rechtsgebied ids for a name ("arbeidsrecht", "Personen- en familierecht", "bestuursrecht"), or from hints in the query. */
export function resolveRechtsgebieden(rechtsgebied: string | undefined, query: string): { ids: string[]; bron: "opgegeven" | "afgeleid" | "geen"; onbekend?: string } {
  if (rechtsgebied?.trim()) {
    const want = foldText(rechtsgebied).replace(/[^a-z]+/g, "");
    const ids = RECHTSGEBIEDEN.filter((r) => {
      const naam = foldText(r.naam).replace(/[^a-z]+/g, "");
      return naam === want || naam.startsWith(want) || r.id.toLowerCase().replace(/[^a-z]+/g, "").endsWith(want);
    }).map((r) => r.id);
    return ids.length ? { ids, bron: "opgegeven" } : { ids: [], bron: "geen", onbekend: rechtsgebied };
  }
  const q = ` ${foldText(query)} `;
  const ids = RECHTSGEBIED_HINTS.filter((h) => h.stems.some((s) => q.includes(` ${s}`))).map((h) => h.id);
  return ids.length ? { ids: [...new Set(ids)], bron: "afgeleid" } : { ids: [], bron: "geen" };
}

/** Instantie URIs for an ECLI code ("HR", "CRvB"), a name or part of one ("Hoge Raad", "hof Den Haag"); several separated by commas. */
export function resolveInstanties(instantie: string | undefined): { uris: string[]; namen: string[]; onbekend: string[] } {
  const uris: string[] = [];
  const namen: string[] = [];
  const onbekend: string[] = [];
  for (const part of String(instantie ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const folded = foldText(part).replace(/\bhof\b/, "gerechtshof").replace(/\s+/g, " ");
    const hits = INSTANTIES.filter((i) => i.afkorting.toLowerCase() === folded.replace(/\s/g, "") || foldText(i.naam).includes(folded));
    if (!hits.length) onbekend.push(part);
    for (const h of hits) if (!uris.includes(h.uri)) { uris.push(h.uri); namen.push(h.naam); }
  }
  return { uris, namen, onbekend };
}

export interface OpenDataEntry {
  ecli: string;
  instantie?: string;
  uitspraakdatum?: string;
  zaaknummer?: string;
  inhoudsindicatie: string;
  updated?: string;
  link: string;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** The entries of an ECLI-index feed (title "ECLI, instantie, dd-mm-jjjj, zaaknummer"); deleted entries are left out. */
export function parseOpenDataFeed(xml: string): { total?: number; entries: OpenDataEntry[] } {
  const total = Number(xml.match(/Aantal gevonden ECLI['’]s:\s*(\d+)/)?.[1]);
  const entries: OpenDataEntry[] = [];
  for (const m of xml.matchAll(/<entry(\s[^>]*)?>([\s\S]*?)<\/entry>/g)) {
    if (/deleted=/.test(m[1] ?? "")) continue;
    const body = m[2];
    const field = (tag: string) => {
      const f = body.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
      return f ? decodeXmlEntities(f[1]).trim() : undefined;
    };
    const ecli = normalizeEcli(field("id") ?? "");
    if (!ecli) continue;
    const parts = (field("title") ?? "").split(/,\s*/);
    const datum = parts.find((p) => /^\d{2}-\d{2}-\d{4}$/.test(p));
    const [dd, mm, jjjj] = datum ? datum.split("-") : [];
    const href = body.match(/<link[^>]*href="([^"]+)"/)?.[1];
    entries.push({
      ecli,
      instantie: parts[1] || undefined,
      uitspraakdatum: datum ? `${jjjj}-${mm}-${dd}` : undefined,
      zaaknummer: datum ? parts.slice(parts.indexOf(datum) + 1).join(", ") || undefined : undefined,
      inhoudsindicatie: field("summary") ?? "",
      updated: field("updated"),
      link: href ? decodeXmlEntities(href) : `${DETAILS}?id=${encodeURIComponent(ecli)}`,
    });
  }
  return { total: Number.isFinite(total) ? total : undefined, entries };
}

/** Function words left out of the query; they say nothing about a ruling. */
const STOPWOORDEN = new Set(["de", "het", "een", "en", "of", "op", "in", "van", "voor", "met", "aan", "bij", "naar", "over", "door", "om", "te", "tot", "uit", "als", "dat", "die", "is", "zijn", "niet", "wel"]);

export function openDataQueryWords(query: string): Array<{ word: string; stem?: string }> {
  return zoektermWords(query).filter((w) => !STOPWOORDEN.has(w.word));
}

/** Every query word found (in the ECLI, instantie, zaaknummer or inhoudsindicatie) counts; the words in a row count extra. */
export function scoreOpenDataEntry(entry: OpenDataEntry, words: Array<{ word: string; stem?: string }>): { matched: number; score: number } {
  const text = foldText(`${entry.ecli} ${entry.instantie ?? ""} ${entry.zaaknummer ?? ""} ${entry.inhoudsindicatie}`);
  let matched = 0;
  for (const w of words) if (text.includes(w.word) || (w.stem && text.includes(w.stem))) matched++;
  const phrase = words.map((w) => w.word).join(" ");
  return { matched, score: matched * 10 + (words.length > 1 && text.includes(phrase) ? 25 : 0) };
}

export interface OpenDataSearchArgs {
  query: string;
  rows: number;
  sort?: "relevance" | "date_newest" | "ruling_newest";
  date_filter?: "week" | "month" | "year" | "last_year";
  rechtsgebied?: string;
  instantie?: string;
  van?: string;
  tot?: string;
  scan?: number;
  /** Also read the full text of the newest rulings the inhoudsindicatie did not match (at most max_documenten). */
  volledige_tekst?: boolean;
  max_documenten?: number;
  /** Only rulings with this procedure (psi:procedure): "kort geding", "hoger beroep", "cassatie", "voorlopige voorziening", … */
  procedure?: string;
  /** Why this search runs here (the website search refused): leads the access note. */
  reden?: string;
}

export interface OpenDataSearchResult {
  items: Array<Record<string, unknown>>;
  total: number;
  endpoint: string;
  params: Record<string, string>;
  access_note: string;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The filters select the entries of the ECLI index (rulings with a published text,
 * most recently published or changed first); the query words are matched in their
 * inhoudsindicaties. Reads at most `scan` entries, 1000 per request, one request at a time.
 */
export async function searchRechtspraakOpenData(args: OpenDataSearchArgs): Promise<OpenDataSearchResult> {
  const gebieden = resolveRechtsgebieden(args.rechtsgebied, args.query);
  const instanties = resolveInstanties(args.instantie);
  const scan = Math.min(Math.max(args.scan ?? SCAN_DEFAULT, PAGE), SCAN_MAX);

  const base = new URLSearchParams({ return: "DOC", sort: "DESC" });
  for (const id of gebieden.ids) base.append("subject", `${RECHTSGEBIED_URI}${id}`);
  for (const uri of instanties.uris) base.append("creator", uri);

  // date = uitspraakdatum (from and to inclusive); modified = published or changed since.
  const now = new Date();
  let van = args.van;
  let tot = args.tot;
  let gewijzigdSinds: string | undefined;
  if (args.date_filter === "week" || args.date_filter === "month") {
    const since = new Date(now);
    if (args.date_filter === "week") since.setUTCDate(since.getUTCDate() - 7);
    else since.setUTCMonth(since.getUTCMonth() - 1);
    gewijzigdSinds = `${isoDay(since)}T00:00:00`;
    base.append("modified", gewijzigdSinds);
  } else if (args.date_filter === "year") {
    van ??= `${now.getUTCFullYear()}-01-01`;
    tot ??= isoDay(now);
  } else if (args.date_filter === "last_year") {
    van ??= `${now.getUTCFullYear() - 1}-01-01`;
    tot ??= `${now.getUTCFullYear() - 1}-12-31`;
  }
  if (van || tot) {
    base.append("date", van ?? "1800-01-01");
    base.append("date", tot ?? isoDay(now));
  }

  const words = openDataQueryWords(args.query);
  const scored: Array<OpenDataEntry & { matched: number; score: number }> = [];
  let total: number | undefined;
  let gelezen = 0;
  let firstUrl = "";
  for (let from = 0; from < scan; from += PAGE) {
    const params = new URLSearchParams(base);
    params.set("max", String(PAGE));
    if (from) params.set("from", String(from));
    const url = `${OPEN_DATA_SEARCH}?${params.toString()}`;
    firstUrl ||= url;
    if (from) await new Promise((r) => setTimeout(r, PAUSE_MS));
    const { data } = await getText(url, { timeoutMs: 30_000, retries: 1, connector: "rechtspraak_open_data", headers: { Accept: "application/atom+xml, application/xml" } });
    const feed = parseOpenDataFeed(data);
    total ??= feed.total;
    gelezen += feed.entries.length;
    for (const e of feed.entries) scored.push({ ...e, ...(words.length ? scoreOpenDataEntry(e, words) : { matched: 0, score: 0 }) });
    if (feed.entries.length < PAGE) break;
  }

  // All words in the inhoudsindicatie first; then (volledige_tekst) all words in the full text; then most words (marked).
  const byDate = (a?: string, b?: string) => String(b ?? "").localeCompare(String(a ?? ""));
  const order = (a: (typeof scored)[number], b: (typeof scored)[number]) =>
    args.sort === "date_newest" ? byDate(a.updated, b.updated)
    : args.sort === "ruling_newest" ? byDate(a.uitspraakdatum, b.uitspraakdatum)
    : b.score - a.score || byDate(a.uitspraakdatum, b.uitspraakdatum);
  const all = (words.length ? scored.filter((e) => e.matched === words.length) : scored).sort(order);

  // The full text of the newest rulings the inhoudsindicatie did not match.
  const procedures = new Map<string, string[]>();
  const passages = new Map<string, string>();
  const inFullText: typeof scored = [];
  let fullRead = 0;
  let fullAsked = 0;
  if (args.volledige_tekst && words.length) {
    const done = new Set(all.map((e) => e.ecli));
    const candidates = scored.filter((e) => !done.has(e.ecli)).sort((a, b) => byDate(a.uitspraakdatum, b.uitspraakdatum)).slice(0, Math.min(args.max_documenten ?? FULL_TEXT_DEFAULT, FULL_TEXT_MAX));
    fullAsked = candidates.length;
    const docs = await paced(candidates, (e) => fullTextOf(e.ecli));
    candidates.forEach((e, i) => {
      const doc = docs[i];
      if (!doc) return;
      fullRead++;
      procedures.set(e.ecli, doc.procedures);
      const text = foldText(doc.text);
      if (words.every((w) => text.includes(w.word) || (w.stem !== undefined && text.includes(w.stem)))) {
        inFullText.push({ ...e, matched: words.length });
        passages.set(e.ecli, passageAround(doc.text, words));
      }
    });
    inFullText.sort(order);
  }

  const found = new Set([...all, ...inFullText].map((e) => e.ecli));
  const needed = Math.max(1, Math.ceil(words.length / 2));
  const partial = words.length > 1 ? scored.filter((e) => !found.has(e.ecli) && e.matched >= needed && e.matched < words.length).sort(order) : [];
  let ranked = [...all, ...inFullText, ...partial];

  // Procedure (kort geding, hoger beroep, …): from the metadata of each ruling in order, until there are enough.
  let procChecked = 0;
  if (args.procedure?.trim()) {
    const want = args.procedure;
    const toCheck = ranked.slice(0, PROCEDURE_CHECKS_MAX);
    let hits = 0;
    const labels = await paced(
      toCheck,
      async (e) => {
        const l = procedures.get(e.ecli) ?? (await procedureLabels(e.ecli));
        procChecked++;
        if (procedureMatches(l, want)) hits++;
        return l;
      },
      () => hits >= args.rows,
    );
    toCheck.forEach((e, i) => { if (labels[i]) procedures.set(e.ecli, labels[i]!); });
    ranked = toCheck.filter((e, i) => labels[i] && procedureMatches(labels[i]!, want));
  }
  const chosen = ranked.slice(0, args.rows);

  const items = chosen.map((e) => ({
    id: e.ecli,
    ecli: e.ecli,
    title: [e.ecli, e.instantie, e.uitspraakdatum?.split("-").reverse().join("-"), e.zaaknummer].filter(Boolean).join(", "),
    summary: e.inhoudsindicatie,
    updated: e.updated,
    link: e.link,
    instantie: e.instantie,
    uitspraakdatum: e.uitspraakdatum,
    zaaknummer: e.zaaknummer,
    ...(procedures.get(e.ecli)?.length ? { procedures: procedures.get(e.ecli) } : {}),
    ...(passages.has(e.ecli) ? { gevonden_in: "volledige tekst", passage: passages.get(e.ecli) } : words.length ? { gevonden_in: "inhoudsindicatie" } : {}),
    ...(e.matched < words.length ? { gedeeltelijke_match: `${e.matched} van ${words.length} zoekwoorden` } : {}),
  }));

  const filters = [
    gebieden.ids.length ? `rechtsgebied ${gebieden.ids.map((id) => RECHTSGEBIEDEN.find((r) => r.id === id)?.naam ?? id).join(" of ")}${gebieden.bron === "afgeleid" ? " (afgeleid uit de zoekwoorden)" : ""}` : "",
    instanties.namen.length ? `instantie ${instanties.namen.join(" of ")}` : "",
    van || tot ? `uitspraakdatum ${van ?? "…"} t/m ${tot ?? "vandaag"}` : "",
    gewijzigdSinds ? `gepubliceerd of gewijzigd sinds ${gewijzigdSinds.slice(0, 10)}` : "",
  ].filter(Boolean);
  const notes = [
    `${args.reden ? `${args.reden} ` : ""}Gezocht via Open Data van de Rechtspraak (data.rechtspraak.nl).`,
    `Filters: ${filters.join("; ") || "geen"}. ${gelezen} van ${total ?? "?"} uitspraken met tekst gelezen, laatst gepubliceerd of gewijzigd eerst; de zoekwoorden zijn gezocht in de inhoudsindicaties.`,
    gebieden.onbekend ? `Rechtsgebied '${gebieden.onbekend}' komt niet voor in de waardelijst; zonder rechtsgebied gezocht. Kies uit: ${RECHTSGEBIEDEN.map((r) => r.naam).join(", ")}.` : "",
    instanties.onbekend.length ? `Instantie '${instanties.onbekend.join("', '")}' niet herkend; geef bijvoorbeeld 'Hoge Raad', 'CRvB', 'Raad van State' of 'Gerechtshof Den Haag'.` : "",
    total !== undefined && gelezen < total ? "Niet alle uitspraken binnen deze filters zijn gelezen: geef instantie, rechtsgebied of een periode (van/tot) in rechtspraak_zoeken_open_data om gerichter en verder terug te zoeken." : "",
    fullAsked ? `Volledige tekst: ${fullRead} van de ${fullAsked} nieuwste uitspraken zonder treffer in de inhoudsindicatie gelezen, ${inFullText.length} met alle zoekwoorden in de tekst (gevonden_in: volledige tekst, met passage).${fullAsked < scored.length - all.length ? " Meer lezen: max_documenten (hoogstens 300), of beperk met instantie of periode." : ""}` : "",
    args.procedure?.trim() ? `Proceduresoort '${args.procedure}': ${procChecked} uitspraken nagekeken in hun metadata, ${ranked.length} met die procedure.${ranked.length < args.rows && procChecked >= PROCEDURE_CHECKS_MAX ? ` Na ${PROCEDURE_CHECKS_MAX} gestopt; beperk met instantie of periode.` : ""}` : "",
    chosen.some((e) => e.matched < words.length) ? "Uitspraken met gedeeltelijke_match bevatten niet alle zoekwoorden." : "",
    !items.length ? `Geen uitspraak gevonden met deze zoekwoorden in de gelezen ${args.volledige_tekst ? "teksten" : "inhoudsindicaties"}${args.procedure ? ` en procedure '${args.procedure}'` : ""}. Probeer andere of minder woorden${args.volledige_tekst ? "" : ", volledige_tekst: true"}, of zoek handmatig op ${SEARCH_PAGE}?zoekterm=${encodeURIComponent(args.query)}.` : "",
    items.length ? "Tekst van een uitspraak: rechtspraak_uitspraak_get; relaties (hoger beroep, cassatie, latere rechtspraak): lido_relaties met de ECLI." : "",
  ].filter(Boolean);

  return {
    items,
    total: ranked.length,
    endpoint: firstUrl || OPEN_DATA_SEARCH,
    params: {
      term: args.query,
      rows: String(args.rows),
      bron: "data.rechtspraak.nl (Open Data)",
      gelezen: String(gelezen),
      ...(fullAsked ? { volledige_tekst_gelezen: String(fullRead) } : {}),
      ...(args.procedure?.trim() ? { procedure: args.procedure } : {}),
      ...(gebieden.ids.length ? { rechtsgebied: gebieden.ids.join(",") } : {}),
      ...(instanties.uris.length ? { instantie: instanties.namen.join(",") } : {}),
      ...(van || tot ? { uitspraakdatum: `${van ?? ""}/${tot ?? ""}` } : {}),
      ...(gewijzigdSinds ? { gewijzigd_sinds: gewijzigdSinds } : {}),
    },
    access_note: notes.join(" "),
  };
}

let installed = false;

/**
 * RechtspraakSource.searchEcli (rechtspraak_search_ecli and nl_gov_ask) tries the
 * website search first and falls back to Open Data when it fails, so a refusal there
 * never leaves a search empty.
 */
export function installRechtspraakOpenData(): void {
  if (installed) return;
  installed = true;
  const website = RechtspraakSource.prototype.searchEcli;
  RechtspraakSource.prototype.searchEcli = async function (this: RechtspraakSource, args) {
    try {
      return await website.call(this, args);
    } catch (error) {
      const status = error instanceof SourceRequestError && error.status ? ` (HTTP ${error.status})` : "";
      return (await searchRechtspraakOpenData({ ...args, reden: `De zoekfunctie van uitspraken.rechtspraak.nl weigerde de vraag${status}.` })) as unknown as Awaited<ReturnType<typeof website>>;
    }
  };
}

export interface RechtspraakOpenDataDeps {
  config: AppConfig;
  TOOL_ANNOTATIONS: Record<string, unknown>;
}

export function registerRechtspraakOpenData(server: McpServer, deps: RechtspraakOpenDataDeps): void {
  installRechtspraakOpenData();
  server.registerTool("rechtspraak_zoeken_open_data", {
    description:
      "Search Dutch case law through Open Data van de Rechtspraak (data.rechtspraak.nl), with filters: rechtsgebied, instantie (court) and uitspraakdatum (van/tot). " +
      "The filters select rulings with a published text, most recently published first (up to 'scan' rulings, default 5000); the keywords are matched in their inhoudsindicaties. " +
      "Use it to find rulings of one court or field, also older ones (give a period), e.g. Hoge Raad on 'transitievergoeding' since 2015. rechtspraak_search_ecli falls back to this search when the website search refuses. " +
      "volledige_tekst: true also reads the full text of the newest rulings whose inhoudsindicatie lacks the words (max_documenten, default 100, at most 300; slower, about 10-40 s), and returns the passage where the words stand. " +
      "procedure keeps only rulings with that procedure (from each ruling's metadata): 'kort geding', 'hoger beroep', 'cassatie', 'voorlopige voorziening', 'eerste aanleg - enkelvoudig', 'verzet', 'herziening', 'prejudiciële beslissing', 'beschikking', … " +
      "access_note says which filters applied and how many rulings were read. Text of a ruling: rechtspraak_uitspraak_get; relations: lido_relaties.",
    inputSchema: {
      query: z.string().min(1).max(200).describe("Keywords, matched in the inhoudsindicatie (all words; rulings with most of them follow, marked)."),
      rechtsgebied: z.string().optional().describe("Rechtsgebied of the waardelijst: 'arbeidsrecht', 'personen- en familierecht', 'verbintenissenrecht', 'socialezekerheidsrecht', 'belastingrecht', 'omgevingsrecht', 'bestuursrecht', 'strafrecht', … Left out, it is derived from the keywords where they point at one field."),
      instantie: z.string().optional().describe("Court by name or ECLI code, several separated by commas: 'Hoge Raad', 'HR', 'CRvB', 'Raad van State', 'CBb', 'Gerechtshof Den Haag', 'Rechtbank Rotterdam'."),
      van: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Earliest uitspraakdatum, JJJJ-MM-DD."),
      tot: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Latest uitspraakdatum, JJJJ-MM-DD."),
      sort: z.enum(["relevance", "date_newest", "ruling_newest"]).default("relevance"),
      rows: z.number().int().min(1).max(50).default(20),
      scan: z.number().int().min(1000).max(SCAN_MAX).default(SCAN_DEFAULT).describe("How many rulings to read at most (1000 per request)."),
      volledige_tekst: z.boolean().default(false).describe("Also search the full text of the newest rulings whose inhoudsindicatie lacks the words."),
      max_documenten: z.number().int().min(10).max(FULL_TEXT_MAX).default(FULL_TEXT_DEFAULT).describe("With volledige_tekst: how many rulings to read in full at most."),
      procedure: z.string().max(60).optional().describe("Only rulings with this procedure: 'kort geding', 'hoger beroep', 'cassatie', 'voorlopige voorziening', 'verzet', 'beschikking', …"),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (args) => {
    try {
      const out = await searchRechtspraakOpenData(args);
      const records: MCPRecord[] = out.items.map((x) => ({ source_name: "rechtspraak", title: String(x.title), canonical_url: String(x.link), snippet: String(x.summary ?? ""), ...(x.uitspraakdatum ? { date: String(x.uitspraakdatum) } : {}), data: x }));
      return toMcpToolPayload(successResponse({
        summary: `${records.length} Rechtspraak resultaten (Open Data)`,
        records,
        provenance: { tool: "rechtspraak_zoeken_open_data", endpoint: out.endpoint, query_params: out.params, timestamp: nowIso(), returned_results: records.length, total_results: out.total },
        access_note: out.access_note,
      }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Open Data van de Rechtspraak", "https://data.rechtspraak.nl"));
    }
  });
}
