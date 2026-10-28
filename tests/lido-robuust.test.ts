import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { foutOorzaak } from "../src/fork/bron-fouten.js";
import { installRechtspraakEcliRobuust } from "../src/fork/bron-gezondheid.js";
import { lidoRelaties } from "../src/fork/lido-relaties.js";
import { isBronStoring, LIDO_VERZOEK, parsePortaal } from "../src/fork/lido-robuust.js";
import { RechtspraakSource } from "../src/sources/rechtspraak.js";
import { clearHttpCache, getCircuitDecision, markConnectorFailure, markConnectorSuccess } from "../src/utils/connector-runtime.js";
import { getText, SourceRequestError } from "../src/utils/http.js";

const portaalHtml = readFileSync(new URL("./fixtures/lido-portaal-crvb-2021-2984.html", import.meta.url), "utf8");
const netwerkfout = () => new SourceRequestError({ message: "fetch failed (ETIMEDOUT: connect ETIMEDOUT 147.181.37.238:443)", endpoint: "https://linkeddata.overheid.nl/service/get-aantal-per-informatietype?ext-id=X", code: "network_error" });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); clearHttpCache(); });

describe("LiDO portal fallback (src/fork/lido-robuust.ts)", () => {
  it("parses the portal list per document type", () => {
    const p = parsePortaal(portaalHtml);
    expect(p.titel).toMatch(/^ECLI:NL:CRVB:2021:2984 - Centrale Raad van Beroep/);
    expect(p.totaal).toBe(5);
    expect(p.richting).toBe("uitgaande");
    expect(p.perType).toEqual([{ type: "Wet", aantal: 3 }, { type: "Jurisprudentie", aantal: 2 }]);
    expect(p.items.map((i) => i.id)).toEqual(expect.arrayContaining(["BWBR0019057", "ECLI:NL:CRVB:2020:3488", "ECLI:NL:RBMNE:2020:4971"]));
    expect(p.items.find((i) => i.titel.endsWith("Artikel 6"))?.geldig_vanaf).toBe("2021-01-01");
  });

  it("lido_relaties falls back to the portal when the services fail, and says so", async () => {
    const services = vi.fn().mockRejectedValue(netwerkfout());
    const portaal = vi.fn().mockResolvedValue({ ...parsePortaal(portaalHtml), url: "https://linkeddata.overheid.nl/front/portal/spiegel-lijstweergave?ext-id=ECLI%3ANL%3ACRVB%3A2021%3A2984" });
    const r = await lidoRelaties("ECLI:NL:CRVB:2021:2984", {}, services, portaal);
    expect(portaal).toHaveBeenCalledWith({ "ext-id": "ECLI:NL:CRVB:2021:2984" });
    expect(r.bron).toBe("lido-portaal");
    expect(r.totaal).toBe(5);
    expect(r.items).toHaveLength(5);
    expect(r.items.every((i) => i.richting === "uitgaand")).toBe(true);
    expect(r.opmerking).toContain("ETIMEDOUT");
  });

  it("does not fall back when LiDO answers but does not know the identifier, nor on a 4xx", async () => {
    const portaal = vi.fn();
    const leeg = vi.fn().mockResolvedValue('<?xml version="1.0"?><lido service="get-aantal-per-informatietype"/>');
    expect((await lidoRelaties("ECLI:NL:CRVB:2099:1", {}, leeg, portaal)).bekend).toBe(false);
    const vierHonderd = new SourceRequestError({ message: "Source request failed with status 400", endpoint: "x", code: "http_error", status: 400 });
    await expect(lidoRelaties("ECLI:NL:CRVB:2021:2984", {}, vi.fn().mockRejectedValue(vierHonderd), portaal)).rejects.toBe(vierHonderd);
    expect(portaal).not.toHaveBeenCalled();
    expect(isBronStoring(new SourceRequestError({ message: "x", endpoint: "x", code: "http_error", status: 503 }))).toBe(true);
    expect(isBronStoring(new SourceRequestError({ message: "x", endpoint: "x", code: "rate_limited", status: 429 }))).toBe(true);
  });

  it("uses the request settings asked for: 20 s, 3 retries after 2, 5 and 10 s, 24 h cache", () => {
    expect(LIDO_VERZOEK.timeoutMs).toBe(20_000);
    expect(LIDO_VERZOEK.retries).toBe(3);
    expect(LIDO_VERZOEK.retryDelaysMs).toEqual([2_000, 5_000, 10_000]);
    expect(LIDO_VERZOEK.cacheTtlMs).toBe(24 * 60 * 60 * 1000);
  });
});

