/**
 * FORK (docs/FORK.md): other names for tool parameters, so a call with the name a caller
 * expects ("id" instead of "identifier", "zoekterm" instead of "query") works instead of
 * failing validation or being silently dropped. Applied to every tool by the registerTool
 * wrapper of installHallucinatieBeveiliging (src/fork/hallucinatie.ts).
 */
import { z } from "zod";

/** Per tool: alias → the parameter it stands for. */
export const ALIASSEN: Record<string, Record<string, string>> = {
  officiele_bekendmakingen_record_get: { id: "identifier" },
  rechtspraak_zoeken_open_data: { zoekterm: "query" },
  lido_relaties: { ecli: "id" },
  literatuur_document_get: { id: "werk", doi: "werk" },
  verdrag_get: { id: "verdrag", nummer: "verdrag" },
};

type Shape = Record<string, z.ZodTypeAny>;
type Args = Record<string, unknown>;

/**
 * The input schema with the aliases added (string or number) and their targets optional,
 * so validation lets an alias through; `vereist` lists the targets that were required.
 */
export function schemaMetAliassen(tool: string, shape: Shape | undefined): { shape: Shape | undefined; vereist: string[] } {
  const al = ALIASSEN[tool];
  if (!al || !shape) return { shape, vereist: [] };
  const uit: Shape = { ...shape };
  const vereist: string[] = [];
  for (const [alias, doel] of Object.entries(al)) {
    const t = uit[doel];
    if (!t) continue;
    if (!t.isOptional()) { vereist.push(doel); uit[doel] = t.optional(); }
    uit[alias] ??= z.union([z.string(), z.number()]).optional().describe(`Alias of ${doel}.`);
  }
  return { shape: uit, vereist: [...new Set(vereist)] };
}

/** The arguments with each alias moved to its target (the target itself wins), and the required targets still missing. */
export function pasAliassenToe(tool: string, args: Args | undefined, vereist: string[]): { args: Args | undefined; ontbreekt: string[] } {
  const al = ALIASSEN[tool];
  if (!al || !args) return { args, ontbreekt: al && vereist.length && !args ? vereist : [] };
  const a: Args = { ...args };
  for (const [alias, doel] of Object.entries(al)) {
    if (a[alias] === undefined) continue;
    if (a[doel] === undefined || a[doel] === "") a[doel] = typeof a[alias] === "number" ? String(a[alias]) : a[alias];
    delete a[alias];
  }
  return { args: a, ontbreekt: vereist.filter((d) => a[d] === undefined || a[d] === "") };
}
