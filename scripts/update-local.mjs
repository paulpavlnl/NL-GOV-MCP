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
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siblings = ["verwijzingscontrole", "verwijzingscontrole-en-uitbreiding"].map((n) => join(here, "..", n));
const repos = [
  { name: "NL-GOV-MCP", root: here, build: true, entry: join(here, "dist", "src", "index.js") },
  ...siblings.filter((d) => existsSync(join(d, ".git"))).slice(0, 1)
    .map((root) => ({ name: "verwijzingscontrole", root, build: false, entry: join(root, "server.js") })),
];

const say = (m) => console.log(m);
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

function update({ name, root, build, entry }) {
  say(`\n== ${name} (${root})`);
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return say("   Overgeslagen: git werkt hier niet."), false;
  if (branch !== "main") {
    if (git(root, ["status", "--porcelain", "--untracked-files=no"]) !== "") return say(`   Overgeslagen: branch ${branch} met eigen wijzigingen.`), false;
    say(`   Op branch ${branch}; overstappen naar main.`);
    if (git(root, ["fetch", "--quiet", "origin", "main"]) === null || git(root, ["checkout", "--quiet", "-B", "main", "origin/main"]) === null) {
      return say("   Overstappen naar main mislukt."), false;
    }
  }
  if (git(root, ["status", "--porcelain", "--untracked-files=no"]) !== "") return say("   Overgeslagen: er zijn lokale wijzigingen in bestanden van de repo."), false;
  if (git(root, ["fetch", "--quiet", "origin", "main"]) === null) return say("   Overgeslagen: GitHub niet bereikbaar."), false;

  const from = git(root, ["rev-parse", "HEAD"]);
  const to = git(root, ["rev-parse", "origin/main"]);
  const changed = from === to ? [] : (git(root, ["diff", "--name-only", from, to]) ?? "").split("\n").filter(Boolean);
  const plan = updatePlan(changed, build);
  if (build && !existsSync(entry)) plan.build = true;
  if (!existsSync(join(root, "node_modules"))) plan.install = true;
  if (from === to && !plan.install && !plan.build) return say(`   Al bij (${from.slice(0, 7)}).`), true;

  if (from !== to) {
    if (git(root, ["merge", "--ff-only", "--quiet", "origin/main"]) === null) return say("   git pull mislukt (lokale commits?)."), false;
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
  const allOk = results.every(Boolean);
  say(allOk ? "\nKlaar. Herstart Claude (helemaal afsluiten en opnieuw openen) om de nieuwe versie te gebruiken." : "\nNiet alles is bijgewerkt; zie hierboven.");
  process.exitCode = allOk ? 0 : 1;
}
