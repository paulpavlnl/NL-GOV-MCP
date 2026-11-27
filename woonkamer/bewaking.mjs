#!/usr/bin/env node
/**
 * Waakhond voor de woonkamer-pc (draait elke 2 minuten als SYSTEM, via C:\mcp\install\funnel-bewaking.ps1).
 *
 * 1. Diensten: elke route achter de proxy moet lokaal antwoorden (HTTP < 500). Twee keer achter elkaar
 *    niet → dienst herstarten (hoogstens eens per 10 minuten per dienst). Proxy zelf eerst.
 * 2. Funnel en Tailscale: de Funnel-relays van buitenaf (publieke DNS) en `tailscale status`.
 *    Gaat het mis, dan per netwerkadapter (met standaardroute) testen of controlplane.tailscale.com
 *    bereikbaar is. Werkt een adapter niet terwijl een andere wel werkt: die adapter herstarten
 *    (hoogstens eens per 15 minuten). Daarna, of anders, Tailscale herstarten (hoogstens eens per 5 minuten).
 *    Aanleiding: 26/27-11-2026 hing de USB-adapter, Tailscale raakte uitgelogd en Tailscale herstarten hielp niet.
 * 3. Alarm: duurt een storing (Funnel of een dienst) 15 minuten of langer, dan één melding via de
 *    projecttaak (C:\mcp\data\claude-taken\taak.json, zelfde route als het voorfilter Claude-taken),
 *    herhaald na 6 uur als hij er nog is. Na herstel een korte melding "opgelost".
 *
 * Droog (niets herstarten, niets afvuren): --droog of WOONKAMER_BEWAKING_DROOG=1.
 * Uit: bestand C:\mcp\data\bewaking\uit (dan alleen meten en loggen).
 * Exitcode 0 altijd (de oude ps1 herstartte bij exitcode 1 zelf Tailscale; dat doet dit script nu zelf).
 */
import https from "node:https";
import http from "node:http";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = process.env.MCP_ROOT || "C:\\mcp";
const HOST = process.env.WOONKAMER_HOST || "woonkamer.tail122f37.ts.net";
const LOG = path.join(ROOT, "logs", "funnel-bewaking.log");
const MAP = path.join(ROOT, "data", "bewaking");
const STAAT = path.join(MAP, "staat.json");
const STATUS = path.join(MAP, "status.json");
const TAAK = path.join(ROOT, "data", "claude-taken", "taak.json");
const TS = "C:\\Program Files\\Tailscale\\tailscale.exe";
const PROXY = process.env.WOONKAMER_PROXY || "http://127.0.0.1:8080";
const DROOG = process.argv.includes("--droog") || process.env.WOONKAMER_BEWAKING_DROOG === "1";
const UIT = fs.existsSync(path.join(MAP, "uit"));
const MIN = 60_000;

/** route → [health-pad, dienst]. Health-pad null: elke HTTP-status < 500 telt als "antwoordt". */
export const ROUTES = {
  "/nlgov": ["/health", "mcp-nlgov"],
  "/workflowy": ["/healthz", "mcp-workflowy"],
  "/studie": ["/healthz", "mcp-studie"],
  "/verwijzing": ["/healthz", "mcp-verwijzing"],
  "/chromebook": ["/health", "mcp-chromebook"],
  "/mail": ["/health", "mcp-mail"],
  "/eboekhouden": ["/healthz", "mcp-eboekhouden"],
  "/garmin": ["/health", "mcp-garmin"],
  "/rvr": ["/health", "mcp-rvr"],
  "/spraak": ["/health", "mcp-spraak"],
  "/whatsapp": [null, "mcp-whatsapp"],
  "/onenote": [null, null], // geplande taak OneNoteConnector met eigen waakhond: alleen alarm
};

const nu = () => Date.now();
const regels = [];
function log(t) { regels.push(`${new Date().toISOString()} ${t}`); }
function leesJson(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } }
function ps(cmd) { return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", timeout: 90_000 }); }
function magOpnieuw(staat, sleutel, minuten) { const t = staat.acties?.[sleutel]; return !t || nu() - t >= minuten * MIN; }
function gedaan(staat, sleutel) { (staat.acties ||= {})[sleutel] = nu(); }

function haal(url, { host, timeout = 20_000, localAddress } = {}) {
  return new Promise((ok) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout, localAddress, headers: host ? { host } : {} }, (x) => { x.resume(); ok(x.statusCode); });
    req.on("timeout", () => { req.destroy(); ok("timeout"); });
    req.on("error", (e) => ok(e.code || e.message));
  });
}

