import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { DnbStatisticsSource } from "../src/sources/dnb-statistics.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import type { AppConfig } from "../src/types.js";

const config: AppConfig = {
  server: { name: "nl-gov-mcp", version: "0.1.0", httpPort: 3333 },
  temporal: { defaultTimeZone: "Europe/Amsterdam" },
  cacheTtlMs: {
    default: 0,
    cbsCatalog: 0,
    tkEntityLists: 0,
    knmiObservations: 0,
    knmiHistorical: 0,
    dataOverheidDatasetList: 0,
    rijksoverheidLists: 0,
  },
  limits: { defaultRows: 25, maxRows: 200 },
  endpoints: {
    dataOverheid: "https://data.overheid.nl/data/api/3/action",
    cbsV4: "https://odata4.cbs.nl/CBS",
    cbsV3: "https://opendata.cbs.nl/ODataApi/OData",
    tweedeKamer: "https://gegevensmagazijn.tweedekamer.nl/OData/v5",
    bekendmakingenSru: "https://repository.overheid.nl/sru",
    rijksoverheid: "https://opendata.rijksoverheid.nl/v1",
    knmi: "https://api.dataplatform.knmi.nl/open-data/v1",
    rijksbegroting: "https://opendata.rijksbegroting.nl",
    duoDatasets: "https://onderwijsdata.duo.nl",
    duoRio: "https://lod.onderwijsregistratie.nl/rio-api",
    apiRegister: "https://apis.developer.overheid.nl",
  },
};

const sampleResponse = {
  observations: [
    { period: "2024-01", value: "3.75", unit: "percent", label: "ECB deposit rate", frequency: "M" },
    { period: "2024-02", value: "3.50", unit: "percent", label: "ECB deposit rate", frequency: "M" },
    { period: "2024-03", value: "3.25", unit: "percent", label: "ECB deposit rate", frequency: "M" },
  ],
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("DnbStatisticsSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes datapoints and forwards the Ocp-Apim-Subscription-Key header", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(sampleResponse));
    vi.stubGlobal("fetch", fetchMock);

    const src = new DnbStatisticsSource(config, "test-key");
    const out = await src.search({ dataset: "interest-rates", rows: 20 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("api.dnb.nl/interest-rates");
    const headers = init.headers as Record<string, string>;
    expect(headers["Ocp-Apim-Subscription-Key"]).toBe("test-key");

    expect(out.items).toHaveLength(3);
    expect(out.items[0].period).toBe("2024-01");
    expect(out.items[0].value).toBe(3.75);
    expect(out.items[0].unit).toBe("percent");
    expect(out.items[0].title).toContain("ECB deposit rate");
    expect(out.endpoint).toContain("interest-rates");
    expect(out.total).toBe(3);
  });

  it("accepts a full endpoint URL for the dataset argument and passes period filters as query params", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(sampleResponse));
    vi.stubGlobal("fetch", fetchMock);

    const src = new DnbStatisticsSource(config, "test-key");
    await src.search({
      dataset: "https://api.dnb.nl/statistics/v1/exchange-rates",
      startPeriod: "2024-01",
      endPeriod: "2024-03",
      rows: 20,
    });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/statistics/v1/exchange-rates");
    expect(url).toContain("startPeriod=2024-01");
    expect(url).toContain("endPeriod=2024-03");
  });

  it("extracts datapoints from an alternate container key and coerces numeric values", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ result: { data: [{ Period: "2023", Value: 1234.5, Unit: "EUR mln" }] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const src = new DnbStatisticsSource(config, "test-key");
    const out = await src.search({ dataset: "balance-of-payments", rows: 20 });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].period).toBe("2023");
    expect(out.items[0].value).toBe(1234.5);
    expect(out.items[0].unit).toBe("EUR mln");
  });

  it("applies the client-side free-text query filter", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(sampleResponse));
    vi.stubGlobal("fetch", fetchMock);

    const src = new DnbStatisticsSource(config, "test-key");
    const out = await src.search({ dataset: "interest-rates", query: "2024-02", rows: 20 });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].period).toBe("2024-02");
  });

  it("returns an empty result set when the response has no recognizable datapoints", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: "no data" }));
    vi.stubGlobal("fetch", fetchMock);

    const src = new DnbStatisticsSource(config, "test-key");
    const out = await src.search({ dataset: "unknown-dataset", rows: 20 });

    expect(out.items).toHaveLength(0);
    expect(out.total).toBe(0);
    expect(out.endpoint).toContain("unknown-dataset");
  });
});

