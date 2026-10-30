#!/usr/bin/env node
/**
 * Beheer van alle MCP-servers op de woonkamer-pc (Windows, altijd aan). Geen afhankelijkheden.
 *
 *   node woonkamer.mjs run <naam>        start één server met zijn geheimen (zo start NSSM hem)
 *   node woonkamer.mjs setup [naam...]   clonen (of bijwerken) en bouwen, zonder de diensten te herstarten
 *   node woonkamer.mjs update            elk uur: nieuwe commits ophalen, bouwen, dienst herstarten; bij een fout terug
 *   node woonkamer.mjs status            lokaal en publiek nagaan of elke server antwoordt; schrijft urls.txt
 *   node woonkamer.mjs render-env        geheimen uit Render halen (RENDER_API_KEY of secrets/render-api-key.txt)
 *
 * Mappen onder MCP_ROOT (standaard C:\mcp): repos/<naam>, secrets/<naam>.json (geheimen van die server),
 * secrets/config.json ({ "host": "<pc>.<tailnet>.ts.net" }), data/, logs/.
 * Servers die niet op GitHub staan (WhatsApp, OneNote) staan in secrets/services.local.json, in dezelfde vorm
 * zonder "repo"; hun code staat al in repos/<naam>. Dat bestand blijft buiten git, dus een update wist het niet.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.MCP_ROOT || (process.platform === "win32" ? "C:\\mcp" : join(here, ".mcp"));
const WIN = process.platform === "win32";
export const services = [
  ...JSON.parse(readFileSync(join(here, "services.json"), "utf8")),
  ...leesJson(join(ROOT, "secrets", "services.local.json"), []),
];
const repoDir = (s) => join(ROOT, "repos", s.name);
const secretFile = (s) => join(ROOT, "secrets", `${s.name}.json`);
const dienst = (s) => `mcp-${s.name}`;

export function leesJson(file, standaard) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return standaard; }
}
const config = () => leesJson(join(ROOT, "secrets", "config.json"), {});

function log(m) {
  const regel = `${new Date().toISOString()} ${m}`;
  console.log(regel);
  try { mkdirSync(join(ROOT, "logs"), { recursive: true }); appendFileSync(join(ROOT, "logs", "woonkamer.log"), `${regel}\n`); } catch { /* geen log */ }
}

/** ${HOST}, ${ROOT} en ${GEHEIM} in services.json invullen. */
function vul(tekst, geheimen) {
  const waarden = { HOST: config().host || "localhost", ROOT: ROOT.replace(/\\/g, "/"), ...geheimen };
  return tekst.replace(/\$\{(\w+)\}/g, (_, k) => waarden[k] ?? "");
}

/** De omgeving van een server: Windows-omgeving, dan zijn geheimen uit Render, dan de vaste lokale waarden. */
export function omgeving(s, basis = process.env) {
  const geheimen = leesJson(secretFile(s), {});
  const env = { ...basis, ...geheimen };
  for (const [k, v] of Object.entries(s.env || {})) env[k] = vul(v, geheimen);
  for (const k of s.zonder || []) delete env[k];
  for (const k of ["NODE_VERSION", "PYTHON_VERSION", "RENDER", "RENDER_SERVICE_ID"]) delete env[k];
  return env;
}

const venvPy = (s) => join(repoDir(s), ".venv", WIN ? "Scripts" : "bin", WIN ? "python.exe" : "python");
const bevel = (s, cmd) => cmd.replaceAll("{venvpy}", `"${venvPy(s)}"`);

function git(dir, args, timeout = 120_000) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function stappen(s, lijst) {
  const env = omgeving(s);
  for (const cmd of lijst) {
    log(`  ${s.name}: ${cmd.slice(0, 120)}`);
    const r = spawnSync(bevel(s, cmd), { cwd: repoDir(s), env, shell: true, stdio: "inherit", timeout: 1_200_000, windowsHide: true });
    if (r.status !== 0) { log(`  ${s.name}: mislukt (exitcode ${r.status})`); return false; }
  }
  return true;
}

function nssm(...args) {
  if (!WIN) return true;
  const r = spawnSync("nssm", args, { encoding: "utf8", windowsHide: true });
  return r.status === 0;
}

