/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. The Woo-index (Wet open overheid, art. 3.3):
 * per government body the places where it publishes each information category, as kept in
 * the Register van Overheidsorganisaties (organisaties.overheid.nl/woo, linked from
 * open.overheid.nl/verwijzingen). Many bodies publish most Woo documents on their own
 * website, not on open.overheid.nl (UWV: ~400 Woo-besluiten on uwv.nl, 16 on open.overheid.nl),
 * so woo_index follows those links: list APIs, HTML pages and the Staatscourant/
 * Gemeenteblad searches the index points to.
 */
import { getJson, getText } from "../utils/http.js";
import { extractSruRecords, parseXml } from "../utils/xml-parser.js";

export const ROO_API = "https://api-organisaties.overheid.nl/v1/overheidsorganisaties";
export const SRU_API = "https://repository.overheid.nl/sru";
const CONNECTOR = "woo_index";
const SITE_CONNECTOR = "woo_index_sites";
const TIMEOUT_MS = 25_000;
const LIST_PAGE_MAX = 12;

export interface WooLocatie { informatiecategorie: string; url: string; toelichting?: string }
export interface WooIndex {
  label?: string;
  uri?: string;
  wooInformatie?: { overzichtUrl?: string; url?: string };
  wooIndex?: WooLocatie[];
}

export interface WooLink { titel: string; url: string; soort: "document" | "pagina"; datum?: string; type?: string }

/** Only public web addresses: the links come from a register, but the server must not be steered to internal hosts. */
export function isVeiligeUrl(u: string): boolean {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
  const h = url.hostname.toLowerCase();
  if (!h.includes(".") || h.includes(":") || /^\d+(\.\d+){3}$/.test(h)) return false;
  return !/(^|\.)(localhost|local|internal|lan|intranet|home|corp)$/.test(h);
}

const DOC_EXT = /\.(pdf|docx?|odt|xlsx?|ods|pptx?|zip|msg|eml|txt|rtf)(?:$|[?#])/i;
const DOC_PATH = /\/(download|downloads|bestanden?|files?|documenten?|attachments?|bijlagen?|assets-kai)\//i;
const WOO_WORDS = /woo|wob|openbaar|besluit|verzoek|publicatie|convenant|rapport|beschikking|advies|jaarverslag|agenda|besluitenlijst/i;

const decode = (s: string) => s
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
const clean = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/**
 * Document and sub-page links on a page: ordinary <a href> and the link-url/link-label
 * attributes of web components (uwv.nl renders its attachment lists that way).
 * Sub-pages are kept when they live on the same site under the page's section, or look like Woo material.
 */
export function extractLinks(html: string, pageUrl: string): WooLink[] {
  const base = new URL(pageUrl);
  // The page's own folder: /…/Wet_open_overheid/ for /…/Wet_open_overheid/Afgehandelde_Woo_verzoeken.
  const section = base.pathname.replace(/[^/]*$/, "");
  const out = new Map<string, WooLink>();
  const add = (href: string, label: string) => {
    let u: URL;
    try { u = new URL(decode(href.trim()), base); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    u.hash = "";
    const url = u.toString();
    if (url === base.toString() || out.has(url)) return;
    const titel = clean(label) || decodeURIComponent(u.pathname.split("/").pop() ?? "");
    if (!titel) return;
    if (DOC_EXT.test(u.pathname) || DOC_PATH.test(u.pathname)) { out.set(url, { titel, url, soort: "document" }); return; }
    if (u.host !== base.host || u.pathname === "/" || titel.length < 4) return;
    if ((section.length > 1 && u.pathname.startsWith(section) && u.pathname.length > section.length) || WOO_WORDS.test(u.pathname)) out.set(url, { titel, url, soort: "pagina" });
  };
  const body = html.replace(/<(script|style|nav|header|footer)\b[\s\S]*?<\/\1>/gi, " ");
  for (const m of body.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) add(m[1], m[2]);
  for (const m of body.matchAll(/<[a-z][\w-]*\b[^>]*?\blink-url\s*=\s*"([^"]+)"[^>]*>/gi)) add(m[1], /\blink-label\s*=\s*"([^"]*)"/i.exec(m[0])?.[1] ?? "");
  return [...out.values()];
}

/** List components that load their items from a JSON endpoint (uwv.nl: fetch-results, POST {cluster:n}). */
export function listEndpoints(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/\bfetch-results\s*=\s*"([^"]+)"/gi)) {
    try { out.add(new URL(decode(m[1]), pageUrl).toString()); } catch { /* ignore */ }
  }
  return [...out];
}

interface ListPage { meta?: { cluster?: { current?: string | number; hasmore?: boolean } }; results?: Array<{ title?: string; url?: string; date?: string; type?: string }> }

export function parseListPage(page: ListPage, pageUrl: string): { items: WooLink[]; meer: boolean } {
  const items = (page.results ?? []).flatMap((r) => {
    if (!r.url || !r.title) return [];
    const url = new URL(r.url, pageUrl).toString();
    return [{ titel: clean(r.title), url, soort: (DOC_EXT.test(url) ? "document" : "pagina") as WooLink["soort"], ...(r.date ? { datum: r.date.slice(0, 10) } : {}), ...(r.type ? { type: r.type } : {}) }];
  });
  return { items, meer: Boolean(page.meta?.cluster?.hasmore) };
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
/** Every word of the search term (2+ characters) occurs in title or address. */
export function matchesZoekterm(link: Pick<WooLink, "titel" | "url">, zoekterm?: string): boolean {
  if (!zoekterm?.trim()) return true;
  const hay = fold(`${link.titel} ${decodeURIComponent(link.url).replace(/[-_/.]+/g, " ")}`);
  return fold(zoekterm).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2).every((w) => hay.includes(w));
}

/** The CQL query of a zoek.officielebekendmakingen.nl link in the index, or null. */
export function bekendmakingenCql(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)officielebekendmakingen\.nl$/.test(u.hostname)) return null;
    const q = u.searchParams.get("q");
    return q && /c\.product-area/.test(q) ? q : null;
  } catch { return null; }
}

