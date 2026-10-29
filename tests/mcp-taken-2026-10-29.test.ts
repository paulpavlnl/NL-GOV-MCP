/**
 * FORK (docs/FORK.md) — the three improvements from the test of 29-10-2026:
 * V10 IP retry and own circuit for LiDO's counting service and portal, V12 wetsgeschiedenis_get
 * volgorde "nieuwste" (BW 7:631), V13 paragraph anchors in rechtspraak_richtlijnen (Rapport alimentatienormen).
 */
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetch as undiciFetch } from "undici";
import { andereAdressen, dispatcherVoorAdres, isVerbindingsFout, metAndereAdressen } from "../src/fork/ip-herkansing.js";
import { lidoRelaties } from "../src/fork/lido-relaties.js";
import { kiesDossiers, type Wijziging } from "../src/fork/wetsgeschiedenis.js";
import { ankerVoor, passagesMetAnker, structuur } from "../src/fork/richtlijnen.js";
import { clearHttpCache, getCircuitDecision, markConnectorFailure, markConnectorSuccess } from "../src/utils/connector-runtime.js";
import { SourceRequestError } from "../src/utils/http.js";

afterEach(() => { vi.useRealTimers(); clearHttpCache(); });

const timeout = (ip: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ETIMEDOUT ${ip}:443`), { code: "ETIMEDOUT" }) });

describe("V10: another IP address for LiDO (src/fork/ip-herkansing.ts)", () => {
  it("knows connection and TLS failures from HTTP answers", () => {
    expect(isVerbindingsFout(timeout("147.181.37.221"))).toBe(true);
    expect(isVerbindingsFout(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENETUNREACH", message: "connect ENETUNREACH 2a04::1:443" } }))).toBe(true);
    expect(isVerbindingsFout(Object.assign(new TypeError("fetch failed"), { cause: { code: "ERR_SSL_TLSV1_UNRECOGNIZED_NAME", message: "SSL alert number 112" } }))).toBe(true);
    expect(isVerbindingsFout(new SourceRequestError({ message: "Source request failed with status 503", endpoint: "x", code: "http_error", status: 503 }))).toBe(false);
  });

  it("tries the other addresses: local DNS without the failed one, then public resolvers, IPv4 first", async () => {
    const lookup = async () => [{ address: "2a04:9a00:1002:4021::1", family: 6 }, { address: "147.181.37.221", family: 4 }];
    const publiek = async () => [{ address: "147.181.13.83", family: 4 }, { address: "147.181.37.221", family: 4 }, { address: "147.181.12.117", family: 4 }];
    expect((await andereAdressen("linkeddata.overheid.nl", { lookup, publiek })).map((a) => a.address)).toEqual(["147.181.13.83", "147.181.12.117", "2a04:9a00:1002:4021::1"]);
  });

  it("succeeds on the second address, and names the cause and every address tried when all fail", async () => {
    const bronnen = { lookup: async () => [{ address: "147.181.37.221", family: 4 }], publiek: async () => [{ address: "147.181.13.83", family: 4 }, { address: "147.181.12.117", family: 4 }, { address: "147.181.37.238", family: 4 }, { address: "147.181.1.1", family: 4 }] };
    const poging = vi.fn().mockRejectedValueOnce(timeout("147.181.37.221")).mockResolvedValueOnce("ok");
    expect(await metAndereAdressen("https://linkeddata.overheid.nl/service/x", poging, bronnen)).toBe("ok");
    expect(poging).toHaveBeenCalledTimes(2);
    expect(poging.mock.calls[1][0]).toBeDefined();
    const altijd = vi.fn().mockRejectedValue(timeout("147.181.37.221"));
    const err = (await metAndereAdressen("https://linkeddata.overheid.nl/service/x", altijd, bronnen).catch((e: unknown) => e)) as Error & { adressenGeprobeerd?: string[] };
    expect(altijd).toHaveBeenCalledTimes(4); // 1 + max 3 extra
    expect(err.message).toContain("ook geprobeerd via 147.181.13.83, 147.181.12.117, 147.181.37.238");
    expect(err.adressenGeprobeerd).toHaveLength(3);
    // No other address: the first error goes back unchanged, so the caller can do its usual retries.
    const geen = (await metAndereAdressen("https://linkeddata.overheid.nl/service/x", vi.fn().mockRejectedValue(timeout("147.181.37.221")), { lookup: async () => [{ address: "147.181.37.221", family: 4 }], publiek: async () => [] }).catch((e: unknown) => e)) as Error & { adressenGeprobeerd?: string[] };
    expect(geen.adressenGeprobeerd).toBeUndefined();
    expect(isVerbindingsFout(new SourceRequestError({ message: "Source timeout after 20000ms", endpoint: "x", code: "timeout" }))).toBe(true);
  });

  it("the pinned dispatcher connects to that address and sends the host name as SNI", async () => {
    let hello: Buffer = Buffer.alloc(0);
    const server = net.createServer((s) => s.on("data", (d: Buffer) => { hello = Buffer.concat([hello, d]); s.destroy(); }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as net.AddressInfo;
    const dispatcher = dispatcherVoorAdres("linkeddata.overheid.nl", { address: "127.0.0.1", family: 4 });
    try {
      await undiciFetch(`https://linkeddata.overheid.nl:${port}/service/get-aantal-per-informatietype`, { dispatcher }).catch(() => {});
      expect(hello.includes(Buffer.from("linkeddata.overheid.nl"))).toBe(true);
    } finally {
      await dispatcher.close();
      server.close();
    }
  });

  it("the counting circuit opens after two failed requests, also on one identifier, and is half-open after 60 s", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 2; i++) markConnectorFailure("lido_telling", { countTowardCircuit: true, endpoint: "https://linkeddata.overheid.nl/service/get-aantal-per-informatietype?ext-id=X" });
    expect(getCircuitDecision("lido_telling").open).toBe(true);
    expect(getCircuitDecision("lido").open).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(getCircuitDecision("lido_telling")).toEqual({ open: false, probe: true });
    markConnectorSuccess("lido_telling", 5);
  });

  it("lido_relaties goes on with get-links when the counting service fails, and marks the counts unavailable", async () => {
    const SELF = "http://linkeddata.overheid.nl/terms/jurisprudentie/id/ECLI:NL:HR:2019:2006";
    const NL = "http://linkeddata.overheid.nl/terms/jurisprudentie/id/ECLI:NL:PHR:2019:1";
    const DC = 'xmlns:dcterms="http://purl.org/dc/terms/"';
    const links = `<?xml version="1.0"?><lido service="get-links" lido-id="${SELF}"><facetten><facet name="obj_type"><int name="Jurisprudentie">7</int><int name="Wet">2</int></facet></facetten>` +
      `<subject id="${SELF}"><dcterms:title ${DC}>HR 2019</dcterms:title><inkomende-links><subject-ref type="x" idref="${NL}" label="Door computer herkende referentie"></subject-ref></inkomende-links></subject>` +
      `<subject id="${NL}"><dcterms:identifier ${DC} type="extern">ECLI:NL:PHR:2019:1</dcterms:identifier><dcterms:type ${DC}>Jurisprudentie</dcterms:type><dcterms:title ${DC}>Conclusie</dcterms:title></subject></lido>`;
    const storing = new SourceRequestError({ message: "fetch failed (ETIMEDOUT: connect ETIMEDOUT 147.181.37.221:443) (ook geprobeerd via 147.181.13.83)", endpoint: "x", code: "network_error" });
    const portaal = vi.fn();
    const r = await lidoRelaties("ECLI:NL:HR:2019:2006", {}, async (u) => { if (/get-aantal/.test(u)) throw storing; return links; }, portaal);
    expect(portaal).not.toHaveBeenCalled();
    expect(r.bron).toBe("lido-services");
    expect(r.tellingen).toBe("niet beschikbaar");
    expect(r.totaal).toBe(9);
    expect(r.perType).toEqual([{ type: "Jurisprudentie", aantal: 7 }, { type: "Wet", aantal: 2 }]);
    expect(r.items.map((i) => i.id)).toContain("ECLI:NL:PHR:2019:1");
    expect(r.opmerking).toMatch(/Tellingen niet beschikbaar.*ETIMEDOUT.*147\.181\.13\.83/);
  });
});

