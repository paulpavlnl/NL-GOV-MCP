import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { htmlResponse, jsonResponse, xmlResponse } from "./helpers/config.js";

/**
 * An upstream failure is a typed error, and an empty answer is a success with
 * zero records and an access_note. None of these tools returns an invented
 * record (a placeholder station, vehicle, dataset or address) as a result.
 */

interface Payload {
  error?: string;
  message?: string;
  summary?: string;
  access_note?: string;
  details?: { status?: number; endpoint?: string };
  records?: Array<{ title?: string; data?: Record<string, unknown> }>;
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

/** Answers every request with the result of `route(url)`. */
function stubFetch(route: (url: string) => Response) {
  const fetchMock = vi.fn(async (input: unknown) => route(urlOf(input)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const notFound = () => jsonResponse({ message: "Not found" }, 404);

function expectFailure(payload: Payload, error = "http_error") {
  expect(payload.error).toBe(error);
  expect(payload.records).toBeUndefined();
  expect(JSON.stringify(payload)).not.toMatch(/fallback|1970-01-01/i);
}

function expectEmpty(payload: Payload) {
  expect(payload.error).toBeUndefined();
  expect(payload.records).toHaveLength(0);
  expect(payload.access_note).toBeTruthy();
  expect(JSON.stringify(payload)).not.toMatch(/fallback|1970-01-01/i);
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearHttpCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("luchtmeetnet_latest", () => {
  it("both /measurements and the LKI failing is an error, not a placeholder measurement", async () => {
    const fetchMock = stubFetch(notFound);
    const payload = await callTool("luchtmeetnet_latest", { component: "NO2", rows: 2 });
    expectFailure(payload);
    expect(payload.details?.status).toBe(404);
    // The LKI path was tried before giving up.
    expect(fetchMock.mock.calls.some((c) => urlOf(c[0]).includes("/lki"))).toBe(true);
  });

  it("no measurements anywhere is zero records with a note", async () => {
    stubFetch(() => jsonResponse({ pagination: { last_page: 1 }, data: [] }));
    const payload = await callTool("luchtmeetnet_latest", { component: "NO2", rows: 2 });
    expectEmpty(payload);
    expect(payload.access_note).toContain("gaf geen metingen");
    expect(payload.access_note).not.toContain("onbereikbaar");
  });

  it("control: the LKI path still answers when /measurements fails", async () => {
    stubFetch((url) => {
      if (url.includes("/lki")) {
        return jsonResponse({
          pagination: { last_page: 1 },
          data: [{ station_number: "NL00001", formula: "LKI", value: 3, timestamp_measured: "2026-01-01T10:00:00+00:00" }],
        });
      }
      if (url.includes("/stations")) return jsonResponse({ pagination: { last_page: 1 }, data: [{ number: "NL00001", location: "Voorbeeldstad-Laan" }] });
      return notFound();
    });
    const payload = await callTool("luchtmeetnet_latest", { rows: 2 });
    expect(payload.error).toBeUndefined();
    expect(payload.records).toHaveLength(1);
    expect(payload.records?.[0].data).toMatchObject({ station_name: "Voorbeeldstad-Laan", unit: "LKI (1-11)" });
    expect(payload.access_note).toContain("onbereikbaar");
  });

  it("control: live measurements are returned as records", async () => {
    stubFetch(() =>
      jsonResponse({
        data: [{ station_number: "NL00001", station_name: "Voorbeeldstad-Laan", formula: "NO2", value: 12, unit: "ug/m3", timestamp_measured: "2026-01-01T10:00:00+00:00" }],
      }),
    );
    const payload = await callTool("luchtmeetnet_latest", { component: "NO2", rows: 2 });
    expect(payload.error).toBeUndefined();
    expect(payload.records).toHaveLength(1);
    expect(payload.records?.[0].data).toMatchObject({ value: 12, station_name: "Voorbeeldstad-Laan" });
  });
});

describe("nl_gov_ask luchtmeetnet route", () => {
  function stubStations(measurements: unknown[]) {
    return stubFetch((url) => {
      if (url.includes("luchtmeetnet.nl/open_api/stations")) {
        return jsonResponse({ pagination: { last_page: 1 }, data: [{ number: "NL00001", location: "Utrecht-Voorbeeldlaan" }] });
      }
      if (url.includes("luchtmeetnet.nl/open_api/measurements")) return jsonResponse({ data: measurements });
      if (url.includes("luchtmeetnet.nl/open_api/lki")) return jsonResponse({ pagination: { last_page: 1 }, data: [] });
      return notFound();
    });
  }

  it("stations without measurements are not reported as a place without a station", async () => {
    stubStations([]);
    const payload = await callTool("nl_gov_ask", { question: "Wat is de luchtkwaliteit in Utrecht?" });
    expect(payload.summary ?? "").not.toContain("geen meetstation");
  });

  it("control: a place without a station is still answered as such", async () => {
    stubStations([]);
    const payload = await callTool("nl_gov_ask", { question: "Wat is de luchtkwaliteit in Staphorst?" });
    expect(payload.error).toBeUndefined();
    expect(payload.summary).toContain("geen meetstation voor Staphorst");
  });

  it("control: measurements of the place are returned", async () => {
    stubStations([{ station_number: "NL00001", station_name: "Utrecht-Voorbeeldlaan", formula: "NO2", value: 12, unit: "ug/m3", timestamp_measured: "2026-01-01T10:00:00+00:00" }]);
    const payload = await callTool("nl_gov_ask", { question: "Wat is de luchtkwaliteit in Utrecht?" });
    expect(payload.summary).toContain("Luchtmeetnet Utrecht");
    expect(payload.records).toHaveLength(1);
  });
});

describe("rdw_open_data_search", () => {
  it("every search step failing is an error, not a placeholder vehicle", async () => {
    stubFetch(notFound);
    expectFailure(await callTool("rdw_open_data_search", { query: "voorbeeldmerk", rows: 2 }));
  });

  it("an empty answer is zero records with a note, not a placeholder vehicle", async () => {
    stubFetch(() => jsonResponse([]));
    const payload = await callTool("rdw_open_data_search", { query: "voorbeeldmerk", rows: 2 });
    expectEmpty(payload);
    expect(payload.access_note).toContain("Geen live match");
  });

  it("an empty answer next to a failed step says the result may be incomplete", async () => {
    stubFetch((url) => (new URL(url).searchParams.has("$q") ? jsonResponse([]) : notFound()));
    const payload = await callTool("rdw_open_data_search", { query: "voorbeeldmerk", rows: 2 });
    expectEmpty(payload);
    expect(payload.access_note).toContain("1 van de 2 zoekstappen mislukte");
  });

  it("control: a match is returned as a record", async () => {
    stubFetch(() => jsonResponse([{ kenteken: "XX99XX", merk: "VOORBEELDMERK", handelsbenaming: "MODEL", voertuigsoort: "Personenauto" }]));
    const payload = await callTool("rdw_open_data_search", { query: "voorbeeldmerk", rows: 2 });
    expect(payload.error).toBeUndefined();
    expect(payload.records).toHaveLength(1);
    expect(payload.records?.[0].data).toMatchObject({ kenteken: "XX99XX" });
  });
});

describe("data_europa_datasets_search", () => {
  it("a failed search is an error, not a placeholder dataset", async () => {
    stubFetch(notFound);
    expectFailure(await callTool("data_europa_datasets_search", { query: "voorbeeld", rows: 2 }));
  });

  it("an empty answer is zero records with a note", async () => {
    stubFetch(() => jsonResponse({ result: { count: 0, results: [] } }));
    expectEmpty(await callTool("data_europa_datasets_search", { query: "voorbeeld", rows: 2 }));
  });

  it("control: a dataset is returned as a record", async () => {
    stubFetch(() => jsonResponse({ result: { count: 1, results: [{ id: "voorbeeld-dataset", title: { en: "Example dataset" } }] } }));
    const payload = await callTool("data_europa_datasets_search", { query: "voorbeeld", rows: 2 });
    expect(payload.error).toBeUndefined();
    expect(payload.records).toHaveLength(1);
    expect(payload.records?.[0].data).toMatchObject({ id: "voorbeeld-dataset" });
  });
});

describe("bag_lookup_address", () => {
  it("a failed lookup is an error, not a placeholder address", async () => {
    stubFetch(notFound);
    const payload = await callTool("bag_lookup_address", { query: "Voorbeeldstraat 1 Voorbeeldstad", rows: 2 });
    expectFailure(payload);
    expect(JSON.stringify(payload)).not.toContain("Geen live BAG-hit");
  });

  it("an empty answer is zero records with a note", async () => {
    stubFetch(() => jsonResponse({ response: { numFound: 0, docs: [] } }));
    const payload = await callTool("bag_lookup_address", { query: "Voorbeeldstraat 1", woonplaats: "Voorbeeldstad", rows: 2 });
    expectEmpty(payload);
    expect(payload.access_note).toContain("Voorbeeldstad");
  });

  it("control: an address is returned as a record", async () => {
    stubFetch(() => jsonResponse({ response: { numFound: 1, docs: [{ id: "adr-voorbeeld", weergavenaam: "Voorbeeldstraat 1, 1234AB Voorbeeldstad", type: "adres" }] } }));
    const payload = await callTool("bag_lookup_address", { query: "Voorbeeldstraat 1 Voorbeeldstad", rows: 2 });
    expect(payload.error).toBeUndefined();
    expect(payload.records).toHaveLength(1);
    expect(payload.access_note).toBeUndefined();
  });
});

const CSW_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<csw:GetRecordsResponse xmlns:csw="http://www.opengis.net/cat/csw/2.0.2">
  <csw:SearchStatus timestamp="2026-01-01T00:00:00" />
  <csw:SearchResults numberOfRecordsMatched="0" numberOfRecordsReturned="0" elementSet="summary" nextRecord="0" />
</csw:GetRecordsResponse>`;

const CSW_ONE = `<?xml version="1.0" encoding="UTF-8"?>
<csw:GetRecordsResponse xmlns:csw="http://www.opengis.net/cat/csw/2.0.2">
  <csw:SearchResults numberOfRecordsMatched="1" numberOfRecordsReturned="1" elementSet="summary" nextRecord="0">
    <gmd:MD_Metadata xmlns:gmd="http://www.isotc211.org/2005/gmd" xmlns:gco="http://www.isotc211.org/2005/gco">
      <gmd:fileIdentifier><gco:CharacterString>voorbeeld-1</gco:CharacterString></gmd:fileIdentifier>
      <gmd:identificationInfo><gmd:MD_DataIdentification>
        <gmd:citation><gmd:CI_Citation><gmd:title><gco:CharacterString>Voorbeeldthema</gco:CharacterString></gmd:title></gmd:CI_Citation></gmd:citation>
      </gmd:MD_DataIdentification></gmd:identificationInfo>
    </gmd:MD_Metadata>
  </csw:SearchResults>
</csw:GetRecordsResponse>`;

const DIRECTORY = `<html><body><a href="../">..</a><a href="andere-map/">andere-map/</a><a href="voorbeeldthema/">voorbeeldthema/</a></body></html>`;

describe("rivm_discovery_search", () => {
  it("catalogue and directory both failing is an error, not an empty success", async () => {
    stubFetch(notFound);
    expectFailure(await callTool("rivm_discovery_search", { query: "voorbeeldthema", rows: 2 }));
  });

  it("an HTML page instead of a catalogue answer is malformed_response", async () => {
    stubFetch((url) => (url.includes("/csw") ? htmlResponse("<html><body>Zoeken</body></html>") : notFound()));
    expectFailure(await callTool("rivm_discovery_search", { query: "voorbeeldthema", rows: 2 }), "malformed_response");
  });

  it("a catalogue answer without matches is zero records with a note", async () => {
    stubFetch((url) => (url.includes("/csw") ? xmlResponse(CSW_EMPTY) : htmlResponse(DIRECTORY)));
    const payload = await callTool("rivm_discovery_search", { query: "zeldzaamwoord", rows: 2 });
    expectEmpty(payload);
    expect(payload.access_note).toContain("zeldzaamwoord");
  });

  it("control: a failed catalogue still lets the directory listing answer", async () => {
    stubFetch((url) => (url.includes("/csw") ? notFound() : htmlResponse(DIRECTORY)));
    const payload = await callTool("rivm_discovery_search", { query: "voorbeeldthema", rows: 2 });
    expect(payload.error).toBeUndefined();
    expect(payload.records).toHaveLength(1);
    expect(payload.records?.[0].data).toMatchObject({ source: "rivm-data-browse" });
  });

  it("control: a catalogue record is returned as a record", async () => {
    stubFetch((url) => (url.includes("/csw") ? xmlResponse(CSW_ONE) : notFound()));
    const payload = await callTool("rivm_discovery_search", { query: "voorbeeldthema", rows: 2 });
    expect(payload.error).toBeUndefined();
    expect(payload.records).toHaveLength(1);
    expect(payload.records?.[0].data).toMatchObject({ id: "voorbeeld-1", source: "rivm-csw" });
  });
});