/** Elke route lokaal via de proxy. */
export async function controleerDiensten() {
  const uit = {};
  for (const [route, [pad]] of Object.entries(ROUTES)) {
    const s = await haal(`${PROXY}${route}${pad || "/"}`, { host: HOST });
    uit[route] = { status: s, goed: typeof s === "number" && s < 500 };
  }
  return uit;
}

/** Funnel-relays van buitenaf, zoals de oude funnel-bewaking.mjs. */
async function controleerFunnel() {
  const r = new dns.Resolver(); r.setServers(["8.8.8.8", "1.1.1.1"]);
  const ips = await new Promise((ok) => r.resolve4(HOST, (e, a) => ok(e ? [] : a)));
  const fout = [];
  for (const ip of ips) {
    let goed = false;
    for (let i = 0; i < 3 && !goed; i++) {
      const s = await new Promise((ok) => https.get({ host: ip, servername: HOST, headers: { host: HOST }, path: "/nlgov/health", timeout: 20000 }, (x) => { x.resume(); ok(x.statusCode); }).on("timeout", function () { this.destroy(); }).on("error", (e) => ok(e.code || e.message)));
      goed = s === 200;
    }
    if (!goed) fout.push(ip);
  }
  return { relays: ips.length, fout };
}

function tailscaleStaat() {
  try { return JSON.parse(execFileSync(TS, ["status", "--json"], { encoding: "utf8", timeout: 30_000 })).BackendState || "?"; }
  catch (e) { return `fout: ${String(e.message).slice(0, 80)}`; }
}

/** IPv4-adapters met een standaardroute, elk getest tegen controlplane.tailscale.com. */
async function testAdapters() {
  let lijst = [];
  try {
    const js = ps("$r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select -Expand ifIndex -Unique; Get-NetIPAddress -AddressFamily IPv4 | ? { $_.InterfaceIndex -in $r -and (Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue).Status -eq 'Up' -and $_.IPAddress -notlike '169.254.*' } | Select InterfaceAlias,IPAddress | ConvertTo-Json -Compress");
    lijst = [].concat(JSON.parse(js || "[]"));
  } catch (e) { log(`adapters lezen mislukt: ${String(e.message).slice(0, 100)}`); }
  for (const a of lijst) {
    const s = await haal("https://controlplane.tailscale.com/key?v=148", { timeout: 10_000, localAddress: a.IPAddress });
    a.goed = s === 200; a.status = s;
  }
  return lijst;
}

