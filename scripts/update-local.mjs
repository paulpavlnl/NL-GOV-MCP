#!/usr/bin/env node
/**
 * Updates the local MCP servers on this machine in one go: NL-GOV-MCP (this
 * repo) and, when it sits next to it, verwijzingscontrole. Per repo it pulls
 * main from GitHub (fast-forward only), runs `npm install` when package.json
 * changed and rebuilds when code changed. When npm fails it puts the previous
 * version back, so a server that worked keeps working.
 *
 * Run it by hand (`npm run update-local`, or double-click update-lokaal.cmd
 * on Windows), then restart Claude. Close Claude first when dependencies
 * changed: a running server keeps sharp's native file locked on Windows.
 *
 * Plain JavaScript with no dependencies, so it also works when node_modules
 * or dist is broken.
 *
 * FORK: also used by scripts/nachtelijke-update.mjs (the nightly run: close Claude, update, smoke test the
 * servers, start Claude again, report a failure in the Workflowy Inbox). Run by hand, this script also
 * registers that nightly task on Windows when it is not there yet.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siblings = ["verwijzingscontrole", "verwijzingscontrole-en-uitbreiding"].map((n) => join(here, "..", n));
export const repos = [
  { name: "NL-GOV-MCP", root: here, build: true, entry: join(here, "dist", "src", "index.js") },
  ...siblings.filter((d) => existsSync(join(d, ".git"))).slice(0, 1)
    .map((root) => ({ name: "verwijzingscontrole", root, build: false, entry: join(root, "server.js"), args: ["--stdio"] })),
];

/** Everything said during this run, for the nightly log and the Workflowy report. */
export const logboek = [];
const say = (m) => { console.log(m); logboek.push(m); };
function git(root, args, timeout = 60_000) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}
function npm(root, args) {
  const r = spawnSync("npm", args, { cwd: root, encoding: "utf8", timeout: 600_000, shell: process.platform === "win32", windowsHide: true });
  if (r.status !== 0) {
    const err = `${r.stderr || ""}${r.error?.message || ""}`;
    say(`   npm ${args.join(" ")} mislukt:\n${err.trim().split("\n").slice(-8).map((l) => `     ${l}`).join("\n")}`);
    if (/EPERM|EBUSY|sharp/i.test(err)) say("   Waarschijnlijk houdt een draaiende server een bestand vast: sluit Claude helemaal af en start dit opnieuw.");
  }
  return r.status === 0;
}

export function updatePlan(changed, build) {
  const install = changed.some((f) => f === "package.json" || f === "package-lock.json");
  const rebuild = build && (install || changed.some((f) => f.startsWith("src/") || /^tsconfig.*\.json$/.test(f)));
  return { install, build: rebuild };
}

/** Changed files that only matter on GitHub or in tests: pulling them needs no restart of the servers. */
export const zonderHerstart = (f) => /\.(md|txt)$/i.test(f) || /^(docs|tests|\.github)\//.test(f) || /^test[-.]/.test(f) || /^LICENSE|^NOTICE/.test(f);

/**
 * What the nightly run has to do for this repo: { bijwerken, herstart, fout? }. bijwerken: there are new
 * commits (or node_modules/the build is missing); herstart: some of them change code the running servers use,
 * so Claude must be closed first. GitHub unreachable: nothing to do (fout says why), never a needless restart.
 */
export function heeftUpdate({ root, build, entry }) {
  if (git(root, ["fetch", "--quiet", "origin", "main"]) === null) return { bijwerken: false, herstart: false, fout: "GitHub niet bereikbaar" };
  if (!existsSync(join(root, "node_modules")) || (build && !existsSync(entry))) return { bijwerken: true, herstart: true };
  const from = git(root, ["rev-parse", "HEAD"]), to = git(root, ["rev-parse", "origin/main"]);
  if (from === to) return { bijwerken: false, herstart: false };
  const changed = (git(root, ["diff", "--name-only", from, to]) ?? "").split("\n").filter(Boolean);
  return { bijwerken: true, herstart: !changed.length || changed.some((f) => !zonderHerstart(f)) };
}

/**
 * Smoke test: start the server over stdio, send initialize and tools/list, and check that it answers with
 * tools within the time-out (no Claude needed). Resolves { ok, tools?, fout? }.
 */
