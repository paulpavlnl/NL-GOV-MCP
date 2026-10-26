import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findServerRoot } from "../src/load-env.js";

describe("load-env", () => {
  it("finds the folder with package.json above the module", () => {
    const root = mkdtempSync(join(tmpdir(), "nlgov-root-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, "dist", "src"), { recursive: true });
    expect(findServerRoot(join(root, "dist", "src"))).toBe(root);
  });

  it("lets .env next to the server override the environment the client passes, whatever the working directory", () => {
    // Inside the repository's node_modules, so dotenv and tsx resolve from the module's folder.
    mkdirSync(join(process.cwd(), "node_modules", ".cache"), { recursive: true });
    const root = mkdtempSync(join(process.cwd(), "node_modules", ".cache", "nlgov-env-"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, ".env"), "BAG_API_KEY=uit-env-bestand\n");
    mkdirSync(join(root, "src"));
    copyFileSync(join(process.cwd(), "src", "load-env.ts"), join(root, "src", "load-env.ts"));
    const elsewhere = mkdtempSync(join(tmpdir(), "nlgov-cwd-"));
    const out = execFileSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), "--input-type=module", "-e",
      `await import(${JSON.stringify(pathToFileURL(join(root, "src", "load-env.ts")).href)}); process.stdout.write(process.env.BAG_API_KEY ?? "")`,
    ], { cwd: elsewhere, env: { ...process.env, BAG_API_KEY: "oud-uit-config" } }).toString();
    expect(out).toBe("uit-env-bestand");
  });

  it("fills missing keys from bronsleutels.env in the private sibling repo, without overriding", () => {
    mkdirSync(join(process.cwd(), "node_modules", ".cache"), { recursive: true });
    const parent = mkdtempSync(join(process.cwd(), "node_modules", ".cache", "nlgov-sib-"));
    const root = join(parent, "nl-gov-mcp");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, ".env"), "CORE_API_KEY=eigen\n");
    copyFileSync(join(process.cwd(), "src", "load-env.ts"), join(root, "src", "load-env.ts"));
    mkdirSync(join(parent, "verwijzingscontrole-en-uitbreiding"));
    writeFileSync(join(parent, "verwijzingscontrole-en-uitbreiding", "bronsleutels.env"), "OPENALEX_API_KEY=uit-prive-repo\nCORE_API_KEY=uit-prive-repo\n");
    const out = execFileSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), "--input-type=module", "-e",
      `await import(${JSON.stringify(pathToFileURL(join(root, "src", "load-env.ts")).href)}); process.stdout.write([process.env.OPENALEX_API_KEY, process.env.CORE_API_KEY].join(","))`,
    ], { cwd: tmpdir(), env: { ...process.env, OPENALEX_API_KEY: "", CORE_API_KEY: "" } }).toString();
    expect(out).toBe("uit-prive-repo,eigen");
  });
});