const txt = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === "object") return txt((v as Record<string, unknown>)["#text"]);
  return String(v);
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : Array.isArray(v) ? obj(v[0]) : {});

export function sruItems(xml: string): { totaal: number | null; items: WooLink[] } {
  const parsed = parseXml(xml) as Record<string, unknown>;
  const resp = obj(parsed.searchRetrieveResponse ?? parsed);
  const n = Number(txt(resp.numberOfRecords));
  const items = extractSruRecords(parsed).map((r) => {
    const meta = obj(obj(r.originalData).meta);
    const kern = obj(meta.owmskern), mantel = obj(meta.owmsmantel);
    const id = txt(kern.identifier) ?? "";
    const url = txt(obj(r.enrichedData).preferredUrl) ?? `https://zoek.officielebekendmakingen.nl/${id}.html`;
    return { titel: clean(txt(kern.title) ?? id), url, soort: "document" as const, datum: txt(mantel.available) ?? txt(mantel.date), type: id.split("-")[0] };
  }).filter((x) => x.titel);
  return { totaal: Number.isFinite(n) ? n : null, items };
}

export interface LocatieResultaat extends WooLocatie {
  methode: "lijst-api" | "html" | "officielebekendmakingen" | "raadsinformatie" | "open.overheid.nl" | "overgeslagen";
  gevonden: number | null;
  doorzocht?: number;
  documenten: WooLink[];
  opmerking?: string;
  fout?: string;
}

export interface WooIndexOpties { zoekterm?: string; diepte: 1 | 2; maxPerLocatie: number }

type Fetchers = {
  text: (url: string) => Promise<string>;
  postJson: (url: string, body: unknown) => Promise<unknown>;
};
const SITE_MAX_BYTES = 5 * 1024 * 1024;
const UA = "Mozilla/5.0 (compatible; NL-GOV-MCP; +https://github.com/paulpavlnl/NL-GOV-MCP)";

/**
 * Fetch from a body's own website. Redirects are followed by hand: every hop must be a public
 * address (no redirect into an internal network), and a Location with stray spaces, which
 * Node's fetch rejects (uwv.nl sends one), still works. One retry on a network error or 5xx.
 */
