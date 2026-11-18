import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearHttpCache, getConnectorHealth, markConnectorFailure } from "../src/utils/connector-runtime.js";
import { getJson, postJson, SourceRequestError } from "../src/utils/http.js";

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown; redirect?: string };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

/** A fetch stub answering per URL, recording what each request carried. */
function routedFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: String(init?.method ?? "GET"),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: init?.body,
      redirect: init?.redirect,
    });
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

function lowerKeys(headers: Record<string, string>): string[] {
  return Object.keys(headers).map((k) => k.toLowerCase()).sort();
}

/** Opens the circuit of a connector the way three upstream failures do. */
function openCircuit(connector: string): void {
  for (let i = 0; i < 3; i += 1) markConnectorFailure(connector, { countTowardCircuit: true });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearHttpCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request(): redirects", () => {
  it("does not carry the caller's key headers to another origin, keeps the generic ones and reports the final URL", async () => {
    const { calls } = routedFetch({
      "https://gateway.example/data?x=1": () => redirect(302, "https://elsewhere.example/landing"),
      "https://elsewhere.example/landing": () => jsonResponse([{ ok: true }]),
    });

    const { data, meta } = await getJson<unknown[]>("https://gateway.example/data", {
      query: { x: 1 },
      headers: { "X-Api-Key": "secret-1", "Ocp-Apim-Subscription-Key": "secret-2", Accept: "application/json" },
      connector: "test_redirect_cross",
      disableCache: true,
      retries: 0,
    });

    expect(data).toEqual([{ ok: true }]);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
    expect(calls[0].headers["X-Api-Key"]).toBe("secret-1");
    expect(lowerKeys(calls[1].headers)).toEqual(["accept", "user-agent"]);
    expect(JSON.stringify(calls[1].headers)).not.toContain("secret");
    // meta.url keeps naming the URL asked; finalUrl names the one that answered.
    expect(meta.url).toBe("https://gateway.example/data?x=1");
    expect(meta.finalUrl).toBe("https://elsewhere.example/landing");
  });

  it("keeps the headers off for the rest of the chain, also when it comes back to the first origin", async () => {
    const { calls } = routedFetch({
      "https://gateway.example/a": () => redirect(301, "https://elsewhere.example/b"),
      "https://elsewhere.example/b": () => redirect(307, "https://gateway.example/c"),
      "https://gateway.example/c": () => jsonResponse({ ok: 1 }),
    });

    await getJson("https://gateway.example/a", { headers: { "X-Api-Key": "secret-1" }, connector: "test_redirect_back", disableCache: true, retries: 0 });

    expect(calls.map((c) => c.url)).toEqual(["https://gateway.example/a", "https://elsewhere.example/b", "https://gateway.example/c"]);
    expect(calls[2].headers["X-Api-Key"]).toBeUndefined();
  });

  it("control: a same-origin redirect keeps the caller's headers", async () => {
    const { calls } = routedFetch({
      "https://gateway.example/old": () => redirect(308, "/new"),
      "https://gateway.example/new": () => jsonResponse({ ok: 1 }),
    });

    const { meta } = await getJson("https://gateway.example/old", { headers: { "X-Api-Key": "secret-1" }, connector: "test_redirect_same", disableCache: true, retries: 0 });

    expect(calls[1].headers["X-Api-Key"]).toBe("secret-1");
    expect(meta.finalUrl).toBe("https://gateway.example/new");
  });

  it("control: without a redirect there is one request and no finalUrl", async () => {
    const { calls } = routedFetch({ "https://gateway.example/plain": () => jsonResponse({ ok: 1 }) });

    const { meta } = await getJson("https://gateway.example/plain", { headers: { "X-Api-Key": "secret-1" }, connector: "test_redirect_none", disableCache: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].headers["X-Api-Key"]).toBe("secret-1");
    expect(meta.url).toBe("https://gateway.example/plain");
    expect(meta.finalUrl).toBeUndefined();
  });

  it("turns a POST into a GET without body on 303, and keeps POST and body on 307", async () => {
    const see = routedFetch({
      "https://gateway.example/post": () => redirect(303, "/result"),
      "https://gateway.example/result": () => jsonResponse({ ok: 1 }),
    });
    await postJson("https://gateway.example/post", { q: 1 }, { connector: "test_redirect_303", retries: 0, disableCache: true });
    expect(see.calls[1]).toMatchObject({ method: "GET", body: undefined });
    expect(lowerKeys(see.calls[1].headers)).not.toContain("content-type");

    const keep = routedFetch({
      "https://gateway.example/post": () => redirect(307, "/again"),
      "https://gateway.example/again": () => jsonResponse({ ok: 1 }),
    });
    await postJson("https://gateway.example/post", { q: 1 }, { connector: "test_redirect_307", retries: 0, disableCache: true });
    expect(keep.calls[1]).toMatchObject({ method: "POST", body: JSON.stringify({ q: 1 }) });
  });

  it("stops after a small number of hops", async () => {
    const { calls } = routedFetch({ "https://gateway.example/loop": () => redirect(302, "https://gateway.example/loop") });

    await expect(
      getJson("https://gateway.example/loop", { connector: "test_redirect_loop", disableCache: true, retries: 0 }),
    ).rejects.toMatchObject({ code: "network_error" });
    expect(calls.length).toBeLessThanOrEqual(6);
  });
});

