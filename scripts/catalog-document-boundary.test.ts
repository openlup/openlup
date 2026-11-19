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
const CONNECTED_CAPTURE = "server/adapters/postgres/connectedStoreCapture.ts";
const CONNECTED_RESTORE = "server/adapters/postgres/connectedStoreRestore.ts";
const DOCUMENT_TRANSFER_PAYLOAD = '"id", "product_id", "revision_no", "schema_id", "document_ref", "document_payload",';
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
// Canonical text carries the same document as the JSONB column. Keep these
// operations bound to exact source lines so that assigning an alias is a use.
const CANONICAL_DOCUMENT_USES = new Map<string, readonly string[]>([
  [CONNECTED_CAPTURE, ['"source_ref", "provenance", "digest", "created_at", "canonical_text",']],
  [PUBLICATION_MIGRATION, [
    "ALTER TABLE public.catalog_product_document_revisions ADD COLUMN canonical_text text;",
    ...PUBLICATION_PAYLOAD_USES.get(PUBLICATION_MIGRATION)!,
    "IF NEW.canonical_text IS NULL THEN RETURN NEW; END IF;",
    "IF encode(sha256(convert_to(NEW.canonical_text,'UTF8')),'hex') <> NEW.digest THEN",
  ]],
  [PUBLICATION_WRITER, [
    ...PUBLICATION_PAYLOAD_USES.get(PUBLICATION_WRITER)!,
    "'canonical_text',d.canonical_text,'provenance',d.provenance))",
    'canonicalText: typeof document.canonical_text === "string" ? document.canonical_text : "", provenance: document.provenance }) as CatalogPublicationDocument);',
    'require(createHash("sha256").update(document!.canonicalText).digest("hex") === document!.reference.digest,',
    "document.reference.documentRef, operation.canonicalText, document.reference.sourceRef, publicationJson(document.provenance), document.reference.digest];",
    "d.revision_no,d.schema_id,d.document_ref,d.source_ref,d.canonical_text,p.id AS publication_id,p.previous_id,previous.revision AS previous_revision",
    '&& typeof row.canonical_text === "string"',
    '&& createHash("sha256").update(row.canonical_text).digest("hex") === row.document_digest,',
    'const rows = await tuple(db, `SELECT p.revision,p.canonical_state,p.digest AS manifest_digest,d.digest,d.canonical_text,',
    '&& typeof row.canonical_text === "string" && createHash("sha256").update(row.canonical_text).digest("hex") === row.digest,',
  ]],
  [PUBLICATION_COMPILER, [
    "reference: z.infer<typeof catalogDocumentRevisionRefSchema>; canonicalText: string;",
    "inspectDocument(canonicalText: string): { schemaId: string; documentRef: string; productSlug: string; revisionNo: number;",
    "identifyDocument(document: unknown): { schemaId: string; documentRef: string; productSlug: string; revisionNo: number; name?: string };",
    "deriveSkuFacts(canonicalText: string, sku: CatalogPublishedSku): CatalogPublicationFacts;",
    "function checkedDocument(canonicalText: string, reference: Pick<CatalogPublicationDocument[\"reference\"], \"digest\" | \"documentRef\" | \"revisionNo\">",
    "need(createHash(\"sha256\").update(canonicalText).digest(\"hex\") === reference.digest, \"catalog_publication_v3_document_digest_mismatch\");",
    "let documentInfo: ReturnType<CatalogPublicationRules[\"inspectDocument\"]>;",
    "documentInfo = rules.inspectDocument(canonicalText);",
    "need(documentInfo?.productSlug === slug && documentInfo.documentRef === reference.documentRef && documentInfo.revisionNo === reference.revisionNo",
    "&& (reference.schemaId === undefined || documentInfo.schemaId === reference.schemaId), \"catalog_publication_v3_document_invalid\");",
    "need(documentInfo.canonicallyEncoded === true, \"catalog_publication_v3_document_not_canonical\");",
    "return documentInfo.contentDigest;",
    "function matchesAuthoredDocument(document: unknown, canonicalText: string, contentDigest: string, rules: CatalogPublicationRules) {",
    "let canonical: string;",
    "canonical = rules.canonicalizeDocument(document);",
    "return canonical === canonicalText && publicationDigest(document) === contentDigest;",
    "function documentSkuFacts(document: CatalogPublicationDocument, sku: CatalogPublishedSku, rules: CatalogPublicationRules): CatalogPublicationFacts {",
    "return rules.deriveSkuFacts(document.canonicalText, sku);",
    "const contentDigest = checkedDocument(operation.canonicalText, { ...operation, schemaId }, slug, rules);",
    "need(matchesAuthoredDocument(source.payload.product.sharedContent.document, operation.canonicalText, contentDigest, rules),",
    "return { reference, canonicalText: operation.canonicalText, provenance };",
    "try { name = rules.identifyDocument(payload.product.sharedContent.document)?.name; }",
    "checkedDocument(document.canonicalText, document.reference, slug, input.rules);",
    "need(equal(documentSkuFacts(currentDocument(), sku, input.rules), sku.facts), \"catalog_publication_v3_compile_derived_facts_mismatch\");",
    "need(equal(documentSkuFacts(currentDocument(), sku, input.rules), operation.facts), \"catalog_publication_v3_compile_derived_facts_mismatch\");",
    "if (payload.product.sharedContent.document !== undefined) {",
    "need(matchesAuthoredDocument(payload.product.sharedContent.document, document.canonicalText,",
    "checkedDocument(document.canonicalText, document.reference, slug, input.rules), input.rules), \"catalog_publication_document_source_mismatch\");",
    "need(equal(documentSkuFacts(currentDocument(), sku, input.rules), sku.facts),",
  ]],
  ["packages/platform/src/catalog/contracts/draftV3.ts", [
    "documentRef: string; sourceRef: string; canonicalText: string; digest: string; provenance: CatalogDraftProvenanceV3 }",
  ]],
  ["packages/platform/src/catalog/draftV3Schemas.ts", [
    "documentRef: reference, sourceRef: reference, canonicalText: z.string().min(1), digest, provenance: catalogDraftProvenanceV3Schema }).strict(),",
  ]],
  ["db/platform/migrations/20261122160000_catalog_drafts_v3.sql", [
    "WHEN 'register_document_revision' THEN ARRAY['op','productSlug','revisionId','revisionNo','documentRef','sourceRef','canonicalText','digest','provenance']",
  ]],
]);
const CANONICAL_DOCUMENT = /\b(?:canonical_text|canonicalText|decodeDocument|inspectDocument|identifyDocument|deriveSkuFacts|documentInfo|matchesAuthoredDocument|documentSkuFacts)\b|\bsharedContent\s*\??\s*(?:\.\s*document\b|\[\s*["']document["']\s*\])/;
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
  "set",
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

function readsUnapprovedCanonicalDocument(file: SourceFile, lines: readonly string[]): boolean {
  // Other SQL carriers use the same column name for unrelated commands.
  // Limit the SQL rule to document storage, draft document operations and references to NEW.
  if (file.path.endsWith(".sql") && !/\bcatalog_product_document_revisions\b|\bregister_document_revision\b|\bNEW\s*\.\s*canonical_text\b/i.test(file.source))
    return false;
  const uses = lines.filter(line => !line.trimStart().startsWith("--") && (CANONICAL_DOCUMENT.test(line)
    || file.path === PUBLICATION_COMPILER && /\bcanonical\b|(?:=|\breturn)\s*\bdocument\b(?!\s*\.)/.test(line))).map(line => line.trim());
  const allowed = CANONICAL_DOCUMENT_USES.get(file.path) ?? [];
  return new Set(uses).size !== uses.length || uses.some(line => !allowed.includes(line));
}

const SQL_PROJECTION_TOKENS = /"(?:[^"]|"")*"|\b(?:select|from|returning)\b|[()]/gi;

function projectionBody(projection: string): string {
  const modifier = /^\s*(?:ALL\b|DISTINCT\b(?:\s+ON\s*\()?)\s*/i.exec(projection)?.[0] ?? "";
  let body = projection.slice(modifier.length);
  if (modifier.trimEnd().endsWith("(")) {
    let depth = 1;
    for (const { 0: token, index } of body.matchAll(SQL_PROJECTION_TOKENS)) {
      if (token === "(") depth++;
      if (token === ")" && --depth === 0) {
        body = body.slice(index + 1);
        break;
      }
    }
  }
  return body;
}

function readsWholeDocumentRow(file: SourceFile): boolean {
  // The capture and restore table loops include document revisions. Test their
  // unresolved table interpolation as the document relation.
  const source = file.path === CONNECTED_CAPTURE || file.path === CONNECTED_RESTORE
    ? file.source.replace(/public\.\$\{(?:identifier|quoted)\(table\)\}/g, "public.catalog_product_document_revisions")
    : file.source;
  return source.split(/[`;]/).some(statement => {
    statement = statement.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"]|"")*"|\bONLY\b/gi,
      token => token.startsWith('"') ? token : " ");
    if (/^\s*table\s+(?:"?public"?\s*\.\s*)?"?catalog_product_document_revisions\b/i.test(statement)) return true;
    const tables = [...statement.matchAll(/(?:\b(?:from|join|update|into)\s+|,\s*)(?:\(\s*)?(?:"?public"?\s*\.\s*)?"?(catalog_product_document_revisions)\b"?(?:\s*\))?(?:\s+(?:as\s+)?(?:"([^"]+)"|([a-z_][\w]*)\b))?/gi)];
    if (!tables.length) return false;
    const projections = [];
    const selects = new Map<number, number>();
    let depth = 0;
    for (const { 0: token, index } of statement.matchAll(SQL_PROJECTION_TOKENS)) {
      switch (token.toLowerCase()) {
        case "(": depth++; break;
        case ")": selects.delete(depth--); break;
        case "select": selects.set(depth, index + token.length); break;
        case "from": {
          if (/\bIS\s+(?:NOT\s+)?DISTINCT\s*$/i.test(statement.slice(0, index))) break;
          const start = selects.get(depth);
          if (start !== undefined) projections.push(projectionBody(statement.slice(start, index)));
          selects.delete(depth);
          break;
        }
        case "returning": projections.push(statement.slice(index + token.length)); break;
      }
    }
    return tables.some(([, table, quotedAlias, alias]) => {
      const row = alias && !SQL_RESERVED_WORDS.has(alias.toLowerCase()) ? alias : table;
      const rowToken = quotedAlias && !/^[a-z_]\w*$/.test(quotedAlias)
        ? `"${quotedAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`
        : String.raw`(?:"${quotedAlias ?? row}"|\b${quotedAlias ?? row}\b)`;
      return projections.some(projection =>
        /(?:^|,)\s*\*\s*(?:,|$)/.test(projection)
        || new RegExp(String.raw`${rowToken}\s*\.\s*\*`, "i").test(projection)
        || new RegExp(String.raw`(?<![."\w])${rowToken}(?!\s*["]?\s*\.)`, "i")
          .test(projection.replace(new RegExp(String.raw`\bAS\s+${rowToken}`, "gi"), "")));
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
    if (readsWholeDocumentRow(file)) {
      found.push(`${file.path}: document rows must use explicit projections`);
    }
    if (readsUnapprovedCanonicalDocument(file, lines)) {
      found.push(`${file.path}: unapproved canonical document operation`);
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
    const opaqueTransfer = file.path === CONNECTED_CAPTURE && exactUses(payloadLines.map(line => line.trim()), [DOCUMENT_TRANSFER_PAYLOAD]);
    const opaqueStorage = file.path === PORTABLE_MIGRATION
      && exactUses(payloadLines.map(line => line.trim()), ["document_payload jsonb NOT NULL,"]);
    if (!isTestSource && (
      (payloadLines.length > 0 && !opaqueStorage && !opaqueQuoteRead && !opaquePublication && !opaqueTransfer)
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
    "SELECT json_agg(saved ORDER BY saved.id) FROM public.catalog_product_document_revisions AS saved;",
    "SELECT jsonb_agg(saved) FROM public.catalog_product_document_revisions AS saved;",
    "SELECT saved.* FROM public.catalog_product_document_revisions saved;",
    "SELECT * FROM public.catalog_product_document_revisions;",
    "SELECT *, saved.id FROM public.catalog_product_document_revisions saved;",
    "SELECT DISTINCT * FROM public.catalog_product_document_revisions d;",
    "SELECT DISTINCT /* whole */ * FROM public.catalog_product_document_revisions d;",
    "SELECT d FROM public.catalog_product_document_revisions AS d;",
    'SELECT "d" FROM public.catalog_product_document_revisions AS d;',
    "SELECT ROW(d) FROM public.catalog_product_document_revisions d;",
    "SELECT jsonb_build_object('revision', d) FROM public.catalog_product_document_revisions d;",
    "SELECT DISTINCT ON (d.id) d FROM public.catalog_product_document_revisions d;",
    "SELECT DISTINCT ON (d.id) * FROM public.catalog_product_document_revisions d;",
    "SELECT DISTINCT ON (coalesce(d.id, (NULL::uuid))) * FROM public.catalog_product_document_revisions d;",
    "SELECT d.* FROM ONLY public.catalog_product_document_revisions d;",
    "SELECT to_jsonb(d) FROM products p JOIN ONLY (public.catalog_product_document_revisions) d ON d.product_id=p.id;",
    'SELECT d FROM "public"."catalog_product_document_revisions" AS "d";',
    'SELECT "select" FROM public.catalog_product_document_revisions AS "select";',
    'SELECT ROW("saved revision") FROM public.catalog_product_document_revisions AS "saved revision";',
    "SELECT (SELECT x.value FROM other_table x), d FROM public.catalog_product_document_revisions d;",
    "SELECT d.id IS DISTINCT FROM x.id, d FROM other_table x, public.catalog_product_document_revisions d;",
    "UPDATE public.catalog_product_document_revisions d SET revision_no=2 RETURNING d;",
    "TABLE public.catalog_product_document_revisions;",
  ])("refuses a whole document row projection: %s", source => {
    expect(violations([{ path: PUBLICATION_WRITER, source }])).toContain(
      `${PUBLICATION_WRITER}: document rows must use explicit projections`,
    );
  });

  it("allows a document row query with only scalar columns and a row count", () => {
    const source = "SELECT DISTINCT d.id, d.revision_no AS d, count(*) FROM public.catalog_product_document_revisions d;";
    expect(violations([{ path: PUBLICATION_WRITER, source }])).toEqual([]);
  });

  it.each([[CONNECTED_CAPTURE, "identifier"], [CONNECTED_RESTORE, "quoted"]])(
    "refuses a whole document row selected by the retained-transfer table loop in %s", (path, name) => {
      const source = "SELECT pg_catalog.to_jsonb(t)::pg_catalog.text AS value FROM public.${" + name + "(table)} t";
      expect(violations([{ path, source }])).toContain(`${path}: document rows must use explicit projections`);
    },
  );

  it.each([
    ["transport (aliased parse)", PUBLICATION_WRITER, "const alias = row.canonicalText;\n JSON.parse(alias);"],
    ["transport (wrong file)", "server/adapters/postgres/other.ts", CANONICAL_DOCUMENT_USES.get(PUBLICATION_WRITER)![2]],
    ["digest (inspection)", PUBLICATION_WRITER, 'createHash("sha256").update(JSON.parse(row.canonical_text).name);'],
    ["equality (field extraction)", PUBLICATION_MIGRATION, "SELECT canonical_text::jsonb->>'name' FROM public.catalog_product_document_revisions;"],
    ["installed handoff (private decoder)", PUBLICATION_COMPILER, "const value = privateRules.decodeDocument(canonicalText);"],
    ["installed handoff (field extraction)", PUBLICATION_COMPILER, "const name = payload.product.sharedContent.document?.name;"],
    ["installed handoff (canonicalization result alias)", PUBLICATION_COMPILER, "const alias = canonical; JSON.parse(alias);"],
    ["installed handoff (decoded document alias)", PUBLICATION_COMPILER, "const alias = document; JSON.parse(alias);"],
    ["installed handoff (field on handed-back value)", PUBLICATION_COMPILER,
      "const name = (documentInfo as { document: { name: string } }).document.name;"],
    ["object envelope (field validation)", PUBLICATION_MIGRATION, "IF jsonb_typeof(NEW.canonical_text::jsonb->'name') IS DISTINCT FROM 'string' THEN"],
  ])("refuses a widened canonical document %s", (_kind, path, source) => {
    expect(violations([{ path, source }])).toContain(`${path}: unapproved canonical document operation`);
  });

  it("refuses a raw payload projection in the legacy storage owner", () => {
    const source = "document_payload jsonb NOT NULL,\nSELECT document_payload FROM public.catalog_product_document_revisions;";
    expect(violations([{ path: PORTABLE_MIGRATION, source }])).toContain(`${PORTABLE_MIGRATION}: document payload must remain opaque SQL storage only`);
  });

  it.each([...CANONICAL_DOCUMENT_USES].flatMap(([path, uses]) => uses.map(use => ({ path, use }))))(
    "refuses a second canonical document use in $path ($use)", ({ path, use }) => {
      const source = path.endsWith(".sql") ? `SELECT id FROM public.catalog_product_document_revisions;\n${use}\n${use}` : `${use}\n${use}`;
      expect(violations([{ path, source }])).toContain(`${path}: unapproved canonical document operation`);
    },
  );

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
