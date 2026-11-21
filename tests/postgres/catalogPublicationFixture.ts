import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import type { CatalogPublishedSku, CatalogPublishedProduct, CatalogSkuRevisionRef, CatalogPublicationManifestV2, CatalogDraftPayloadV4 } from "@openlup/platform/catalog";

export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const catalogueReadGrant = "db/platform/migrations/20261124180000_catalogue_read_grant.sql";
export const cataloguePublicationAuthority = "db/platform/migrations/q2_20261123192500_catalog_publication_authority.sql";
export const catalogueGovernedForward = "db/platform/migrations/20261124220000_catalog_governed_lifecycle.sql";

export async function installAfter(pool: Pool, predecessor: string) {
  const index = platformForwards.findIndex(unit => unit.file === predecessor);
  if (index < 0) throw new Error("Native fixture predecessor missing");
  for (const { file } of platformForwards.slice(index + 1)) await pool.query(readFileSync(file, "utf8"));
}
const platformForwards = (JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as {
  forward: { file: string }[];
}).forward;
export const membershipSignature = "public.catalog_offer_memberships_page(text,jsonb,integer,text)";
export const readinessSignature = "public.catalog_publication_activation_readiness(text[],text)";

// These isolated SQL suites install individual forwards without the production runner.
export async function installCatalogueReadGrants(pool: Pool) {
  await transaction(pool, async db => {
    await db.query("CREATE ROLE openlup_catalog_publication LOGIN NOINHERIT");
    await db.query("INSERT INTO public.platform_schema_migrations(catalog_path,sha256,position) VALUES($1,$2,0)",
      [cataloguePublicationAuthority, hash(readFileSync(cataloguePublicationAuthority, "utf8"))]);
    await db.query(readFileSync(catalogueReadGrant, "utf8"));
    await db.query("DELETE FROM public.platform_schema_migrations WHERE catalog_path=$1", [cataloguePublicationAuthority]);
  });
}

export async function publicFunctionGrants(pool: Pool, signatures: string[]) {
  return (await pool.query(`SELECT name, acl.privilege_type FROM unnest($1::text[]) AS names(name)
    JOIN pg_catalog.pg_proc fn ON fn.oid=name::regprocedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(fn.proacl,pg_catalog.acldefault('f',fn.proowner))) acl
    WHERE acl.grantee=0`, [signatures])).rows;
}

// Fixture construction can deliberately exceed wire bounds so that SQL owns the refusal.
export const json = (input: unknown): string => JSON.stringify(input, (_key, value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
});
export function malformedPublicationPackets(canonicalText: string) {
  const manifest = JSON.parse(canonicalText) as CatalogPublicationManifestV2;
  const first = manifest.skus[0]!;
  const withRevisionId = (revisionId: string) => json({ ...manifest, skus: [{ ...first, revisionId }, ...manifest.skus.slice(1)] });
  return [
    { path: "skus.1.skuId", text: json({ ...manifest, skus: [first, first, ...manifest.skus.slice(1)] }) },
    { path: "product.primarySkuId", text: json({ ...manifest, skus: [] }) },
    { path: "skus.0.revisionId", text: withRevisionId("\0") },
    { path: "skus.0.revisionId", text: withRevisionId("not-a-uuid") },
  ].map(({ path, text }) => ({ path, text, digest: hash(text) }));
}
export const sealedPublicationRemedy = "Recover the sealed publication or re-export it from a verified copy.";

export const publicationDocuments = {
  retained: { label: "retained immutable bytes" },
  contradictory: { label: "different authored bytes" },
  different: { label: "different content" },
  second: { label: "second document" },
};

export function authoredPublicationDocument(productSlug: string) {
  return { schemaVersion: 1, id: "example:document", productSlug, revisionNo: 1, name: "Example article" };
}

export function publicationDocumentAtDraftDepth(deepest: number) {
  // The document sits at depth 3 in the draft. Its value starts at depth 4.
  let nested: unknown = {};
  for (let level = 4; level < deepest; level++) nested = [nested];
  return { value: nested };
}

