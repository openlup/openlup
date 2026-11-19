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
const parsedProvenance = "OmniPack";
const parsedProvenanceRefusal = `imports or reconstructs ${parsedProvenance} provenance`;

interface SourceFile {
  path: string;
  source: string;
}

const SQL_RESERVED_WORDS = new Set([
  "where",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "cross",
  "on",
  "order",
  "group",
  "limit",
  "offset",
  "union",
  "returning",
]);

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
    if (file.path === PORTABLE_ADAPTER && new RegExp(`\\b${parsedProvenance}\\b`, "i").test(file.source)) {
      found.push(`${file.path}: ${parsedProvenanceRefusal}`);
    }

    const isTestSource = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.path);
    const payloadLines = file.source
      .split("\n")
      .filter((line) => /\bdocument_payload\b/.test(line) && !line.trimStart().startsWith("--"));
    const opaqueQuoteRead = file.path === QUOTE_READER && opaqueQuotePayloadPassThrough(file.source, payloadLines);
    const opaqueStorage = file.path === PORTABLE_MIGRATION
      && payloadLines.every((line) => /^\s*document_payload jsonb NOT NULL,\s*$/.test(line));
    if (!isTestSource && (
      (payloadLines.length > 0 && !opaqueStorage && !opaqueQuoteRead)
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

  it.each([
    [PORTABLE_MIGRATION, "SELECT document_payload->>'name' FROM public.catalog_product_document_revisions;", "document payload must remain opaque SQL storage only"],
    [QUOTE_READER, [...QUOTE_PAYLOAD_USES, "console.log(documents);"].join("\n"), "quote document must pass unparsed to host policy"],
    [PORTABLE_ADAPTER, "import { ProductDocumentV1 } from './productDocumentContracts.js';", "imports a private document boundary"],
    [PORTABLE_ADAPTER, "ProductDocumentV1;", "private document schema vocabulary is not portable"],
    [PORTABLE_ADAPTER, "parseDocument(value);", "parses, validates, or canonicalizes a private document"],
    [PORTABLE_ADAPTER, `// ${parsedProvenance}`, parsedProvenanceRefusal],
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
