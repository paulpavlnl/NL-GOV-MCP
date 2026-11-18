import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";
import { InvalidInputError } from "../utils/response.js";

interface SparqlJsonBindingValue {
  type?: string;
  value?: string;
  datatype?: string;
  [key: string]: unknown;
}

interface SparqlJsonResponse {
  head?: { vars?: string[] };
  results?: { bindings?: Array<Record<string, SparqlJsonBindingValue>> };
}

export const SPARQL_LIMIT_CAP = 100;

/** What a refused query is told: the form the validator accepts. */
const SPARQL_INPUT_SUGGESTION =
  `Gebruik een read-only SELECT query (PREFIX-regels ervoor mogen) met een kleine LIMIT (max ${SPARQL_LIMIT_CAP}); ` +
  "INSERT, DELETE, LOAD, CLEAR, CREATE, DROP, COPY, MOVE, ADD, CONSTRUCT, DESCRIBE, ASK, SERVICE en WITH, " +
  "\\u- of \\U-escapes en onafgesloten strings worden geweigerd.";

const BLOCKED_KEYWORDS = [
  "insert",
  "delete",
  "load",
  "clear",
  "create",
  "drop",
  "copy",
  "move",
  "add",
  "construct",
  "describe",
  "ask",
  "service",
  "with",
];

