// Live check of the Rechtspraak search through Open Data (docs/FORK.md): npx tsx scripts/live-rechtspraak-zoeken.ts
import { loadConfig } from "../src/config.js";
import { installRechtspraakOpenData, searchRechtspraakOpenData, type OpenDataSearchArgs } from "../src/fork/rechtspraak-open-data.js";
import { RechtspraakSource } from "../src/sources/rechtspraak.js";

installRechtspraakOpenData();
const src = new RechtspraakSource(loadConfig());
const cases: Array<OpenDataSearchArgs & { via: "search_ecli" | "open_data" }> = [
  { via: "search_ecli", query: "ontslag op staande voet", rows: 5 },
  { via: "search_ecli", query: "kinderalimentatie draagkracht", rows: 3 },
  { via: "open_data", query: "transitievergoeding", rows: 3, instantie: "Hoge Raad", van: "2015-01-01" },
  { via: "open_data", query: "WIA arbeidsongeschiktheid", rows: 3, instantie: "CRvB" },
  { via: "search_ecli", query: "huurprijs gebreken", rows: 3, sort: "ruling_newest" },
  { via: "search_ecli", query: "redelijkheid en billijkheid", rows: 3, date_filter: "month" },
  { via: "open_data", query: "ontslag", rows: 3, rechtsgebied: "arbeidsrecht", procedure: "kort geding" },
  { via: "open_data", query: "relatiebeding", rows: 3, rechtsgebied: "arbeidsrecht", volledige_tekst: true, max_documenten: 100 },
  { via: "open_data", query: "omgangsregeling", rows: 3, instantie: "Gerechtshof Den Haag", procedure: "hoger beroep" },
];
for (const { via, ...c } of cases) {
  const t0 = Date.now();
  const out = via === "search_ecli" ? await src.searchEcli(c) : await searchRechtspraakOpenData(c);
  console.log(`\n== ${via} ${JSON.stringify(c)} (${Date.now() - t0} ms): ${out.items.length} getoond, ${out.total} gevonden`);
  console.log(`   ${(out as { access_note?: string }).access_note ?? ""}`);
  for (const x of out.items) console.log(`   - ${x.title}${x.gedeeltelijke_match ? ` [${x.gedeeltelijke_match}]` : ""}${x.procedures ? ` {${(x.procedures as string[]).join(", ")}}` : ""}${x.gevonden_in === "volledige tekst" ? " (volledige tekst)" : ""}\n     ${String(x.passage ?? x.summary).slice(0, 140)}`);
}
