import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SparqlLinkedDataSource } from "../src/sources/sparql-linked-data.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

const ENDPOINT = "https://example.org/sparql";
const REMOTE = "<http://remote.example/sparql>";

/** Stub fetch with a small SPARQL-JSON answer and record the query text of every call. */
function stubSparql() {
  const queries: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    queries.push(url.searchParams.get("query") ?? "");
    return jsonResponse({
      head: { vars: ["s"] },
      results: { bindings: [{ s: { type: "uri", value: "http://example.org/a" } }] },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, queries };
}

function source() {
  return new SparqlLinkedDataSource(testConfig, ENDPOINT, "Example");
}

beforeEach(() => clearHttpCache());
afterEach(() => vi.unstubAllGlobals());

describe("SPARQL select validation follows SPARQL's lexical rules", () => {
  // Each of these hid SERVICE from the old per-line comment stripper while the
  // endpoint parses it as a keyword. The error must stay an input error
  // (an InvalidInputError, which the tools report as invalid_input).
  const bypasses: Array<[string, string]> = [
    ["comment ended by a bare CR", `SELECT ?s WHERE { ?s ?p ?o #c\rSERVICE ${REMOTE} { ?a ?b ?c } }`],
    ["lower-case keyword after a bare CR", `SELECT ?s WHERE { ?s ?p ?o #c\rservice ${REMOTE} { ?a ?b ?c } }`],
    ["'#' inside a multi-line long string", `SELECT ?s WHERE { ?s ?p '''\n#''' . SERVICE ${REMOTE} { ?a ?b ?c } }`],
    ["'#' inside a multi-line double-quoted long string", `SELECT ?s WHERE { ?s ?p """\n#""" . SERVICE ${REMOTE} { ?a ?b ?c } }`],
    ["escaped backslash before a closing quote", `SELECT ?s WHERE { ?s ?p "\\\\" . ?s ?q "x#" . SERVICE ${REMOTE} { ?a ?b ?c } }`],
    ["codepoint escape spelling the keyword", `SELECT ?s WHERE { ?s ?p ?o . \\u0053ERVICE ${REMOTE} { ?a ?b ?c } }`],
    ["codepoint escape ending a comment", `SELECT ?s WHERE { ?s ?p ?o #\\u000ASERVICE ${REMOTE} { ?a ?b ?c } }`],
    ["unterminated string", `SELECT ?s WHERE { ?s ?p "open #\nSERVICE ${REMOTE} { ?a ?b ?c } }`],
  ];

  for (const [name, query] of bypasses) {
    it(`rejects ${name} before any request`, async () => {
      const { fetchMock } = stubSparql();
      await expect(source().select({ query, limit: 10 })).rejects.toThrow(/toegestaan/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("still rejects plain SERVICE and SERVICE after an LF- or CRLF-terminated comment", async () => {
    const { fetchMock } = stubSparql();
    for (const query of [
      `SELECT ?s WHERE { SERVICE ${REMOTE} { ?a ?b ?c } }`,
      `SELECT ?s WHERE { ?s ?p ?o #c\nSERVICE ${REMOTE} { ?a ?b ?c } }`,
      `SELECT ?s WHERE { ?s ?p ?o #c\r\nSERVICE ${REMOTE} { ?a ?b ?c } }`,
    ]) {
      await expect(source().select({ query, limit: 10 })).rejects.toThrow(/SERVICE/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts valid queries with comments, CRLF, IRIs and strings holding '#', and sends them unchanged", async () => {
    const { queries } = stubSparql();
    const valid = [
      "PREFIX ex: <http://example.org/def#>\r\n# delete this note later\r\nSELECT ?s WHERE { ?s ex:name ?n }",
      "SELECT ?s WHERE { ?s <http://example.org/def#name> ?n . FILTER(?n < 5) } # trailing note",
      "SELECT ?s WHERE { ?s ?p '''line one\n# not a comment''' . ?s ?q \"a \\\" # b\" }",
      "SELECT ?s WHERE { ?s ?p \"\\\\\" }",
    ];
    for (const query of valid) {
      const out = await source().select({ query, limit: 10 });
      expect(out.items).toHaveLength(1);
    }
    expect(queries).toEqual(valid.map((q) => `${q}\nLIMIT 10`));
  });
});

describe("SPARQL select LIMIT enforcement", () => {
  it("adds an outer LIMIT when the only LIMIT is inside a subquery", async () => {
    const { queries } = stubSparql();
    const query = "SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } LIMIT 5 } ?s ?q ?r }";
    const out = await source().select({ query, limit: 10 });
    expect(queries[0]).toBe(`${query}\nLIMIT 10`);
    expect(out.params.limit).toBe("10");
  });

  it("adds an outer LIMIT when 'LIMIT' only appears in a comment or a string", async () => {
    const { queries } = stubSparql();
    const query = 'SELECT ?s ("limit 1" AS ?note) WHERE { ?s ?p "limit 2" } # limit 3';
    await source().select({ query, limit: 10 });
    expect(queries[0]).toBe(`${query}\nLIMIT 10`);
  });

  it("keeps a top-level LIMIT under the cap and lowers one above it", async () => {
    const { queries } = stubSparql();
    const small = await source().select({ query: "SELECT ?s WHERE { ?s ?p ?o } LIMIT 3", limit: 10 });
    expect(queries[0]).toBe("SELECT ?s WHERE { ?s ?p ?o } LIMIT 3");
    expect(small.params.limit).toBe("3");

    const large = await source().select({ query: "SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } LIMIT 2 } } LIMIT 500;", limit: 10 });
    expect(queries[1]).toBe("SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } LIMIT 2 } } LIMIT 10");
    expect(large.params.limit).toBe("10");
  });

  it("appends a LIMIT when the query has none, in front of a trailing VALUES block", async () => {
    const { queries } = stubSparql();
    await source().select({ query: "SELECT ?s WHERE { ?s ?p ?o }", limit: 7 });
    expect(queries[0]).toBe("SELECT ?s WHERE { ?s ?p ?o }\nLIMIT 7");

    await source().select({ query: "SELECT ?s WHERE { ?s ?p ?o } VALUES ?s { <http://example.org/a> }", limit: 7 });
    expect(queries[1]).toBe("SELECT ?s WHERE { ?s ?p ?o } LIMIT 7\nVALUES ?s { <http://example.org/a> }");
  });
});