describe("V12: wetsgeschiedenis_get volgorde (BW 7:631)", () => {
  // The versions of BW 7:631 in the WTI of BWBR0005290 (29-10-2026), newest first.
  const versies: Wijziging[] = [
    { datum: "2018-01-01", betreft: "wijziging", dossiers: ["34766"], staatsblad: ["stb-2017-484"] },
    { datum: "2017-01-01", betreft: "wijziging", dossiers: ["34108"], staatsblad: ["stb-2015-233"] },
    { datum: "2007-01-01", betreft: "wijziging", dossiers: ["30655"], staatsblad: ["stb-2006-706"] },
    { datum: "2005-12-29", betreft: "wijziging", dossiers: ["30118"], staatsblad: ["stb-2005-573"] },
    { datum: "1998-01-01", betreft: "wijziging", dossiers: ["24776", "25415"], staatsblad: ["stb-1997-178", "stb-1997-794"] },
    { datum: "1997-04-01", betreft: "nieuw", dossiers: ["23438"], staatsblad: ["stb-1996-406"] },
  ];
  it("default stays: the introducing act (23 438) first", () => {
    expect(kiesDossiers(versies, 1)).toEqual(["23438"]);
    expect(kiesDossiers(versies, 4)).toEqual(["23438", "34766", "34108", "30655"]);
  });
  it("nieuwste: the latest amending act, for a paragraph added later", () => {
    expect(kiesDossiers(versies, 1, "nieuwste")).toEqual(["34766"]);
    expect(kiesDossiers(versies, 3, "nieuwste")).toEqual(["34766", "34108", "30655"]);
  });
});

