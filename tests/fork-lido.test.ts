/**
 * FORK (docs/FORK.md) — LiDO counts and lists for article references get-id does
 * not know ("6:162" BW, "3:4" Awb), via the label-id from the BWB toestand.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LidoSource } from "../src/sources/lido.js";
import { installLidoArtikelFallback, lidoObjectFromArtikel } from "../src/fork/lido-artikel.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { testConfig, xmlResponse } from "./helpers/config.js";

const HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const AWB_34 = "http://linkeddata.overheid.nl/terms/bwb/id/BWBR0005537/2814224/1994-01-01/1994-01-01";

afterEach(() => {
  vi.unstubAllGlobals();
  clearHttpCache();
  LidoSource.artikelFallback = undefined;
});

describe("LiDO article fallback", () => {
  it("builds the LiDO object from label-id and inwerking", () => {
    expect(lidoObjectFromArtikel({ bwb_id: "BWBR0005537", label_id: "2814224", inwerking: "1994-01-01" })).toBe(AWB_34);
    expect(lidoObjectFromArtikel({ bwb_id: "BWBR0005537" })).toBeNull();
  });

  it("counts references to 3:4 Awb when get-id knows no object for it", async () => {
    const urls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      urls.push(url);
      if (url.pathname.endsWith("/get-id")) return xmlResponse(`${HEAD}<lido service="get-id" juriconnect-ref="BWBR0005537&amp;artikel=3:4"></lido>`);
      return xmlResponse(`${HEAD}<lido service="get-aantal-per-informatietype" id="${AWB_34}"><aantal informatietype-label="Jurisprudentie" url="x">6961</aantal></lido>`);
    }));
    const getArtikel = vi.fn(async () => ({ items: [{ bwb_id: "BWBR0005537", label_id: "2814224", inwerking: "1994-01-01" }] }));
    installLidoArtikelFallback(testConfig, { getArtikel } as never);
    const out = await new LidoSource(testConfig).references({ id: "BWBR0005537", artikel: "3:4" });
    expect(getArtikel).toHaveBeenCalledWith({ bwbId: "BWBR0005537", artikel: "3:4" });
    expect(out.items[0]).toMatchObject({ lido_id: AWB_34, total_references: 6961 });
    expect(urls[1].searchParams.get("id")).toBe(AWB_34);
  });

  it("does not guess when the article number occurs more than once", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse(`${HEAD}<lido service="get-id" juriconnect-ref="x"></lido>`)));
    installLidoArtikelFallback(testConfig, { getArtikel: async () => ({ items: [{ bwb_id: "B", label_id: "1", inwerking: "2000-01-01" }, { bwb_id: "B", label_id: "2", inwerking: "2000-01-01" }] }) } as never);
    const out = await new LidoSource(testConfig).references({ id: "BWBR0005289", artikel: "1" });
    expect(out.items).toEqual([]);
  });
});
