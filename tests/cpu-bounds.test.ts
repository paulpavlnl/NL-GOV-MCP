import { describe, expect, it } from "vitest";
import type { MCPRecord, Provenance } from "../src/types.js";
import { enrichRelatedLinks } from "../src/utils/cross-reference.js";
import {
  type Coord,
  type Polygon,
  WKT_MAX_LENGTH,
  parseWkt,
  pointInPolygon,
  polygonCentroid,
  polygonInteriorPoint,
  polylabel,
  representativePoint,
} from "../src/utils/geometry.js";
import { buildFormattedResponse } from "../src/utils/tool-runner.js";

/** Milliseconds a call took. The budgets are far above the bounded run time and far below the unbounded one. */
function elapsed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

function links(record: MCPRecord): Array<Record<string, unknown>> {
  return (((record.data ?? {}) as Record<string, unknown>).related_links ?? []) as Array<Record<string, unknown>>;
}

function provenance(returned: number): Provenance {
  return { tool: "test_records", endpoint: "https://voorbeeld.test/api", query_params: {}, timestamp: "2026-01-01T00:00:00.000Z", returned_results: returned };
}

/** `count` records whose snippets all cite the same `ids` BWB ids. */
function sharingRecords(count: number, ids: number): MCPRecord[] {
  const cited = Array.from({ length: ids }, (_, i) => `BWBR${String(1_000_000 + i).padStart(7, "0")}`).join(" ");
  return Array.from({ length: count }, (_, i) => ({
    source_name: "data_overheid",
    title: `Dataset ${i}`,
    canonical_url: `https://voorbeeld.test/dataset/${i}`,
    snippet: `Grondslag: ${cited}`,
    data: {},
  }));
}

describe("cross-reference links are bounded", () => {
  it("caps related_links per record when many records share many ids", () => {
    const out = enrichRelatedLinks(sharingRecords(25, 300));
    expect(out).toHaveLength(25);
    for (const record of out) expect(links(record).length).toBeLessThanOrEqual(50);
    expect(out.reduce((sum, record) => sum + links(record).length, 0)).toBeLessThanOrEqual(25 * 50);
  });

  it("takes at most 20 different ids of a kind from a record's free text", () => {
    const [record] = enrichRelatedLinks(sharingRecords(1, 30));
    const wetten = links(record).filter((link) => link.target_connector === "officiele_bekendmakingen");
    expect(wetten.map((link) => link.target_id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `BWBR${String(1_000_000 + i).padStart(7, "0")}`),
    );
  });

  it("builds links only for the page that is sent", () => {
    const response = buildFormattedResponse({
      summary: "x",
      records: sharingRecords(200, 300),
      provenance: provenance(1),
      outputFormat: "json",
      offset: 0,
      limit: 1,
    });
    expect(response.records).toHaveLength(1);
    expect(links(response.records[0]).length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(response).length).toBeLessThan(50_000);
  });

  it("keeps the links of ordinary records, links to records outside the page included", () => {
    const records: MCPRecord[] = [
      { source_name: "rechtspraak", title: "Uitspraak ECLI:NL:HR:2020:1234 over BWBR0001854", canonical_url: "https://voorbeeld.test/a", data: {} },
      { source_name: "wetten", title: "Wet", canonical_url: "https://voorbeeld.test/b", data: { bwb_id: "BWBR0001854" } },
      { source_name: "cbs", title: "Zie ecli:nl:hr:2020:1234", canonical_url: "https://voorbeeld.test/c", data: { gemeentecode: "GM0001" } },
      { source_name: "cbs", title: "Kerncijfers", canonical_url: "https://voorbeeld.test/d", data: { gemeentecode: "GM0001" } },
      { source_name: "tweedekamer", title: "Geen verwijzing", canonical_url: "https://voorbeeld.test/e", data: {} },
    ];
    const wetten = { target_connector: "officiele_bekendmakingen", target_id: "BWBR0001854", relationship: "references_law", url: "https://wetten.overheid.nl/BWBR0001854" };
    const bag = {
      target_connector: "bag_linked_data",
      target_id: "GM0001",
      relationship: "about_municipality",
      url: "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?fq=gemeentecode:GM0001",
    };
    const expected = [
      [
        { target_connector: "cbs", target_id: "ECLI:NL:HR:2020:1234", relationship: "related_record", url: "https://voorbeeld.test/c" },
        { target_connector: "wetten", target_id: "BWBR0001854", relationship: "references_law", url: "https://voorbeeld.test/b" },
        wetten,
      ],
      [{ target_connector: "rechtspraak", target_id: "BWBR0001854", relationship: "references_law", url: "https://voorbeeld.test/a" }, wetten],
      [
        { target_connector: "cbs", target_id: "GM0001", relationship: "about_municipality", url: "https://voorbeeld.test/d" },
        bag,
        { target_connector: "rechtspraak", target_id: "ECLI:NL:HR:2020:1234", relationship: "related_record", url: "https://voorbeeld.test/a" },
      ],
      [{ target_connector: "cbs", target_id: "GM0001", relationship: "about_municipality", url: "https://voorbeeld.test/c" }, bag],
      [],
    ];
    expect(enrichRelatedLinks(records).map(links)).toEqual(expected);
    expect(enrichRelatedLinks(records)[4]).toBe(records[4]);

    // The page holds records 1 and 2; their links to records 0 and 3 stay.
    const response = buildFormattedResponse({
      summary: "x",
      records,
      provenance: provenance(2),
      outputFormat: "json",
      offset: 1,
      limit: 2,
    });
    expect(response.records.map(links)).toEqual(expected.slice(1, 3));
    expect(response.pagination).toMatchObject({ offset: 1, limit: 2, total: 5, has_more: true });
  });
});

