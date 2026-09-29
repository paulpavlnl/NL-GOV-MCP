import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { BwbArtikelSource, artikelXmlToText, findArtikelen, normalizeArtikelNr } from "../src/sources/bwb-artikel.js";

const config = loadConfig();

const SRU_XML = `<?xml version="1.0" encoding="UTF-8"?>
<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><numberOfRecords>1</numberOfRecords><records><record><recordData>
<gzd xmlns="http://standaarden.overheid.nl/sru" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:overheidbwb="http://standaarden.overheid.nl/bwb/terms/">
<originalData><overheidbwb:meta><owmskern><dcterms:identifier>BWBR0019057</dcterms:identifier><dcterms:title>Wet werk en inkomen naar arbeidsvermogen</dcterms:title></owmskern>
<bwbipm><overheidbwb:toestand>http://wetten.overheid.nl/id/BWBR0019057/2026-07-01/0</overheidbwb:toestand></bwbipm></overheidbwb:meta></originalData>
<enrichedData><overheidbwb:locatie_toestand>https://repository.officiele-overheidspublicaties.nl/bwb/BWBR0019057/2026-07-01_0/xml/BWBR0019057_2026-07-01_0.xml</overheidbwb:locatie_toestand></enrichedData>
</gzd></recordData></record></records></searchRetrieveResponse>`;

const TOESTAND_XML = `<?xml version="1.0" encoding="UTF-8"?><toestand><wetgeving><wet-besluit><wettekst><hoofdstuk>
<artikel bwb-ng-variabel-deel="/Hoofdstuk7/Paragraaf7.1/Artikel54" label-id="1" label="Artikel 54"><kop><label>Artikel</label><nr>54</nr><titel>Iets anders</titel></kop><al>Niet dit artikel.</al></artikel>
<artikel bwb-ng-variabel-deel="/Hoofdstuk7/Paragraaf7.1/Artikel55" label-id="7587404" label="Artikel 55" inwerking="2017-12-16"><kop><label>Artikel</label><nr>55</nr><titel>Later ontstaan van het recht op een WGA-uitkering</titel></kop>
<lid><lidnr>1</lidnr>
<al>Indien op de dag, bedoeld in artikel 54, tweede lid, geen recht op een WGA-uitkering is ontstaan, ontstaat het recht:</al>
<lijst><li><li.nr>a.</li.nr>
<al>recht had op een arbeidsongeschiktheidsuitkering;</al></li></lijst></lid>
<lid><lidnr>2</lidnr>
<al>Het recht op een WGA-uitkering ontstaat niet indien &#233;&#233;n uitsluitingsgrond zich voordoet.</al></lid>
</artikel></hoofdstuk></wettekst></wet-besluit></wetgeving></toestand>`;

function xml(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
}

describe("bwb-artikel helpers", () => {
  it("normalizes article numbers", () => {
    expect(normalizeArtikelNr("Artikel 55")).toBe("55");
    expect(normalizeArtikelNr("art. 7:658")).toBe("7:658");
  });

  it("finds exactly the requested article and renders readable text", () => {
    const hits = findArtikelen(TOESTAND_XML, "55");
    expect(hits).toHaveLength(1);
    expect(hits[0].pad).toBe("/Hoofdstuk7/Paragraaf7.1/Artikel55");
    const { kop, tekst } = artikelXmlToText(hits[0].xml);
    expect(kop).toBe("Artikel 55 Later ontstaan van het recht op een WGA-uitkering");
    expect(tekst).toContain("1. Indien op de dag");
    expect(tekst).toContain("a. recht had op een arbeidsongeschiktheidsuitkering;");
    expect(tekst).toContain("2. Het recht op een WGA-uitkering ontstaat niet indien één uitsluitingsgrond");
    expect(tekst).not.toContain("Niet dit artikel");
  });
});

describe("BwbArtikelSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolves the toestand via SRU and returns the article with links", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).includes("zoekservice.overheid.nl") ? xml(SRU_XML) : xml(TOESTAND_XML),
    );
    vi.stubGlobal("fetch", fetchMock);

    const src = new BwbArtikelSource(config);
    const out = await src.getArtikel({ bwbId: "bwbr0019057", artikel: "55", datum: "2026-09-29" });

    expect(out.total).toBe(1);
    const a = out.items[0];
    expect(a.label_id).toBe("7587404");
    expect(a.titel_regeling).toBe("Wet werk en inkomen naar arbeidsvermogen");
    expect(a.wetten_url).toBe("https://wetten.overheid.nl/BWBR0019057/2026-07-01/0/Hoofdstuk7/Paragraaf7.1/Artikel55");
    expect(a.lido_tekst_url).toContain("label-id=7587404");
    expect(a.tekst).toContain("WGA-uitkering");
  });

  it("rejects an invalid BWB id", async () => {
    const src = new BwbArtikelSource(config);
    await expect(src.getArtikel({ bwbId: "WIA", artikel: "55" })).rejects.toThrow(/Ongeldig BWB-id/);
  });
});
