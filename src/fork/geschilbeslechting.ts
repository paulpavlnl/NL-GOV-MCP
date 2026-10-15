/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. Rulings outside rechtspraak.nl, for research:
 * - Raad van State (raadvanstate.nl): its own search with facets (rechtsgebied, procedure, type,
 *   jaar). Its rulings are also on rechtspraak.nl; the search gives the ECLI, read the text there.
 * - College voor de Rechten van de Mens (oordelen.mensenrechten.nl): oordelen gelijke behandeling.
 * - Onderwijsgeschillen (onderwijsgeschillen.nl): via the site's public Algolia search key.
 * - De Geschillencommissie (degeschillencommissie.nl): consumenten- en zakelijke geschillen.
 * - Raad van Arbitrage in bouwgeschillen (raadvanarbitrage.info): an arbitration institute, not a
 *   court; its awards are almost never on rechtspraak.nl.
 * - MfN-register Tuchtrecht Updates (mfn-tuchtrechtupdates.nl): tuchtrecht voor mediators.
 * geschil_uitspraak_get reads one document from these sites (HTML or PDF).
 * Registered from registerEuForkTools.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MCPRecord } from "../types.js";
import { fetchPdfText } from "../utils/pdf-text.js";
import { errorResponse, mapSourceError, nowIso, successResponse, toMcpToolPayload } from "../utils/response.js";
import { decodeEntities, htmlNaarTekst } from "./juridische-bronnen.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 30_000;
export const GESCHIL_HOSTS = ["www.raadvanstate.nl", "oordelen.mensenrechten.nl", "www.onderwijsgeschillen.nl", "www.degeschillencommissie.nl", "www.raadvanarbitrage.info", "www.mfn-tuchtrechtupdates.nl", "wordpress.onderwijsgeschillen.nl", "www.kifid.nl"];
export const KIFID_API = "https://www.kifid.nl/api/Search/SearchDecision/";
const ALGOLIA = { app: "WZZZ9YGZMQ", key: "2c1b53e1dd0676f10fa8a06a7df2c0d1", index: "posts" }; // public search-only key from the site itself

type Fetcher = (url: string, init?: { method?: "GET" | "POST"; body?: string; headers?: Record<string, string> }) => Promise<{ status: number; url: string; text: string; cookies: string[] }>;

export const httpFetch: Fetcher = async (url, init = {}) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { method: init.method ?? "GET", redirect: "follow", headers: { "User-Agent": UA, "Accept-Language": "nl", ...(init.headers ?? {}) }, ...(init.body ? { body: init.body } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await res.text();
      if (res.status >= 500) throw new Error(`HTTP ${res.status} van ${new URL(url).hostname}`);
      return { status: res.status, url: res.url, text, cookies: typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [] };
    } catch (e) { lastError = e; }
  }
  throw lastError;
};

// Some sites encode entities twice ("&amp;euml;"): decode the result once more.
const inline = (html: string) => decodeEntities(htmlNaarTekst(html)).replace(/\s*\n\s*/g, " ").trim();
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const rec = (source: string, title: string, url: string, date: string | undefined, snippet: string | undefined, data: Record<string, unknown>): MCPRecord => ({ source_name: source, title, canonical_url: url, ...(date ? { date } : {}), ...(snippet ? { snippet: snippet.slice(0, 400) } : {}), data });

/** Checkbox/option facets of a search form: [{name, value, label, aantal}]. */
export function formFacetten(html: string, name: string): Array<{ value: string; label: string; aantal?: number }> {
  const out: Array<{ value: string; label: string; aantal?: number }> = [];
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of html.matchAll(new RegExp(`<input\\b[^>]*name="${esc}"[^>]*>`, "gi"))) {
    const value = /value="([^"]*)"/i.exec(m[0])?.[1];
    const id = /id="([^"]*)"/i.exec(m[0])?.[1];
    const lab = id ? new RegExp(`<label[^>]*for="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</label>`, "i").exec(html)?.[1] : undefined;
    const after = lab ?? /^[\s\S]{0,300}?<\/label>/.exec(html.slice((m.index ?? 0) + m[0].length))?.[0] ?? "";
    const t = inline(after);
    const cnt = /\(([\d.]+)\)\s*$/.exec(t);
    if (value) out.push({ value, label: t.replace(/\s*\([\d.]+\)\s*$/, "").trim(), ...(cnt ? { aantal: Number(cnt[1].replace(/\./g, "")) } : {}) });
  }
  return out;
}

/** The facet value for a label the user gives ("Asiel", "geslacht"): exact, then prefix, then contains. */
export function kiesFacet(facetten: Array<{ value: string; label: string }>, invoer: string): { value: string; label: string } | null {
  const f = fold(invoer);
  return facetten.find((x) => fold(x.label) === f) ?? facetten.find((x) => fold(x.label).startsWith(f)) ?? facetten.find((x) => fold(x.label).includes(f)) ?? null;
}

