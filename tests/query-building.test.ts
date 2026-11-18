import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRegisterSource } from "../src/sources/api-register.js";
import { BagDetailSource } from "../src/sources/bagDetail.js";
import { BekendmakingenSource } from "../src/sources/bekendmakingen.js";
import { CvdrSource } from "../src/sources/cvdr.js";
import { DataOverheidSource, ckanFilterValue } from "../src/sources/data-overheid.js";
import { EpOnlineSource } from "../src/sources/ep-online.js";
import { KoopCollectieSource } from "../src/sources/koop-collecties.js";
import { TweedeKamerInputError, TweedeKamerSource } from "../src/sources/tweede-kamer.js";
import { bwbSearchCql } from "../src/sources/wetten-bwb.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { escapeSruValue, freeTextCql, freeTextCqlTerms } from "../src/utils/sru-cql.js";
import { MARKING, locatedRecord, sruResponse } from "./helpers/bekendmakingen-fixtures.js";
import { jsonResponse, testConfig, xmlResponse } from "./helpers/config.js";

interface Call {
  url: URL;
  headers: Headers;
}

/** Stub fetch with a handler; every request is recorded with its headers. */
function stubFetch(handler: (url: URL) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(href);
    calls.push({ url, headers: new Headers(init?.headers) });
    return handler(url);
  }));
  return calls;
}

const EMPTY_SRU = `<?xml version="1.0" encoding="UTF-8"?>
<sru:searchRetrieveResponse xmlns:sru="http://docs.oasis-open.org/ns/search-ws/sruResponse">
  <sru:version>2.0</sru:version><sru:numberOfRecords>0</sru:numberOfRecords><sru:records></sru:records>
</sru:searchRetrieveResponse>`;

const sentQueries = (calls: Call[]) => calls.map((call) => call.url.searchParams.get("query") ?? "");

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearHttpCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/*  braces never reach a KOOP SRU query                           */
/* ------------------------------------------------------------------ */

describe("KOOP SRU: braces are removed from every caller value", () => {
  it("strips braces in the plain free-text terms and in quoted values", () => {
    expect(freeTextCqlTerms("zorg{ x} {")).toEqual(["zorg"]);
    expect(freeTextCql("{woning}bouw")).toBe("woningbouw");
    expect(escapeSruValue("Gemeente Utrecht{")).toBe("Gemeente Utrecht");
    expect(escapeSruValue('a{"}\\')).toBe('a\\"\\\\');
  });

  it("control: values without braces are escaped as before", () => {
    expect(freeTextCql("tuchtklachten huisarts")).toBe("tuchtklachten AND huisarts");
    expect(escapeSruValue('Centraal "Tucht" College')).toBe('Centraal \\"Tucht\\" College');
    expect(escapeSruValue("a\\b")).toBe("a\\\\b");
  });

  it("koop-collecties sends no brace from query or organisatie", async () => {
    const calls = stubFetch(() => xmlResponse(EMPTY_SRU));
    await new KoopCollectieSource(testConfig, "samenwerkendecatalogi").search({ organisatie: "Gemeente Voorbeeld{", maximumRecords: 1 });
    await new KoopCollectieSource(testConfig, "tuchtrecht").search({ query: "zorg{", maximumRecords: 1 });
    await new KoopCollectieSource(testConfig, "tuchtrecht").search({ query: "welzijn", organisatie: "{}", maximumRecords: 1 });
    const queries = sentQueries(calls);
    expect(queries).toEqual([
      'c.product-area==samenwerkendecatalogi AND dt.creator=="Gemeente Voorbeeld"',
      "c.product-area==tuchtrecht AND zorg",
      // An organisatie of braces only is no filter at all.
      "c.product-area==tuchtrecht AND welzijn",
    ]);
  });

  it("bekendmakingen sends no brace from an unknown publicatieblad or a record identifier", async () => {
    const calls = stubFetch(() => xmlResponse(EMPTY_SRU));
    const source = new BekendmakingenSource(testConfig);
    await source.search({ query: "wonen", publicatieblad: "Voorbeeldblad{", maximumRecords: 1 });
    await source.getRecord("gmb-2026-1{");
    const queries = sentQueries(calls);
    expect(queries.length).toBeGreaterThanOrEqual(2);
    for (const query of queries) expect(query).not.toMatch(/[{}]/);
    expect(queries.some((query) => query.includes('w.publicatienaam="Voorbeeldblad"'))).toBe(true);
    expect(queries.some((query) => query.includes('dt.identifier=="gmb-2026-1"'))).toBe(true);
  });

  it("control: a plain record identifier is looked up exactly as before", async () => {
    const calls = stubFetch(() => xmlResponse(EMPTY_SRU));
    await new BekendmakingenSource(testConfig).getRecord("gmb-2026-104512");
    expect(sentQueries(calls)[0]).toBe('dt.identifier=="gmb-2026-104512" AND c.product-area="officielepublicaties"');
  });

  it("cvdr sends no brace from the keyword or the organisation", async () => {
    const calls = stubFetch(() => xmlResponse(EMPTY_SRU));
    await new CvdrSource(testConfig).search({ query: "parkeren{ {}", organization: "Voorbeeldstad}", maximumRecords: 5 });
    const queries = sentQueries(calls);
    expect(queries[0]).toBe('keyword=parkeren AND creator="Voorbeeldstad"');
    for (const query of queries) expect(query).not.toMatch(/[{}]/);
  });

  it("control: cvdr keyword and organisation without braces are unchanged", async () => {
    const calls = stubFetch(() => xmlResponse(EMPTY_SRU));
    await new CvdrSource(testConfig).search({ query: "parkeren", organization: "Voorbeeldstad", maximumRecords: 6 });
    expect(sentQueries(calls)[0]).toBe('keyword=parkeren AND creator="Voorbeeldstad"');
  });
});

