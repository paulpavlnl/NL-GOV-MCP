/**
 * Loads `.env` from the server's own folder (the one with package.json), not
 * from the working directory: the Claude desktop app starts the server from
 * its own folder, so `dotenv/config` never saw a `.env` there.
 *
 * Values in that `.env` override the environment the client passes in. The
 * desktop app rewrites claude_desktop_config.json while it runs, so a key
 * changed there can silently come back; a `.env` next to the server is the
 * place a local install keeps its keys. Imported first by index.ts, before
 * any module reads process.env.
 *
 * FORK: the source keys of this fork (OpenAlex, CORE, OpenAIRE …) live in
 * `bronsleutels.env` in the private repo verwijzingscontrole next to this one,
 * which update-local pulls on every computer: this repo is public, so keys
 * never come with it. Those only fill in what is not set yet (no override).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export function findServerRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The keys file in the private sibling repo, when it is there. */
export function bronsleutelBestanden(root: string): string[] {
  return ["verwijzingscontrole", "verwijzingscontrole-en-uitbreiding"].map((n) => join(root, "..", n, "bronsleutels.env")).filter((f) => existsSync(f));
}

const root = findServerRoot(dirname(fileURLToPath(import.meta.url)));
const envFile = root ? join(root, ".env") : undefined;
if (envFile && existsSync(envFile)) {
  dotenv.config({ path: envFile, override: true, quiet: true });
} else {
  // Without a .env next to the server: the old behaviour (working directory, no override).
  dotenv.config({ quiet: true });
}
// Only where nothing is set yet (an empty value counts as not set).
if (root) for (const f of bronsleutelBestanden(root)) {
  for (const [k, v] of Object.entries(dotenv.parse(readFileSync(f)))) if (!process.env[k]?.trim() && v.trim()) process.env[k] = v.trim();
}
