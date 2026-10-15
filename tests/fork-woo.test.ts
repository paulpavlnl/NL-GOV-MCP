/**
 * FORK (docs/FORK.md) — Woo documents: woo_zoeken / woo_document_get (open.overheid.nl)
 * and woo_index (the Woo-index of the Register van Overheidsorganisaties, followed to the
 * bodies' own websites and the bekendmakingen searches it points to). Plus the small
 * lido_relaties fixes: Juriconnect input, '#' in CELLAR titles, filtered totals, no duplicate case law.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { wooDatum, wooDocumentId, wooPassages, wooRecords, wooZoekUrl, wooOrganisatieNamen } from "../src/fork/woo.js";
import { bekendmakingenCql, extractLinks, isVeiligeUrl, listEndpoints, matchesZoekterm, parseListPage, sruItems, volgLocatie } from "../src/fork/woo-index.js";
import { groepeerPerType, lidoRelaties, parseJci, schoneTitel, type LidoDocument } from "../src/fork/lido-relaties.js";
import { htmlResponse, jsonResponse, xmlResponse } from "./helpers/config.js";

afterEach(() => { vi.unstubAllGlobals(); clearHttpCache(); });

const WOO_JSON = {
  totaal: 2,
  resultaten: [
    { document: { id: "b6a4e445-5b95-4753-90c7-4d5aaf94fc81", pid: "https://open.overheid.nl/documenten/b6a4e445-5b95-4753-90c7-4d5aaf94fc81", titel: "Eerste deelbesluit op Woo-verzoek beslagen", omschrijving: "Besluit op een Woo-verzoek.", openbaarmakingsdatum: "2026-10-15", publisher: "ministerie van Buitenlandse Zaken" }, bestandsType: "application/pdf", aantalPaginas: 12, bestandsgrootte: "0.19 MB", highlightedText: "artikel 28 Rv" },
    { document: { id: "ronl-30eea600-30ee-4173-ae38-d75310dcb0d8_1", pid: "https://open.overheid.nl/documenten/ronl-30eea600-30ee-4173-ae38-d75310dcb0d8", titel: "Besluit afval", publisher: "gemeente Dordrecht" } },
  ],
  filters: { organisatie: [{ naam: "gemeente Dordrecht", aantal: 1 }, { naam: "ministerie van Buitenlandse Zaken", aantal: 5 }] },
};

describe("woo_zoeken / woo_document_get", () => {
  it("builds the open.overheid.nl query: dd-mm-jjjj dates, repeated organisatie, page size", () => {
    expect(wooDatum("2024-01-31")).toBe("31-01-2024");
    expect(wooDatum("1-2-2024")).toBe("01-02-2024");
    expect(wooDatum("januari")).toBeNull();
    expect(wooDatum(undefined)).toBeUndefined();
    const u = new URL(wooZoekUrl({ zoektekst: "beslag", organisatie: ["UWV", "gemeente Dordrecht"], van: "2024-01-01", tot: "31-12-2024", aantal: 50, start: 50 }));
    expect(u.searchParams.getAll("organisatie")).toEqual(["UWV", "gemeente Dordrecht"]);
    expect([u.searchParams.get("publicatiedatumVan"), u.searchParams.get("publicatiedatumTot"), u.searchParams.get("aantalResultaten"), u.searchParams.get("start")]).toEqual(["01-01-2024", "31-12-2024", "50", "50"]);
  });

  it("maps results to records with the downloadable id (version suffix dropped)", () => {
    const r = wooRecords(WOO_JSON);
    expect(r[0]).toMatchObject({ title: "Eerste deelbesluit op Woo-verzoek beslagen", date: "2026-10-15", snippet: "artikel 28 Rv" });
    expect(r[1].data?.document_id).toBe("ronl-30eea600-30ee-4173-ae38-d75310dcb0d8");
    expect(wooDocumentId("https://open.overheid.nl/documenten/oep-abc123def_1")).toBe("oep-abc123def");
    expect(wooDocumentId("../etc/passwd")).toBeNull();
    expect(wooOrganisatieNamen("Gemeente Dordrecht")).toEqual(["Gemeente Dordrecht", "gemeente Dordrecht"]);
  });

  it("returns passages around a search term", () => {
    const p = wooPassages("a\nb\nhet beslag is gelegd\nc\nd\ne\nnog een Beslag\nf", "beslag");
    expect(p).toEqual(["b\nhet beslag is gelegd\nc", "e\nnog een Beslag\nf"]);
  });

  it("woo_zoeken answers over MCP with facets in the access note", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(href);
      return jsonResponse(WOO_JSON);
    }));
    const out = await call("woo_zoeken", { zoektekst: "beslag", organisatie: "ministerie van Buitenlandse Zaken", van: "2024-01-01" });
    expect(out.records).toHaveLength(2);
    expect(out.access_note).toContain("gemeente Dordrecht");
    expect(new URL(urls[0]).searchParams.get("publicatiedatumVan")).toBe("01-01-2024");
  });
});

const UWV_LIST = `<html><body><nav><a href="/nl/contact">Contact</a></nav><mdgs-dynamic-list fetch-results="/api/overview/nl/wet-open-overheid/publicaties/woo-publicaties" per-page="10"></mdgs-dynamic-list></body></html>`;
const UWV_DETAIL = `<html><body><h1>Woo-besluit over gebruik van pasfoto's</h1><bgl-list-link link-id="x0" link-label="Woo-besluit 2026096 (PDF, 1 MB)" link-url="/assets-kai/files/09d9/woo-besluit-2026096.pdf" link-type="default"></bgl-list-link>` +
  `<bgl-list-link link-label="E-mails over gebruik pasfoto (PDF, 8 MB)" link-url="/assets-kai/files/e8c7/e-mails-over-gebruik -pasfoto.pdf"></bgl-list-link></body></html>`;
const page = (n: number, more: boolean) => ({
  meta: { cluster: { current: String(n), hasmore: more } },
  results: n === 1
    ? [{ id: 1, title: "Woo-besluit over gebruik van pasfoto's door UWV", url: "/nl/wet-open-overheid/woo-publicaties/2026/woo-besluit-gebruik-van-pasfotos-door-uwv", date: "2026-09-16T22:00:00Z", type: "WOO publicatie" },
      { id: 2, title: "Woo-besluit over Bemiddelingsservice (BMS)", url: "/nl/wet-open-overheid/woo-publicaties/2026/woo-besluit-bms", date: "2026-09-10T22:00:00Z", type: "WOO publicatie" }]
    : [{ id: 3, title: "Woo-besluit over WW-uitkeringen", url: "/nl/wet-open-overheid/woo-publicaties/2019/ww", date: "2019-03-03T00:00:00Z" }],
});
const SRU = `<?xml version="1.0"?><sru:searchRetrieveResponse xmlns:sru="http://docs.oasis-open.org/ns/search-ws/sruResponse" xmlns:gzd="http://standaarden.overheid.nl/sru" xmlns:ow="http://standaarden.overheid.nl/wetgeving/" xmlns:dcterms="http://purl.org/dc/terms/"><sru:numberOfRecords>4</sru:numberOfRecords><sru:records><sru:record><sru:recordData><gzd:gzd><gzd:originalData><ow:meta><ow:owmskern><dcterms:identifier>stcrt-2014-30765</dcterms:identifier><dcterms:title>Convenant Aziatische Horeca</dcterms:title><dcterms:type scheme="x">convenant</dcterms:type></ow:owmskern><ow:owmsmantel><dcterms:available>2014-10-31</dcterms:available></ow:owmsmantel></ow:meta></gzd:originalData><gzd:enrichedData><gzd:preferredUrl>https://zoek.officielebekendmakingen.nl/stcrt-2014-30765.html</gzd:preferredUrl></gzd:enrichedData></gzd:gzd></sru:recordData></sru:record></sru:records></sru:searchRetrieveResponse>`;
const OB_LINK = "https://zoek.officielebekendmakingen.nl/resultaten?q=((c.product-area==%22officielepublicaties%22)+AND+((dt.creator==%22Uitvoeringsinstituut+Werknemersverzekeringen%22))+AND+((dt.type==%22convenant%22)))";

describe("woo_index", () => {
  it("only follows public web addresses", () => {
    expect(isVeiligeUrl("https://www.uwv.nl/x")).toBe(true);
    for (const u of ["http://localhost/x", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest", "file:///etc/passwd", "http://intranet/", "http://svc.internal/", "https://u:p@www.uwv.nl/"]) expect(isVeiligeUrl(u)).toBe(false);
  });

  it("reads link lists, web-component attachment links and list endpoints", () => {
    expect(listEndpoints(UWV_LIST, "https://www.uwv.nl/nl/wet-open-overheid/publicaties/woo-publicaties")).toEqual(["https://www.uwv.nl/api/overview/nl/wet-open-overheid/publicaties/woo-publicaties"]);
    const docs = extractLinks(UWV_DETAIL, "https://www.uwv.nl/nl/wet-open-overheid/woo-publicaties/2026/x");
    expect(docs.map((d) => [d.titel, d.soort])).toEqual([["Woo-besluit 2026096 (PDF, 1 MB)", "document"], ["E-mails over gebruik pasfoto (PDF, 8 MB)", "document"]]);
    const html = `<a href="/woo/besluit-1">Besluit op Woo-verzoek 1</a><a href="/over-ons">Over ons</a><a href="https://elders.nl/a.pdf">Bijlage &amp; inventaris</a><a href="mailto:x@y.nl">mail</a>`;
    expect(extractLinks(html, "https://gemeente.nl/bestuur/woo/").map((l) => [l.titel, l.soort])).toEqual([["Besluit op Woo-verzoek 1", "pagina"], ["Bijlage & inventaris", "document"]]);
    expect(parseListPage(page(1, true), "https://www.uwv.nl/x").items[0]).toMatchObject({ datum: "2026-09-16", soort: "pagina" });
  });

  it("matches every word of the search term, accent- and case-insensitive", () => {
    expect(matchesZoekterm({ titel: "Woo-besluit over gebruik van pasfoto's", url: "https://x/y" }, "pasfoto gebruik")).toBe(true);
    expect(matchesZoekterm({ titel: "Woo-besluit BMS", url: "https://x/bemiddelingsservice" }, "bemiddelingsservice")).toBe(true);
    expect(matchesZoekterm({ titel: "Woo-besluit BMS", url: "https://x/y" }, "pasfoto")).toBe(false);
  });

  it("follows a list API page by page and lists the attachments of matching sub-pages", async () => {
    const posted: unknown[] = [];
    const r = await volgLocatie({ informatiecategorie: "Woo-verzoeken en -besluiten", url: "https://www.uwv.nl/overuwv/pers/woo-publicaties/index.aspx" }, { zoekterm: "pasfoto", diepte: 2, maxPerLocatie: 25 }, {
      text: async (u) => (/woo-besluit-gebruik/.test(u) ? UWV_DETAIL : UWV_LIST),
      postJson: async (_u, body) => { posted.push(body); return posted.length === 1 ? page(1, true) : page(2, false); },
    });
    expect(posted).toEqual([{}, { cluster: 2 }]);
    expect(r).toMatchObject({ methode: "lijst-api", doorzocht: 3, gevonden: 1 });
    expect((r.documenten[0] as { bijlagen?: unknown[] }).bijlagen).toHaveLength(2);
  });

  it("runs the index's bekendmakingen search through SRU, with the search term; points RIS to ori_search", async () => {
    expect(bekendmakingenCql(OB_LINK)).toContain('dt.creator=="Uitvoeringsinstituut Werknemersverzekeringen"');
    expect(sruItems(SRU)).toEqual({ totaal: 4, items: [{ titel: "Convenant Aziatische Horeca", url: "https://zoek.officielebekendmakingen.nl/stcrt-2014-30765.html", soort: "document", datum: "2014-10-31", type: "stcrt" }] });
    let asked = "";
    const r = await volgLocatie({ informatiecategorie: "Convenanten", url: OB_LINK }, { zoekterm: "horeca", diepte: 1, maxPerLocatie: 10 }, { text: async (u) => { asked = u; return SRU; }, postJson: async () => ({}) });
    expect(new URL(asked).searchParams.get("query")).toMatch(/AND cql\.textAndIndexes="horeca" sortBy dt\.date\/sort\.descending$/);
    expect(r).toMatchObject({ methode: "officielebekendmakingen", gevonden: 4 });
    const ris = await volgLocatie({ informatiecategorie: "Ingekomen stukken", url: "https://raad.dordrecht.nl/" }, { diepte: 1, maxPerLocatie: 10 }, { text: async () => { throw new Error("niet ophalen"); }, postJson: async () => ({}) });
    expect(ris).toMatchObject({ methode: "raadsinformatie" });
  });

  it("answers over MCP: register lookup, Woo-index, open.overheid.nl count, followed locations", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(href);
      if (u.hostname === "api-organisaties.overheid.nl" && u.pathname.endsWith("/woo")) {
        return jsonResponse({ label: "Uitvoeringsinstituut Werknemersverzekeringen", uri: "https://identifier.overheid.nl/tooi/id/zbo/zb000117", wooInformatie: { overzichtUrl: "https://organisaties.overheid.nl/woo/28212254/Uitvoeringsinstituut_Werknemersverzekeringen", url: "https://www.uwv.nl/nl/over-uwv/wet-open-overheid" }, wooIndex: [{ informatiecategorie: "Woo-verzoeken en -besluiten", url: "https://www.uwv.nl/overuwv/pers/woo-publicaties/index.aspx", toelichting: "Woo besluiten vanaf 1 mei 2022" }, { informatiecategorie: "Convenanten", url: OB_LINK }] });
      }
      if (u.hostname === "api-organisaties.overheid.nl") return jsonResponse([{ label: "Uitvoeringsinstituut Werknemersverzekeringen", type: "https://identifier.overheid.nl/tooi/def/ont/Zbo", uri: "https://identifier.overheid.nl/tooi/id/zbo/zb000117" }]);
      if (u.hostname === "standaarden.overheid.nl") return jsonResponse({ results: { bindings: [{ org: { type: "uri", value: "https://identifier.overheid.nl/tooi/id/zbo/zb000117" }, afk: { type: "literal", value: "UWV" } }] } });
      if (u.hostname === "open.overheid.nl") return jsonResponse({ totaal: 16, resultaten: [], filters: {} });
      if (u.hostname === "repository.overheid.nl") return xmlResponse(SRU);
      if (u.pathname.startsWith("/api/overview")) return jsonResponse((init?.body && String(init.body).includes("cluster")) ? page(2, false) : page(1, true));
      if (/woo-besluit-gebruik/.test(u.pathname)) return htmlResponse(UWV_DETAIL);
      return htmlResponse(UWV_LIST);
    }));
    const out = await call("woo_index", { organisatie: "UWV", zoekterm: "pasfoto" });
    expect(out.records[0].data).toMatchObject({ organisatie: "Uitvoeringsinstituut Werknemersverzekeringen", locaties: 2, open_overheid: { totaal: 16 } });
    const woo = out.records.find((r: { canonical_url: string }) => r.canonical_url.includes("woo-publicaties"));
    expect(woo.data).toMatchObject({ methode: "lijst-api", gevonden: 1 });
    expect(woo.data.documenten[0].bijlagen).toHaveLength(2);
    const ob = out.records.find((r: { canonical_url: string }) => r.canonical_url === OB_LINK);
    expect(ob.data.methode).toBe("officielebekendmakingen");
  });
});

describe("lido_relaties fixes", () => {
  it("reads Juriconnect references", () => {
    expect(parseJci("jci1.3:c:BWBR0005537&hoofdstuk=3&artikel=3:4")).toEqual({ bwb: "BWBR0005537", artikel: "3:4" });
    expect(parseJci("jci1.31:c:BWBR0005289&boek=6&titeldeel=3&artikel=162&z=2024-01-01&g=2024-01-01")).toEqual({ bwb: "BWBR0005289", artikel: "6:162", geldigOp: "2024-01-01" });
    expect(parseJci("jci1.3:c:BWBR0001854")).toEqual({ bwb: "BWBR0001854" });
    expect(parseJci("ECLI:NL:HR:2019:1")).toBeNull();
  });

  it("drops CELLAR's '#' separators from titles", () => {
    expect(schoneTitel("Arrest van het Hof#Celtec Ltd tegen John Astley e.a.#Verzoek om een prejudiciële beslissing#")).toBe("Arrest van het Hof — Celtec Ltd tegen John Astley e.a. — Verzoek om een prejudiciële beslissing");
    expect(schoneTitel("  ")).toBeNull();
  });

  it("lists the separately fetched newest case law first in Jurisprudentie, without duplicates", () => {
    const d = (id: string, type: string): LidoDocument => ({ lidoId: id, id, titel: id, type, instantie: null, gewijzigd: null, url: null, richting: "inkomend", labels: [] });
    const g = groepeerPerType([d("W1", "Wet"), d("J1", "Jurisprudentie")], [d("J2", "Jurisprudentie"), d("J1", "Jurisprudentie")]);
    expect(g.Jurisprudentie.map((x) => x.id)).toEqual(["J2", "J1"]);
    expect(g.Wet).toHaveLength(1);
  });

  it("takes the filtered total from a facet that carries the other filters", async () => {
    const SELF = "http://linkeddata.overheid.nl/terms/bwb/id/BWBR0005290/1/2020-01-01/2020-01-01";
    const LINKS = `<?xml version="1.0"?><lido service="get-links" lido-id="${SELF}"><facetten><facet name="obj_type"><int name="Jurisprudentie">900</int></facet><facet name="obj_organisatie"><int name="Hoge Raad der Nederlanden">26</int></facet><facet name="obj_jaar"><int name="2024">7</int></facet></facetten><subject id="${SELF}"><title>x</title></subject></lido>`;
    const TELLING = `<?xml version="1.0"?><lido service="get-aantal-per-informatietype" id="${SELF}"><aantal informatietype-label="Jurisprudentie" url="x">1000</aantal></lido>`;
    const f = async (u: string) => (/get-aantal/.test(u) ? TELLING : LINKS);
    expect((await lidoRelaties("x", { type: "Jurisprudentie", instantie: "Hoge Raad der Nederlanden", lidoObject: SELF }, f)).totaalMetFilter).toBe(26);
    expect((await lidoRelaties("x", { type: "Jurisprudentie", instantie: "Hoge Raad der Nederlanden", jaar: "2024", lidoObject: SELF }, f)).totaalMetFilter).toBe(7);
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
