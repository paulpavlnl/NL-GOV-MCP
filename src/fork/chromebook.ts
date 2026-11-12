/**
 * FORK (docs/FORK.md): de Chromebook-tijdlijn van Paul voor elke Claude-sessie.
 *
 * De Chrome-extensie op de Chromebook stuurt browsersegmenten naar de dienst
 * mcp-chromebook (repo paulpavlnl/chromebook-tijd) op de woonkamer-pc; die
 * bewaart ze in C:\mcp\data\chromebook-tijd.json (DATA_FILE) en levert ze aan
 * ManicTime als Web source. De ManicTime-connector geeft die Web source niet
 * terug; deze tools lezen het bestand rechtstreeks (zelfde pc, geen sleutel).
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MCPRecord, ToolResult } from "../types.js";
import { errorResponse, successResponse, toMcpToolPayload } from "../utils/response.js";

const TZ = "Europe/Amsterdam";
const MERGE_GAP_MS = 5000;

interface Segment { id: string; startMs: number; endMs: number; url?: string; domain: string; title?: string }

export function chromebookDataFile(): string {
  return process.env.CHROMEBOOK_DATA_FILE?.trim() || path.join(process.env.MCP_ROOT || "C:\\mcp", "data", "chromebook-tijd.json");
}

/** Lokale tijd in Europe/Amsterdam ('JJJJ-MM-DD' of 'JJJJ-MM-DDTUU:MM[:SS]') naar epoch-ms. */
export function amsterdamNaarMs(lokaal: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(lokaal.trim());
  if (!m) return NaN;
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  const alsUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  // Offset van Amsterdam op dat moment (twee keer, voor de zomertijdgrens).
  const offset = (ms: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  };
  let ms = alsUtc - offset(alsUtc);
  ms = alsUtc - offset(ms);
  return ms;
}