describe("wetten-bwb: a title or afkorting is one CQL value", () => {
  const DAY = "2026-01-01";

  it("quotes a single token that carries CQL syntax, and drops braces", () => {
    expect(bwbSearchCql("Awb)or(dcterms.identifier=x", DAY)).toBe(
      `overheidbwb.titel="Awb)or(dcterms.identifier=x" and overheidbwb.geldigheidsdatum=${DAY}`,
    );
    expect(bwbSearchCql('Wet"or"x', DAY)).toBe(`overheidbwb.titel="Wet\\"or\\"x" and overheidbwb.geldigheidsdatum=${DAY}`);
    expect(bwbSearchCql("Awb{", DAY)).toBe(`overheidbwb.titel="Awb" and overheidbwb.geldigheidsdatum=${DAY}`);
    expect(bwbSearchCql("or", DAY)).toBe(`overheidbwb.titel="or" and overheidbwb.geldigheidsdatum=${DAY}`);
  });

  it("control: plain words stay bare and phrases quoted, as before", () => {
    expect(bwbSearchCql("arbeid", DAY)).toBe(`overheidbwb.titel=arbeid and overheidbwb.geldigheidsdatum=${DAY}`);
    expect(bwbSearchCql("Wet-voorbeeld", DAY)).toBe(`overheidbwb.titel=Wet-voorbeeld and overheidbwb.geldigheidsdatum=${DAY}`);
    expect(bwbSearchCql("arbeid vreemdelingen", DAY)).toBe(`overheidbwb.titel="arbeid vreemdelingen" and overheidbwb.geldigheidsdatum=${DAY}`);
  });
});

/* ------------------------------------------------------------------ */
/*  CKAN filter values                                             */
/* ------------------------------------------------------------------ */

