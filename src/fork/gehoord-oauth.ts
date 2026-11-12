/**
 * FORK (docs/FORK.md): Gehoord.de zonder GEHOORD_KEY, via de eigen MCP-server
 * van Gehoord.de (https://gehoord.de/api/mcp) met een OAuth-token van het
 * account van de gebruiker. Gehoord geeft REST-sleutels (/api/v1) alleen op
 * aanvraag; de MCP-server is open voor elk account (scope transcripts:read).
 *
 * Inloggen: eenmalig `node scripts/gehoord-inloggen.mjs` (dynamische
 * registratie + PKCE); dat schrijft gehoord-oauth.json in de repomap. Hier
 * wordt het access token zo nodig ververst met het refresh token en
 * teruggeschreven. De tools van Gehoord geven tekst terug; elk item ("- ...")
 * wordt één record.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MCPRecord, ToolResult } from "../types.js";
import { errorResponse, successResponse } from "../utils/response.js";

export const GEHOORD_MCP_URL = "https://gehoord.de/api/mcp";
const TIMEOUT_MS = 30_000;

interface OauthFile {
  client_id: string;
  client_secret?: string;
  token_endpoint: string;
  resource?: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
}

/** Waar gehoord-oauth.json staat: GEHOORD_OAUTH_FILE, anders de repomap (vanuit src/fork of dist/src/fork). */
export function gehoordOauthPath(): string | undefined {
  const env = process.env.GEHOORD_OAUTH_FILE?.trim();
  if (env) return fs.existsSync(env) ? env : undefined;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "../..", "gehoord-oauth.json"), path.resolve(here, "../../..", "gehoord-oauth.json"), path.resolve(process.cwd(), "gehoord-oauth.json")];
  return candidates.find((p) => fs.existsSync(p));
}

/** Is er een OAuth-koppeling met Gehoord.de (bestand met refresh token)? */
export function gehoordOauthBeschikbaar(): boolean {
  const p = gehoordOauthPath();
  if (!p) return false;
  try {
    const o = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<OauthFile>;
    return Boolean(o.access_token && (o.refresh_token || (o.expires_at ?? 0) > Date.now()));
  } catch {
    return false;
  }
}

let verversing: Promise<string> | undefined;

async function accessToken(): Promise<string> {
  const p = gehoordOauthPath();
  if (!p) throw new Error("geen gehoord-oauth.json");
  const o = JSON.parse(fs.readFileSync(p, "utf8")) as OauthFile;
  if (o.expires_at - 60_000 > Date.now()) return o.access_token;
  if (!o.refresh_token) throw new Error("Gehoord-token verlopen en geen refresh token");
  verversing ??= (async () => {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: o.refresh_token!, client_id: o.client_id });
    if (o.client_secret) body.set("client_secret", o.client_secret);
    if (o.resource) body.set("resource", o.resource);
    const r = await fetch(o.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!r.ok || !j.access_token) throw new Error(`Gehoord-token verversen mislukt (HTTP ${r.status})`);
    const nieuw: OauthFile = { ...o, access_token: j.access_token, refresh_token: j.refresh_token ?? o.refresh_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 };
    fs.writeFileSync(p, JSON.stringify(nieuw, null, 2));
    return nieuw.access_token;
  })().finally(() => { verversing = undefined; });
  return verversing;
}

let volgnummer = 0;

async function rpc(token: string, method: string, params: unknown, sessionId?: string): Promise<{ result: any; sessionId?: string }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const r = await fetch(GEHOORD_MCP_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++volgnummer, method, params }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await r.text();
  if (r.status === 401) throw Object.assign(new Error("Gehoord.de weigert het token (401)"), { status: 401 });
  if (!r.ok) throw Object.assign(new Error(`Gehoord.de MCP HTTP ${r.status}`), { status: r.status });
  // JSON, of SSE met "data: {...}"-regels: neem het laatste JSON-RPC-object.
  const blokken = text.includes("data:") ? text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()) : [text];
  const laatste = blokken.filter(Boolean).pop() ?? "{}";
  const j = JSON.parse(laatste) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(`Gehoord.de MCP: ${j.error.message ?? "fout"}`);
  return { result: j.result, sessionId: r.headers.get("mcp-session-id") ?? sessionId };
}

