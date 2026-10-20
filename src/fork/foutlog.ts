/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. Foutlog: every failed lookup and every deviating outcome
 * as one row, plus a counter of all calls (no content). The same central log as the
 * verwijzingscontroleur (foutlog.js there, which also holds the sync, the report foutlog_rapport and
 * `npm run hertest-foutlog`): table foutlog_nl_gov_mcp and table aanroepen in the Postgres of
 * FOUTLOG_DATABASE_URL. On a pc every row also goes to the local copy
 * (%USERPROFILE%\mcp-lokaal\foutlog\nl_gov_mcp.jsonl), and to a local queue when the database cannot be
 * reached; the verwijzingscontroleur pushes that queue on its next sync.
 *
 * Privacy: only the reference and the input that names the source (wet, artikel, BWB-id, ECLI, peildatum);
 * never a zoekterm or other free text. Logging never fails or delays a tool: it runs after the call,
 * with a time-out, and a failure only writes a warning to stderr (stdout stays clean JSON-RPC).
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const APP = "nl_gov_mcp";
export const INVOER_VELDEN = ["reference", "bwbId", "bwb_id", "wet", "artikel", "datum", "peildatum", "pad", "ecli", "sectie", "onderdeel", "query_ref"];

export interface FoutRegel {
  tool: string;
  verwijzing: string;
  invoer?: Record<string, unknown>;
  uitkomst: string | string[];
  diagnose?: string | null;
  peildatum?: string | null;
  citaat?: string;
  extra?: Record<string, unknown>;
}

const warn = (m: string) => { try { process.stderr.write(`[foutlog] ${m}\n`); } catch { /* nothing */ } };

export function serverNaam(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FOUTLOG_SERVER) return env.FOUTLOG_SERVER;
  return env.RENDER ? "render" : `lokaal-${os.hostname().toLowerCase()}`;
}
export function lokaleMap(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.FOUTLOG_MAP) return env.FOUTLOG_MAP;
  return env.RENDER ? null : join(os.homedir(), "mcp-lokaal", "foutlog");
}
export function alleenInvoer(args: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of INVOER_VELDEN) { const v = args[k]; if (v !== undefined && v !== null && String(v).trim()) out[k] = String(v).slice(0, 300); }
  return out;
}
export function maakRegel(r: FoutRegel, server: string, nu = new Date()) {
  const c = String(r.citaat ?? "");
  return {
    id: randomUUID(), tijdstip: nu.toISOString(), server, tool: r.tool.slice(0, 80), verwijzing: String(r.verwijzing ?? "").slice(0, 300),
    invoer: alleenInvoer(r.invoer), uitkomst: Array.isArray(r.uitkomst) ? r.uitkomst.join(",") : String(r.uitkomst ?? ""),
    diagnose: r.diagnose ? String(r.diagnose).slice(0, 80) : null, peildatum: r.peildatum ? String(r.peildatum).slice(0, 10) : null,
    ...(c ? { citaat_hash: createHash("sha256").update(c.normalize("NFC").trim()).digest("hex").slice(0, 16), citaat_lengte: c.length } : {}),
    ...(r.extra ? { extra: r.extra } : {}),
  };
}
type Regel = ReturnType<typeof maakRegel>;

type Pool = { query: (sql: string, values?: unknown[]) => Promise<unknown>; on: (e: string, f: (err: Error) => void) => void };
const KOLOMMEN = ["id", "tijdstip", "server", "tool", "verwijzing", "invoer", "uitkomst", "diagnose", "peildatum", "citaat_hash", "citaat_lengte", "extra"] as const;
const metTijd = <T>(p: Promise<T>, ms: number, wat: string) => Promise.race([p, new Promise<never>((_, rej) => { const t = setTimeout(() => rej(new Error(`${wat}: time-out na ${ms} ms`)), ms); t.unref?.(); })]);

