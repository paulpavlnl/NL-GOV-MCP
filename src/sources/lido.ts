import type { AppConfig } from "../types.js";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * LiDO (Linked Data Overheid) source voor NL-GOV-MCP.
 *
 * Versie 2 — gelijkgetrokken met de LiDO-logica uit de verwijzingscontroleur
 * (server.js), met drie structurele verbeteringen die de "expired"-fout
 * wegnemen:
 *
 *  1. HARDE eindgarantie. De volledige tool draait binnen een `Promise.race`
 *     met een watchdog. Loopt het budget af, dan wordt ALTIJD een geldig
 *     (gedeeltelijk) resultaat teruggegeven in plaats van te blijven hangen.
 *     Dit is het verschil tussen "partialResult: true" en "expired".
 *
 *  2. Eén gedeelde werkwachtrij. De vorige versie haalde componenten en
 *     relatiepagina's twee keer op: eerst in relationsByIdentifier en daarna
 *     nog eens in inventoryLido, die dezelfde URL's opnieuw ontdekte in de
 *     samengevoegde HTML. Dat verdubbelde de netwerktijd binnen hetzelfde
 *     budget. Nu wordt elke URL exact één keer opgehaald (visited-set).
 *
 *  3. Budget-bewuste per-fetch timeout. De per-request timeout wordt geschaald
 *     naar de resterende tijd, zodat één trage LiDO-pagina niet het hele
 *     budget opeet en er meer relatiepagina's binnen het budget passen.
 *
 * Alle limieten staan hieronder HARD GECODEERD. Er worden bewust geen
 * omgevingsvariabelen gelezen: het gedrag van deze tool is daarmee op elke
 * omgeving identiek en reproduceerbaar.
 */

/* ------------------------------------------------------------------ */
/* Configuratie — hard gecodeerd                                       */
/* ------------------------------------------------------------------ */

/** Totale wandkloktijd voor één LiDO-tool-aanroep. */
const LIDO_TOOL_BUDGET_MS = 20_000;
/** Maximale tijd voor één enkele HTTP-request naar LiDO. */
const LIDO_FETCH_TIMEOUT_MS = 6_000;
/** Veiligheidsmarge: hierna wordt niets nieuws meer gestart en wordt afgerond. */
const LIDO_WRAPUP_MS = 1_200;

/** Maximaal aantal unieke relaties dat wordt teruggegeven. */
const MAX_LIDO_RELATIONS = 5_000;
/** Maximaal aantal relatiepagina's (spiegel-lijstweergave) dat wordt opgehaald. */
const MAX_LIDO_RELATION_PAGES = 50;
/** Maximaal aantal documentcomponenten dat wordt opgehaald. */
const MAX_LIDO_COMPONENTS = 20;
/** Aantal gelijktijdige HTTP-requests naar LiDO. */
const MAX_CONCURRENCY = 4;
/** Hardlimiet op de omvang van één responsbody. */
const MAX_RESPONSE_BYTES = 8_000_000;

const LIDO_ORIGIN = "https://linkeddata.overheid.nl";
const DOCUMENT_VIEWER_URL = `${LIDO_ORIGIN}/front/portal/document-viewer`;
const SEARCH_URL = `${LIDO_ORIGIN}/front/portal/lido-lx`;

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

/* ------------------------------------------------------------------ */
/* Regex                                                               */
/* ------------------------------------------------------------------ */

const ECLI_RE = /ECLI:[A-Z]{2}:[A-Z0-9.]+:[0-9]{4}:[A-Z0-9.]+/gi;
const BWBR_RE = /BWBR[0-9]{6,8}/gi;
const CVDR_RE = /CVDR[0-9]{5,8}(?:_[0-9]+)?/gi;
const CELEX_RE = /CELEX:[0-9A-Z][0-9]{4}[A-Z]{1,2}[0-9]{4}(?:\([0-9]{2}\))?/gi;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const LINK_RE = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
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

/** True zodra er geen nieuw werk meer gestart mag worden. */
function budgetExhausted(): boolean {
  return remainingMs() <= LIDO_WRAPUP_MS;
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

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
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

function extractUrls(raw: string, base: string): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    try {
      out.push(new URL(value.replace(/&amp;/g, "&"), base).toString());
    } catch {
      /* ongeldige URL overslaan */
    }
  };
  for (const m of raw.matchAll(LINK_RE)) push(m[1]);
  for (const m of raw.matchAll(URL_RE)) push(m[0]);
  // Relatieve component-/relatiepagina-URL's die in JS-snippets staan.
  for (const m of raw.matchAll(REL_URL_RE)) push(m[0]);
  return unique(out);
}

