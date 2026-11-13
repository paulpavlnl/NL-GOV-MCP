/**
 * FORK (docs/FORK.md): cao's uit de databank van de directie Cao van het ministerie van
 * SZW (cao.minszw.nl, Mozard), plus de besluiten tot algemeenverbindendverklaring (AVV)
 * uit de Staatscourant.
 *
 * - Zoeken: het zoekformulier van de databank (POST naar !suite16.scherm1168 met csrf-token)
 *   geeft een selectie; die wordt doorgebladerd met getObjectbakResultaat (mMaxid) en de
 *   namen komen uit getObjectRegels. De lijst zonder zoekwoord heeft een plafond (±700-1000
 *   regels), dus altijd met zoekwoord.
 * - Een cao is een object (!suite92.scherm1007?mObj=<n>) met kenmerken in <dl class="moz-dl">
 *   en een dossier met pdf's (document/docnr/...), die naar een kortlevende S3-link verwijzen.
 * - Tekst: de pdf via unpdf naar tekst per pagina (24 uur in het geheugen).
 * - AVV: Staatscourant via BekendmakingenSource (zelfde bron als officiele_bekendmakingen_search).
 * Mozard werkt met een sessiecookie; die wordt hier zelf bijgehouden.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, MCPRecord, ToolResult } from "../types.js";
import { errorResponse, successResponse, toMcpToolPayload } from "../utils/response.js";
import { BekendmakingenSource } from "../sources/bekendmakingen.js";

const BASIS = "https://cao.minszw.nl/mozard/";
const ALLE = "654165"; // selectie "alle aangemelde cao's, sociale fondscao's en sociale plannen"
const TIMEOUT = 30_000;

// ---------- sessie ----------

class MozardSessie {
  private cookie = "";
  async req(pad: string, init: RequestInit = {}, diepte = 0): Promise<{ url: string; text: string; status: number }> {
    const url = pad.startsWith("http") ? pad : BASIS + pad;
    const r = await fetch(url, { redirect: "manual", ...init, headers: { ...(init.headers as Record<string, string> ?? {}), ...(this.cookie ? { cookie: this.cookie } : {}) }, signal: AbortSignal.timeout(TIMEOUT) });
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const kv = c.split(";")[0];
      const k = kv.split("=")[0];
      this.cookie = [...this.cookie.split("; ").filter((x) => x && !x.startsWith(`${k}=`)), kv].join("; ");
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get("location") && diepte < 6) return this.req(new URL(r.headers.get("location")!, url).toString(), {}, diepte + 1);
    if (r.status >= 400) throw Object.assign(new Error(`cao.minszw.nl HTTP ${r.status}`), { status: r.status });
    return { url: r.url || url, text: await r.text(), status: r.status };
  }
  /** Volgt de redirect van een document naar S3 en geeft de bytes. */
  async pdf(pad: string): Promise<Uint8Array> {
    const eerst = await fetch(BASIS + pad, { redirect: "manual", headers: this.cookie ? { cookie: this.cookie } : {}, signal: AbortSignal.timeout(TIMEOUT) });
    const doel = eerst.status >= 300 && eerst.status < 400 ? new URL(eerst.headers.get("location")!, BASIS + pad).toString() : undefined;
    const r = doel ? await fetch(doel, { signal: AbortSignal.timeout(90_000) }) : eerst;
    if (!r.ok) throw Object.assign(new Error(`cao-pdf HTTP ${r.status}`), { status: r.status });
    return new Uint8Array(await r.arrayBuffer());
  }
}

// ---------- ontleden ----------

