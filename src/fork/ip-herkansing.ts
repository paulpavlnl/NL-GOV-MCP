/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. Retry on another IP address of the
 * same host after a connection or TLS failure, as Verwijzingscontrole does since
 * commit c1d4f14 (28-10-2026).
 *
 * linkeddata.overheid.nl is a GSLB name (koop-prod.gslb.rijksapps.nl): the local
 * resolver and public resolvers hand out different nodes (147.181.37.221,
 * 147.181.37.238, 147.181.13.83, 147.181.12.117). On 28-10 one node refused the
 * name (TLS alert 112); on 29-10 07:06 UTC get-aantal-per-informatietype and the
 * portal timed out on 147.181.37.221 (ENETUNREACH on IPv6) while get-links
 * worked. A request that fails to connect therefore gets up to 3 more attempts,
 * each on an address it has not tried yet: what the local DNS gives besides the
 * first IPv4 address, then what public resolvers give, IPv4 before IPv6. The SNI
 * stays the host name of the URL (undici sets it from the URL, never from the IP).
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup as dnsLookupAsync, Resolver } from "node:dns/promises";
import { Agent } from "undici";

const VERBINDING_RE = /ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|UND_ERR_CONNECT|UND_ERR_SOCKET|ERR_SSL_|unrecognized name|SSL alert number|EPROTO|wrong version number|handshake|socket hang up|fetch failed/i;
const PUBLIEKE_RESOLVERS = ["1.1.1.1", "9.9.9.9"];
export const MAX_EXTRA_ADRESSEN = 3;

/** Whether an error (or one of its causes) is a connection or TLS failure, not an HTTP answer. */
export function isVerbindingsFout(error: unknown): boolean {
  let e = error as { code?: unknown; message?: unknown; cause?: unknown; status?: unknown; errors?: unknown[] } | undefined;
  for (let i = 0; e && i < 5; e = e.cause as typeof e, i++) {
    if (typeof e.status === "number") return false;
    if (VERBINDING_RE.test(`${e.code ?? ""} ${e.message ?? ""}`)) return true;
    if (Array.isArray(e.errors) && e.errors.some((x) => isVerbindingsFout(x))) return true;
  }
  return false;
}

export interface Adres { address: string; family: number }
export interface AdresBronnen { lookup?: (host: string) => Promise<Adres[]>; publiek?: (host: string) => Promise<Adres[]> }

async function publiekeAdressen(host: string): Promise<Adres[]> {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  resolver.setServers(PUBLIEKE_RESOLVERS);
  const [v4, v6] = await Promise.all([resolver.resolve4(host).catch(() => [] as string[]), resolver.resolve6(host).catch(() => [] as string[])]);
  return [...v4.map((address) => ({ address, family: 4 })), ...v6.map((address) => ({ address, family: 6 }))];
}

/** Other addresses of `host`: the local DNS besides its first IPv4 address (the one that just failed), then public resolvers; IPv4 first. */
export async function andereAdressen(host: string, bronnen: AdresBronnen = {}): Promise<Adres[]> {
  const lokaal = await (bronnen.lookup ?? ((h: string) => dnsLookupAsync(h, { all: true })))(host).catch(() => [] as Adres[]);
  const eerste = lokaal.find((r) => r.family === 4) ?? lokaal[0];
  const extra = await (bronnen.publiek ?? publiekeAdressen)(host).catch(() => [] as Adres[]);
  const gezien = new Set(eerste ? [eerste.address] : []);
  const uit: Adres[] = [];
  for (const r of [...lokaal, ...extra].sort((a, b) => a.family - b.family)) {
    if (gezien.has(r.address)) continue;
    gezien.add(r.address);
    uit.push(r);
  }
  return uit;
}

/** A dispatcher that connects `host` to `adres`; other hosts (a redirect) resolve normally. */
export function dispatcherVoorAdres(host: string, adres: Adres): Agent {
  return new Agent({
    connect: {
      lookup(hostname: string, opts: { all?: boolean }, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
        if (hostname !== host) return dnsLookup(hostname, opts as never, cb as never);
        return opts?.all ? cb(null, [adres]) : cb(null, adres.address, adres.family);
      },
    } as never,
  });
}

/**
 * Runs `poging()` (default address); on a connection or TLS failure up to 3 more times with a
 * dispatcher pinned to another address. When all fail, the error names the real cause of the
 * first failure and the addresses tried.
 */
export async function metAndereAdressen<T>(url: string, poging: (dispatcher?: Agent) => Promise<T>, bronnen: AdresBronnen = {}): Promise<T> {
  try {
    return await poging();
  } catch (eerste) {
    if (!isVerbindingsFout(eerste)) throw eerste;
    const host = new URL(url).hostname;
    const geprobeerd: string[] = [];
    let laatste: unknown = eerste;
    for (const adres of (await andereAdressen(host, bronnen)).slice(0, MAX_EXTRA_ADRESSEN)) {
      geprobeerd.push(adres.address);
      const dispatcher = dispatcherVoorAdres(host, adres);
      try {
        return await poging(dispatcher);
      } catch (e) {
        laatste = e;
        if (!isVerbindingsFout(e)) throw e;
      } finally {
        dispatcher.close().catch(() => {});
      }
    }
    if (!geprobeerd.length) throw eerste;
    const melding = `${eerste instanceof Error ? eerste.message : String(eerste)} (ook geprobeerd via ${geprobeerd.join(", ")}${laatste !== eerste && laatste instanceof Error ? `; laatste: ${laatste.message}` : ""})`;
    if (eerste instanceof Error) { eerste.message = melding; throw eerste; }
    throw new Error(melding);
  }
}
