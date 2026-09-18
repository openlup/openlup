import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PERIMETERS = [
  "packages/core",
  "db/platform",
  "src/domains/catalog",
  "server/domains/catalog",
  "server/adapters/postgres",
] as const;
const PORTABLE_MIGRATION = "db/platform/migrations/20260827220000_catalog_document_revision_foundation.sql";
const PORTABLE_ADAPTER = "server/adapters/postgres/catalogSkuEnvelope.ts";

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
    if (file.path === PORTABLE_ADAPTER && /\bomnipack\b/i.test(file.source)) {
      found.push(`${file.path}: imports or reconstructs OmniPack provenance`);
    }

    const isTestSource = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.path);
    const payloadLines = file.source
      .split("\n")
      .filter((line) => /\bdocument_payload\b/.test(line) && !line.trimStart().startsWith("--"));
    if (!isTestSource && payloadLines.length > 0 && (
      file.path !== PORTABLE_MIGRATION
      || payloadLines.some((line) => !/^\s*document_payload jsonb NOT NULL,\s*$/.test(line))
    )) {
      found.push(`${file.path}: document payload must remain opaque SQL storage only`);
    }
  }
  return found;
}

describe("portable catalog document boundary", () => {
  it("scans exactly the portable/core catalog perimeter", () => {
    const files = perimeterSources();

    expect(files).not.toHaveLength(0);
    expect(files.every((file) => PERIMETERS.some((perimeter) => file.path.startsWith(`${perimeter}/`)))).toBe(true);
    expect(files.some((file) => file.path === PORTABLE_MIGRATION)).toBe(true);
    expect(files.some((file) => file.path === PORTABLE_ADAPTER)).toBe(true);
    expect(violations(files)).toEqual([]);
  });

  it("fails document interpretation while allowing an opaque storage declaration", () => {
    expect(violations([
      { path: PORTABLE_MIGRATION, source: "  document_payload jsonb NOT NULL,\n" },
      { path: "server/adapters/postgres/unsafe.ts", source: "import { ProductDocumentV1 } from '../../../src/overlays/reference/data/catalog/productDocumentContracts.js';" },
      { path: "server/adapters/postgres/unsafe-payload.ts", source: "SELECT document_payload FROM public.catalog_product_document_revisions;" },
    ])).toEqual([
      "server/adapters/postgres/unsafe.ts: private document schema vocabulary is not portable",
      "server/adapters/postgres/unsafe.ts: imports a private document boundary",
      "server/adapters/postgres/unsafe-payload.ts: document payload must remain opaque SQL storage only",
    ]);
  });

  it("fails imports or interpretation of the private W2d mapping proof", () => {
    expect(violations([
      { path: "packages/core/src/catalog-mapping.ts", source: "export type { CatalogDocumentMappingReceiptV1 } from '../../../../src/overlays/private/data/catalog/catalogDocumentMappingContracts.js';" },
      { path: "server/domains/catalog/mapper.ts", source: "const mapping = await import('../../../src/overlays/private/tooling/catalog/mapCatalogPresentation.js');" },
    ])).toEqual([
      "packages/core/src/catalog-mapping.ts: private document schema vocabulary is not portable",
      "packages/core/src/catalog-mapping.ts: imports a private document boundary",
      "server/domains/catalog/mapper.ts: imports a private document boundary",
    ]);
  });

  it.each([
    "SELECT gtin FROM catalog_skus",
    "SELECT sku.gtin FROM catalog_skus AS sku",
    "SELECT sku.gtin FROM public.catalog_skus sku",
    "SELECT catalog_skus.gtin FROM catalog_skus",
  ])("rejects a dormant GTIN read mutation: %s", (source) => {
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
