import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";
import {
  extractSruNumberOfRecords,
  extractSruRecords,
  parseXml,
} from "../utils/xml-parser.js";

/** SRU endpoint (KOOP zoekservice) that serves the BWB consolidated-legislation collection. */
const BWB_SRU_ENDPOINT = "https://zoekservice.overheid.nl/sru/Search";
const BWB_CONNECTION = "BWB";

/** Read a scalar text value from a fast-xml-parser node (string, number, or { "#text": ... }). */
function toStringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return obj["#text"];
    if (typeof obj["#text"] === "number") return String(obj["#text"]);
  }
  return undefined;
}

/** Escape a value for use inside double-quoted CQL/SRU strings. */
function escapeSruValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build the CQL query for BWB. The BWB SRU index rejects generic indexes
 * (cql.textAndIndexes, dcterms.title …); it exposes its own indexes such as
 * overheidbwb.titel. Free-text terms are matched against the title index.
 */
function buildCql(query: string, geldigheidsdatum?: string): string {
  const term = query.trim();
  // Quote multi-word terms so CQL treats them as an ordered phrase.
  const value = /\s/.test(term) ? `"${escapeSruValue(term)}"` : escapeSruValue(term);
  const titel = term ? `overheidbwb.titel=${value}` : "overheidbwb.titel=*";
  // Zonder datumfilter levert elke historische toestand een eigen record op, zodat één
  // regeling de hele resultatenlijst kan vullen.
  return geldigheidsdatum ? `${titel} and overheidbwb.geldigheidsdatum==${geldigheidsdatum}` : titel;
}

const TYPE_RANG: Record<string, number> = { wet: 0, AMvB: 1, "ministeriele-regeling": 2 };

/**
 * Narrow one parsed SRU <gzd> record into the useful BWB fields.
 * With removeNSPrefix the tags are local names: overheidbwb:meta → meta,
 * dcterms:title → title, overheid:authority → authority, etc.
 */
function extractBwb(record: Record<string, unknown>) {
  const original = record.originalData as Record<string, unknown> | undefined;
  const meta = original?.meta as Record<string, unknown> | undefined;
  const owmskern = meta?.owmskern as Record<string, unknown> | undefined;
  const owmsmantel = meta?.owmsmantel as Record<string, unknown> | undefined;
  const enriched = record.enrichedData as Record<string, unknown> | undefined;

  const identifier = toStringValue(owmskern?.identifier) ?? toStringValue(record.identifier);
  const title = toStringValue(owmskern?.title) ?? toStringValue(record.title);
  const type = toStringValue(owmskern?.type);
  const authority = toStringValue(owmskern?.authority);
  const creator = toStringValue(owmskern?.creator);
  const date = toStringValue(owmskern?.modified) ?? toStringValue(owmsmantel?.created);

  const canonical =
    toStringValue(enriched?.preferredUrl) ??
    (identifier ? `https://wetten.overheid.nl/${identifier}` : undefined);

  return { identifier, title, type, authority, creator, date, canonical };
}

export class WettenBwbSource {
  constructor(private readonly config: AppConfig) {}

  /**
   * Zoekt op titel. Standaard alleen regelingen die vandaag gelden (`geldigheidsdatum`,
   * of `inclusiefVervallen` voor de volledige historie), ontdubbeld per BWBR, met een
   * exacte titeltreffer en daarna wetten bovenaan.
   */
  async search(args: { query: string; maximumRecords: number; startRecord?: number; geldigheidsdatum?: string; inclusiefVervallen?: boolean }) {
    const datum = args.inclusiefVervallen ? undefined : (args.geldigheidsdatum ?? new Date().toISOString().slice(0, 10));
    const params: Record<string, string | number> = {
      "x-connection": BWB_CONNECTION,
      operation: "searchRetrieve",
      version: "1.2",
      query: buildCql(args.query, datum),
      // Ruimer ophalen zodat een exacte titeltreffer na het rangschikken niet buiten de pagina valt.
      maximumRecords: Math.min(200, Math.max(args.maximumRecords, 50)),
      startRecord: args.startRecord ?? 1,
    };

    const { data, meta } = await getText(BWB_SRU_ENDPOINT, {
      query: params,
      connector: "wetten_bwb",
    });
    const parsed = parseXml(data);
    const records = extractSruRecords(parsed);
    const total = extractSruNumberOfRecords(parsed);

    const term = args.query.trim().toLowerCase();
    const seen = new Set<string>();
    const items = records
      .map((r) => extractBwb(r))
      .filter((m) => {
        const key = m.identifier ?? m.title ?? "";
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((m, i) => ({ m, i, exact: (m.title ?? "").toLowerCase() === term ? 0 : 1, rang: TYPE_RANG[m.type ?? ""] ?? 3 }))
      .sort((a, b) => a.exact - b.exact || a.rang - b.rang || a.i - b.i)
      .map(({ m }) => ({
        identifier: m.identifier,
        title: m.title,
        type: m.type,
        authority: m.authority,
        creator: m.creator,
        date: m.date,
        canonical_url: m.canonical,
      }) as Record<string, unknown>);

    return {
      items,
      // Alles binnen? Dan is het ontdubbelde aantal het echte totaal; anders het SRU-totaal.
      total: typeof total === "number" && records.length >= total ? items.length : total,
      endpoint: meta.url,
      params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      access_note:
        "Bron: BWB geconsolideerde wetgeving via KOOP SRU. Gezocht op de titel-index (overheidbwb.titel)" +
        (datum ? `, alleen regelingen geldig op ${datum}` : ", inclusief vervallen versies") +
        "; één resultaat per regeling, exacte titel en wetten eerst.",
    };
  }
}
