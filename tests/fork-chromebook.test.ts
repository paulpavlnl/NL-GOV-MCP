import { describe, expect, it } from "vitest";
import { amsterdamNaarMs, msNaarAmsterdam, chromebookBlokken } from "../src/fork/chromebook.js";

describe("chromebook (FORK)", () => {
  it("rekent lokale tijd om, ook rond de zomertijd", () => {
    expect(new Date(amsterdamNaarMs("2026-11-12T15:50:00")).toISOString()).toBe("2026-11-12T14:50:00.000Z");
    expect(new Date(amsterdamNaarMs("2026-07-01")).toISOString()).toBe("2026-06-30T22:00:00.000Z");
    expect(msNaarAmsterdam(Date.parse("2026-11-12T14:50:00Z"))).toBe("2026-11-12T15:50:00");
    expect(Number.isNaN(amsterdamNaarMs("12-11-2026"))).toBe(true);
  });

  it("kapt af op de periode en voegt gelijke opeenvolgende stukken samen", () => {
    const t = (hm: string) => amsterdamNaarMs(`2026-11-12T${hm}`);
    const segs = [
      { id: "a", startMs: t("15:40:00"), endMs: t("15:55:00"), domain: "claude.ai", title: "Claude" },
      { id: "b", startMs: t("15:55:02"), endMs: t("16:00:00"), domain: "claude.ai", title: "Claude" },
      { id: "c", startMs: t("16:00:00"), endMs: t("16:10:00"), domain: "nrc.nl", title: "NRC" },
      { id: "d", startMs: t("18:00:00"), endMs: t("18:10:00"), domain: "x.nl", title: "X" },
    ];
    const b = chromebookBlokken(segs, t("15:50:00"), t("17:20:00"));
    expect(b.map((x) => [msNaarAmsterdam(x.startMs).slice(11), msNaarAmsterdam(x.endMs).slice(11), x.domain])).toEqual([
      ["15:50:00", "16:00:00", "claude.ai"],
      ["16:00:00", "16:10:00", "nrc.nl"],
    ]);
  });
});