/** Roept één tool van de Gehoord.de-MCP aan; geeft de tekst terug. */
export async function gehoordMcpCall(name: string, args: Record<string, unknown>): Promise<string> {
  const token = await accessToken();
  const init = await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nl-gov-mcp", version: "1" } });
  const res = await rpc(token, "tools/call", { name, arguments: Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== "")) }, init.sessionId);
  const text = ((res.result?.content ?? []) as Array<{ type?: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  if (res.result?.isError) throw new Error(text || "Gehoord.de gaf een fout");
  return text;
}

/** Zet de tekst van Gehoord om in records: elk "- "-item één record; de kop is de samenvatting. */
export function gehoordTekstRecords(text: string): { summary: string; records: MCPRecord[]; vervolg?: string } {
  const delen = text.split(/\n(?=- )/);
  const kop = delen[0].startsWith("- ") ? "" : delen.shift()!.trim();
  const laatste = delen.length ? delen[delen.length - 1] : "";
  const vervolgMatch = /\n\n(Nog [^\n]*|Volgende pagina[^\n]*|[^\n]*offset=\d+[^\n]*)\s*$/.exec(laatste);
  if (vervolgMatch && delen.length) delen[delen.length - 1] = laatste.slice(0, vervolgMatch.index);
  const records: MCPRecord[] = delen.map((d): MCPRecord => {
    const regels = d.replace(/^- /, "").split("\n");
    const titel = regels[0].trim();
    const link = /https:\/\/gehoord\.de\/\S+/.exec(d)?.[0];
    const id = /#(\d+)/.exec(titel)?.[1];
    const datum = /(\d{2})-(\d{2})-(\d{4})/.exec(titel);
    return {
      title: titel,
      date: datum ? `${datum[3]}-${datum[2]}-${datum[1]}` : undefined,
      source_name: "gehoord",
      canonical_url: link ?? (id ? `https://gehoord.de/beraadslagingen/${id}` : "https://gehoord.de/beraadslagingen"),
      snippet: regels.slice(1).join("\n").trim() || undefined,
      data: { debat_id: id, tekst: d.trim() },
    };
  });
  if (!records.length && kop) records.push({ title: kop.split("\n")[0], source_name: "gehoord", canonical_url: /https:\/\/gehoord\.de\/\S+/.exec(kop)?.[0] ?? "https://gehoord.de/beraadslagingen", data: { tekst: kop } });
  return { summary: (kop.split("\n")[0] || `${records.length} resultaat/resultaten van Gehoord.de`).trim(), records, vervolg: vervolgMatch?.[1] };
}

const NOTE = "Via de MCP-server van Gehoord.de met het account van de gebruiker (OAuth; geen GEHOORD_KEY): automatische transcriptie zonder koppeling met het officiële verslag; geschikt om te vinden, niet om te citeren (citeer uit de Handelingen). De tekst per record staat in data.tekst.";

function fout(e: unknown): ToolResult {
  const status = (e as { status?: number }).status;
  if (status === 401) return errorResponse({ error: "not_configured", message: "Gehoord.de-koppeling verlopen of ingetrokken", suggestion: "Opnieuw koppelen: node scripts/gehoord-inloggen.mjs in de repomap, dan Toestaan op gehoord.de." });
  const msg = e instanceof Error ? e.message : String(e);
  return errorResponse({ error: /timeout|abort/i.test(msg) ? "timeout" : "http_error", message: msg, retry_after: 30 });
}

function resultaat(tool: string, upstream: string, args: Record<string, unknown>, text: string, extra: Array<string | undefined>, offset: number, limit: number): ToolResult {
  const { summary, records, vervolg } = gehoordTekstRecords(text);
  const totaal = /^(\d+)\s/.exec(summary)?.[1];
  return successResponse({
    summary,
    records,
    provenance: { tool, endpoint: `${GEHOORD_MCP_URL} (${upstream})`, query_params: Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])), timestamp: new Date().toISOString(), returned_results: records.length, total_results: totaal ? Number(totaal) : undefined },
    access_note: [NOTE, ...extra, vervolg].filter(Boolean).join(" "),
    pagination: { offset, limit, total: totaal ? Number(totaal) : null, has_more: Boolean(vervolg) },
  });
}