export async function siteFetch(url: string, init: { method?: "GET" | "POST"; body?: string; accept: string; contentType?: string }): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let current = url;
      let method = init.method ?? "GET";
      for (let hop = 0; hop <= 5; hop++) {
        if (!isVeiligeUrl(current)) throw new Error(`Geen openbaar webadres: ${current.slice(0, 120)}`);
        const res = await fetch(current, {
          method,
          redirect: "manual",
          headers: { "User-Agent": UA, Accept: init.accept, ...(method === "POST" && init.contentType ? { "Content-Type": init.contentType } : {}) },
          ...(method === "POST" ? { body: init.body } : {}),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          current = new URL(res.headers.get("location")!.trim(), current).toString();
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) method = "GET";
          continue;
        }
        if (res.status >= 500) throw new Error(`HTTP ${res.status} van ${new URL(current).hostname}`);
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} van ${new URL(current).hostname}`), { definitief: true });
        const buf = await res.arrayBuffer();
        if (buf.byteLength > SITE_MAX_BYTES) throw Object.assign(new Error("Pagina te groot"), { definitief: true });
        return new TextDecoder().decode(buf);
      }
      throw Object.assign(new Error("Te veel doorverwijzingen"), { definitief: true });
    } catch (e) {
      lastError = e;
      if ((e as { definitief?: boolean }).definitief) break;
    }
  }
  throw lastError;
}

export const defaultFetchers: Fetchers = {
  text: (url) => (/^https:\/\/repository\.overheid\.nl\//.test(url)
    ? getText(url, { connector: SITE_CONNECTOR, timeoutMs: TIMEOUT_MS, retries: 1, headers: { Accept: "application/xml" } }).then((r) => r.data)
    : siteFetch(url, { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" })),
  postJson: async (url, body) => JSON.parse(await siteFetch(url, { method: "POST", body: JSON.stringify(body), accept: "application/json", contentType: "application/json" })),
};

/** Follow one location of the index and list what it holds (filtered on the search term). */
export async function volgLocatie(loc: WooLocatie, o: WooIndexOpties, f: Fetchers = defaultFetchers): Promise<LocatieResultaat> {
  const base = { ...loc, documenten: [] as WooLink[], gevonden: null as number | null };
  const cql = bekendmakingenCql(loc.url);
  try {
    if (cql) {
      const q = `${cql}${o.zoekterm?.trim() ? ` AND cql.textAndIndexes="${o.zoekterm.replace(/["\\]/g, " ").trim()}"` : ""} sortBy dt.date/sort.descending`;
      const u = new URL(SRU_API);
      for (const [k, v] of Object.entries({ operation: "searchRetrieve", version: "2.0", query: q, maximumRecords: String(Math.min(o.maxPerLocatie, 50)), startRecord: "1", recordSchema: "gzd" })) u.searchParams.set(k, v);
      const r = sruItems(await f.text(u.toString()));
      return { ...base, methode: "officielebekendmakingen", gevonden: r.totaal, documenten: r.items, opmerking: "Gezocht in Officiële Bekendmakingen met de zoekvraag uit de Woo-index (op tekst, niet alleen titel). Meer: officiele_bekendmakingen_search." };
    }
    const host = new URL(loc.url).hostname;
    if (/(^|\.)open\.overheid\.nl$/.test(host)) return { ...base, methode: "open.overheid.nl", opmerking: "Verwijst naar open.overheid.nl: zoek met woo_zoeken." };
    if (/notubiz|ibabs|raadsinformatie|gemeenteoplossingen|^raad\.|^ris\.|\.ris\./.test(host)) return { ...base, methode: "raadsinformatie", opmerking: "Raadsinformatiesysteem: zoek met ori_search (Open Raadsinformatie)." };
    if (!isVeiligeUrl(loc.url)) return { ...base, methode: "overgeslagen", opmerking: "Geen openbaar webadres." };

    const html = await f.text(loc.url);
    let items: WooLink[] = [];
    let methode: LocatieResultaat["methode"] = "html";
    const lists = listEndpoints(html, loc.url).filter(isVeiligeUrl);
    let doorzocht = 0;
    for (const ep of lists) {
      methode = "lijst-api";
      for (let cluster = 1; cluster <= LIST_PAGE_MAX; cluster++) {
        const p = parseListPage((await f.postJson(ep, cluster === 1 ? {} : { cluster })) as ListPage, loc.url);
        doorzocht += p.items.length;
        items.push(...p.items);
        if (!p.meer || !p.items.length) break;
      }
    }
    if (!lists.length) { items = extractLinks(html, loc.url); doorzocht = items.length; }
    let hits = items.filter((i) => matchesZoekterm(i, o.zoekterm));
    const gevonden = hits.length;
    hits = hits.slice(0, o.maxPerLocatie);
    // Diepte 2: the documents (PDFs) on the first matching sub-pages, e.g. the attachments of a Woo-besluit.
    if (o.diepte === 2) {
      const pages = hits.filter((h) => h.soort === "pagina" && isVeiligeUrl(h.url)).slice(0, o.zoekterm ? 8 : 4);
      await Promise.all(pages.map(async (p) => {
        try {
          const docs = extractLinks(await f.text(p.url), p.url).filter((d) => d.soort === "document").slice(0, 25);
          if (docs.length) (p as WooLink & { bijlagen?: WooLink[] }).bijlagen = docs.map(({ titel, url }) => ({ titel, url, soort: "document" as const }));
        } catch { /* a sub-page that fails just has no attachments listed */ }
      }));
    }
    return {
      ...base, methode, gevonden, doorzocht, documenten: hits,
      ...(doorzocht === 0 ? { opmerking: "Geen links gevonden: de pagina wordt mogelijk met JavaScript opgebouwd of zit achter een zoekformulier. Open de link zelf." } : methode === "lijst-api" && doorzocht >= LIST_PAGE_MAX * 50 ? { opmerking: `Alleen de nieuwste ${doorzocht} items van de lijst doorzocht.` } : {}),
    };
  } catch (e) {
    return { ...base, methode: "html", fout: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

export async function haalWooIndex(tooiUri: string): Promise<{ data: WooIndex; url: string }> {
  const url = `${ROO_API}/${encodeURIComponent(tooiUri)}/woo`;
  const { data } = await getJson<WooIndex>(url, { connector: CONNECTOR, timeoutMs: 20_000, retries: 1, headers: { Accept: "application/json" } });
  return { data, url };
}