describe("DnbStatisticsSource: the subscription key goes to the DNB gateway only", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it.each([
    "http://127.0.0.1:1/x",
    "HTTP://127.0.0.1:9/grab?probe=1",
    "HTTP://api.dnb.nl/x",
    "http://api.dnb.nl/statisticsdata/v1/slug",
    "https://api.dnb.nl.evil.example/x",
    "https://evil.example/api.dnb.nl/x",
    "https://api.dnb.nl:8443/x",
    "https://user@api.dnb.nl/x",
    "https://user:pw@api.dnb.nl/x",
    "http://api.dnb.nl@127.0.0.1:9/grab",
    "https://api.portal.dnb.nl/statistics/v1/x",
    "file:///etc/hosts",
    "ftp://api.dnb.nl/x",
    "https://",
  ])("refuses dataset %s before any request", async (dataset) => {
    const fetchMock = vi.fn(async () => jsonResponse(sampleResponse));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DnbStatisticsSource(config, "test-key").search({ dataset, rows: 3 })).rejects.toThrow(/Ongeldige dataset/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["statisticsdata/v1/slug", "https://api.dnb.nl/statisticsdata/v1/slug"],
    ["/statisticsdata/v1/slug", "https://api.dnb.nl/statisticsdata/v1/slug"],
    ["  statisticsdata/v1/slug  ", "https://api.dnb.nl/statisticsdata/v1/slug"],
    ["https://api.dnb.nl/statisticsdata/v1/slug", "https://api.dnb.nl/statisticsdata/v1/slug"],
    ["HTTPS://API.DNB.NL/statisticsdata/v1/slug", "https://api.dnb.nl/statisticsdata/v1/slug"],
  ])("control: %s is fetched from %s", async (dataset, expected) => {
    const fetchMock = vi.fn(async () => jsonResponse(sampleResponse));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new DnbStatisticsSource(config, "test-key").search({ dataset, rows: 3 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(expected);
    expect((init.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBe("test-key");
    expect(out.items).toHaveLength(3);
  });

  it("does not follow a redirect to another host with the key", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
      return url.startsWith("https://api.dnb.nl/")
        ? new Response(null, { status: 302, headers: { location: "https://elsewhere.example/land" } })
        : jsonResponse(sampleResponse);
    }));

    await new DnbStatisticsSource(config, "test-key").search({ dataset: "statisticsdata/v1/moved", rows: 3 });
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(["api.dnb.nl", "elsewhere.example"]);
    expect(calls[1].headers["Ocp-Apim-Subscription-Key"]).toBeUndefined();
    expect(JSON.stringify(calls[1].headers)).not.toContain("test-key");
  });

  it("dnb_statistics_search answers a foreign URL with an error naming the dataset rule, without a request", async () => {
    vi.stubEnv("DNB_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => jsonResponse(sampleResponse));
    vi.stubGlobal("fetch", fetchMock);
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dnb-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({ name: "dnb_statistics_search", arguments: { dataset: "http://127.0.0.1:1/x", rows: 3 } })) as {
        content: Array<{ text: string }>;
      };
      const payload = JSON.parse(result.content[0].text) as { error?: string; message?: string };
      expect(payload.error).toBeDefined();
      expect(payload.message).toContain("Ongeldige dataset");
      expect(payload.message).toContain("https://api.dnb.nl");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
      vi.unstubAllEnvs();
    }
  });
});