const html = (s: string) => s.replace(/&#40;/g, "(").replace(/&#41;/g, ")").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

export interface CaoRegel {
  obj: string;
  naamVolledig: string;
  nummer?: string;
  naam: string;
  ingang?: string; // JJJJ-MM-DD
  expiratie?: string;
  type?: string; // Regulier, Sociaal Fonds, Sociaal plan, ...
  kvo?: string; // datum formele kennisgeving van ontvangst
  wijziging: boolean; // TTW = tussentijdse wijziging
  extra?: string;
}

const iso = (d?: string) => (d && /^\d{2}-\d{2}-\d{4}$/.test(d) ? `${d.slice(6)}-${d.slice(3, 5)}-${d.slice(0, 2)}` : undefined);

/** "689 - METALEKTRO ... - 01-01-2026 - 31-12-2026 - Sociaal Fonds - kvo datum - 09-04-2026 - TTW ..." */
export function parseCaoNaam(obj: string, volledig: string): CaoRegel {
  const m = /^(\d+)\s+-\s+(.*?)\s+-\s+(\d{2}-\d{2}-\d{4})\s+-\s+(\d{2}-\d{2}-\d{4})\s+-\s+(.*?)\s+-\s+kvo datum(?:\s+-\s+(\d{2}-\d{2}-\d{4}))?(?:\s+-\s+(.*))?$/.exec(volledig.trim());
  if (!m) return { obj, naamVolledig: volledig, naam: volledig, wijziging: /\bTTW\b/.test(volledig) };
  const extra = m[7]?.trim();
  return { obj, naamVolledig: volledig, nummer: m[1], naam: m[2], ingang: iso(m[3]), expiratie: iso(m[4]), type: m[5], kvo: iso(m[6]), wijziging: /\bTTW\b/.test(extra ?? ""), extra: extra?.replace(/\bTTW\b/, "").trim() || undefined };
}

const veld = (h: string, naam: string) => new RegExp(`name="${naam}"[^>]*value="([^"]*)"|value="([^"]*)"[^>]*name="${naam}"`).exec(h)?.slice(1).find((x) => x !== undefined) ?? "";

export function parseKenmerken(h: string): Record<string, string> {
  const uit: Record<string, string> = {};
  for (const m of h.matchAll(/<dt class="prompttekst">([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    const k = html(m[1].replace(/<[^>]+>/g, "")).trim();
    const v = html(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (k && !(k in uit)) uit[k] = v;
  }
  return uit;
}

export function parseDocumenten(h: string): Array<{ pad: string; naam: string }> {
  const gezien = new Set<string>();
  const uit: Array<{ pad: string; naam: string }> = [];
  for (const m of h.matchAll(/href="((?:\/mozard\/)?document\/docnr\/[^"]+)"/g)) {
    const pad = html(m[1]).replace(/^\/mozard\//, "");
    if (gezien.has(pad)) continue;
    gezien.add(pad);
    uit.push({ pad, naam: decodeURIComponent(pad.split("/").pop() ?? pad) });
  }
  return uit;
}

// ---------- databank ----------

const cacheZoek = new Map<string, { t: number; regels: CaoRegel[] }>();
const cacheTekst = new Map<string, { t: number; paginas: string[]; bron: string }>();

export async function zoekCaos(woord: string, max = 300): Promise<CaoRegel[]> {
  const sleutel = woord.trim().toLowerCase();
  const c = cacheZoek.get(sleutel);
  if (c && Date.now() - c.t < 6 * 3600_000) return c.regels;
  const s = new MozardSessie();
  const start = await s.req(`!suite16.scherm1168?mSelod=${ALLE}`);
  const i = start.text.indexOf("!suite16.scherm1168");
  const deel = i >= 0 ? start.text.slice(i) : start.text;
  const body = new URLSearchParams({ mBpk: veld(deel, "mBpk"), mCsrfToken: veld(deel, "mCsrfToken"), mEditModalOpties: "", mGmr: veld(deel, "mGmr"), mSelod: veld(deel, "mSelod"), mZoe: woord.trim() });
  if (!body.get("mCsrfToken")) throw new Error("cao.minszw.nl: zoekformulier niet gevonden (opbouw gewijzigd?)");
  const na = await s.req("!suite16.scherm1168", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  const sel = /mSelod=(\d+)/.exec(na.url)?.[1] ?? /mSelod=(\d+)/.exec(na.text)?.[1];
  if (!sel) throw new Error("cao.minszw.nl: geen zoekresultaat (selectie) terug");
  const objs: string[] = [];
  let maxid = 0;
  for (let i2 = 0; i2 < 100 && objs.length < max; i2++) {
    const j = JSON.parse((await s.req(`!suite16.getObjectbakResultaat?mSelod=${sel}&mMaxid=${maxid}`)).text) as { r: Array<{ obj: number; id: number }>; erismeer: number };
    objs.push(...j.r.map((x) => String(x.obj)));
    if (!j.erismeer || !j.r.length) break;
    maxid = j.r[j.r.length - 1].id;
  }
  const regels: CaoRegel[] = [];
  for (let i3 = 0; i3 < objs.length; i3 += 100) {
    const t = (await s.req(`!suite16.getObjectRegels?mObjecten=,${objs.slice(i3, i3 + 100).join(",")}&mSelod=${sel}`)).text;
    for (const m of t.matchAll(/mObj=(\d+)[\s\S]*?<h3>(.*?)<\\\/h3>/g)) regels.push(parseCaoNaam(m[1], html(m[2])));
  }
  cacheZoek.set(sleutel, { t: Date.now(), regels });
  return regels;
}

export async function caoDetail(obj: string): Promise<{ kenmerken: Record<string, string>; documenten: Array<{ pad: string; naam: string }>; sessie: MozardSessie }> {
  const s = new MozardSessie();
  const p = await s.req(`!suite92.scherm1007?mObj=${encodeURIComponent(obj)}`);
  const kenmerken = parseKenmerken(p.text);
  if (!kenmerken.Naam) throw Object.assign(new Error(`geen cao met id ${obj} in de databank`), { status: 404 });
  return { kenmerken, documenten: parseDocumenten(p.text), sessie: s };
}

async function caoPaginas(obj: string, documentNr?: number): Promise<{ paginas: string[]; bron: string; documenten: Array<{ pad: string; naam: string }>; kenmerken: Record<string, string> }> {
  const d = await caoDetail(obj);
  if (!d.documenten.length) throw Object.assign(new Error("bij deze cao staat geen tekst (pdf) in de databank"), { status: 404 });
  const doc = d.documenten[Math.min(Math.max(0, (documentNr ?? 1) - 1), d.documenten.length - 1)];
  const sleutel = `${obj}|${doc.pad}`;
  const c = cacheTekst.get(sleutel);
  if (c && Date.now() - c.t < 24 * 3600_000) return { paginas: c.paginas, bron: c.bron, documenten: d.documenten, kenmerken: d.kenmerken };
  const bytes = await d.sessie.pdf(doc.pad);
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const paginas = (text as string[]).map((p) => p.replace(/[ \t]+\n/g, "\n"));
  if (cacheTekst.size > 30) cacheTekst.delete(cacheTekst.keys().next().value!);
  cacheTekst.set(sleutel, { t: Date.now(), paginas, bron: doc.naam });
  return { paginas, bron: doc.naam, documenten: d.documenten, kenmerken: d.kenmerken };
}

/** Het artikel ("12", "3.4", "12a") als tekst: van de kop tot de volgende artikelkop. */
export function zoekArtikel(paginas: string[], artikel: string): Array<{ pagina: number; tekst: string }> {
  const a = artikel.trim().replace(/^art(?:ikel)?\.?\s*/i, "").replace(/\./g, "\\.");
  // Twee nummeringen: "Artikel 12" / "Art. 3.4", en kopjes als "1.5 Volledige arbeidsduur"
  // (dan het nummer aan het begin van een regel, gevolgd door een woord met hoofdletter).
  const koppen = [
    { kop: new RegExp(`(^|\\n)\\s*(?:Artikel|Art\\.)\\s+${a}(?![\\d.a-z])[^\\n]*`, "i"), volgende: /\n\s*(?:Artikel|Art\.)\s+\d+[a-z]?(?:\.\d+)?\b/i },
    // Volgende kop: een ander nummer (geen subkopje als 1.5.1 onder 1.5) of een Artikel/Hoofdstuk.
    { kop: new RegExp(`(^|\\n)\\s*${a}\\.?\\s+[A-Z][^\\n]{2,}`), volgende: new RegExp(`\\n\\s*(?!${a}\\.)\\d+(?:\\.\\d+)*\\.?\\s+[A-Z][^\\n]{2,}|\\n\\s*(?:Artikel|Hoofdstuk)\\s+\\d+`) },
  ];
  for (const { kop, volgende: volgendeKop } of koppen) {
    const uit: Array<{ pagina: number; tekst: string }> = [];
    for (let p = 0; p < paginas.length && uit.length < 3; p++) {
      const m = kop.exec(paginas[p]);
      if (!m) continue;
      const rest = paginas[p].slice(m.index) + "\n" + (paginas[p + 1] ?? "") + "\n" + (paginas[p + 2] ?? "");
      const volgende = rest.slice(m[0].length).search(volgendeKop);
      const tekst = (volgende >= 0 ? rest.slice(0, m[0].length + volgende) : rest.slice(0, 6000)).trim();
      // Inhoudsopgave overslaan: een kop met puntjes of alleen een paginanummer erachter.
      if (/\.{4,}|…{2,}/.test(m[0]) || (tekst.length < 120 && /\s\d+\s*$/.test(tekst))) continue;
      uit.push({ pagina: p + 1, tekst: tekst.slice(0, 8000) });
    }
    if (uit.length) return uit;
  }
  return [];
}

export function zoekPassages(paginas: string[], term: string, max = 10): Array<{ pagina: number; tekst: string }> {
  const t = term.trim().toLowerCase();
  const uit: Array<{ pagina: number; tekst: string }> = [];
  for (let p = 0; p < paginas.length && uit.length < max; p++) {
    const laag = paginas[p].toLowerCase();
    let i = laag.indexOf(t);
    while (i >= 0 && uit.length < max) {
      uit.push({ pagina: p + 1, tekst: paginas[p].slice(Math.max(0, i - 500), i + t.length + 700).trim() });
      i = laag.indexOf(t, i + t.length + 700);
    }
  }
  return uit;
}

// ---------- tools ----------

const detailUrl = (obj: string) => `${BASIS}!suite92.scherm1007?mObj=${obj}`;
const NOTE = "Bron: de cao-databank van de directie Cao van het ministerie van SZW (cao.minszw.nl): cao's, sociale-fondscao's en sociale plannen zoals ze bij SZW zijn aangemeld, met hun tekst (pdf). Een cao die nooit is aangemeld staat er niet in. 'wijziging' (TTW) = tussentijdse wijziging; kvo = datum formele kennisgeving van ontvangst. Algemeenverbindendverklaring: cao_avv.";

function fout(e: unknown): ToolResult {
  const st = (e as { status?: number }).status;
  const msg = e instanceof Error ? e.message : String(e);
  if (st === 404) return errorResponse({ error: "unexpected", message: msg, suggestion: "Zoek eerst met cao_zoeken en gebruik het id daaruit." });
  return errorResponse({ error: /timeout|abort/i.test(msg) ? "timeout" : "http_error", message: msg, retry_after: 30 });
}

export function registerCao(server: McpServer, deps: { config: AppConfig; TOOL_ANNOTATIONS: Record<string, unknown> }): void {
  const bekend = new BekendmakingenSource(deps.config);

  server.registerTool("cao_zoeken", {
    description: "Search Dutch collective labour agreements (cao's), sociale-fondscao's and sociale plannen in the SZW cao database (cao.minszw.nl, directie Cao): by name or keyword ('metalektro', 'ziekenhuizen', 'kinderopvang', 'uitzend'), optionally valid on a date and by kind. Each result: cao number, name, period (ingang/expiratie), type, whether it is a tussentijdse wijziging, and an id for cao_tekst (the full text) and cao_avv (algemeenverbindendverklaring).",
    inputSchema: {
      zoekterm: z.string().min(2).describe("Naam of trefwoord van de cao, bijv. 'metalektro', 'ziekenhuizen', 'gemeenten'."),
      geldig_op: z.string().optional().describe("JJJJ-MM-DD: alleen cao's waarvan de looptijd deze dag omvat."),
      type: z.enum(["alle", "regulier", "sociaal fonds", "sociaal plan"]).default("alle"),
      zonder_wijzigingen: z.boolean().default(false).describe("Tussentijdse wijzigingen (TTW) weglaten."),
      top: z.number().int().min(1).max(100).default(25),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async ({ zoekterm, geldig_op, type, zonder_wijzigingen, top }) => {
    try {
      let regels = await zoekCaos(zoekterm);
      const totaal = regels.length;
      if (geldig_op) regels = regels.filter((r) => (!r.ingang || r.ingang <= geldig_op) && (!r.expiratie || r.expiratie >= geldig_op));
      if (type !== "alle") regels = regels.filter((r) => (r.type ?? "").toLowerCase().includes(type));
      if (zonder_wijzigingen) regels = regels.filter((r) => !r.wijziging);
      regels = [...regels].sort((a, b) => (b.ingang ?? "").localeCompare(a.ingang ?? "") || (b.kvo ?? "").localeCompare(a.kvo ?? ""));
      const records: MCPRecord[] = regels.slice(0, top).map((r) => ({
        title: r.naamVolledig,
        date: r.ingang,
        source_name: "cao_minszw",
        canonical_url: detailUrl(r.obj),
        data: { id: r.obj, nummer: r.nummer, naam: r.naam, ingang: r.ingang, expiratie: r.expiratie, type: r.type, kvo_datum: r.kvo, tussentijdse_wijziging: r.wijziging, opmerking: r.extra },
      }));
      return toMcpToolPayload(successResponse({
        summary: `${regels.length} cao-regels voor '${zoekterm}'${geldig_op ? ` geldig op ${geldig_op}` : ""} (van ${totaal} treffers in de databank)${records.length < regels.length ? `, ${records.length} getoond` : ""}.`,
        records,
        provenance: { tool: "cao_zoeken", endpoint: `${BASIS}!suite16.scherm1168`, query_params: { zoekterm, ...(geldig_op ? { geldig_op } : {}) }, timestamp: new Date().toISOString(), returned_results: records.length, total_results: regels.length },
        access_note: `${NOTE} Nieuwste looptijd eerst. Tekst: cao_tekst met id.`,
      }));
    } catch (e) {
      return toMcpToolPayload(fout(e));
    }
  });

  server.registerTool("cao_tekst", {
    description: "Read a Dutch cao from the SZW cao database by its id from cao_zoeken: the characteristics (number, period, kind, SBI code) and the text of its pdf. With artikel: that article (e.g. '12', '3.4'); with zoekterm: the passages containing it, with page numbers; else pages van..tot (default the first 3) and the page count.",
    inputSchema: {
      id: z.string().describe("Id uit cao_zoeken (data.id)."),
      artikel: z.string().optional().describe("Artikelnummer zoals de cao het nummert: 'Artikel 12' -> '12', of kopjes als '1.7.2' (veel cao's nummeren zo; 'Artikel 12' staat dan vaak alleen in een reglement achterin)."),
      zoekterm: z.string().optional().describe("Woord of woordgroep, bijv. 'ploegentoeslag', 'transitievergoeding'."),
      pagina_van: z.number().int().min(1).optional(),
      pagina_tot: z.number().int().min(1).optional(),
      document: z.number().int().min(1).default(1).describe("Welk document uit het dossier als er meer zijn (1 = eerste)."),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async ({ id, artikel, zoekterm, pagina_van, pagina_tot, document }) => {
    try {
      const { paginas, bron, documenten, kenmerken } = await caoPaginas(id, document);
      let delen: Array<{ pagina: number; tekst: string }>;
      let wat: string;
      if (artikel) { delen = zoekArtikel(paginas, artikel); wat = `artikel ${artikel}`; }
      else if (zoekterm) { delen = zoekPassages(paginas, zoekterm); wat = `'${zoekterm}'`; }
      else {
        const van = pagina_van ?? 1;
        const tot = Math.min(paginas.length, pagina_tot ?? van + 2, van + 9);
        delen = paginas.slice(van - 1, tot).map((t, i) => ({ pagina: van + i, tekst: t }));
        wat = `pagina ${van}-${tot}`;
      }
      const records: MCPRecord[] = delen.map((d) => ({ title: `${kenmerken.Naam ?? id} · p. ${d.pagina}`, source_name: "cao_minszw", canonical_url: detailUrl(id), data: { pagina: d.pagina, tekst: d.tekst } }));
      return toMcpToolPayload(successResponse({
        summary: delen.length ? `${kenmerken.Naam}: ${wat}, ${delen.length} ${delen.length === 1 ? "deel" : "delen"} (document '${bron}', ${paginas.length} pagina's).` : `${kenmerken.Naam}: ${wat} niet gevonden in '${bron}' (${paginas.length} pagina's).`,
        records: [{ title: kenmerken.Naam ?? id, source_name: "cao_minszw", canonical_url: detailUrl(id), data: { id, kenmerken, documenten: documenten.map((d, i) => ({ nr: i + 1, naam: d.naam })), paginas: paginas.length } }, ...records],
        provenance: { tool: "cao_tekst", endpoint: detailUrl(id), query_params: { id, ...(artikel ? { artikel } : {}), ...(zoekterm ? { zoekterm } : {}) }, timestamp: new Date().toISOString(), returned_results: records.length },
        access_note: `${NOTE} Tekst uit de pdf zoals bij SZW aangemeld; paginanummers zijn die van de pdf. Citeer met de link naar de databank. ${delen.length || artikel === undefined ? "" : "Artikel niet gevonden: probeer zoekterm met een woord uit het artikel."}`.trim(),
      }));
    } catch (e) {
      return toMcpToolPayload(fout(e));
    }
  });

  server.registerTool("cao_avv", {
    description: "Algemeenverbindendverklaring (AVV) of a Dutch cao: the decisions of the Minister of SZW in the Staatscourant (besluit tot algemeenverbindendverklaring, wijziging, intrekking, verzoek/tervisielegging), newest first. Give the cao name or the id from cao_zoeken.",
    inputSchema: {
      naam: z.string().optional().describe("Naam van de cao, bijv. 'Metalektro', 'Bouw en Infra'."),
      id: z.string().optional().describe("Id uit cao_zoeken; de naam wordt dan uit de databank gehaald."),
      top: z.number().int().min(1).max(50).default(10),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async ({ naam, id, top }) => {
    try {
      let n = naam?.trim();
      if (!n && id) n = parseCaoNaam(id, (await caoDetail(id)).kenmerken.Naam ?? "").naam;
      if (!n) return toMcpToolPayload(errorResponse({ error: "unexpected", message: "naam of id ontbreekt" }));
      const kern = n.replace(/\(CAO\)|\bCAO\b|collectieve arbeidsovereenkomst/gi, "").replace(/\s+/g, " ").trim();
      // Alleen de dragende woorden: geen afkortingen tussen haakjes, geen lidwoorden of voorzetsels.
      const STOP = new Set(["voor", "het", "van", "de", "den", "der", "een", "en", "in", "inzake", "op", "met", "bij", "cao"]);
      const woorden = kern.replace(/\([^)]*\)/g, " ").toLowerCase().split(/[^a-z0-9à-ÿ-]+/).filter((w) => w.length > 2 && !STOP.has(w));
      const out = await bekend.search({ query: `algemeenverbindendverklaring ${woorden.join(" ") || kern}`, maximumRecords: 50, publicatieblad: "Staatscourant", sort: "date_newest" });
      const items = (out.items as Array<Record<string, unknown>>).filter((i) => /verbindend/i.test(String(i.title ?? ""))).filter((i) => woorden.every((w) => String(i.title ?? "").toLowerCase().includes(w)) || woorden.length === 0);
      const soort = (t: string) => (/intrekking/i.test(t) ? "intrekking" : /wijziging/i.test(t) ? "wijziging" : /verzoek|ter inzage|tervisie/i.test(t) ? "verzoek (ter visie)" : /besluit/i.test(t) ? "besluit tot AVV" : "overig");
      const records: MCPRecord[] = items.slice(0, top).map((i) => ({ title: String(i.title ?? ""), date: String(i.date ?? ""), source_name: "officielebekendmakingen", canonical_url: String(i.canonical_url ?? ""), data: { soort: soort(String(i.title ?? "")), vindplaats: i.vindplaats, identifier: i.identifier, pdf: i.pdf_url } }));
      return toMcpToolPayload(successResponse({
        summary: records.length ? `${records.length} AVV-publicaties in de Staatscourant voor '${kern}' (nieuwste eerst).` : `Geen AVV-publicatie in de Staatscourant gevonden voor '${kern}'.`,
        records,
        provenance: { tool: "cao_avv", endpoint: "Staatscourant (officielebekendmakingen.nl, SRU)", query_params: { query: `algemeenverbindendverklaring ${kern}` }, timestamp: new Date().toISOString(), returned_results: records.length },
        access_note: "Alleen publicaties met de cao-naam in de titel. Geen treffer betekent niet zeker dat de cao niet algemeen verbindend is: zoek dan breder met officiele_bekendmakingen_search (publicatieblad Staatscourant). Een AVV geldt voor de periode in het besluit, niet voor de hele looptijd van de cao.",
      }));
    } catch (e) {
      return toMcpToolPayload(fout(e));
    }
  });
}
