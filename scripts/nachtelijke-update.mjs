#!/usr/bin/env node
/**
 * FORK: de nachtelijke update op de eigen computers (geplande taak "MCP nachtelijke update", ingesteld door
 * update-lokaal.cmd). Volgorde:
 *  1. Is er iets bij te werken? Zo niet (of is GitHub onbereikbaar): klaar, Claude blijft open. Veranderen alleen
 *     documentatie, tests of workflows, dan wordt bijgewerkt zonder Claude te sluiten.
 *  2. Claude sluiten (de servers houden anders bestanden vast), maar alleen als vaststaat hoe hij weer te starten
 *     is (app-ID uit Get-StartApps, of het pad). Buiten de nacht (01:00-06:00) alleen als Claude niet draait:
 *     een gemiste taak die 's ochtends alsnog start, sluit Claude nooit midden in het werk.
 *  3. Bijwerken (update-local.mjs: pull, npm install, build; bij een fout de vorige versie terug).
 *  4. Rooktest: elke server start via stdio en geeft zijn tools.
 *  5. Claude weer starten als hij open was (via de app-ID, anders het pad), en controleren dat hij binnen een
 *     minuut echt draait; anders een tweede poging op de andere manier, en lukt dat niet: een melding.
 *  6. Mislukt er iets: een taak in de Workflowy-Inbox met de computer, wat er misging en het logboek, zodat de
 *     dagronde het meldt en Claude het kan herstellen. Logboek: %USERPROFILE%\mcp-lokaal\nachtelijke-update.log.
 *
 *   node scripts/nachtelijke-update.mjs [--droog]   (--droog: niets sluiten of starten; voor tests)
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { heeftUpdate, logboek, repos, rookTest, update } from "./update-local.mjs";
import { meldWorkflowy } from "./meld-workflowy.mjs";

const droog = process.argv.includes("--droog");
const win = process.platform === "win32";
const map = join(os.homedir(), "mcp-lokaal");
const logBestand = join(map, "nachtelijke-update.log");
const padBestand = join(map, "claude-pad.txt");
const computer = os.hostname();
const uur = new Date().getHours();
const nacht = uur >= 1 && uur < 6;

const log = (m) => { const r = `${new Date().toISOString()} ${m}`; console.log(r); try { mkdirSync(map, { recursive: true }); appendFileSync(logBestand, `${r}\n`); } catch { /* geen schijf */ } };
const ps = (cmd) => spawnSync("powershell.exe", ["-NoProfile", "-Command", cmd], { encoding: "utf8", windowsHide: true, timeout: 30_000 });

/** Pad van de draaiende Claude-app (en onthoud het), of het laatst bekende / standaardpad. */
function claudePad() {
  if (!win) return undefined;
  const r = ps("(Get-Process -Name Claude -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path)");
  const nu = r.stdout?.trim();
  if (nu) { try { writeFileSync(padBestand, nu); } catch { /* niet erg */ } return nu; }
  if (existsSync(padBestand)) { const p = readFileSync(padBestand, "utf8").trim(); if (p && existsSync(p)) return p; }
  return [join(process.env.LOCALAPPDATA ?? "", "AnthropicClaude", "claude.exe"), join(process.env.LOCALAPPDATA ?? "", "Programs", "Claude", "Claude.exe")].find(existsSync);
}
const claudeDraait = () => win && /claude\.exe/i.test(spawnSync("tasklist", ["/FI", "IMAGENAME eq Claude.exe", "/NH"], { encoding: "utf8", windowsHide: true }).stdout ?? "");

