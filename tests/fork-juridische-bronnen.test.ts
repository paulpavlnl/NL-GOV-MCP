/**
 * FORK (docs/FORK.md) — PUC uitvoeringsinformatie, ACOI Woo-jurisprudentie, ANBI register.
 */
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import {
  acoiGrond, acoiInstantie, htmlNaarTekst, parseAcoiHtml, parseAnbiXml, parsePucDocument, parsePucZoek, pucZoekUrl, unzipEersteXml, zoekAnbi,
} from "../src/fork/juridische-bronnen.js";
import { htmlResponse, jsonResponse } from "./helpers/config.js";

afterEach(() => { vi.unstubAllGlobals(); clearHttpCache(); });

const PUC_ZOEK = `<html><body><div class="resultaat"><p>1 t/m 20 van 78 voor: "kinderbijslag buitenland"</p><ul>
<li><a href="/svb/doc/PUC_818085_20/1"><span class="titel">Dubbele kinderbijslag voor uitwonende kinderen (SB1414)</span><span class="fragment">... beroepsopleiding in het buitenland Er kan recht zijn op dubbele kinderbijslag ...</span>
<span class="meta">Beleidsregel niet in wetten.nl - Sociale Verzekeringsbank Kenmerk: SB1414, 2024 Beschikbaar: <strong>29-11-2024</strong> <strong>Geldig vandaag:</strong> van <strong>28-11-2024</strong></span></a><a href="/svb/doc/PUC_818085_20/1">samenvatting</a></li>
<li><a href="/svb/doc/PUC_746787_20/1">HvJ EG 22 oktober 2015, zaak C-378/14 (Trapkowski) ... persoon recht heeft op kinderbijslag ... Officiële uitspraak Kenmerk: ECLI:EU:C:2015:720, C-378/14 Uitspraakdatum: <b>22-10-2015</b> Beschikbaar: <b>18-09-2019</b></a></li>
</ul></div></body></html>`;

const PUC_DOC = `<html><body><nav><a href="/svb/">Home</a></nav><h1>Verlaging of intrekking van de uitkering (SB1407)</h1>
<div>Dit onderwerp bevat de volgende rubrieken.</div><a href="#x">Maak een PDF</a>
<h2>Inleiding</h2><p>Deze beleidsregel gaat over het moment waarop een uitkering wordt verlaagd.</p><a href="#">Permanente link</a>
<h3>AKW</h3><p>Bij een wijziging op de peildatum past de SVB de kinderbijslag aan.</p>
<ul><li>AKW: <a href="https://wetten.overheid.nl/jci1.3:c:BWBR0002368&amp;hoofdstuk=III&amp;paragraaf=2&amp;artikel=14a">artikel 14a</a></li>
<li><a href="https://zoek.officielebekendmakingen.nl/stcrt-2024-38526.html">Wijzigingsbesluit Beleidsregels SVB november 2024</a></li></ul>
<p>Uitlooptermijn volgt uit <a href="http://deeplink.rechtspraak.nl/uitspraak?id=ECLI:NL:CRVB:1999:AA8620">ECLI:NL:CRVB:1999:AA8620</a>.</p>
<h2>Bijlagen</h2><h2>Informatietype en toegang</h2><div>Informatietype Informatie voor uitvoering Documentsoort Beleidsregel niet in wetten.nl Toegangsrechten Extern</div>
<h2>Identificatie, datum en versie</h2><div>Identificatie PUC_811677_20 Versie 4 Datum beschikbaarheid 01-04-2026 Geldigheid van 01-04-2026 tot en met Wijzigingsdatum 01-04-2026</div>
<h2>Herkomst en taal</h2><div>Titel Verlaging (SB1407)Organisatie<a href="/zoeken/resultaat/org/SVB">Sociale Verzekeringsbank</a>Taal Nederlands Beleidsregelnummer SB1407 Jaargang 2026</div></body></html>`;

const ACOI_HTML = `<article class="mediamonitor-item" data-filterdata="{&#34;id&#34;:11916}"><div class="mediamonitor-item__header"><h3 class="mediamonitor-item__title">ECLI:NL:RVS:2026:4415</h3><div class="mediamonitor-item__when">Datum uitspraak: 29 juli 2026</div></div>` +
  `<div class="mediamonitor-item__description"><p class="normal">B en W Tilburg, inzage in adresonderzoek.</p><p class="normal">College had het verzoek moeten aanmerken als verzoek ex 5.5 Woo.</p></div>` +
  `<div class="b"><a href="https://woo-wijzer.acoi.nl/jurisprudentie-database/!/ecli-nl-rvs-2026-4415/">Bekijk details</a><a href="https://uitspraken.rechtspraak.nl/details?id=ECLI:NL:RVS:2026:4415">Naar uitspraak</a></div></article>`;