describe("request(): a time budget the caller chose", () => {
  function hangingFetch() {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("does not count its timeouts toward the shared circuit", async () => {
    hangingFetch();
    for (let i = 0; i < 4; i += 1) {
      await expect(
        getJson("https://slow.example/x", { connector: "test_budget", timeoutMs: 30, retries: 0, disableCache: true, callerBudget: true }),
      ).rejects.toMatchObject({ code: "timeout" });
    }
    const health = getConnectorHealth("test_budget");
    expect(health.circuit_open).toBe(false);
    expect(health.consecutive_failures).toBe(0);
    expect(health.total_failures).toBe(4);
  });

  it("control: timeouts without a caller budget still open the circuit", async () => {
    hangingFetch();
    for (let i = 0; i < 3; i += 1) {
      await expect(
        getJson("https://slow.example/x", { connector: "test_no_budget", timeoutMs: 30, retries: 0, disableCache: true }),
      ).rejects.toMatchObject({ code: "timeout" });
    }
    expect(getConnectorHealth("test_no_budget").circuit_open).toBe(true);
  });
});

describe("request(): the circuit is checked again", () => {
  it("ends a queued request with circuit_open when the circuit opened while it waited", async () => {
    const connector = "test_recheck_queue";
    let releaseFirst: (r: Response) => void = () => {};
    let n = 0;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      n += 1;
      if (n === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve; });
      // The other two hold their slots until their own timeout.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const opts = { connector, disableCache: true, retries: 0, timeoutMs: 2_000 };
    const first = getJson("https://queue.example/1", opts);
    void getJson("https://queue.example/2", opts).catch(() => {});
    void getJson("https://queue.example/3", opts).catch(() => {});
    const queued = getJson("https://queue.example/4", opts);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(getConnectorHealth(connector).queue_depth).toBe(1);

    openCircuit(connector);
    releaseFirst(new Response("gone", { status: 404 }));
    await expect(first).rejects.toMatchObject({ status: 404 });

    await expect(queued).rejects.toMatchObject({ code: "circuit_open" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("ends a request before its retry when the circuit opened in between", async () => {
    const connector = "test_recheck_retry";
    const fetchMock = vi.fn(async () => {
      // Other callers' failures open the circuit while this request waits to retry.
      openCircuit(connector);
      return new Response("unavailable", { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getJson("https://retry.example/x", { connector, disableCache: true, retries: 2 }),
    ).rejects.toMatchObject({ code: "circuit_open" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("control: the half-open probe may retry and closes the circuit on success", async () => {
    const connector = "test_recheck_probe";
    openCircuit(connector);
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 301_000);

    let n = 0;
    const fetchMock = vi.fn(async () => (n++ === 0 ? new Response("unavailable", { status: 503 }) : jsonResponse({ ok: 1 })));
    vi.stubGlobal("fetch", fetchMock);

    const { data } = await getJson("https://probe.example/x", { connector, disableCache: true, retries: 1 });
    expect(data).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getConnectorHealth(connector)).toMatchObject({ circuit_open: false, consecutive_failures: 0 });
  });
});

describe("request(): the wait queue per connector has a cap", () => {
  it("fails at once beyond 50 waiting requests, and serves the ones within the cap", async () => {
    const connector = "test_queue_cap";
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const fetchMock = vi.fn(async () => {
      await gate;
      return jsonResponse({ ok: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const opts = { connector, disableCache: true, retries: 0, timeoutMs: 10_000 };
    const accepted = Array.from({ length: 53 }, (_, i) => getJson(`https://cap.example/${i}`, opts));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(getConnectorHealth(connector).queue_depth).toBe(50);

    const started = Date.now();
    const overflow = getJson("https://cap.example/overflow", opts);
    await expect(overflow).rejects.toBeInstanceOf(SourceRequestError);
    await expect(overflow).rejects.toMatchObject({ code: "rate_limited" });
    expect(Date.now() - started).toBeLessThan(1_000);

    open();
    const results = await Promise.all(accepted);
    expect(results).toHaveLength(53);
    expect(fetchMock).toHaveBeenCalledTimes(53);
  });
});
