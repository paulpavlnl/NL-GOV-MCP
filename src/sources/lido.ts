import type { AppConfig } from "../types.js";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";
import net from "node:net";

/**
 * LiDO (Linked Data Overheid) source voor NL-GOV-MCP.
 *
 * Versie 4 — functioneel gelijkgetrokken met de LiDO-logica uit de
 * verwijzingscontroleur (server.js), met twee correcties die uit een
 * browsermeting op linkeddata.overheid.nl volgden:
 *
 *  A. RELATIETELLING. LiDO toont het aantal relaties als twee losse getallen
 *     ("Relaties 7 0" = 7 uitgaand, 0 inkomend). De oude regex plakte die aan
 *     elkaar tot 70, waardoor elk volledig resultaat ten onrechte als
 *     "gedeeltelijk" werd gemeld en de crawler bleef doorzoeken naar relaties
 *     die niet bestaan. Nu worden uitgaande en inkomende relaties afzonderlijk
 *     gelezen en opgeteld.
 *
 *  B. CRAWL-SCOPE. Relatiepagina's (spiegel-lijstweergave) worden alleen
 *     gevolgd wanneer zij over HETZELFDE object gaan. Zonder die begrenzing
 *     volgde de crawler facetfilters en de relatiepagina's van elke gevonden
 *     wet, wat in een meting 3227 "relaties" en 52 pagina's opleverde voor een
 *     uitspraak die er 7 heeft. Dat is de werkelijke oorzaak van het
 *     opgebruikte tijdsbudget.
 *
 * Verder, ten opzichte van server.js:
 *
 *  1. HARDE eindgarantie via een watchdog: er komt ALTIJD een geldig
 *     (gedeeltelijk) resultaat binnen het budget, nooit een hangende request.
 *  2. Eén gedeelde werkwachtrij: elke URL wordt exact één keer opgehaald.
 *  3. Niet-blokkerende documentviewer: faalt die, dan wordt doorgezocht via de
 *     direct uit de identifier afgeleide URL's.
 *
 * De HTML-parser is cheerio wanneer die beschikbaar is; anders valt de module
 * terug op een regex-parser. Het actieve pad staat in `parserEngine`.
 */

/* ------------------------------------------------------------------ */
/* Configuratie — hard gecodeerd, conform server.js                    */
/* ------------------------------------------------------------------ */

/** Totale wandkloktijd voor één LiDO-tool-aanroep (server.js: 15 s). */
const LIDO_TOOL_BUDGET_MS = 15_000;
/** Maximale tijd voor één enkele HTTP-request (server.js: 9 s). */
const LIDO_FETCH_TIMEOUT_MS = 9_000;
/** Time-out buiten een LiDO-budget, bijv. bij het volgen van documenten. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Veiligheidsmarge: hierna wordt niets nieuws meer gestart en wordt afgerond. */
const LIDO_WRAPUP_MS = 1_200;
/** Marge waarbinnen geen nieuw primair document meer wordt gevolgd. */
const LIDO_FOLLOW_MARGIN_MS = 1_500;

/** Maximaal aantal unieke relaties dat wordt teruggegeven (server.js: 5000). */
const MAX_LIDO_RELATIONS = 5_000;
/** Maximaal aantal relatiepagina's dat wordt opgehaald (server.js: 50). */
const MAX_LIDO_RELATION_PAGES = 50;
/** Maximaal aantal documentcomponenten dat wordt opgehaald (server.js: 20). */
const MAX_LIDO_COMPONENTS = 20;
/** Maximaal aantal primaire documenten dat wordt gevolgd (server.js: 10). */
const MAX_LIDO_FOLLOW = 10;
/** Gelijktijdige HTTP-requests (server.js: 3). */
const MAX_CONCURRENCY = 3;
/** Maximaal aantal redirects dat handmatig wordt gevolgd (server.js: 3). */
const MAX_REDIRECTS = 3;
/** Hardlimiet op de omvang van één responsbody (server.js: 8 MB). */
const MAX_RESPONSE_BYTES = 8_000_000;
/** Hardlimiet op tekstuele output (server.js: 180.000 tekens). */
const MAX_OUTPUT_CHARACTERS = 180_000;
/** Lengte van de leesbare samenvatting van de LiDO-pagina (server.js: 20.000). */
const READABLE_SNIPPET_CHARACTERS = 20_000;
/** Maximaal aantal brondocument-URL's per gevolgde identifier (server.js: 10). */
const MAX_SOURCE_DOCUMENTS = 10;

const LIDO_ORIGIN = "https://linkeddata.overheid.nl";
const DOCUMENT_VIEWER_URL = `${LIDO_ORIGIN}/front/portal/document-viewer`;
const SEARCH_URL = `${LIDO_ORIGIN}/front/portal/lido-lx`;
const RECHTSPRAAK_CONTENT_URL = "https://data.rechtspraak.nl/uitspraken/content";
const BWB_SRU_URL = "https://zoekservice.overheid.nl/sru/Search";
const CVDR_SRU_URL = "https://zoekdienst.overheid.nl/sru/Search";

const USER_AGENT = "Paul-van-Lange-NL-GOV-MCP-LiDO/4.0 (+https://paulvanlange.nl)";

const ALLOWED_HOSTS = new Set([
  "linkeddata.overheid.nl",
  "uitspraken.rechtspraak.nl",
  "data.rechtspraak.nl",
  "zoekservice.overheid.nl",
  "zoekdienst.overheid.nl",
  "repository.overheid.nl",
  "wetten.overheid.nl",
  "lokaleregelgeving.overheid.nl",
  "tuchtrecht.overheid.nl",
  "repository.officiele-overheidspublicaties.nl",
  "deeplink.rechtspraak.nl",
]);

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface LidoItem {
  id?: string;
  title?: string;
  link?: string;
  [key: string]: unknown;
}

interface LidoResult {
  items: LidoItem[];
  total: number;
  endpoint: string;
  params: Record<string, string>;
  access_note?: string;
}

type RelationKind = "ecli" | "bwbr" | "cvdr" | "celex" | "official-url";
type IdentifierKind = "ecli" | "bwbr" | "cvdr" | "celex";

interface Relation {
  kind: RelationKind;
  identifier?: string;
  url: string | null;
  description: string;
  sourceUrl: string;
}

interface Identifiers {
  eclis: string[];
  bwbrs: string[];
  cvdrs: string[];
  celexes: string[];
}

