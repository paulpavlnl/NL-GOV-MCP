import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

interface RdwRecord {
  kenteken?: string;
  merk?: string;
  handelsbenaming?: string;
  voertuigsoort?: string;
  [key: string]: unknown;
}

const RDW_ENDPOINT = "https://opendata.rdw.nl/resource/m9d7-ebf2.json";

function normalizeKenteken(input: string): string | undefined {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{6}$/.test(compact)) return undefined;
  const letters = (compact.match(/[A-Z]/g) ?? []).length;
  const digits = (compact.match(/[0-9]/g) ?? []).length;
  return letters >= 2 && digits >= 2 ? compact : undefined;
}

function toRdwItem(x: RdwRecord, fallbackId: string) {
  const datumTenaamstelling = (x as { datum_tenaamstelling?: unknown }).datum_tenaamstelling;
  return {
    id: `${x.kenteken ?? fallbackId}`,
    title: `${x.merk ?? "Onbekend merk"} ${x.handelsbenaming ?? ""}`.trim(),
    url: "https://opendata.rdw.nl/",
    updated_at: String(datumTenaamstelling ?? ""),
    kenteken: x.kenteken,
    merk: x.merk,
    handelsbenaming: x.handelsbenaming,
    voertuigsoort: x.voertuigsoort,
    datum_tenaamstelling: datumTenaamstelling,
  };
}

function containsQuery(x: RdwRecord, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  const text = `${x.kenteken ?? ""} ${x.merk ?? ""} ${
    x.handelsbenaming ?? ""
  } ${x.voertuigsoort ?? ""}`.toLowerCase();
  return text.includes(q);
}

export class RdwSource {
  constructor(private readonly config: AppConfig) {}

  /**
   * Tries the search strategies in turn. When every request failed, the last
   * error is thrown; when at least one answered and none matched, the result is
   * empty and `access_note` says so (and whether a strategy failed).
   */
  async search(args: { query: string; rows: number }) {
    const q = args.query.trim();
    const normalizedKenteken = normalizeKenteken(q);
    const escapedLike = q.toUpperCase().replace(/'/g, "''").replace(/[%_\\]/g, "\\$&");

    const attemptParams: Array<Record<string, string>> = [];

    if (normalizedKenteken) {
      attemptParams.push({
        $limit: String(Math.min(args.rows, 25)),
        $where: `kenteken='${normalizedKenteken}'`,
      });
    }

    attemptParams.push({
      $limit: String(Math.min(args.rows * 5, 100)),
      $q: q,
      $order: "datum_tenaamstelling DESC",
    });

    if (q) {
      attemptParams.push({
        $limit: String(Math.min(args.rows * 5, 100)),
        $where: `upper(merk) like '%${escapedLike}%' or upper(handelsbenaming) like '%${escapedLike}%' or upper(voertuigsoort) like '%${escapedLike}%'`,
        $order: "datum_tenaamstelling DESC",
        __timeoutMs: "8000", // LIKE with leading wildcards is slow on Socrata
      });
    }

    let answered = 0;
    let failed = 0;
    let lastError: unknown;
    for (const params of attemptParams) {
      try {
        const timeoutMs = params.__timeoutMs ? Number(params.__timeoutMs) : 15_000;
        const { __timeoutMs: _, ...cleanParams } = params;
        const { data, meta } = await getJson<RdwRecord[]>(RDW_ENDPOINT, {
          query: cleanParams,
          timeoutMs,
        });
        answered += 1;

        const raw = Array.isArray(data) ? data : [];
        const filtered =
          params.$q || params.$where
            ? raw
            : raw.filter((x) => containsQuery(x, q));

        if (!filtered.length) continue;

        const seen = new Set<string>();
        const items = filtered
          .map((x, i) => toRdwItem(x, `rdw-${i}`))
          .filter((item) => {
            const key = String(item.id ?? "");
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, args.rows);

        if (!items.length) continue;

        return {
          items,
          // Upstream levert geen count; null i.p.v. de paginagrootte, zodat een
          // consument "x van y" niet met een verzonnen y toont.
          total: null,
          endpoint: meta.url,
          params,
        };
      } catch (e) {
        // try next strategy
        failed += 1;
        lastError = e;
      }
    }

    if (!answered && lastError !== undefined) throw lastError;

    return {
      items: [],
      total: 0,
      endpoint: RDW_ENDPOINT,
      params: { $limit: String(args.rows) },
      access_note: failed
        ? `Geen live match in RDW dataset voor deze zoekterm; ${failed} van de ${attemptParams.length} zoekstappen mislukte, dus het resultaat kan onvolledig zijn.`
        : "Geen live match in RDW dataset voor deze zoekterm.",
    };
  }
}
