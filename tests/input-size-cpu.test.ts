import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { publicationXmlToText } from "../src/sources/bekendmakingen.js";
import { parseTkQuery } from "../src/sources/tweede-kamer.js";
import { type Polygon, parseWkt, pointInPolygon, polygonInteriorPoint, representativePoint } from "../src/utils/geometry.js";
import { htmlToText } from "../src/utils/html-text.js";
import { REWRITE_INPUT_MAX, rewriteQuery } from "../src/utils/query-rewriter.js";

/** Milliseconds a call took. The budgets below are far above the linear run time and far below the quadratic one. */
function elapsed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("query preprocessing stays linear on long punctuation runs", () => {
  it("rewriteQuery handles a run of '?' or '.' before a letter quickly", () => {
    for (const mark of ["?", ".", "!"]) {
      expect(elapsed(() => rewriteQuery(`a${mark.repeat(50_000)}b`, "moderate")), mark).toBeLessThan(500);
      expect(elapsed(() => rewriteQuery(`a${mark.repeat(50_000)}b`, "strict")), mark).toBeLessThan(500);
    }
  });

  it("rewriteQuery cuts its input instead of working on all of it", () => {
    const rw = rewriteQuery("woord ".repeat(1_000), "moderate");
    expect(rw.original.length).toBeLessThanOrEqual(REWRITE_INPUT_MAX);
    expect(rw.rewritten).toMatch(/^woord( woord)*$/);
    // Passthrough is untouched: it does no regex work.
    expect(rewriteQuery("x".repeat(5_000), "passthrough").rewritten).toHaveLength(5_000);
  });

  it("keeps the trailing-noise results, the abbreviation dot included", () => {
    expect(rewriteQuery("regels voor B.V.?", "moderate").rewritten).toBe("regels voor b.v.");
    expect(rewriteQuery("regels voor b.v. ?!", "moderate").rewritten).toBe("regels voor b.v.");
    expect(rewriteQuery("Wat is erfpacht?", "moderate").rewritten).toBe("erfpacht");
    expect(rewriteQuery("stikstof graag", "moderate").rewritten).toBe("stikstof");
    expect(rewriteQuery("stikstof . ?  please", "moderate").rewritten).toBe("stikstof");
    expect(rewriteQuery("wat is 2.0?", "moderate").rewritten).toBe("2.0");
    // No note when only the end punctuation changed.
    expect(rewriteQuery("regels voor B.V.?", "moderate").explanation).toBeUndefined();
  });

  it("parseTkQuery handles a run of punctuation inside a token quickly and cuts long input", () => {
    for (const mark of [".", "?", "-"]) {
      expect(elapsed(() => parseTkQuery(`a${mark.repeat(50_000)}b`)), mark).toBeLessThan(500);
    }
    expect(elapsed(() => parseTkQuery("woord ".repeat(50_000)))).toBeLessThan(500);
    // Cut at a word boundary: the words past the cap are gone, no word is halved.
    const words = Array.from({ length: 1_000 }, (_, i) => `term${i}`);
    const texts = parseTkQuery(`${words.join(" ")} slot`).terms.map((t) => t.text);
    expect(texts).not.toContain("slot");
    expect(texts.length).toBeGreaterThan(100);
    expect(texts.every((t) => words.includes(t))).toBe(true);
  });

  it("parseTkQuery keeps its terms for ordinary input", () => {
    expect(parseTkQuery('"sociale advocatuur" (WW-uitkering), 2.0! ...ICT...')).toEqual({
      terms: [
        { text: "sociale advocatuur", mode: "word" },
        { text: "WW-uitkering", mode: "substring" },
        { text: "2.0", mode: "word" },
        { text: "ICT", mode: "word" },
      ],
      ignored: [],
    });
  });
});