describe("V13: paragraph anchors in rechtspraak_richtlijnen (Rapport alimentatienormen)", () => {
  // The layout of the PDF text: a table of contents with page numbers (one entry wrapped), numbered headings,
  // a footnote, and the page number glued to the footer at the end of every page.
  const tekst = [
    "Inhoud", "3. Behoefte 11", "4.2 Berekening van draagkracht voor kinderalimentatie en", "partneralimentatie 18", "4.6 Bijzondere omstandigheden 24",
    "2Rapport Alimentatienormen januari 2026",
    "4. Draagkracht", "4.2 Berekening van draagkracht voor kinderalimentatie en", "partneralimentatie", "4.2.2.4 Woonbudget",
    "In het forfait zit een woonbudget.", "Als een onderhoudsplichtige duurzaam aanmerkelijk hogere woonlasten heeft dan het", "woonbudget kunnen we daarmee rekening houden.",
    "2 Volgens het rapport Kosten van kinderen behoren ook hoge oppaskosten tot de kosten",
    "20Rapport Alimentatienormen januari 2026",
    "4.6.2 Lasten die niet vermijdbaar en niet verwijtbaar zijn", "• Reiskosten voor werk.", "Woonlasten voormalige echtelijke woning als niet verwijtbare last",
    "27Rapport Alimentatienormen januari 2026",
  ].join("\n");
  const doc = { titel: "Rapport alimentatienormen, versie januari 2026", url: "https://www.rechtspraak.nl/rapport.pdf" };

  it("finds the headings (not the contents or the footnote) and the pages", () => {
    const st = structuur(tekst);
    expect(st.paragrafen.map((p) => p.nummer)).toEqual(["4", "4.2", "4.2.2.4", "4.6.2"]);
    expect(st.paginas.map((p) => p.pagina)).toEqual([2, 20, 27]);
    expect(ankerVoor(st, tekst.indexOf("In het forfait"))).toEqual({ paragraaf: "4.2.2.4", kopje: "Woonbudget", pagina: 20 });
  });

  it("gives every passage its paragraph, page, a link to the page and a citation", () => {
    const p = passagesMetAnker(tekst, "woonlasten", doc);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ paragraaf: "4.2.2.4", kopje: "Woonbudget", pagina: 20, link: "https://www.rechtspraak.nl/rapport.pdf#page=20" });
    expect(p[0].citeer).toBe("Rapport alimentatienormen, versie januari 2026, par. 4.2.2.4 (Woonbudget), p. 20");
    expect(p[1]).toMatchObject({ paragraaf: "4.6.2", pagina: 27 });
  });

  it("a term in a heading belongs to that heading's paragraph", () => {
    const t = ["4.6.1 Inleiding", "Een inleidende alinea over lasten.", "4.6.2 Woonlasten voormalige echtelijke woning", "De lasten van de woning.", "27Rapport Alimentatienormen januari 2026", "28Rapport Alimentatienormen januari 2026", "29Rapport Alimentatienormen januari 2026"].join("\n");
    expect(passagesMetAnker(t, "woonlasten", doc)[0]).toMatchObject({ paragraaf: "4.6.2", pagina: 27 });
  });
});