// Characters a SPARQL IRIREF may hold between '<' and '>'.
const IRI_CHAR = /[^<>"{}|^`\\\x00-\x20]/;

interface SparqlScan {
  /** The query with every comment blanked out; same length as the query. */
  withoutComments: string;
  /** The query with comments, strings, IRIs and everything inside braces blanked out. */
  topLevel: string;
}

// Lexes the query by SPARQL's own rules, so the text the validator checks is the
// text the endpoint parses: a comment runs from '#' to CR or LF, a string may be
// long ('''...''' or """...""") and span lines, a backslash escapes the next
// character, and '<' opens an IRI only when a valid IRIREF follows.
function scanSparql(query: string): { ok: true; scan: SparqlScan } | { ok: false; reason: string } {
  // Codepoint escapes are decoded before the SPARQL grammar applies, so an escaped
  // letter inside a keyword, or an escaped line feed after '#', would mean something
  // else to the endpoint than to this check.
  if (/\\[uU]/.test(query)) {
    return { ok: false, reason: "Unicode-escapes (\\u, \\U) zijn niet toegestaan in de SPARQL query." };
  }

  const withoutComments = query.split("");
  const topLevel = query.split("");
  const blank = (from: number, to: number, comment: boolean) => {
    for (let k = from; k < to; k++) {
      topLevel[k] = " ";
      if (comment) withoutComments[k] = " ";
    }
  };

  let depth = 0;
  let i = 0;
  while (i < query.length) {
    const c = query[i];
    if (c === "#") {
      let end = i;
      while (end < query.length && query[end] !== "\n" && query[end] !== "\r") end++;
      blank(i, end, true);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = query.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + quote.length;
      let end = -1;
      while (j < query.length) {
        if (query[j] === "\\") {
          j += 2;
          continue;
        }
        if (quote.length === 1 && (query[j] === "\n" || query[j] === "\r")) break;
        if (query.startsWith(quote, j)) {
          end = j + quote.length;
          break;
        }
        j++;
      }
      if (end < 0) {
        return { ok: false, reason: "Een onafgesloten string is niet toegestaan in de SPARQL query." };
      }
      blank(i, end, false);
      i = end;
      continue;
    }
    if (c === "<") {
      let j = i + 1;
      while (j < query.length && IRI_CHAR.test(query[j])) j++;
      if (query[j] === ">") {
        blank(i, j + 1, false);
        i = j + 1;
        continue;
      }
    }
    if (c === "{") depth++;
    if (depth > 0) topLevel[i] = " ";
    if (c === "}") depth = Math.max(0, depth - 1);
    i++;
  }

  return { ok: true, scan: { withoutComments: withoutComments.join(""), topLevel: topLevel.join("") } };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary regexes voor elk geblokkeerd keyword. \b matcht ook grenzen naar
// niet-woordtekens zoals '{', '<' en '"', zodat obfuscaties als "{SERVICE<...>}"
// of '"delete"' alsnog worden herkend (de space-padding-check miste die).
const BLOCKED_KEYWORD_PATTERNS = BLOCKED_KEYWORDS.map(
  (word) => ({ word, regex: new RegExp(`\\b${escapeRegExp(word)}\\b`, "i") }),
);

function validateSelectOnly(scan: SparqlScan): { ok: boolean; reason?: string } {
  const normalized = scan.withoutComments.replace(/\s+/g, " ").trim();
  const noPrefix = normalized.replace(/^(prefix\s+[^>]+>\s*)+/i, "").trim();

  if (!/^select\b/i.test(noPrefix)) {
    return { ok: false, reason: "Alleen SELECT queries zijn toegestaan." };
  }

  for (const { word, regex } of BLOCKED_KEYWORD_PATTERNS) {
    if (regex.test(noPrefix)) {
      return { ok: false, reason: `SPARQL keyword niet toegestaan: ${word.toUpperCase()}` };
    }
  }

  return { ok: true };
}

// Only a LIMIT at the top level bounds the result; one inside a subquery, string,
// IRI or comment is blanked out of scan.topLevel and does not count.
const TOP_LEVEL_LIMIT = /(?<![\w?$:.-])limit(\s+)(\d+)\b/gi;
const TOP_LEVEL_VALUES = /(?<![\w?$:.-])values\b/i;

function enforceLimit(query: string, scan: SparqlScan, requestedLimit: number): { safeQuery: string; appliedLimit: number } {
  const cap = Math.max(1, Math.min(SPARQL_LIMIT_CAP, requestedLimit));
  const limits = [...scan.topLevel.matchAll(TOP_LEVEL_LIMIT)];
  if (!limits.length) {
    // A trailing VALUES block must stay last, so the LIMIT goes in front of it.
    const values = TOP_LEVEL_VALUES.exec(scan.topLevel);
    if (values) {
      return { safeQuery: `${query.slice(0, values.index)}LIMIT ${cap}\n${query.slice(values.index)}`, appliedLimit: cap };
    }
    return { safeQuery: `${query}\nLIMIT ${cap}`, appliedLimit: cap };
  }

  // scan.topLevel has the same length as the query, so match positions apply to it.
  let safeQuery = query;
  let appliedLimit = cap;
  for (const match of limits.reverse()) {
    const digits = match[2];
    const start = (match.index ?? 0) + match[0].length - digits.length;
    const currentLimit = Number(digits);
    if (currentLimit > cap) {
      safeQuery = `${safeQuery.slice(0, start)}${cap}${safeQuery.slice(start + digits.length)}`;
    }
    appliedLimit = Math.min(appliedLimit, currentLimit);
  }
  return { safeQuery, appliedLimit };
}

function bindingToValue(binding: SparqlJsonBindingValue | undefined): unknown {
  if (!binding) return undefined;
  if (binding.datatype?.endsWith("#integer") || binding.datatype?.endsWith("#decimal") || binding.datatype?.endsWith("#double")) {
    const asNum = Number(binding.value);
    if (!Number.isNaN(asNum)) return asNum;
  }
  if (binding.datatype?.endsWith("#boolean")) {
    return String(binding.value).toLowerCase() === "true";
  }
  return binding.value;
}

export class SparqlLinkedDataSource {
  constructor(
    private readonly config: AppConfig,
    private readonly endpoint: string,
    private readonly sourceLabel: string,
  ) {}

  async select(args: { query: string; limit: number }) {
    // Validate exactly the text that is sent, apart from the LIMIT that enforceLimit sets.
    const query = args.query.trim().replace(/;\s*$/, "");
    const scanned = scanSparql(query);
    if (!scanned.ok) {
      throw new InvalidInputError(scanned.reason, SPARQL_INPUT_SUGGESTION);
    }
    const validation = validateSelectOnly(scanned.scan);
    if (!validation.ok) {
      throw new InvalidInputError(validation.reason ?? "Ongeldige SPARQL query", SPARQL_INPUT_SUGGESTION);
    }

    const { safeQuery, appliedLimit } = enforceLimit(query, scanned.scan, args.limit);

    const { data, meta } = await getJson<SparqlJsonResponse>(this.endpoint, {
      query: {
        query: safeQuery,
        format: "application/sparql-results+json",
      },
      headers: {
        Accept: "application/sparql-results+json",
      },
      timeoutMs: 20_000,
      retries: 1,
    });

    const vars = Array.isArray(data.head?.vars) ? data.head?.vars ?? [] : [];
    const bindings = Array.isArray(data.results?.bindings) ? data.results?.bindings ?? [] : [];

    const items = bindings.slice(0, appliedLimit).map((binding) => {
      const out: Record<string, unknown> = {};
      for (const v of vars) {
        out[v] = bindingToValue(binding[v]);
      }
      return out;
    });

    return {
      items,
      total: bindings.length,
      endpoint: meta.url,
      params: {
        limit: String(appliedLimit),
      },
      safeQuery,
      source: this.sourceLabel,
      ...(items.length ? {} : { access_note: `${this.sourceLabel} endpoint bereikbaar, maar query leverde geen bindings op.` }),
    };
  }
}
