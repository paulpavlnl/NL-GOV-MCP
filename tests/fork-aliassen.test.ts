import { describe, expect, it } from "vitest";
import { z } from "zod";
import { pasAliassenToe, schemaMetAliassen } from "../src/fork/aliassen.js";
import { zoektermPatroon } from "../src/fork/wetsgeschiedenis.js";

describe("parameter aliases (src/fork/aliassen.ts)", () => {
  it("adds the alias to the schema and makes a required target optional", () => {
    const { shape, vereist } = schemaMetAliassen("officiele_bekendmakingen_record_get", { identifier: z.string(), include_text: z.boolean().optional() });
    expect(Object.keys(shape!)).toEqual(["identifier", "include_text", "id"]);
    expect(z.object(shape!).safeParse({ id: "kst-32137-C" }).success).toBe(true);
    expect(vereist).toEqual(["identifier"]);
  });

  it("moves an alias to its target; the target itself wins", () => {
    expect(pasAliassenToe("officiele_bekendmakingen_record_get", { id: "kst-32137-C" }, ["identifier"])).toEqual({ args: { identifier: "kst-32137-C" }, ontbreekt: [] });
    expect(pasAliassenToe("lido_relaties", { ecli: "ECLI:NL:HR:2019:2006", id: "X" }, []).args).toEqual({ id: "X" });
    expect(pasAliassenToe("literatuur_document_get", { doi: "10.1000/xyz" }, ["werk"]).args).toEqual({ werk: "10.1000/xyz" });
    expect(pasAliassenToe("verdrag_get", { nummer: 9051 }, ["verdrag"]).args).toEqual({ verdrag: "9051" });
    expect(pasAliassenToe("rechtspraak_zoeken_open_data", { zoekterm: "ontslag" }, ["query"]).args).toEqual({ query: "ontslag" });
  });

  it("reports a required parameter that neither name gave", () => {
    expect(pasAliassenToe("officiele_bekendmakingen_record_get", { include_text: true }, ["identifier"]).ontbreekt).toEqual(["identifier"]);
  });

  it("leaves tools without aliases alone", () => {
    const shape = { q: z.string() };
    expect(schemaMetAliassen("cbs_tables_search", shape).shape).toBe(shape);
    expect(pasAliassenToe("cbs_tables_search", { q: "x" }, []).args).toEqual({ q: "x" });
  });
});

describe("wetsgeschiedenis_get search terms", () => {
  it("finds the legislature's synonym and a term over a line break", () => {
    const { re, termen } = zoektermPatroon("uitzonderingsclausule");
    expect(termen).toContain("exceptieclausule");
    expect(re.test("De exceptieclausule van artikel 8 maakt het mogelijk")).toBe(true);
    expect(zoektermPatroon("billijkheid van het resultaat").re.test("de billijkheid van\nhet resultaat")).toBe(true);
  });
});