const ANBI_XML = `<?xml version="1.0" encoding="ISO-8859-1"?><publicatieAnbiInstellingen><header><aanmaakDatum>2026-10-12</aanmaakDatum></header>
<beschikking><dossierNummer>10</dossierNummer><naam>Stichting Muziek &amp; Zorg</naam><vestigingsPlaats>DORDRECHT</vestigingsPlaats><fiscaalNummer>812345678</fiscaalNummer><ingangsDatum>2015-01-01</ingangsDatum><ingangsDatumCultuur>2016-01-01</ingangsDatumCultuur></beschikking>
<beschikking><dossierNummer>11</dossierNummer><naam>Stichting   Oud Goed</naam><vestigingsPlaats>Utrecht</vestigingsPlaats><fiscaalNummer>001234567</fiscaalNummer><ingangsDatum>2008-01-01</ingangsDatum><eindDatum>2020-12-31</eindDatum><intrekkingsDatum>2020-12-31</intrekkingsDatum></beschikking>
</publicatieAnbiInstellingen>`;

/** A minimal zip with one deflated entry. */
function zip(name: string, content: string): Uint8Array {
  const data = deflateRawSync(Buffer.from(content, "latin1"));
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(0, 42);
  const cdStart = 30 + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + nameBuf.length, 12); eocd.writeUInt32LE(cdStart, 16);
  return new Uint8Array(Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]));
}

describe("PUC", () => {
  it("builds PUC's own search URLs", () => {
    expect(pucZoekUrl({ portaal: "svb", zoekterm: "kinderbijslag buitenland", pagina: 2, geldigVandaag: true, sorteer: "datum" }))
      .toBe("https://puc.overheid.nl/svb/zoeken/resultaat/q/kinderbijslag-wt_buitenland/p/2/gdlv/1/s/datumdocument-wt_desc/");
    expect(pucZoekUrl({ zoekterm: "art. 4:84 Awb" })).toBe("https://puc.overheid.nl/zoeken/resultaat/q/art.-wt_4%3A84-wt_Awb/p/1/");
  });

  it("parses result pages: title, kenmerk, dates, document type, organisation; skips 'samenvatting' links", () => {
    const r = parsePucZoek(PUC_ZOEK);
    expect(r.totaal).toBe(78);
    expect(r.treffers).toHaveLength(2);
    expect(r.treffers[0]).toMatchObject({ id: "PUC_818085_20", versie: "1", titel: "Dubbele kinderbijslag voor uitwonende kinderen (SB1414)", soort: "Beleidsregel niet in wetten.nl", organisatie: "Sociale Verzekeringsbank", kenmerk: "SB1414, 2024", beschikbaar: "29-11-2024", geldig_vanaf: "28-11-2024", url: "https://puc.overheid.nl/svb/doc/PUC_818085_20/1" });
    expect(r.treffers[1]).toMatchObject({ id: "PUC_746787_20", datum: "22-10-2015", kenmerk: "ECLI:EU:C:2015:720, C-378/14" });
  });

  it("reads a document: text without page furniture, metadata, relations", () => {
    const d = parsePucDocument(PUC_DOC, "PUC_811677_20");
    expect(d.titel).toBe("Verlaging of intrekking van de uitkering (SB1407)");
    expect(d.tekst).toContain("past de SVB de kinderbijslag aan");
    expect(d.tekst).not.toMatch(/Permanente link|Informatietype|Home/);
    expect(d).toMatchObject({ versie: "4", geldigheid: "van 01-04-2026 tot en met", documentsoort: "Beleidsregel niet in wetten.nl", organisatie: "Sociale Verzekeringsbank", kenmerk: "SB1407" });
    expect(d.relaties.map((r) => r.soort)).toEqual(["wet", "bekendmaking", "rechtspraak"]);
    expect(d.relaties[0].url).toContain("jci1.3:c:BWBR0002368&hoofdstuk=III");
  });

  it("puc_zoeken answers over MCP", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(PUC_ZOEK)));
    const out = await call("puc_zoeken", { zoekterm: "kinderbijslag buitenland", portaal: "svb" });
    expect(out.records[0].title).toContain("SB1414");
    expect(out.provenance.endpoint).toContain("/svb/zoeken/resultaat/q/kinderbijslag-wt_buitenland/p/1/gdlv/1/");
  });
});

