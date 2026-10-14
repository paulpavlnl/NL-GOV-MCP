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
 */
import { existsSync } from "node:fs";
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

const root = findServerRoot(dirname(fileURLToPath(import.meta.url)));
const envFile = root ? join(root, ".env") : undefined;
if (envFile && existsSync(envFile)) {
  dotenv.config({ path: envFile, override: true, quiet: true });
} else {
  // Without a .env next to the server: the old behaviour (working directory, no override).
  dotenv.config({ quiet: true });
}
