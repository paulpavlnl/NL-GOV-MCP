import { describe, expect, it } from "vitest";
import { applyOutputFormat, paginateRecords } from "../src/utils/output-format.js";
import type { MCPRecord } from "../src/types.js";

function rec(data: Record<string, unknown>): MCPRecord {
  return {
    source_name: "test",
    title: "title",
    canonical_url: "https://example.com",
    data,
  };
}

describe("output format helpers", () => {
  it("renders csv", () => {
    const out = applyOutputFormat({
      records: [rec({ id: 1, name: "alpha" })],
      outputFormat: "csv",
    });

    expect(out.output_format).toBe("csv");
    expect(typeof out.formatted_output).toBe("string");
    expect(String(out.formatted_output)).toContain("data.id");
    expect(String(out.formatted_output)).toContain("alpha");
  });

  it("renders geojson when coordinates exist", () => {
    const out = applyOutputFormat({
      records: [rec({ latitude: 52.08, longitude: 4.31 })],
      outputFormat: "geojson",
    });

    expect(out.output_format).toBe("geojson");
    const geo = out.formatted_output as Record<string, unknown>;
    expect(geo.type).toBe("FeatureCollection");
  });

  it("falls back to json for geojson without location", () => {
    const out = applyOutputFormat({
      records: [rec({ id: 123 })],
      outputFormat: "geojson",
    });

    expect(out.output_format).toBe("json");
    expect(out.access_note).toContain("fallback naar json");
  });

  it("keeps one record on one markdown row when a cell or header holds CR, LF or a backslash", () => {
    const out = applyOutputFormat({
      records: [
        { ...rec({ "key\r\nname": "v", note: "back\\|slash" }), title: "first\rsecond", snippet: "line one\nline two" },
      ],
      outputFormat: "markdown_table",
    });
    const table = String(out.formatted_output);

    expect(table).not.toMatch(/\r/);
    const lines = table.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("| data.key name |");
    expect(lines[2]).toContain("| first second |");
    expect(lines[2]).toContain("| line one line two |");
    // The upstream "\|" becomes "\\\|": an escaped backslash, then an escaped pipe.
    expect(lines[2]).toContain("| back\\\\\\|slash |");
    // Every unescaped pipe is a column border: header and row have the same number.
    const borders = (line: string) => line.replace(/\\\\/g, "").replace(/\\\|/g, "").split("|").length;
    expect(borders(lines[2])).toBe(borders(lines[0]));
  });

  it("escapes pipes and folds newlines in markdown cells as before", () => {
    const out = applyOutputFormat({
      records: [{ ...rec({ name: "a|b" }), title: "plain\ntitle" }],
      outputFormat: "markdown_table",
    });
    const rows = String(out.formatted_output).split("\n");
    expect(rows[0]).toBe("| source_name | title | canonical_url | date | snippet | data.name |");
    expect(rows[2]).toBe("| test | plain title | https://example.com |  |  | a\\|b |");
  });

  it("does not let a data key replace source_name, title or canonical_url in GeoJSON", () => {
    const out = applyOutputFormat({
      records: [
        rec({
          lat: 52.1,
          lon: 5.1,
          source_name: "other-source",
          title: "Other title",
          canonical_url: "https://other.example/",
          date: "2024-01-01",
          kind: "station",
        }),
      ],
      outputFormat: "geojson",
    });
    const geo = out.formatted_output as { features: Array<{ properties: Record<string, unknown> }> };
    const props = geo.features[0].properties;

    expect(props.source_name).toBe("test");
    expect(props.title).toBe("title");
    expect(props.canonical_url).toBe("https://example.com");
    // Other data keys keep coming through, including date when the record has none of its own.
    expect(props.date).toBe("2024-01-01");
    expect(props.kind).toBe("station");
    expect(props.lat).toBe(52.1);
  });

  it("paginates records", () => {
    const out = paginateRecords([1, 2, 3, 4], { offset: 1, limit: 2, total: 4 });
    expect(out.page).toEqual([2, 3]);
    expect(out.pagination.has_more).toBe(true);
    expect(out.pagination.total).toBe(4);
  });
});
