import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataOverheidSource } from "../src/sources/data-overheid.js";
import { appCache } from "../src/cache.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

const THEME_ECONOMIE = "http://standaarden.example/owms/terms/Economie";
const THEME_VERKEER = "http://standaarden.example/owms/terms/Verkeer_(thema)";

/** The beleidsagenda waardelijst: URIs as keys, labels per language, sub-themes with a parent. */
const TAXONOMY = {
  [THEME_ECONOMIE]: { labels: { "nl-NL": "Economie", "en-US": "Economy" } },
  [THEME_VERKEER]: { labels: { "nl-NL": "Verkeer", "en-US": "Traffic" } },
  "http://standaarden.example/owms/terms/Begroting": {
    labels: { "nl-NL": "Begroting", "en-US": "Budget" },
    parent: THEME_ECONOMIE,
  },
};

/** organization_list with all_fields: slug in name, display title in title. */
const ORGANIZATIONS = [
  { name: "gemeente-voorbeeldstad", title: "Gemeente Voorbeeldstad" },
  { name: "voorbeeld-opendata", title: "Voorbeeld OpenData" },
  { name: "voorbeeld-opendata-2", title: "Voorbeeld OpenData" },
];

function stubCkan(): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(href);
    calls.push(url);
    if (url.pathname.endsWith("overheid_taxonomiebeleidsagenda.json")) return jsonResponse(TAXONOMY);
    if (url.pathname.endsWith("/organization_list")) return jsonResponse({ success: true, result: ORGANIZATIONS });
    return jsonResponse({ success: true, result: { count: 0, results: [] } });
  }));
  return calls;
}

async function fqOf(args: { organization?: string; theme?: string }): Promise<{ fq: string | null; calls: URL[] }> {
  const calls = stubCkan();
  const out = await new DataOverheidSource(testConfig).datasetsSearch({ query: `q${Math.random()}`, rows: 5, ...args });
  const search = calls.find((url) => url.pathname.endsWith("/package_search"));
  expect(search).toBeDefined();
  expect(out.query.fq ?? null).toBe(search!.searchParams.get("fq"));
  return { fq: search!.searchParams.get("fq"), calls };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearHttpCache();
  appCache.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("data_overheid_datasets_search: the theme filter uses the dataset's theme field", () => {
  it("turns a Dutch label from data_overheid_themes into its URI in the theme field", async () => {
    const { fq } = await fqOf({ theme: "Verkeer" });
    expect(fq).toBe(`theme:"${THEME_VERKEER}"`);
  });

  it("accepts the English label and any letter case", async () => {
    expect((await fqOf({ theme: "economy" })).fq).toBe(`theme:"${THEME_ECONOMIE}"`);
    expect((await fqOf({ theme: "  BEGROTING " })).fq).toBe('theme:"http://standaarden.example/owms/terms/Begroting"');
  });

  it("passes a theme URI as is, without reading the waardelijst", async () => {
    const { fq, calls } = await fqOf({ theme: THEME_ECONOMIE });
    expect(fq).toBe(`theme:"${THEME_ECONOMIE}"`);
    expect(calls.some((url) => url.pathname.endsWith(".json"))).toBe(false);
  });

  it("control: an unknown theme goes as given, quoted, in the theme field", async () => {
    expect((await fqOf({ theme: "Onbekend thema" })).fq).toBe('theme:"Onbekend thema"');
  });
});

describe("data_overheid_datasets_search: organization is the CKAN slug", () => {
  it("turns a title from data_overheid_organizations into its slug", async () => {
    expect((await fqOf({ organization: "Gemeente Voorbeeldstad" })).fq).toBe("organization:gemeente-voorbeeldstad");
    expect((await fqOf({ organization: "gemeente  VOORBEELDSTAD" })).fq).toBe("organization:gemeente-voorbeeldstad");
  });

  it("a title shared by several organizations matches each of them", async () => {
    expect((await fqOf({ organization: "Voorbeeld OpenData" })).fq).toBe("organization:(voorbeeld-opendata OR voorbeeld-opendata-2)");
  });

  it("combines organization and theme", async () => {
    expect((await fqOf({ organization: "Gemeente Voorbeeldstad", theme: "Verkeer" })).fq).toBe(
      `organization:gemeente-voorbeeldstad AND theme:"${THEME_VERKEER}"`,
    );
  });

  it("control: a slug goes as is without reading the organization list, and no filter adds no fq", async () => {
    const { fq, calls } = await fqOf({ organization: "gemeente-voorbeeldstad" });
    expect(fq).toBe("organization:gemeente-voorbeeldstad");
    expect(calls.some((url) => url.pathname.endsWith("/organization_list"))).toBe(false);
    const none = await fqOf({});
    expect(none.fq).toBeNull();
    expect(none.calls).toHaveLength(1);
  });

  it("control: an unknown title goes as given, quoted", async () => {
    expect((await fqOf({ organization: "Gemeente Elders" })).fq).toBe('organization:"Gemeente Elders"');
  });
});
