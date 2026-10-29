/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md.
 *
 * 1. rechtspraak_get_by_ecli: upstream fetched data.rechtspraak.nl/uitspraken/content
 *    once with a bare fetch(), no retry, and returned "fetch failed" on any network
 *    hiccup. installRechtspraakEcliRobuust() keeps that request first and, when it
 *    throws or gets a 5xx/429, takes the route of rechtspraak_uitspraak_get (the
 *    shared HTTP client) with 3 retries after 2, 5 and 10 s. The result says which
 *    route answered (bron).
 * 2. Tool bronnen_status: tests LiDO (services and portal) and the Rechtspraak API
 *    (content service and Open Data index) right now, without cache, and shows the
 *    circuit state of their connectors.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RechtspraakSource } from "../sources/rechtspraak.js";
import { getConnectorHealth } from "../utils/connector-runtime.js";
import { getText, SourceRequestError } from "../utils/http.js";
import { nowIso, successResponse, toMcpToolPayload } from "../utils/response.js";
import { foutOorzaak } from "./bron-fouten.js";
import { metAndereAdressen } from "./ip-herkansing.js";
import { LIDO_VERZOEK } from "./lido-robuust.js";

const RECHTSPRAAK_CONTENT = "https://data.rechtspraak.nl/uitspraken/content";
export const BRON_RETRY = { retries: 3, retryDelaysMs: [2_000, 5_000, 10_000], timeoutMs: 20_000 } as const;

type GetByEcli = RechtspraakSource["getByEcli"];
type GetByEcliResult = Awaited<ReturnType<GetByEcli>>;

let installed = false;
export function installRechtspraakEcliRobuust(): void {
  if (installed) return;
  installed = true;
  const direct = RechtspraakSource.prototype.getByEcli;
  RechtspraakSource.prototype.getByEcli = async function (this: RechtspraakSource, args) {
    let reden: string;
    try {
      const out = await direct.call(this, args);
      const status = /\(HTTP (\d{3})\)/.exec(out.access_note ?? "")?.[1];
      if (!status || (Number(status) < 500 && status !== "429")) return { ...out, bron: "content-service" } as unknown as GetByEcliResult;
      reden = `HTTP ${status}`;
    } catch (error) {
      reden = foutOorzaak(error);
    }
    return viaGedeeldeClient(args, reden);
  };
}

/** The route of rechtspraak_uitspraak_get: the shared client with retries; same output as getByEcli. */
export async function viaGedeeldeClient(args: { ecli: string; returnType?: "DOC" | "META" }, reden: string): Promise<GetByEcliResult> {
  const ecli = args.ecli.trim().toUpperCase();
  const params = { ecli, return: args.returnType ?? "DOC" };
  try {
    const { data, meta } = await getText(RECHTSPRAAK_CONTENT, { query: { id: ecli, return: params.return }, connector: "rechtspraak", ...BRON_RETRY, headers: { Accept: "application/xml, text/xml, application/rdf+xml" } });
    return {
      items: [{ id: ecli, title: ecli, link: `https://uitspraken.rechtspraak.nl/details?id=${encodeURIComponent(ecli)}`, ecli, xml: data }],
      total: 1,
      endpoint: meta.url,
      params,
      access_note: `Eerste verzoek mislukte (${reden}); opgehaald via de route van rechtspraak_uitspraak_get.`,
      bron: "gedeelde-client",
    } as unknown as GetByEcliResult;
  } catch (error) {
    if (error instanceof SourceRequestError && error.status === 404) {
      return { items: [], total: 0, endpoint: `${RECHTSPRAAK_CONTENT}?id=${encodeURIComponent(ecli)}`, params, access_note: `data.rechtspraak.nl kent ${ecli} niet (HTTP 404).` } as unknown as GetByEcliResult;
    }
    throw error;
  }
}

