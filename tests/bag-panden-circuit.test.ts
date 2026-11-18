import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { BAG_OGC_BASE, BagPandenSource, VBO_ENDED_STATUSES } from "../src/sources/bag-panden.js";
import { clearHttpCache, getConnectorHealth, markConnectorFailure } from "../src/utils/connector-runtime.js";

// Own test file: the circuit state of bag_panden_ogc is per process (module), and
// these tests must start from a closed circuit.
const config = loadConfig();
const BBOX = "120000,480000,120100,480100";

function jsonResponse(p: unknown): Response {
  return new Response(JSON.stringify(p), { status: 200, headers: { "content-type": "application/json" } });
}

/** The OGC API either hangs until the request aborts, or answers an empty page at once. */
function ogcFetch(mode: { hang: boolean }) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (!String(input).startsWith(BAG_OGC_BASE)) return new Response("unexpected", { status: 500 });
    if (!mode.hang) return jsonResponse({ type: "FeatureCollection", features: [], links: [] });
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const endedOnly = (bbox: string, endedTimeoutMs?: number) => ({
  objecttype: "verblijfsobject" as const,
  bbox,
  bboxCrs: "EPSG:28992" as const,
  statuses: [...VBO_ENDED_STATUSES],
  includeEnded: false,
  offset: 0,
  limit: 10,
  includeGeometry: false,
  ...(endedTimeoutMs !== undefined ? { endedTimeoutMs } : {}),
});

describe("BAG OGC API: a caller's time budget and the shared circuit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a short beeindigd_timeout_ms over three ended statuses leaves the circuit closed for the next caller", async () => {
    const mode = { hang: true };
    const fetchMock = ogcFetch(mode);
    await expect(new BagPandenSource(config).search(endedOnly(BBOX, 500))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getConnectorHealth("bag_panden_ogc")).toMatchObject({ circuit_open: false, consecutive_failures: 0 });

    // Another caller with the default budget reaches the (healthy) OGC API.
    mode.hang = false;
    const out = await new BagPandenSource(config).search(endedOnly("120200,480200,120300,480300"));
    expect(out.items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("a budget timeout on the half-open probe does not open the circuit again", async () => {
    for (let i = 0; i < 3; i += 1) markConnectorFailure("bag_panden_ogc", { countTowardCircuit: true });
    expect(getConnectorHealth("bag_panden_ogc").circuit_open).toBe(true);
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 301_000);

    const mode = { hang: true };
    const fetchMock = ogcFetch(mode);
    const one = { ...endedOnly("120400,480400,120500,480500", 500), statuses: [VBO_ENDED_STATUSES[0]] };
    await expect(new BagPandenSource(config).search(one)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getConnectorHealth("bag_panden_ogc").circuit_open).toBe(false);

    // The next default-budget caller becomes the probe and closes the circuit.
    mode.hang = false;
    await new BagPandenSource(config).search(endedOnly("120600,480600,120700,480700"));
    expect(getConnectorHealth("bag_panden_ogc")).toMatchObject({ circuit_open: false, consecutive_failures: 0 });
  });
});
