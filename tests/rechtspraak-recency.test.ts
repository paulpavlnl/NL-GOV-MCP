import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { RechtspraakSource } from "../src/sources/rechtspraak.js";

const config = loadConfig();

function getMockRequestBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls[0] as unknown as Array<unknown> | undefined;
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

function mockFetch(facetCounts: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async () => {
    return new Response(
      JSON.stringify({
        Results: [],
        ResultCount: 0,
        FacetCounts: facetCounts,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Rechtspraak structured parameters", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sort=date_newest maps to PublicatieDatumDesc", async () => {
    const fetchMock = mockFetch();
    const src = new RechtspraakSource(config);
    const out = await src.searchEcli({
      query: "waterschade",
      rows: 5,
      sort: "date_newest",
    });

    const body = getMockRequestBody(fetchMock);
    expect(body.SortOrder).toBe("PublicatieDatumDesc");
    expect(body.SearchTerms[0].Term).toBe("waterschade");
    expect(out.params.sortOrder).toBe("PublicatieDatumDesc");
  });

  it("sort=ruling_newest maps to UitspraakDatumDesc", async () => {
    const fetchMock = mockFetch();
    const src = new RechtspraakSource(config);
    const out = await src.searchEcli({
      query: "huurrecht",
      rows: 5,
      sort: "ruling_newest",
    });

    const body = getMockRequestBody(fetchMock);
    expect(body.SortOrder).toBe("UitspraakDatumDesc");
  });

  it("default sort is Relevance", async () => {
    const fetchMock = mockFetch();
    const src = new RechtspraakSource(config);
    await src.searchEcli({ query: "waterschade", rows: 5 });

    const body = getMockRequestBody(fetchMock);
    expect(body.SortOrder).toBe("Relevance");
  });

  it("date_filter=year sets DitJaar facet", async () => {
    const fetchMock = mockFetch({
      DatumPublicatie: [{ Identifier: "DitJaar", Count: 25 }],
    });
    const src = new RechtspraakSource(config);
    const out = await src.searchEcli({
      query: "waterschade",
      rows: 5,
      sort: "date_newest",
      date_filter: "year",
    });

    const body = getMockRequestBody(fetchMock);
    expect(body.SortOrder).toBe("PublicatieDatumDesc");
    expect(body.DatumPublicatie[0].Identifier).toBe("DitJaar");
    expect(out.params.publicatieFilter).toBe("DitJaar");
    expect(out.params.term).toBe("waterschade");
  });

  it("the search request goes out with the server's own User-Agent", async () => {
    // The search sends the default User-Agent and no Referer or token header.
    const fetchMock = mockFetch();
    const src = new RechtspraakSource(config);
    await src.searchEcli({ query: "voorbeeldterm", rows: 3 });

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toBe("https://uitspraken.rechtspraak.nl/api/zoek");
    const headers = new Headers(call[1].headers);
    expect(headers.get("user-agent")).not.toMatch(/Mozilla|Chrome|Safari|Gecko/i);
    expect(headers.get("user-agent")).toMatch(/^nl-gov-mcp\//);
    expect(headers.has("referer")).toBe(false);
    expect(headers.has("__requestverificationtoken")).toBe(false);
    // Control: the headers the API needs are still sent.
    expect(headers.get("accept")).toContain("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(call[1].method).toBe("POST");
  });

  it("date_filter=month sets BinnenEenMaand facet", async () => {
    const fetchMock = mockFetch();
    const src = new RechtspraakSource(config);
    const out = await src.searchEcli({
      query: "huurrecht",
      rows: 5,
      date_filter: "month",
    });

    const body = getMockRequestBody(fetchMock);
    expect(body.DatumPublicatie[0].Identifier).toBe("BinnenEenMaand");
    expect(out.params.publicatieFilter).toBe("BinnenEenMaand");
  });
});
