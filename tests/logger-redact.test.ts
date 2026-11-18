import { describe, expect, it, vi } from "vitest";

// Capture what the real logger writes by giving it an in-memory destination.
const written = vi.hoisted(() => [] as string[]);

vi.mock("pino", async (importOriginal) => {
  const actual = await importOriginal<{ default: (options: unknown, stream: unknown) => unknown }>();
  const pino = actual.default;
  const memory = { write: (line: string) => void written.push(line) };
  const wrapped = Object.assign((options: unknown) => pino(options, memory), pino, {
    destination: () => memory,
  });
  return { ...actual, default: wrapped };
});

const { logger } = await import("../src/utils/logger.js");

function lastEntry(): Record<string, unknown> {
  return JSON.parse(written[written.length - 1]) as Record<string, unknown>;
}

describe("logger redaction", () => {
  it("redacts the API key headers the sources send, under headers and req.headers", () => {
    logger.info(
      {
        headers: {
          "x-api-key": "secret-1",
          "X-Api-Key": "secret-2",
          "X-API-Key": "secret-3",
          "ocp-apim-subscription-key": "secret-4",
          "Ocp-Apim-Subscription-Key": "secret-5",
          "x-auth-token": "secret-6",
          "X-AUTH-TOKEN": "secret-7",
          authorization: "Bearer secret-8",
          Accept: "application/json",
        },
        req: {
          headers: {
            "x-api-key": "secret-9",
            "ocp-apim-subscription-key": "secret-10",
            "x-auth-token": "secret-11",
            authorization: "Bearer secret-12",
            host: "localhost:3333",
          },
        },
      },
      "request",
    );

    const line = written[written.length - 1];
    expect(line).not.toMatch(/secret-/);
    const entry = lastEntry() as { headers: Record<string, unknown>; req: { headers: Record<string, unknown> } };
    expect(entry.headers["x-api-key"]).toBe("[Redacted]");
    expect(entry.headers["Ocp-Apim-Subscription-Key"]).toBe("[Redacted]");
    expect(entry.req.headers["x-auth-token"]).toBe("[Redacted]");
  });

  it("keeps ordinary fields and headers readable", () => {
    logger.info({ headers: { Accept: "application/json" }, req: { headers: { host: "localhost:3333" } }, url: "https://example.org/x" }, "request");
    const entry = lastEntry() as { headers: Record<string, unknown>; req: { headers: Record<string, unknown> }; url: string; msg: string };
    expect(entry.headers.Accept).toBe("application/json");
    expect(entry.req.headers.host).toBe("localhost:3333");
    expect(entry.url).toBe("https://example.org/x");
    expect(entry.msg).toBe("request");
  });
});