describe("ACOI Woo-jurisprudentie", () => {
  it("maps courts and refusal grounds to the site's codes", () => {
    expect(acoiInstantie("Raad van State")).toBe("6599");
    expect(acoiInstantie("rechtbank")).toBe("6603");
    expect(acoiInstantie("kantonrechter")).toBeNull();
    expect(acoiGrond("5.1 lid 2 e")).toBe("512e-persoonlijke-levenssfeer");
    expect(acoiGrond("art. 5.2 lid 1 Woo")).toBe("521-pers-beleidsopvattingen-intern-beraad");
    expect(acoiGrond("5.3")).toBe("53-verzwaarde-motivering");
    expect(acoiGrond("persoonlijke levenssfeer")).toBe("512e-persoonlijke-levenssfeer");
    expect(acoiGrond("onzin")).toBeNull();
  });

  it("parses the result HTML and calls SearchJurisprudentie with the site's filter shape", async () => {
    expect(parseAcoiHtml(ACOI_HTML)[0]).toMatchObject({ ecli: "ECLI:NL:RVS:2026:4415", datum: "29 juli 2026", uitspraak_url: "https://uitspraken.rechtspraak.nl/details?id=ECLI:NL:RVS:2026:4415" });
    let body: { method: string; params: [Record<string, unknown>] } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return jsonResponse({ error: null, id: 1, result: { totalcount: 36, resultshtml: ACOI_HTML, filtercounts: [{ items: [{ id: 6599, results: 10 }] }] } }); }));
    const out = await call("woo_jurisprudentie_zoeken", { zoekterm: "adres", instantie: "Raad van State", weigeringsgrond: "5.1 lid 2 e", pagina: 2 });
    expect(body!.method).toBe("SearchJurisprudentie");
    expect(body!.params[0]).toMatchObject({ query: "adres", instantie: ["6599"], uitzonderingsgrond: "512e-persoonlijke-levenssfeer", page: 1, sorteer: "recent" });
    expect(out.summary).toContain("36 uitspraken");
    expect(out.records[0].title).toBe("ECLI:NL:RVS:2026:4415");
  });
});

describe("ANBI register", () => {
  it("unzips, parses and finds on name, RSIN and place with the status on a reference date", () => {
    const xml = new TextDecoder("latin1").decode(unzipEersteXml(zip("anbi.xml", ANBI_XML)));
    const reg = parseAnbiXml(xml);
    expect(reg.aangemaakt).toBe("2026-10-12");
    expect(reg.instellingen[0].naam).toBe("Stichting Muziek & Zorg");
    expect(reg.instellingen[1].naam).toBe("Stichting Oud Goed");
    expect(zoekAnbi(reg.instellingen, { naam: "muziek zorg", peildatum: "2026-01-01" }, 5).items[0].status).toBe("ANBI op 2026-01-01; culturele ANBI");
    expect(zoekAnbi(reg.instellingen, { rsin: "1234567", peildatum: "2024-06-01" }, 5).items[0].status).toBe("geen ANBI meer (sinds 2020-12-31)");
    expect(zoekAnbi(reg.instellingen, { rsin: "1234567", peildatum: "2019-06-01" }, 5).items[0].status).toBe("ANBI op 2019-06-01");
    expect(zoekAnbi(reg.instellingen, { naam: "stichting", plaats: "dordrecht" }, 5).totaal).toBe(1);
  });

  it("anbi_zoeken downloads the register once and answers over MCP", async () => {
    const fetch = vi.fn(async () => new Response(Buffer.from(zip("anbi.xml", ANBI_XML)) as unknown as BodyInit, { status: 200, headers: { "content-type": "application/zip" } }));
    vi.stubGlobal("fetch", fetch);
    const out = await call("anbi_zoeken", { naam: "Oud Goed", peildatum: "2025-01-01" });
    expect(out.records[0].snippet).toContain("geen ANBI meer");
    await call("anbi_zoeken", { rsin: "812345678" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps block structure when converting HTML", () => {
    expect(htmlNaarTekst("<p>a&amp;b</p><p>c <b>d</b></p>")).toBe("a&b\nc d");
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
