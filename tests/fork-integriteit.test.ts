// FORK (docs/FORK.md): bewaakt na elke upstream-sync dat de eigen tools er nog zijn en dat
// eigen HTTP-opties niet stil wegvallen in herschreven upstream-code.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { getJson } from "../src/utils/http.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";

const { tools: FORK_TOOLS } = JSON.parse(readFileSync(new URL("../data/fork-tools.json", import.meta.url), "utf8")) as { tools: string[] };

afterEach(() => {
  vi.unstubAllGlobals();
  clearHttpCache();
});

describe("fork-integriteit", () => {
  it("createServer registreert elke eigen tool uit data/fork-tools.json", () => {
    const registered = Object.keys((createServer() as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    const missing = FORK_TOOLS.filter((name) => !registered.includes(name));
    expect(missing, `eigen tools ontbreken na de merge: ${missing.join(", ")}`).toEqual([]);
  });

  it("de dispatcher-optie (ip-herkansing) bereikt fetch, ook via de redirect-lus", async () => {
    const dispatcher = { naam: "test-dispatcher" };
    const seen: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: Record<string, unknown>) => {
      seen.push(init?.dispatcher);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
    await getJson("https://example.org/fork-integriteit", { dispatcher, cache: false } as never);
    expect(seen).toEqual([dispatcher]);
  });
});