const MATCH: Record<string, string> = { alle: "all", een: "any", woordgroep: "phrase" };

/** gehoord_debatten_search via de Gehoord-MCP (search_transcripts). */
export async function gehoordOauthSearch(args: { query: string; match?: string; date_from?: string; date_to?: string; kamer?: string; fractie?: string; spreker?: string; debat_id?: string | number; top: number; offset: number }): Promise<ToolResult> {
  const call = { q: args.query.trim(), match: MATCH[args.match ?? "alle"] ?? "all", debate_id: args.debat_id, from: args.date_from, to: args.date_to, limit: Math.min(args.top, 50), offset: args.offset };
  const niet = [args.kamer && "kamer", args.fractie && "fractie", args.spreker && "spreker"].filter(Boolean);
  try {
    const text = await gehoordMcpCall("search_transcripts", call);
    return resultaat("gehoord_debatten_search", "search_transcripts", call, text, [niet.length ? `Filter(s) ${niet.join(", ")} kan de Gehoord-MCP niet toepassen: niet gefilterd; voeg de naam of fractie desnoods aan de zoekwoorden toe.` : undefined], args.offset, call.limit);
  } catch (e) {
    return fout(e);
  }
}

/** gehoord_debatten_list via de Gehoord-MCP (search_debates). */
export async function gehoordOauthList(args: { kamer?: string; status?: string; date_from?: string; date_to?: string; top: number; offset: number }): Promise<ToolResult> {
  const call = { chamber: args.kamer, status: args.status, from: args.date_from, to: args.date_to, limit: Math.min(args.top, 50), offset: args.offset };
  try {
    return resultaat("gehoord_debatten_list", "search_debates", call, await gehoordMcpCall("search_debates", call), [], args.offset, call.limit);
  } catch (e) {
    return fout(e);
  }
}

/** gehoord_debat_get via de Gehoord-MCP (get_debate + get_transcript); segment_id wordt niet ondersteund. */
export async function gehoordOauthDebat(args: { debate_id: string; segment_id?: string; offset: number; max_chars: number }): Promise<ToolResult> {
  try {
    const debat = await gehoordMcpCall("get_debate", { debate_id: args.debate_id });
    const call = { debate_id: args.debate_id, offset: args.offset, max_chars: 40_000 };
    const transcript = await gehoordMcpCall("get_transcript", call);
    const vervolg = /(offset=\d+)[^\n]*\s*$/.exec(transcript)?.[0];
    const titel = debat.split("\n")[0].replace(/^#+\s*/, "").trim();
    const record: MCPRecord = { title: titel || `Debat ${args.debate_id}`, source_name: "gehoord", canonical_url: /https:\/\/gehoord\.de\/\S+/.exec(debat)?.[0] ?? `https://gehoord.de/beraadslagingen/${args.debate_id}`, data: { debat_id: args.debate_id, debat: debat.trim(), tekst: transcript.trim() } };
    return successResponse({
      summary: `Debat ${titel || args.debate_id}: transcript vanaf fragment ${args.offset}`,
      records: [record],
      provenance: { tool: "gehoord_debat_get", endpoint: `${GEHOORD_MCP_URL} (get_debate, get_transcript)`, query_params: { debate_id: args.debate_id, offset: String(args.offset), max_chars: String(call.max_chars) }, timestamp: new Date().toISOString(), returned_results: 1 },
      access_note: [NOTE, "data.debat: gegevens en sprekers; data.tekst: het transcript in debatvolgorde.", args.segment_id ? "segment_id kan de Gehoord-MCP niet gebruiken: het transcript begint bij offset." : undefined, vervolg ? `Meer transcript: ${vervolg}.` : undefined].filter(Boolean).join(" "),
      pagination: { offset: args.offset, limit: 1, total: null, has_more: Boolean(vervolg) },
    });
  } catch (e) {
    return fout(e);
  }
}
