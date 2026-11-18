import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { htmlResponse, jsonResponse } from "./helpers/config.js";

/**
 * A refused or failed upstream request is reported as an error: the Rechtspraak
 * search no longer answers "0 results, service not reachable", and the SPARQL
 * tools no longer invent a "fallback row".
 */

interface Payload {
  error?: string;
  message?: string;
  suggestion?: string;
  summary?: string;
  details?: { status?: number; endpoint?: string };
  records?: Array<Record<string, unknown>>;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Payload> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0].text) as Payload;
  } finally {
    await client.close();
    await server.close();
  }
}

function urlOf(input: unknown): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
}

const SPARQL_ROW = {
  head: { vars: ["s"] },
  results: { bindings: [{ s: { type: "uri", value: "http://example.org/voorbeeld" } }] },
};

const BAG_ENDPOINT = "https://api.labs.kadaster.nl/datasets/bag/lv/services/baglv/sparql";
const RCE_ENDPOINT = "https://api.linkeddata.cultureelerfgoed.nl/datasets/rce/cho/services/cho/sparql";

beforeEach(() => {
  vi.restoreAllMocks();
  clearHttpCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rechtspraak_search_ecli reports a refused search as an error", () => {
  it("a 403 from the search API is http_error with the website search as fallback, not zero results", async () => {
    const fetchMock = vi.fn(async () => htmlResponse("<html><title>Request Rejected</title></html>", 403));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("rechtspraak_search_ecli", { query: "voorbeeldterm", rows: 3 });
    expect(payload.error).toBe("http_error");
    expect(payload.message).toContain("HTTP 403");
    expect(payload.details?.status).toBe(403);
    expect(payload.suggestion).toContain("https://uitspraken.rechtspraak.nl/resultaat?zoekterm=voorbeeldterm");
    expect(payload.records).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("control: a search with results returns records and no error", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        Results: [
          {
            TitelEmphasis: "ECLI:NL:XX:2026:1234",
            Titel: "Voorbeeldgerecht, 01-01-2026, 123/456",
            Tekstfragment: "Voorbeeldsamenvatting.",
            InterneUrl: "https://uitspraken.rechtspraak.nl/details?id=ECLI:NL:XX:2026:1234",
            PublicatiedatumDate: "2026-01-02",
          },
        ],
        ResultCount: 1,
        FacetCounts: {},
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("rechtspraak_search_ecli", { query: "voorbeeldterm", rows: 3 });
    expect(payload.error).toBeUndefined();
    expect(payload.records).toHaveLength(1);
    expect(String(payload.records?.[0].title)).toContain("ECLI:NL:XX:2026:1234");
  });

  it("control: a search that matches nothing is a success with zero records", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ Results: [], ResultCount: 0, FacetCounts: {} })));

    const payload = await callTool("rechtspraak_search_ecli", { query: "voorbeeldterm", rows: 3 });
    expect(payload.error).toBeUndefined();
    expect(payload.records).toHaveLength(0);
  });
});

describe("bag_linked_data_select uses Kadaster's renamed SPARQL service", () => {
  it("queries the baglv service, not the removed default service", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SPARQL_ROW));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("bag_linked_data_select", { query: "SELECT ?s WHERE { ?s ?p ?o }", limit: 3 });
    expect(payload.error).toBeUndefined();
    const url = urlOf((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url.startsWith(`${BAG_ENDPOINT}?`)).toBe(true);
    expect(url).not.toContain("/services/default/");
  });

  it("control: rce_linked_data_select keeps its own endpoint", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SPARQL_ROW));
    vi.stubGlobal("fetch", fetchMock);

    await callTool("rce_linked_data_select", { query: "SELECT ?s WHERE { ?s ?p ?o }", limit: 3 });
    expect(urlOf((fetchMock.mock.calls[0] as unknown[])[0]).startsWith(`${RCE_ENDPOINT}?`)).toBe(true);
  });
});

describe("SPARQL tools report an endpoint failure as an error, never an invented row", () => {
  it.each(["bag_linked_data_select", "rce_linked_data_select"])(
    "%s: a 404 'Service not found' is http_error with no records",
    async (tool) => {
      const fetchMock = vi.fn(async () => jsonResponse({ message: "Service not found." }, 404));
      vi.stubGlobal("fetch", fetchMock);

      const payload = await callTool(tool, { query: "SELECT ?s WHERE { ?s ?p ?o }", limit: 3 });
      expect(payload.error).toBe("http_error");
      expect(payload.details?.status).toBe(404);
      expect(payload.records).toBeUndefined();
      expect(JSON.stringify(payload)).not.toMatch(/fallback/i);
      expect(fetchMock).toHaveBeenCalled();
    },
  );

  it.each(["bag_linked_data_select", "rce_linked_data_select"])(
    "control: %s returns the endpoint's rows on success",
    async (tool) => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(SPARQL_ROW)));

      const payload = await callTool(tool, { query: "SELECT ?s WHERE { ?s ?p ?o }", limit: 3 });
      expect(payload.error).toBeUndefined();
      expect(payload.records).toHaveLength(1);
      expect(payload.records?.[0].data).toMatchObject({ s: "http://example.org/voorbeeld" });
    },
  );
});