export function maakFoutlog({ env = process.env, timeoutMs = 4_000, tellerIntervalMs = 15_000 }: { env?: NodeJS.ProcessEnv; timeoutMs?: number; tellerIntervalMs?: number } = {}) {
  const uit = /^(1|true|ja|uit)$/i.test(String(env.FOUTLOG_UIT ?? ""));
  const url = String(env.FOUTLOG_DATABASE_URL ?? "").trim();
  const server = serverNaam(env);
  const map = lokaleMap(env);
  let rij: Regel[] = [];
  let tellers = new Map<string, { tool: string; dag: string; aantal: number }>();
  let pool: Promise<Pool> | null = null;
  let schemaKlaar = false;
  let gewaarschuwd = false;
  let bezig: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  let tellerTimer: NodeJS.Timeout | null = null;

  const db = () => (pool ??= (async () => {
    const pg = (await import("pg")).default;
    const ssl = /sslmode=disable|@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : { rejectUnauthorized: false };
    const p = new pg.Pool({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ""), ssl, max: 2, connectionTimeoutMillis: timeoutMs, idleTimeoutMillis: 5_000, allowExitOnIdle: true, statement_timeout: timeoutMs, query_timeout: timeoutMs }) as unknown as Pool;
    p.on("error", (e) => warn(`database: ${e.message}`));
    return p;
  })().catch((e) => { pool = null; throw e; }));

  const lokaal = async (fn: () => Promise<void>) => { if (!map) return; try { await mkdir(map, { recursive: true }); await fn(); } catch (e) { warn(`lokale kopie: ${(e as Error).message}`); } };

  async function schrijf() {
    const regels = rij; rij = [];
    const tel = [...tellers.values()]; tellers = new Map();
    if (!regels.length && !tel.length) return;
    const jsonl = (rs: Regel[]) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
    if (regels.length) await lokaal(() => appendFile(join(map!, `${APP}.jsonl`), jsonl(regels)));
    if (tel.length) await lokaal(async () => {
      const f = join(map!, "aanroepen.json");
      let t: Record<string, number> = {};
      try { t = JSON.parse(await readFile(f, "utf8")); } catch { /* new */ }
      for (const r of tel) { const k = `${APP}|${server}|${r.tool}|${r.dag}`; t[k] = (t[k] ?? 0) + r.aantal; }
      await writeFile(f, JSON.stringify(t));
    });
    if (!url) return;
    try {
      const p = await metTijd(db(), timeoutMs, "verbinden");
      await metTijd((async () => {
        if (!schemaKlaar) {
          await p.query(`CREATE TABLE IF NOT EXISTS foutlog_${APP} (id uuid PRIMARY KEY, tijdstip timestamptz NOT NULL, server text NOT NULL, tool text NOT NULL, verwijzing text, invoer jsonb, uitkomst text, diagnose text, peildatum text, citaat_hash text, citaat_lengte integer, extra jsonb);
            CREATE INDEX IF NOT EXISTS foutlog_${APP}_tijdstip ON foutlog_${APP} (tijdstip);
            CREATE TABLE IF NOT EXISTS aanroepen (app text NOT NULL, server text NOT NULL, tool text NOT NULL, dag date NOT NULL, aantal integer NOT NULL, PRIMARY KEY (app, server, tool, dag));`);
          schemaKlaar = true;
        }
        for (const r of regels) {
          const rr = r as Record<string, unknown>;
          await p.query(`INSERT INTO foutlog_${APP} (${KOLOMMEN.join(",")}) VALUES (${KOLOMMEN.map((_, i) => `$${i + 1}`).join(",")}) ON CONFLICT (id) DO NOTHING`,
            KOLOMMEN.map((k) => (k === "invoer" || k === "extra" ? (rr[k] ? JSON.stringify(rr[k]) : null) : rr[k] ?? null)));
        }
        for (const t of tel) {
          await p.query("INSERT INTO aanroepen (app, server, tool, dag, aantal) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (app, server, tool, dag) DO UPDATE SET aantal = aanroepen.aantal + EXCLUDED.aantal", [APP, server, t.tool, t.dag, t.aantal]);
        }
      })(), timeoutMs * 2, "schrijven");
      gewaarschuwd = false;
    } catch (e) {
      schemaKlaar = false;
      if (!gewaarschuwd) warn(`centrale database niet bereikbaar (${(e as Error).message}); ${map ? "bewaard in de lokale wachtrij" : "bewaard tot de volgende poging"}.`);
      gewaarschuwd = true;
      if (map) { if (regels.length) await lokaal(() => appendFile(join(map, `${APP}.wachtrij.jsonl`), jsonl(regels))); }
      else {
        rij = [...regels, ...rij].slice(-500);
        for (const t of tel) { const k = `${t.tool}|${t.dag}`; const o = tellers.get(k); tellers.set(k, { ...t, aantal: t.aantal + (o?.aantal ?? 0) }); }
      }
    }
  }
  function plan() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; bezig = bezig.then(schrijf).catch((e) => warn((e as Error).message)); }, 0);
    timer.unref?.();
  }
  return {
    server, actief: !uit, database: Boolean(url), map,
    fout(r: FoutRegel) {
      if (uit) return;
      try { rij.push(maakRegel(r, server)); plan(); } catch (e) { warn(`regel niet gelogd: ${(e as Error).message}`); }
    },
    aanroep(tool: string) {
      if (uit) return;
      try {
        const dag = new Date().toISOString().slice(0, 10), k = `${tool}|${dag}`;
        tellers.set(k, { tool: tool.slice(0, 80), dag, aantal: 1 + (tellers.get(k)?.aantal ?? 0) });
        if (!tellerTimer) { tellerTimer = setTimeout(() => { tellerTimer = null; plan(); }, tellerIntervalMs); tellerTimer.unref?.(); }
      } catch { /* the counter is secondary */ }
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (tellerTimer) { clearTimeout(tellerTimer); tellerTimer = null; }
      await bezig; await schrijf();
    },
  };
}

let gedeeld: ReturnType<typeof maakFoutlog> | undefined;
/** One logger per process (the HTTP transport builds a server per request). */
export function foutlog() { return (gedeeld ??= maakFoutlog()); }
