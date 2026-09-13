import type { AppConfig } from "../types.js";

interface LidoItem {
  id?: string;
  title?: string;
  summary?: string;
  link?: string;
  [key: string]: unknown;
}

const LIDO_ORIGIN = "https://linkeddata.overheid.nl";
const DOCUMENT_VIEWER_URL = `${LIDO_ORIGIN}/front/portal/document-viewer`;
const SEARCH_URL = `${LIDO_ORIGIN}/front/portal/lido-lx`;

const ECLI_RE = /ECLI:[A-Z]{2}:[A-Z0-9.]+:[0-9]{4}:[A-Z0-9.]+/gi;
const BWBR_RE = /BWBR[0-9]{6,8}/gi;
const CVDR_RE = /CVDR[0-9]{5,8}(?:_[0-9]+)?/gi;
const CELEX_RE = /CELEX:[0-9A-Z]{1}[0-9]{4}[A-Z]{1,2}[0-9]{4}(?:\([0-9]{2}\))?/gi;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function extractIdentifiers(raw: string) {
  return {
    eclis: unique((raw.match(ECLI_RE) ?? []).map((m) => m.toUpperCase())),
    bwbrs: unique((raw.match(BWBR_RE) ?? []).map((m) => m.toUpperCase())),
    cvdrs: unique((raw.match(CVDR_RE) ?? []).map((m) => m.toUpperCase())),
    celexes: unique((raw.match(CELEX_RE) ?? []).map((m) => m.toUpperCase())),
  };
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

async function fetchHtml(
  url: URL,
): Promise<{ url: string; status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });
    const body = await response.text();
    return { url: response.url || url.toString(), status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export class LidoSource {
  constructor(private readonly config: AppConfig) {}

  /** Haal de LiDO-documentpagina op voor een bekende identifier (ECLI/BWBR/CVDR) en detecteer gerelateerde identifiers. */
  async relationsByIdentifier(args: { identifier: string }) {
    const id = args.identifier.trim();
    const url = new URL(DOCUMENT_VIEWER_URL);
    url.searchParams.set("ext-id", id);

    const page = await fetchHtml(url);

    if (page.status < 200 || page.status >= 300) {
      return {
        items: [] as LidoItem[],
        total: 0,
        endpoint: page.url,
        params: { "ext-id": id },
        access_note: `LiDO gaf HTTP ${page.status} voor identifier ${id}. Geen relaties opgehaald.`,
      };
    }

    const discovered = extractIdentifiers(page.body);
    const related = unique([
      ...discovered.eclis,
      ...discovered.bwbrs,
      ...discovered.cvdrs,
      ...discovered.celexes,
    ]).filter((value) => value.toUpperCase() !== id.toUpperCase());

    const item: LidoItem = {
      id,
      title: `LiDO-relaties voor ${id}`,
      link: page.url,
      identifier: id,
      lido_page_url: page.url,
      discovered_identifiers: discovered,
      related_identifiers: related,
      readable_snippet: stripHtml(page.body).slice(0, 20_000),
      limitation:
        "LiDO-pagina's kunnen deels client-side worden opgebouwd; deze tool doorzoekt de ruwe HTML-respons op identifiers.",
    };

    return {
      items: [item],
      total: related.length,
      endpoint: page.url,
      params: { "ext-id": id },
      ...(related.length === 0
        ? { access_note: "Geen gerelateerde identifiers gevonden in de ruwe HTML van deze LiDO-pagina." }
        : {}),
    };
  }

  /** Zoek op LiDO met vrije tekst wanneer geen formele identifier bekend is. */
  async searchFreeText(args: { query: string }) {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("inputtext", args.query);

    const page = await fetchHtml(url);

    if (page.status < 200 || page.status >= 300) {
      return {
        items: [] as LidoItem[],
        total: 0,
        endpoint: page.url,
        params: { inputtext: args.query },
        access_note: `LiDO gaf HTTP ${page.status} voor zoekterm "${args.query}". Geen resultaten opgehaald.`,
      };
    }

    const discovered = extractIdentifiers(page.body);
    const found = unique([
      ...discovered.eclis,
      ...discovered.bwbrs,
      ...discovered.cvdrs,
      ...discovered.celexes,
    ]);

    const item: LidoItem = {
      id: args.query,
      title: `LiDO-zoekresultaat: ${args.query}`,
      link: page.url,
      query: args.query,
      lido_search_url: page.url,
      discovered_identifiers: discovered,
      found_identifiers: found,
      readable_snippet: stripHtml(page.body).slice(0, 20_000),
      limitation:
        "LiDO-zoekresultaten kunnen deels client-side worden opgebouwd; deze tool doorzoekt de ruwe HTML-respons op identifiers.",
    };

    return {
      items: [item],
      total: found.length,
      endpoint: page.url,
      params: { inputtext: args.query },
      ...(found.length === 0
        ? { access_note: "Geen identifiers gevonden in de ruwe HTML van deze LiDO-zoekpagina." }
        : {}),
    };
  }
}