interface Candidate {
  kind: IdentifierKind;
  value: string;
}

interface FetchedPage {
  url: string;
  contentType: string;
  rawHtml: string;
  setCookies: string[];
}

interface PageResult {
  url: string;
  contentType?: string;
  error?: string;
}

interface AnchorNode {
  href: string;
  text: string;
  rel: string;
}

interface RelationCount {
  outgoing: number | null;
  incoming: number | null;
  total: number | null;
}

/* ------------------------------------------------------------------ */
/* Parser — cheerio met regex-fallback                                 */
/* ------------------------------------------------------------------ */

type CheerioApi = {
  each: (fn: (index: number, element: unknown) => void) => unknown;
  first: () => { length: number; text: () => string };
  remove: () => unknown;
  attr: (name: string) => string | undefined;
  text: () => string;
  length: number;
};

type CheerioModule = { load: (html: string) => (selector: unknown) => CheerioApi };

let cheerioModule: CheerioModule | null = null;
let cheerioProbed = false;

/**
 * Laadt cheerio eenmalig en optioneel. Ontbreekt de dependency, dan blijft de
 * module werken via de regex-parser; cheerio is dus een verbetering en geen
 * harde installatievoorwaarde voor NL-GOV-MCP.
 */
async function loadCheerio(): Promise<CheerioModule | null> {
  if (cheerioProbed) return cheerioModule;
  cheerioProbed = true;
  try {
    // Specifier via variabele: cheerio mag bij het compileren ontbreken.
    const specifier = "cheerio";
    const mod = (await import(specifier)) as unknown as CheerioModule & { default?: CheerioModule };
    cheerioModule = typeof mod.load === "function" ? mod : (mod.default ?? null);
  } catch {
    cheerioModule = null;
  }
  return cheerioModule;
}

function parserEngine(): "cheerio" | "regex" {
  return cheerioModule ? "cheerio" : "regex";
}

const LINK_RE = /<a\s+[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]{0,4000}?)<\/a>/gi;
const REL_ATTR_RE = /\brel\s*=\s*["']([^"']*)["']/i;
const HREF_SRC_RE = /<(?:a|link)\s+[^>]*?href\s*=\s*["']([^"']*)["']|<script\s+[^>]*?src\s*=\s*["']([^"']*)["']/gi;

/** Haalt alle <a>-elementen op als platte structuren, via cheerio of regex. */
function parseAnchors(raw: string): AnchorNode[] {
  const $ = cheerioModule?.load(raw);
  if ($) {
    const out: AnchorNode[] = [];
    $("a[href]").each((_: number, element: unknown) => {
      const el = $(element);
      const href = el.attr("href");
      if (!href) return;
      out.push({
        href,
        text: (el.text() ?? "").replace(/\s+/g, " ").trim(),
        rel: el.attr("rel") ?? "",
      });
    });
    return out;
  }

  const out: AnchorNode[] = [];
  for (const m of raw.matchAll(LINK_RE)) {
    const href = m[1];
    if (!href) continue;
    const openingTag = m[0].slice(0, m[0].indexOf(">") + 1);
    out.push({
      href,
      text: stripHtml(m[2] ?? ""),
      rel: openingTag.match(REL_ATTR_RE)?.[1] ?? "",
    });
  }
  return out;
}

/** Haalt href/src-waarden op uit a, link en script, via cheerio of regex. */
function parseHrefsAndSrcs(raw: string): string[] {
  const $ = cheerioModule?.load(raw);
  if ($) {
    const out: string[] = [];
    $("a[href],link[href],script[src]").each((_: number, element: unknown) => {
      const el = $(element);
      const v = el.attr("href") ?? el.attr("src");
      if (v) out.push(v);
    });
    return out;
  }

  const out: string[] = [];
  for (const m of raw.matchAll(HREF_SRC_RE)) {
    const v = m[1] ?? m[2];
    if (v) out.push(v);
  }
  return out;
}

const BLOCK_TAGS_RE = /<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi;