describe("retries and the real cause (src/utils/http.ts, src/fork/bron-fouten.ts)", () => {
  it("retries network errors with the given delays and reports the cause", async () => {
    const oorzaak = Object.assign(new Error("connect ETIMEDOUT 147.181.37.238:443"), { code: "ETIMEDOUT" });
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: oorzaak }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await getText("https://linkeddata.overheid.nl/service/test-oorzaak", { connector: "lido_test", retries: 3, retryDelaysMs: [1, 1, 1], disableCache: true }).catch((e) => e);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(err).toBeInstanceOf(SourceRequestError);
    expect(err.message).toContain("ETIMEDOUT");
  });

  it("retries a 503 and succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("weg", { status: 503 }))
      .mockResolvedValueOnce(new Response("<lido/>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await getText("https://linkeddata.overheid.nl/service/test-503", { connector: "lido_test", retries: 3, retryDelaysMs: [1, 1, 1], disableCache: true });
    expect(r.data).toBe("<lido/>");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("names an AggregateError per address", () => {
    const agg = Object.assign(new AggregateError([Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT", address: "2a04::1", port: 443 })], ""), { code: "ETIMEDOUT" });
    expect(foutOorzaak(Object.assign(new TypeError("fetch failed"), { cause: agg }))).toMatch(/fetch failed \(ETIMEDOUT.*2a04::1:443/);
  });
});

describe("LiDO circuit (src/utils/connector-runtime.ts)", () => {
  it("never opens on one identifier, opens after 5 different endpoints, half-open after 60 s", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 10; i++) markConnectorFailure("lido", { countTowardCircuit: true, endpoint: "https://linkeddata.overheid.nl/service/get-links?ext-id=ECLI:NL:CRVB:2021:2984" });
    expect(getCircuitDecision("lido").open).toBe(false);
    for (let i = 0; i < 4; i++) markConnectorFailure("lido", { countTowardCircuit: true, endpoint: `https://linkeddata.overheid.nl/service/x?ext-id=${i}` });
    expect(getCircuitDecision("lido").open).toBe(true);
    vi.advanceTimersByTime(60_001);
    expect(getCircuitDecision("lido")).toEqual({ open: false, probe: true });
    markConnectorSuccess("lido", 10);
    expect(getCircuitDecision("lido").open).toBe(false);
  });
});

describe("rechtspraak_get_by_ecli fallback (src/fork/bron-gezondheid.ts)", () => {
  it("takes the route of rechtspraak_uitspraak_get when the direct request throws", async () => {
    const origineel = RechtspraakSource.prototype.getByEcli;
    RechtspraakSource.prototype.getByEcli = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    try {
      installRechtspraakEcliRobuust();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<open-rechtspraak>ECLI:NL:CRVB:2024:2331</open-rechtspraak>", { status: 200 })));
      const out = await new RechtspraakSource({} as never).getByEcli({ ecli: "ECLI:NL:CRVB:2024:2331" });
      expect(out.items[0].xml).toContain("ECLI:NL:CRVB:2024:2331");
      expect((out as unknown as { bron: string }).bron).toBe("gedeelde-client");
      expect(out.access_note).toContain("fetch failed");
    } finally {
      RechtspraakSource.prototype.getByEcli = origineel;
    }
  });
});