/** Bestanden die de draaiende server niet raken: ophalen zonder herstart. */
export const zonderHerstart = (f) => /\.(md|txt)$/i.test(f) || /^(docs|tests|\.github)\//.test(f) || /^test[-.]/.test(f) || /^LICENSE|^NOTICE/.test(f);

/** Clonen als de map er nog niet is, dan installeren en bouwen. */
export function setup(s) {
  const dir = repoDir(s);
  mkdirSync(join(ROOT, "repos"), { recursive: true });
  if (!s.repo) return existsSync(dir) ? stappen(s, [...s.install, ...s.build]) : (log(`${s.name}: ${dir} ontbreekt`), false);
  if (!existsSync(join(dir, ".git"))) {
    log(`${s.name}: clonen ${s.repo} (${s.branch})`);
    if (git(join(ROOT, "repos"), ["clone", "--branch", s.branch, s.repo, s.name], 600_000) === null) return log(`${s.name}: clonen mislukt`), false;
  }
  return stappen(s, [...s.install, ...s.build]);
}

/**
 * Nieuwe commits van GitHub verwerken. Alleen package-bestanden gewijzigd of node_modules weg: dienst eerst
 * stoppen (Windows houdt native bestanden vast). Lukt installeren of bouwen niet: terug naar de vorige versie.
 */
export function bijwerken(s) {
  const dir = repoDir(s);
  if (!s.repo) return true;
  if (!existsSync(join(dir, ".git"))) return setup(s) && nssm("restart", dienst(s));
  if (git(dir, ["fetch", "--quiet", "origin", s.branch]) === null) return log(`${s.name}: GitHub niet bereikbaar`), true;
  const van = git(dir, ["rev-parse", "HEAD"]), naar = git(dir, ["rev-parse", "FETCH_HEAD"]);
  if (!van || !naar || van === naar) return true;
  // Eigen commits op deze pc (bijv. e-Boekhouden, waarvan GitHub de repo van CodeMill is): niet wissen. Zit de
  // upstream er al in, dan is er niets te doen; anders samenvoegen, en bij een conflict deze repo overslaan.
  if (git(dir, ["merge-base", "--is-ancestor", naar, van]) !== null) return true;
  const eigen = Number(git(dir, ["rev-list", "--count", `${naar}..${van}`]) ?? 0);
  const gewijzigd = (git(dir, ["diff", "--name-only", van, naar]) ?? "").split("\n").filter(Boolean);
  if (eigen > 0) {
    if (git(dir, ["-c", "user.name=woonkamer-update", "-c", "user.email=woonkamer@localhost", "merge", "--no-edit", "--quiet", naar]) === null) {
      git(dir, ["merge", "--abort"]);
      return log(`${s.name}: ${eigen} eigen commit(s) en nieuwe upstream-commits botsen; niet bijgewerkt (handmatig samenvoegen)`), false;
    }
    log(`${s.name}: upstream ${naar.slice(0, 7)} samengevoegd met ${eigen} eigen commit(s) (${gewijzigd.length} bestanden)`);
    // Back-up van de eigen versie (remote "prive", bijv. paulpavlnl/e-boekhouden-mcp) bijhouden, als die er is.
    if (git(dir, ["remote", "get-url", "prive"]) !== null && git(dir, ["push", "--quiet", "prive", `HEAD:${s.branch}`]) === null) log(`${s.name}: push naar prive mislukt`);
  } else {
    if (git(dir, ["reset", "--hard", "--quiet", naar]) === null) return log(`${s.name}: bijwerken mislukt`), false;
    log(`${s.name}: ${van.slice(0, 7)} -> ${naar.slice(0, 7)} (${gewijzigd.length} bestanden)`);
  }
  // De woonkamer-scripts zelf zitten in NL-GOV-MCP: de proxy leest services.json alleen bij het starten.
  if (gewijzigd.some((f) => f.startsWith("woonkamer/"))) nssm("restart", "mcp-proxy");
  if (gewijzigd.every(zonderHerstart)) return true;
  const pakket = gewijzigd.some((f) => /^(package(-lock)?\.json|requirements\.txt)$/.test(f));
  if (pakket) nssm("stop", dienst(s));
  if (stappen(s, [...(pakket ? s.install : []), ...s.build])) return nssm("restart", dienst(s)), log(`${s.name}: bijgewerkt en herstart`), true;
  log(`${s.name}: terug naar ${van.slice(0, 7)}`);
  git(dir, ["reset", "--hard", "--quiet", van]);
  if (pakket) nssm("stop", dienst(s));
  stappen(s, [...(pakket ? s.install : []), ...s.build]);
  nssm("restart", dienst(s));
  return false;
}

