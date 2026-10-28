/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. The real cause of a failed
 * request. Node's fetch throws "fetch failed" and keeps the reason (ETIMEDOUT,
 * ECONNRESET, an AggregateError per address, a TLS error) in `cause`; upstream
 * passed on only the message, so an error said "LiDO request failed" and the
 * log said nothing. Imported by src/utils/http.ts; imports only the logger.
 */
import { logger } from "../utils/logger.js";

type MetOorzaak = Error & { code?: string; cause?: unknown; errors?: unknown[] };

function deel(e: unknown): string {
  if (!e || typeof e !== "object") return String(e ?? "");
  const x = e as MetOorzaak & { address?: string; port?: number };
  const kern = [x.code, x.name !== "Error" ? x.name : undefined].filter(Boolean)[0] ?? "";
  const adres = x.address ? ` ${x.address}${x.port ? `:${x.port}` : ""}` : "";
  const sub = Array.isArray(x.errors) && x.errors.length ? ` [${x.errors.map(deel).join("; ")}]` : "";
  const bericht = x.message && x.message !== kern ? `${kern ? ": " : ""}${x.message}` : "";
  return `${kern}${bericht}${adres}${sub}`.trim();
}

/** "fetch failed (ETIMEDOUT: connect ETIMEDOUT 147.181.37.238:443)" instead of "fetch failed". */
export function foutOorzaak(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const e = error as MetOorzaak;
  if (e.name === "AbortError" || e.name === "TimeoutError") return `time-out (${e.message})`;
  const oorzaak = e.cause ? deel(e.cause) : Array.isArray(e.errors) ? deel(e) : "";
  return oorzaak && !e.message.includes(oorzaak) ? `${e.message} (${oorzaak})` : e.message;
}

/** One log line per failed attempt, with the cause; upstream logged only successes. */
export function logBronFout(connector: string, url: string, attempt: number, error: unknown): void {
  logger.warn({ connector, url, attempt, oorzaak: foutOorzaak(error) }, "source_request_failed");
}
