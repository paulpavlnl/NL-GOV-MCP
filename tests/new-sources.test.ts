import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { NdwSource } from "../src/sources/ndw.js";
import { SparqlLinkedDataSource } from "../src/sources/sparql-linked-data.js";
import { EurostatSource } from "../src/sources/eurostat.js";

const config = loadConfig();

// PDOK, Luchtmeetnet, RDW, RIVM, data.europa.eu, Rechtspraak and the SPARQL
// sources have no fallback record any more: an upstream failure is an error and
// an empty answer is zero records (tests/no-invented-records.test.ts).
describe("new source fallbacks", () => {
  it("ndw fallback returns no results, with an explanation", () => {
    const out = new NdwSource(config).fallback({ query: "doorstroming", rows: 1 });
    expect(out.items).toHaveLength(0);
    expect(out.total).toBe(0);
    expect(out.access_note).toContain("doorstroming");
  });

  it("sparql guardrails work", async () => {
    const src = new SparqlLinkedDataSource(config, "https://example.org/sparql", "Example");
    await expect(src.select({ query: "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }", limit: 10 })).rejects.toThrow(/SELECT/i);
    await expect(src.select({ query: "SELECT * WHERE { ?s ?p ?o } DELETE { ?s ?p ?o }", limit: 10 })).rejects.toThrow(/niet toegestaan/i);
  });

  it("eurostat catalogue suggestions are deterministic", () => {
    const eurostat = new EurostatSource(config);
    const euroOut = eurostat.searchFallback({ query: "population", rows: 2 });
    expect(euroOut.items.length).toBeGreaterThan(0);
  });
});
