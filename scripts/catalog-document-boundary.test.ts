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
const PUBLICATION_MIGRATION = "db/platform/migrations/20261123150000_catalog_publication.sql";
const PUBLICATION_WRITER = "packages/platform/src/catalog/publicationStore.ts";
const PUBLICATION_COMPILER = "packages/platform/src/catalog/publicationValidation.ts";
const PUBLICATION_PAYLOAD_USES = new Map<string, readonly string[]>([
  [PUBLICATION_MIGRATION, [
    "canonical_text IS NULL OR (CAST(canonical_text AS jsonb) = document_payload)) NOT VALID;",
  ]],
  [PUBLICATION_WRITER, [
    "(id,product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest,canonical_text)",
    "AND canonical_text=$6 AND document_payload=$6::text::jsonb AND source_ref=$7 AND provenance=$8::jsonb AND digest=$9 AS matches",
  ]],
]);
const PUBLICATION_CANONICALIZATION_USES = [
  "canonicalizeDocument(document: unknown): string;",
  "canonical = rules.canonicalizeDocument(document);",
];
const DOCUMENT_METHOD = /\b(?:parse|safeParse|validate|canonicalize)(?:Product)?Document(?:V1)?\b/;
const PAYLOAD_COLUMN = String.raw`\b(?:document_payload|revision_document_payload)\b`;
const SQL_DOCUMENT_OPERATOR = String.raw`(?:->>?|#>>?|@>|<@|\?)`;
const SQL_DOCUMENT_INTERPRETATION = new RegExp(
  [
    String.raw`${PAYLOAD_COLUMN}"?\s*(?:\)\s*)*${SQL_DOCUMENT_OPERATOR}`,
    String.raw`${SQL_DOCUMENT_OPERATOR}\s*(?:\w+\.)?"?${PAYLOAD_COLUMN}`,
    String.raw`\bjsonb_\w+\s*\([^;\x60]*${PAYLOAD_COLUMN}`,
  ].join("|"),
  "i",
);
const OPAQUE_DOCUMENT = String.raw`\b(?:document|document_payload|revision_document_payload)\b`;
const DOCUMENT_INTERPRETATION = new RegExp(String.raw`\b(?:parse|safeParse|validate|canonicalize)\s*\([^();,]*${OPAQUE_DOCUMENT}`);
const BARE_CANONICAL_TEXT_INTERPRETATION = /(?<![\w$.])(?:parse|safeParse|validate|canonicalize)\s*\(\s*canonicalText\b/;
const LOG_OR_STRINGIFY = /\b(?:console|logger)\s*[.[]|\bJSON\s*\.\s*stringify\s*\(/;
const DOCUMENT_DISCLOSURE = new RegExp(String.raw`(?:\b(?:console|logger)\s*(?:\.\s*\w+|\[[^\]]+\])\s*\(|\bJSON\s*\.\s*stringify\s*\()[^;]*${OPAQUE_DOCUMENT}`);

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

function exactUses(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === expected.length
    && actual.every(line => expected.includes(line));
}

function readsWholeDocumentRow(source: string): boolean {
  return source.split(/[`;]/).some(statement => {
    if (/\bselect\s+\*\s+from\s+(?:public\.)?catalog_product_document_revisions\b/i.test(statement)) return true;
    const tables = statement.matchAll(/\b(?:from|join)\s+(?:public\.)?(catalog_product_document_revisions)\b(?:\s+(?:as\s+)?([a-z_][\w]*))?/gi);
    return [...tables].some(([, table, alias]) => {
      const row = alias && !SQL_RESERVED_WORDS.has(alias.toLowerCase()) ? alias : table;
      return new RegExp(String.raw`\b(?:to_jsonb|row_to_json|to_json)\s*\(\s*${row}\s*\)|\b${row}\s*\.\s*\*`, "i").test(statement);
    });
  });
}

// This exact opt-in reader may transport an unknown value only to host policy.
// Any second selection or other use of the value requires another boundary decision.
function opaqueQuotePayloadPassThrough(source: string, payloadLines: readonly string[]): boolean {
  const uses = source.split("\n").filter((line) => /\brevision_document_payload\b/.test(line)).map((line) => line.trim());
  return payloadLines.length === 1 && payloadLines[0]!.trim() === QUOTE_PAYLOAD_SELECT
    && exactUses(uses, QUOTE_PAYLOAD_USES);
}

function violations(files: readonly SourceFile[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const lines = file.source.split("\n");
    if (/\b(?:ProductDocumentV1|productDocumentV1Schema|productDocumentSchema|CatalogDocumentMappingDraftV1|CatalogDocumentMappingReceiptV1|catalogDocumentMappingDraftV1Schema|catalogDocumentMappingReceiptV1Schema)\b/.test(file.source)) {
      found.push(`${file.path}: private document schema vocabulary is not portable`);
    }
    if (/(?:from\s*|import\s*\()\s*["'][^"']*(?:productDocumentContracts|catalogDocumentMappingContracts|mapCatalogPresentation|compile-catalog-document-mapping|overlays\/[^/]+\/(?:data|tooling)\/catalog)/.test(file.source)) {
      found.push(`${file.path}: imports a private document boundary`);
    }
    const documentMethods = lines.filter(line => DOCUMENT_METHOD.test(line)).map(line => line.trim());
    const installedCanonicalization = file.path === PUBLICATION_COMPILER
      && exactUses(documentMethods, PUBLICATION_CANONICALIZATION_USES);
    if ((documentMethods.length > 0 && !installedCanonicalization) || DOCUMENT_INTERPRETATION.test(file.source)
      || BARE_CANONICAL_TEXT_INTERPRETATION.test(file.source)) {
      found.push(`${file.path}: parses, validates, or canonicalizes a private document`);
    }
    if (SQL_DOCUMENT_INTERPRETATION.test(file.source)) {
      found.push(`${file.path}: interprets the SQL document payload`);
    }
    if (readsWholeDocumentRow(file.source)) {
      found.push(`${file.path}: document rows must use explicit projections`);
    }
    if (readsDormantCatalogSkuGtin(file.source)) {
      found.push(`${file.path}: reads dormant catalog_skus.gtin`);
    }
    if (file.path === PORTABLE_ADAPTER && /\bomnipack\b/i.test(file.source)) {
      found.push(`${file.path}: imports or reconstructs OmniPack provenance`);
    }

    const isTestSource = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.path);
    const payloadLines = lines.filter(line => /\bdocument_payload\b/.test(line) && !line.trimStart().startsWith("--"));
    const opaqueQuoteRead = file.path === QUOTE_READER && opaqueQuotePayloadPassThrough(file.source, payloadLines);
    const publicationPayloadUses = PUBLICATION_PAYLOAD_USES.get(file.path);
    const opaquePublication = publicationPayloadUses !== undefined && exactUses(payloadLines.map(line => line.trim()), publicationPayloadUses);
    const opaqueStorage = file.path === PORTABLE_MIGRATION
      && payloadLines.every((line) => /^\s*document_payload jsonb NOT NULL,\s*$/.test(line));
    if (!isTestSource && (
      (payloadLines.length > 0 && !opaqueStorage && !opaqueQuoteRead && !opaquePublication)
      || (file.path === QUOTE_READER && /\brevision_document_payload\b/.test(file.source) && !opaqueQuoteRead)
    )) {
      found.push(`${file.path}: document payload must remain opaque SQL storage only`);
    }
    if (file.path === QUOTE_READER && (
      /\b(?:parse|safeParse|validate|canonicalize)\s*\(/.test(file.source)
      || LOG_OR_STRINGIFY.test(file.source)
    )) {
      found.push(`${file.path}: quote document must pass unparsed to host policy`);
    }
    if (DOCUMENT_DISCLOSURE.test(file.source)
      || ((publicationPayloadUses !== undefined || file.path === PUBLICATION_COMPILER) && LOG_OR_STRINGIFY.test(file.source))) {
      found.push(`${file.path}: document payload must not be logged or serialized`);
    }
  }
  return found;
}

describe("portable catalog document boundary", () => {
  it("scans exactly the portable/core catalog perimeter", () => {
    const files = perimeterSources();

    expect(files).not.toHaveLength(0);
    expect(files.some((file) =>
      file.path.startsWith("node_modules/@openlup/core/src/catalog/") && /\.tsx?$/.test(file.path),
    )).toBe(true);
    expect(files.every((file) => PERIMETERS.some((perimeter) => file.path.startsWith(`${perimeter}/`)))).toBe(true);
    expect(files.some((file) => file.path === PORTABLE_MIGRATION)).toBe(true);
    expect(files.some((file) => file.path === PORTABLE_ADAPTER)).toBe(true);
    expect(violations(files)).toEqual([]);
  });

  const publicationUses = [...PUBLICATION_PAYLOAD_USES, [PUBLICATION_COMPILER, PUBLICATION_CANONICALIZATION_USES] as const];
  const publicationRefusal = (path: string) => path === PUBLICATION_COMPILER
    ? "parses, validates, or canonicalizes a private document"
    : "document payload must remain opaque SQL storage only";

  it.each(publicationUses)("accepts only the selected document lines in %s", (path, uses) => {
    expect(violations([{ path, source: uses.map(use => `  ${use}  `).join("\n") }])).toEqual([]);
  });

  it.each(publicationUses.flatMap(([path, uses]) => uses.map((use, index) => ({ path, uses, use, index }))))(
    "refuses a second occurrence of allowed use $index in $path", ({ path, uses, use }) => {
      expect(violations([{ path, source: [...uses, use].join("\n") }])).toContain(`${path}: ${publicationRefusal(path)}`);
    },
  );

  it.each(publicationUses.filter(([, uses]) => uses.length === 2))(
    "refuses a duplicate replacing another approved line in %s", (path, [use]) => {
      expect(violations([{ path, source: [use, use].join("\n") }])).toContain(`${path}: ${publicationRefusal(path)}`);
    },
  );

  it.each(publicationUses)("refuses the approved lines from %s in a different file", (owner, uses) => {
    const path = "server/adapters/postgres/anotherDocumentOwner.ts";
    expect(violations([{ path, source: uses.join("\n") }])).toContain(`${path}: ${publicationRefusal(owner)}`);
  });

  it.each([
    "document_payload -> 'name'",
    "document_payload ->> 'name'",
    "document_payload #> '{name}'",
    "revision.document_payload #>> '{name}'",
    "document_payload @> $1",
    "$1 <@ revision.document_payload",
    "document_payload ? 'name'",
    "jsonb_extract_path(document_payload, 'name')",
    'jsonb_path_exists(\n  revision."document_payload", \'$.name\')',
  ])("refuses SQL document interpretation in an approved file: %s", expression => {
    const source = [...PUBLICATION_PAYLOAD_USES.get(PUBLICATION_WRITER)!, `SELECT ${expression};`].join("\n");
    expect(violations([{ path: PUBLICATION_WRITER, source }])).toContain(`${PUBLICATION_WRITER}: interprets the SQL document payload`);
  });

  it.each([
    "SELECT to_jsonb(d) FROM public.catalog_product_document_revisions d;",
    "SELECT row_to_json(saved) FROM public.catalog_product_document_revisions AS saved;",
    "SELECT saved.* FROM public.catalog_product_document_revisions saved;",
    "SELECT * FROM public.catalog_product_document_revisions;",
  ])("refuses a whole document row projection: %s", source => {
    expect(violations([{ path: PUBLICATION_WRITER, source }])).toContain(
      `${PUBLICATION_WRITER}: document rows must use explicit projections`,
    );
  });

  it.each([
    "canonicalizeDocument(document);",
    "otherRules.canonicalizeDocument(document);",
    'import { canonicalizeDocument } from "./privateCanonicalizer.js";',
    "canonicalize(document);",
    "parse(document);",
    "validate(document);",
    "parse(canonicalText);",
  ])("refuses an unapproved document method: %s", use => {
    const source = [...PUBLICATION_CANONICALIZATION_USES, use].join("\n");
    expect(violations([{ path: PUBLICATION_COMPILER, source }])).toContain(`${PUBLICATION_COMPILER}: ${publicationRefusal(PUBLICATION_COMPILER)}`);
  });

  it.each([
    [PUBLICATION_COMPILER, "logger.info(value);"],
    [PUBLICATION_WRITER, "JSON.stringify(value);"],
    ["server/adapters/postgres/anotherDocumentOwner.ts", "console.log(document);"],
    ["server/adapters/postgres/anotherDocumentOwner.ts", "JSON.stringify({ document });"],
  ])("refuses document disclosure in %s: %s", (path, source) => {
    expect(violations([{ path, source }])).toContain(`${path}: document payload must not be logged or serialized`);
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

    const passThrough = QUOTE_PAYLOAD_USES.join("\n");
    expect(violations([{ path: QUOTE_READER, source: passThrough }])).toEqual([]);
    // Every other perimeter retains the original no-read boundary.
    for (const perimeter of PERIMETERS) {
      const path = `${perimeter}/unexpected-document-read.ts`;
      expect(violations([{ path, source: passThrough }])).toContain(
        `${path}: document payload must remain opaque SQL storage only`,
      );
    }
    expect(violations([{ path: QUOTE_READER, source: `${passThrough}\n${QUOTE_PAYLOAD_SELECT}` }])).toContain(
      `${QUOTE_READER}: document payload must remain opaque SQL storage only`,
    );
    for (const interpretation of ["parseDocument(value);", "validateDocument(value);", "canonicalizeDocument(value);"]) {
      expect(violations([{ path: QUOTE_READER, source: `${passThrough}\n${interpretation}` }])).toContain(
        `${QUOTE_READER}: parses, validates, or canonicalizes a private document`,
      );
    }
    for (const interpretation of ["JSON.parse(value);", "schema.safeParse(value);", "validate(value);", "canonicalize(value);"]) {
      expect(violations([{ path: QUOTE_READER, source: `${passThrough}\n${interpretation}` }])).toContain(
        `${QUOTE_READER}: quote document must pass unparsed to host policy`,
      );
    }
    for (const logging of ["console.log(documents);", "logger.info(documents[index]);", "JSON.stringify(documents);"]) {
      expect(violations([{ path: QUOTE_READER, source: `${passThrough}\n${logging}` }])).toContain(
        `${QUOTE_READER}: quote document must pass unparsed to host policy`,
      );
    }
    for (const schema of ["ProductDocumentV1", "productDocumentV1Schema", "productDocumentSchema"]) {
      expect(violations([{ path: QUOTE_READER, source: `${passThrough}\n${schema};` }])).toContain(
        `${QUOTE_READER}: private document schema vocabulary is not portable`,
      );
    }
    for (const misuse of [
      passThrough.replace("revision_document_payload, envelope", "revision_document_payload.title, envelope"),
      passThrough.replace("revision_document_payload, envelope", 'revision_document_payload["title"], envelope'),
      `${passThrough}\nconsole.log(documents[index]!.revision_document_payload);`,
      `${passThrough}\nconst copied = documents[index]!.revision_document_payload;`,
    ]) {
      expect(violations([{ path: QUOTE_READER, source: misuse }])).toContain(
        `${QUOTE_READER}: document payload must remain opaque SQL storage only`,
      );
    }
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
