import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { ApiRegisterSource } from "../src/sources/api-register.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { SourceRequestError } from "../src/utils/http.js";
import { htmlResponse, jsonResponse, testConfig } from "./helpers/config.js";

const API_HOST = "api.developer.overheid.nl";
const SITE_HOST = "apis.developer.overheid.nl";

interface Call {
  url: URL;
  headers: Headers;
}

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

/** A register entry in the shape GET /apis returns. */
function entry(id: string, title: string, extra: { summary?: string; description?: string; org?: string } = {}) {
  return {
    id,
    title,
    summary: extra.summary ?? `Samenvatting ${title}`,
    description: extra.description ?? "",
    contact: { name: "Voorbeeld", url: "https://voorbeeld.example", email: "info@voorbeeld.example" },
    organisation: { uri: `https://identifier.example/org/${id}`, label: extra.org ?? "Organisatie Voorbeeld" },
    adrScore: 50,
    lifecycle: { status: "active", version: "1.2.0" },
    oasUrl: `https://voorbeeld.example/${id}/openapi.json`,
    _links: { self: { href: `/v1/apis/${id}` } },
  };
}

const filler = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => entry(`vul-${from + i}`, `Vulregister ${from + i}`));

const SITE_CARD = `<ul><li class="x"><div class="rhc-card-as-link"><h2>Kaart Voorbeeld</h2>
<a href="https://apis.developer.overheid.nl/apis/kaart-1">Kaart</a>
<a class="_badgeLink" href="#">Organisatie Voorbeeld</a><div class="description">voorbeeld omschrijving</div></div></li></ul>`;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearHttpCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("API register: the JSON API on its own host", () => {
  it("asks GET /apis on the API host with q, perPage and the key, and reads the bare array", async () => {
    const calls = stubFetch(() => jsonResponse([entry("abc-1", "Voorbeeldregister", { org: "Gemeente Voorbeeld" })]));
    const out = await new ApiRegisterSource(testConfig, "test-key").search("voorbeeldregister", 5);

    expect(calls).toHaveLength(1);
    expect(calls[0].url.hostname).toBe(API_HOST);
    expect(calls[0].url.pathname).toBe("/api-register/v1/apis");
    expect(calls[0].url.searchParams.get("q")).toBe("voorbeeldregister");
    expect(calls[0].url.searchParams.get("perPage")).toBe("5");
    expect(calls[0].url.searchParams.has("limit")).toBe(false);
    expect(calls[0].headers.get("x-api-key")).toBe("test-key");

    expect(out.params.mode).toBe("api-search");
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      id: "abc-1",
      name: "Voorbeeldregister",
      title: "Voorbeeldregister",
      organization: "Gemeente Voorbeeld",
      description: "Samenvatting Voorbeeldregister",
      version: "1.2.0",
      status: "active",
      adr_score: 50,
      oas_url: "https://voorbeeld.example/abc-1/openapi.json",
      url: `https://${SITE_HOST}/apis/abc-1`,
      documentation_url: `https://${SITE_HOST}/apis/abc-1`,
      source: "api.developer.overheid.nl",
    });
  });

  it("caps perPage at the API's maximum of 100", async () => {
    const calls = stubFetch(() => jsonResponse([entry("abc-1", "Voorbeeldregister")]));
    await new ApiRegisterSource(testConfig, "test-key").search("voorbeeldregister", 200);
    expect(calls[0].url.searchParams.get("perPage")).toBe("100");
  });

  it("control: an older object shape with items is still read", async () => {
    stubFetch(() => jsonResponse({ items: [{ name: "Oud Voorbeeld", url: `https://${SITE_HOST}/apis/oud-1` }] }));
    const out = await new ApiRegisterSource(testConfig, "test-key").search("oud", 5);
    expect(out.items[0]).toMatchObject({ name: "Oud Voorbeeld", url: `https://${SITE_HOST}/apis/oud-1` });
  });
});