async function vuur(tekst) {
  const cfg = leesJson(TAAK, null);
  if (!cfg?.url || !cfg?.token) throw new Error("taak.json ontbreekt of is onvolledig");
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "experimental-cc-routine-2026-04-01", "content-type": "application/json" },
    body: JSON.stringify({ text: tekst }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`fire ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const tijd = (ms) => new Date(ms).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

async function main() {
  fs.mkdirSync(MAP, { recursive: true });
  const staat = leesJson(STAAT, {});
  staat.fouten ||= {};
  const doe = !DROOG && !UIT;

  // 1. Diensten
  const diensten = await controleerDiensten();
  const allesStuk = Object.values(diensten).every((d) => !d.goed);
  for (const [route, d] of Object.entries(diensten)) {
    const reeks = d.goed ? 0 : (staat.fouten[route] || 0) + 1;
    staat.fouten[route] = reeks;
    if (d.goed) continue;
    const dienst = allesStuk ? "mcp-proxy" : ROUTES[route][1];
    log(`dienst ${route} antwoordt niet (${d.status}), ${reeks}e keer`);
    if (reeks < 2 || !dienst) continue;
    if (!magOpnieuw(staat, dienst, 10)) continue;
    if (doe) { try { ps(`Restart-Service ${dienst} -Force`); log(`${dienst} herstart`); } catch (e) { log(`${dienst} herstart mislukt: ${String(e.message).slice(0, 100)}`); } }
    else log(`zou ${dienst} herstarten`);
    gedaan(staat, dienst);
    if (allesStuk) break;
  }

  // 2. Funnel en Tailscale
  const funnel = await controleerFunnel();
  const ts = tailscaleStaat();
  const funnelGoed = funnel.relays > 0 && funnel.fout.length === 0 && ts === "Running";
  log(`relays ${funnel.relays}, fout: ${funnel.fout.join(" ") || "geen"}, tailscale ${ts}`);
  let adapters = null;
  if (!funnelGoed && !allesStuk) {
    adapters = await testAdapters();
    log(`adapters: ${adapters.map((a) => `${a.InterfaceAlias}=${a.goed ? "goed" : a.status}`).join(", ") || "geen"}`);
    const goed = adapters.filter((a) => a.goed), stuk = adapters.filter((a) => !a.goed);
    let adapterHerstart = false;
    if (goed.length && stuk.length) {
      for (const a of stuk) {
        const k = `adapter:${a.InterfaceAlias}`;
        if (!magOpnieuw(staat, k, 15)) continue;
        if (doe) { try { ps(`Restart-NetAdapter -Name '${a.InterfaceAlias.replace(/'/g, "''")}' -Confirm:$false`); log(`adapter ${a.InterfaceAlias} herstart`); adapterHerstart = true; } catch (e) { log(`adapter ${a.InterfaceAlias} herstart mislukt: ${String(e.message).slice(0, 100)}`); } }
        else log(`zou adapter ${a.InterfaceAlias} herstarten`);
        gedaan(staat, k);
      }
    }
    const tsWacht = goed.length ? 5 : 15; // zonder internet niet elke 5 minuten
    if (adapterHerstart || magOpnieuw(staat, "tailscale", tsWacht)) {
      if (doe) {
        if (adapterHerstart) await new Promise((r) => setTimeout(r, 15_000));
        try { ps("Restart-Service Tailscale -Force"); log("Tailscale herstart"); } catch (e) { log(`Tailscale herstart mislukt: ${String(e.message).slice(0, 100)}`); }
      } else log("zou Tailscale herstarten");
      gedaan(staat, "tailscale");
    }
  }

  // 3. Alarm bij een storing van 15 minuten of langer
  const problemen = [];
  if (!funnelGoed) problemen.push(`Funnel/Tailscale (tailscale ${ts}, relays ${funnel.relays}, fout ${funnel.fout.length})`);
  for (const [route, d] of Object.entries(diensten)) if (!d.goed) problemen.push(`${route} antwoordt lokaal niet (${d.status})`);
  if (problemen.length) {
    staat.storing_sinds ||= nu();
    const duur = nu() - staat.storing_sinds;
    const herhaal = staat.alarm_om && nu() - staat.alarm_om >= 6 * 60 * MIN;
    if (duur >= 15 * MIN && (!staat.alarm_om || herhaal)) {
      const tekst = `MCP-storing woonkamer-pc sinds ${tijd(staat.storing_sinds)} (waakhond, automatisch). ` +
        `Problemen: ${problemen.join("; ")}. ` +
        (adapters ? `Adapters: ${adapters.map((a) => `${a.InterfaceAlias}=${a.goed ? "goed" : a.status}`).join(", ")}. ` : "") +
        `De waakhond heeft zelf herstel geprobeerd (zie C:\\mcp\\logs\\funnel-bewaking.log). ` +
        `Start een beheersessie in C:\\mcp op de woonkamer-pc om het te herstellen; zie C:\\mcp\\CLAUDE.md (storing 26/27-11-2026). Verwijder niets.`;
      if (doe) { try { await vuur(tekst); staat.alarm_om = nu(); log(`alarm verstuurd: ${problemen.length} probleem/problemen`); } catch (e) { log(`alarm mislukt: ${String(e.message).slice(0, 150)}`); } }
      else { log(`zou alarm sturen: ${tekst.slice(0, 160)}`); }
    }
  } else if (staat.storing_sinds) {
    if (staat.alarm_om) {
      const tekst = `MCP-storing woonkamer-pc opgelost om ${tijd(nu())} (begon ${tijd(staat.storing_sinds)}). Geen actie nodig; zie C:\\mcp\\logs\\funnel-bewaking.log.`;
      if (doe) { try { await vuur(tekst); log("opgelost gemeld"); } catch (e) { log(`opgelost-melding mislukt: ${String(e.message).slice(0, 150)}`); } }
      else log("zou opgelost melden");
    }
    delete staat.storing_sinds; delete staat.alarm_om;
  }

  const status = { tijd: new Date().toISOString(), droog: DROOG, uit: UIT, funnel: { ...funnel, tailscale: ts, goed: funnelGoed }, diensten, adapters, storing_sinds: staat.storing_sinds ? new Date(staat.storing_sinds).toISOString() : null, alarm_om: staat.alarm_om ? new Date(staat.alarm_om).toISOString() : null };
  if (!DROOG) { fs.writeFileSync(STAAT, JSON.stringify(staat, null, 1)); fs.writeFileSync(STATUS, JSON.stringify(status, null, 1)); }
  else console.log(JSON.stringify(status, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (e) { log(`fout: ${e.stack || e}`); }
  if (DROOG) console.log(regels.join("\n"));
  else try { fs.appendFileSync(LOG, regels.join("\n") + "\n"); } catch {}
  process.exit(0);
}