export function msNaarAmsterdam(ms: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

function leesSegmenten(): { segs: Segment[]; mtime: number } {
  const file = chromebookDataFile();
  const stat = fs.statSync(file);
  return { segs: JSON.parse(fs.readFileSync(file, "utf8")) as Segment[], mtime: stat.mtimeMs };
}

/** Blokken in [van, tot): afgekapt op de periode, opeenvolgende stukken met hetzelfde domein en dezelfde titel samengevoegd. */
export function chromebookBlokken(segs: Segment[], vanMs: number, totMs: number): Array<{ startMs: number; endMs: number; domain: string; title: string; url?: string }> {
  const rows = segs.filter((s) => s.endMs > vanMs && s.startMs < totMs).sort((a, b) => a.startMs - b.startMs);
  const uit: Array<{ startMs: number; endMs: number; domain: string; title: string; url?: string }> = [];
  for (const s of rows) {
    const start = Math.max(s.startMs, vanMs, uit.length ? uit[uit.length - 1].endMs : -Infinity);
    const end = Math.min(s.endMs, totMs);
    if (end - start < 1000) continue;
    const title = s.title || s.domain;
    const vorige = uit[uit.length - 1];
    if (vorige && vorige.domain === s.domain && vorige.title === title && start - vorige.endMs <= MERGE_GAP_MS) vorige.endMs = end;
    else uit.push({ startMs: start, endMs: end, domain: s.domain, title, url: s.url || undefined });
  }
  return uit;
}

const NOTE = "Bron: de Chrome-extensie op Pauls Chromebook, via de dienst mcp-chromebook op de woonkamer-pc (bestand C:\\mcp\\data\\chromebook-tijd.json); dezelfde gegevens als de Web source 'Chromebook' in ManicTime, die de ManicTime-connector niet teruggeeft. Tijden zijn Europe/Amsterdam. Geen blokken = de Chromebook werd in die periode niet gebruikt (of stond uit); een fout = de gegevens konden niet worden gelezen.";

function fout(e: unknown): ToolResult {
  const code = (e as { code?: string }).code;
  if (code === "ENOENT") return errorResponse({ error: "not_configured", message: `Chromebook-gegevens niet gevonden (${chromebookDataFile()})`, suggestion: "Deze tool werkt alleen op de woonkamer-pc (Overheidsdata via woonkamer.tail122f37.ts.net). Controleer of de dienst mcp-chromebook draait met DATA_FILE." });
  return errorResponse({ error: "unexpected", message: `Chromebook-gegevens niet leesbaar: ${e instanceof Error ? e.message : String(e)}` });
}

export function registerChromebook(server: McpServer, deps: { TOOL_ANNOTATIONS: Record<string, unknown> }): void {
  server.registerTool("chromebook_tijdlijn", {
    description: "Paul's Chromebook timeline: which websites (domain and page title) were open in Chrome on his Chromebook, block by block, for a period. Use this for 'wat deed Paul op de Chromebook', for tagging time in ManicTime and for declaraties: the ManicTime connector does NOT return the Chromebook. Times are local (Europe/Amsterdam). No blocks means the Chromebook was not used in that period.",
    inputSchema: {
      van: z.string().describe("Begin, lokale tijd Europe/Amsterdam: 'JJJJ-MM-DDTUU:MM:SS' of 'JJJJ-MM-DD' (00:00)."),
      tot: z.string().describe("Eind (niet inbegrepen), zelfde vorm, bijv. '2026-11-13' voor heel 12-11."),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async ({ van, tot }) => {
    const vanMs = amsterdamNaarMs(van), totMs = amsterdamNaarMs(tot);
    if (!Number.isFinite(vanMs) || !Number.isFinite(totMs) || totMs <= vanMs) return toMcpToolPayload(errorResponse({ error: "unexpected", message: "van/tot ongeldig", suggestion: "Gebruik 'JJJJ-MM-DDTUU:MM:SS' of 'JJJJ-MM-DD' (lokale tijd), tot later dan van." }));
    if (totMs - vanMs > 31 * 86400000) return toMcpToolPayload(errorResponse({ error: "unexpected", message: "periode langer dan 31 dagen", suggestion: "Vraag hooguit 31 dagen per keer op." }));
    try {
      const { segs, mtime } = leesSegmenten();
      const blokken = chromebookBlokken(segs, vanMs, totMs);
      const records: MCPRecord[] = blokken.map((b) => ({
        title: `${msNaarAmsterdam(b.startMs).slice(11)}–${msNaarAmsterdam(b.endMs).slice(11)} ${b.domain}: ${b.title}`,
        date: msNaarAmsterdam(b.startMs).slice(0, 10),
        source_name: "chromebook",
        canonical_url: b.url || `https://${b.domain}`,
        data: { begin: msNaarAmsterdam(b.startMs), eind: msNaarAmsterdam(b.endMs), duur_s: Math.round((b.endMs - b.startMs) / 1000), domein: b.domain, paginatitel: b.title },
      }));
      const totaal = blokken.reduce((n, b) => n + (b.endMs - b.startMs), 0);
      const laatste = segs.reduce((m, s) => Math.max(m, s.endMs), 0);
      const summary = blokken.length
        ? `${blokken.length} Chromebook-blokken, samen ${Math.round(totaal / 60000)} min, ${van} tot ${tot}`
        : `Geen Chromebook-activiteit van ${van} tot ${tot}: de Chromebook werd toen niet gebruikt (laatste activiteit ooit: ${laatste ? msNaarAmsterdam(laatste) : "geen"}).`;
      return toMcpToolPayload(successResponse({
        summary,
        records,
        provenance: { tool: "chromebook_tijdlijn", endpoint: "mcp-chromebook (DATA_FILE)", query_params: { van, tot }, timestamp: new Date().toISOString(), returned_results: records.length, total_results: records.length },
        access_note: `${NOTE} Laatste ontvangst van de extensie: ${msNaarAmsterdam(mtime)}.`,
      }));
    } catch (e) {
      return toMcpToolPayload(fout(e));
    }
  });

  server.registerTool("chromebook_status", {
    description: "Status of Paul's Chromebook time tracking: when the Chrome extension last sent data, the last activity, and blocks and minutes today. Use before concluding the Chromebook was off.",
    inputSchema: {},
    annotations: deps.TOOL_ANNOTATIONS,
  }, async () => {
    try {
      const { segs, mtime } = leesSegmenten();
      const vandaag = msNaarAmsterdam(Date.now()).slice(0, 10);
      const vanMs = amsterdamNaarMs(vandaag);
      const blokken = chromebookBlokken(segs, vanMs, vanMs + 86400000 + 3600000);
      const laatste = segs.reduce((m, s) => Math.max(m, s.endMs), 0);
      const min = Math.round(blokken.reduce((n, b) => n + (b.endMs - b.startMs), 0) / 60000);
      return toMcpToolPayload(successResponse({
        summary: `Laatste ontvangst ${msNaarAmsterdam(mtime)}; laatste activiteit ${laatste ? msNaarAmsterdam(laatste) : "geen"}; vandaag ${blokken.length} blokken, ${min} min.`,
        records: [{ title: "Chromebook-tijd", source_name: "chromebook", canonical_url: "https://github.com/paulpavlnl/chromebook-tijd", data: { laatste_ontvangst: msNaarAmsterdam(mtime), laatste_activiteit: laatste ? msNaarAmsterdam(laatste) : null, vandaag_blokken: blokken.length, vandaag_minuten: min, segmenten_totaal: segs.length, eerste_activiteit: segs.length ? msNaarAmsterdam(Math.min(...segs.map((s) => s.startMs))) : null } }],
        provenance: { tool: "chromebook_status", endpoint: "mcp-chromebook (DATA_FILE)", query_params: {}, timestamp: new Date().toISOString(), returned_results: 1 },
        access_note: NOTE,
      }));
    } catch (e) {
      return toMcpToolPayload(fout(e));
    }
  });
}
