/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. LiDO that keeps working when
 * linkeddata.overheid.nl stumbles.
 *
 * - Every LiDO service call: the headers of Verwijzingscontrole (which kept
 *   working during the outages of 21 and 28 October 2026), 20 s per request,
 *   3 retries after 2, 5 and 10 s (also on 429, 5xx and network errors), and a
 *   24-hour cache per URL, so per identifier. The circuit (connector-runtime)
 *   opens only after 5 different endpoints fail and is half-open after 60 s.
 * - IPv4 first: this host has no IPv6 route, and an AAAA answer first cost a
 *   connect attempt per request.
 * - When the services fail: the portal list (front/portal/spiegel-lijstweergave),
 *   the same relations as HTML, parsed per document type; result marked bron
 *   "lido-portaal".
 * - A connection or TLS failure is retried on another IP address of the GSLB name
 *   (src/fork/ip-herkansing.ts) before the slow retries on the same address.
 */
import dns from "node:dns";
import { getText, type RequestOptions, SourceRequestError } from "../utils/http.js";
import { metAndereAdressen } from "./ip-herkansing.js";

export const LIDO_USER_AGENT = "Paul-van-Lange-NL-Legal-Reference-Checker/1.12 (nl-gov-mcp fork)";
const DAG_MS = 24 * 60 * 60 * 1000;

/** Options for every LiDO service request (src/sources/lido.ts and src/fork/lido-relaties.ts). */
export const LIDO_VERZOEK = {
  timeoutMs: 20_000,
  retries: 3,
  retryDelaysMs: [2_000, 5_000, 10_000],
  cacheTtlMs: DAG_MS,
  headers: { "User-Agent": LIDO_USER_AGENT, Accept: "application/xml,text/xml,*/*;q=0.5", "Accept-Language": "nl" },
} as const;

/** A failure of the source (not "LiDO does not know this"): the portal may still answer. */
export function isBronStoring(error: unknown): boolean {
  if (!(error instanceof SourceRequestError)) return error instanceof Error && /fetch failed|ETIMEDOUT|ECONN|socket|network/i.test(error.message);
  return error.code !== "malformed_response" && !(error.code === "http_error" && error.status !== undefined && error.status < 500 && error.status !== 429);
}

const PORTAAL = "https://linkeddata.overheid.nl/front/portal/spiegel-lijstweergave";

/**
 * getText for LiDO: first one attempt; a connection or TLS failure (or a time-out) then goes to up to 3 other
 * addresses, one attempt each and outside the circuit breaker, so one request counts once. Any other source
 * failure (5xx, 429), or a connection failure with no other address to try, gets the usual retries.
 */
export async function lidoGetText(url: string, options: RequestOptions) {
  try {
    return await metAndereAdressen(url, (dispatcher) => getText(url, { ...options, retries: 0, ...(dispatcher ? { dispatcher, buitenCircuit: true } : {}) }));
  } catch (error) {
    const geprobeerd = (error as { adressenGeprobeerd?: string[] }).adressenGeprobeerd;
    if (geprobeerd?.length || !(error instanceof SourceRequestError) || error.code === "circuit_open" || !isBronStoring(error) || !options.retries) throw error;
    await new Promise((r) => setTimeout(r, options.retryDelaysMs?.[0] ?? 500));
    return getText(url, { ...options, retries: options.retries - 1, retryDelaysMs: options.retryDelaysMs?.slice(1) });
  }
}

export interface PortaalDocument { lidoId: string; id: string | null; titel: string; type: string; geldig_vanaf: string | null; url: string }
export interface PortaalRelaties { titel: string | null; richting: string | null; totaal: number | null; perType: Array<{ type: string; aantal: number }>; items: PortaalDocument[] }

const ontsnap = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
const tekst = (html: string) => ontsnap(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** The portal page: "<n> uitgaande relaties gevonden", then per type a header "Wet (3)" and a list of links. */
export function parsePortaal(html: string): PortaalRelaties {
  const h = String(html ?? "");
  const titels = [...h.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => tekst(m[1]));
  const telling = titels.map((t) => /^(\d+)\s+(\w+)\s+relaties gevonden/i.exec(t)).find(Boolean);
  const titel = titels.find((t) => t && !/^Relaties$|relaties gevonden|^Verfijn/i.test(t)) ?? null;
  const items: PortaalDocument[] = [];
  const perType: Array<{ type: string; aantal: number }> = [];
  const start = h.indexOf('class="results"');
  const blokken = (start >= 0 ? h.slice(start) : "").split(/<div class="result-header">/i).slice(1);
  for (const blok of blokken) {
    const kop = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(blok);
    const m = kop ? /^(.*?)\s*\((\d+)\)\s*$/.exec(tekst(kop[1])) : null;
    if (!m) continue;
    const type = m[1].trim();
    perType.push({ type, aantal: Number(m[2]) });
    for (const li of blok.matchAll(/<li class="result-detail">\s*<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = ontsnap(li[1]);
      const lidoId = new URLSearchParams(href.replace(/^[^?]*\?/, "")).get("id") ?? "";
      if (!lidoId) continue;
      const meta = /<span class="meta">([\s\S]*?)<\/span>/i.exec(li[2]);
      const vanaf = meta ? /(\d{2})-(\d{2})-(\d{4})/.exec(tekst(meta[1])) : null;
      const naam = tekst(li[2].replace(/<span class="meta">[\s\S]*?<\/span>/i, ""));
      const ext = /\/(ECLI:[^/]+|BWB[RV]\d{7}|CVDR\d+[^/]*|CELEX:[^/]+)/i.exec(lidoId)?.[1] ?? null;
      items.push({ lidoId, id: ext, titel: naam, type, geldig_vanaf: vanaf ? `${vanaf[3]}-${vanaf[2]}-${vanaf[1]}` : null, url: `${PORTAAL}?id=${encodeURIComponent(lidoId)}` });
    }
  }
  return { titel, richting: telling ? telling[2].toLowerCase() : null, totaal: telling ? Number(telling[1]) : null, perType, items };
}

/** The portal list for a LiDO lookup ({"ext-id": ECLI} or {id: LiDO object}). */
export async function lidoViaPortaal(lookup: { id: string } | { "ext-id": string }): Promise<PortaalRelaties & { url: string }> {
  const u = new URL(PORTAAL);
  if ("id" in lookup) u.searchParams.set("id", lookup.id);
  else u.searchParams.set("ext-id", lookup["ext-id"]);
  const { data } = await lidoGetText(u.toString(), { ...LIDO_VERZOEK, connector: "lido_portaal", headers: { ...LIDO_VERZOEK.headers, Accept: "text/html,application/xhtml+xml" } });
  return { ...parsePortaal(data), url: u.toString() };
}

let geinstalleerd = false;
/** IPv4 before IPv6 for the whole process (once). */
export function installLidoNetwerk(): void {
  if (geinstalleerd) return;
  geinstalleerd = true;
  dns.setDefaultResultOrder("ipv4first");
}