type C = Coord;
const X = 155_000;
const Y = 463_000;
/** A polygon along the corners, every edge split into `perEdge` collinear pieces, at RD-sized coordinates. */
function densify(corners: C[], perEdge: number): Polygon {
  const ring: C[] = [];
  for (let c = 0; c + 1 < corners.length; c += 1) {
    const [ax, ay] = corners[c];
    const [bx, by] = corners[c + 1];
    for (let k = 0; k < perEdge; k += 1) {
      const f = k / perEdge;
      ring.push([X + ax + (bx - ax) * f, Y + ay + (by - ay) * f]);
    }
  }
  ring.push([X + corners[0][0], Y + corners[0][1]]);
  return [ring];
}
/** A strip of width w along three sides of a square field of side s. */
const uStrip = (s: number, w: number): C[] => [[0, 0], [s, 0], [s, s], [s - w, s], [s - w, w], [w, w], [w, s], [0, s], [0, 0]];
/** A strip of width w along two sides. */
const lStrip = (s: number, w: number): C[] => [[0, 0], [s, 0], [s, w], [w, w], [w, s], [0, s], [0, 0]];

describe("the interior-point search has one work budget", () => {
  const thin: Array<[string, Polygon]> = [
    ["1 m U strip around a 300 m field, 2,001 vertices", densify(uStrip(300, 1), 250)],
    ["0.5 m U strip around a 300 m field, 1,001 vertices", densify(uStrip(300, 0.5), 125)],
    ["1 m L strip along a 300 m field, 1,999 vertices", densify(lStrip(300, 1), 333)],
    ["0.01 m walled U of 100 m, 2,001 vertices", densify(uStrip(100, 0.01), 250)],
    ["0.5 m U strip around a 300 m field, 2,001 vertices", densify(uStrip(300, 0.5), 250)],
  ];

  for (const [name, polygon] of thin) {
    it(`puts a point inside a ${name} quickly`, () => {
      expect(pointInPolygon(polygonCentroid(polygon), polygon)).toBe(false);
      let point: Coord | undefined;
      expect(elapsed(() => (point = polygonInteriorPoint(polygon)))).toBeLessThan(500);
      expect(pointInPolygon(point!, polygon)).toBe(true);
    });
  }

  it("bounds a polygon with very many vertices, and through WKT", () => {
    const polygon = densify(uStrip(300, 1), 12_500);
    let point: Coord | undefined;
    expect(elapsed(() => (point = polygonInteriorPoint(polygon)))).toBeLessThan(1_000);
    expect(pointInPolygon(point!, polygon)).toBe(true);

    const wkt = `POLYGON ((${densify(uStrip(300, 1), 250)[0].map(([x, y]) => `${x} ${y}`).join(", ")}))`;
    const geometry = parseWkt(wkt)!;
    expect(elapsed(() => (point = representativePoint(geometry)))).toBeLessThan(500);
    expect(geometry.type === "polygon" && pointInPolygon(point!, geometry.polygons[0])).toBe(true);
  });

  it("keeps the points of ordinary polygons", () => {
    const L: Polygon = [[[0, 0], [10, 0], [10, 1], [1, 1], [1, 10], [0, 10], [0, 0]]];
    const U: Polygon = [[[0, 0], [30, 0], [30, 30], [20, 30], [20, 5], [10, 5], [10, 30], [0, 30], [0, 0]]];
    const courtyard: Polygon = [
      [[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]],
      [[8, 8], [32, 8], [32, 32], [8, 32], [8, 8]],
    ];
    const v: Polygon = [[[0, 0], [178, 56], [356, 0], [356, 0.5], [178, 56.5], [0, 0.5], [0, 0]]];
    const ditch: Polygon = [[[0, 0], [1000, 1000], [1001.5, 998.5], [1.5, -1.5], [0, 0]]];
    expect(polygonInteriorPoint(L)).toEqual([0.5859375, 0.5859375]);
    expect(polygonInteriorPoint(U)).toEqual([5.0390625, 8.5546875]);
    expect(polygonInteriorPoint(courtyard)).toEqual([4.6875, 4.6875]);
    expect(polygonInteriorPoint(v)).toEqual([338.55859375, 5.73828125]);
    expect(polygonInteriorPoint(ditch)).toEqual([500.75, 499.25]);
    expect(polylabel(U)).toEqual([5.0390625, 8.5546875]);
    // A 4 m strip: the first pass lands inside, as before.
    const wide = densify(uStrip(300, 4), 25);
    expect(pointInPolygon(polygonInteriorPoint(wide), wide)).toBe(true);
  });
});

