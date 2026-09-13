import type { AppConfig } from "../types.js";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * LiDO (Linked Data Overheid) source voor NL-GOV-MCP.
 *
 * Geavanceerde versie: volgt niet alleen de documentviewer-/zoekpagina,
 * maar ook de daarin gevonden documentcomponenten en relatiepagina's
 * (incl. paginering), tot een tijdsbudget en tot configureerbare limieten.
 * Dit is een 1-op-1 poort van de LiDO-logica uit de verwijzingscontroleur
 * (server.js), aangepast naar TypeScript/regex (geen cheerio-dependency
 * in dit project) en naar de class-stijl van RechtspraakSource.
 */

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

interface Relation {
  kind: "ecli" | "bwbr" | "cvdr" | "celex" | "official-url";
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

const LIDO_ORIGIN = "https://linkeddata.overheid.nl";
const DOCUMENT_VIEWER_URL = `${LIDO_ORIGIN}/front/portal/document-viewer`;
const SEARCH_URL = `${LIDO_ORIGIN}/front/portal/lido-lx`;

const ECLI_RE = /ECLI:[A-Z]{2}:[A-Z0-9.]+:[0-9]{4}:[A-Z0-9.]+/gi;
const BWBR_RE = /BWBR[0-9]{6,8}/gi;
const CVDR_RE = /CVDR[0-9]{5,8}(?:_[0-9]+)?/gi;
const CELEX_RE = /CELEX:[0-9A-Z][0-9]{4}[A-Z]{1,2}[0-9]{4}(?:\([0-9]{2}\))?/gi;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const LINK_RE = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const COMPONENT_RE = /\/component\/(?:get-document-with-refs-html|item-text-with-links)/i;
const RELATION_PAGE_RE = /\/front\/portal\/spiegel-lijstweergave/i;
const NEXT_PAGE_RE = /volgende|next|pagination/i;

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

const lidoExecution = new AsyncLocalStorage<{ deadline: number }>();

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function asError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractIdentifiers(raw: string): Identifiers {
  return {
    eclis: unique((raw.match(ECLI_RE) ?? []).map((m) => m.toUpperCase())),
    bwbrs: unique((raw.match(BWBR_RE) ?? []).map((m) => m.toUpperCase())),
    cvdrs: unique((raw.match(CVDR_RE) ?? []).map((m) => m.toUpperCase())),
    celexes: unique((raw.match(CELEX_RE) ?? []).map((m) => m.toUpperCase())),
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
  for (const m of raw.matchAll(LINK_RE)) {
    try {
      out.push(new URL(m[1], base).toString());
    } catch {
      // ongeldige/relatieve link overslaan
    }
  }
  for (const m of raw.matchAll(URL_RE)) {
    try {
      out.push(new URL(m[0].replace(/&amp;/g, "&"), base).toString());
    } catch {
      // negeren
    }
  }
  return unique(out);
}

function discoverLidoTargets(raw: string, base: string) {
  const urls = extractUrls(raw, base);
  return {
    components: urls.filter((u) => COMPONENT_RE.test(u)),
    relationPages: urls.filter((u) => RELATION_PAGE_RE.test(u)),
  };
}

function findNextRelationPages(raw: string, base: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(LINK_RE)) {
    const href = m[1];
    const label = stripHtml(m[2] ?? "").toLowerCase();
    if (NEXT_PAGE_RE.test(label)) {
      try {
        const u = new URL(href, base).toString();
        if (RELATION_PAGE_RE.test(u)) out.push(u);
      } catch {
        // negeren
      }
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
    const href = m[1];
    let url: string;
    try {
      url = new URL(href, base).toString();
    } catch {
      continue;
    }
    const description = stripHtml(m[2] ?? "");
    const ids = extractIdentifiers(`${description} ${url}`);
    for (const identifier of ids.eclis) found.push({ kind: "ecli", identifier, url, description, sourceUrl });
    for (const identifier of ids.bwbrs) found.push({ kind: "bwbr", identifier, url, description, sourceUrl });
    for (const identifier of ids.cvdrs) found.push({ kind: "cvdr", identifier, url, description, sourceUrl });
    for (const identifier of ids.celexes) found.push({ kind: "celex", identifier, url, description, sourceUrl });
    if (!ids.eclis.length && !ids.bwbrs.length && !ids.cvdrs.length && !ids.celexes.length) {
      try {
        if (ALLOWED_HOSTS.has(new URL(url).hostname.toLowerCase())) {
          found.push({ kind: "official-url", url, description, sourceUrl });
        }
      } catch {
        // negeren
      }
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

async function fetchLidoPage(
  url: string,
  options: { headers?: Record<string, string> } = {},
): Promise<{ url: string; contentType: string; rawHtml: string; setCookies: string[] }> {
  const parsed = new URL(url);
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Domein niet toegestaan: ${parsed.hostname}`);
  }

  const execution = lidoExecution.getStore();
  const remaining = execution ? execution.deadline - Date.now() : 20_000;
  if (remaining <= 250) throw new Error("LIDO_TIME_BUDGET_REACHED");
  const timeoutMs = Math.max(250, Math.min(9_000, remaining - 100));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        ...(options.headers ?? {}),
      },
    });

    const body = await response.text();

    if (!response.ok) {
      throw new Error(`LiDO gaf HTTP ${response.status}: ${body.slice(0, 500)}`);
    }

    const setCookies =
      typeof (response.headers as any).getSetCookie === "function"
        ? (response.headers as any).getSetCookie()
        : response.headers.get("set-cookie")
          ? [response.headers.get("set-cookie") as string]
          : [];

    return { url: response.url || url, contentType: response.headers.get("content-type") ?? "", rawHtml: body, setCookies };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const n = i++;
      if (n >= items.length) return;
      try {
        out[n] = await fn(items[n]);
      } catch (error) {
        out[n] = { url: items[n], error: asError(error) } as unknown as R;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function buildDirectLidoUrls(identifier: string) {
  const id = identifier.trim();
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

const MAX_LIDO_RELATIONS = 5000;
const MAX_LIDO_RELATION_PAGES = 50;
const MAX_LIDO_COMPONENTS = 20;
const MAX_CONCURRENCY = 3;
const LIDO_TOOL_BUDGET_MS = 30_000;

async function inventoryLido(seedPage: { url: string; rawHtml: string }) {
  const execution = lidoExecution.getStore();
  const timeBudgetReached = () => Boolean(execution && Date.now() >= execution.deadline - 500);
  let stopReason: string | null = null;

  const reportedRelationCount = parseReportedRelationCount(seedPage.rawHtml);
  const initial = discoverLidoTargets(seedPage.rawHtml, seedPage.url);
  const componentUrls = unique(initial.components).slice(0, MAX_LIDO_COMPONENTS);
  const components: Array<{ url: string; contentType?: string; rawHtml?: string; error?: string }> = [];

  for (
    const batchStart of Array.from(
      { length: Math.ceil(componentUrls.length / MAX_CONCURRENCY) },
      (_, i) => i * MAX_CONCURRENCY,
    )
  ) {
    if (timeBudgetReached()) {
      stopReason = "time_budget_reached";
      break;
    }
    const batch = componentUrls.slice(batchStart, batchStart + MAX_CONCURRENCY);
    components.push(...(await mapLimit(batch, MAX_CONCURRENCY, (u) => fetchLidoPage(u))));
  }

  let relationQueue = unique([
    ...initial.relationPages,
    ...components.flatMap((c) => (c.rawHtml ? discoverLidoTargets(c.rawHtml, c.url).relationPages : [])),
  ]);
  const relationPages: Array<{ url: string; contentType?: string; error?: string }> = [];
  const visited = new Set<string>();
  let relations: Relation[] = [];

  while (relationQueue.length && relationPages.length < MAX_LIDO_RELATION_PAGES && relations.length < MAX_LIDO_RELATIONS) {
    if (timeBudgetReached()) {
      stopReason = "time_budget_reached";
      break;
    }
    const url = relationQueue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      const p = await fetchLidoPage(url);
      relationPages.push({ url: p.url, contentType: p.contentType });
      relations.push(...extractRelations(p.rawHtml, p.url, p.url));
      relationQueue.push(...findNextRelationPages(p.rawHtml, p.url).filter((u) => !visited.has(u)));
    } catch (error) {
      relationPages.push({ url, error: asError(error) });
    }
  }

  relations.push(...extractRelations(seedPage.rawHtml, seedPage.url, seedPage.url));
  for (const c of components) if (c.rawHtml) relations.push(...extractRelations(c.rawHtml, c.url, c.url));

  const dedup: Relation[] = [];
  const seen = new Set<string>();
  for (const r of relations) {
    const k = relationKey(r);
    if (!seen.has(k)) {
      seen.add(k);
      dedup.push(r);
    }
    if (dedup.length >= MAX_LIDO_RELATIONS) break;
  }

  const ids = mergeIdentifiers([
    extractIdentifiers(seedPage.rawHtml),
    ...components.filter((c) => c.rawHtml).map((c) => extractIdentifiers(c.rawHtml as string)),
    extractIdentifiers(JSON.stringify(dedup)),
  ]);

  const fullByReported = reportedRelationCount !== null && dedup.length >= reportedRelationCount;
  const capped = dedup.length >= MAX_LIDO_RELATIONS || relationPages.length >= MAX_LIDO_RELATION_PAGES;
  if (!stopReason && capped) stopReason = "configured_limit_reached";

  return {
    reportedRelationCount,
    relationsExtracted: dedup.length,
    relationPagesFetched: relationPages.length,
    documentComponentsFetched: components.filter((c) => c.rawHtml).length,
    partialResult: reportedRelationCount === null ? true : !fullByReported,
    limitReached: capped,
    stopReason,
    discoveredIdentifiers: ids,
    relations: dedup,
    componentResults: components.map((c) => (c.error ? c : { url: c.url, contentType: c.contentType })),
    relationPageResults: relationPages,
  };
}

function normalizeIdentifier(v: string): string {
  return v.trim().toUpperCase();
}

function candidatesFromInventory(
  inv: Awaited<ReturnType<typeof inventoryLido>>,
  exclude: string,
): Array<{ kind: "ecli" | "bwbr" | "cvdr" | "celex"; value: string }> {
  const ex = normalizeIdentifier(exclude);
  const out: Array<{ kind: "ecli" | "bwbr" | "cvdr" | "celex"; value: string }> = [];

  for (const r of inv.relations) {
    if (r.identifier && normalizeIdentifier(r.identifier) !== ex && ["ecli", "bwbr", "cvdr", "celex"].includes(r.kind)) {
      out.push({ kind: r.kind as "ecli" | "bwbr" | "cvdr" | "celex", value: r.identifier });
    }
  }

  for (const [plural, kind] of [
    ["eclis", "ecli"],
    ["bwbrs", "bwbr"],
    ["cvdrs", "cvdr"],
    ["celexes", "celex"],
  ] as const) {
    for (const value of inv.discoveredIdentifiers[plural]) {
      if (normalizeIdentifier(value) !== ex) out.push({ kind, value });
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

async function runLidoTool<T>(work: () => Promise<T>): Promise<T> {
  return lidoExecution.run({ deadline: Date.now() + LIDO_TOOL_BUDGET_MS }, work);
}

export class LidoSource {
  constructor(private readonly config: AppConfig) {}

  /**
   * Haal de LiDO-documentviewer op voor een bekende identifier, volg de
   * daarin gevonden documentcomponenten en relatiepagina's (met paginering),
   * en geef de unieke gevonden relaties (ECLI/BWBR/CVDR/CELEX) terug.
   */
  async relationsByIdentifier(args: { identifier: string; maxFollow?: number }): Promise<LidoResult> {
    const identifier = args.identifier.trim();
    const maxFollow = args.maxFollow ?? 5;

    return runLidoTool(async () => {
      const url = new URL(DOCUMENT_VIEWER_URL);
      url.searchParams.set("ext-id", identifier);

      let viewer;
      try {
        viewer = await fetchLidoPage(url.toString());
      } catch (error) {
        return {
          items: [] as LidoItem[],
          total: 0,
          endpoint: url.toString(),
          params: { "ext-id": identifier },
          access_note: `De LiDO-documentviewer kon niet worden opgehaald: ${asError(error)}`,
        };
      }

      const cookie = viewer.setCookies.map((v) => v.split(";", 1)[0]).join("; ");
      const discovered = discoverLidoTargets(viewer.rawHtml, viewer.url);
      const direct = buildDirectLidoUrls(identifier);
      const targetUrls = unique([...discovered.components, ...discovered.relationPages, ...direct.urls]);
      const requestOptions = { headers: { Referer: viewer.url, ...(cookie ? { Cookie: cookie } : {}) } };

      const fetched = await mapLimit(targetUrls, MAX_CONCURRENCY, (u) => fetchLidoPage(u, requestOptions));
      const successes = fetched.filter((x) => x?.rawHtml);
      const combinedHtml = [viewer.rawHtml, ...successes.map((x) => x.rawHtml)].join("\n");

      const inv = await inventoryLido({ url: viewer.url, rawHtml: combinedHtml });
      const candidates = candidatesFromInventory(inv, identifier);

      const item: LidoItem = {
        id: identifier,
        title: `LiDO-relaties voor ${identifier}`,
        link: viewer.url,
        identifier,
        lido_page_url: viewer.url,
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
        total_follow_candidates: candidates.length,
        explanation:
          inv.reportedRelationCount === null
            ? `LiDO vermeldde geen betrouwbaar totaal. ${inv.relationsExtracted} unieke relaties gevonden uit ${inv.documentComponentsFetched} componenten en ${inv.relationPagesFetched} relatiepagina's.`
            : `LiDO meldt ${inv.reportedRelationCount} relaties. ${inv.relationsExtracted} unieke relaties gevonden uit ${inv.documentComponentsFetched} componenten en ${inv.relationPagesFetched} relatiepagina's. Resultaat is ${inv.partialResult ? "gedeeltelijk" : "volledig"}.`,
        limitation:
          "LiDO-pagina's kunnen deels client-side worden opgebouwd; deze tool doorzoekt de ruwe HTML-respons op identifiers en volgt gevonden componenten/relatiepagina's tot een tijdsbudget van 30 seconden.",
      };

      return {
        items: [item],
        total: inv.relationsExtracted,
        endpoint: url.toString(),
        params: { "ext-id": identifier },
        ...(inv.relationsExtracted === 0
          ? { access_note: "Geen relaties gevonden na het volgen van componenten en relatiepagina's." }
          : {}),
      };
    });
  }

  /** Zoek op LiDO met vrije tekst wanneer geen formele identifier bekend is. */
  async searchFreeText(args: { query: string; maxFollow?: number }): Promise<LidoResult> {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("inputtext", args.query);

    return runLidoTool(async () => {
      let page;
      try {
        page = await fetchLidoPage(url.toString());
      } catch (error) {
        return {
          items: [] as LidoItem[],
          total: 0,
          endpoint: url.toString(),
          params: { inputtext: args.query },
          access_note: `De LiDO-zoekpagina kon niet worden opgehaald: ${asError(error)}`,
        };
      }

      const inv = await inventoryLido({ url: page.url, rawHtml: page.rawHtml });

      const item: LidoItem = {
        id: args.query,
        title: `LiDO-zoekresultaat: ${args.query}`,
        link: page.url,
        query: args.query,
        lido_search_url: page.url,
        reported_relation_count: inv.reportedRelationCount,
        relations_extracted: inv.relationsExtracted,
        relation_pages_fetched: inv.relationPagesFetched,
        document_components_fetched: inv.documentComponentsFetched,
        partial_result: inv.partialResult,
        stop_reason: inv.stopReason,
        discovered_identifiers: inv.discoveredIdentifiers,
        relations: inv.relations,
        limitation:
          "LiDO-zoekresultaten kunnen deels client-side worden opgebouwd; deze tool doorzoekt de ruwe HTML-respons op identifiers en volgt gevonden componenten/relatiepagina's tot een tijdsbudget van 30 seconden.",
      };

      return {
        items: [item],
        total: inv.relationsExtracted,
        endpoint: url.toString(),
        params: { inputtext: args.query },
        ...(inv.relationsExtracted === 0
          ? { access_note: "Geen relaties gevonden in de LiDO-zoekresultaten." }
          : {}),
      };
    });
  }
}
