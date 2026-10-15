/**
 * FORK (docs/FORK.md) — rulings outside rechtspraak.nl: Raad van State search, College voor de
 * Rechten van de Mens, Onderwijsgeschillen, De Geschillencommissie, Raad van Arbitrage, MfN.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { documentTekst, formFacetten, kiesFacet, parseCrmLijst, parseGcLijst, parseMfnLijst, parseRvaLijst, parseRvsLijst } from "../src/fork/geschilbeslechting.js";
import { htmlResponse, jsonResponse } from "./helpers/config.js";

afterEach(() => { vi.unstubAllGlobals(); clearHttpCache(); });

const RVS = `<p>aantal resultaten: 18</p><fieldset><legend>Rechtsgebied</legend><ul><li><div class="facet"><input type="checkbox" name="Zoe_Selected_facet:Rechtsgebied" id="facet-rechtsgebied_36" value="36"><label for="facet-rechtsgebied_36">Asiel (23.610)</label></div>
<li><div class="facet"><input type="checkbox" name="Zoe_Selected_facet:Rechtsgebied" id="facet-rechtsgebied_83" value="83"><label for="facet-rechtsgebied_83">Bewaring (11.382)</label></div></ul></fieldset>
<h2><a class="siteLink" href="https://www.raadvanstate.nl/uitspraken/@161248/202403518-1-a3/">202403518/1/A3</a></h2><div class="grid-inside"><div class="entry"><div class="summary"><p>Bij besluit van 31 juli 2023 heeft de burgemeester van Heerlen het pand gesloten.</p></div>
<dl><dt>ECLI<dd>ECLI:NL:RVS:2026:6065<dt>Datum uitspraak<dd>14 oktober 2026</dl><div class="tags"><ul class="trefwoorden"><li>Hoger beroep<li>Openbare orde</ul></div></div></div>
<h2><a class="siteLink" href="https://www.raadvanstate.nl/uitspraken/@161347/202504710-1-a3/#highlight=x">202504710/1/A3</a></h2><div class="summary"><p>Tweede zaak.</p></div><dl><dt>ECLI<dd>ECLI:NL:RVS:2026:6098<dt>Datum uitspraak<dd>14 oktober 2026</dl>`;

const CRM = `<form data-searchresultscount="600"><input type="checkbox" id="Discriminatiegronden3" name="Discriminatiegronden" value="f6eeef49-5f29" ><label for="Discriminatiegronden3">Geslacht </label>
<input type="checkbox" id="Discriminatiegronden4" name="Discriminatiegronden" value="dede88d9-ef20" ><label for="Discriminatiegronden4">Handicap of chronische ziekte</label></form>
<a href="/oordeel/2026-122/1b69a43d-3cab-42c6-9146-fe09c25e80f0"> <h3> BoFit B.V. discrimineert een vrouw niet </h3> <p> &#8230; vanwege haar zwangerschap </p> <p class="meta"> Oordeelnummer 2026-122 <span>| <time datetime="2026-09-02T22:00:00">02-09-2026</time></span> </p> </a>`;

const GC = `<h4 class="results-count">U ziet 1-10 van de 2 uitspraken</h4><article><h4><a href="https://www.degeschillencommissie.nl/uitspraken/klacht-over-beschadigd-keukenblad/">Klacht over beschadigd keukenblad ongegrond verklaard</a></h4>
<p class="uitspraken-info"><strong>Commissie:</strong> Wonen &nbsp;&nbsp; <strong>Categorie:</strong> (non)conformiteit &nbsp;&nbsp; <strong>Jaartal:</strong> 2025 <br> <strong>Soort uitspraak:</strong> Bindend Advies&nbsp;&nbsp; <strong>Uitkomst:</strong> ongegrond&nbsp;&nbsp; <strong>Referentiecode:</strong> 267444/422677 </p>
<p>Waar gaat de uitspraak over? Een consument klaagde over een keukenblad [&hellip;]</p></article>
<select name="tax_category"><option value="">Selecteer commissie</option><option value="wonen">Wonen</option><option value="reizen">Reizen</option></select>`;

const RVA = `<script>setData("searchResultsPage", '{"totalResults":2, "linkAdd": "|search=meerwerk", "results": [{"id" : 1, "pdfUrl":"jurisprudentie/2025/37735at.pdf", "pdfName" : "37735atvvv"},{"id" : 2, "pdfUrl":"jurisprudentie/2025/72297av.pdf", "pdfName" : "72297avvvv"}]}');</script>
<p class='zoekenResultaat' data-rank='1000'><a href='#' onclick='return false;' data-id='1' class=' pdfWepViewer'  target='_blank'>RvA eerste aanleg | 37.735 | <span class='searchDate'>20-08-2025</span></a><br /><span class='searchTxt'>Essentie: Tussenvonnis. Betonvloeren en meerwerk.</span>
<p class='zoekenResultaat' data-rank='1000'><a href='#' onclick='return false;' data-id='2' class=' pdfWepViewer'  target='_blank'>RvA hoger beroep | 72.297 | <span class='searchDate'>29-07-2025</span></a><br /><span class='searchTxt'>Essentie: Schade aan winkelpand.</span>`;

const MFN = `<p>Toon resultaten (50)</p><p>50 resultaten</p><div class="outer wall-item"><div class="inner wall-item-inner"><a class="item-link" href="https://www.mfn-tuchtrechtupdates.nl/samenvatting/mtr-2026-0012"><div class="left"><h4 class="type">Uitspraak</h4><p class="date">B-2025-4</p></div><div class="right"><h3>Toetsing vertrouwelijkheidsnormen</h3>Mediation bij be&amp;euml;indiging relatie...<div class="details"><span class="creator item-details-important">College van Beroep (tweede aanleg)</span>, 27-02-2026</div></div></a></div></div>`;

describe("parsers", () => {
  it("Raad van State: zaaknummer, ECLI, datum, trefwoorden, samenvatting; facetten op naam", () => {
    const r = parseRvsLijst(RVS);
    expect(r.totaal).toBe(18);
    expect(r.items[0]).toMatchObject({ zaaknummer: "202403518/1/A3", ecli: "ECLI:NL:RVS:2026:6065", datum: "14 oktober 2026", trefwoorden: ["Hoger beroep", "Openbare orde"] });
    expect(r.items[1].url).toBe("https://www.raadvanstate.nl/uitspraken/@161347/202504710-1-a3/");
    const f = formFacetten(RVS, "Zoe_Selected_facet:Rechtsgebied");
    expect(f).toEqual([{ value: "36", label: "Asiel", aantal: 23610 }, { value: "83", label: "Bewaring", aantal: 11382 }]);
    expect(kiesFacet(f, "bewaring")?.value).toBe("83");
    expect(kiesFacet(f, "asi")?.value).toBe("36");
    expect(kiesFacet(f, "bouwen")).toBeNull();
  });

  it("CRM, Geschillencommissie, Raad van Arbitrage en MfN", () => {
    expect(parseCrmLijst(CRM)).toMatchObject({ totaal: 600, items: [{ nummer: "2026-122", datum: "2026-09-02", titel: "BoFit B.V. discrimineert een vrouw niet", url: "https://oordelen.mensenrechten.nl/oordeel/2026-122/1b69a43d-3cab-42c6-9146-fe09c25e80f0" }] });
    expect(kiesFacet(formFacetten(CRM, "Discriminatiegronden"), "geslacht")?.value).toBe("f6eeef49-5f29");
    expect(parseGcLijst(GC).items[0]).toMatchObject({ commissie: "Wonen", categorie: "(non)conformiteit", jaar: "2025", soort: "Bindend Advies", uitkomst: "ongegrond", referentie: "267444/422677" });
    expect(parseGcLijst(GC).totaal).toBe(2);
    const rva = parseRvaLijst(RVA);
    expect(rva.totaal).toBe(2);
    expect(rva.items[1]).toMatchObject({ bron: "RvA hoger beroep", geschilnummer: "72.297", datum: "29-07-2025", essentie: "Schade aan winkelpand.", pdf: "https://www.raadvanarbitrage.info/raad-van-arbitrage-info/_sitefiles/file/jurisprudentie/2025/72297av.pdf" });
    expect(parseMfnLijst(MFN)).toMatchObject({ totaal: 50, items: [{ soort: "Uitspraak", zaaknummer: "B-2025-4", titel: "Toetsing vertrouwelijkheidsnormen", instantie: "College van Beroep (tweede aanleg)", datum: "27-02-2026" }] });
    expect(parseMfnLijst(MFN).items[0].fragment).toContain("beëindiging");
  });

  it("documenttekst: titel en blokken, zonder navigatie", () => {
    const d = documentTekst(`<nav>Menu</nav><main><h1>Oordeel 2026-122</h1><p>6.1 Het College stelt vast.</p><p>6.2 Het College oordeelt.</p></main>`);
    expect(d.titel).toBe("Oordeel 2026-122");
    expect(d.tekst).toBe("Oordeel 2026-122\n6.1 Het College stelt vast.\n6.2 Het College oordeelt.");
  });
});

describe("tools over MCP", () => {
  it("raadvanstate_zoeken zet het facet om naar de waarde van de site", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => { const u = String(input instanceof Request ? input.url : input); urls.push(u); return htmlResponse(RVS); }));
    const out = await call("raadvanstate_zoeken", { rechtsgebied: "bewaring", jaar: "2025" });
    const q = new URL(urls.at(-1)!).searchParams;
    expect(q.get("Zoe_Selected_facet:Rechtsgebied")).toBe("83");
    expect(q.get("kalenderjaar")).toBe("2025");
    expect(out.records[0].title).toBe("202403518/1/A3 (ECLI:NL:RVS:2026:6065)");
    expect(out.access_note).toContain("rechtspraak_get_by_ecli");
  });

  it("crm_oordelen_zoeken zoekt op oordeelnummer via Nummer en Jaar", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => { urls.push(String(input instanceof Request ? input.url : input)); return htmlResponse(CRM); }));
    await call("crm_oordelen_zoeken", { nummer: "2026-122" });
    const q = new URL(urls.at(-1)!).searchParams;
    expect([q.get("Nummer"), q.get("Jaar")]).toEqual(["122", "2026"]);
  });

  it("onderwijsgeschillen_zoeken filtert op type en jaar via Algolia", async () => {
    let body: { facetFilters?: string[][]; query?: string } = {};
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return jsonResponse({ nbHits: 1, hits: [{ title: "Verwijdering", link: "https://www.onderwijsgeschillen.nl/uitspraken/x/", date: "1788220800", year: "2026", acf: { pub_number: "136526" }, terms: { commission_tax: { names: ["GPO"] } } }], facets: {} }); }));
    const out = await call("onderwijsgeschillen_zoeken", { zoekterm: "verwijdering", jaar: "2026" });
    expect(body.facetFilters).toEqual([["type.name:Verdicts"], ["year:2026"]]);
    expect(out.records[0]).toMatchObject({ title: "Verwijdering", date: "2026-09-01" });
  });

  it("geschil_uitspraak_get leest alleen de bekende sites en verwijst RvS naar rechtspraak.nl", async () => {
    expect((await call("geschil_uitspraak_get", { url: "https://example.com/x" })).message).toContain("Alleen links van");
    expect((await call("geschil_uitspraak_get", { url: "https://www.raadvanstate.nl/uitspraken/@1/x/" })).suggestion).toContain("rechtspraak_get_by_ecli");
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const server = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
    return JSON.parse(res.content[0].text);
  } finally { await client.close(); await server.close(); }
}
