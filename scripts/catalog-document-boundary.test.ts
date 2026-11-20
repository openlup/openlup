import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PERIMETERS = [
  "node_modules/@openlup/core",
  "db/platform",
  "src/domains/catalog",
  "packages/platform/src/catalog",
  "server/domains/catalog",
  "server/adapters/postgres",
] as const;
const PORTABLE_MIGRATION = "db/platform/migrations/20260827220000_catalog_document_revision_foundation.sql";
const PORTABLE_ADAPTER = "packages/platform/src/catalog/catalogSkuEnvelope.ts";
const QUOTE_READER = "packages/platform/src/catalog/commerceQuoteCatalogRead.ts";
const QUOTE_PAYLOAD_SELECT = "revision.document_payload AS revision_document_payload, revision.digest AS revision_digest";
const QUOTE_PAYLOAD_USES = [
  QUOTE_PAYLOAD_SELECT,
  "await verifyDocument(documents[index]!.revision_document_payload, envelope);",
  "revision_document_payload: unknown;",
];
const parsedProvenance = "SyntheticProvenance";
const parsedProvenanceRefusal = "imports or reconstructs provider provenance";

const OPAQUE_CARRIERS = new Map([
  ["db/platform/migrations/20261123190000_catalog_publication.sql", "CROSS JOIN LATERAL (SELECT d.document_payload AS payload) stored"],
  ["server/adapters/postgres/connectedStoreCapture.ts", '"id", "product_id", "revision_no", "schema_id", "document_ref", "document_payload",'],
]);
const documentTable = String.raw`(?:"?public"?\s*\.\s*)?"?catalog_product_document_revisions"?`;

