import type { AppConfig } from "../types.js";
import { getJson, getText, SourceRequestError } from "../utils/http.js";

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedTerms(query: string): string[] {
  const stop = new Set(["de", "het", "een", "en", "of", "voor", "van", "api", "apis", "welke", "is", "er"]);
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 1 && !stop.has(x));
  return [...new Set(terms)];
}

/** The text of one entry per field, in the order the ranking weighs them. */
interface RankFields {
  title: string;
  summary: string;
  /** Description, organisation and any other text of the entry. */
  other: string;
}

/**
 * Ranks entries on the query terms by field: first the number of terms in the
 * title, then the number in title or summary, then the number anywhere. So a
 * title that carries the terms comes first, a summary next, description and
 * organisation last, and within each tier more terms rank above fewer. The
 * three counts are folded into one number (base terms+1) for sorting and as
 * `match_score`; 0 means no term matched.
 */
function rankScore(fields: RankFields, terms: string[]): number {
  if (!terms.length) return 0;
  const title = fields.title.toLowerCase();
  const summary = fields.summary.toLowerCase();
  const other = fields.other.toLowerCase();
  let inTitle = 0;
  let inTitleOrSummary = 0;
  let anywhere = 0;
  for (const t of terms) {
    const t1 = title.includes(t);
    const t2 = t1 || summary.includes(t);
    const t3 = t2 || other.includes(t);
    if (t1) inTitle += 1;
    if (t2) inTitleOrSummary += 1;
    if (t3) anywhere += 1;
  }
  const base = terms.length + 1;
  return (inTitle * base + inTitleOrSummary) * base + anywhere;
}

/** Highest score first; equal scores keep the order the register listed them in. */
function rankItems(scored: Array<{ item: Record<string, unknown>; score: number }>, top: number): Array<Record<string, unknown>> {
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top)
    .map((x) => ({ ...x.item, match_score: x.score }));
}

function parseCards(pageHtml: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const cardRegex = /<li[^>]*>[\s\S]*?<div class="rhc-card-as-link[\s\S]*?<\/li>/gi;
  const cards = pageHtml.match(cardRegex) ?? [];

  for (const card of cards) {
    const titleMatch = card.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const linkCandidates = Array.from(
      card.matchAll(
        /href="(https:\/\/apis\.developer\.overheid\.nl\/apis\/[A-Za-z0-9_\-]+)"/gi,
      ),
    )
      .map((m) => m[1])
      .filter((u) => !u.includes("/apis/toevoegen") && !u.endsWith("/apis"));
    const link = linkCandidates.length
      ? linkCandidates[linkCandidates.length - 1]
      : "";
    const orgMatch = card.match(
      /class="_badgeLink[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const descMatch = card.match(
      /<div class="description[^"]*">([\s\S]*?)<\/div>/i,
    );
    const versionMatch = card.match(
      /<div class="version"[^>]*>\s*Versie\s*([\s\S]*?)<\/div>/i,
    );

    const title = titleMatch ? stripTags(titleMatch[1]) : "";
    const url = link;
    const organization = orgMatch ? stripTags(orgMatch[1]) : "";
    const description = descMatch ? stripTags(descMatch[1]) : "";
    const version = versionMatch ? stripTags(versionMatch[1]) : "";

    if (!title || !url) continue;

    out.push({
      id: url.split("/").pop(),
      name: title,
      organization,
      description,
      version,
      url,
      documentation_url: url,
      api_type: "unknown",
      source: "developer.overheid.nl-html",
      __raw_text: stripTags(card),
    });
  }

  return out;
}

/** Connector of the JSON API. */
export const API_REGISTER_CONNECTOR = "api_register";
/** Connector of the public website pages, the path when the JSON API cannot be used. */
export const API_REGISTER_PAGES_CONNECTOR = "api_register_pages";

/** JSON API of the register (OpenAPI: <base>/openapi.json); used when the config names none. */
const DEFAULT_API_BASE = "https://api.developer.overheid.nl/api-register/v1";
/** The API's largest page. */
const LIST_PAGE_SIZE = 100;
/** Hard cap on list pages when the register is listed in full (about 300 entries in 2026). */
const MAX_LIST_PAGES = 5;

type ApiResult = { items: Array<Record<string, unknown>>; endpoint: string; params: Record<string, string> };

function listOf(data: unknown, endpoint: string): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  const obj = (data ?? {}) as Record<string, unknown>;
  const list = obj.items ?? obj.apis;
  if (Array.isArray(list)) return list as Array<Record<string, unknown>>;
  throw new SourceRequestError({
    message: "API register answered without a list of APIs",
    endpoint,
    code: "malformed_response",
  });
}

/**
 * The failures for which the public HTML pages are a degraded path: the API is
 * unreachable, broken (5xx), refuses the key, or its circuit is open after such
 * failures (the pages have a circuit of their own). Anything else (404, 429, a
 * malformed body) is reported, not hidden behind a scrape.
 */
function apiUnavailable(error: unknown): boolean {
  if (!(error instanceof SourceRequestError)) return false;
  if (error.code === "network_error" || error.code === "timeout" || error.code === "circuit_open") return true;
  if (error.code !== "http_error") return false;
  const status = error.status ?? 0;
  return status >= 500 || status === 401 || status === 403;
}

export class ApiRegisterSource {
  constructor(private readonly config: AppConfig, private readonly apiKey: string) {}

  private get apiBase(): string {
    return this.config.endpoints.apiRegisterApi ?? DEFAULT_API_BASE;
  }

