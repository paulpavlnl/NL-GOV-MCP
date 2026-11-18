import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRegisterSource } from "../src/sources/api-register.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { htmlResponse, jsonResponse, testConfig } from "./helpers/config.js";

const API_HOST = "api.developer.overheid.nl";

function stubFetch(handler: (url: URL) => Response | Promise<Response>): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(href);
    calls.push(url);
    return handler(url);
  }));
  return calls;
}

/** A register entry in the shape GET /apis returns; summary and description are set explicitly. */
function entry(id: string, title: string, extra: { summary?: string; description?: string; org?: string } = {}) {
  return {
    id,
    title,
    summary: extra.summary ?? "",
    description: extra.description ?? "",
    organisation: { uri: `https://identifier.example/org/${id}`, label: extra.org ?? "Organisatie Voorbeeld" },
    lifecycle: { status: "active", version: "1.0.0" },
  };
}

/** The title search finds nothing, so the full list (one short page) is scored locally. */
async function rankedIds(query: string, list: unknown[], top = 10): Promise<string[]> {
  stubFetch((url) => (url.searchParams.has("q") ? jsonResponse([]) : jsonResponse(list)));
  const out = await new ApiRegisterSource(testConfig, "test-key").search(query, top);
  expect(out.params.mode).toBe("api-list-scored");
  return out.items.map((item) => String(item.id));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearHttpCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API register: the locally scored list ranks by field, then by number of terms", () => {
  it("puts titles that carry the terms before summaries, and summaries before description and organisation", async () => {
    const list = [
      // Both terms, but only in the description: listed first by the register.
      entry("beschrijving-2", "Driedimensionale voorbeeldvoorziening", { description: "Levert kaartlagen en voorbeeldadressen in 3D" }),
      entry("organisatie-1", "Zoekdienst", { org: "Bureau Kaartlagen" }),
      entry("samenvatting-1", "Locatiedienst", { summary: "Zoekt adressen op" }),
      entry("titel-1", "Adressen (voorbeeld geharmoniseerd)"),
      entry("titel-1-plus", "Kaartlagen", { description: "Alle adressen op een kaart" }),
      entry("titel-2", "Kaartlagen en adressen"),
      entry("geen", "Weerdienst"),
    ];
    const ids = await rankedIds("kaartlagen adressen", list);
    expect(ids).toEqual(["titel-2", "titel-1-plus", "titel-1", "samenvatting-1", "beschrijving-2", "organisatie-1"]);
  });

  it("an entry matching more of the terms ranks above one matching fewer in the same field", async () => {
    const ids = await rankedIds("alfa beta gamma", [
      entry("een", "Alfa dienst"),
      entry("drie", "Alfa beta gamma dienst"),
      entry("twee", "Beta en gamma"),
    ]);
    expect(ids).toEqual(["drie", "twee", "een"]);
  });

  it("keeps the register's own order for equal scores", async () => {
    const ids = await rankedIds("kaartlagen", [
      entry("zeta", "Zeta kaartlagen"),
      entry("alfa", "Alfa kaartlagen"),
      entry("midden", "Midden kaartlagen"),
    ]);
    expect(ids).toEqual(["zeta", "alfa", "midden"]);
  });

  it("reports a match_score that follows the order and counts a repeated term once", async () => {
    stubFetch((url) =>
      url.searchParams.has("q")
        ? jsonResponse([])
        : jsonResponse([entry("b", "Beschrijving", { description: "kaartlagen" }), entry("a", "Kaartlagen")]),
    );
    const out = await new ApiRegisterSource(testConfig, "test-key").search("kaartlagen kaartlagen", 5);
    const scores = out.items.map((item) => item.match_score as number);
    expect(out.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(0);
  });

  it("control: entries without any term stay out, and top cuts the ranked list", async () => {
    const ids = await rankedIds("kaartlagen", [entry("geen", "Weerdienst"), entry("a", "Kaartlagen A"), entry("b", "Kaartlagen B")], 1);
    expect(ids).toEqual(["a"]);
  });

  it("control: the register's own title search keeps its order and is not re-ranked", async () => {
    const calls = stubFetch(() => jsonResponse([entry("tweede", "Kaartlagen beheer"), entry("eerste", "Kaartlagen")]));
    const out = await new ApiRegisterSource(testConfig, "test-key").search("kaartlagen", 5);
    expect(out.params.mode).toBe("api-search");
    expect(out.items.map((item) => item.id)).toEqual(["tweede", "eerste"]);
    expect(calls.every((url) => url.hostname === API_HOST)).toBe(true);
  });
});

describe("API register: the website pages rank the same way", () => {
  const card = (slug: string, title: string, description: string) =>
    `<li class="x"><div class="rhc-card-as-link"><h2>${title}</h2>
<a href="https://apis.developer.overheid.nl/apis/${slug}">${title}</a>
<a class="_badgeLink" href="#">Organisatie Voorbeeld</a><div class="description">${description}</div></div></li>`;

  it("puts a card whose title carries the terms before one that has them in its description only", async () => {
    const page = `<ul>${card("beschrijving", "Driedimensionale voorbeeldvoorziening", "kaartlagen en adressen")}${card("titel", "Adressen", "voorbeeld")}${card("geen", "Weerdienst", "regen")}</ul>`;
    stubFetch((url) => (url.pathname === "/apis" ? htmlResponse(page) : htmlResponse("<html></html>")));
    const out = await new ApiRegisterSource(testConfig, "").search("kaartlagen adressen", 5);
    expect(out.params.mode).toBe("scored-fallback");
    expect(out.items.map((item) => item.id)).toEqual(["titel", "beschrijving"]);
  });
});