function isAllowedHost(url: string): boolean {
  try {
    return ALLOWED_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function discoverLidoTargets(raw: string, base: string): { components: string[]; relationPages: string[] } {
  const urls = extractUrls(raw, base).filter(isAllowedHost);
  return {
    components: urls.filter((u) => COMPONENT_RE.test(u)),
    relationPages: urls.filter((u) => RELATION_PAGE_RE.test(u)),
  };
}

function findNextRelationPages(raw: string, base: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(LINK_RE)) {
    const label = stripHtml(m[2] ?? "").toLowerCase();
    if (!NEXT_PAGE_RE.test(label)) continue;
    try {
      const u = new URL(m[1], base).toString();
      if (RELATION_PAGE_RE.test(u)) out.push(u);
    } catch {
      /* negeren */
    }
  }
  return unique(out);
}

function relationKey(r: Relation): string {
  return `${r.kind}|${r.identifier ?? ""}|${r.url ?? ""}|${r.description}`;
}

function extractRelations(raw: string, base: string, sourceUrl: string): Relation[] {
  const found: Relation[] = [];

  for (const m of raw.matchAll(LINK_RE)) {
    let url: string;
    try {
      url = new URL(m[1], base).toString();
    } catch {
      continue;
    }
    const description = stripHtml(m[2] ?? "");
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

function parseReportedRelationCount(raw: string): number | null {
  const text = stripHtml(raw);
  const patterns = [/Relaties\s+([0-9][0-9.\s]*)/i, /([0-9][0-9.\s]*)\s+relaties/i];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = Number(m[1].replace(/[^0-9]/g, ""));
      if (Number.isSafeInteger(n)) return n;
    }
  }
  return null;
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

async function fetchLidoPage(url: string, options: { headers?: Record<string, string> } = {}): Promise<FetchedPage> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Alleen HTTPS is toegestaan.");
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Domein niet toegestaan: ${parsed.hostname}`);
  }

  const remaining = remainingMs();
  if (remaining <= LIDO_WRAPUP_MS) throw new Error("LIDO_TIME_BUDGET_REACHED");
  const timeoutMs = Math.max(500, Math.min(LIDO_FETCH_TIMEOUT_MS, remaining - LIDO_WRAPUP_MS));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        "Accept-Language": "nl",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
        ...(options.headers ?? {}),
      },
    });

    const body = await readLimitedBody(response);
    if (!response.ok) throw new Error(`LiDO gaf HTTP ${response.status}: ${body.slice(0, 400)}`);

    const anyHeaders = response.headers as unknown as { getSetCookie?: () => string[] };
    const setCookies =
      typeof anyHeaders.getSetCookie === "function"
        ? anyHeaders.getSetCookie()
        : response.headers.get("set-cookie")
          ? [response.headers.get("set-cookie") as string]
          : [];

    return {
      url: response.url || url,
      contentType: response.headers.get("content-type") ?? "",
      rawHtml: body,
      setCookies,
    };
  } finally {
    clearTimeout(timer);
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
  reportedRelationCount: number | null;
  stopReason: string | null;
  limitReached: boolean;
}

function newCrawlState(): CrawlState {
  return {
    relations: new Map(),
    identifierSources: [],
    componentResults: [],
    relationPageResults: [],
    componentsFetched: 0,
    relationPagesFetched: 0,
    reportedRelationCount: null,
    stopReason: null,
    limitReached: false,
  };
}

function ingestPage(state: CrawlState, page: FetchedPage): { components: string[]; relationPages: string[] } {
  state.identifierSources.push(page.rawHtml);

  if (state.reportedRelationCount === null) {
    state.reportedRelationCount = parseReportedRelationCount(page.rawHtml);
  }

  for (const relation of extractRelations(page.rawHtml, page.url, page.url)) {
    if (state.relations.size >= MAX_LIDO_RELATIONS) {
      state.limitReached = true;
      break;
    }
    const key = relationKey(relation);
    if (!state.relations.has(key)) state.relations.set(key, relation);
  }

  const discovered = discoverLidoTargets(page.rawHtml, page.url);
  return {
    components: discovered.components,
    relationPages: unique([...discovered.relationPages, ...findNextRelationPages(page.rawHtml, page.url)]),
  };
}

/**
 * Haalt alle LiDO-componenten en relatiepagina's op vanaf een set start-URL's.
 * Elke URL wordt maximaal één keer opgehaald. Stopt netjes op budget of limiet.
 */
async function crawlLido(
  state: CrawlState,
  seedUrls: string[],
  requestOptions: { headers?: Record<string, string> },
): Promise<void> {
  const visited = new Set<string>();
  const queue = unique(seedUrls).filter(isAllowedHost);

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
        if (entry.error === "LIDO_TIME_BUDGET_REACHED") state.stopReason = "time_budget_reached";
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

  const reported = state.reportedRelationCount;
  const fullByReported = reported !== null && relations.length >= reported;
  const partial = reported === null ? true : !fullByReported || state.stopReason !== null;

  const ex = identifier ? normalizeIdentifier(identifier) : null;
  const followCandidates = new Set<string>();
  for (const r of relations) {
    if (!r.identifier || r.kind === "official-url") continue;
    if (ex && normalizeIdentifier(r.identifier) === ex) continue;
    followCandidates.add(`${r.kind}|${r.identifier}`);
  }
  for (const [plural, kind] of [
    ["eclis", "ecli"],
    ["bwbrs", "bwbr"],
    ["cvdrs", "cvdr"],
    ["celexes", "celex"],
  ] as const) {
    for (const value of ids[plural]) {
      if (ex && normalizeIdentifier(value) === ex) continue;
      followCandidates.add(`${kind}|${value}`);
    }
  }

  return {
    reportedRelationCount: reported,
    relationsExtracted: relations.length,
    relationPagesFetched: state.relationPagesFetched,
    documentComponentsFetched: state.componentsFetched,
    partialResult: partial,
    limitReached: state.limitReached,
    stopReason: state.stopReason,
    discoveredIdentifiers: ids,
    relations,
    componentResults: state.componentResults,
    relationPageResults: state.relationPageResults,
    totalFollowCandidates: followCandidates.size,
    limits: {
      toolBudgetMs: LIDO_TOOL_BUDGET_MS,
      fetchTimeoutMs: LIDO_FETCH_TIMEOUT_MS,
      wrapUpMs: LIDO_WRAPUP_MS,
      maxRelations: MAX_LIDO_RELATIONS,
      maxRelationPages: MAX_LIDO_RELATION_PAGES,
      maxComponents: MAX_LIDO_COMPONENTS,
      concurrency: MAX_CONCURRENCY,
    },
    explanation:
      reported === null
        ? `LiDO vermeldde geen betrouwbaar totaal. De server las ${relations.length} unieke relatieverwijzingen uit ${state.componentsFetched} componenten en ${state.relationPagesFetched} relatiepagina's. Stopreden: ${state.stopReason ?? "geen"}.`
        : `LiDO meldt ${reported} relaties. De server las ${relations.length} unieke relatieverwijzingen uit ${state.componentsFetched} componenten en ${state.relationPagesFetched} relatiepagina's. Het resultaat is ${partial ? "gedeeltelijk" : "volledig volgens het gemelde totaal"}. Stopreden: ${state.stopReason ?? "geen"}.`,
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
   * Haalt de LiDO-relaties op voor een bekende identifier (ECLI/BWBR/CVDR).
   *
   * De documentviewer wordt gebruikt als startpunt, maar is niet blokkerend:
   * mislukt die, dan wordt alsnog doorgezocht via de directe component- en
   * relatiepagina-URL's die uit de identifier worden afgeleid. Zo levert de
   * tool ook bij een trage of falende viewer nog links op.
   */
  async relationsByIdentifier(args: { identifier: string; maxFollow?: number }): Promise<LidoResult> {
    const identifier = args.identifier.trim();
    const endpointUrl = new URL(DOCUMENT_VIEWER_URL);
    endpointUrl.searchParams.set("ext-id", identifier);
    const endpoint = endpointUrl.toString();
    const params = { "ext-id": identifier };

    let viewerUrl = endpoint;
    let viewerNote: string | undefined;

    const toResult = (state: CrawlState): LidoResult => {
      const inv = summarize(state, identifier);
      const item: LidoItem = {
        id: identifier,
        title: `LiDO-relaties voor ${identifier}`,
        link: viewerUrl,
        identifier,
        lido_page_url: viewerUrl,
        reported_relation_count: inv.reportedRelationCount,
        relations_extracted: inv.relationsExtracted,
        relation_pages_fetched: inv.relationPagesFetched,
        document_components_fetched: inv.documentComponentsFetched,
        partial_result: inv.partialResult,
        limit_reached: inv.limitReached,
        stop_reason: inv.stopReason,
        discovered_identifiers: inv.discoveredIdentifiers,
        relations: inv.relations,
        component_results: inv.componentResults,
        relation_page_results: inv.relationPageResults,
        total_follow_candidates: inv.totalFollowCandidates,
        limits: inv.limits,
        explanation: inv.explanation,
        ...(viewerNote ? { viewer_note: viewerNote } : {}),
        limitation:
          "LiDO-pagina's worden deels client-side opgebouwd. Deze tool doorzoekt de ruwe HTML van de documentviewer, de documentcomponenten en de relatiepagina's (inclusief paginering) tot het tijdsbudget of de ingestelde limieten zijn bereikt.",
      };

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

    return runLidoTool(
      async (state) => {
        const direct = buildDirectLidoUrls(identifier);
        const seeds: string[] = [...direct.urls];
        const requestOptions: { headers?: Record<string, string> } = {};

        try {
          const viewer = await fetchLidoPage(endpoint);
          viewerUrl = viewer.url;
          const cookie = viewer.setCookies.map((v) => v.split(";", 1)[0]).join("; ");
          requestOptions.headers = { Referer: viewer.url, ...(cookie ? { Cookie: cookie } : {}) };
          const found = ingestPage(state, viewer);
          seeds.unshift(...found.components, ...found.relationPages);
        } catch (error) {
          viewerNote = `De LiDO-documentviewer kon niet worden opgehaald (${asError(error)}); er is doorgezocht via de directe component- en relatiepagina-URL's.`;
        }

        await crawlLido(state, seeds, requestOptions);
        return toResult(state);
      },
      (state) => toResult(state),
    );
  }

  /** Zoekt in LiDO op vrije tekst wanneer geen formele identifier bekend is. */
  async searchFreeText(args: { query: string; maxFollow?: number }): Promise<LidoResult> {
    const query = args.query.trim();
    const endpointUrl = new URL(SEARCH_URL);
    endpointUrl.searchParams.set("inputtext", query);
    const endpoint = endpointUrl.toString();
    const params = { inputtext: query };

    let pageUrl = endpoint;
    let pageNote: string | undefined;

    const toResult = (state: CrawlState): LidoResult => {
      const inv = summarize(state, null);
      const item: LidoItem = {
        id: query,
        title: `LiDO-zoekresultaat: ${query}`,
        link: pageUrl,
        query,
        lido_search_url: pageUrl,
        reported_relation_count: inv.reportedRelationCount,
        relations_extracted: inv.relationsExtracted,
        relation_pages_fetched: inv.relationPagesFetched,
        document_components_fetched: inv.documentComponentsFetched,
        partial_result: inv.partialResult,
        limit_reached: inv.limitReached,
        stop_reason: inv.stopReason,
        discovered_identifiers: inv.discoveredIdentifiers,
        relations: inv.relations,
        component_results: inv.componentResults,
        relation_page_results: inv.relationPageResults,
        total_follow_candidates: inv.totalFollowCandidates,
        limits: inv.limits,
        explanation: inv.explanation,
        ...(pageNote ? { search_note: pageNote } : {}),
        limitation:
          "LiDO-zoekresultaten worden deels client-side opgebouwd. Deze tool doorzoekt de ruwe HTML-respons op identifiers en volgt gevonden componenten en relatiepagina's tot het tijdsbudget of de ingestelde limieten zijn bereikt.",
      };

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

    return runLidoTool(
      async (state) => {
        const seeds: string[] = [];
        try {
          const page = await fetchLidoPage(endpoint);
          pageUrl = page.url;
          const found = ingestPage(state, page);
          seeds.push(...found.components, ...found.relationPages);
        } catch (error) {
          pageNote = `De LiDO-zoekpagina kon niet worden opgehaald: ${asError(error)}`;
          state.stopReason ??= "search_page_fetch_failed";
          return toResult(state);
        }

        // Identifiers uit de zoekresultaten kunnen zelf weer LiDO-documenten zijn.
        const ids = extractIdentifiers(state.identifierSources.join("\n"));
        for (const ecli of ids.eclis.slice(0, 3)) seeds.push(...buildDirectLidoUrls(ecli).urls);

        await crawlLido(state, seeds, {});
        return toResult(state);
      },
      (state) => toResult(state),
    );
  }
}
