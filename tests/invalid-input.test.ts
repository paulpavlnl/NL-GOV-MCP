import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearDsoCaches } from "../src/sources/dso-omgevingsdocumenten.js";
import { GehoordInputError, mapGehoordError } from "../src/sources/gehoord.js";
import { mapOnderzoekscallError, OnderzoekscallInputError, OnderzoekscallPageError } from "../src/sources/nl-onderzoekscalls.js";
import { mapTweedeKamerError, TweedeKamerInputError } from "../src/sources/tweede-kamer.js";
import { mapWodcError, WodcInputError } from "../src/sources/wodc.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { SourceRequestError } from "../src/utils/http.js";
import { InvalidInputError, mapSourceError } from "../src/utils/response.js";
import { jsonResponse } from "./helpers/config.js";

/**
 * An argument the server refuses is `invalid_input` with its own message and
 * suggestion, for every tool: no longer `unexpected` with "try again". A failure
 * that is not the caller's input (a document not found, an upstream error) keeps
 * its code.
 */

interface Payload {
  error?: string;
  message?: string;
  suggestion?: string;
  details?: Record<string, unknown>;
  summary?: string;
  records?: unknown[];
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Payload> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0].text) as Payload;
  } finally {
    await client.close();
    await server.close();
  }
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  clearHttpCache();
  clearDsoCaches();
  fetchMock = vi.fn(async () => jsonResponse({}, 500));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function expectRefused(payload: Payload, message: RegExp | string) {
  expect(payload.error).toBe("invalid_input");
  expect(payload.message).toMatch(message);
  expect(payload.suggestion).toBeTruthy();
  expect(payload.suggestion).not.toMatch(/try again|probeer (het )?(later )?opnieuw/i);
}