describe("free-text query schemas are capped", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const capped = [
    "data_overheid_datasets_search",
    "cbs_tables_search",
    "tweede_kamer_documents",
    "tweede_kamer_search",
    "tweede_kamer_votes",
    "tweede_kamer_debatten",
    "officiele_bekendmakingen_search",
    "rijksbegroting_search",
    "duo_datasets_search",
    "duo_rio_search",
    "overheid_api_register_search",
    "ori_search",
    "ndw_search",
    "rdw_open_data_search",
    "rijkswaterstaat_waterdata_search",
    "rijkswaterstaat_waterdata_measurements",
    "ngr_discovery_search",
    "rechtspraak_search_ecli",
    "rivm_discovery_search",
    "eurostat_datasets_search",
    "data_europa_datasets_search",
  ];

  it("refuses a 501-character query before any request, and accepts 500 characters", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "input-size-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      for (const name of capped) {
        const result = (await client.callTool({ name, arguments: { query: `a${"?".repeat(500)}` } })) as { isError?: boolean };
        expect(result.isError, name).toBe(true);
      }
      expect(fetchMock).not.toHaveBeenCalled();

      const ok = (await client.callTool({
        name: "data_overheid_datasets_search",
        arguments: { query: `luchtkwaliteit ${"x".repeat(485)}`, dryRun: true },
      })) as { isError?: boolean };
      expect(ok.isError).toBeFalsy();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("describes the DNB dataset as a path or a URL on the DNB gateway", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "input-size-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const dnb = tools.find((tool) => tool.name === "dnb_statistics_search")!;
      const dataset = (dnb.inputSchema.properties as Record<string, { description?: string }>).dataset;
      for (const text of [dnb.description ?? "", dataset.description ?? ""]) {
        expect(text).not.toMatch(/full (https )?endpoint URL/);
        expect(text).toContain("https://api.dnb.nl/");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("polylabel work is bounded", () => {
  it("puts a point inside a notched 100 m by 0.03 mm polygon quickly", () => {
    const wkt = "POLYGON((155000 463000, 155100 463000, 155100 463000.00003, 155050 463000.000003, 155000 463000.00003, 155000 463000))";
    const geometry = parseWkt(wkt)!;
    let point: [number, number] | undefined;
    expect(elapsed(() => (point = representativePoint(geometry)))).toBeLessThan(1_000);
    expect(geometry.type === "polygon" && pointInPolygon(point!, geometry.polygons[0])).toBe(true);
  });

  it("ends when the cell side is below the floating-point resolution of the coordinates", () => {
    const sliver: Polygon = [[[1e15, 0], [1e15, 1e-9], [0.5e15, 0.5e-10], [0, 1e-9], [0, 0], [1e15, 0]]];
    let point: [number, number] | undefined;
    expect(elapsed(() => (point = polygonInteriorPoint(sliver)))).toBeLessThan(1_000);
    expect(pointInPolygon(point!, sliver)).toBe(true);
  });

  it("keeps the point of an ordinary non-convex polygon", () => {
    // A U opening upward: the centroid lies in the gap, the point lands in an arm.
    const u: Polygon = [[[0, 0], [30, 0], [30, 30], [20, 30], [20, 5], [10, 5], [10, 30], [0, 30], [0, 0]]];
    const point = polygonInteriorPoint(u);
    expect(pointInPolygon(point, u)).toBe(true);
    expect(point[1]).toBeGreaterThan(5);
  });
});

describe("HTML and publication XML stripping stays linear on unclosed openers", () => {
  it("htmlToText handles many <style and <script openers without '>'", () => {
    expect(elapsed(() => htmlToText("<style ".repeat(50_000)))).toBeLessThan(500);
    expect(elapsed(() => htmlToText("<script ".repeat(50_000)))).toBeLessThan(500);
    // Escaped openers were linear before and stay text.
    expect(htmlToText("&lt;style ".repeat(3))).toBe("<style <style <style");
  });

  it("htmlToText strips well-formed and unclosed script/style blocks as before", () => {
    expect(htmlToText("<p>Voor</p><script type='x'>var a = 1;</script ><STYLE>p{}</style>na &amp; <b>vet</b>")).toBe("Voor na & vet");
    expect(htmlToText("tekst <script>niet gesloten")).toBe("tekst");
  });

  it("publicationXmlToText handles many unclosed metadata, tag, comment and processing-instruction openers", () => {
    expect(elapsed(() => publicationXmlToText(`<a>${"<metadata/>".repeat(20_000)}</a>`))).toBeLessThan(500);
    expect(elapsed(() => publicationXmlToText("<b ".repeat(100_000)))).toBeLessThan(500);
    expect(elapsed(() => publicationXmlToText("< ".repeat(100_000)))).toBeLessThan(500);
    expect(elapsed(() => publicationXmlToText("<!-- ".repeat(100_000)))).toBeLessThan(500);
    expect(elapsed(() => publicationXmlToText("<? ".repeat(100_000)))).toBeLessThan(500);
  });

  it("publicationXmlToText keeps its text for well-formed XML", () => {
    const xml =
      "<?xml version='1.0'?><gemeenteblad><metadata><meta name='x'/></metadata><!-- c -->" +
      "<al>Eerste <nadruk>alinea</nadruk>.</al><al>Tweede</al></gemeenteblad>";
    expect(publicationXmlToText(xml)).toBe("Eerste alinea. Tweede");
  });
});
