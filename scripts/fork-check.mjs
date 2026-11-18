#!/usr/bin/env node
// FORK (docs/FORK.md): controleert na een merge van upstream dat niets eigens is weggevallen.
// Gebruik: node scripts/fork-check.mjs <basis-ref>   (bijv. origin/main: de stand vóór de merge)
// 1. elke regel met "FORK" in src/ en tests/ op de basis staat nog in hetzelfde bestand
//    (een regel die bewust is aangepast: noem hem in de commit en pas de basis aan);
// 2. elk bestand in src/fork/, tests/fork*, data/ en docs/FORK.md van de basis bestaat nog.
// Exitcode 1 met de lijst als iets ontbreekt.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const base = process.argv[2] ?? "origin/main";
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const norm = (l) => l.trim().replace(/\s+/g, " ");
const problems = [];

const files = git("ls-tree", "-r", "--name-only", base).split("\n").filter(Boolean);
for (const f of files) {
  const eigen = f.startsWith("src/fork/") || f.startsWith("tests/fork") || f.startsWith("data/") || f === "docs/FORK.md";
  if (eigen && !existsSync(f)) problems.push(`bestand weg: ${f}`);
}
const forkFiles = git("grep", "-l", "FORK", base, "--", "src", "tests").split("\n").filter(Boolean).map((l) => l.slice(base.length + 1));
for (const f of forkFiles) {
  const before = git("show", `${base}:${f}`).split(/\r?\n/).filter((l) => l.includes("FORK")).map(norm);
  if (!existsSync(f)) { problems.push(`bestand met FORK-regels weg: ${f}`); continue; }
  const now = readFileSync(f, "utf8").split(/\r?\n/).map(norm);
  const pool = new Map();
  for (const l of now) pool.set(l, (pool.get(l) ?? 0) + 1);
  for (const l of before) {
    const n = pool.get(l) ?? 0;
    if (n > 0) pool.set(l, n - 1);
    else problems.push(`FORK-regel weg in ${f}: ${l.slice(0, 160)}`);
  }
}
if (problems.length) {
  console.log(`Fork-controle tegen ${base}: ${problems.length} probleem/problemen`);
  for (const p of problems) console.log(`- ${p}`);
  process.exit(1);
}
console.log(`Fork-controle tegen ${base}: alle FORK-regels en eigen bestanden aanwezig.`);