describe("data.overheid.nl: organization and theme are one quoted term each", () => {
  const fqOf = async (organization?: string, theme?: string) => {
    const calls = stubFetch(() => jsonResponse({ success: true, result: { count: 0, results: [] } }));
    await new DataOverheidSource(testConfig).datasetsSearch({ query: `q${Math.random()}`, rows: 5, organization, theme });
    // A title or label is first looked up in the organization list or the theme list.
    const search = calls.find((call) => call.url.pathname.endsWith("/package_search"));
    return search ? search.url.searchParams.get("fq") : undefined;
  };

  it("quotes multi-word values and escapes Lucene syntax in them", async () => {
    expect(await fqOf("Gemeente Voorbeeld", "Openbare orde en veiligheid")).toBe(
      'organization:"Gemeente Voorbeeld" AND theme:"Openbare orde en veiligheid"',
    );
    expect(await fqOf("x OR *:*", 'y") OR (*:*')).toBe('organization:"x OR *:*" AND theme:"y\\") OR (*:*"');
    expect(ckanFilterValue('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it("control: a CKAN slug goes as is, an empty value adds no filter", async () => {
    expect(await fqOf("voorbeeld-organisatie")).toBe("organization:voorbeeld-organisatie");
    expect(await fqOf("  ", undefined)).toBeNull();
    expect(ckanFilterValue("-x")).toBe('"-x"');
  });
});

/* ------------------------------------------------------------------ */
/*  Tweede Kamer document id                                       */
/* ------------------------------------------------------------------ */

describe("tweede_kamer_document_get: only a GUID reaches the path", () => {
  const GUID = "00000000-0000-4000-8000-0000000000a1";

  it("refuses an id that leaves Document(...) before any request", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const source = new TweedeKamerSource(testConfig);
    for (const id of [`${GUID})/../Verslag(${GUID}`, `${GUID})/../../../../x/y?z=(`, "doc-1", "", `${GUID}?$filter=x`]) {
      await expect(source.getDocument({ id })).rejects.toBeInstanceOf(TweedeKamerInputError);
    }
    expect(calls).toHaveLength(0);
  });

  it("control: a GUID, also with surrounding spaces, is fetched", async () => {
    const calls = stubFetch(() => jsonResponse({ Id: GUID, Onderwerp: "Voorbeeld", ContentType: "application/pdf" }));
    const out = await new TweedeKamerSource(testConfig).getDocument({ id: ` ${GUID.toUpperCase()} ` });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe(`/OData/v5/Document(${GUID.toUpperCase()})`);
    expect(out.item.resource_url).toContain(`/Document(${GUID.toUpperCase()})/Resource`);
  });
});

/* ------------------------------------------------------------------ */
/*  API register key only on the JSON API                          */
/* ------------------------------------------------------------------ */

describe("api register: the key goes only to the JSON API", () => {
  // The JSON API has its own host; the HTML pages are on the website host.
  const isJsonApi = (call: Call) => call.url.hostname === "api.developer.overheid.nl";

  it("does not send the key to the HTML pages of the scraping fallback", async () => {
    // A refused key is one of the failures that sends the source to the HTML pages.
    const calls = stubFetch((url) =>
      url.hostname === "api.developer.overheid.nl" ? new Response("refused", { status: 401 }) : new Response("<html><body></body></html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    await new ApiRegisterSource(testConfig, "test-key-123").search("voorbeeld", 5);
    const json = calls.filter(isJsonApi);
    const html = calls.filter((call) => !isJsonApi(call));
    for (const call of html) expect(call.url.hostname).toBe("apis.developer.overheid.nl");
    expect(html.length).toBeGreaterThan(0);
    for (const call of html) {
      expect(call.headers.get("x-api-key")).toBeNull();
      expect(call.headers.get("authorization")).toBeNull();
    }
    // Control: the JSON API still gets it.
    expect(json.length).toBeGreaterThan(0);
    expect(json[0].headers.get("x-api-key")).toBe("test-key-123");
  });
});

/* ------------------------------------------------------------------ */
/*  dot segments in key-bearing paths                              */
/* ------------------------------------------------------------------ */

describe("BAG and EP-Online: no dot segment in a key-bearing path", () => {
  it("BAG refuses '.' and '..' as an id before a request", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const source = new BagDetailSource(testConfig);
    await expect(source.getVerblijfsobject("..", "test-key")).rejects.toThrow(/BAG-id/);
    await expect(source.getPand(".", "test-key")).rejects.toThrow(/BAG-id/);
    expect(calls).toHaveLength(0);
  });

  it("BAG: an id from the Locatieserver that is '..' becomes a note, not a request", async () => {
    const saved = process.env.BAG_API_KEY;
    process.env.BAG_API_KEY = "test-key";
    try {
      const calls = stubFetch((url) =>
        url.hostname === "api.pdok.nl"
          ? jsonResponse({ response: { docs: [{ id: "adr-1", weergavenaam: "Voorbeeldstraat 1", adresseerbaarobject_id: "..", pandid: ["."] }] } })
          : jsonResponse({}),
      );
      const out = await new BagDetailSource(testConfig).lookupDetail({ pdok_id: "adr-1" });
      expect(calls.filter((call) => call.url.hostname === "api.bag.kadaster.nl")).toHaveLength(0);
      expect(out.detail.notes.join(" ")).toMatch(/verblijfsobject-lookup mislukt/);
    } finally {
      if (saved === undefined) delete process.env.BAG_API_KEY;
      else process.env.BAG_API_KEY = saved;
    }
  });

  it("control: a BAG id is requested with the key", async () => {
    const calls = stubFetch(() => jsonResponse({ pand: { identificatie: "0000100000000001" } }));
    await new BagDetailSource(testConfig).getPand("0000100000000001", "test-key");
    expect(calls[0].url.pathname).toBe("/lvbag/individuelebevragingen/v2/panden/0000100000000001");
    expect(calls[0].headers.get("x-api-key")).toBe("test-key");
  });

  it("EP-Online refuses '.' and '..' as bagId before a request", async () => {
    const calls = stubFetch(() => jsonResponse([]));
    const source = new EpOnlineSource(testConfig, "test-key");
    await expect(source.search({ bagId: "..", rows: 5 })).rejects.toThrow(/bagId/);
    await expect(source.search({ bagId: ".", rows: 5 })).rejects.toThrow(/bagId/);
    expect(calls).toHaveLength(0);
  });

  it("control: EP-Online requests a bagId with dots inside it", async () => {
    const calls = stubFetch(() => jsonResponse([]));
    await new EpOnlineSource(testConfig, "test-key").search({ bagId: "0000010000000001", rows: 5 });
    expect(calls[0].url.pathname).toMatch(/\/PandEnergielabel\/AdresseerbaarObject\/0000010000000001$/);
  });
});

/* ------------------------------------------------------------------ */
/*  location work per record                                      */
/* ------------------------------------------------------------------ */

describe("bekendmakingen: location work per record is bounded", () => {
  /** A marking without any geometry: looked at, but no location. */
  const EMPTY_MARKING = MARKING.gemeente;
  const PUNT = MARKING.punt(134630, 453950, 52.0734589, 5.0900909, "Voorbeeldplein");

  const locationsOf = async (markings: string[]) => {
    stubFetch(() => xmlResponse(sruResponse([locatedRecord("gmb-2026-9", markings)], 1)));
    const [item] = (await new BekendmakingenSource(testConfig).search({ query: "", maximumRecords: 5 })).items;
    return item;
  };

  it("stops looking after a fixed number of elements, located or not", async () => {
    const item = await locationsOf([...Array.from({ length: 400 }, () => EMPTY_MARKING), PUNT]);
    expect(item.location).toBeUndefined();
  });

  it("control: a location after a few elements without geometry is still found", async () => {
    const item = await locationsOf([...Array.from({ length: 10 }, () => EMPTY_MARKING), PUNT]);
    expect(item.location).toMatchObject({ kind: "Punt", label: "Voorbeeldplein" });
  });

  it("control: at most 50 locations are listed", async () => {
    const item = await locationsOf(Array.from({ length: 80 }, () => PUNT));
    expect((item.locations as unknown[]).length).toBe(50);
  });
});