function readsWholeDocument(source: string): boolean {
  const fromDocument = new RegExp(String.raw`\b(?:from|join)\s+(?:only\s+)?${documentTable}(?:\s+(?:as\s+)?("?\w+"?))?`, "i");
  return source.replace(/public\.\$\{(?:identifier|quoted)\(table\)\}/g, "public.catalog_product_document_revisions")
    .split(/[`;]/).some(statement => {
      const table = fromDocument.exec(statement);
      if (!table) return new RegExp(String.raw`^\s*table\s+${documentTable}`, "i").test(statement);
      const fields = statement.slice(0, table.index);
      const candidate = table[1];
      const alias = candidate && !SQL_RESERVED_WORDS.has(candidate.toLowerCase())
        ? candidate.replaceAll('"', "") : "catalog_product_document_revisions";
      return /\bselect\s+(?:distinct(?:\s+on\s*\([^;]*?\))?\s+)?\*/i.test(fields)
        || new RegExp(String.raw`(?:"?${alias}"?\s*\.\s*\*|\b(?:to_jsonb|row_to_json|jsonb?_agg)\s*\(\s*"?${alias}"?\s*\)|\bselect\s+"?${alias}"?\s*$)`, "i").test(fields);
    });
}

interface SourceFile {
  path: string;
  source: string;
}

const SQL_RESERVED_WORDS = new Set("where join left right inner outer full cross on order group limit offset union returning having window fetch for except intersect".split(" "));

function perimeterSources(): SourceFile[] {
  return PERIMETERS.flatMap((perimeter) => walk(join(ROOT, perimeter)).map((path) => ({
    path: relative(ROOT, path),
    source: readFileSync(path, "utf8"),
  })));
}

function walk(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return walk(child);
    return entry.isFile() ? [child] : [];
  });
}

function readsDormantCatalogSkuGtin(source: string): boolean {
  if (/\b(?:public\s*\.\s*)?catalog_skus\s*\.\s*gtin\b/i.test(source)) return true;

  return source.split(";").some((statement) => {
    const select = statement.match(/\bselect\b([\s\S]*?)\bfrom\b/i);
    if (!select) return false;

    const selectList = select[1] ?? "";
    const catalogSkuReferences = Array.from(statement.matchAll(
      /\b(?:from|join)\s+(?:public\s*\.\s*)?catalog_skus\b(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi,
    ));
    if (catalogSkuReferences.length === 0) return false;

    if (/(?:^|[^.\w$])gtin\b/i.test(selectList)) return true;

    return catalogSkuReferences.some((reference) => {
      const alias = reference[1]?.toLowerCase();
      if (!alias || SQL_RESERVED_WORDS.has(alias)) return false;
      return new RegExp(`\\b${alias}\\s*\\.\\s*gtin\\b`, "i").test(selectList);
    });
  });
}

// This exact opt-in reader may transport an unknown value only to host policy.
// Any second selection or other use of the value requires another boundary decision.
function opaqueQuotePayloadPassThrough(source: string, payloadLines: readonly string[]): boolean {
  const uses = source.split("\n").filter((line) => /\brevision_document_payload\b/.test(line)).map((line) => line.trim());
  return payloadLines.length === 1 && payloadLines[0]!.trim() === QUOTE_PAYLOAD_SELECT
    && uses.length === QUOTE_PAYLOAD_USES.length
    && new Set(uses).size === QUOTE_PAYLOAD_USES.length
    && uses.every((line) => QUOTE_PAYLOAD_USES.includes(line));
}

function violations(files: readonly SourceFile[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (/\b(?:ProductDocumentV1|productDocumentV1Schema|productDocumentSchema|CatalogDocumentMappingDraftV1|CatalogDocumentMappingReceiptV1|catalogDocumentMappingDraftV1Schema|catalogDocumentMappingReceiptV1Schema)\b/.test(file.source)) {
      found.push(`${file.path}: private document schema vocabulary is not portable`);
    }
    if (/(?:from\s*|import\s*\()\s*["'][^"']*(?:productDocumentContracts|catalogDocumentMappingContracts|mapCatalogPresentation|compile-catalog-document-mapping|overlays\/[^/]+\/(?:data|tooling)\/catalog)/.test(file.source)) {
      found.push(`${file.path}: imports a private document boundary`);
    }
    if (/\b(?:parse|safeParse|validate|canonicalize)(?:Product)?Document(?:V1)?\b/.test(file.source)) {
      found.push(`${file.path}: parses, validates, or canonicalizes a private document`);
    }
    if (readsDormantCatalogSkuGtin(file.source)) {
      found.push(`${file.path}: reads dormant catalog_skus.gtin`);
    }
    if (file.path === PORTABLE_ADAPTER && new RegExp(`\\b(?:OmniPack|${parsedProvenance})\\b`, "i").test(file.source)) {
      found.push(`${file.path}: ${parsedProvenanceRefusal}`);
    }

    const isTestSource = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.path);
    const payloadLines = file.source
      .split("\n")
      .filter((line) => /\bdocument_payload\b/.test(line) && !line.trimStart().startsWith("--"));
    const opaqueQuoteRead = file.path === QUOTE_READER && opaqueQuotePayloadPassThrough(file.source, payloadLines);
    const opaqueCarrier = payloadLines.length === 1 && payloadLines[0]?.trim() === OPAQUE_CARRIERS.get(file.path);
    if (!isTestSource && readsWholeDocument(file.source)) found.push(`${file.path}: document rows must use explicit projections`);
    const opaqueStorage = file.path === PORTABLE_MIGRATION
      && payloadLines.every((line) => /^\s*document_payload jsonb NOT NULL,\s*$/.test(line));
    if (!isTestSource && (
      (payloadLines.length > 0 && !opaqueStorage && !opaqueQuoteRead && !opaqueCarrier)
      || (file.path === QUOTE_READER && /\brevision_document_payload\b/.test(file.source) && !opaqueQuoteRead)
    )) {
      found.push(`${file.path}: document payload must remain opaque SQL storage only`);
    }
    if (file.path === QUOTE_READER && (
      /\b(?:parse|safeParse|validate|canonicalize)\s*\(/.test(file.source)
      || /\b(?:console|logger)\s*[.[]|\bJSON\s*\.\s*stringify\s*\(/.test(file.source)
    )) {
      found.push(`${file.path}: quote document must pass unparsed to host policy`);
    }
  }
  return found;
}

describe("portable catalog document boundary", () => {
  it("scans exactly the portable/core catalog perimeter", () => {
    const files = perimeterSources();

    expect(files.some(file => file.path.startsWith("node_modules/@openlup/core/src/catalog/") && /\.tsx?$/.test(file.path))).toBe(true);
    expect(files.every(file => PERIMETERS.some(perimeter => file.path.startsWith(`${perimeter}/`)))).toBe(true);
    expect(files.some(file => file.path === PORTABLE_MIGRATION)).toBe(true);
    expect(files.some(file => file.path === PORTABLE_ADAPTER)).toBe(true);
    expect(violations(files)).toEqual([]);
  });

  const handoff = QUOTE_PAYLOAD_USES.join("\n");
  const opaque = "document payload must remain opaque SQL storage only", unparsed = "quote document must pass unparsed to host policy";
  it.each([
    [PORTABLE_MIGRATION, "  document_payload jsonb NOT NULL,", null],
    [QUOTE_READER, handoff, null],
    [PORTABLE_ADAPTER, handoff, opaque],
    [QUOTE_READER, `${handoff}\n${QUOTE_PAYLOAD_SELECT}`, opaque],
    [QUOTE_READER, handoff.replace("revision_document_payload, envelope", "revision_document_payload.title, envelope"), opaque],
    ...["JSON.parse(value);", "console.log(documents);", "logger.info(documents);", "JSON.stringify(documents);"].map(call =>
      [QUOTE_READER, `${handoff}\n${call}`, unparsed] as const),
  ] as const)("preserves the document handoff and custody checks in %s", (path, source, reason) => {
    expect(violations([{ path, source }])).toEqual(reason ? [`${path}: ${reason}`] : []);
  });

  it.each([
    ["SELECT document_payload->>'name' FROM public.catalog_product_document_revisions", "document payload must remain opaque SQL storage only"],
    ["SELECT DISTINCT ON (d.id) * FROM ONLY public.catalog_product_document_revisions d", "document rows must use explicit projections"],
    ["SELECT to_jsonb(catalog_product_document_revisions) FROM public.catalog_product_document_revisions WHERE id=$1", "document rows must use explicit projections"],
    ["SELECT to_jsonb(t) FROM public.${identifier(table)} t", "document rows must use explicit projections"],
    ["privateRules.parseDocument(document)", "parses, validates, or canonicalizes a private document"],
  ])("refuses an ordinary opacity violation: %s", (source, reason) => {
    const path = "server/adapters/postgres/connectedStoreCapture.ts";
    expect(violations([{ path, source }])).toContain(`${path}: ${reason}`);
  });

  it("refuses a second opaque use on the same allowed path", () => {
    const [path, use] = [...OPAQUE_CARRIERS][0]!;
    expect(violations([{ path, source: use }])).toEqual([]);
    expect(violations([{ path, source: `${use}\n${use}` }])).toContain(`${path}: document payload must remain opaque SQL storage only`);
  });

  it.each([
    [PORTABLE_MIGRATION, "SELECT document_payload->>'name' FROM public.catalog_product_document_revisions;", "document payload must remain opaque SQL storage only"],
    [QUOTE_READER, [...QUOTE_PAYLOAD_USES, "console.log(documents);"].join("\n"), "quote document must pass unparsed to host policy"],
    [PORTABLE_ADAPTER, "import { ProductDocumentV1 } from './productDocumentContracts.js';", "imports a private document boundary"],
    [PORTABLE_ADAPTER, "ProductDocumentV1;", "private document schema vocabulary is not portable"],
    [PORTABLE_ADAPTER, "parseDocument(value);", "parses, validates, or canonicalizes a private document"],
    [PORTABLE_ADAPTER, `const source = "${parsedProvenance}";`, parsedProvenanceRefusal],
  ])("refuses %s with %s", (path, source, expected) => {
    expect(violations([{ path, source }])).toContain(`${path}: ${expected}`);
  });

  it("rejects a qualified dormant GTIN read", () => {
    const source = "SELECT sku.gtin FROM public.catalog_skus sku";
    expect(violations([{ path: "server/adapters/postgres/mutated-read.ts", source }])).toEqual([
      "server/adapters/postgres/mutated-read.ts: reads dormant catalog_skus.gtin",
    ]);
  });

  it.each([
    "SELECT identifier.normalized_value FROM catalog_sku_identifiers AS identifier",
    "SELECT identifier.normalized_value FROM catalog_sku_identifiers AS identifier JOIN catalog_skus AS sku ON sku.id = identifier.catalog_sku_id",
    "SELECT identifier.gtin FROM catalog_sku_eans AS identifier JOIN catalog_skus AS sku ON sku.id = identifier.catalog_sku_id",
  ])("allows an identifier-table reference: %s", (source) => {
    expect(violations([{ path: "server/adapters/postgres/identifier-read.ts", source }])).toEqual([]);
  });
});