describe("refused input is invalid_input, without a request", () => {
  it.each<[string, Record<string, unknown>, RegExp | string]>([
    ["officiele_bekendmakingen_search", { query: "", bbox_rd: [1, 2, 3] }, /^bbox_rd/],
    ["bag_lookup_address", {}, "query of postcode"],
    ["bag_address_detail", {}, "ofwel `query` ofwel `pdok_id`"],
    ["rechtspraak_uitspraak_get", { ecli: "19/00135" }, "Geen geldige ECLI"],
    ["rechtspraak_uitspraak_get", { ecli: "ECLI:EU:C:2014:317" }, "geen Nederlandse ECLI"],
    ["rechtspraak_uitspraak_get", { ecli: "ECLI:NL:HR:2019:2006", sectie: '") OR ("' }, "bevat geen nummer"],
    ["wetten_bwb_tekst", { bwb_id: "Awb" }, "geen BWB-id"],
    ["eurlex_document", { id: "geen celex" }, "Ongeldig CELEX-nummer"],
    ["eurlex_nl_omzetting", { id: "geen celex" }, "Ongeldig CELEX-nummer"],
    ["eurlex_nl_omzetting", { id: "32016R0679" }, "is geen richtlijn"],
    ["eurlex_search", { query: "de het EU" }, "geen bruikbare woorden"],
    ["lido_verwijzingen", { id: "geen-id" }, "Onbekend LiDO-identifier"],
    ["lido_verwijzingen", { id: "ECLI:NL:HR:2019:2006", artikel: "3" }, "alleen van toepassing op een BWB-id"],
    ["lido_verwijzingen_lijst", { id: "geen-id" }, "Onbekend LiDO-identifier"],
    ["lido_verwijzingen_lijst", { id: "BWBR0011823", type: "Wet:*" }, "Ongeldig informatietype"],
    ["tenderned_aanbesteding_get", { publicatieId: "abc" }, "alleen cijfers"],
    ["tenderned_aanbesteding_get", { publicatieId: "1", publicatie_id: "2" }, "verschillen"],
    ["tenderned_aanbestedingen_search", { top: 100, page: 100 }, "10000"],
    ["eu_funding_search", { programme: "Geen Programma" }, "Geen Programma"],
    ["eu_funding_get", { id: "   " }, "topic-identifier"],
    ["rvo_subsidie_get", { id: "   " }, "Geef een id"],
    ["nl_onderzoek_call_get", { url: "https://www.example.org/calls/x" }, "geen pagina van nwo.nl"],
    ["tweede_kamer_documents", { query: "stikstof", date_from: "1 juli 2026" }, "JJJJ-MM-DD"],
    ["tweede_kamer_document_get", { id: "geen-guid" }, "verwacht een GUID"],
    ["tweede_kamer_votes", { zaak_id: "motie stikstof" }, "zaak_id"],
    ["tweede_kamer_debatten", { date_from: "1 oktober 2026" }, "geen datum"],
    ["wodc_search", { date_from: "2025-13" }, "geen datum"],
    ["nl_gov_ask", { question: "wat is er vorige week besloten", reference_now: "gisteren-ochtend" }, "reference_now"],
    ["nl_gov_ask", { question: "wat is er vorige week besloten", timezone: "Mars/Olympus" }, "timezone"],
  ])("%s %j", async (tool, args, message) => {
    expectRefused(await callTool(tool, args), message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the DSO tools: a bad identifier, an onderdeel too long for a label, and provincie with bevoegdGezag", async () => {
    vi.stubEnv("DSO_API_KEY", "voorbeeld-sleutel");
    const id = await callTool("dso_omgevingsdocument_tekst", { identificatie: "https://voorbeeld.example/geen-akn" });
    expectRefused(id, "Onbekende identificatie");
    // Over the tool's own 300 characters, under the general argument limit: the tool's own check answers.
    const label = await callTool("dso_omgevingsdocument_tekst", { identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan", onderdeel: "a".repeat(400) });
    expectRefused(label, "te lang voor een eId of label");
    const renvooi = await callTool("dso_omgevingsdocument_tekst", { identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan", weergave: "wijzigingen" });
    expectRefused(renvooi, "alleen voor een ontwerp");
    const both = await callTool("dso_omgevingsdocumenten_search", { provincie: "Utrecht", bevoegdGezag: "gemeente Utrecht" });
    expectRefused(both, "provincie gaat niet samen");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the Gehoord.de tools: an id that is none", async () => {
    vi.stubEnv("GEHOORD_KEY", "voorbeeld-sleutel");
    expectRefused(await callTool("gehoord_debat_get", { debate_id: "a b" }), "geen geldig Gehoord-id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ep_online_energielabel: neither postcode with huisnummer nor bagId", async () => {
    vi.stubEnv("EP_ONLINE_API_KEY", "voorbeeld-sleutel");
    expectRefused(await callTool("ep_online_energielabel", { postcode: "1234AB" }), "vereist postcode + huisnummer");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the per-source input errors are InvalidInputError, with their extra fields", () => {
  it("map to invalid_input through their own mappers and through mapSourceError", () => {
    const tk = new TweedeKamerInputError("Ongeldige waarde 'x'.", "Geef 'y'.");
    expect(tk).toBeInstanceOf(InvalidInputError);
    expect(mapTweedeKamerError(tk)).toMatchObject({ error: "invalid_input", message: "Ongeldige waarde 'x'.", suggestion: "Geef 'y'." });
    expect(mapGehoordError(new GehoordInputError("Ongeldig id.", "Neem het id over."))).toMatchObject({ error: "invalid_input", suggestion: "Neem het id over." });
    expect(mapWodcError(new WodcInputError("Geen datum.", "Gebruik YYYY."))).toMatchObject({ error: "invalid_input", suggestion: "Gebruik YYYY." });
    expect(mapOnderzoekscallError(new OnderzoekscallInputError("Geen URL.", "Geef een url."))).toMatchObject({ error: "invalid_input", suggestion: "Geef een url." });
  });

  it("keeps details on the response", () => {
    const out = mapSourceError(new InvalidInputError("Te breed.", "Specifieker.", { aantal: 12 }), "Voorbeeldbron");
    expect(out).toMatchObject({ error: "invalid_input", details: { aantal: 12 } });
  });
});

describe("controls: a failure that is not the caller's input keeps its code", () => {
  it("nl_gov_ask takes a blank reference_now or a padded timezone as before", async () => {
    const blank = await callTool("nl_gov_ask", { question: "wat is er vorige week besloten", reference_now: "", timezone: "", dryRun: true });
    expect(blank.error).toBeUndefined();
    const padded = await callTool("nl_gov_ask", { question: "wat is er vorige week besloten", timezone: " Europe/Amsterdam ", dryRun: true });
    expect(padded.error).toBeUndefined();
  });

  it("a document the DSO does not have (404) stays unexpected, with its suggestion", async () => {
    vi.stubEnv("DSO_API_KEY", "voorbeeld-sleutel");
    fetchMock.mockImplementation(async () => jsonResponse({ title: "Resource niet gevonden" }, 404));
    const out = await callTool("dso_omgevingsdocument_tekst", { identificatie: "_akn_nl_act_gm9999_2099_voorbeeld" });
    expect(out.error).toBe("unexpected");
    expect(out.message).toContain("niet gevonden in het DSO");
  });

  it("a fetched page that is no call page stays unexpected", () => {
    const out = mapOnderzoekscallError(new OnderzoekscallPageError("https://www.zonmw.nl/nl/subsidie/x is geen subsidiepagina.", "Geef de url van een call."));
    expect(out).toMatchObject({ error: "unexpected", suggestion: "Geef de url van een call." });
  });

  it("an HTTP 400 of the Tweede Kamer API stays http_error, a plain Error unexpected", () => {
    const http400 = new SourceRequestError({ message: "bad", endpoint: "https://gegevensmagazijn.tweedekamer.nl/OData/v4/2.0/Document", code: "http_error", status: 400 });
    expect(mapTweedeKamerError(http400).error).toBe("http_error");
    expect(mapGehoordError(new Error("kapot")).error).toBe("unexpected");
  });

  it("a valid argument is not refused: rechtspraak_uitspraak_get asks the source", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 404 }));
    const out = await callTool("rechtspraak_uitspraak_get", { ecli: "ECLI:NL:HR:2019:2006" });
    expect(out.error).not.toBe("invalid_input");
    expect(fetchMock).toHaveBeenCalled();
  });
});