/** Zet HTML om naar leesbare tekst, via cheerio of regex. */
function htmlToText(html: string): string {
  const $ = cheerioModule?.load(html);
  if ($) {
    $("script,style,noscript,svg,nav,footer,header,form").remove();
    const main = $("main").first();
    const article = $("article").first();
    const roleMain = $('[role="main"]').first();
    const part = main.length ? main : article.length ? article : roleMain.length ? roleMain : $("body").first();
    return part
      .text()
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return stripHtml(html.replace(BLOCK_TAGS_RE, " "));
}

/* ------------------------------------------------------------------ */
/* Regex voor identifiers en URL-vormen                                */
/* ------------------------------------------------------------------ */

const ECLI_RE = /ECLI:[A-Z]{2}:[A-Z0-9.]+:[0-9]{4}:[A-Z0-9.]+/gi;
const BWBR_RE = /BWBR[0-9]{6,8}/gi;
const CVDR_RE = /CVDR[0-9]{5,8}(?:_[0-9]+)?/gi;
const CELEX_RE = /CELEX:[0-9A-Z][0-9]{4}[A-Z]{1,2}[0-9]{4}(?:\([0-9]{2}\))?/gi;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const REL_URL_RE =
  /(?:\.\.\/|\.\/|\/)?(?:front\/portal\/)?(?:component\/(?:get-document-with-refs-html|item-text-with-links)|spiegel-lijstweergave)[^\s<>"']*/gi;
const COMPONENT_RE = /\/component\/(?:get-document-with-refs-html|item-text-with-links)/i;
const RELATION_PAGE_RE = /\/front\/portal\/spiegel-lijstweergave/i;
const NEXT_PAGE_RE = /volgende|next|pagination/i;

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

interface Budget {
  deadline: number;
}

const lidoExecution = new AsyncLocalStorage<Budget>();

function remainingMs(): number {
  const store = lidoExecution.getStore();
  return store ? store.deadline - Date.now() : LIDO_TOOL_BUDGET_MS;
}

function budgetExhausted(margin = LIDO_WRAPUP_MS): boolean {
  const store = lidoExecution.getStore();
  return store ? store.deadline - Date.now() <= margin : false;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function asError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeIdentifier(value: string): string {
  return String(value ?? "").trim().toUpperCase();
}

function clip(value: unknown, maximum = MAX_OUTPUT_CHARACTERS): string {
  const s = String(value ?? "");
  return s.length <= maximum ? s : `${s.slice(0, maximum)}\n\n[RESULTAAT AFGEKAPT OP ${maximum} TEKENS]`;
}

function cleanQuery(value: string): string {
  return String(value ?? "")
    .replace(/["\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractIdentifiers(raw: string): Identifiers {
  const s = String(raw ?? "");
  return {
    eclis: unique((s.match(ECLI_RE) ?? []).map((m) => m.toUpperCase())),
    bwbrs: unique((s.match(BWBR_RE) ?? []).map((m) => m.toUpperCase())),
    cvdrs: unique((s.match(CVDR_RE) ?? []).map((m) => m.toUpperCase())),
    celexes: unique((s.match(CELEX_RE) ?? []).map((m) => m.toUpperCase())),
  };
}

function mergeIdentifiers(items: Identifiers[]): Identifiers {
  return {
    eclis: unique(items.flatMap((x) => x.eclis)),
    bwbrs: unique(items.flatMap((x) => x.bwbrs)),
    cvdrs: unique(items.flatMap((x) => x.cvdrs)),
    celexes: unique(items.flatMap((x) => x.celexes)),
  };
}

function isAllowedHost(url: string): boolean {
  try {
    return ALLOWED_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function extractUrls(raw: string, base: string): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    try {
      out.push(new URL(value.replace(/&amp;/g, "&"), base).toString());
    } catch {
      /* ongeldige URL overslaan */
    }
  };
  for (const v of parseHrefsAndSrcs(raw)) push(v);
  for (const m of raw.matchAll(URL_RE)) push(m[0]);
  for (const m of raw.matchAll(REL_URL_RE)) push(m[0]);
  return unique(out);
}

/* ------------------------------------------------------------------ */
/* Crawl-scope (correctie B)                                           */
/* ------------------------------------------------------------------ */

/**
 * Normaliseert een LiDO-object-URI voor vergelijking: schema, trailing slash,
 * hoofdletters en fragment worden genegeerd.
 */
function normalizeObjectUri(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "")
    .toUpperCase();
}

/** Leest de `id`-parameter (het object waarover de relatiepagina gaat). */
function relationPageObject(url: string): string | null {
  try {
    const id = new URL(url).searchParams.get("id");
    return id ? normalizeObjectUri(id) : null;
  } catch {
    return null;
  }
}

/** Verwijdert het fragment, zodat #content en #navigation geen dubbele fetch geven. */
function stripFragment(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Bepaalt of een relatiepagina binnen de scope van het onderzochte object valt.
 *
 * Zonder deze begrenzing volgt de crawler facetfilters (facet.field=...) en de
 * relatiepagina's van elke aangetroffen wet. In een browsermeting leverde dat
 * 3227 "relaties" en 52 pagina's op voor een uitspraak met 7 relaties.
 */
function isInScopeRelationPage(url: string, scope: Set<string>): boolean {
  if (!RELATION_PAGE_RE.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Facet- en filterweergaven zijn navigatie, geen relaties.
  for (const key of parsed.searchParams.keys()) {
    if (/^facet\./i.test(key) || /^(?:fq|link_richting|obj_type|obj_jaar|obj_organisatie)/i.test(key)) return false;
  }
  if (!scope.size) return true;
  const object = relationPageObject(url);
  return object !== null && scope.has(object);
}

function discoverLidoTargets(raw: string, base: string, scope: Set<string>) {
  const urls = extractUrls(raw, base).filter(isAllowedHost).map(stripFragment);
  return {
    components: unique(urls.filter((u) => COMPONENT_RE.test(u))),
    relationPages: unique(urls.filter((u) => isInScopeRelationPage(u, scope))),
  };
}

function findNextRelationPages(raw: string, base: string, scope: Set<string>): string[] {
  const out: string[] = [];
  for (const anchor of parseAnchors(raw)) {
    const label = `${anchor.text} ${anchor.rel}`.toLowerCase();
    if (!NEXT_PAGE_RE.test(label)) continue;
    try {
      const u = stripFragment(new URL(anchor.href, base).toString());
      // Paginering blijft per definitie binnen hetzelfde object.
      if (RELATION_PAGE_RE.test(u) && isInScopeRelationPage(u, scope)) out.push(u);
    } catch {
      /* negeren */
    }
  }
  return unique(out);
}

/* ------------------------------------------------------------------ */
/* Relaties en telling                                                 */
/* ------------------------------------------------------------------ */

function relationKey(r: Relation): string {
  return `${r.kind}|${r.identifier ?? ""}|${r.url ?? ""}|${r.description}`;
}

/**
 * Bepaalt het doel van een relatie op het niveau waarop LiDO telt.
 *
 * LiDO rekent per object-URI, niet per identifier: artikel 6:162, 6:165 en
 * 6:119 zijn drie relaties, ook al delen ze BWBR0005289. Tellen op identifier
 * geeft daardoor te weinig en markeert een volledig resultaat als gedeeltelijk.
 */
function relationTargetKey(r: Relation): string | null {
  if (r.url) {
    const object = relationPageObject(r.url);
    if (object) return `uri|${object}`;
    try {
      const decoded = decodeURIComponent(r.url);
      const term = decoded.match(/linkeddata\.overheid\.nl\/terms\/[^\s"'<>]+/i);
      if (term) return `uri|${normalizeObjectUri(term[0])}`;
    } catch {
      /* negeren */
    }
  }
  return r.identifier ? `${r.kind}|${normalizeIdentifier(r.identifier)}` : null;
}

function extractRelations(raw: string, base: string, sourceUrl: string): Relation[] {
  const found: Relation[] = [];

  for (const anchor of parseAnchors(raw)) {
    let url: string;
    try {
      url = new URL(anchor.href, base).toString();
    } catch {
      continue;
    }
    const description = anchor.text;
    let decodedUrl = url;
    try {
      decodedUrl = decodeURIComponent(url);
    } catch {
      /* laat url ongewijzigd bij ongeldige escape-reeksen */
    }
    const ids = extractIdentifiers(`${description} ${decodedUrl}`);
    let matched = false;
    for (const identifier of ids.eclis) {
      found.push({ kind: "ecli", identifier, url, description, sourceUrl });
      matched = true;
    }
    for (const identifier of ids.bwbrs) {
      found.push({ kind: "bwbr", identifier, url, description, sourceUrl });
      matched = true;
    }
    for (const identifier of ids.cvdrs) {
      found.push({ kind: "cvdr", identifier, url, description, sourceUrl });
      matched = true;
    }
    for (const identifier of ids.celexes) {
      found.push({ kind: "celex", identifier, url, description, sourceUrl });
      matched = true;
    }
    if (!matched && isAllowedHost(url)) {
      found.push({ kind: "official-url", url, description, sourceUrl });
    }
  }

  const ids = extractIdentifiers(raw);
  for (const [plural, kind] of [
    ["eclis", "ecli"],
    ["bwbrs", "bwbr"],
    ["cvdrs", "cvdr"],
    ["celexes", "celex"],
  ] as const) {
    for (const identifier of ids[plural]) {
      found.push({ kind, identifier, url: null, description: "", sourceUrl });
    }
  }

  const seen = new Set<string>();
  return found.filter((r) => {
    const k = relationKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Leest het aantal relaties van een LiDO-pagina (correctie A).
 *
 * LiDO toont twee losse tellers, bijvoorbeeld "Uitgaande relaties (7)" en
 * "Inkomende relaties (0)"; in platte tekst wordt dat "Relaties 7 0". De vorige
 * implementatie las dat als het getal 70. Daardoor gold een volledig resultaat
 * altijd als gedeeltelijk en bleef de crawler doorzoeken.
 */
function parseRelationCount(raw: string): RelationCount {
  const text = htmlToText(raw);

  const outgoing = text.match(/Uitgaande\s+relaties?\s*\(?\s*([0-9][0-9.\s]*)\)?/i);
  const incoming = text.match(/Inkomende\s+relaties?\s*\(?\s*([0-9][0-9.\s]*)\)?/i);
  const toNumber = (m: RegExpMatchArray | null): number | null => {
    if (!m) return null;
    const n = Number(m[1].replace(/[^0-9]/g, ""));
    return Number.isSafeInteger(n) ? n : null;
  };

  const out = toNumber(outgoing);
  const inc = toNumber(incoming);
  if (out !== null || inc !== null) {
    return { outgoing: out, incoming: inc, total: (out ?? 0) + (inc ?? 0) };
  }

  // Vorm "Relaties 7 0": twee losse getallen achter het woord Relaties.
  const pair = text.match(/Relaties\s+([0-9]{1,6})\s+([0-9]{1,6})\b/i);
  if (pair) {
    const a = Number(pair[1]);
    const b = Number(pair[2]);
    if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) {
      return { outgoing: a, incoming: b, total: a + b };
    }
  }

  // Enkelvoudige vorm "Relaties 7" of "7 relaties".
  const single = text.match(/Relaties\s+([0-9]{1,6})\b/i) ?? text.match(/\b([0-9]{1,6})\s+relaties\b/i);
  const n = toNumber(single);
  return { outgoing: null, incoming: null, total: n };
}

/* ------------------------------------------------------------------ */
/* SSRF-bescherming — conform server.js                                */
/* ------------------------------------------------------------------ */

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    return (
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      p[0] >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    return (
      s === "::1" ||
      s === "::" ||
      s.startsWith("fc") ||
      s.startsWith("fd") ||
      s.startsWith("fe8") ||
      s.startsWith("fe9") ||
      s.startsWith("fea") ||
      s.startsWith("feb") ||
      s.startsWith("::ffff:127.") ||
      s.startsWith("::ffff:10.") ||
      s.startsWith("::ffff:192.168.")
    );
  }
  return true;
}

async function assertSafeUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Alleen HTTPS is toegestaan.");
  if (url.username || url.password || url.port) {
    throw new Error("URL met credentials of afwijkende poort is niet toegestaan.");
  }
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) throw new Error(`Domein niet toegestaan: ${host}`);
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some((r) => isPrivateIp(r.address))) {
    throw new Error(`Onveilig of niet-publiek adres voor ${host}.`);
  }
  return url;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function readLimitedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`Bronrespons groter dan ${MAX_RESPONSE_BYTES} bytes.`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

interface SourceResponse {
  url: string;
  status: number;
  contentType: string;
  setCookies: string[];
  body: string;
}

/** Haalt één bron op met handmatige redirect-afhandeling en budgetbewaking. */
async function fetchSource(input: string, options: { headers?: Record<string, string> } = {}): Promise<SourceResponse> {
  let current = await assertSafeUrl(input);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const execution = lidoExecution.getStore();
    const remaining = execution ? remainingMs() : REQUEST_TIMEOUT_MS;
    if (execution && remaining <= LIDO_WRAPUP_MS) throw new Error("LIDO_TIME_BUDGET_REACHED");
    const timeoutMs = execution
      ? Math.max(500, Math.min(LIDO_FETCH_TIMEOUT_MS, remaining - LIDO_WRAPUP_MS))
      : REQUEST_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "nl",
          Accept: "text/html,application/xhtml+xml,application/xml,text/xml,application/json;q=0.8,*/*;q=0.5",
          ...(options.headers ?? {}),
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects === MAX_REDIRECTS) throw new Error("Te veel redirects.");
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect zonder Location-header.");
        current = await assertSafeUrl(new URL(location, current).toString());
        continue;
      }

      const body = await readLimitedBody(response);
      if (!response.ok) throw new Error(`Bron gaf HTTP ${response.status}: ${body.slice(0, 1200)}`);

      const anyHeaders = response.headers as unknown as { getSetCookie?: () => string[] };
      const setCookies =
        typeof anyHeaders.getSetCookie === "function"
          ? anyHeaders.getSetCookie()
          : response.headers.get("set-cookie")
            ? [response.headers.get("set-cookie") as string]
            : [];

      return {
        url: current.toString(),
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        setCookies,
        body,
      };
    } catch (error) {
      if (asError(error) === "LIDO_TIME_BUDGET_REACHED") throw error;
      const cause = (error as { cause?: { code?: string; name?: string; message?: string } })?.cause;
      const detail = cause
        ? `${cause.code ?? cause.name ?? "cause"}: ${cause.message ?? String(cause)}`
        : asError(error);
      throw new Error(`Ophalen mislukt voor ${current.hostname}: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("Redirectlus.");
}

async function fetchLidoPage(url: string, options: { headers?: Record<string, string> } = {}): Promise<FetchedPage> {
  const r = await fetchSource(url, options);
  return { url: r.url, contentType: r.contentType, rawHtml: r.body, setCookies: r.setCookies };
}

/* ------------------------------------------------------------------ */
/* Primaire bronnen voor maxFollow                                     */
/* ------------------------------------------------------------------ */

async function getRechtspraakXml(ecli: string) {
  const u = new URL(RECHTSPRAAK_CONTENT_URL);
  u.searchParams.set("id", ecli);
  u.searchParams.set("return", "DOC");
  const r = await fetchSource(u.toString(), {
    headers: { Accept: "application/xml,text/xml,application/rdf+xml" },
  });
  return {
    detailUrl: `https://uitspraken.rechtspraak.nl/details?id=${encodeURIComponent(ecli)}`,
    xmlUrl: u.toString(),
    contentType: r.contentType,
    xml: clip(r.body),
  };
}

async function searchSru(args: {
  endpoint: string;
  version: string;
  connection?: string;
  query: string;
  maximumRecords: number;
}) {
  const u = new URL(args.endpoint);
  u.searchParams.set("operation", "searchRetrieve");
  u.searchParams.set("version", args.version);
  if (args.connection) u.searchParams.set("x-connection", args.connection);
  u.searchParams.set("query", args.query);
  u.searchParams.set("maximumRecords", String(args.maximumRecords));
  const r = await fetchSource(u.toString(), { headers: { Accept: "application/xml,text/xml" } });
  const links = unique((r.body.match(URL_RE) ?? []).map((v) => v.replace(/&amp;/g, "&").replace(/[),.;]+$/g, "")));
  return { searchUrl: u.toString(), xml: r.body, links };
}

async function verifyBwbIdentifier(id: string) {
  const s = await searchSru({
    endpoint: BWB_SRU_URL,
    version: "2.0",
    connection: "BWB",
    query: `dcterms.identifier==${cleanQuery(id)}`,
    maximumRecords: 5,
  });
  return {
    searchUrl: s.searchUrl,
    documentUrls: s.links.filter(isAllowedHost).slice(0, MAX_SOURCE_DOCUMENTS),
    sourceXml: clip(s.xml, 60_000),
  };
}

async function verifyCvdrIdentifier(id: string) {
  const s = await searchSru({
    endpoint: CVDR_SRU_URL,
    version: "1.2",
    connection: "CVDR",
    query: `dcterms.identifier==${cleanQuery(id)}`,
    maximumRecords: 5,
  });
  return {
    searchUrl: s.searchUrl,
    documentUrls: s.links.filter(isAllowedHost).slice(0, MAX_SOURCE_DOCUMENTS),
    sourceXml: clip(s.xml, 60_000),
  };
}

async function resolveDiscoveredIdentifier(c: Candidate): Promise<Record<string, unknown>> {
  try {
    if (c.kind === "ecli") return { ...(await getRechtspraakXml(c.value)), kind: c.kind, identifier: c.value };
    if (c.kind === "bwbr") return { ...(await verifyBwbIdentifier(c.value)), kind: c.kind, identifier: c.value };
    if (c.kind === "cvdr") return { ...(await verifyCvdrIdentifier(c.value)), kind: c.kind, identifier: c.value };
    return {
      kind: c.kind,
      identifier: c.value,
      note: "CELEX gedetecteerd maar niet automatisch opgehaald.",
      suggestedUrl: `https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=${encodeURIComponent(c.value)}`,
    };
  } catch (error) {
    return { kind: c.kind, identifier: c.value, error: asError(error) };
  }
}

/* ------------------------------------------------------------------ */
/* Crawler                                                             */
/* ------------------------------------------------------------------ */

function buildDirectLidoUrls(identifier: string): { objectUri: string | null; urls: string[] } {
  const id = String(identifier ?? "").trim();
  const objectUri = /^ECLI:/i.test(id) ? `http://linkeddata.overheid.nl/terms/jurisprudentie/id/${id}` : null;
  const urls: string[] = [];

  const component1 = new URL(`${LIDO_ORIGIN}/front/portal/component/get-document-with-refs-html`);
  component1.searchParams.set("ecli", id);
  urls.push(component1.toString());

  const component2 = new URL(`${LIDO_ORIGIN}/front/portal/component/item-text-with-links`);
  component2.searchParams.set("id", id);
  urls.push(component2.toString());

  if (objectUri) {
    const relation = new URL(`${LIDO_ORIGIN}/front/portal/spiegel-lijstweergave`);
    relation.searchParams.set("id", objectUri);
    relation.searchParams.set("callback", "");
    relation.searchParams.set("dates", "");
    relation.searchParams.set("fields", "");
    urls.push(relation.toString());
  }

  return { objectUri, urls };
}

interface CrawlState {
  relations: Map<string, Relation>;
  identifierSources: string[];
  componentResults: PageResult[];
  relationPageResults: PageResult[];
  componentsFetched: number;
  relationPagesFetched: number;
  relationCount: RelationCount;
  readableSnippet: string;
  contentType: string;
  stopReason: string | null;
  limitReached: boolean;
  followed: Record<string, unknown>[];
  scope: Set<string>;
  skippedOutOfScope: number;
}

function newCrawlState(): CrawlState {
  return {
    relations: new Map(),
    identifierSources: [],
    componentResults: [],
    relationPageResults: [],
    componentsFetched: 0,
    relationPagesFetched: 0,
    relationCount: { outgoing: null, incoming: null, total: null },
    readableSnippet: "",
    contentType: "",
    stopReason: null,
    limitReached: false,
    followed: [],
    scope: new Set<string>(),
    skippedOutOfScope: 0,
  };
}

function ingestPage(state: CrawlState, page: FetchedPage): { components: string[]; relationPages: string[] } {
  state.identifierSources.push(page.rawHtml);

  if (state.relationCount.total === null) {
    state.relationCount = parseRelationCount(page.rawHtml);
  }

  for (const relation of extractRelations(page.rawHtml, page.url, page.url)) {
    if (state.relations.size >= MAX_LIDO_RELATIONS) {
      state.limitReached = true;
      break;
    }
    const key = relationKey(relation);
    if (!state.relations.has(key)) state.relations.set(key, relation);
  }

  const discovered = discoverLidoTargets(page.rawHtml, page.url, state.scope);
  return {
    components: discovered.components,
    relationPages: unique([
      ...discovered.relationPages,
      ...findNextRelationPages(page.rawHtml, page.url, state.scope),
    ]),
  };
}

/**
 * Haalt alle in-scope LiDO-componenten en relatiepagina's op vanaf een set
 * start-URL's. Elke URL wordt maximaal één keer opgehaald. Stopt netjes op
 * budget of limiet.
 */
async function crawlLido(
  state: CrawlState,
  seedUrls: string[],
  requestOptions: { headers?: Record<string, string> },
): Promise<void> {
  const visited = new Set<string>();
  const queue = unique(seedUrls.map(stripFragment)).filter(isAllowedHost);

  while (queue.length) {
    if (budgetExhausted()) {
      state.stopReason = "time_budget_reached";
      return;
    }
    if (state.componentsFetched >= MAX_LIDO_COMPONENTS && state.relationPagesFetched >= MAX_LIDO_RELATION_PAGES) {
      state.limitReached = true;
      state.stopReason ??= "configured_limit_reached";
      return;
    }

    const batch: string[] = [];
    while (queue.length && batch.length < MAX_CONCURRENCY) {
      const url = queue.shift() as string;
      if (visited.has(url)) continue;
      const isComponent = COMPONENT_RE.test(url);
      const isRelationPage = RELATION_PAGE_RE.test(url);
      if (!isComponent && !isRelationPage) continue;
      if (isRelationPage && !isInScopeRelationPage(url, state.scope)) {
        state.skippedOutOfScope += 1;
        continue;
      }
      if (isComponent && state.componentsFetched + batch.length >= MAX_LIDO_COMPONENTS) continue;
      if (isRelationPage && state.relationPagesFetched + batch.length >= MAX_LIDO_RELATION_PAGES) continue;
      visited.add(url);
      batch.push(url);
    }
    if (!batch.length) {
      if (queue.length) continue;
      return;
    }

    const settled = await Promise.all(
      batch.map(async (url) => {
        try {
          return { url, page: await fetchLidoPage(url, requestOptions) };
        } catch (error) {
          return { url, error: asError(error) };
        }
      }),
    );

    const next: string[] = [];
    for (const entry of settled) {
      const isComponent = COMPONENT_RE.test(entry.url);
      const bucket = isComponent ? state.componentResults : state.relationPageResults;

      if ("error" in entry && entry.error) {
        bucket.push({ url: entry.url, error: entry.error });
        if (/LIDO_TIME_BUDGET_REACHED/.test(entry.error)) state.stopReason = "time_budget_reached";
        continue;
      }

      const page = (entry as { page: FetchedPage }).page;
      bucket.push({ url: page.url, contentType: page.contentType });
      if (isComponent) state.componentsFetched += 1;
      else state.relationPagesFetched += 1;

      const found = ingestPage(state, page);
      next.push(...found.components, ...found.relationPages);
    }

    if (state.relations.size >= MAX_LIDO_RELATIONS) {
      state.limitReached = true;
      state.stopReason ??= "configured_limit_reached";
      return;
    }

    queue.push(...next.filter((u) => !visited.has(u)));
  }
}

function candidatesFromState(state: CrawlState, ids: Identifiers, exclude: string | null): Candidate[] {
  const ex = exclude ? normalizeIdentifier(exclude) : null;
  const out: Candidate[] = [];

  for (const r of state.relations.values()) {
    if (!r.identifier || r.kind === "official-url") continue;
    if (ex && normalizeIdentifier(r.identifier) === ex) continue;
    out.push({ kind: r.kind as IdentifierKind, value: r.identifier });
  }
  for (const [plural, kind] of [
    ["eclis", "ecli"],
    ["bwbrs", "bwbr"],
    ["cvdrs", "cvdr"],
    ["celexes", "celex"],
  ] as const) {
    for (const value of ids[plural]) {
      if (ex && normalizeIdentifier(value) === ex) continue;
      out.push({ kind, value });
    }
  }

  const seen = new Set<string>();
  return out.filter((x) => {
    const k = `${x.kind}|${x.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Volgt de gevonden identifiers naar hun primaire bron. */
async function followCandidates(state: CrawlState, candidates: Candidate[], maxFollow: number): Promise<void> {
  const followLimit = Math.max(0, Math.min(maxFollow, MAX_LIDO_FOLLOW));
  for (const candidate of candidates.slice(0, followLimit)) {
    if (budgetExhausted(LIDO_FOLLOW_MARGIN_MS)) {
      state.stopReason ??= "time_budget_reached";
      return;
    }
    state.followed.push(await resolveDiscoveredIdentifier(candidate));
  }
}

function summarize(state: CrawlState, identifier: string | null) {
  const relations = [...state.relations.values()];

  const failedRequests = [...state.componentResults, ...state.relationPageResults].filter((p) => p.error);
  if (!state.stopReason && failedRequests.length) {
    state.stopReason = failedRequests.some((p) => /aborted|timeout|TIME_BUDGET/i.test(p.error ?? ""))
      ? "time_budget_reached"
      : "one_or_more_lido_requests_failed";
  }

  const ids = mergeIdentifiers([
    ...state.identifierSources.map((raw) => extractIdentifiers(raw)),
    extractIdentifiers(JSON.stringify(relations)),
  ]);

  const reported = state.relationCount.total;
  // Vergelijk het gemelde aantal met unieke relatiedoelen op object-niveau, niet
  // met het aantal linkvarianten en ook niet met het aantal identifiers.
  const ex = identifier ? normalizeIdentifier(identifier) : null;
  const exUri = ex ? normalizeObjectUri(`http://linkeddata.overheid.nl/terms/jurisprudentie/id/${ex}`) : null;
  const distinctTargets = new Set<string>();
  for (const r of relations) {
    if (r.kind === "official-url") continue;
    const key = relationTargetKey(r);
    if (!key) continue;
    if (ex && key === `${r.kind}|${ex}`) continue;
    if (exUri && key === `uri|${exUri}`) continue;
    distinctTargets.add(key);
  }
  const distinctExcludingSelf = distinctTargets.size;

  const fullByReported = reported !== null && distinctExcludingSelf >= reported;
  const partial = reported === null ? true : !fullByReported || state.stopReason !== null;
  const candidates = candidatesFromState(state, ids, identifier);

  return {
    reportedRelationCount: reported,
    reportedOutgoingRelations: state.relationCount.outgoing,
    reportedIncomingRelations: state.relationCount.incoming,
    relationsExtracted: relations.length,
    distinctRelatedDocuments: distinctExcludingSelf,
    relationPagesFetched: state.relationPagesFetched,
    documentComponentsFetched: state.componentsFetched,
    outOfScopePagesSkipped: state.skippedOutOfScope,
    partialResult: partial,
    limitReached: state.limitReached,
    stopReason: state.stopReason,
    discoveredIdentifiers: ids,
    relations,
    componentResults: state.componentResults,
    relationPageResults: state.relationPageResults,
    candidates,
    totalFollowCandidates: candidates.length,
    followedCount: state.followed.length,
    followedResults: state.followed,
    readableSnippet: state.readableSnippet,
    contentType: state.contentType,
    parserEngine: parserEngine(),
    limits: {
      toolBudgetMs: LIDO_TOOL_BUDGET_MS,
      fetchTimeoutMs: LIDO_FETCH_TIMEOUT_MS,
      wrapUpMs: LIDO_WRAPUP_MS,
      maxRelations: MAX_LIDO_RELATIONS,
      maxRelationPages: MAX_LIDO_RELATION_PAGES,
      maxComponents: MAX_LIDO_COMPONENTS,
      maxPrimaryDocumentsFollowed: MAX_LIDO_FOLLOW,
      maxRedirects: MAX_REDIRECTS,
      concurrency: MAX_CONCURRENCY,
    },
    explanation:
      reported === null
        ? `LiDO vermeldde geen betrouwbaar totaal. De server las ${relations.length} relatieverwijzingen naar ${distinctExcludingSelf} unieke documenten, uit ${state.componentsFetched} componenten en ${state.relationPagesFetched} relatiepagina's. Stopreden: ${state.stopReason ?? "geen"}.`
        : `LiDO meldt ${reported} relaties (${state.relationCount.outgoing ?? "?"} uitgaand, ${state.relationCount.incoming ?? "?"} inkomend). De server las ${relations.length} relatieverwijzingen naar ${distinctExcludingSelf} unieke documenten, uit ${state.componentsFetched} componenten en ${state.relationPagesFetched} relatiepagina's. Het resultaat is ${partial ? "gedeeltelijk" : "volledig volgens het gemelde totaal"}. Stopreden: ${state.stopReason ?? "geen"}.`,
  };
}

/**
 * Bouwt het item op met ZOWEL camelCase (server.js-contract) als snake_case
 * (NL-GOV-MCP-conventie), zodat clients van beide vormen blijven werken.
 */
function buildItem(inv: ReturnType<typeof summarize>, base: LidoItem, note?: { key: string; value: string }): LidoItem {
  return {
    ...base,
    // camelCase — contract van server.js
    reportedRelationCount: inv.reportedRelationCount,
    reportedOutgoingRelations: inv.reportedOutgoingRelations,
    reportedIncomingRelations: inv.reportedIncomingRelations,
    relationsExtracted: inv.relationsExtracted,
    distinctRelatedDocuments: inv.distinctRelatedDocuments,
    relationPagesFetched: inv.relationPagesFetched,
    documentComponentsFetched: inv.documentComponentsFetched,
    outOfScopePagesSkipped: inv.outOfScopePagesSkipped,
    partialResult: inv.partialResult,
    limitReached: inv.limitReached,
    stopReason: inv.stopReason,
    discoveredIdentifiers: inv.discoveredIdentifiers,
    relations: inv.relations,
    componentResults: inv.componentResults,
    relationPageResults: inv.relationPageResults,
    totalFollowCandidates: inv.totalFollowCandidates,
    followedCount: inv.followedCount,
    followedResults: inv.followedResults,
    readableSnippet: inv.readableSnippet,
    contentType: inv.contentType,
    parserEngine: inv.parserEngine,
    limits: inv.limits,
    explanation: inv.explanation,
    // snake_case — bestaande NL-GOV-MCP-conventie
    reported_relation_count: inv.reportedRelationCount,
    reported_outgoing_relations: inv.reportedOutgoingRelations,
    reported_incoming_relations: inv.reportedIncomingRelations,
    relations_extracted: inv.relationsExtracted,
    distinct_related_documents: inv.distinctRelatedDocuments,
    relation_pages_fetched: inv.relationPagesFetched,
    document_components_fetched: inv.documentComponentsFetched,
    out_of_scope_pages_skipped: inv.outOfScopePagesSkipped,
    partial_result: inv.partialResult,
    limit_reached: inv.limitReached,
    stop_reason: inv.stopReason,
    discovered_identifiers: inv.discoveredIdentifiers,
    component_results: inv.componentResults,
    relation_page_results: inv.relationPageResults,
    total_follow_candidates: inv.totalFollowCandidates,
    followed_count: inv.followedCount,
    followed_results: inv.followedResults,
    readable_snippet: inv.readableSnippet,
    parser_engine: inv.parserEngine,
    ...(note ? { [note.key]: note.value } : {}),
    limitation:
      "LiDO-pagina's worden deels client-side opgebouwd. Deze tool doorzoekt de documentviewer, de documentcomponenten en de relatiepagina's van hetzelfde object (inclusief paginering) tot het tijdsbudget of de ingestelde limieten zijn bereikt, en volgt daarna maximaal maxFollow gevonden identifiers naar hun primaire bron. Facet- en filterweergaven en relatiepagina's van andere objecten worden bewust overgeslagen.",
  };
}

/* ------------------------------------------------------------------ */
/* Budget-runner met harde eindgarantie                                */
/* ------------------------------------------------------------------ */

/**
 * Voert het werk uit binnen het tijdsbudget en garandeert dat er ALTIJD binnen
 * LIDO_TOOL_BUDGET_MS iets wordt teruggegeven. Bij overschrijding wordt de
 * fallback gebruikt: een geldig gedeeltelijk resultaat in plaats van een
 * hangende request die door de MCP-client als "expired" wordt gezien.
 */
async function runLidoTool<T>(work: (state: CrawlState) => Promise<T>, fallback: (state: CrawlState) => T): Promise<T> {
  const state = newCrawlState();
  const deadline = Date.now() + LIDO_TOOL_BUDGET_MS;

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    watchdog = setTimeout(() => {
      state.stopReason = "time_budget_reached";
      resolve(fallback(state));
    }, LIDO_TOOL_BUDGET_MS);
  });

  try {
    return await Promise.race([
      lidoExecution.run({ deadline }, () => work(state)).catch(() => {
        state.stopReason ??= "unrecoverable_error";
        return fallback(state);
      }),
      guard,
    ]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}

/* ------------------------------------------------------------------ */
/* Publieke source                                                     */
/* ------------------------------------------------------------------ */

export class LidoSource {
  constructor(private readonly config: AppConfig) {}

  /**
   * Haalt de LiDO-relaties op voor een bekende identifier (ECLI/BWBR/CVDR) en
   * volgt maximaal `maxFollow` gevonden identifiers naar hun primaire bron.
   *
   * De documentviewer is startpunt maar niet blokkerend: mislukt die, dan wordt
   * doorgezocht via de direct uit de identifier afgeleide URL's. `stopReason`
   * meldt dat als "document_viewer_fetch_failed".
   */
  async relationsByIdentifier(args: { identifier: string; maxFollow?: number }): Promise<LidoResult> {
    const identifier = args.identifier.trim();
    const maxFollow = args.maxFollow ?? 5;
    const endpointUrl = new URL(DOCUMENT_VIEWER_URL);
    endpointUrl.searchParams.set("ext-id", identifier);
    const endpoint = endpointUrl.toString();
    const params = { "ext-id": identifier };

    let viewerUrl = endpoint;
    let viewerNote: string | undefined;

    const toResult = (state: CrawlState): LidoResult => {
      const inv = summarize(state, identifier);
      const item = buildItem(
        inv,
        {
          id: identifier,
          title: `LiDO-relaties voor ${identifier}`,
          link: viewerUrl,
          identifier,
          lidoPageUrl: viewerUrl,
          lido_page_url: viewerUrl,
        },
        viewerNote ? { key: "viewer_note", value: viewerNote } : undefined,
      );

      return {
        items: [item],
        total: inv.relationsExtracted,
        endpoint,
        params,
        ...(inv.relationsExtracted === 0
          ? { access_note: "Geen relaties gevonden na het volgen van componenten en relatiepagina's." }
          : {}),
      };
    };

    await loadCheerio();

    return runLidoTool(
      async (state) => {
        const direct = buildDirectLidoUrls(identifier);

        // Scope: alleen relatiepagina's over dit object worden gevolgd.
        if (direct.objectUri) state.scope.add(normalizeObjectUri(direct.objectUri));
        state.scope.add(normalizeObjectUri(identifier));

        const seeds: string[] = [...direct.urls];
        const requestOptions: { headers?: Record<string, string> } = {};

        try {
          const viewer = await fetchLidoPage(endpoint);
          viewerUrl = viewer.url;
          state.contentType = viewer.contentType;
          state.readableSnippet = clip(htmlToText(viewer.rawHtml), READABLE_SNIPPET_CHARACTERS);
          const cookie = viewer.setCookies.map((v) => v.split(";", 1)[0]).join("; ");
          requestOptions.headers = { Referer: viewer.url, ...(cookie ? { Cookie: cookie } : {}) };
          const found = ingestPage(state, viewer);
          seeds.unshift(...found.components, ...found.relationPages);
        } catch (error) {
          const detail = asError(error);
          // Een afgebroken request door het tijdsbudget is géén viewer-fout.
          state.stopReason = /LIDO_TIME_BUDGET_REACHED|aborted|AbortError/i.test(detail)
            ? "time_budget_reached"
            : "document_viewer_fetch_failed";
          state.componentResults.push({ url: endpoint, error: detail });
          viewerNote = `De LiDO-documentviewer kon niet worden opgehaald (${detail}); er is doorgezocht via de directe component- en relatiepagina-URL's.`;
        }

        await crawlLido(state, seeds, requestOptions);

        if (!state.readableSnippet && state.identifierSources.length) {
          state.readableSnippet = clip(htmlToText(state.identifierSources[0]), READABLE_SNIPPET_CHARACTERS);
        }

        const ids = mergeIdentifiers(state.identifierSources.map((raw) => extractIdentifiers(raw)));
        await followCandidates(state, candidatesFromState(state, ids, identifier), maxFollow);

        return toResult(state);
      },
      (state) => toResult(state),
    );
  }

  /** Zoekt in LiDO op vrije tekst wanneer geen formele identifier bekend is. */
  async searchFreeText(args: { query: string; maxFollow?: number }): Promise<LidoResult> {
    const query = args.query.trim();
    const maxFollow = args.maxFollow ?? 5;
    const endpointUrl = new URL(SEARCH_URL);
    endpointUrl.searchParams.set("inputtext", query);
    const endpoint = endpointUrl.toString();
    const params = { inputtext: query };

    let pageUrl = endpoint;
    let pageNote: string | undefined;

    const toResult = (state: CrawlState): LidoResult => {
      const inv = summarize(state, null);
      const item = buildItem(
        inv,
        {
          id: query,
          title: `LiDO-zoekresultaat: ${query}`,
          link: pageUrl,
          query,
          lidoPageUrl: pageUrl,
          lido_search_url: pageUrl,
        },
        pageNote ? { key: "search_note", value: pageNote } : undefined,
      );

      return {
        items: [item],
        total: inv.relationsExtracted,
        endpoint,
        params,
        ...(inv.relationsExtracted === 0
          ? { access_note: "Geen relaties gevonden in de LiDO-zoekresultaten." }
          : {}),
      };
    };

    await loadCheerio();

    return runLidoTool(
      async (state) => {
        const seeds: string[] = [];
        try {
          const page = await fetchLidoPage(endpoint);
          pageUrl = page.url;
          state.contentType = page.contentType;
          state.readableSnippet = clip(htmlToText(page.rawHtml), READABLE_SNIPPET_CHARACTERS);
          const found = ingestPage(state, page);
          seeds.push(...found.components, ...found.relationPages);
        } catch (error) {
          pageNote = `De LiDO-zoekpagina kon niet worden opgehaald: ${asError(error)}`;
          state.stopReason ??= "search_page_fetch_failed";
          return toResult(state);
        }

        // De eerste treffers zijn zelf LiDO-documenten; die worden in scope
        // genomen zodat hun relatiepagina's wél gevolgd mogen worden.
        const seedIds = extractIdentifiers(state.identifierSources.join("\n"));
        for (const ecli of seedIds.eclis.slice(0, 3)) {
          const direct = buildDirectLidoUrls(ecli);
          if (direct.objectUri) state.scope.add(normalizeObjectUri(direct.objectUri));
          state.scope.add(normalizeObjectUri(ecli));
          seeds.push(...direct.urls);
        }

        await crawlLido(state, seeds, {});

        const ids = mergeIdentifiers(state.identifierSources.map((raw) => extractIdentifiers(raw)));
        await followCandidates(state, candidatesFromState(state, ids, null), maxFollow);

        return toResult(state);
      },
      (state) => toResult(state),
    );
  }
}