const facetCache = new Map<string, { at: number; html: string }>();
async function formPagina(url: string, f: Fetcher): Promise<string> {
  const c = facetCache.get(url);
  if (c && Date.now() - c.at < 24 * 3600_000) return c.html;
  const html = (await f(url)).text;
  facetCache.set(url, { at: Date.now(), html });
  return html;
}

// ---------- Raad van State ----------

export const RVS_ZOEK = "https://www.raadvanstate.nl/uitspraken/";
export function parseRvsLijst(html: string) {
  const totaal = /aantal resultaten:\s*([\d.]+)/i.exec(html)?.[1];
  const items = [...html.matchAll(/<h2><a class="siteLink" href="([^"]+)">([^<]+)<\/a><\/h2>([\s\S]*?)(?=<h2><a class="siteLink"|<\/main>|$)/gi)].map(([, url, zaak, rest]) => {
    const dd = (k: string) => inline(new RegExp(`<dt>\\s*${k}\\s*(?:</dt>)?\\s*<dd>([\\s\\S]*?)(?=<dt>|</dl>)`, "i").exec(rest)?.[1] ?? "") || undefined;
    const tags = [...(/<ul class="trefwoorden">([\s\S]*?)<\/ul>/i.exec(rest)?.[1] ?? "").matchAll(/<li>([^<]+)/g)].map((m) => decodeEntities(m[1]).trim()).filter(Boolean);
    return { zaaknummer: decodeEntities(zaak).trim(), url: url.replace(/[#?].*$/, ""), ecli: dd("ECLI"), datum: dd("Datum uitspraak"), trefwoorden: tags, samenvatting: inline(/<div class="summary">([\s\S]*?)<\/div>/i.exec(rest)?.[1] ?? "") };
  });
  return { totaal: totaal ? Number(totaal.replace(/\./g, "")) : items.length, items };
}

// ---------- College voor de Rechten van de Mens ----------

export const CRM_ZOEK = "https://oordelen.mensenrechten.nl/oordelen";
export function parseCrmLijst(html: string) {
  const totaal = Number(/data-searchresultscount="(\d+)"/.exec(html)?.[1] ?? NaN);
  const items = [...html.matchAll(/<a href="(\/oordeel\/(\d{4}-\d+)\/[0-9a-f-]{36})">\s*<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>\s*<p class="meta">([\s\S]*?)<\/p>/gi)].map(([, href, nummer, titel, fragment, meta]) => ({
    nummer, url: new URL(href, CRM_ZOEK).toString(), titel: inline(titel), fragment: inline(fragment).replace(/^…\s*/, ""), datum: /datetime="(\d{4}-\d{2}-\d{2})/.exec(meta)?.[1],
  }));
  return { totaal: Number.isFinite(totaal) ? totaal : items.length, items };
}

// ---------- De Geschillencommissie ----------

export const GC_ZOEK = "https://www.degeschillencommissie.nl/uitspraken-overzicht/";
export const slug = (s: string) => fold(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export function parseGcLijst(html: string) {
  const totaal = /van de\s*([\d.]+)\s*uitspraken/i.exec(inline(html.slice(0, 600_000)))?.[1];
  const items = [...html.matchAll(/<article>\s*<h4><a href="([^"]+)">([\s\S]*?)<\/a><\/h4>\s*<p class="uitspraken-info">([\s\S]*?)<\/p>\s*(?:<p>([\s\S]*?)<\/p>)?/gi)].map(([, url, titel, info, frag]) => {
    const t = inline(info);
    const get = (k: string, next: string) => new RegExp(`${k}:\\s*(.+?)\\s*(?:${next}:|$)`).exec(t)?.[1]?.trim();
    return { url, titel: inline(titel), commissie: get("Commissie", "Categorie"), categorie: get("Categorie", "Jaartal"), jaar: get("Jaartal", "Soort uitspraak"), soort: get("Soort uitspraak", "Uitkomst"), uitkomst: get("Uitkomst", "Referentiecode"), referentie: get("Referentiecode", "$^"), fragment: frag ? inline(frag).replace(/\s*\[…\]$|\s*\[&hellip;\]$/, "…") : undefined };
  });
  return { totaal: totaal ? Number(totaal.replace(/\./g, "")) : items.length, items };
}

// ---------- Raad van Arbitrage in bouwgeschillen ----------

