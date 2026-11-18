import type { MCPRecord } from "../types.js";

interface RelatedLink {
  target_connector: string;
  target_id: string;
  relationship: "references_law" | "about_municipality" | "related_record";
  url?: string;
}

interface Identifier {
  kind: "ecli" | "bwb_id" | "document_id" | "gemeentecode" | "url";
  value: string;
}

function normalize(value: string): string {
  return value.trim();
}

function addIdentifier(target: Identifier[], kind: Identifier["kind"], value: unknown): void {
  if (typeof value !== "string") return;
  const clean = normalize(value);
  if (!clean) return;
  target.push({ kind, value: clean });
}

/** Different ECLI and BWB ids each taken from a record's title and snippet, at most. */
const MAX_TEXT_IDENTIFIERS = 20;
/** related_links on one record, at most. */
const MAX_RELATED_LINKS = 50;

/** The first MAX_TEXT_IDENTIFIERS different matches, upper-cased; the rest of the text is not searched. */
function firstMatches(text: string, pattern: RegExp, kind: Identifier["kind"], out: Identifier[]): void {
  const seen = new Set<string>();
  for (const m of text.matchAll(pattern)) {
    const value = normalize(m[0].toUpperCase());
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ kind, value });
    if (seen.size >= MAX_TEXT_IDENTIFIERS) return;
  }
}

function extractFromText(text: string): Identifier[] {
  const out: Identifier[] = [];
  firstMatches(text, /ECLI:[A-Z]{2}:[A-Z0-9]+:[0-9]{4}:[A-Z0-9.:-]+/gi, "ecli", out);
  firstMatches(text, /BWBR[0-9]{7,}/gi, "bwb_id", out);
  return out;
}

function extractIdentifiers(record: MCPRecord): Identifier[] {
  const ids: Identifier[] = [];
  const data = (record.data ?? {}) as Record<string, unknown>;

  addIdentifier(ids, "ecli", data.ecli);
  addIdentifier(ids, "bwb_id", data.bwb_id);
  addIdentifier(ids, "bwb_id", data.bwbId);
  addIdentifier(ids, "document_id", data.document_id);
  addIdentifier(ids, "document_id", data.documentId);
  addIdentifier(ids, "gemeentecode", data.gemeentecode);
  addIdentifier(ids, "gemeentecode", data.gemeente_code);
  addIdentifier(ids, "gemeentecode", data.regiocode);

  if (record.canonical_url) ids.push({ kind: "url", value: record.canonical_url });

  const textBlob = `${record.title ?? ""} ${record.snippet ?? ""}`;
  ids.push(...extractFromText(textBlob));

  if (typeof data.url === "string") ids.push({ kind: "url", value: data.url });

  const unique = new Map<string, Identifier>();
  for (const id of ids) {
    const key = `${id.kind}:${id.value.toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, id);
  }

  return Array.from(unique.values());
}

function linkKey(link: RelatedLink): string {
  return `${link.target_connector}|${link.target_id}|${link.relationship}|${link.url ?? ""}`;
}

/**
 * Adds related_links (at most MAX_RELATED_LINKS) to the records in `window`
 * (all records when omitted) and returns those records. A link may point to
 * any record in `records`, also one outside the window.
 */
export function enrichRelatedLinks(records: MCPRecord[], window?: { start: number; end: number }): MCPRecord[] {
  const identifiersPerRecord = records.map((r) => extractIdentifiers(r));
  const occurrences = new Map<string, number[]>();

  for (let i = 0; i < identifiersPerRecord.length; i += 1) {
    for (const id of identifiersPerRecord[i]) {
      const key = `${id.kind}:${id.value.toLowerCase()}`;
      const arr = occurrences.get(key) ?? [];
      arr.push(i);
      occurrences.set(key, arr);
    }
  }

  const start = window?.start ?? 0;
  return records.slice(start, window?.end ?? records.length).map((record, offset) => {
    const idx = start + offset;
    // Deduplicated as they come; full once MAX_RELATED_LINKS different links are in.
    const unique = new Map<string, RelatedLink>();
    const add = (link: RelatedLink): boolean => {
      const key = linkKey(link);
      if (!unique.has(key)) unique.set(key, link);
      return unique.size < MAX_RELATED_LINKS;
    };

    links: for (const id of identifiersPerRecord[idx]) {
      const key = `${id.kind}:${id.value.toLowerCase()}`;
      const matchIndices = occurrences.get(key) ?? [];

      for (const otherIdx of matchIndices) {
        if (otherIdx === idx) continue;
        const other = records[otherIdx];
        const room = add({
          target_connector: other.source_name,
          target_id: id.value,
          relationship: id.kind === "bwb_id" ? "references_law" : id.kind === "gemeentecode" ? "about_municipality" : "related_record",
          url: other.canonical_url,
        });
        if (!room) break links;
      }

      // Add direct cross-reference targets even if not present in current result set.
      if (id.kind === "bwb_id") {
        const room = add({
          target_connector: "officiele_bekendmakingen",
          target_id: id.value,
          relationship: "references_law",
          url: `https://wetten.overheid.nl/${encodeURIComponent(id.value)}`,
        });
        if (!room) break links;
      }

      if (id.kind === "gemeentecode" && record.source_name.toLowerCase().includes("cbs")) {
        const room = add({
          target_connector: "bag_linked_data",
          target_id: id.value,
          relationship: "about_municipality",
          url: `https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?fq=gemeentecode:${encodeURIComponent(id.value)}`,
        });
        if (!room) break links;
      }
    }

    if (!unique.size) return record;

    const data = { ...(record.data ?? {}) } as Record<string, unknown>;
    data.related_links = Array.from(unique.values());

    return {
      ...record,
      data,
    };
  });
}
