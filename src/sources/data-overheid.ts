import { getJson } from "../utils/http.js";
import type { AppConfig } from "../types.js";
import { appCache, makeCacheKey } from "../cache.js";

interface CkanResource {
  id: string;
  name?: string;
  format?: string;
  url?: string;
  created?: string;
  last_modified?: string;
}

interface CkanDataset {
  id: string;
  title?: string;
  notes?: string;
  metadata_modified?: string;
  organization?: { title?: string; name?: string };
  groups?: Array<{ title?: string; name?: string }>;
  license_title?: string;
  resources?: CkanResource[];
}

interface CkanSearchResponse {
  success: boolean;
  result: {
    count: number;
    results: CkanDataset[];
  };
}

interface CkanShowResponse {
  success: boolean;
  result: CkanDataset;
}

interface CkanListResponse {
  success: boolean;
  result: string[] | Array<{ name?: string; title?: string }>;
}

/** One entry of the Overheid.nl beleidsagenda taxonomy waardelijst. */
interface TaxonomyEntry {
  labels?: { "nl-NL"?: string; "en-US"?: string };
  parent?: string;
}

/** A theme surfaced by `themes()`; keeps `title`/`name` for the tool layer. */
interface ThemeItem {
  title: string;
  name: string;
  name_en: string;
  uri: string;
  parent: string;
  level: "main" | "sub";
  // Index signature so the tool layer can treat an item as Record<string, unknown>.
  [key: string]: unknown;
}

/**
 * Canonical, keyless source of data.overheid.nl themes. CKAN groups are empty
 * and the `theme` facet only lists URI fragments, so we read the Overheid.nl
 * taxonomy beleidsagenda waardelijst instead (a static vocabulary). A dataset's
 * `theme` field holds URIs of this list.
 */
const TAXONOMY_WAARDELIJST_URL =
  "https://waardelijsten.dcat-ap-donl.nl/overheid_taxonomiebeleidsagenda.json";

/**
 * A caller value as one term of a CKAN (Solr) filter query: a CKAN slug
 * ("centraal-bureau-voor-de-statistiek") as is, anything else as one quoted
 * phrase with `\` and `"` escaped. Unquoted, only the first word of
 * "Gemeente Utrecht" would be fielded and Lucene syntax in a value (OR, *:*,
 * parentheses) would change the filter. Undefined when nothing is left.
 */