describe("API register: a query the title search misses is scored over the full list", () => {
  it("lists the register page by page and scores title, summary, description and organisation", async () => {
    const page1 = [
      ...filler(1, 97),
      entry("t-1", "Adressenregister Voorbeeld"),
      entry("d-1", "Locatiedienst", { description: "Levert voorbeeldadressen en woonplaatsen" }),
      entry("o-1", "Zoekdienst", { org: "Bureau Woonplaatsen" }),
    ];
    const page2 = [entry("geen-1", "Weerdienst Voorbeeld"), entry("t-2", "Woonplaatsen en adressenregister")];
    const calls = stubFetch((url) => {
      if (url.searchParams.has("q")) return jsonResponse([]);
      return jsonResponse(url.searchParams.get("page") === "1" ? page1 : page2);
    });

    const out = await new ApiRegisterSource(testConfig, "test-key").search("adressenregister woonplaatsen", 10);

    const listCalls = calls.filter((call) => !call.url.searchParams.has("q"));
    expect(listCalls.map((call) => [call.url.searchParams.get("page"), call.url.searchParams.get("perPage")])).toEqual([["1", "100"], ["2", "100"]]);
    for (const call of calls) {
      expect(call.url.hostname).toBe(API_HOST);
      expect(call.headers.get("x-api-key")).toBe("test-key");
    }
    expect(out.params).toMatchObject({ mode: "api-list-scored", pages: "2", listed: "102", perPage: "100" });
    expect(out.params.list_truncated).toBeUndefined();
    expect(out.endpoint).toBe("https://api.developer.overheid.nl/api-register/v1/apis");

    const ids = out.items.map((item) => item.id);
    // Both terms in the title rank first; then matches in title, description and organisation.
    expect(ids[0]).toBe("t-2");
    expect(ids).toEqual(expect.arrayContaining(["t-1", "t-2", "o-1"]));
    expect(ids).not.toContain("geen-1");
    expect(ids.some((id) => String(id).startsWith("vul-"))).toBe(false);
    expect(out.items.every((item) => typeof item.match_score === "number" && (item.match_score as number) > 0)).toBe(true);
  });

  it("finds an entry by its description when the title does not match", async () => {
    stubFetch((url) =>
      url.searchParams.has("q") ? jsonResponse([]) : jsonResponse([entry("d-1", "Locatiedienst", { description: "Levert handelsgegevens van bedrijven" })]),
    );
    const out = await new ApiRegisterSource(testConfig, "test-key").search("handelsgegevens", 5);
    expect(out.items.map((item) => item.id)).toEqual(["d-1"]);
    expect(out.params.mode).toBe("api-list-scored");
  });

  it("stops after a fixed number of full pages and says the list was cut", async () => {
    let page = 0;
    const calls = stubFetch((url) => {
      if (url.searchParams.has("q")) return jsonResponse([]);
      page += 1;
      return jsonResponse(filler(page * 1000, 100));
    });
    const out = await new ApiRegisterSource(testConfig, "test-key").search("niets passends", 5);
    expect(calls.filter((call) => !call.url.searchParams.has("q"))).toHaveLength(5);
    expect(out.params).toMatchObject({ pages: "5", list_truncated: "true" });
  });

  it("an empty result stays empty: no HTML pages are read", async () => {
    const calls = stubFetch((url) => (url.searchParams.has("q") ? jsonResponse([]) : jsonResponse([entry("geen-1", "Weerdienst")])));
    const out = await new ApiRegisterSource(testConfig, "test-key").search("onvindbaar", 5);
    expect(out.items).toEqual([]);
    expect(out.params.mode).toBe("api-list-scored");
    expect(calls.some((call) => call.url.hostname === SITE_HOST)).toBe(false);
  });
});

describe("API register: the HTML pages only when the API cannot be used", () => {
  const siteOrApi = (apiAnswer: () => Response) => (url: URL) =>
    url.hostname === API_HOST ? apiAnswer() : url.pathname === "/apis" ? htmlResponse(SITE_CARD) : htmlResponse("<html></html>");

  for (const status of [401, 403, 503]) {
    it(`falls back to the keyless HTML pages on HTTP ${status}`, async () => {
      const calls = stubFetch(siteOrApi(() => new Response("nee", { status })));
      const out = await new ApiRegisterSource(testConfig, "test-key").search("kaart", 5);
      expect(out.params.mode).toBe("scored-fallback");
      expect(out.endpoint).toContain("html-fallback");
      expect(out.items.map((item) => item.name)).toEqual(["Kaart Voorbeeld"]);
      for (const call of calls.filter((c) => c.url.hostname === SITE_HOST)) {
        expect(call.headers.get("x-api-key")).toBeNull();
        expect(call.headers.get("authorization")).toBeNull();
      }
    });
  }

  it("reports a 404 from the API as an error instead of hiding it behind a scrape", async () => {
    const calls = stubFetch(siteOrApi(() => new Response("niet gevonden", { status: 404 })));
    const error = await new ApiRegisterSource(testConfig, "test-key").search("kaart", 5).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceRequestError);
    expect((error as SourceRequestError).status).toBe(404);
    expect(calls.some((call) => call.url.hostname === SITE_HOST)).toBe(false);
  });

  it("reports a body that is no list as malformed", async () => {
    stubFetch(siteOrApi(() => jsonResponse({ message: "iets anders" })));
    const error = await new ApiRegisterSource(testConfig, "test-key").search("kaart", 5).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceRequestError);
    expect((error as SourceRequestError).code).toBe("malformed_response");
  });

  it("without a key reads only the HTML pages and sends no key header", async () => {
    const calls = stubFetch(siteOrApi(() => jsonResponse([])));
    const out = await new ApiRegisterSource(testConfig, "").search("kaart", 5);
    expect(out.params.mode).toBe("scored-fallback");
    expect(calls.some((call) => call.url.hostname === API_HOST)).toBe(false);
  });
});

describe("API register: configuration and the tool", () => {
  it("the default config names the JSON API next to the website", () => {
    const config = loadConfig();
    expect(config.endpoints.apiRegisterApi).toBe("https://api.developer.overheid.nl/api-register/v1");
    expect(config.endpoints.apiRegister).toBe("https://apis.developer.overheid.nl");
  });

  it("overheid_api_register_search returns the entry with its website link and the path that answered", async () => {
    vi.stubEnv("OVERHEID_API_KEY", "test-key");
    stubFetch((url) => (url.hostname === API_HOST ? jsonResponse([entry("abc-1", "Voorbeeldregister")]) : htmlResponse("<html></html>")));
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "api-register-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({ name: "overheid_api_register_search", arguments: { query: "voorbeeldregister", top: 5 } })) as {
        content: Array<{ text: string }>;
      };
      const payload = JSON.parse(result.content[0].text) as {
        error?: string;
        records: Array<{ title: string; canonical_url: string }>;
        provenance: { endpoint: string; query_params: Record<string, string> };
      };
      expect(payload.error).toBeUndefined();
      expect(payload.records[0]).toMatchObject({ title: "Voorbeeldregister", canonical_url: `https://${SITE_HOST}/apis/abc-1` });
      expect(JSON.stringify(payload.provenance)).toContain("api-search");
      expect(JSON.stringify(payload.provenance)).toContain(API_HOST);
    } finally {
      await client.close();
    }
  });
});
