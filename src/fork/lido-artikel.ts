/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. LiDO's get-id finds no object for
 * many article references: a BW article written with its book ("6:162" in
 * BWBR0005289, where LiDO knows "162") and articles numbered per chapter
 * ("3:4" Awb). lido_verwijzingen and lido_verwijzingen_lijst then reported 0
 * references for the most cited articles there are. This fallback reads the
 * article's label-id and inwerking from the BWB toestand (as
 * lido_relations_by_identifier does) and builds the LiDO object from them.
 */
import type { AppConfig } from "../types.js";
import { BwbArtikelSource } from "../sources/bwb-artikel.js";
import { LidoSource } from "../sources/lido.js";

export function lidoObjectFromArtikel(a: { bwb_id: string; label_id?: string; inwerking?: string }): string | null {
  return a.label_id && a.inwerking ? `http://linkeddata.overheid.nl/terms/bwb/id/${a.bwb_id}/${a.label_id}/${a.inwerking}/${a.inwerking}` : null;
}

export function installLidoArtikelFallback(config: AppConfig, source: Pick<BwbArtikelSource, "getArtikel"> = new BwbArtikelSource(config)): void {
  LidoSource.artikelFallback = async (bwbId, artikel) => {
    const out = await source.getArtikel({ bwbId, artikel });
    // Several articles with that number (other books, annexes): no guess.
    return out.items.length === 1 ? lidoObjectFromArtikel(out.items[0]) : null;
  };
}