export const RVA_BASE = "https://www.raadvanarbitrage.info/";
export const RVA_BRONNEN: Record<string, string> = { "eerste aanleg": "1", "hoger beroep": "2", garantie: "3", "garantie hoger beroep": "4", aibk: "5", metaal: "6", kivi: "7" };
export function parseRvaLijst(html: string) {
  const json = /searchResultsPage",\s*'(\{[\s\S]*?\})'\s*\)/.exec(html)?.[1];
  const data = json ? (JSON.parse(json) as { totalResults?: number; results?: Array<{ id: number; pdfUrl: string; pdfName: string }> }) : {};
  const pdf = new Map((data.results ?? []).map((r) => [r.id, r.pdfUrl]));
  const items = [...html.matchAll(/<p class='zoekenResultaat'[^>]*><a[^>]*data-id='(\d+)'[^>]*>([\s\S]*?)<\/a><br \/><span class='searchTxt'>([\s\S]*?)<\/span>/gi)].map(([, id, kop, txt]) => {
    const [bron, nr] = inline(kop).split("|").map((x) => x.trim());
    const p = pdf.get(Number(id));
    return { bron, geschilnummer: nr, datum: /searchDate'>([^<]+)/.exec(kop)?.[1], essentie: inline(txt).replace(/^Essentie:\s*/, ""), ...(p ? { pdf: `${RVA_BASE}raad-van-arbitrage-info/_sitefiles/file/${p}` } : {}) };
  });
  return { totaal: data.totalResults ?? items.length, items };
}

// ---------- MfN Tuchtrecht Updates ----------

export const MFN_BASE = "https://www.mfn-tuchtrechtupdates.nl/";
export function parseMfnLijst(html: string) {
  const totaal = /(\d+)\s*resultaten/.exec(inline(html.slice(0, 300_000)))?.[1];
  const items = [...html.matchAll(/<a class="item-link" href="([^"]+)">([\s\S]*?)<\/a>/gi)].map(([, url, inner]) => {
    const soort = inline(/<h4 class="type">([\s\S]*?)<\/h4>/i.exec(inner)?.[1] ?? "");
    const nr = inline(/<p class="date">([\s\S]*?)<\/p>/i.exec(inner)?.[1] ?? "");
    const right = /<div class="right">([\s\S]*)/i.exec(inner)?.[1] ?? "";
    const details = inline(/<div class="details">([\s\S]*?)<\/div>/i.exec(right)?.[1] ?? "");
    return { url, soort, zaaknummer: /^[MB]-\d{4}-\d+$/i.test(nr) ? nr : undefined, titel: inline(/<h3>([\s\S]*?)<\/h3>/i.exec(right)?.[1] ?? ""), fragment: inline(right.replace(/<h3>[\s\S]*?<\/h3>/i, "").replace(/<div class="details">[\s\S]*$/i, "")), instantie: details.split(",")[0]?.trim(), datum: /(\d{2}-\d{2}-\d{4})/.exec(details)?.[1] };
  });
  return { totaal: totaal ? Number(totaal) : items.length, items };
}

// ---------- reading one document ----------

export function documentTekst(html: string): { titel?: string; tekst: string } {
  const titel = inline(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "") || undefined;
  const main = /<main\b[\s\S]*<\/main>/i.exec(html)?.[0] ?? /<article\b[\s\S]*<\/article>/i.exec(html)?.[0] ?? html;
  return { titel, tekst: decodeEntities(htmlNaarTekst(main.replace(/<(nav|header|form|aside)\b[\s\S]*?<\/\1>/gi, " "))) };
}

/** Kifid: datum als .NET-ticks → JJJJ-MM-DD. */
export const kifidDatum = (ticks: unknown): string | undefined => { const n = Number(ticks); return n > 6e17 ? new Date((n - 621355968000000000) / 10000).toISOString().slice(0, 10) : undefined; };

/** Kifid-zoekresultaat → items (nummer, aard, instantie, categorie, samenvatting, links, tekst). */
export function parseKifid(json: unknown) {
  const lijst = ((json as { decision?: { decisionItemsList?: Array<Record<string, unknown>> } })?.decision?.decisionItemsList) ?? [];
  return lijst.map((x) => {
    const titel = String(x.title ?? x.name ?? "").trim();
    const tekst = String(x.pdfContent ?? "");
    return {
      titel, nummer: /(\d{4}-\d{3,4})/.exec(titel)?.[1], instantie: x.authority as string | undefined, categorie: x.category as string | undefined,
      aard: /bindend/i.test(titel) ? "bindend advies" : /niet[- ]bindend/i.test(titel) || /niet-bindend/i.test(tekst.slice(0, 600)) ? "niet-bindend advies" : /Aard uitspraak\s+([A-Za-z -]+?)\s+(?:Uitkomst|Onderwerp)/.exec(tekst)?.[1]?.toLowerCase(),
      uitkomst: /Uitkomst\s+(.+?)\s+(?:Bijlage|1\.\s)/.exec(tekst)?.[1]?.slice(0, 120),
      tegen: x.defendant as string | undefined, datum: kifidDatum(x.date), trefwoorden: String(x.judgementTags ?? "").split(/[;,]/).map((t) => t.trim()).filter(Boolean),
      samenvatting: inline(String(x.summary ?? "")), url: x.url as string | undefined, pdf: x.statementLink as string | undefined, tekst,
    };
  });
}

export function passages(text: string, term: string, max = 25): string[] {
  const lines = text.split("\n"); const t = fold(term); const out: string[] = []; let last = -2;
  lines.forEach((l, i) => { if (out.length >= max || !fold(l).includes(t)) return; const from = Math.max(i - 1, last + 2), to = Math.min(i + 1, lines.length - 1); if (from <= to) out.push(lines.slice(from, to + 1).join("\n")); last = to - 1; });
  return out;
}

