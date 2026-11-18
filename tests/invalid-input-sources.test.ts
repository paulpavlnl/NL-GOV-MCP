import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { SparqlLinkedDataSource } from "../src/sources/sparql-linked-data.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { InvalidInputError, mapSourceError } from "../src/utils/response.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

/**
 * Input the server refuses before any request is a caller error, not a source
 * failure: the tool result says `invalid_input` with a suggestion naming what is
 * accepted, never `unexpected` with "try again".
 */

interface Payload {
  error?: string;
  message?: string;
  suggestion?: string;
  summary?: string;
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

function expectRefusedInput(payload: Payload) {
  expect(payload.error).toBe("invalid_input");
  expect(payload.suggestion).toBeTruthy();
  expect(payload.suggestion).not.toMatch(/try again|probeer (het )?opnieuw/i);
}

const SPARQL_ROW = {
  head: { vars: ["s"] },
  results: { bindings: [{ s: { type: "uri", value: "http://example.org/a" } }] },
};

beforeEach(() => {
  vi.restoreAllMocks();
  clearHttpCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("mapSourceError and refused input", () => {
  it("maps InvalidInputError to invalid_input with its own suggestion", () => {
    const out = mapSourceError(new InvalidInputError("Waarde 'x' geweigerd", "Geef een waarde als 'y'."), "Voorbeeldbron", "https://bron.example");
    expect(out).toMatchObject({ error: "invalid_input", message: "Waarde 'x' geweigerd", suggestion: "Geef een waarde als 'y'." });
  });

  it("control: a plain Error stays unexpected", () => {
    expect(mapSourceError(new Error("kapot"), "Voorbeeldbron").error).toBe("unexpected");
  });
});

describe("dnb_statistics_search: a refused dataset is invalid_input", () => {
  it.each(["http://127.0.0.1:1/x", "https://elders.example/statisticsdata/v1/slug", "file:///etc/hosts"])(
    "refuses %s with invalid_input and no request",
    async (dataset) => {
      vi.stubEnv("DNB_API_KEY", "voorbeeld-sleutel");
      const fetchMock = vi.fn(async () => jsonResponse({ observations: [] }));
      vi.stubGlobal("fetch", fetchMock);

      const payload = await callTool("dnb_statistics_search", { dataset, rows: 3 });
      expectRefusedInput(payload);
      expect(payload.message).toContain("Ongeldige dataset");
      expect(payload.suggestion).toContain("statisticsdata/");
      expect(payload.suggestion).toContain("https://api.dnb.nl/");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("control: a dataset path is fetched from the DNB gateway and gives records", async () => {
    vi.stubEnv("DNB_API_KEY", "voorbeeld-sleutel");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ observations: [{ period: "2024-01", value: "1.5", unit: "percent", label: "Voorbeeldreeks" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("dnb_statistics_search", { dataset: "statisticsdata/v1/voorbeeld-reeks", rows: 3 });
    expect(payload.error).toBeUndefined();
    expect(payload.records).toHaveLength(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://api.dnb.nl/statisticsdata/v1/voorbeeld-reeks");
  });
});

describe("knmi_latest_files: a refused path segment is invalid_input", () => {
  it.each(["..", "."])("refuses datasetName %j with invalid_input and no request", async (datasetName) => {
    vi.stubEnv("KNMI_API_KEY", "voorbeeld-sleutel");
    const fetchMock = vi.fn(async () => jsonResponse({ files: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("knmi_latest_files", { datasetName, datasetVersion: "1", top: 3 });
    expectRefusedInput(payload);
    expect(payload.message).toContain("Ongeldige datasetName");
    expect(payload.suggestion).toContain("knmi_datasets");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("control: an ordinary dataset name lists files", async () => {
    vi.stubEnv("KNMI_API_KEY", "voorbeeld-sleutel");
    const fetchMock = vi.fn(async () => jsonResponse({ files: [{ filename: "voorbeeld.nc" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("knmi_latest_files", { datasetName: "voorbeeld_dataset", datasetVersion: "1", top: 3 });
    expect(payload.error).toBeUndefined();
    expect(payload.records).toHaveLength(1);
  });
});

describe("SPARQL tools: a refused query is invalid_input, recognised by type", () => {
  const REMOTE = "<http://remote.example/sparql>";

  it.each([
    ["bag_linked_data_select", `SELECT ?s WHERE { SERVICE ${REMOTE} { ?a ?b ?c } }`],
    ["bag_linked_data_select", "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }"],
    ["rce_linked_data_select", `SELECT ?s WHERE { ?s ?p "open }`],
    ["rce_linked_data_select", "SELECT ?s WHERE { ?s ?p ?o . \\u0053ERVICE <http://x.example/> { } }"],
  ])("%s refuses %s with invalid_input and no request", async (tool, query) => {
    const fetchMock = vi.fn(async () => jsonResponse(SPARQL_ROW));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool(tool, { query, limit: 5 });
    expectRefusedInput(payload);
    expect(payload.message).toMatch(/toegestaan/);
    expect(payload.suggestion).toMatch(/SELECT/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the source throws the typed error, whatever the message says", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SPARQL_ROW));
    vi.stubGlobal("fetch", fetchMock);
    const src = new SparqlLinkedDataSource(testConfig, "https://sparql.example/endpoint", "Voorbeeld");

    await expect(src.select({ query: "DESCRIBE <http://example.org/a>", limit: 5 })).rejects.toBeInstanceOf(InvalidInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("control: a plain SELECT on both tools returns rows", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SPARQL_ROW));
    vi.stubGlobal("fetch", fetchMock);

    for (const tool of ["bag_linked_data_select", "rce_linked_data_select"]) {
      const payload = await callTool(tool, { query: "SELECT ?s WHERE { ?s ?p ?o }", limit: 5 });
      expect(payload.error).toBeUndefined();
      expect(payload.records).toHaveLength(1);
      expect(payload.records?.[0].data).toMatchObject({ s: "http://example.org/a" });
    }
  });

  it("an upstream failure whose text mentions SELECT or a keyword is not reported as refused input", async () => {
    // The old check matched /SELECT|toegestaan|keyword/ in any error message, so a
    // network error quoting the query was reported as the caller's mistake.
    const fetchMock = vi.fn(async () => {
      throw new TypeError("socket closed while sending SELECT keyword");
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("bag_linked_data_select", { query: "SELECT ?s WHERE { ?s ?p ?o }", limit: 5 });
    // An upstream failure is reported as an error, not as refused input and not
    // as an invented "fallback row".
    expect(payload.error).toBeDefined();
    expect(payload.error).not.toBe("invalid_input");
    expect(payload.records).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });
});
