/** FORK (docs/FORK.md) — diagnose, geldigheid, bekende valkuilen and foutlog on the lookup tools. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const MAP = mkdtempSync(join(tmpdir(), "foutlog-nlgov-"));
process.env.FOUTLOG_MAP = MAP;
process.env.FOUTLOG_DATABASE_URL = "";
process.env.FOUTLOG_SERVER = "lokaal-test";

const { createServer } = await import("../src/server.js");
const { clearHttpCache } = await import("../src/utils/connector-runtime.js");
const { artikelDiagnose, geldigheid, wtiVersies, zoekValkuil } = await import("../src/fork/hallucinatie.js");
const { foutlog, maakRegel } = await import("../src/fork/foutlog.js");
const { xmlResponse } = await import("./helpers/config.js");

const RV = "BWBR0001827";
const art = (nr: string, o: { status?: string; inwerking: string; bron: string; tekst: string; pad?: string }) =>
  `<artikel bwb-ng-variabel-deel="${o.pad ?? "/BoekDerde/TiteldeelZevende"}/Artikel${nr}" label="Artikel ${nr}" label-id="${nr.length}9" inwerking="${o.inwerking}" bron="${o.bron}" status="${o.status ?? "goed"}"><kop><label>Artikel</label><nr>${nr}</nr></kop><al>${o.tekst}</al></artikel>`;
const toestand = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><toestand bwb-id="${RV}"><wetgeving soort="wet"><citeertitel status="officieel">Wetboek van Burgerlijke Rechtsvordering</citeertitel><wet-besluit><wettekst>${body}</wettekst></wet-besluit></wetgeving></toestand>`;
const OUD = toestand(art("194", { inwerking: "2002-01-01", bron: "Stb.2001-580", tekst: "Oude tekst over deskundigen.", pad: "/BoekEerste/TiteldeelTweede" }) + art("843a", { inwerking: "2002-01-01", bron: "Stb.2001-580", tekst: "Hij die daarbij rechtmatig belang heeft, kan inzage vorderen." }));
const NIEUW = toestand(art("194", { inwerking: "2025-01-01", bron: "Stb.2024-62", tekst: "Een partij bij een rechtsbetrekking heeft recht op inzage.", pad: "/BoekEerste/TiteldeelTweede" }) + art("843a", { status: "vervallen", inwerking: "2025-01-01", bron: "Stb.2024-62", tekst: "Vervallen" }));
const WTI = `<wetstechnische-informatie><wijzigingen>
<regelingelement label-id="49"><datum waarde="2025-01-01" label="Artikel 843a"><details><betreft>vervallen</betreft><ontstaansbron><bron><dossiernummer>35498</dossiernummer><bekendmaking soort="Stb" urlidentifier="stb-2024-62"/></bron></ontstaansbron></details></datum><datum waarde="1988-04-01" label="Artikel 843a"><details><betreft>nieuw</betreft></details></datum></regelingelement>
<regelingelement label-id="44"><datum waarde="2013-07-01" label="Artikel 429a"><details><betreft>vervallen</betreft><ontstaansbron><bron><bekendmaking soort="Stb" urlidentifier="stb-2013-200"/></bron></ontstaansbron></details></datum><datum waarde="1992-01-01" label="Artikel 429a"><details><betreft>nieuw</betreft></details></datum></regelingelement>
</wijzigingen></wetstechnische-informatie>`;
const url = (start: string) => `https://repository.officiele-overheidspublicaties.nl/bwb/${RV}/${start}_0/xml/${RV}_${start}_0.xml`;
const rec = (start: string, end?: string) => `<record><recordData><gzd xmlns="http://standaarden.overheid.nl/sru" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:overheidbwb="http://standaarden.overheid.nl/bwb/terms/"><originalData><overheidbwb:meta><owmskern><dcterms:identifier>${RV}</dcterms:identifier><dcterms:title>Wetboek van Burgerlijke Rechtsvordering</dcterms:title><dcterms:type>wet</dcterms:type></owmskern><bwbipm><overheidbwb:toestand>http://wetten.overheid.nl/id/${RV}/${start}/0</overheidbwb:toestand><overheidbwb:geldigheidsperiode_startdatum>${start}</overheidbwb:geldigheidsperiode_startdatum><overheidbwb:geldigheidsperiode_einddatum>${end ?? "9999-12-31"}</overheidbwb:geldigheidsperiode_einddatum></bwbipm></overheidbwb:meta></originalData><enrichedData><overheidbwb:locatie_toestand>${url(start)}</overheidbwb:locatie_toestand></enrichedData></gzd></recordData></record>`;
const sru = (records: string[]) => `<?xml version="1.0" encoding="UTF-8"?><searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><version>1.2</version><numberOfRecords>${records.length}</numberOfRecords><records>${records.join("")}</records></searchRetrieveResponse>`;

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const u = new URL(String(input));
    if (u.hostname === "zoekservice.overheid.nl") {
      const q = u.searchParams.get("query") ?? "";
      const d = /geldigheidsdatum==?(\d{4}-\d{2}-\d{2})/.exec(q)?.[1];
      if (q.includes(RV)) return xmlResponse(sru([d && d < "2025-01-01" ? rec("2024-11-08", "2024-12-31") : rec("2026-07-14")]));
      return xmlResponse(sru([]));
    }
    if (String(input) === url("2024-11-08")) return xmlResponse(OUD);
    if (String(input) === url("2026-07-14")) return xmlResponse(NIEUW);
    if (u.pathname.endsWith(".WTI")) return xmlResponse(WTI);
    if (u.hostname === "data.rechtspraak.nl") {
      const id = u.searchParams.get("id");
      if (id === "ECLI:NL:RBDHA:2021:5") return xmlResponse(`<open-rechtspraak><rdf:RDF><dcterms:identifier>${id}</dcterms:identifier></rdf:RDF></open-rechtspraak>`);
      return new Response("Not found", { status: 404 });
    }
    return new Response("?", { status: 404 });
  }));
}

async function call(name: string, args: Record<string, unknown>) {
  const server = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(ct);
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
  await client.close();
  return JSON.parse(res.content[0].text);
}
const regels = async () => { await foutlog().flush(); const f = join(MAP, "nl_gov_mcp.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };

describe("hallucinatiebeveiliging: helpers", () => {
  it("bekende valkuil 843a Rv, met opvolger en overgangsrecht uit de officiële bron", () => {
    const v = zoekValkuil(RV, "Artikel 843a")!;
    expect(v.vervallen_per).toBe("2025-01-01");
    expect((v.opvolger as Array<{ artikel: string }>).map((o) => o.artikel)).toEqual(["194", "195", "195a"]);
    expect(JSON.stringify(v.overgangsrecht)).toContain("XIIA");
    expect(zoekValkuil(RV, "843")).toBeUndefined();
  });
  it("WTI-versies op label, diagnose artikel_bestond_nooit en nog niet in werking", () => {
    expect(wtiVersies(WTI, "843a").map((v) => v.betreft)).toEqual(["vervallen", "nieuw"]);
    expect(artikelDiagnose({ bwbId: RV, artikel: "999", peildatum: "2026-10-20", versies: [] }).code).toBe("artikel_bestond_nooit");
    expect(artikelDiagnose({ bwbId: RV, artikel: "5", peildatum: "2020-01-01", versies: [{ datum: "2022-01-01", betreft: "nieuw", staatsblad: [], dossiers: [] }] }).nog_niet_in_werking).toBe(true);
  });
  it("geldigheid", () => {
    expect(geldigheid({ status: "goed", inwerking: "2002-01-01" }, { status: "goed", inwerking: "2025-01-01" }, "2024-06-01", "2026-10-20")?.status).toBe("gewijzigd_sinds_peildatum");
    expect(geldigheid({ status: "nogniet" }, undefined, "2026-10-20", "2026-10-20")?.status).toBe("nog_niet_in_werking");
  });
  it("foutlog-regel bewaart geen vrije tekst", () => {
    const r = maakRegel({ tool: "wetten_bwb_tekst", verwijzing: "Rv art. 843a", invoer: { wet: "Rv", artikel: "843a", zoekterm: "geheim" }, uitkomst: "x", citaat: "geheim" }, "render");
    expect(JSON.stringify(r)).not.toContain("geheim");
    expect(r.citaat_lengte).toBe(6);
  });
});

describe("hallucinatiebeveiliging: tools", () => {
  beforeEach(() => { vi.unstubAllGlobals(); clearHttpCache(); stub(); });
  afterEach(() => vi.unstubAllGlobals());

  it("1. bwb_artikel_tekst 843a Rv: bekende_valkuil, geldigheid vervallen, diagnose met vervallen_per; gelogd", async () => {
    const r = await call("bwb_artikel_tekst", { bwbId: RV, artikel: "843a" });
    expect(r.bekende_valkuil.soort).toBe("vervallen");
    expect(r.geldigheid.status).toBe("vervallen");
    expect(r.diagnose.code).toBe("artikel_bestaat_niet_in_geldende_versie");
    expect(r.diagnose.vervallen_per).toBe("2025-01-01");
    const l = (await regels()).find((x) => x.tool === "bwb_artikel_tekst" && x.invoer.artikel === "843a");
    expect(l.uitkomst).toContain("bekende_valkuil");
    expect(l.server).toBe("lokaal-test");
  });
  it("2. bwb_artikel_tekst met peildatum 2024-06-01: 194 gewijzigd_sinds_peildatum; 843a gold toen, nu vervallen", async () => {
    const a = await call("bwb_artikel_tekst", { bwbId: RV, artikel: "194", peildatum: "2024-06-01" });
    expect(a.geldigheid.status).toBe("gewijzigd_sinds_peildatum");
    expect(a.geldigheid.datum).toBe("2025-01-01");
    const b = await call("bwb_artikel_tekst", { bwbId: RV, artikel: "843a", datum: "2024-06-01" });
    expect(b.geldigheid.status).toBe("vervallen");
    expect(b.diagnose).toBeUndefined();
  });
  it("3. wetten_bwb_tekst art. 194 vandaag: geldend, geen diagnose", async () => {
    const r = await call("wetten_bwb_tekst", { bwb_id: RV, artikel: "194" });
    expect(r.geldigheid.status).toBe("geldend");
    expect(r.diagnose).toBeUndefined();
  });
  it("4. wetten_bwb_tekst art. 429a: eerder vervallen, vervallen_per en wijzigingswet uit de WTI", async () => {
    const r = await call("wetten_bwb_tekst", { bwb_id: RV, artikel: "429a" });
    expect(r.diagnose.code).toBe("artikel_bestaat_niet_in_geldende_versie");
    expect(r.diagnose.vervallen_per).toBe("2013-07-01");
    expect(r.geldigheid.status).toBe("vervallen");
  });
  it("5. wetten_bwb_tekst art. 999: artikel_bestond_nooit", async () => {
    const r = await call("wetten_bwb_tekst", { bwb_id: RV, artikel: "999" });
    expect(r.diagnose.code).toBe("artikel_bestond_nooit");
  });
  it("6. wetten_bwb_tekst onbekend BWB-id: wet_onbekend", async () => {
    const r = await call("wetten_bwb_tekst", { bwb_id: "BWBR9999999", artikel: "1" });
    expect(r.diagnose.code).toBe("wet_onbekend");
  });
  it("7. rechtspraak_uitspraak_get onbekende ECLI: ecli_onbekend; rechtspraak_get_by_ecli idem", async () => {
    expect((await call("rechtspraak_uitspraak_get", { ecli: "ECLI:NL:HR:2099:1" })).diagnose.code).toBe("ecli_onbekend");
    expect((await call("rechtspraak_get_by_ecli", { ecli: "ECLI:NL:HR:2099:1" })).diagnose.code).toBe("ecli_onbekend");
  });
  it("8. rechtspraak_get_by_ecli met alleen metadata: ecli_zonder_tekst", async () => {
    expect((await call("rechtspraak_get_by_ecli", { ecli: "ECLI:NL:RBDHA:2021:5" })).diagnose.code).toBe("ecli_zonder_tekst");
  });
  it("9. netwerkfout: toolfout met de foutmelding, niet 'bestaat niet'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const r = await call("rechtspraak_uitspraak_get", { ecli: "ECLI:NL:HR:2019:2006" });
    expect(r.diagnose.code).toBe("toolfout");
  });
  it("10. wetten_bwb_search met een artikel in de vraag: diagnose en valkuil van dat artikel", async () => {
    const r = await call("wetten_bwb_search", { query: `artikel 843a ${RV}` });
    expect(r.bekende_valkuil?.artikel).toBe("843a");
    expect(r.geldigheid?.status).toBe("vervallen");
  });
  it("tooldescripties noemen diagnose, geldigheid en bekende_valkuil; bwb_artikel_tekst kent peildatum", async () => {
    const server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(ct);
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "bwb_artikel_tekst")!;
    expect(t.description).toMatch(/diagnose\.code/);
    expect(t.description).toMatch(/bekende_valkuil/);
    expect(Object.keys(t.inputSchema.properties ?? {})).toContain("peildatum");
    expect(tools.find((x) => x.name === "rechtspraak_uitspraak_get")!.description).toMatch(/ecli_onbekend/);
    await client.close();
  });
});
