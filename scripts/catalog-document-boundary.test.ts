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

const COMPILER = "packages/platform/src/catalog/publicationValidation.ts";
const DOCUMENT_USE = /\b(?:canonical_text|canonicalText|authoredValue)\b|\bsharedContent\s*\??\s*(?:\.\s*document\b|\[\s*["']document["']\s*\])/;
// Owner-file and exact-line allowances for pass-through, digest and installed-rule calls.
const documentUses = new Map<string, readonly string[]>([
  [COMPILER, [
    "function checkedDocument(canonicalText: string, reference: Pick<CatalogPublicationDocument[\"reference\"], \"digest\" | \"documentRef\" | \"revisionNo\" | \"schemaId\">,",
    "need(createHash(\"sha256\").update(canonicalText).digest(\"hex\") === reference.digest, \"catalog_publication_v3_document_digest_mismatch\");",
    "documentInfo = rules.inspectDocument(canonicalText);",
    "function matchesAuthoredDocument(authoredValue: unknown, canonicalText: string, rules: CatalogPublicationRulesModule) {",
    "try { return rules.matchesDocument(authoredValue, canonicalText) === true; }",
    "return rules.deriveSkuFacts(document.canonicalText, ruleSku(sku));",
    "if (reference && rules) checkedDocument(operation.canonicalText, { ...operation, schemaId: reference.schemaId }, slug, rules);",
    "else need(createHash(\"sha256\").update(operation.canonicalText).digest(\"hex\") === operation.digest,",
    "if (rules && intent.product.sharedContent.document !== undefined)",
    "need(matchesAuthoredDocument(intent.product.sharedContent.document, operation.canonicalText, rules), \"catalog_publication_v3_document_invalid\");",
    "return { reference, canonicalText: operation.canonicalText, provenance };",
    "if (payload.product.sharedContent.document !== undefined) {",
    "try { name = rules.identifyDocument(payload.product.sharedContent.document)?.name; }",
    "const info = checkedDocument(registration.canonicalText, reference, slug, rules);",
    "if (rules) checkedDocument(document.canonicalText, document.reference, slug, rules);",
    "if (rules && afterDocument && payload.product.sharedContent.document !== undefined)",
    "need(matchesAuthoredDocument(payload.product.sharedContent.document, afterDocument.canonicalText, rules), \"catalog_publication_document_source_mismatch\");",
    "beforeDocument: beforeDocument.canonicalText, afterDocument: afterDocument.canonicalText }) === \"compatible\", \"sku_identity_change_requires_new_sku\");",
    "const issues = rules.validateProduct(ruleProduct(result), [...skus.values()].map(ruleSku), documents.map(document => document.canonicalText));",
  ]],
  ["packages/platform/src/catalog/catalogPublicationRules.ts", [
    "inspectDocument(canonicalText: string): { schemaId: string; documentRef: string; productSlug: string; revisionNo: number;",
    "matchesDocument(document: unknown, canonicalText: string): boolean;",
    "deriveSkuFacts(canonicalText: string, sku: RulesSku): CatalogPublicationFacts;",
  ]],
  ["packages/platform/src/catalog/publicationEvidence.ts", ["reference: CatalogDocumentRevisionRef; canonicalText: string;"]],
  ["packages/platform/src/catalog/contracts/draftV3.ts", ["documentRef: string; sourceRef: string; canonicalText: string; digest: string; provenance: CatalogDraftProvenanceV3 }"]],
  ["packages/platform/src/catalog/draftV3Schemas.ts", ["documentRef: reference, sourceRef: reference, canonicalText: z.string().min(1), digest, provenance: catalogDraftProvenanceV3Schema }).strict(),"]],
  ["db/platform/migrations/20261122160000_catalog_drafts_v3.sql", ["WHEN 'register_document_revision' THEN ARRAY['op','productSlug','revisionId','revisionNo','documentRef','sourceRef','canonicalText','digest','provenance']"]],
]);

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
    if (file.path === PORTABLE_ADAPTER && /\bomnipack\b/i.test(file.source)) {
      found.push(`${file.path}: imports or reconstructs OmniPack provenance`);
    }

    const uses = file.path.endsWith(".sql") && !/catalog_product_document_revisions|register_document_revision/.test(file.source)
      ? [] : file.source.split("\n").map(line => line.trim()).filter(line => DOCUMENT_USE.test(line));
    const allowed = documentUses.get(file.path) ?? [];
    if (uses.length !== new Set(uses).size || uses.some(line => !allowed.includes(line)))
      found.push(`${file.path}: unapproved document operation`);
    if (/\bSELECT\s+(?:DISTINCT\s+(?:ON\s*\([^)]*\)\s*)?)?(?:[\w."]*\*|(?:to_jsonb|row_to_json|jsonb?_agg)\s*\([^)]*\))\s+FROM\s+(?:ONLY\s+)?(?:public\.)?catalog_product_document_revisions\b/i.test(file.source))
      found.push(`${file.path}: document rows require explicit columns`);
    else if (/\bSELECT\s+(?:DISTINCT\s+)?([a-z_][\w]*)\s+FROM\s+(?:ONLY\s+)?(?:public\.)?catalog_product_document_revisions\s+(?:AS\s+)?\1\b/i.test(file.source))
      found.push(`${file.path}: document rows require explicit columns`);

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

    expect(files.some(file => file.path === PORTABLE_MIGRATION)).toBe(true);
    expect(files.some(file => file.path === PORTABLE_ADAPTER)).toBe(true);
    expect(violations(files)).toEqual([]);
  });

  it.each([
    [PORTABLE_MIGRATION, "SELECT document_payload->>'name' FROM public.catalog_product_document_revisions;", "document payload must remain opaque SQL storage only"],
    [PORTABLE_MIGRATION, "SELECT DISTINCT r FROM ONLY public.catalog_product_document_revisions AS r;", "document rows require explicit columns"],
    [PORTABLE_MIGRATION, "SELECT canonical_text::jsonb->>'name' FROM public.catalog_product_document_revisions;", "unapproved document operation"],
    [COMPILER, "const parsed = JSON.parse(canonicalText);", "unapproved document operation"],
    [COMPILER, "const value = payload.product.sharedContent.document.title;", "unapproved document operation"],
    [COMPILER, "logger.info(authoredValue);", "unapproved document operation"],
    [COMPILER, "schema.safeParse(authoredValue);", "unapproved document operation"],
    [COMPILER, [documentUses.get(COMPILER)![0], documentUses.get(COMPILER)![0]].join("\n"), "unapproved document operation"],
    [QUOTE_READER, [...QUOTE_PAYLOAD_USES, "console.log(documents);"].join("\n"), "quote document must pass unparsed to host policy"],
    [QUOTE_READER, [...QUOTE_PAYLOAD_USES, QUOTE_PAYLOAD_SELECT].join("\n"), "document payload must remain opaque SQL storage only"],
    [PORTABLE_ADAPTER, QUOTE_PAYLOAD_SELECT, "document payload must remain opaque SQL storage only"],
    [PORTABLE_ADAPTER, "import { ProductDocumentV1 } from './productDocumentContracts.js';", "imports a private document boundary"],
    [PORTABLE_ADAPTER, "ProductDocumentV1;", "private document schema vocabulary is not portable"],
    [PORTABLE_ADAPTER, "parseDocument(value);", "parses, validates, or canonicalizes a private document"],
  ])("refuses %s with %s", (path, source, expected) => {
    expect(violations([{ path, source }])).toContain(`${path}: ${expected}`);
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