async function sluitClaude() {
  spawnSync("taskkill", ["/IM", "Claude.exe", "/T"], { windowsHide: true });
  for (let i = 0; i < 20 && claudeDraait(); i++) await new Promise((r) => setTimeout(r, 1000));
  if (claudeDraait()) spawnSync("taskkill", ["/F", "/IM", "Claude.exe", "/T"], { windowsHide: true });
  await new Promise((r) => setTimeout(r, 3000)); // de servers (node) laten afsluiten
  return !claudeDraait();
}
/** De app-ID van Claude in het startmenu (werkt ook voor een Store/MSIX-installatie), of undefined. */
function claudeAppId() {
  if (!win) return undefined;
  const r = ps("(Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1 -ExpandProperty AppID)");
  return r.stdout?.trim() || undefined;
}
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
/** Start Claude (eerst via de app-ID, dan via het pad) en controleer dat hij binnen een minuut draait. */
async function startClaude({ appId, pad }) {
  const manieren = [
    appId && { naam: `app-ID ${appId}`, start: () => spawn("explorer.exe", [`shell:AppsFolder\\${appId}`], { detached: true, stdio: "ignore", windowsHide: true }).unref() },
    pad && { naam: pad, start: () => spawn("cmd.exe", ["/c", "start", "", pad], { detached: true, stdio: "ignore", windowsHide: true }).unref() },
  ].filter(Boolean);
  for (const m of manieren) {
    try { m.start(); } catch (e) { log(`Starten via ${m.naam} mislukt: ${e instanceof Error ? e.message : e}`); continue; }
    for (let i = 0; i < 60; i++) { await wacht(1000); if (claudeDraait()) return { ok: true, via: m.naam }; }
    log(`Claude draait niet na starten via ${m.naam}.`);
  }
  return { ok: false, via: manieren.map((m) => m.naam).join(" en ") || "geen app-ID of pad bekend" };
}

const problemen = [];
try {
  log(`Nachtelijke update op ${computer} (${droog ? "droog" : win ? "Windows" : process.platform}).`);
  const plan = repos.map((r) => ({ r, ...heeftUpdate(r) }));
  for (const p of plan.filter((x) => x.fout)) log(`${p.r.name}: ${p.fout}; overgeslagen.`);
  const teDoen = plan.filter((x) => x.bijwerken);
  if (!teDoen.length) { log("Niets bij te werken; Claude niet gesloten."); process.exit(0); }
  const herstart = teDoen.some((x) => x.herstart);
  log(`Bij te werken: ${teDoen.map((x) => x.r.name).join(", ")}${herstart ? "" : " (alleen documentatie/tests: zonder Claude te sluiten)"}.`);

  const wasOpen = claudeDraait();
  const pad = claudePad(), appId = claudeAppId();
  let gesloten = false;
  if (wasOpen && herstart) {
    if (!nacht && !droog) { log("Claude is open en het is geen nacht: niet gesloten, de update volgt de volgende nacht."); process.exit(0); }
    if (!appId && !pad) { problemen.push("Claude niet gesloten en niet bijgewerkt: geen app-ID of pad bekend om hem daarna weer te starten"); throw new Error("stop"); }
    if (!droog) { log(`Claude sluiten (weer starten via ${appId ? `app-ID ${appId}` : pad})…`); gesloten = await sluitClaude(); if (!gesloten) problemen.push("Claude kon niet worden gesloten"); }
  }

  for (const x of teDoen) if (!update(x.r)) problemen.push(`${x.r.name}: bijwerken mislukt`);
  for (const r of repos) {
    const t = await rookTest(r);
    log(t.ok ? `Rooktest ${r.name}: ${t.tools} tools.` : `Rooktest ${r.name} MISLUKT: ${t.fout}`);
    if (!t.ok) problemen.push(`${r.name}: start niet (${t.fout})`);
  }

  if (wasOpen && herstart && !droog && !claudeDraait()) {
    const s = await startClaude({ appId, pad });
    if (s.ok) log(`Claude weer gestart (via ${s.via}) en draait.`);
    else problemen.push(`Claude is gesloten maar draait niet na opnieuw starten (geprobeerd: ${s.via}): start hem met de hand`);
  }
} catch (e) {
  if (!(e instanceof Error && e.message === "stop")) problemen.push(`onverwachte fout: ${e instanceof Error ? e.message : e}`);
}

for (const l of logboek) log(`  ${l.trim()}`);
if (problemen.length) {
  log(`MISLUKT: ${problemen.join("; ")}`);
  const r = await meldWorkflowy({
    titel: `⚠️ Nachtelijke MCP-update mislukt op ${computer}: ${problemen.join("; ").slice(0, 200)}`,
    notitie: [`Computer: ${computer}`, `Tijd: ${new Date().toLocaleString("nl-NL")}`, `Wat: ${problemen.join("; ")}`, "", "Opdracht voor Claude: herstel de nachtelijke MCP-update op deze computer (NL-GOV-MCP en verwijzingscontroleur in %USERPROFILE%\\mcp-lokaal).", `Logboek: ${logBestand}`, "", ...logboek.slice(-40)].join("\n"),
  });
  log(r.ok ? "Gemeld in de Workflowy-Inbox." : `Melden in Workflowy mislukt: ${r.fout}`);
  process.exitCode = 1;
} else log("Klaar: bijgewerkt en getest.");
