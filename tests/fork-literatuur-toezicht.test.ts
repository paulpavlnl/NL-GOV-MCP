/**
 * FORK (docs/FORK.md) — open legal literature (OpenAlex, CORE), Kifid and the Autoriteit Persoonsgegevens.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { coreWerk, openaireUrl, openaireWerk, pdfUitPagina, samenvatting, status, werk, werkId, zonderSleutel, zoekUrl } from "../src/fork/literatuur.js";
import { kifidDatum, parseKifid } from "../src/fork/geschilbeslechting.js";
import { parseApDocument, parseApLijst } from "../src/fork/toezicht.js";
import { htmlResponse, jsonResponse } from "./helpers/config.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearHttpCache(); });

const WERK = {
  id: "https://openalex.org/W1234567", doi: "https://doi.org/10.33540/231", display_name: "Aansprakelijkheid  bij leidingschades", publication_year: 2011, publication_date: "2011-05-20",
  type: "dissertation", language: "nl", cited_by_count: 3,
  authorships: [{ author: { display_name: "A. Jansen" }, institutions: [{ display_name: "Delft University of Technology" }] }],
  primary_location: { landing_page_url: "https://repository.tudelft.nl/record/uuid:1", source: { display_name: "TU Delft Repository", type: "repository" } },
  best_oa_location: { is_oa: true, pdf_url: null, landing_page_url: "https://repository.tudelft.nl/record/uuid:1" },
  locations: [{ is_oa: true, landing_page_url: "https://repository.tudelft.nl/record/uuid:1" }],
  open_access: { is_oa: true, oa_url: "https://repository.tudelft.nl/record/uuid:1" },
  abstract_inverted_index: { Dit: [0], gaat: [1], over: [2], leidingschade: [3] },
  primary_topic: { display_name: "Tort law", subfield: { display_name: "Law" } },
};

describe("literatuur", () => {
  it("reads OpenAlex works and builds queries without leaking the key", () => {
    expect(samenvatting(WERK.abstract_inverted_index)).toBe("Dit gaat over leidingschade");
    const w = werk(WERK);
    expect(w).toMatchObject({ id: "W1234567", titel: "Aansprakelijkheid bij leidingschades", soort: "proefschrift", betrouwbaarheid: "proefschrift (openbaar verdedigd)", instellingen: ["Delft University of Technology"], open_access: true });
    expect(status({ type: "article", primary_location: { source: { type: "journal", is_in_doaj: true } } })).toMatch(/peer-reviewed open-access/);
    expect(status({ type: "preprint", primary_location: { source: { display_name: "SSRN" } } })).toMatch(/niet door vakgenoten/);
    const u = new URL(zoekUrl({ zoekterm: "aansprakelijkheid", soort: "proefschrift", taal: "nl", land: "NL+BE", alleen_open_access: true, van: 2000, bron: "oa_boeken" }));
    expect(u.searchParams.get("search")).toBeNull();
    expect(u.searchParams.get("filter")).toBe("title_and_abstract.search:aansprakelijkheid,type:dissertation,language:nl,authorships.institutions.country_code:NL|BE,is_oa:true,locations.source.id:S4306402535|S4306400539,publication_year:2000-2100");
    const breed = new URL(zoekUrl({ zoekterm: "a, b", zoeken_in: "alles" }));
    expect(breed.searchParams.get("search")).toBe("a, b");
    expect(breed.searchParams.get("filter")).toBe("type:!dataset");
    expect(zonderSleutel("https://api.openalex.org/works?search=x&api_key=GEHEIM&page=1")).toBe("https://api.openalex.org/works?search=x&page=1");
    expect(zonderSleutel("https://api.openalex.org/works/W1?select=id&api_key=GEHEIM")).toBe("https://api.openalex.org/works/W1?select=id");
    expect(werkId("https://doi.org/10.33540/231.")).toBe("doi:10.33540/231");
    expect(werkId("W2741809807")).toBe("W2741809807");
    expect(pdfUitPagina(`<meta name="citation_pdf_url" content="/file/File_01">`, "https://repository.tudelft.nl/record/uuid:1")).toBe("https://repository.tudelft.nl/file/File_01");
    expect(coreWerk({ id: 42, title: "Werkgeversaansprakelijkheid", yearPublished: 2016, authors: [{ name: "B. de Vries" }], dataProviders: [{ name: "VU Research Portal" }], downloadUrl: "https://core.ac.uk/download/303668857.pdf", fullText: "x".repeat(2000) }))
      .toMatchObject({ id: "core:42", bron: "VU Research Portal", core_output: "303668857", volledige_tekst_beschikbaar: true });
  });

  it("literatuur_zoeken and literatuur_document_get via the tools", async () => {
    vi.stubEnv("OPENALEX_API_KEY", "GEHEIM");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const u = String(input instanceof Request ? input.url : input); urls.push(u);
      if (u.includes("/works?")) return jsonResponse({ meta: { count: 1 }, results: [WERK] });
      if (u.includes("/works/W1234567")) return jsonResponse(WERK);
      if (u.includes("repository.tudelft.nl/record")) return htmlResponse(`<html><meta name="citation_pdf_url" content="/file/File_01"></html>`);
      return htmlResponse("niet gevonden", 404);
    }));
    const r = await call("literatuur_zoeken", { zoekterm: "leidingschade", soort: "proefschrift" });
    expect(r.records[0].data.betrouwbaarheid).toMatch(/proefschrift/);
    expect(JSON.stringify(r)).not.toContain("GEHEIM");
    expect(urls[0]).toContain("api_key=GEHEIM");
    const d = await call("literatuur_document_get", { werk: "W1234567" });
    expect(JSON.stringify(d)).not.toContain("GEHEIM");
    expect(d.records[0].data.open_in_browser).toBe("https://repository.tudelft.nl/record/uuid:1");
    expect(d.records[0].data.pogingen.length).toBeGreaterThan(0);
  });

  it("searches law first and broadens only when that finds too little", async () => {
    const urls: string[] = [];
    const ANDER = { ...WERK, id: "https://openalex.org/W7654321", doi: "https://doi.org/10.1/ander", display_name: "Werkgeversaansprakelijkheid in de praktijk", primary_topic: { subfield: { display_name: "Political Science" } } };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const u = String(input instanceof Request ? input.url : input); urls.push(u);
      return jsonResponse(u.includes("3308") ? { meta: { count: 1 }, results: [WERK] } : { meta: { count: 2 }, results: [WERK, ANDER] });
    }));
    const r = await call("literatuur_zoeken", { zoekterm: "aansprakelijkheid" });
    expect(urls[0]).toContain("primary_topic.subfield.id%3A3308");
    expect(urls[1]).not.toContain("3308");
    expect(r.records.map((x: { data: { vakgebied: string } }) => x.data.vakgebied)).toEqual(["Recht", "buiten Recht geclassificeerd"]);
    urls.length = 0;
    await call("literatuur_zoeken", { zoekterm: "aansprakelijkheid", vakgebied: "alle" });
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toContain("3308");
  });

  const OAIRE = {
    id: "doi_dedup___::abc", mainTitle: "De zorgplicht van de bank", publicationDate: "2019-03-01", language: { code: "dut" },
    authors: [{ fullName: "C. de Bruin" }], bestAccessRight: { label: "OPEN" }, descriptions: ["<p>Over de zorgplicht.</p>"],
    container: { name: "Ondernemingsrecht", vol: "12", iss: "3", sp: "45", ep: "52", issnPrinted: "1381-8295" },
    instances: [{ type: "Article", refereed: "peerReviewed", urls: ["https://repository.ubn.ru.nl/handle/2066/1"] }],
    pids: [{ scheme: "doi", value: "10.5117/or.2019.3" }], subjects: [{ subject: { value: "Bankrecht" } }],
  };
  it("reads OpenAIRE records and builds OpenAIRE queries", () => {
    expect(openaireWerk(OAIRE)).toMatchObject({ id: "openaire:doi_dedup___::abc", titel: "De zorgplicht van de bank", jaar: 2019, betrouwbaarheid: "door vakgenoten beoordeeld (peer reviewed)", bron: "Ondernemingsrecht", jaargang: "12", paginas: "45-52", doi: "https://doi.org/10.5117/or.2019.3", open_access: true, oa_link: "https://repository.ubn.ru.nl/handle/2066/1", samenvatting: " Over de zorgplicht. " });
    expect(openaireWerk({ ...OAIRE, container: undefined, instances: [{ type: "Doctoral thesis", refereed: "nonPeerReviewed", urls: [] }] }).betrouwbaarheid).toBe("proefschrift (openbaar verdedigd)");
    const u = new URL(openaireUrl({ zoekterm: "zorgplicht bank", soort: "proefschrift", land: "NL+BE", alleen_open_access: true, recht: true, van: 2010, sortering: "nieuwste" }));
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ search: "zorgplicht bank", countryCode: "NL,BE", fos: "0505 law", bestOpenAccessRightLabel: "OPEN", instanceType: "Doctoral thesis", fromPublicationDate: "2010-01-01", sortBy: "publicationDate DESC" });
  });

  it("literatuur_zoeken via OpenAIRE uses a client-credentials token and reports the limit", async () => {
    vi.stubEnv("OPENAIRE_CLIENT_ID", "id"); vi.stubEnv("OPENAIRE_CLIENT_SECRET", "geheim");
    const calls: Array<{ url: string; auth?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input instanceof Request ? input.url : input);
      calls.push({ url: u, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      if (u.includes("aai.openaire.eu")) return jsonResponse({ access_token: "TOKEN" });
      return jsonResponse({ header: { numFound: 1 }, results: Array.from({ length: 6 }, (_, i) => ({ ...OAIRE, id: `x${i}`, pids: [{ scheme: "doi", value: `10.1/${i}` }] })) });
    }));
    const r = await call("literatuur_zoeken", { zoekterm: "zorgplicht", bron: "openaire" });
    expect(calls[0].auth).toBe(`Basic ${Buffer.from("id:geheim").toString("base64")}`);
    expect(calls[1].auth).toBe("Bearer TOKEN");
    expect(calls[1].url).toContain("fos=0505+law");
    expect(calls).toHaveLength(2); // 6 resultaten binnen Recht: niet verbreed
    expect(r.records[0].data.betrouwbaarheid).toMatch(/peer reviewed/);
    expect(JSON.stringify(r)).not.toContain("TOKEN");
    vi.unstubAllEnvs(); vi.stubEnv("OPENAIRE_CLIENT_ID", "");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 429)));
    const t = await call("literatuur_zoeken", { zoekterm: "zorgplicht", bron: "openaire" });
    expect(JSON.stringify(t)).toMatch(/limiet bereikt/);
  });
});

describe("Kifid", () => {
  const ITEM = { title: "Uitspraak 2026-1003 (Bindend)", defendant: "NIBC Direct Hypotheken B.V.", date: 639270144000000000, summary: "<p>De consument heeft een hypotheek.</p>", statementLink: "https://www.kifid.nl/media/x/uitspraak-2026-1003-bindend.pdf", category: "Hypotheek", authority: "Geschillencommissie", judgementTags: "Zorgplicht", url: "https://www.kifid.nl/kifid-kennis-en-uitspraken/uitspraken/uitspraak-2026-1003-bindend/", pdfContent: "Uitspraak Geschillencommissie Kifid nr. 2026-1003 Aard uitspraak Bindend advies Uitkomst Vordering afgewezen Bijlage x 1. Procedure 1.1 De commissie beslist. 3.2 De zorgplicht van de bank gaat niet zo ver." };
  it("parses the search API", () => {
    expect(kifidDatum(639270144000000000)).toBe("2026-10-08");
    const [i] = parseKifid({ decision: { decisionItemsList: [ITEM] } });
    expect(i).toMatchObject({ nummer: "2026-1003", aard: "bindend advies", uitkomst: "Vordering afgewezen", tegen: "NIBC Direct Hypotheken B.V.", datum: "2026-10-08", trefwoorden: ["Zorgplicht"], samenvatting: "De consument heeft een hypotheek." });
  });
  it("kifid_zoeken with passages", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => { urls.push(String(input instanceof Request ? input.url : input)); return jsonResponse({ decision: { decisionItemsList: [ITEM] } }); }));
    const r = await call("kifid_zoeken", { zoekterm: "zorgplicht", categorie: "Hypotheek", tekst: true });
    const u = new URL(urls[0]);
    expect([u.searchParams.get("searchTerm"), u.searchParams.get("category"), u.searchParams.get("sort")]).toEqual(["zorgplicht", "Hypotheek", "newest"]);
    expect(r.records[0].title).toBe("Kifid Geschillencommissie 2026-1003");
    expect(r.records[0].data.tekst).toContain("zorgplicht van de bank");
  });
});

describe("Autoriteit Persoonsgegevens", () => {
  const LIJST = `<article class="node-publication-card"><a class="node-publication-card__action" href="/documenten/boete-ambitious-people-group-verwijderverzoeken"></a><div class="node-publication-card__content"><h3 class="node-publication-card__title"><span>Boete Ambitious People Group verwijderverzoeken</span></h3><div class="node-publication-card__submitted">05 juni 2024</div></div></article>
<nav><a href="?keys=boete&amp;page=1" rel="next">Volgende</a></nav>`;
  const DOC = `<main><h1><span>Boete Ambitious People Group verwijderverzoeken</span></h1><div>05 juni 2024</div><div>Thema's:</div><div>Privacyrechten AVG</div><div>Uitzendbureau</div><p>De AP heeft een boete opgelegd van 6.000 euro.</p><a href="/system/files?file=2024-06/Besluit%20boete%20APG.pdf">Download document</a></main>`;
  it("parses list and document", () => {
    const l = parseApLijst(LIJST);
    expect(l.items).toEqual([{ titel: "Boete Ambitious People Group verwijderverzoeken", url: "https://autoriteitpersoonsgegevens.nl/documenten/boete-ambitious-people-group-verwijderverzoeken", datum: "2024-06-05" }]);
    expect(l.volgende).toBe(1);
    const d = parseApDocument(DOC);
    expect(d).toMatchObject({ titel: "Boete Ambitious People Group verwijderverzoeken", datum: "2024-06-05", themas: ["Privacyrechten AVG", "Uitzendbureau"], pdf: "https://autoriteitpersoonsgegevens.nl/system/files?file=2024-06/Besluit%20boete%20APG.pdf" });
  });
  it("reports a firewall refusal with the official alternatives", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("The requested URL was rejected. Please consult with your administrator. Your support ID is: <1>", 200)));
    const r = await call("ap_documenten_zoeken", { zoekterm: "camera", soort: ["boete"] });
    expect(r.error).toBeDefined();
    expect(JSON.stringify(r)).toContain("officiele_bekendmakingen_search");
    expect((await call("ap_documenten_zoeken", { soort: ["onbekend"] })).error).toBeDefined();
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
