import { afterEach, describe, expect, it, vi } from "vitest";
import { API_REGISTER_CONNECTOR, API_REGISTER_PAGES_CONNECTOR, ApiRegisterSource } from "../src/sources/api-register.js";
import { clearHttpCache, getConnectorCategory, getConnectorHealth, inferConnectorName, markConnectorFailure, markConnectorSuccess } from "../src/utils/connector-runtime.js";
import { SourceRequestError } from "../src/utils/http.js";
import { htmlResponse, jsonResponse, testConfig } from "./helpers/config.js";

// Own test file: circuit state is per process (module), and these tests depend
// on the order in which they open it.

const API_HOST = "api.developer.overheid.nl";
const SITE_HOST = "apis.developer.overheid.nl";

const SITE_CARD = `<ul><li class="x"><div class="rhc-card-as-link"><h2>Kaart Voorbeeld</h2>
<a href="https://apis.developer.overheid.nl/apis/kaart-1">Kaart</a>
<a class="_badgeLink" href="#">Organisatie Voorbeeld</a><div class="description">voorbeeld omschrijving</div></div></li></ul>`;

function stubFetch(apiAnswer: () => Response): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(href);
    calls.push(url);
    if (url.hostname === API_HOST) return apiAnswer();
    return url.pathname === "/apis" ? htmlResponse(SITE_CARD) : htmlResponse("<html></html>");
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearHttpCache();
});

describe("API register: the website pages have a circuit of their own", () => {
  it("names the two paths apart and files both as discovery", () => {
    expect(API_REGISTER_CONNECTOR).toBe("api_register");
    expect(API_REGISTER_PAGES_CONNECTOR).toBe("api_register_pages");
    expect(inferConnectorName(`https://${API_HOST}/api-register/v1/apis`)).toBe("api_register");
    expect(inferConnectorName(`https://${SITE_HOST}/apis/pagina/2`)).toBe("api_register_pages");
    expect(getConnectorCategory("api_register_pages")).toBe("discovery");
    expect(getConnectorCategory("api_register")).toBe("discovery");
  });

  it("control: an open circuit of the pages does not stop the JSON API", async () => {
    for (let i = 0; i < 3; i += 1) markConnectorFailure(API_REGISTER_PAGES_CONNECTOR, { countTowardCircuit: true });
    stubFetch(() => jsonResponse([{ id: "kaart-1", title: "Kaart Voorbeeld" }]));
    const out = await new ApiRegisterSource(testConfig, "test-key").search("kaart", 5);
    expect(out.params.mode).toBe("api-search");
    expect(out.items.map((item) => item.id)).toEqual(["kaart-1"]);
    markConnectorSuccess(API_REGISTER_PAGES_CONNECTOR, 0);
    expect(getConnectorHealth(API_REGISTER_PAGES_CONNECTOR).circuit_open).toBe(false);
  });

  it("the API failure that opens its circuit leaves the pages usable, and later searches read the pages at once", async () => {
    // Two earlier failures; the 503 of this search is the third.
    markConnectorFailure(API_REGISTER_CONNECTOR, { countTowardCircuit: true });
    markConnectorFailure(API_REGISTER_CONNECTOR, { countTowardCircuit: true });
    const first = stubFetch(() => new Response("storing", { status: 503 }));
    const out = await new ApiRegisterSource(testConfig, "test-key").search("kaart", 5);

    expect(out.params.mode).toBe("scored-fallback");
    expect(out.items.map((item) => item.name)).toEqual(["Kaart Voorbeeld"]);
    expect(first.some((url) => url.hostname === SITE_HOST)).toBe(true);
    // A success of the pages does not close the API's circuit, and the API's failures do not touch the pages.
    expect(getConnectorHealth(API_REGISTER_CONNECTOR).circuit_open).toBe(true);
    expect(getConnectorHealth(API_REGISTER_PAGES_CONNECTOR)).toMatchObject({ circuit_open: false, consecutive_failures: 0 });

    // While the API's circuit is open, the next search goes to the pages without asking the API.
    const second = stubFetch(() => jsonResponse([]));
    const again = await new ApiRegisterSource(testConfig, "test-key").search("kaart", 5);
    expect(again.params.mode).toBe("scored-fallback");
    expect(again.items.map((item) => item.name)).toEqual(["Kaart Voorbeeld"]);
    expect(second.some((url) => url.hostname === API_HOST)).toBe(false);
  });

  it("control: with both circuits open the search reports the open circuit", async () => {
    for (let i = 0; i < 3; i += 1) markConnectorFailure(API_REGISTER_PAGES_CONNECTOR, { countTowardCircuit: true });
    const calls = stubFetch(() => jsonResponse([]));
    const error = await new ApiRegisterSource(testConfig, "test-key").search("kaart", 5).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceRequestError);
    expect((error as SourceRequestError).code).toBe("circuit_open");
    expect(calls).toHaveLength(0);
    markConnectorSuccess(API_REGISTER_PAGES_CONNECTOR, 0);
  });
});
