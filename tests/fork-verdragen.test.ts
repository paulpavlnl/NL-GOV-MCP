/**
 * FORK (docs/FORK.md) — treaties: Verdragenbank (SRU, site search, XML record) and HCCH.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { hcchArtikel, parseHcchLijst, parseHcchSecties, parseHcchSectie, parseHcchVerdrag, parseVerdragenLijst, parseVerdragenSru, parseVerdragXml, verdragsnummer } from "../src/fork/verdragen.js";
import { htmlResponse } from "./helpers/config.js";

afterEach(() => { vi.unstubAllGlobals(); clearHttpCache(); });

const XML = `<Verdragenbank xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <meta><owmskern><dcterms:identifier>009051</dcterms:identifier><dcterms:title>Verdrag tot afschaffing van het vereiste van legalisatie van buitenlandse openbare akten</dcterms:title><dcterms:creator scheme="overheid:Ministerie">Ministerie van Justitie en Veiligheid</dcterms:creator><dcterms:modified>2026-07-21</dcterms:modified></owmskern>
  <owmsmantel><Goedkeuringswet><dcterms:isPartOf resourceIdentifier="https://zoek.officielebekendmakingen.nl/stb-1965-104.html">1965, 104</dcterms:isPartOf></Goedkeuringswet>
  <Tractatenbladen><Tractatenblad><TractatenbladText>1963, 28</TractatenbladText><Omschrijving>Fr, En; vert. Ne</Omschrijving></Tractatenblad><Tractatenblad><TractatenbladText>1965, 182</TractatenbladText><Omschrijving>goedkeuring; inwerkingtreding</Omschrijving></Tractatenblad></Tractatenbladen>
  <Verdragstekst><dcterms:isPartOf resourceIdentifier="https://wetten.overheid.nl/BWBV0002030">0002030</dcterms:isPartOf></Verdragstekst><dcterms:subject>Burgerlijke stand</dcterms:subject><dcterms:abbreviation>IPR 12 Apostilleverdrag</dcterms:abbreviation></owmsmantel>
  <verdragipm><sluitingsDatum>1961-10-05</sluitingsDatum><sluitingsPlaats>'s-Gravenhage</sluitingsPlaats><voorlopigeToepassingDatum xsi:nil="true" /><inwerkingtredingDatum>1965-01-24</inwerkingtredingDatum><uitwerkingtredingDatum xsi:nil="true" /><isNLDepositair>true</isNLDepositair><isHaagseConferentiePrivaatrecht>true</isHaagseConferentiePrivaatrecht><verdragType>Multilateraal</verdragType><verdragStatus>Totstandgekomen</verdragStatus></verdragipm></meta>
  <body><verdrag><Opmerking>Het Verdrag gold voor de Nederlandse Antillen vanaf 30-04-1967 tot 10-10-2010.</Opmerking>
  <Koninkrijksdelen><Koninkrijksdeel><NaamKoninkrijksdeel>Nederland (in Europa)</NaamKoninkrijksdeel><DatumVoorlopigeToepassing xsi:nil="true" /><DatumInwerkingtreding>1965-10-08</DatumInwerkingtreding><DatumBuitenwerkingtreding xsi:nil="true" /></Koninkrijksdeel></Koninkrijksdelen>
  <Partijen><Partij><NaamPartij>Albanië</NaamPartij><DatumOndertekenning xsi:nil="true" /><DatumRatificatie>2003-09-03</DatumRatificatie><DatumInwerkingtreding>2004-05-09</DatumInwerkingtreding><DatumOpzegging xsi:nil="true" /><TypeInstemming>T</TypeInstemming><IsVoorbehoud>false</IsVoorbehoud><IsBezwaar>false</IsBezwaar><Voorbehouden /></Partij>
  <Partij><NaamPartij>Argentinië</NaamPartij><DatumRatificatie>1987-05-08</DatumRatificatie><DatumInwerkingtreding>1988-02-18</DatumInwerkingtreding><TypeInstemming>T</TypeInstemming><IsVoorbehoud>true</IsVoorbehoud><IsBezwaar>false</IsBezwaar><Voorbehouden><Voorbehoud><DatumVoorbehoud>1987-05-08</DatumVoorbehoud><TekstVoorbehoud>The Republic of Argentina objects to the extension of the application of the Convention to the Malvinas.</TekstVoorbehoud><BezwarenVoorbehoud><BezwaarVoorbehoudPartij><PartijBezwaarVoorbehoud>Verenigd Koninkrijk</PartijBezwaarVoorbehoud><DatumBezwaarVoorbehoud>1987-08-27</DatumBezwaarVoorbehoud><TekstBezwaarVoorbehoud>The United Kingdom rejects the statement.</TekstBezwaarVoorbehoud></BezwaarVoorbehoudPartij></BezwarenVoorbehoud></Voorbehoud></Voorbehouden></Partij></Partijen>
  <DepositaireGegevens><BezwarenToetreding><BezwaarToetreding><BezwaarTegenPartij>Albanië</BezwaarTegenPartij><BezwaarDoor><BezwaarDoorPartij>België</BezwaarDoorPartij><DatumBezwaarToetreding>2004-03-05</DatumBezwaarToetreding><DatumIntrekkenBezwaarToetreding>2015-12-21</DatumIntrekkenBezwaarToetreding><OpmerkingBezwaarToetreding>Belgium declares that the Convention will not take effect between Albania and Belgium.</OpmerkingBezwaarToetreding></BezwaarDoor></BezwaarToetreding></BezwarenToetreding>
  <Autoriteiten><Autoriteit><PartijAutoriteit>Albanië</PartijAutoriteit><MededelingAutoriteit><DatumAutoriteit>2003-09-03</DatumAutoriteit><TekstAutoriteit>Central Authority: the Consular Department of the Ministry of Foreign Affairs will be the competent authority for issuing the certificate.</TekstAutoriteit></MededelingAutoriteit></Autoriteit></Autoriteiten>
  <DepositaireNotificaties><Notificatie><DatumNotificatie>2026-07-21</DatumNotificatie><TitelNotificatie>Legalisation No. 16/2026 (Germany withdrawal objection accession Moldova)</TitelNotificatie><Bestandsnaam>009051_Notificaties_278.pdf</Bestandsnaam></Notificatie></DepositaireNotificaties></DepositaireGegevens></verdrag></body></Verdragenbank>`;

const SRU = `<sru:searchRetrieveResponse><sru:numberOfRecords>7</sru:numberOfRecords><sru:records><sru:record><sru:recordData><gzd:gzd><gzd:originalData><overheidwetgeving:meta><overheidwetgeving:owmskern><dcterms:identifier>009051</dcterms:identifier><dcterms:title xml:lang="nl">Verdrag tot afschaffing van het vereiste van legalisatie van buitenlandse openbare akten</dcterms:title></overheidwetgeving:owmskern><overheidwetgeving:owmsmantel><dcterms:isPartOf>trb-1963-28</dcterms:isPartOf><dcterms:isPartOf>trb-1965-182</dcterms:isPartOf><dcterms:subject xml:lang="nl">Burgerlijke stand</dcterms:subject><dcterms:abbreviation>IPR 12 Apostilleverdrag</dcterms:abbreviation></overheidwetgeving:owmsmantel></overheidwetgeving:meta></gzd:originalData></gzd:gzd></sru:recordData></sru:record></sru:records></sru:searchRetrieveResponse>`;

const LIJST = `<h1 class="h1 h1--large">Zoekresultaten&nbsp;<span class="h1__sub">1-2 van de 6 verdragen</span></h1><div class="result--list result--list--wide"> <ul> <li class="item"> <div class="item-header"> <h2 class="result--title "><a href="/nl/Verdrag/Details/009051">Verdrag tot afschaffing van het vereiste van legalisatie van buitenlandse openbare akten</a></h2> </div> <p>'s-Gravenhage, 05-10-1961</p> </li>
<li class="item"> <div class="item-header"> <h2 class="result--title "><a href="/nl/Verdrag/Details/001097">Verdrag betreffende de afschaffing van de legalisatie van akten in de Lid-Staten van de Europese Gemeenschappen</a></h2> </div> <p>Brussel, 25-05-1987</p> </li></ul></div>`;

const HCCH_LIJST = `<ul><li><a href="/en/instruments/conventions/full-text/?cid=41">Convention of 5 October 1961 Abolishing the Requirement of Legalisation for Foreign Public Documents</a></li>
<li><a href="/en/instruments/conventions/full-text/?cid=24">Convention of 25 October 1980 on the Civil Aspects of International Child Abduction</a></li><li><a href="/en/instruments/conventions/full-text/?cid=24">Full text</a></li></ul>`;

const HCCH_VERDRAG = `<main><h1>Full text</h1><p>12: Convention of 5 October 1961 Abolishing the Requirement of Legalisation for Foreign Public Documents</p><p>Entry into force:</p><p>24-I-1965</p><a href="https://assets.hcch.net/docs/b12ad529.pdf">Text of the Convention in PDF</a>
<p>CONVENTION ABOLISHING THE REQUIREMENT OF LEGALISATION FOR FOREIGN PUBLIC DOCUMENTS</p><p>(Concluded 5 October 1961)</p><p>The States signatory to the present Convention, desiring to abolish the requirement of diplomatic or consular legalisation for foreign public documents, have resolved to conclude a Convention to this effect.</p>
<p>Article 1</p><p>The present Convention shall apply to public documents which have been executed in the territory of one Contracting State and which have to be produced in the territory of another Contracting State.</p>
<p>Article 3</p><p>The only formality that may be required in order to certify the authenticity of the signature is the addition of the certificate described in Article 4.</p>
<p>Article 4</p><p>The certificate referred to in the first paragraph of Article 3 shall be placed on the document itself or on an "allonge".</p></main>`;

describe("parsers", () => {
  it("verdragsnummer uit nummer of link", () => {
    expect(verdragsnummer("009051")).toBe("009051");
    expect(verdragsnummer("9051")).toBe("009051");
    expect(verdragsnummer("https://verdragenbank.overheid.nl/nl/Verdrag/Details/009051_du.html")).toBe("009051");
    expect(verdragsnummer("https://repository.overheid.nl/frbr/vd/009051/1/xml-nl/009051.xml")).toBe("009051");
    expect(verdragsnummer("Apostilleverdrag")).toBeNull();
  });

  it("XML: algemeen, koninkrijksdelen, Tractatenblad, BWBV, partijen met voorbehoud en bezwaar, autoriteiten, notificaties", () => {
    const v = parseVerdragXml(XML)!;
    expect(v).toMatchObject({ verdragsnummer: "009051", afkorting: "IPR 12 Apostilleverdrag", onderwerp: ["Burgerlijke stand"], inwerkingtreding: "1965-01-24", nl_depositaris: true, haagse_conferentie: true, type: "Multilateraal" });
    expect(v.sluiting).toEqual({ datum: "1961-10-05", plaats: "'s-Gravenhage" });
    expect(v.verdragstekst).toEqual({ bwb_id: "BWBV0002030", url: "https://wetten.overheid.nl/BWBV0002030" });
    expect(v.goedkeuringswet?.url).toBe("https://zoek.officielebekendmakingen.nl/stb-1965-104.html");
    expect(v.tractatenblad[1]).toEqual({ vindplaats: "1965, 182", omschrijving: "goedkeuring; inwerkingtreding", url: "https://zoek.officielebekendmakingen.nl/trb-1965-182.html" });
    expect(v.koninkrijksdelen[0]).toMatchObject({ deel: "Nederland (in Europa)", inwerkingtreding: "1965-10-08" });
    expect(v.koninkrijksdelen[0].buitenwerkingtreding).toBeUndefined();
    expect(v.partijen[0]).toMatchObject({ partij: "Albanië", ratificatie: "2003-09-03", inwerkingtreding: "2004-05-09", voorbehoud: false });
    expect(v.partijen[0].ondertekening).toBeUndefined();
    expect(v.partijen[1].voorbehouden[0].bezwaren[0]).toMatchObject({ door: "Verenigd Koninkrijk", datum: "1987-08-27" });
    expect(v.bezwaren_toetreding[0]).toMatchObject({ tegen: "Albanië", door: [{ partij: "België", ingetrokken: "2015-12-21" }] });
    expect(v.autoriteiten[0].mededelingen[0].tekst).toContain("competent authority");
    expect(v.notificaties[0].url).toBe("https://repository.overheid.nl/frbr/vd/009051/1/pdf/009051_Notificaties_278.pdf");
  });

  it("SRU en resultatenlijst van de site", () => {
    expect(parseVerdragenSru(SRU)).toMatchObject({ totaal: 7, items: [{ verdragsnummer: "009051", afkorting: "IPR 12 Apostilleverdrag", onderwerp: ["Burgerlijke stand"], tractatenblad: ["trb-1963-28", "trb-1965-182"] }] });
    expect(parseVerdragenLijst(LIJST)).toMatchObject({ totaal: 6, items: [{ verdragsnummer: "009051", plaats: "'s-Gravenhage", datum: "1961-10-05" }, { verdragsnummer: "001097", plaats: "Brussel" }] });
  });

  it("HCCH: lijst zonder dubbelen, verdragstekst en één artikel", () => {
    expect(parseHcchLijst(HCCH_LIJST).map((i) => i.cid)).toEqual([41, 24]);
    const v = parseHcchVerdrag(HCCH_VERDRAG, 41);
    expect(v).toMatchObject({ nummer: 12, inwerkingtreding: "24-I-1965" });
    expect(v.titel).toContain("Abolishing the Requirement of Legalisation");
    expect(v.tekst.startsWith("CONVENTION ABOLISHING")).toBe(true);
    expect(v.links.statustabel).toBe("https://www.hcch.net/en/instruments/conventions/status-table/?cid=41");
    expect(hcchArtikel(v.tekst, "3")).toBe("Article 3\nThe only formality that may be required in order to certify the authenticity of the signature is the addition of the certificate described in Article 4.");
    expect(hcchArtikel(v.tekst, "art. 9")).toBeNull();
    expect(parseHcchSecties(`<a href="/en/instruments/conventions/specialised-sections/child-abduction">x</a><a href="/en/instruments/conventions/specialised-sections/apostille">y</a><a href="/en/instruments/conventions/specialised-sections/apostille">z</a>`)).toEqual(["child-abduction", "apostille"]);
    expect(parseHcchSectie(`<title>HCCH | Child Abduction Section</title><a href="/en/instruments/conventions/full-text/?cid=24">Full text</a><a href="/en/instruments/conventions/full-text/?cid=24">x</a>`, "child-abduction")).toEqual([{ cid: 24, titel: "Child Abduction Section (child abduction)", sectie: "https://www.hcch.net/en/instruments/conventions/specialised-sections/child-abduction", url: "https://www.hcch.net/en/instruments/conventions/full-text/?cid=24" }]);
  });
});

describe("tools over MCP", () => {
  it("verdrag_get met partij: voorbehouden, bezwaren, autoriteit van die partij; BWBV in de toelichting", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => { urls.push(String(input instanceof Request ? input.url : input)); return htmlResponse(XML); }));
    const out = await call("verdrag_get", { verdrag: "9051", partij: "albanie" });
    expect(urls[0]).toBe("https://repository.overheid.nl/frbr/vd/009051/1/xml-nl/009051.xml");
    const d = out.records[0].data;
    expect(d.partijen).toHaveLength(1);
    expect(d.autoriteiten[0].partij).toBe("Albanië");
    expect(d.bezwaren_toetreding).toHaveLength(1);
    expect(out.access_note).toContain("BWBV0002030");
    expect((await call("verdrag_get", { verdrag: "9051", partij: "Japan" })).message).toContain("geen partij");
  });

  it("verdragen_zoeken: vrije tekst via SRU, filters via de site", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const u = String(input instanceof Request ? input.url : input); urls.push(u);
      if (u.includes("/sru")) return htmlResponse(SRU);
      if (u.includes("ZoekUitgebreid?") || u.endsWith("ZoekUitgebreid")) return htmlResponse(`<input type="checkbox" name="topic" value="Personen- en familierecht"><input type="checkbox" name="party" value="Marokko">`);
      return htmlResponse(LIJST);
    }));
    const sru = await call("verdragen_zoeken", { zoekterm: "apostille" });
    expect(new URL(urls.at(-1)!).searchParams.get("query")).toBe('c.product-area==vd AND cql.textAndIndexes="apostille"');
    expect(sru.records[0].title).toContain("(IPR 12 Apostilleverdrag)");
    await call("verdragen_zoeken", { onderwerp: "familierecht", partij: "marokko", nl_depositaris: true });
    const q = new URL(urls.at(-1)!).searchParams;
    expect([q.get("topic"), q.get("party"), q.get("isNLDepositary")]).toEqual(["Personen- en familierecht", "Marokko", "True"]);
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