interface Proef { bron: string; url: string; connector: string; accept: string; verwacht: RegExp }
const PROEVEN: Proef[] = [
  { bron: "LiDO-services (get-aantal-per-informatietype)", url: "https://linkeddata.overheid.nl/service/get-aantal-per-informatietype?ext-id=ECLI%3ANL%3AHR%3A2019%3A2006", connector: "lido_telling", accept: "application/xml", verwacht: /<lido\b/ },
  { bron: "LiDO-services (get-links)", url: "https://linkeddata.overheid.nl/service/get-links?ext-id=ECLI%3ANL%3AHR%3A2019%3A2006&output=xml&start=0&rows=1", connector: "lido", accept: "application/xml", verwacht: /<lido\b/ },
  { bron: "LiDO-portaal (spiegel-lijstweergave)", url: "https://linkeddata.overheid.nl/front/portal/spiegel-lijstweergave?ext-id=ECLI%3ANL%3AHR%3A2019%3A2006", connector: "lido_portaal", accept: "text/html", verwacht: /relaties gevonden/i },
  { bron: "Rechtspraak content-service", url: `${RECHTSPRAAK_CONTENT}?id=ECLI%3ANL%3AHR%3A2019%3A2006&return=META`, connector: "rechtspraak", accept: "application/xml", verwacht: /ECLI:NL:HR:2019:2006/ },
  { bron: "Rechtspraak Open Data-index", url: "https://data.rechtspraak.nl/uitspraken/zoeken?max=1&return=DOC", connector: "rechtspraak_open_data", accept: "application/xml", verwacht: /<feed\b/ },
];

export async function proefBronnen(fetchImpl: typeof fetch = fetch) {
  return Promise.all(PROEVEN.map(async (p) => {
    const t0 = Date.now();
    try {
      // FORK: LiDO through another IP address after a connection failure, as the tools do (src/fork/ip-herkansing.ts).
      const poging = (dispatcher?: unknown) => fetchImpl(p.url, { headers: { ...LIDO_VERZOEK.headers, Accept: p.accept }, signal: AbortSignal.timeout(20_000), ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
      const r = p.connector.startsWith("lido") ? await metAndereAdressen(p.url, poging) : await poging();
      const body = await r.text();
      const ok = r.ok && p.verwacht.test(body);
      return { bron: p.bron, ok, status: r.status, ms: Date.now() - t0, ...(ok ? {} : { oorzaak: r.ok ? "onverwacht antwoord" : `HTTP ${r.status}` }), circuit: getConnectorHealth(p.connector).circuit_open ? "open" : "dicht" };
    } catch (error) {
      return { bron: p.bron, ok: false, status: null, ms: Date.now() - t0, oorzaak: foutOorzaak(error), circuit: getConnectorHealth(p.connector).circuit_open ? "open" : "dicht" };
    }
  }));
}

export function registerBronGezondheid(server: McpServer, annotations: Record<string, unknown>): void {
  installRechtspraakEcliRobuust();
  server.registerTool("bronnen_status", {
    description: "Health check: tests right now (no cache) whether LiDO (services get-aantal-per-informatietype and get-links, and the portal) and the Rechtspraak API (content service and Open Data index) answer, with HTTP status, time, the real cause of a failure and whether the server's circuit breaker for that source is open. Use it when lido_* or rechtspraak_* tools fail.",
    inputSchema: {},
    annotations,
  }, async () => {
    const uitslag = await proefBronnen();
    const fout = uitslag.filter((u) => !u.ok);
    return toMcpToolPayload(successResponse({
      summary: fout.length ? `${fout.length} van ${uitslag.length} bronnen faalt: ${fout.map((f) => `${f.bron} (${f.oorzaak})`).join("; ")}` : `Alle ${uitslag.length} bronnen antwoorden`,
      records: uitslag.map((u) => ({ source_name: "bronnen_status", title: u.bron, canonical_url: PROEVEN.find((p) => p.bron === u.bron)!.url, data: u })),
      provenance: { tool: "bronnen_status", endpoint: "linkeddata.overheid.nl, data.rechtspraak.nl", query_params: {}, timestamp: nowIso(), returned_results: uitslag.length, total_results: uitslag.length },
    }));
  });
}