/** Eén server starten met zijn geheimen; NSSM herstart hem als hij stopt. */
function run(s) {
  const [cmd, ...args] = s.start.map((a) => (a === "{venvpy}" ? venvPy(s) : a));
  const p = spawn(cmd, args, { cwd: repoDir(s), env: omgeving(s), stdio: "inherit", windowsHide: true });
  // Bij stoppen de hele boom van de server beëindigen, ook kleinkinderen: een overgebleven proces houdt de
  // uitvoer van NSSM open, en dan blijft de dienst in StopPending hangen (29-10-2026, drie keer).
  const stop = () => {
    if (process.platform === "win32" && p.pid) spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
    else p.kill();
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, stop);
  p.on("exit", (code) => process.exit(code ?? 1));
}

/** De publieke URL van een server, met de sleutel die de connector nodig heeft. */
export function publiekeUrl(s, host = config().host) {
  const geheimen = leesJson(secretFile(s), {});
  const basis = s.funnel ? `https://${host}:${s.funnel}` : `https://${host}${s.route}`;
  return basis + vul(s.mcpPad, geheimen);
}

async function antwoordt(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return r.status < 500 ? `ok (${r.status})` : `fout (${r.status})`;
  } catch (e) { return `geen antwoord (${e.cause?.code || e.name})`; }
}

async function status() {
  const host = config().host;
  const regels = [];
  for (const s of services) {
    const lokaal = await antwoordt(`http://127.0.0.1:${s.port}${s.health}`);
    const publiek = host ? await antwoordt(`${s.funnel ? `https://${host}:${s.funnel}` : `https://${host}${s.route}`}${s.health}`) : "geen host";
    regels.push(`${s.titel}\n  lokaal: ${lokaal}   publiek: ${publiek}\n  connector-URL: ${publiekeUrl(s, host)}`);
  }
  const tekst = regels.join("\n\n");
  console.log(tekst);
  writeFileSync(join(ROOT, "secrets", "urls.txt"), `${tekst}\n`);
}

/** Geheimen uit Render: per service de env-vars via de Render-API, alleen als secrets/<naam>.json nog ontbreekt. */
async function renderEnv() {
  const sleutelbestand = join(ROOT, "secrets", "render-api-key.txt");
  const sleutel = process.env.RENDER_API_KEY || (existsSync(sleutelbestand) ? readFileSync(sleutelbestand, "utf8").trim() : "");
  if (!sleutel) throw new Error(`Geen Render-API-sleutel (RENDER_API_KEY of ${sleutelbestand}).`);
  for (const s of services) {
    if (!s.renderId || existsSync(secretFile(s))) { log(`${s.name}: geheimen al aanwezig of niet op Render`); continue; }
    const r = await fetch(`https://api.render.com/v1/services/${s.renderId}/env-vars?limit=100`, { headers: { Authorization: `Bearer ${sleutel}`, Accept: "application/json" } });
    if (!r.ok) { log(`${s.name}: Render gaf ${r.status}`); continue; }
    const env = Object.fromEntries((await r.json()).map((x) => [x.envVar.key, x.envVar.value]));
    writeFileSync(secretFile(s), JSON.stringify(env, null, 2));
    log(`${s.name}: ${Object.keys(env).length} geheimen opgeslagen`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [opdracht, ...namen] = process.argv.slice(2);
  const kies = namen.length ? services.filter((s) => namen.includes(s.name)) : services;
  mkdirSync(join(ROOT, "secrets"), { recursive: true });
  if (opdracht === "run") run(kies[0] ?? (console.error("Onbekende server."), process.exit(2)));
  else if (opdracht === "setup") process.exitCode = kies.map(setup).every(Boolean) ? 0 : 1;
  else if (opdracht === "update") process.exitCode = kies.map(bijwerken).every(Boolean) ? 0 : 1;
  else if (opdracht === "status") await status();
  else if (opdracht === "render-env") await renderEnv();
  else console.log("Gebruik: node woonkamer.mjs run|setup|update|status|render-env [naam...]");
}