const type = { key: "example:article", version: 1 };
const definitionDigest = hash("synthetic installed definition");
export const actorId = randomUUID();

export async function installPublicationActors(pool: Pool) {
  await pool.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'publication@example.invalid')", [actorId]);
  await pool.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())", [actorId]);
  await pool.query(`INSERT INTO public.catalog_type_versions(type_key,version,definition,definition_digest,validator_ref)
    VALUES($1,$2,'{}',$3,$4)`, [type.key, type.version, definitionDigest, `sha256:${hash("synthetic rules")}`]);
}

export async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

export const invalidReceiptResults = {
  "escaped NUL": '{"value":"\\u0000"}',
  "unpaired Unicode escape": '{"value":"\\uD800"}',
  "excessive nesting": '{"value":' + "[".repeat(30_000) + "0" + "]".repeat(30_000) + "}",
};

export const fixture = () => ({ productId: randomUUID(), skuId: randomUUID(), draftId: randomUUID(), documentId: randomUUID() });
type Fixture = ReturnType<typeof fixture> & { skuCode?: string };
type Head = { publicationId: string; revision: number; documentDigest: string };

export async function graph(db: PoolClient, data: Fixture, before: Head | null = null, stageProduct = true,
  options: { draftRevision?: number; registerExisting?: boolean; registrationText?: string | Record<string, never>; documentText?: string;
    retainedSource?: CatalogPublishedProduct["source"]; authoredDocument?: Record<string, unknown>;
    lifecycle?: "draft" | "active" | "withdrawn" } = {}) {
  const { productId, skuId, draftId, documentId } = data;
  const revision = (before?.revision ?? 0) + 1;
  const draftRevision = options.draftRevision ?? revision;
  const issueId = randomUUID(), skuRevisionId = randomUUID(), approvalId = randomUUID();
  const slug = `article-${productId}`, code = data.skuCode ?? `sku-${skuId}`;
  const canonicalText = options.documentText ?? json(publicationDocuments.retained);
  const document = { id: documentId, productId, revisionNo: 1, schemaId: "example:document", documentRef: "example:ref", sourceRef: "example:source", digest: hash(canonicalText) };
  const content: CatalogPublishedProduct["content"] = { schemaVersion: 1, catalogAction: before ? "revise" : "create", presentation: {},
    requestedModes: [], offerMemberships: [], publicationSkus: [] };
  const quantity = { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 };
  const retained = options.retainedSource;
  const provenance = retained ? { source: "retained_draft", draftId: retained.draftId, draftRevision: retained.revision,
    draftCommandKey: retained.commandKey, draftFingerprint: retained.fingerprint } : { source: "current_draft" };
  const registerDocument = { op: "register_document_revision", productSlug: slug, revisionId: documentId, revisionNo: 1,
    sourceRef: document.sourceRef, documentRef: document.documentRef, canonicalText: options.registrationText ?? canonicalText,
    digest: document.digest, provenance };
  const sharedContent = options.authoredDocument ? { ...content, document: options.authoredDocument } : content;
  const payload = { schemaVersion: 3, product: { id: productId, slug, type, dimensions: [], primarySkuId: skuId, documentRevision: document, sharedContent },
    skus: [{ id: skuId, productId, code, options: {}, netContent: quantity }],
    publication: { kind: "release", evidence: retained ? { drafts: [retained] } : {}, operations: before ? (options.registerExisting ? [registerDocument] : []) : [
      { op: "create_product", productId, productSlug: slug, name: "Article" },
      registerDocument,
      { op: "move_document_pointer", productSlug: slug, documentRevisionNo: 1 },
      { op: "create_sku", skuId, productSlug: slug, documentRevisionNo: 1, skuCode: code, title: "Article", minQuantity: 1, isAddon: false, facts: {} },
      { op: "set_primary_sku", productSlug: slug, skuCode: code },
    ] } };
  if (options.lifecycle !== undefined) {
    const authored = payload as unknown as CatalogDraftPayloadV4;
    authored.schemaVersion = 4;
    if (options.lifecycle === "active") authored.publication.operations.push(
      { op: "set_product_lifecycle", productSlug: slug, expectedState: "draft", state: "active", children: [] },
      { op: "set_sku_lifecycle", skuCode: code, expectedState: "draft", state: "active" },
      { op: "set_eligibility", skuCode: code, sellableStandalone: true, sellableInSubscription: false },
    );
    if (options.lifecycle === "withdrawn") authored.publication.operations.push(
      { op: "set_product_lifecycle", productSlug: slug, expectedState: "active", state: "withdrawn",
        children: [{ skuCode: code, expectedState: "active" }] },
    );
  }
  const draftKey = `draft:${draftRevision}`;
  const source = { draftId, revision: draftRevision, commandKey: draftKey, fingerprint: hash(json(payload)) };
  if (!before && stageProduct) await stageProductRows(db, data, slug, code);
  if (draftRevision === 1) {
    await db.query("INSERT INTO public.catalog_draft_heads(draft_id,product_id,revision,status) VALUES($1,$2,1,'open')", [draftId, productId]);
  } else {
    await db.query("UPDATE public.catalog_draft_heads SET revision=$2 WHERE draft_id=$1", [draftId, draftRevision]);
  }
  await db.query(`INSERT INTO public.catalog_draft_revisions(draft_id,revision,product_id,status,payload,command_key,fingerprint,actor_id)
    VALUES($1,$2,$3,'open',$4,$5,$6,'test-fixture')`, [draftId, draftRevision, productId, json(payload), draftKey, source.fingerprint]);
  await db.query("INSERT INTO public.catalog_draft_command_receipts(draft_id,command_key,fingerprint,revision) VALUES($1,$2,$3,$4)",
    [draftId, draftKey, source.fingerprint, draftRevision]);
  const candidateRef = `v1:${draftId}@${draftRevision}/${before ? `${before.publicationId}@${before.revision}` : "unpublished"}`;
  const candidateDigest = hash(json(["catalog-candidate", 1, payload, [{ ...type, definitionDigest }], before]));
  const commandKey = `issue:${revision}`, fingerprint = hash(commandKey);
  const decisionKey = `approve:${revision}`;
  const time = (await db.query<{ now: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`)).rows[0]!.now;
  const decision: { schemaVersion: number; productId: string; candidateRef: string; candidateDigest: string;
    commandKey: string; action: "approve" | "revoke"; reason: string | null } =
    { schemaVersion: 2, productId, candidateRef, candidateDigest, commandKey: decisionKey, action: "approve", reason: null };
  const product: CatalogPublishedProduct = { id: productId, slug, name: "Article", status: "draft", type, axes: [], attributes: {},
    primarySkuId: skuId, document, presentation: {}, source, content };
  const facts: CatalogPublishedSku = { id: skuId, productId, code, title: before ? `Article ${revision}` : "Article", status: "draft", minQuantity: 1, isAddon: false, sellableStandalone: false,
    sellableInSubscription: false, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 },
    grossMass: null, options: {}, attributes: {}, facts: {} as Record<string, string>, identifiers: [], assetRefs: [], logisticsRef: null, memberships: [], source };
  if (options.lifecycle !== undefined) {
    const state = options.lifecycle, status = state === "withdrawn" ? "active" : state;
    Object.assign(product, { schemaVersion: 3, lifecycleState: state, status, definitionDigest });
    Object.assign(facts, { schemaVersion: 3, lifecycleState: state, status, optionDigest: hash(json(facts.options)), sellableStandalone: state === "active" });
  }
  const head = { publicationId: issueId, revision, documentDigest: document.digest };
  const base = { revision, ...data, approvalId, decision, decisionKey, candidateDigest, candidateRef, commandKey, fingerprint, head,
    product, facts, time, skuRevisionId, before, canonicalText, issueId, source, document };
  return base;
}
export type Graph = Awaited<ReturnType<typeof graph>>;

export async function publicationManifestText(pool: Pool, head: Graph["head"]): Promise<string> {
  const { rows } = await pool.query<{ canonical_state: string }>(
    "SELECT canonical_state FROM public.catalog_publications WHERE id=$1", [head.publicationId],
  );
  return rows[0]!.canonical_state;
}

export async function publishMaximumRoster(pool: Pool) {
  const data = { ...fixture(), skuCode: randomUUID().padEnd(160, "x") };
  const first = await transaction(pool, async db => {
    const issue = await graph(db, data);
    issue.facts.status = "archived";
    await insertGraph(db, issue, { extraSkuCount: 9_998, maxCodes: true });
    return issue;
  });
  const inherited = (JSON.parse(await publicationManifestText(pool, first.head)) as CatalogPublicationManifestV2).skus;
  const latest = await transaction(pool, async db => {
    const issue = await graph(db, data, first.head);
    issue.facts.status = "archived";
    await insertGraph(db, issue, { inherited, onlyNew: true, extraSkuCount: 1, maxCodes: true });
    return issue;
  });
  return { data, latest };
}

export async function stageProductRows(db: PoolClient, data: Fixture,
  slug = `article-${data.productId}`, code = data.skuCode ?? `sku-${data.skuId}`) {
  await db.query("INSERT INTO public.catalog_products(id,slug,name,status,type_key,type_version) VALUES ($1,$2,'Article','draft',$3,$4)",
    [data.productId, slug, type.key, type.version]);
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,net_weight_g) VALUES($1,$2,$3,'Article','draft',100)",
    [data.skuId, data.productId, code]);
}

export async function documentRow(db: PoolClient, value: Graph, storedValue = value.canonicalText) {
  const { document, source } = value;
  await db.query(`INSERT INTO public.catalog_product_document_revisions
    (id,product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
  [document.id, document.productId, document.revisionNo, document.schemaId, document.documentRef, storedValue, document.sourceRef,
    json({ draftId: source.draftId, draftRevision: source.revision, draftCommandKey: source.commandKey, draftFingerprint: source.fingerprint }), document.digest]);
  await db.query(`INSERT INTO public.catalog_publication_pointer_capabilities
    VALUES(pg_current_xact_id(),$1,$2,$3)`, [value.productId, document.id, value.fingerprint]);
  await db.query("UPDATE public.catalog_products SET current_document_revision_id=$2,primary_sku_id=$3 WHERE id=$1", [value.productId, document.id, value.skuId]);
}

export function sealedState(product: CatalogPublishedProduct, references: { skuId: string; digest: string }[]) {
  return json({ schemaVersion: product.schemaVersion ?? 2, product, skus: references.map(({ skuId, digest }) => ({ skuId, digest }))
    .sort((left, right) => left.skuId < right.skuId ? -1 : left.skuId > right.skuId ? 1 : 0) });
}

function decisionEvidence(value: Graph, approvedState?: string) {
  const text = value.decision.action === "approve" ? approvedState ?? sealedState(value.product,
    [{ skuId: value.skuId, digest: hash(json(value.facts)) }]) : null;
  const digest = text === null ? null : hash(text);
  const body = { ...value.decision, ...(digest === null ? {} : { postStateDigest: digest }) };
  return { text, digest, body, fingerprint: hash(json([body, actorId])) };
}

export async function decisionRow(db: PoolClient, value: Graph, approvedState?: string) {
  const seal = decisionEvidence(value, approvedState);
  await db.query(`INSERT INTO public.catalog_publication_decisions
    (id,product_id,candidate_ref,candidate_digest,candidate_reference_digest,action,actor_id,command_key,fingerprint,
      decided_at,reason,post_state_canonical_text,post_state_digest)
    VALUES($1,$2,$3,$4,$5,$10,$6,$7,$8,$9,$11,$12,$13)`, [
    value.approvalId, value.productId, value.candidateRef, value.candidateDigest, hash(json([value.candidateRef,value.candidateDigest])),
    actorId, value.decisionKey, seal.fingerprint, value.time, value.decision.action, value.decision.reason, seal.text, seal.digest,
  ]);
}

export async function decisionReceipt(db: PoolClient, value: Graph, approvedState?: string) {
  const seal = decisionEvidence(value, approvedState);
  await db.query("INSERT INTO public.catalog_operator_receipts(kind,scope_id,command_key,fingerprint,actor_id,result) VALUES($6,$1,$2,$3,$4,$5)", [
    value.productId, value.decisionKey, seal.fingerprint, actorId,
    json({ ...seal.body, fingerprint: seal.fingerprint, actorId, decidedAt: value.time }), value.decision.action,
  ]);
}

export async function skuRow(db: PoolClient, value: Graph, issueOrdinal = 1, facts = json(value.facts)) {
  await db.query(`INSERT INTO public.catalog_sku_revisions
    (id,sku_id,sku_code,product_id,revision,publication_id,issue_ordinal,full_facts,digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
    value.skuRevisionId, value.skuId, value.facts.code, value.productId, value.revision, value.issueId, issueOrdinal, facts, hash(facts),
  ]);
}

export async function insertGraph(db: PoolClient, value: Graph, options: {
  order?: "child-first"; receipt?: "omit" | "timestamp"; roster?: "omit"; head?: "omit"; rawState?: (state: string) => string; rawFacts?: (facts: string) => string;
  existingDocument?: boolean; omitProductProjection?: boolean; extraSkuCount?: number; approvalTime?: string; reuseApproval?: boolean; approvedState?: string;
  receiptResult?: string;
  inherit?: CatalogSkuRevisionRef; inherited?: CatalogSkuRevisionRef[]; onlyNew?: boolean; skuRevision?: number; maxCodes?: boolean;
} = {}) {
  if (!value.before && !options.existingDocument) await documentRow(db, value);
  const { productId, skuId, issueId, revision, before, head } = value;
  const extras = Array.from({ length: options.extraSkuCount ?? 0 }, () => {
    const skuId = randomUUID();
    return { ...value, skuId, skuRevisionId: randomUUID(), revision: 1, facts: { ...value.facts, id: skuId, code: options.maxCodes ? skuId.padEnd(160, "x") : `sku-${skuId}` } };
  });
  const issued = (options.inherit ? [] : options.onlyNew ? extras : [{ ...value, revision: options.skuRevision ?? revision }, ...extras]).sort((left, right) => left.skuId.localeCompare(right.skuId));
  const factBytes = issued.map(sku => {
    const text = json(sku.facts);
    return options.rawFacts?.(text) ?? text;
  });
  const newReferences = issued.map((sku, index) => ({
    skuId: sku.skuId, revisionId: sku.skuRevisionId, revision: sku.revision, digest: hash(factBytes[index]!),
  }));
  const changed = new Set<string>(newReferences.map(ref => ref.skuId));
  const references = (options.inherit ? [options.inherit] : [
    ...(options.inherited ?? []).filter(ref => !changed.has(ref.skuId)), ...newReferences,
  ]).sort((left, right) => left.skuId < right.skuId ? -1 : left.skuId > right.skuId ? 1 : 0);
  const schemaVersion = value.product.schemaVersion ?? 2;
  const encoded = json({ schemaVersion, product: value.product, skus: options.roster === "omit" ? [] : references });
  const state = options.rawState?.(encoded) ?? encoded;
  const recorded = {
    schemaVersion, productId, commandKey: value.commandKey, fingerprint: value.fingerprint, actorId, previousHead: before, head,
    publicationDigest: hash(state), committedAt: options.receipt === "timestamp" ? "2000-01-01T00:00:00.000000Z" : value.time,
    changes: issued.map(sku => ({ productId, variantId: sku.skuId, sku: sku.facts.code, state: sku.facts.lifecycleState ?? (sku.facts.status === "archived" ? "withdrawn" : sku.facts.status), variantRevision: sku.revision,
      publicationHead: head, draftRef: { draftId: value.draftId, revision: value.source.revision } })),
  };
  async function issue() {
    await db.query(`INSERT INTO public.catalog_publications
      (id,product_id,revision,issued_count,approval_id,command_fingerprint,previous_id,draft_id,draft_revision,command_key,
        candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id,committed_at)
      VALUES($1,$2,$3,$17,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [issueId, productId, revision, value.approvalId, value.fingerprint, before?.publicationId, value.draftId, value.source.revision, value.commandKey,
      value.candidateRef, value.candidateDigest, value.documentId, state, hash(state), actorId, value.time, issued.length]);
  }
  if (options.order !== "child-first") await issue();
  const approval = { ...value, time: options.approvalTime ?? value.time };
  if (!options.reuseApproval) {
    const approved = options.approvedState ?? sealedState(value.product, references);
    await decisionRow(db, approval, approved);
    await decisionReceipt(db, approval, approved);
  }
  if (extras.length) await db.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,status,net_weight_g)
    SELECT item.id,$1,item.code,'Article','draft',100 FROM unnest($2::uuid[],$3::text[]) AS item(id,code)`, [
    productId, extras.map(sku => sku.skuId), extras.map(sku => sku.facts.code),
  ]);
  if (issued.length) await db.query(`INSERT INTO public.catalog_sku_revisions
    (id,sku_id,sku_code,product_id,revision,publication_id,issue_ordinal,full_facts,digest)
    SELECT id,sku_id,code,$1,revision,$2,ordinality,facts,digest
    FROM unnest($3::uuid[],$4::uuid[],$5::text[],$6::integer[],$7::text[],$8::text[]) WITH ORDINALITY
      item(id,sku_id,code,revision,facts,digest,ordinality)`, [productId, issueId,
    issued.map(sku => sku.skuRevisionId), issued.map(sku => sku.skuId), issued.map(sku => sku.facts.code),
    issued.map(sku => sku.revision), factBytes, newReferences.map(ref => ref.digest)]);

  if (options.head !== "omit") await db.query(`INSERT INTO public.catalog_publication_heads VALUES($1,$2,$3)
     ON CONFLICT (product_id) DO UPDATE SET publication_id=excluded.publication_id,revision=excluded.revision`, [productId, issueId, revision]);
  if (options.receipt !== "omit") await db.query("INSERT INTO public.catalog_operator_receipts VALUES('publish',$1,$2,$3,$4,$5,$6)", [
    productId, value.commandKey, value.fingerprint, actorId, issueId, options.receiptResult ?? json(recorded),
  ]);
  if (options.order === "child-first") await issue();
  if (!options.omitProductProjection) await db.query("UPDATE public.catalog_products SET publication_facts=$2,variant_axes=$3,attribute_values=$4, status=coalesce($5,status) WHERE id=$1",
    [productId, json(value.product), value.product.axes, json(value.product.attributes), value.product.lifecycleState ? value.product.status : null]);
  if (issued.length) await db.query(`UPDATE public.catalog_skus s SET title=f->>'title', publication_facts=f,
      status=f->>'status',sellable_standalone=(f->>'sellableStandalone')::boolean,sellable_in_subscription=(f->>'sellableInSubscription')::boolean,
      option_values=f->'options',attribute_values=f->'attributes',
      combination_digest=CASE WHEN f ? 'optionDigest' THEN decode(f->>'optionDigest','hex') ELSE s.combination_digest END,
      net_content_dimension='mass',net_content_unit='openlup:g',
      net_content_unscaled=100,net_content_scale=0
    FROM jsonb_array_elements($1::jsonb) AS f WHERE s.id=(f->>'id')::uuid`, [json(issued.map(sku => sku.facts))]);
  for (const { skuId, facts } of issued) {
    for (const id of facts.identifiers) await db.query(`INSERT INTO public.catalog_sku_identifiers
      (catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,is_primary) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [skuId, id.issuer, id.scheme === "gs1:gtin" ? "gtin" : "other", id.scheme === "gs1:gtin" ? id.value.padStart(14, "0") : id.value,
      id.packagingLevel === "unit" ? "unit" : "collective", id.quantity, id.isPrimary]);
  }
  return recorded;
}
