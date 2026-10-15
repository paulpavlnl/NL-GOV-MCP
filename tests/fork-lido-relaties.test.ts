/**
 * FORK (docs/FORK.md) — lido_relaties: every LiDO relation of any kind of
 * government document, through LiDO's services.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { lidoLookups, lidoRelaties, linkFilters, parseLinks } from "../src/fork/lido-relaties.js";
import { xmlResponse } from "./helpers/config.js";

const HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const DC = 'xmlns:dcterms="http://purl.org/dc/terms/"';
const SELF = "http://linkeddata.overheid.nl/terms/jurisprudentie/id/ECLI:EU:C:2005:321";
const NL = "http://linkeddata.overheid.nl/terms/jurisprudentie/id/ECLI:NL:PHR:2022:624";
const REG = "http://linkeddata.overheid.nl/terms/bwb/id/BWBR0012345/1/2020-01-01/2020-01-01";
const ref = (id: string, label: string) => `<subject-ref type="x" idref="${id}" label="${label}"></subject-ref>`;
const subj = (id: string, ext: string, type: string, title: string, creator: string, extra = "") =>
  `<subject id="${id}"><dcterms:identifier ${DC} type="extern">${ext}</dcterms:identifier><dcterms:type ${DC}>${type}</dcterms:type>` +
  `<dcterms:title ${DC}>${title}</dcterms:title><dcterms:creator ${DC}>${creator}</dcterms:creator><dcterms:hasVersion ${DC}>https://x/${ext}</dcterms:hasVersion>${extra}</subject>`;
const LINKS = `${HEAD}<lido service="get-links" lido-id="${SELF}"><facetten><facet name="obj_type"><int name="Jurisprudentie">6</int><int name="Ministeriële-regeling">1</int></facet>` +
  `<facet name="obj_organisatie"><int name="Gerechtshof &#39;s-Hertogenbosch">2</int><int name="Parket bij de Hoge Raad">1</int></facet></facetten>` +
  subj(SELF, "ECLI:EU:C:2005:321", "Jurisprudentie", "Celtec", "Hof van Justitie", `<inkomende-links>${ref(NL, "Door computer herkende referentie")}</inkomende-links><uitgaande-links>${ref(REG, "x")}</uitgaande-links>`) +
  subj(REG, "BWBR0012345", "Ministeriële-regeling", "Regeling", "Gerechtshof &#39;s-Hertogenbosch") +
  subj(NL, "ECLI:NL:PHR:2022:624", "Jurisprudentie", "Conclusie A-G", "Parket bij de Hoge Raad") + "</lido>";
const TELLING = `${HEAD}<lido service="get-aantal-per-informatietype" id="${SELF}"><aantal informatietype-label="Jurisprudentie" url="x">6</aantal><aantal informatietype-label="Ministeriële-regeling" url="y">1</aantal></lido>`;
const EMPTY = `${HEAD}<lido service="get-aantal-per-informatietype" id=""></lido>`;

afterEach(() => { vi.unstubAllGlobals(); clearHttpCache(); });

describe("lido_relaties", () => {
  it("maps every kind of identifier to a LiDO lookup", () => {
    expect(lidoLookups("ecli:eu:c:2005:321")).toEqual([{ "ext-id": "ECLI:EU:C:2005:321" }]);
    expect(lidoLookups("32001L0023")).toEqual([{ "ext-id": "CELEX:32001L0023" }]);
    expect(lidoLookups("stb-2018-401")).toEqual([{ "ext-id": "OEP:stb-2018-401" }]);
    expect(lidoLookups("BWBR0005537")).toEqual([{ "juriconnect-ref": "BWBR0005537" }]);
    expect(lidoLookups("artikel 3:4 Awb")).toEqual([]);
    expect(linkFilters({ type: "Jurisprudentie", instantie: "Hoge Raad der Nederlanden" })).toHaveLength(2);
    expect(() => linkFilters({ type: 'x" OR *:*' })).toThrow();
  });

  it("parses direction, type and issuing body; decodes entities", () => {
    const p = parseLinks(LINKS)!;
    expect(p.items.map((i) => [i.id, i.type, i.richting])).toEqual([["BWBR0012345", "Ministeriële-regeling", "uitgaand"], ["ECLI:NL:PHR:2022:624", "Jurisprudentie", "inkomend"]]);
    expect(p.perInstantie[0].naam).toBe("Gerechtshof 's-Hertogenbosch");
  });

  it("lists the newest case law apart when no type filter is given; says CVDR is not in LiDO", async () => {
    const urls: URL[] = [];
    const r = await lidoRelaties("ECLI:EU:C:2005:321", { max: 1 }, async (u) => { urls.push(new URL(u)); return /get-aantal/.test(u) ? TELLING : LINKS; });
    expect(r.items).toHaveLength(1);
    expect(r.rechtspraak?.[0].id).toBe("ECLI:NL:PHR:2022:624");
    expect(urls.at(-1)!.searchParams.get("fq")).toBe('{!tag=obj_type}obj_type:"Jurisprudentie"');
    const c = await lidoRelaties("CVDR766973", {}, async () => EMPTY);
    expect(c.bekend).toBe(false);
    expect(c.opmerking).toContain("geen decentrale regelgeving");
  });

  it("is registered and answers over MCP with documents grouped per type", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return xmlResponse(/get-aantal/.test(href) ? TELLING : LINKS);
    }));
    const server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const res = (await client.callTool({ name: "lido_relaties", arguments: { id: "ECLI:EU:C:2005:321", type: "Jurisprudentie" } })) as { content: Array<{ text: string }> };
      const d = JSON.parse(res.content[0].text).records[0].data;
      expect(d).toMatchObject({ totaal: 7, filter: { type: "Jurisprudentie" }, totaal_met_filter: 6 });
      expect(Object.keys(d.documenten)).toEqual(["Ministeriële-regeling", "Jurisprudentie"]);
    } finally { await client.close(); await server.close(); }
  });
});
