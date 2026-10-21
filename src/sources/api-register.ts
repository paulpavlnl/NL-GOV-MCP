import type { AppConfig } from "../types.js";
import { getJson, getText } from "../utils/http.js";

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
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 1 && !stop.has(x));
}

function scoreText(text: string, query: string): number {
  const hay = text.toLowerCase();
  const terms = normalizedTerms(query);
  if (!terms.length) return 0;
  let score = 0;
  for (const t of terms) {
    if (hay.includes(t)) score += 2;
  }
  if (hay.includes(query.toLowerCase().trim())) score += 3;
  return score;
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

/** Production base URL of the API register API (servers[0] in its OpenAPI spec). */
export const API_REGISTER_API = "https://api.developer.overheid.nl/api-register/v1";
const PORTAL = "https://apis.developer.overheid.nl/apis";

/** Maps an ApiSummary (id, title, summary, description, organisation, lifecycle, adrScore) to a record item. */
export function apiSummaryToItem(raw: unknown): Record<string, unknown> {
  const a = (raw ?? {}) as Record<string, unknown>;
  const org = (a.organisation ?? {}) as Record<string, unknown>;
  const id = String(a.id ?? "");
  const url = id ? `${PORTAL}/${id}` : PORTAL;
  return {
    id,
    name: String(a.title ?? id ?? "API"),
    organization: String(org.label ?? ""),
    organization_uri: org.uri,
    description: String(a.summary ?? a.description ?? ""),
    lifecycle: a.lifecycle,
    adr_score: a.adrScore,
    url,
    portalUrl: url,
    documentation_url: url,
    source: "developer.overheid.nl-api",
  };
}

export class ApiRegisterSource {
  constructor(private readonly config: AppConfig, private readonly apiKey: string) {}

  /**
   * The official API register API (developer.overheid.nl, OpenAPI in
   * github.com/developer-overheid-nl/don-api-register): GET /apis with `q` and
   * `perPage`, the read-only key in X-Api-Key, an array of ApiSummary in return.
   * The old guess (`<portal>/api/v1/apis`) never existed, so every search fell
   * back to scraping the portal, which is now rendered client-side and yields nothing.
   */
  private async tryOfficialApi(query: string, top: number) {
    const endpoint = `${API_REGISTER_API}/apis`;
    const params = { q: query, perPage: String(Math.min(100, Math.max(1, top))) };
    try {
      const { data, meta } = await getJson<unknown>(endpoint, {
        query: params,
        headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
        timeoutMs: 10_000,
      });
      if (!Array.isArray(data)) return undefined;
      return { items: data.slice(0, top).map(apiSummaryToItem), endpoint: meta.url, params };
    } catch {
      return undefined;
    }
  }

  private async fallbackScrape(query: string, top: number) {
    const base = `${this.config.endpoints.apiRegister}/apis`;
    const seen = new Set<string>();
    const scored: Array<{ item: Record<string, unknown>; score: number }> = [];

    for (let page = 1; page <= 5; page += 1) {
      const pageUrl = page === 1 ? base : `${base}/pagina/${page}`;
      const { data } = await getText(pageUrl, {
        headers: {
          "X-API-Key": this.apiKey,
          Authorization: this.apiKey,
        },
      });

      const cards = parseCards(data);
      if (!cards.length) break;

      for (const card of cards) {
        const url = String(card.url ?? "");
        if (!url || seen.has(url)) continue;
        seen.add(url);

        const text = `${String(card.name ?? "")} ${String(card.organization ?? "")} ${String(card.description ?? "")} ${String(card.__raw_text ?? "")}`;
        const score = scoreText(text, query);
        const { __raw_text, ...clean } = card;
        scored.push({ item: clean, score });
      }
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.item.name ?? "").localeCompare(String(b.item.name ?? ""));
    });

    const items = scored
      .filter((x) => x.score > 0)
      .slice(0, top)
      .map((x) => ({ ...x.item, match_score: x.score } as Record<string, unknown>));

    return {
      items,
      endpoint: `${base} (html-fallback)`,
      params: { q: query, limit: String(top), mode: "scored-fallback" },
    };
  }

  async search(query: string, top: number) {
    const apiResult = await this.tryOfficialApi(query, top);
    if (apiResult) return apiResult;

    return this.fallbackScrape(query, top);
  }
}