  /** One register entry as a record; the website page of the entry is its link. */
  private toItem(api: Record<string, unknown>): Record<string, unknown> {
    const organisation = (api.organisation ?? {}) as Record<string, unknown>;
    const lifecycle = (api.lifecycle ?? {}) as Record<string, unknown>;
    const id = typeof api.id === "string" ? api.id : undefined;
    const url = id
      ? `${this.config.endpoints.apiRegister}/apis/${encodeURIComponent(id)}`
      : typeof api.url === "string" ? api.url : undefined;
    const title = String(api.title ?? api.name ?? "");
    return {
      ...(id ? { id } : {}),
      name: title,
      title,
      ...(organisation.label ? { organization: String(organisation.label) } : {}),
      ...(organisation.uri ? { organisation_uri: String(organisation.uri) } : {}),
      description: String(api.summary ?? api.description ?? ""),
      ...(lifecycle.version ? { version: String(lifecycle.version) } : {}),
      ...(lifecycle.status ? { status: String(lifecycle.status) } : {}),
      ...(typeof api.adrScore === "number" ? { adr_score: api.adrScore } : {}),
      ...(typeof api.oasUrl === "string" ? { oas_url: api.oasUrl } : {}),
      ...(url ? { url, documentation_url: url } : {}),
      source: "api.developer.overheid.nl",
    };
  }

  private async getApis(query: Record<string, string>) {
    const { data, meta } = await getJson<unknown>(`${this.apiBase}/apis`, {
      query,
      headers: { "X-Api-Key": this.apiKey },
      connector: API_REGISTER_CONNECTOR,
    });
    return { list: listOf(data, meta.url), meta };
  }

  /**
   * The register's own search (`q`) matches API titles only, as one phrase:
   * "BAG adressen" finds nothing where "adressen" does. When it finds nothing,
   * the register is listed in full (paged, capped) and scored locally over
   * title, summary, description and organisation. A page shorter than the page
   * size is the last one.
   */
  private async tryOfficialApi(query: string, top: number): Promise<ApiResult> {
    const perPage = String(Math.min(Math.max(top, 1), LIST_PAGE_SIZE));
    const searched = await this.getApis({ q: query, perPage, page: "1" });
    if (searched.list.length) {
      return {
        items: searched.list.slice(0, top).map((api) => this.toItem(api)),
        endpoint: searched.meta.url,
        params: { q: query, perPage, mode: "api-search" },
      };
    }

    const terms = normalizedTerms(query);
    const seen = new Set<string>();
    const scored: Array<{ item: Record<string, unknown>; score: number }> = [];
    let pages = 0;
    let lastPageFull = false;
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const { list } = await this.getApis({ perPage: String(LIST_PAGE_SIZE), page: String(page) });
      pages = page;
      for (const api of list) {
        const key = String(api.id ?? api.title ?? api.name ?? "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const organisation = (api.organisation ?? {}) as Record<string, unknown>;
        const score = rankScore({
          title: String(api.title ?? api.name ?? ""),
          summary: String(api.summary ?? ""),
          other: `${String(api.description ?? "")} ${String(organisation.label ?? "")}`,
        }, terms);
        scored.push({ item: this.toItem(api), score });
      }
      lastPageFull = list.length >= LIST_PAGE_SIZE;
      if (!lastPageFull) break;
    }

    return {
      items: rankItems(scored, top),
      endpoint: `${this.apiBase}/apis`,
      params: {
        q: query,
        perPage: String(LIST_PAGE_SIZE),
        pages: String(pages),
        listed: String(seen.size),
        mode: "api-list-scored",
        ...(lastPageFull ? { list_truncated: "true" } : {}),
      },
    };
  }

  private async fallbackScrape(query: string, top: number) {
    const base = `${this.config.endpoints.apiRegister}/apis`;
    const terms = normalizedTerms(query);
    const seen = new Set<string>();
    const scored: Array<{ item: Record<string, unknown>; score: number }> = [];

    for (let page = 1; page <= 5; page += 1) {
      const pageUrl = page === 1 ? base : `${base}/pagina/${page}`;
      // Public HTML pages: the API key belongs to the JSON API only. Their own
      // connector, so failures of the JSON API cannot open the circuit for them.
      const { data } = await getText(pageUrl, { connector: API_REGISTER_PAGES_CONNECTOR });

      const cards = parseCards(data);
      if (!cards.length) break;

      for (const card of cards) {
        const url = String(card.url ?? "");
        if (!url || seen.has(url)) continue;
        seen.add(url);

        // A card carries no separate summary: its description is the summary.
        const score = rankScore({
          title: String(card.name ?? ""),
          summary: String(card.description ?? ""),
          other: `${String(card.organization ?? "")} ${String(card.__raw_text ?? "")}`,
        }, terms);
        const { __raw_text, ...clean } = card;
        scored.push({ item: clean, score });
      }
    }

    const items = rankItems(scored, top);

    return {
      items,
      endpoint: `${base} (html-fallback)`,
      params: { q: query, limit: String(top), mode: "scored-fallback" },
    };
  }

  /**
   * The JSON API answers; an empty result there is an empty result. The keyless
   * HTML pages are only read when the API cannot be used (no key, unreachable,
   * 5xx, key refused).
   */
  async search(query: string, top: number): Promise<ApiResult> {
    if (!this.apiKey) return this.fallbackScrape(query, top);
    try {
      return await this.tryOfficialApi(query, top);
    } catch (error) {
      if (!apiUnavailable(error)) throw error;
    }

    return this.fallbackScrape(query, top);
  }
}