const NOTE_ROL = "Gebruik deze bron als vindplaats; laat elke verwijzing die je uiteindelijk gebruikt controleren met de verwijzingscontroleur (verify_legal_reference: bestaan, r.o., citaat en bewering).";

export function registerGeschilbeslechting(server: McpServer, deps: { TOOL_ANNOTATIONS: Record<string, unknown> }, f: Fetcher = httpFetch): void {
  const params = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
  const prov = (tool: string, endpoint: string, p: Record<string, string>, n: number, total: number) => ({ tool, endpoint, query_params: p, timestamp: nowIso(), returned_results: n, total_results: total });

  server.registerTool("raadvanstate_zoeken", {
    description: "Search rulings of the Afdeling bestuursrechtspraak van de Raad van State on raadvanstate.nl, with its own filters: rechtsgebied (e.g. 'Asiel', 'Bouwen', 'Omgevingsrecht'), proceduresoort ('Hoger beroep', 'Uitspraak van de grote kamer', 'Conclusie', 'Overzichtsuitspraak'), type ('Hoofdzaak', 'Voorlopige voorziening', 'Vreemdelingenzaak') and year. Returns zaaknummer, ECLI, date and summary. These rulings are also on rechtspraak.nl: read the text with rechtspraak_get_by_ecli.",
    inputSchema: {
      zoekterm: z.string().max(200).optional(),
      rechtsgebied: z.string().max(80).optional(), proceduresoort: z.string().max(80).optional(), type: z.string().max(40).optional(),
      jaar: z.string().regex(/^\d{4}$/).optional(),
      aantal: z.union([z.literal(10), z.literal(20), z.literal(50)]).default(20), pagina: z.number().int().min(1).max(100).default(1),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    try {
      const u = new URL(RVS_ZOEK);
      u.searchParams.set("zoeken", "true");
      if (a.zoekterm) u.searchParams.set("zoeken_term", a.zoekterm);
      if (a.jaar) { u.searchParams.set("actualiteit", "kalenderjaar"); u.searchParams.set("kalenderjaar", a.jaar); }
      const filters: string[] = [];
      for (const [veld, naam] of [["rechtsgebied", "Rechtsgebied"], ["proceduresoort", "Proceduresoort"], ["type", "Type uitspraak"]] as const) {
        const v = a[veld];
        if (!v) continue;
        const fac = kiesFacet(formFacetten(await formPagina(RVS_ZOEK, f), `Zoe_Selected_facet:${naam}`), v);
        if (!fac) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `${naam} '${v}' onbekend.`, suggestion: `Kies uit: ${formFacetten(await formPagina(RVS_ZOEK, f), `Zoe_Selected_facet:${naam}`).slice(0, 40).map((x) => x.label).join(", ")}` }));
        u.searchParams.append(`Zoe_Selected_facet:${naam}`, fac.value);
        filters.push(`${naam}: ${fac.label}`);
      }
      u.searchParams.set("pager_rows", String(a.aantal));
      if (a.pagina > 1) u.searchParams.set("pager_page", String(a.pagina));
      const r = parseRvsLijst((await f(u.toString())).text);
      const records = r.items.map((i) => rec("raadvanstate.nl", `${i.zaaknummer}${i.ecli ? ` (${i.ecli})` : ""}`, i.url, i.datum, i.samenvatting, { ...i }));
      return toMcpToolPayload(successResponse({ summary: `Raad van State: ${r.totaal} uitspraken${filters.length ? ` (${filters.join("; ")})` : ""}; ${records.length} getoond`, records, provenance: prov("raadvanstate_zoeken", u.toString(), params(a), records.length, r.totaal),
        access_note: `Bron: raadvanstate.nl/uitspraken. Alle uitspraken staan ook op rechtspraak.nl (ECLI:NL:RVS); lees de tekst met rechtspraak_get_by_ecli of lido_relaties. De filters (grote kamer, conclusie staatsraad A-G, overzichtsuitspraak) zijn het voordeel van deze zoekfunctie. ${NOTE_ROL}` }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "Raad van State", RVS_ZOEK)); }
  });

  server.registerTool("crm_oordelen_zoeken", {
    description: "Search oordelen of the College voor de Rechten van de Mens (equal treatment; before 2012 the Commissie Gelijke Behandeling): free text (operators EN/OF/NIET, * and \"…\"~10), year, oordeelnummer ('2026-122'), discriminatiegrond ('geslacht', 'handicap of chronische ziekte', 'leeftijd', 'ras'…), terrein ('Arbeid', 'Goederen en diensten - Onderwijs'…) and outcome ('Verboden onderscheid', 'Geen verboden onderscheid'). Returns number, title, date and link; read with geschil_uitspraak_get.",
    inputSchema: {
      zoekterm: z.string().max(200).optional(), jaar: z.string().regex(/^\d{4}$/).optional(),
      nummer: z.string().regex(/^\d{4}-\d{1,4}$/).optional().describe("Oordeelnummer, bijv. '2026-122'"),
      discriminatiegrond: z.string().max(80).optional(), terrein: z.string().max(80).optional(), uitkomst: z.string().max(60).optional(),
      pagina: z.number().int().min(1).max(200).default(1),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    try {
      const u = new URL(CRM_ZOEK);
      u.searchParams.set("verstuurd", "true");
      if (a.zoekterm) u.searchParams.set("ZoekTerm", a.zoekterm);
      if (a.jaar) u.searchParams.set("Jaar", a.jaar);
      // The site's Nummer field takes only the sequence number; the year goes in Jaar.
      if (a.nummer) { const [j, n] = a.nummer.split("-"); u.searchParams.set("Jaar", j); u.searchParams.set("Nummer", String(Number(n))); }
      for (const [veld, naam] of [["discriminatiegrond", "Discriminatiegronden"], ["terrein", "Terreinen"], ["uitkomst", "Dictum"]] as const) {
        const v = a[veld];
        if (!v) continue;
        const opties = formFacetten(await formPagina(CRM_ZOEK, f), naam);
        const fac = kiesFacet(opties, v);
        if (!fac) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `${veld} '${v}' onbekend.`, suggestion: `Kies uit: ${opties.map((x) => x.label).join(", ")}` }));
        u.searchParams.append(naam, fac.value);
      }
      if (a.pagina > 1) u.searchParams.set("pagina", String(a.pagina));
      const r = parseCrmLijst((await f(u.toString())).text);
      const records = r.items.map((i) => rec("oordelen.mensenrechten.nl", `Oordeel ${i.nummer}: ${i.titel}`, i.url, i.datum, i.fragment, { ...i }));
      return toMcpToolPayload(successResponse({ summary: `College voor de Rechten van de Mens: ${r.totaal} oordelen; ${records.length} getoond (pagina ${a.pagina})`, records, provenance: prov("crm_oordelen_zoeken", u.toString(), params(a), records.length, r.totaal),
        access_note: `Bron: oordelen.mensenrechten.nl. Oordelen zijn niet bindend, maar worden in de rechtspraak zwaar gewogen; ze staan niet op rechtspraak.nl. ${NOTE_ROL}` }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "College voor de Rechten van de Mens", CRM_ZOEK)); }
  });

  server.registerTool("onderwijsgeschillen_zoeken", {
    description: "Search rulings on onderwijsgeschillen.nl (Landelijke Klachtencommissie Onderwijs, Geschillencommissie passend onderwijs, Commissie van beroep funderend onderwijs/mbo/hbo, LBT, medezeggenschap (WMS) and CAO/functiewaardering commissions): free text, commissie, onderwerp ('verwijdering leerling/student', 'passend onderwijs', 'toelating'…) and year. Returns title, number, commissie and link, plus facets for refining.",
    inputSchema: { zoekterm: z.string().max(200).optional(), commissie: z.string().max(120).optional(), onderwerp: z.string().max(120).optional(), jaar: z.string().regex(/^\d{4}$/).optional(), pagina: z.number().int().min(1).max(100).default(1) },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    const endpoint = `https://${ALGOLIA.app}-dsn.algolia.net/1/indexes/${ALGOLIA.index}/query`;
    try {
      const facetFilters: string[][] = [["type.name:Verdicts"]];
      const facetsReq = ["terms.commission_tax.names", "terms.verdict_subject.names", "year"];
      const zoekFacet = async (veld: string, v: string) => {
        const r = await f(endpoint, { method: "POST", headers: { "X-Algolia-Application-Id": ALGOLIA.app, "X-Algolia-API-Key": ALGOLIA.key, "Content-Type": "application/json" }, body: JSON.stringify({ query: "", hitsPerPage: 0, facets: [veld], maxValuesPerFacet: 200, facetFilters: [["type.name:Verdicts"]] }) });
        const namen = Object.keys((JSON.parse(r.text).facets ?? {})[veld] ?? {});
        return kiesFacet(namen.map((n) => ({ value: n, label: n })), v)?.value ?? null;
      };
      if (a.commissie) { const c = await zoekFacet("terms.commission_tax.names", a.commissie); if (!c) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Commissie '${a.commissie}' onbekend.`, suggestion: "Zoek eerst zonder commissie; de facetten tonen de namen." })); facetFilters.push([`terms.commission_tax.names:${c}`]); }
      if (a.onderwerp) { const o = await zoekFacet("terms.verdict_subject.names", a.onderwerp); if (!o) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Onderwerp '${a.onderwerp}' onbekend.`, suggestion: "Zoek eerst zonder onderwerp; de facetten tonen de namen." })); facetFilters.push([`terms.verdict_subject.names:${o}`]); }
      if (a.jaar) facetFilters.push([`year:${a.jaar}`]);
      const r = await f(endpoint, { method: "POST", headers: { "X-Algolia-Application-Id": ALGOLIA.app, "X-Algolia-API-Key": ALGOLIA.key, "Content-Type": "application/json" }, body: JSON.stringify({ query: a.zoekterm ?? "", hitsPerPage: 20, page: a.pagina - 1, facetFilters, facets: facetsReq, attributesToSnippet: ["content:40"], distinct: true }) });
      const d = JSON.parse(r.text) as { nbHits?: number; hits?: Array<Record<string, any>>; facets?: Record<string, Record<string, number>> };
      const records = (d.hits ?? []).map((h) => rec("onderwijsgeschillen.nl", String(h.title ?? ""), String(h.link ?? ""), h.date ? new Date(Number(h.date) * 1000).toISOString().slice(0, 10) : undefined,
        inline(String(h._snippetResult?.content?.value ?? "")), { nummer: h.acf?.pub_number, commissie: h.terms?.commission_tax?.names, onderwerpen: h.terms?.verdict_subject?.names, sector: h.terms?.education_type?.names, jaar: h.year }));
      const facetten = Object.fromEntries(Object.entries(d.facets ?? {}).map(([k, v]) => [k.replace(/^terms\.|\.names$/g, ""), Object.entries(v).sort((x, y) => y[1] - x[1]).slice(0, 25)]));
      return toMcpToolPayload(successResponse({ summary: `Onderwijsgeschillen: ${d.nbHits ?? records.length} uitspraken; ${records.length} getoond (pagina ${a.pagina})`, records, provenance: prov("onderwijsgeschillen_zoeken", endpoint, params(a), records.length, d.nbHits ?? records.length),
        access_note: `Bron: onderwijsgeschillen.nl (zoekfunctie van de site, Algolia). Staat niet op rechtspraak.nl. Facetten: ${JSON.stringify(facetten)}. ${NOTE_ROL}` }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "Onderwijsgeschillen", "https://www.onderwijsgeschillen.nl/uitspraken-zoeken/")); }
  });

  server.registerTool("geschillencommissie_zoeken", {
    description: "Search rulings (bindend advies, arbitraal vonnis) of De Geschillencommissie (consumer and business disputes: Wonen, Reizen, Energie, Kinderopvang, Zorg, Makelaardij, Advocatuur, Notariaat …): free text, commissie and year. Returns title, commissie, category, type, outcome, reference code and link.",
    inputSchema: { zoekterm: z.string().max(200).optional(), commissie: z.string().max(100).optional(), jaar: z.string().regex(/^\d{4}$/).optional(), aantal: z.union([z.literal(10), z.literal(20), z.literal(50)]).default(20), pagina: z.number().int().min(1).max(500).default(1) },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    try {
      const u = new URL(a.pagina > 1 ? `${GC_ZOEK}page/${a.pagina}/` : GC_ZOEK);
      u.searchParams.set("wpas_id", "myform");
      if (a.zoekterm) u.searchParams.set("search_query", a.zoekterm);
      if (a.commissie) {
        const html = await formPagina(GC_ZOEK, f);
        const sel = /<select[^>]*name="tax_category"[\s\S]*?<\/select>/i.exec(html)?.[0] ?? "";
        const opties = [...sel.matchAll(/<option[^>]*value="([^"]+)"[^>]*>([^<]+)/g)].map((m) => ({ value: m[1], label: decodeEntities(m[2]).trim() }));
        const c = kiesFacet(opties, a.commissie);
        if (!c) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Commissie '${a.commissie}' onbekend.`, suggestion: `Kies uit: ${opties.map((o) => o.label).join(", ")}` }));
        u.searchParams.set("tax_category", c.value);
      }
      if (a.jaar) u.searchParams.set("tax_uitspraak_jaartal", a.jaar);
      u.searchParams.set("posts_per_page", String(a.aantal));
      u.searchParams.set("wpas_submit", "1");
      const r = parseGcLijst((await f(u.toString())).text);
      const records = r.items.map((i) => rec("degeschillencommissie.nl", i.titel, i.url, i.jaar, i.fragment, { ...i }));
      return toMcpToolPayload(successResponse({ summary: `De Geschillencommissie: ${r.totaal} uitspraken; ${records.length} getoond (pagina ${a.pagina})`, records, provenance: prov("geschillencommissie_zoeken", u.toString(), params(a), records.length, r.totaal),
        access_note: `Bron: degeschillencommissie.nl. Bindend advies (art. 7:900 BW) of arbitraal vonnis; staat niet op rechtspraak.nl. ${NOTE_ROL}` }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "De Geschillencommissie", GC_ZOEK)); }
  });

  server.registerTool("raad_van_arbitrage_zoeken", {
    description: "Search arbitral awards of the Raad van Arbitrage in bouwgeschillen (an arbitration institute for construction disputes, not a court), incl. appeal, guarantee schemes (Woningborg, GIW, AIG), AIBK, metaal and KIVI: free text (or a geschilnummer), source and year. Returns source, geschilnummer, date, essentie and PDF link. Almost none of these awards are on rechtspraak.nl.",
    inputSchema: { zoekterm: z.string().min(2).max(200), bron: z.string().max(40).optional().describe(`One of: ${Object.keys(RVA_BRONNEN).join(", ")}.`), jaar: z.string().regex(/^\d{4}$/).optional(), max: z.number().int().min(1).max(100).default(25), start: z.number().int().min(0).max(1500).default(0) },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    try {
      const bron = a.bron ? RVA_BRONNEN[fold(a.bron)] ?? Object.entries(RVA_BRONNEN).find(([k]) => k.includes(fold(a.bron!)))?.[1] : "0";
      if (bron === undefined) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Bron '${a.bron}' onbekend.`, suggestion: `Kies uit: ${Object.keys(RVA_BRONNEN).join(", ")}.` }));
      const first = await f(RVA_BASE);
      const body = new URLSearchParams({ q: a.zoekterm, cof: "FORID:9", qSort: bron, jaar: a.jaar ?? "0", fileDate: "", send: "Zoeken", ...(/^\d{1,3}\.?\d{3}$/.test(a.zoekterm.trim()) ? { byNr: "on" } : {}) }).toString();
      const res = await f(RVA_BASE, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: RVA_BASE, Origin: RVA_BASE.replace(/\/$/, ""), Cookie: first.cookies.map((c) => c.split(";")[0]).join("; ") } });
      const r = parseRvaLijst(res.text);
      const items = r.items.slice(a.start, a.start + a.max);
      const records = items.map((i) => rec("raadvanarbitrage.info", `${i.bron ?? "RvA"} ${i.geschilnummer ?? ""}`.trim(), i.pdf ?? RVA_BASE, i.datum, i.essentie, { ...i }));
      return toMcpToolPayload(successResponse({ summary: `Raad van Arbitrage in bouwgeschillen: ${r.totaal} treffers; ${records.length} getoond vanaf ${a.start}`, records, provenance: prov("raad_van_arbitrage_zoeken", RVA_BASE, params(a), records.length, r.totaal),
        access_note: `Bron: raadvanarbitrage.info (alle vonnissen geanonimiseerd). Arbitrage: scheidsrechterlijke vonnissen, geen rechtspraak; gezaghebbend voor de bouwpraktijk (UAV, UAV-GC). Lees met geschil_uitspraak_get (PDF). ${NOTE_ROL}` }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "Raad van Arbitrage", RVA_BASE)); }
  });

  server.registerTool("mfn_tuchtrecht_zoeken", {
    description: "Search MfN-register Tuchtrecht Updates (mfn-tuchtrechtupdates.nl): disciplinary rulings on mediators (Tuchtcommissie, College van Beroep) and annotations. Free text, type (uitspraak/annotatie) and page. Returns zaaknummer (M-/B-JJJJ-N), title, instantie, date and link.",
    inputSchema: { zoekterm: z.string().max(200).optional(), soort: z.enum(["uitspraak", "annotatie", "beide"]).default("beide"), pagina: z.number().int().min(1).max(50).default(1) },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    try {
      const u = new URL(MFN_BASE);
      if (a.zoekterm) u.searchParams.set("query", a.zoekterm);
      if (a.soort !== "beide") u.searchParams.append("types[]", a.soort === "uitspraak" ? "summary" : "annotation");
      if (a.pagina > 1) u.searchParams.set("page", String(a.pagina));
      const r = parseMfnLijst((await f(u.toString())).text);
      const records = r.items.map((i) => rec("mfn-tuchtrechtupdates.nl", `${i.soort}${i.zaaknummer ? ` ${i.zaaknummer}` : ""}: ${i.titel}`, i.url, i.datum, i.fragment, { ...i }));
      return toMcpToolPayload(successResponse({ summary: `MfN Tuchtrecht Updates: ${r.totaal} resultaten; ${records.length} getoond (pagina ${a.pagina})`, records, provenance: prov("mfn_tuchtrecht_zoeken", u.toString(), params(a), records.length, r.totaal),
        access_note: `Bron: MfN-register Tuchtrecht Updates. Uitspraken van de Tuchtcommissie (M-…) en het College van Beroep (B-…) over MfN-registermediators, met annotaties. ${NOTE_ROL}` }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "MfN Tuchtrecht Updates", MFN_BASE)); }
  });

  server.registerTool("kifid_zoeken", {
    description: "Search rulings of Kifid (Klachteninstituut Financiële Dienstverlening): the Geschillencommissie and the Commissie van Beroep, on complaints about banks, insurers, mortgages, investments, BKR registrations and debt collection. Free text or a ruling number ('2026-1003'), category (Bank, Beleggen, Hypotheek, Verzekeringen, BKR, Kleinzakelijk, Incassodienstverlening), instance and page. Returns number, binding or non-binding, outcome, financial institution, date, summary, PDF and (with tekst=true) the full text or the passages with the search term. Not on rechtspraak.nl.",
    inputSchema: {
      zoekterm: z.string().max(200).optional(), categorie: z.enum(["Bank", "Beleggen", "Hypotheek", "Verzekeringen", "BKR", "Kleinzakelijk", "Incassodienstverlening", "Anders"]).optional(),
      instantie: z.enum(["Geschillencommissie", "Commissie van Beroep"]).optional(), sortering: z.enum(["nieuwste", "relevantie"]).default("nieuwste"),
      pagina: z.number().int().min(1).max(500).default(1), aantal: z.number().int().min(1).max(25).default(10),
      tekst: z.boolean().default(false), max_chars: z.number().int().min(1000).max(60_000).default(8_000),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    const u = new URL(KIFID_API);
    for (const [k, v] of Object.entries({ searchTerm: a.zoekterm ?? "", category: a.categorie ?? "", authority: a.instantie ?? "", targetGroup: "", startDate: "0", endDate: "0", page: String(a.pagina), pageSize: String(a.aantal) })) u.searchParams.set(k, v);
    if (a.sortering === "nieuwste") u.searchParams.set("sort", "newest");
    try {
      const r = await f(u.toString(), { headers: { Accept: "application/json" } });
      const items = parseKifid(JSON.parse(r.text));
      const records = items.map(({ tekst, ...i }) => {
        const body = a.tekst ? (a.zoekterm && !/^\d{4}-\d{3,4}$/.test(a.zoekterm.trim()) ? passages(tekst.replace(/\s(?=\d{1,2}\.\d{1,2}\s)/g, "\n"), a.zoekterm).join("\n…\n") || tekst : tekst) : undefined;
        return rec("kifid.nl", `Kifid ${i.instantie ?? ""} ${i.nummer ?? i.titel}`.replace(/\s+/g, " ").trim(), i.url ?? i.pdf ?? KIFID_API, i.datum, i.samenvatting, { ...i, ...(body !== undefined ? { tekst: body.length > a.max_chars ? `${body.slice(0, a.max_chars)}…` : body } : {}) });
      });
      return toMcpToolPayload(successResponse({ summary: `Kifid: ${records.length} uitspraken (pagina ${a.pagina})`, records, provenance: prov("kifid_zoeken", u.toString(), params(a), records.length, records.length),
        access_note: `Bron: kifid.nl. De Geschillencommissie geeft een bindend of niet-bindend advies (geen rechtspraak); de Commissie van Beroep oordeelt in hoger beroep. Volledige tekst met tekst=true, of de PDF met geschil_uitspraak_get. ${NOTE_ROL}` }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "Kifid", KIFID_API)); }
  });

  server.registerTool("geschil_uitspraak_get", {
    description: "Read one ruling from these sites: oordelen.mensenrechten.nl, onderwijsgeschillen.nl, degeschillencommissie.nl, raadvanarbitrage.info (PDF), mfn-tuchtrechtupdates.nl (incl. the source PDF), kifid.nl (PDF). Returns the text, optionally only the passages with a search term. For Raad van State use rechtspraak_get_by_ecli.",
    inputSchema: { url: z.string().url().max(600), zoekterm: z.string().max(120).optional(), max_chars: z.number().int().min(1000).max(100_000).default(20_000) },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async ({ url, zoekterm, max_chars }) => {
    const host = new URL(url).hostname;
    if (!GESCHIL_HOSTS.includes(host) || new URL(url).protocol !== "https:") return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Alleen links van ${GESCHIL_HOSTS.join(", ")}.`, suggestion: "Gebruik een link uit de zoektools." }));
    if (host === "www.raadvanstate.nl") return toMcpToolPayload(errorResponse({ error: "unexpected", message: "Lees Raad van State-uitspraken via rechtspraak.nl.", suggestion: "rechtspraak_get_by_ecli met de ECLI uit raadvanstate_zoeken." }));
    try {
      let titel: string | undefined, tekst: string, bronUrl = url;
      if (/\.pdf($|\?)/i.test(url)) {
        const pdf = await fetchPdfText(url, { connector: "geschillen", timeoutMs: 60_000, retries: 1, maxChars: 400_000, headers: { "User-Agent": UA } });
        if (!pdf.ok) throw new Error(pdf.message);
        tekst = pdf.text;
      } else {
        const html = (await f(url)).text;
        const d = documentTekst(html);
        titel = d.titel; tekst = d.tekst;
        const mfnPdf = host === "www.mfn-tuchtrechtupdates.nl" ? /href="(\/uploads\/summary\/case_law_document\/[^"]+\.pdf)"/i.exec(html)?.[1] : undefined;
        if (mfnPdf) {
          bronUrl = new URL(mfnPdf, url).toString();
          const pdf = await fetchPdfText(bronUrl, { connector: "geschillen", timeoutMs: 60_000, retries: 1, maxChars: 400_000, headers: { "User-Agent": UA } });
          if (pdf.ok) tekst = `${tekst}\n\n— Volledige uitspraak (bron-PDF) —\n${pdf.text}`;
        }
      }
      const body = zoekterm ? passages(tekst, zoekterm).join("\n…\n") : tekst;
      const out = body.length > max_chars ? `${body.slice(0, max_chars)}…` : body;
      return toMcpToolPayload(successResponse({ summary: `${titel ?? url}: ${tekst.length} tekens${zoekterm ? `; passages met '${zoekterm}'` : ""}`, records: [rec(host, titel ?? url, url, undefined, undefined, { tekst: out, ingekort: body.length > max_chars, ...(bronUrl !== url ? { bron_pdf: bronUrl } : {}) })],
        provenance: prov("geschil_uitspraak_get", url, params({ url, zoekterm }), 1, 1), access_note: NOTE_ROL }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, host, url)); }
  });
}