describe("parseWkt", () => {
  it("reads a long whitespace run after the keyword in linear time", () => {
    for (const tail of ["x", "((5.1 52.0,5.2 52.0,5.2 52.1"]) {
      const wkt = `POLYGON${" ".repeat(100_000)}${tail}`;
      let geometry: unknown = null;
      expect(elapsed(() => (geometry = parseWkt(wkt))), tail).toBeLessThan(100);
      expect(geometry).toBeUndefined();
    }
  });

  it("refuses a geometry text above the length cap before parsing", () => {
    const padded = (length: number): string => {
      const head = "POINT (1 2";
      return `${head}${" ".repeat(length - head.length - 1)})`;
    };
    expect(parseWkt(padded(WKT_MAX_LENGTH + 1))).toBeUndefined();
    expect(parseWkt(padded(WKT_MAX_LENGTH))).toEqual({ type: "point", points: [[1, 2]] });
  });

  it("reads Z, M and ZM headers with and without spaces as before", () => {
    const triangle = { type: "polygon", polygons: [[[[0, 0], [4, 0], [4, 4], [0, 0]]]] };
    expect(parseWkt("POLYGON Z ((0 0 1, 4 0 1, 4 4 1, 0 0 1))")).toEqual(triangle);
    expect(parseWkt("polygonzm((0 0 1 2, 4 0 1 2, 4 4 1 2, 0 0 1 2))")).toEqual(triangle);
    expect(parseWkt("  POINT M  (1 2 3)  ")).toEqual({ type: "point", points: [[1, 2]] });
    expect(parseWkt("MULTIPOINT Z((1 2 3),(3 4 5))")).toEqual({ type: "point", points: [[1, 2], [3, 4]] });
    expect(parseWkt("LINESTRING(0 0,1 1)")).toEqual({ type: "line", lines: [[[0, 0], [1, 1]]] });
    expect(parseWkt("POLYGON Z")).toBeUndefined();
    expect(parseWkt("")).toBeUndefined();
  });
});
