import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { API_REGISTER_API, ApiRegisterSource, apiSummaryToItem } from "../src/sources/api-register.js";

const config = loadConfig();

afterEach(() => vi.unstubAllGlobals());

describe("API register", () => {
  it("queries the official API with the key in X-Api-Key and maps ApiSummary items", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify([
        { id: "rechtspraak-open-data", title: "Open Data van de Rechtspraak", summary: "Uitspraken", organisation: { uri: "https://identifier.overheid.nl/tooi/id/oorg/oorg10073", label: "De Rechtspraak" }, lifecycle: { status: "active" } },
      ]), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await new ApiRegisterSource(config, "test-key").search("rechtspraak-unique-1", 5);

    const [url, init] = fetchMock.mock.calls[0];
    const u = new URL(String(url));
    expect(`${u.origin}${u.pathname}`).toBe(`${API_REGISTER_API}/apis`);
    expect(u.searchParams.get("q")).toBe("rechtspraak-unique-1");
    expect(u.searchParams.get("perPage")).toBe("5");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("test-key");
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      name: "Open Data van de Rechtspraak",
      organization: "De Rechtspraak",
      url: "https://apis.developer.overheid.nl/apis/rechtspraak-open-data",
    });
  });

  it("maps a summary without organisation", () => {
    expect(apiSummaryToItem({ id: "x", title: "X" })).toMatchObject({ name: "X", organization: "", url: "https://apis.developer.overheid.nl/apis/x" });
  });
});
