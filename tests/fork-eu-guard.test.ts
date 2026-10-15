/**
 * FORK GUARD (docs/FORK.md) — fails when a merge from WAINUTAI/NL-GOV-MCP drops
 * the hooks of the fork's EU module. If this fails on the upstream-sync pull
 * request, restore the lines marked "FORK" in src/tools.ts and
 * src/router/nl-gov-ask.ts before merging.
 */
import { readFileSync, existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { CELTEC_HTML } from "./helpers/eu-fixtures.js";
import { jsonResponse } from "./helpers/config.js";

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const server = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fork-guard", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

beforeEach(() => {
  vi.unstubAllGlobals();
  clearHttpCache();
});

describe("fork EU module survives upstream merges", () => {
  it("keeps its own files", () => {
    for (const f of ["src/fork/eu-tekst.ts", "src/fork/eu-bron.ts", "src/fork/eu-tools.ts", "src/fork/lido-artikel.ts", "src/fork/lido-relaties.ts", "docs/FORK.md"]) expect(existsSync(new URL(f, root)), f).toBe(true);
  });

  it("keeps the hooks in upstream files", () => {
    const tools = read("src/tools.ts");
    expect(tools).toContain('import { registerEuForkTools } from "./fork/eu-tools.js";');
    expect(tools).toMatch(/const euTekstResult = registerEuForkTools\(server, \{ config, TOOL_ANNOTATIONS, lido \}\)/);
    expect(tools).toMatch(/registerNlGovAsk\(server, \{ euTekstResult,/);
    const ask = read("src/router/nl-gov-ask.ts");
    expect(ask).toContain("euTekstResult?: (args: { id: string; max_chars: number }) => Promise<ToolResult>;");
    expect(ask).toContain("const { euTekstResult } = deps;");
    expect(ask).toContain("if (outs.some((o) => \"records\" in o))");
    const lido = read("src/sources/lido.ts");
    expect(lido).toContain("static artikelFallback?: (bwbId: string, artikel: string) => Promise<string | null>;");
    expect(lido).toContain("LidoSource.artikelFallback(value, artikel)");
  });

  it("registers eurlex_tekst_get next to the upstream EU tools", async () => {
    const names = await withClient(async (c) => (await c.listTools()).tools.map((t) => t.name));
    expect(names).toEqual(expect.arrayContaining(["eurlex_tekst_get", "lido_relaties", "woo_zoeken", "woo_document_get", "woo_index", "puc_zoeken", "puc_document_get", "woo_jurisprudentie_zoeken", "anbi_zoeken", "raadvanstate_zoeken", "crm_oordelen_zoeken", "onderwijsgeschillen_zoeken", "geschillencommissie_zoeken", "raad_van_arbitrage_zoeken", "mfn_tuchtrecht_zoeken", "geschil_uitspraak_get", "verdragen_zoeken", "verdrag_get", "hcch_verdrag_get", "ehrm_zoeken", "ehrm_uitspraak_get", "kifid_zoeken", "literatuur_zoeken", "literatuur_document_get", "ap_documenten_zoeken", "ap_document_get", "wetsgeschiedenis_get", "rechtspraak_richtlijnen", "eurlex_document", "eurlex_search", "lido_verwijzingen"]));
  });

  it("nl_gov_ask reads an EU ECLI through CELLAR instead of refusing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href);
      if (url.pathname.endsWith("/sparql")) {
        const q = url.searchParams.get("query") ?? "";
        const lit = (value: string) => ({ type: "literal", value });
        return jsonResponse({ results: { bindings: q.includes("?key") ? [{ key: lit("ecli|ECLI:EU:C:2005:321"), celex: lit("62003CJ0478") }] : [{ ecli: lit("ECLI:EU:C:2005:321"), date: lit("2005-05-26"), parties: lit("Celtec Ltd tegen John Astley en anderen.") }] } });
      }
      if (url.hostname === "linkeddata.overheid.nl") return jsonResponse({});
      return new Response(CELTEC_HTML, { status: 200, headers: { "content-type": "text/html" } });
    }));
    const payload = await withClient(async (c) => {
      const res = (await c.callTool({ name: "nl_gov_ask", arguments: { question: "Wat besliste het Hof in ECLI:EU:C:2005:321?" } })) as { content: Array<{ text: string }> };
      return JSON.parse(res.content[0].text);
    });
    expect(payload.summary).toContain("EUR-Lex/CELLAR");
    expect(payload.records[0].data).toMatchObject({ ecli: "ECLI:EU:C:2005:321", celex: "62003CJ0478", partijen: "Celtec Ltd tegen John Astley en anderen" });
  });
});