export function ckanFilterValue(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  if (/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/[\\"]/g, "\\$&")}"`;
}

const CKAN_SLUG = /^[a-z0-9][a-z0-9_-]*$/;

/** Whitespace collapsed, trimmed, lower case: how caller values are compared to names. */
function folded(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export class DataOverheidSource {
  constructor(private readonly config: AppConfig) {}

  /**
   * The CKAN `organization` field holds the slug (`name`). A slug goes as is; a
   * title or name that `data_overheid_organizations` returns (case-insensitive)
   * becomes its slug(s). Anything else goes as given.
   */
  private async organizationNames(organization: string | undefined): Promise<string[]> {
    const value = (organization ?? "").replace(/\s+/g, " ").trim();
    if (!value) return [];
    if (CKAN_SLUG.test(value)) return [value];
    const wanted = folded(value);
    const { items } = await this.organizations();
    const names = items
      .filter((org) => folded(org.title) === wanted || folded(org.name) === wanted)
      .map((org) => org.name ?? "")
      .filter(Boolean);
    return names.length ? [...new Set(names)] : [value];
  }

  /**
   * A dataset's `theme` field holds URIs of the beleidsagenda waardelijst. A URI
   * goes as is; a Dutch or English label or title that `data_overheid_themes`
   * returns (case-insensitive) becomes its URI. Anything else goes as given.
   */
  private async themeUri(theme: string | undefined): Promise<string | undefined> {
    const value = (theme ?? "").replace(/\s+/g, " ").trim();
    if (!value) return undefined;
    if (/^https?:\/\//i.test(value)) return value;
    const wanted = folded(value);
    const { items } = await this.themes();
    const hit = items.find((item) => [item.name, item.name_en, item.title].some((label) => folded(label) === wanted));
    return hit?.uri ?? value;
  }

  async datasetsSearch(args: {
    query: string;
    rows: number;
    sort?: "relevance" | "date_newest";
    organization?: string;
    theme?: string;
  }): Promise<{ items: CkanDataset[]; total: number; endpoint: string; query: Record<string, string> }> {
    const queryParams: Record<string, string> = {
      q: args.query,
      rows: String(args.rows),
      ...(args.sort === "date_newest" ? { sort: "metadata_modified desc" } : {}),
    };

    const fqParts: string[] = [];
    const organizations = (await this.organizationNames(args.organization))
      .map((name) => ckanFilterValue(name))
      .filter((name): name is string => Boolean(name));
    const theme = ckanFilterValue(await this.themeUri(args.theme));
    if (organizations.length === 1) fqParts.push(`organization:${organizations[0]}`);
    if (organizations.length > 1) fqParts.push(`organization:(${organizations.join(" OR ")})`);
    if (theme) fqParts.push(`theme:${theme}`);
    if (fqParts.length) queryParams.fq = fqParts.join(" AND ");

    const endpoint = `${this.config.endpoints.dataOverheid}/package_search`;

    const cacheKey = makeCacheKey("dataOverheid:search", queryParams);
    const cached = appCache.get<{ items: CkanDataset[]; total: number; endpoint: string; query: Record<string, string> }>(cacheKey);
    if (cached) return cached;

    const { data, meta } = await getJson<CkanSearchResponse>(endpoint, {
      query: queryParams,
    });

    const result = {
      items: data.result?.results ?? [],
      total: data.result?.count ?? 0,
      endpoint: meta.url,
      query: queryParams,
    };

    appCache.set(cacheKey, result, this.config.cacheTtlMs.dataOverheidDatasetList);
    return result;
  }

  async datasetsGet(id: string): Promise<{ item: CkanDataset; endpoint: string; query: Record<string, string> }> {
    const query = { id };
    const endpoint = `${this.config.endpoints.dataOverheid}/package_show`;

    const cacheKey = makeCacheKey("dataOverheid:get", query);
    const cached = appCache.get<{ item: CkanDataset; endpoint: string; query: Record<string, string> }>(cacheKey);
    if (cached) return cached;

    const { data, meta } = await getJson<CkanShowResponse>(endpoint, { query });
    const result = {
      item: data.result,
      endpoint: meta.url,
      query,
    };

    appCache.set(cacheKey, result, this.config.cacheTtlMs.dataOverheidDatasetList);
    return result;
  }

  async organizations(): Promise<{ items: Array<{ name?: string; title?: string }>; endpoint: string }> {
    const endpoint = `${this.config.endpoints.dataOverheid}/organization_list`;
    const cacheKey = "dataOverheid:organizations";
    const cached = appCache.get<{ items: Array<{ name?: string; title?: string }>; endpoint: string }>(cacheKey);
    if (cached) return cached;

    const { data, meta } = await getJson<CkanListResponse>(endpoint, {
      query: { all_fields: true, limit: 5000 },
    });

    const raw = Array.isArray(data.result) ? data.result : [];
    const items = raw.map((x) => (typeof x === "string" ? { name: x, title: x } : x));
    const result = { items, endpoint: meta.url };
    appCache.set(cacheKey, result, this.config.cacheTtlMs.dataOverheidDatasetList);
    return result;
  }

  async themes(): Promise<{ items: ThemeItem[]; endpoint: string }> {
    const { data, meta } = await getJson<Record<string, TaxonomyEntry>>(
      TAXONOMY_WAARDELIJST_URL,
      {
        connector: "data_overheid",
        // Static vocabulary — cache for a full day.
        cacheTtlMs: 24 * 60 * 60 * 1000,
      },
    );

    const entries = Object.entries(data ?? {});
    const labelOf = (uri: string): string => data?.[uri]?.labels?.["nl-NL"] ?? "";
    const uriLeaf = (uri: string): string => {
      const parts = uri.split(/[/#]/).filter(Boolean);
      return parts[parts.length - 1] ?? uri;
    };

    const items: ThemeItem[] = entries.map(([uri, entry]) => {
      const nl = entry?.labels?.["nl-NL"];
      const en = entry?.labels?.["en-US"];
      return {
        title: nl ?? uriLeaf(uri),
        name: nl ?? "",
        name_en: en ?? "",
        uri,
        parent: entry?.parent ? labelOf(entry.parent) : "",
        level: entry?.parent ? "sub" : "main",
      };
    });

    // Main themes first, then sub-themes; each group alphabetical (nl) by title.
    items.sort((a, b) => {
      if (a.level !== b.level) return a.level === "main" ? -1 : 1;
      return a.title.localeCompare(b.title, "nl");
    });

    return { items, endpoint: meta.url };
  }
}
