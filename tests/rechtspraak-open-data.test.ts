import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  installRechtspraakOpenData,
  parseOpenDataFeed,
  resolveInstanties,
  resolveRechtsgebieden,
  searchRechtspraakOpenData,
} from "../src/fork/rechtspraak-open-data.js";
import { RechtspraakSource } from "../src/sources/rechtspraak.js";

const config = loadConfig();

const FEED = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title type="text">Rechtspraak Open Data (Uitspraken)</title><subtitle type="text">Aantal gevonden ECLI's: 3</subtitle>
<entry><id>ECLI:NL:RBZWB:2026:9950</id><title type="text">ECLI:NL:RBZWB:2026:9950, Rechtbank Zeeland-West-Brabant, 07-10-2026, 12226719 \\ AZ VERZ 26-60</title><summary type="text">Ontslag op staande voet. Vreemd gedrag van werknemer leidt tot schorsing &amp; ontslag.</summary><updated>2026-10-23T14:02:53Z</updated><link rel="alternate" type="text/html" href="https://uitspraken.rechtspraak.nl/details?id=ECLI:NL:RBZWB:2026:9950" /></entry>
<entry><id>ECLI:NL:RBROT:2026:14701</id><title type="text">ECLI:NL:RBROT:2026:14701, Rechtbank Rotterdam, 26-10-2026, 12217484 VZ VERZ 26-2288</title><summary type="text">Transitievergoeding en loonvordering. Werknemer is AOW-gerechtigd.</summary><updated>2026-10-26T10:37:26Z</updated><link rel="alternate" type="text/html" href="https://uitspraken.rechtspraak.nl/details?id=ECLI:NL:RBROT:2026:14701" /></entry>
<entry deleted="doc"><id>ECLI:NL:RBAMS:2026:1</id><title type="text">ECLI:NL:RBAMS:2026:1, Rechtbank Amsterdam, 01-01-2026, 1</title><updated>2026-10-01</updated></entry>
</feed>`;

const atom = () => new Response(FEED, { status: 200, headers: { "content-type": "application/atom+xml" } });
const urlOf = (input: string | URL | Request) => String(input instanceof Request ? input.url : input);

describe("Open Data van de Rechtspraak: feed and filters", () => {
  it("reads the entries of an ECLI-index feed, without deleted entries", () => {
    const feed = parseOpenDataFeed(FEED);
    expect(feed.total).toBe(3);
    expect(feed.entries).toHaveLength(2);
    expect(feed.entries[0]).toMatchObject({
      ecli: "ECLI:NL:RBZWB:2026:9950",
      instantie: "Rechtbank Zeeland-West-Brabant",
      uitspraakdatum: "2026-10-07",
      zaaknummer: "12226719 \\ AZ VERZ 26-60",
      link: "https://uitspraken.rechtspraak.nl/details?id=ECLI:NL:RBZWB:2026:9950",
    });
    expect(feed.entries[0].inhoudsindicatie).toContain("schorsing & ontslag");
  });

  it("takes a rechtsgebied by name, and derives one from the keywords", () => {
    expect(resolveRechtsgebieden("arbeidsrecht", "").ids).toEqual(["civielRecht_arbeidsrecht"]);
    expect(resolveRechtsgebieden("Personen- en familierecht", "").ids).toEqual(["civielRecht_personenEnFamilierecht"]);
    expect(resolveRechtsgebieden(undefined, "ontslag op staande voet")).toMatchObject({ ids: ["civielRecht_arbeidsrecht"], bron: "afgeleid" });
    expect(resolveRechtsgebieden(undefined, "kinderalimentatie draagkracht").ids).toEqual(["civielRecht_personenEnFamilierecht"]);
    expect(resolveRechtsgebieden(undefined, "redelijkheid")).toMatchObject({ ids: [], bron: "geen" });
    expect(resolveRechtsgebieden("tuinrecht", "")).toMatchObject({ ids: [], onbekend: "tuinrecht" });
  });

  it("takes an instantie by ECLI code or name", () => {
    expect(resolveInstanties("HR").uris).toEqual(["http://standaarden.overheid.nl/owms/terms/Hoge_Raad_der_Nederlanden"]);
    expect(resolveInstanties("CRvB, hof Den Haag").namen).toEqual(["Centrale Raad van Beroep", "Gerechtshof Den Haag"]);
    expect(resolveInstanties("Rechtbank Mars").onbekend).toEqual(["Rechtbank Mars"]);
  });
});

describe("Rechtspraak search through Open Data", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rechtspraak_search_ecli falls back to data.rechtspraak.nl on HTTP 403 and matches the words in the inhoudsindicaties", async () => {
    installRechtspraakOpenData();
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input);
      urls.push(url);
      if (url.includes("/api/zoek")) return new Response("<html>Request Rejected</html>", { status: 403, headers: { "content-type": "text/html" } });
      return atom();
    }));
    const out = await new RechtspraakSource(config).searchEcli({ query: "ontslag staande voet", rows: 5 });
    expect(out.items.map((x) => x.ecli)).toEqual(["ECLI:NL:RBZWB:2026:9950"]);
    expect((out as { access_note?: string }).access_note).toContain("HTTP 403");
    expect((out as { access_note?: string }).access_note).toContain("Arbeidsrecht (afgeleid uit de zoekwoorden)");
    const od = new URL(urls.find((u) => u.includes("data.rechtspraak.nl/uitspraken/zoeken"))!);
    expect(od.searchParams.get("return")).toBe("DOC");
    expect(od.searchParams.get("sort")).toBe("DESC");
    expect(od.searchParams.getAll("subject")).toEqual(["http://psi.rechtspraak.nl/rechtsgebied#civielRecht_arbeidsrecht"]);
  });

  it("filters on instantie and a period, as creator and two date parameters", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      urls.push(urlOf(input));
      return atom();
    }));
    const out = await searchRechtspraakOpenData({ query: "transitievergoeding", rows: 5, instantie: "Rechtbank Rotterdam", van: "2026-01-01", tot: "2026-10-26" });
    const od = new URL(urls[0]);
    expect(od.searchParams.getAll("creator")).toEqual(["http://standaarden.overheid.nl/owms/terms/Rechtbank_Rotterdam"]);
    expect(od.searchParams.getAll("date")).toEqual(["2026-01-01", "2026-10-26"]);
    expect(out.items.map((x) => x.ecli)).toEqual(["ECLI:NL:RBROT:2026:14701"]);
  });

  it("returns nothing, with a note, when no inhoudsindicatie has the words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => atom()));
    const out = await searchRechtspraakOpenData({ query: "erfpacht", rows: 5, rechtsgebied: "goederenrecht" });
    expect(out.items).toEqual([]);
    expect(out.access_note).toContain("Geen uitspraak gevonden");
  });
});

describe("FORK couplings in upstream files (docs/FORK.md)", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  it("are still there after an upstream sync", () => {
    expect(read("src/fork/eu-tools.ts")).toContain("registerRechtspraakOpenData(server, deps);");
    expect(read("src/sources/rechtspraak.ts")).toMatch(/connector: "rechtspraak_zoek", \/\/ FORK/);
    expect(read("src/utils/connector-runtime.ts")).toMatch(/rechtspraak_open_data: "semi_live"/);
    expect(read("src/sources/rechtspraak.ts")).toMatch(/async searchEcli\(/);
  });
});