export function rookTest({ name, entry, args = [] }, timeoutMs = 30_000) {
  return new Promise((ok) => {
    if (!existsSync(entry)) return ok({ ok: false, fout: `${entry} ontbreekt` });
    const p = spawn(process.execPath, [entry, ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, FOUTLOG_UIT: "1" } });
    let buf = "", err = "", klaar = false;
    const einde = (r) => { if (klaar) return; klaar = true; clearTimeout(t); try { p.kill(); } catch { /* weg */ } ok(r); };
    const t = setTimeout(() => einde({ ok: false, fout: `${name} antwoordde niet binnen ${timeoutMs / 1000} s${err ? `: ${err.trim().split("\n").slice(-3).join(" ")}` : ""}` }), timeoutMs);
    p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (c) => einde({ ok: false, fout: `${name} stopte direct (exitcode ${c})${err ? `: ${err.trim().split("\n").slice(-5).join(" ")}` : ""}` }));
    p.stdout.on("data", (d) => {
      buf += d;
      for (const l of buf.split("\n")) {
        let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.id === 1 && m.result) p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
        if (m.id === 2) einde(m.result?.tools?.length ? { ok: true, tools: m.result.tools.length } : { ok: false, fout: `${name} gaf geen tools` });
      }
    });
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rooktest", version: "1" } } })}\n`);
  });
}

/** Windows: register the nightly task (03:30, also later when the computer was off), unless it exists. */
export function zorgVoorNachtelijkeTaak() {
  if (process.platform !== "win32") return;
  const naam = "MCP nachtelijke update";
  if (spawnSync("schtasks", ["/Query", "/TN", naam], { windowsHide: true }).status === 0) return;
  const script = join(here, "scripts", "nachtelijke-update.mjs");
  const ps = [
    `$a = New-ScheduledTaskAction -Execute '${process.execPath}' -Argument '"${script}"'`,
    "$t = New-ScheduledTaskTrigger -Daily -At 3:30am",
    "$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours 1)",
    `Register-ScheduledTask -TaskName '${naam}' -Action $a -Trigger $t -Settings $s -Description 'Werkt NL-GOV-MCP en de verwijzingscontroleur bij en herstart Claude; meldt een fout in Workflowy.' -Force | Out-Null`,
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true });
  say(r.status === 0 ? `\nNachtelijke taak '${naam}' ingesteld (elke nacht om 03:30).` : `\nNachtelijke taak instellen mislukt: ${(r.stderr || "").trim().slice(0, 300)}`);
}

export function update({ name, root, build, entry }) {
  say(`\n== ${name} (${root})`);
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return say("   Overgeslagen: git werkt hier niet."), false;
  // The version installed now, also when the switch to main below already moves HEAD.
  const from = git(root, ["rev-parse", "HEAD"]);
  if (branch !== "main") {
    if (git(root, ["status", "--porcelain", "--untracked-files=no"]) !== "") return say(`   Overgeslagen: branch ${branch} met eigen wijzigingen.`), false;
    say(`   Op branch ${branch}; overstappen naar main.`);
    if (git(root, ["fetch", "--quiet", "origin", "main"]) === null || git(root, ["checkout", "--quiet", "-B", "main", "origin/main"]) === null) {
      return say("   Overstappen naar main mislukt."), false;
    }
  }
  if (git(root, ["status", "--porcelain", "--untracked-files=no"]) !== "") return say("   Overgeslagen: er zijn lokale wijzigingen in bestanden van de repo."), false;
  if (git(root, ["fetch", "--quiet", "origin", "main"]) === null) return say("   Overgeslagen: GitHub niet bereikbaar."), false;

  const to = git(root, ["rev-parse", "origin/main"]);
  const changed = from === to ? [] : (git(root, ["diff", "--name-only", from, to]) ?? "").split("\n").filter(Boolean);
  const plan = updatePlan(changed, build);
  if (build && !existsSync(entry)) plan.build = true;
  if (!existsSync(join(root, "node_modules"))) plan.install = true;
  if (from === to && !plan.install && !plan.build) return say(`   Al bij (${from.slice(0, 7)}).`), true;

  if (from !== to) {
    if (git(root, ["rev-parse", "HEAD"]) !== to && git(root, ["merge", "--ff-only", "--quiet", "origin/main"]) === null) {
      return say("   git pull mislukt (lokale commits?)."), false;
    }
    say(`   ${from.slice(0, 7)} -> ${to.slice(0, 7)}, ${changed.length} bestand(en) gewijzigd.`);
  }
  const ok = (!plan.install || (say("   npm install..."), npm(root, ["install", "--no-audit", "--no-fund"])))
    && (!plan.build || (say("   bouwen..."), npm(root, ["run", "build"])));
  if (!ok && from !== to) {
    say(`   Terug naar de vorige versie ${from.slice(0, 7)}.`);
    git(root, ["reset", "--hard", "--quiet", from]);
    if (plan.install) npm(root, ["install", "--no-audit", "--no-fund"]);
    if (plan.build) npm(root, ["run", "build"]);
    return false;
  }
  if (ok) say("   Bijgewerkt.");
  return ok;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = repos.map(update);
  zorgVoorNachtelijkeTaak();
  const allOk = results.every(Boolean);
  say(allOk ? "\nKlaar. Herstart Claude (helemaal afsluiten en opnieuw openen) om de nieuwe versie te gebruiken." : "\nNiet alles is bijgewerkt; zie hierboven.");
  process.exitCode = allOk ? 0 : 1;
}
