import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalCatalogPublicationJson, type CatalogPublishedSku, type CatalogPublishedProduct } from "../../server/adapters/postgres/catalogPublicationWire.js";

export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const json = canonicalCatalogPublicationJson;
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

export const fixture = () => ({ productId: randomUUID(), skuId: randomUUID(), draftId: randomUUID(), documentId: randomUUID() });
type Fixture = ReturnType<typeof fixture>;
type Head = { publicationId: string; revision: number; documentDigest: string };

export async function graph(db: PoolClient, data: Fixture, before: Head | null = null, stageProduct = true) {
  const { productId, skuId, draftId, documentId } = data;
  const revision = (before?.revision ?? 0) + 1;
  const issueId = randomUUID(), skuRevisionId = randomUUID(), approvalId = randomUUID();
  const slug = `article-${productId}`, code = `sku-${skuId}`;
  const canonicalText = json({ label: "retained immutable bytes" });
  const document = { id: documentId, productId, revisionNo: 1, schemaId: "example:document", documentRef: "example:ref", sourceRef: "example:source", digest: hash(canonicalText) };
  const content: CatalogPublishedProduct["content"] = { schemaVersion: 1, catalogAction: before ? "revise" : "create", presentation: {},
    requestedModes: [], offerMemberships: [], publicationSkus: [] };
  const quantity = { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 };
  const payload = { schemaVersion: 3, product: { id: productId, slug, type, dimensions: [], primarySkuId: skuId, documentRevision: document, sharedContent: content },
    skus: [{ id: skuId, productId, code, options: {}, netContent: quantity }],
    publication: { kind: "release", evidence: {}, operations: before ? [] : [
      { op: "create_product", productId, productSlug: slug, name: "Article" },
      { op: "register_document_revision", productSlug: slug, revisionId: documentId, revisionNo: 1,
        sourceRef: document.sourceRef, documentRef: document.documentRef, canonicalText, digest: document.digest,
        provenance: { source: "current_draft" } },
      { op: "move_document_pointer", productSlug: slug, documentRevisionNo: 1 },
      { op: "create_sku", skuId, productSlug: slug, documentRevisionNo: 1, skuCode: code, title: "Article", minQuantity: 1, isAddon: false, facts: {} },
      { op: "set_primary_sku", productSlug: slug, skuCode: code },
    ] } };
  const draftKey = `draft:${revision}`;
  const source = { draftId, revision, commandKey: draftKey, fingerprint: hash(json(payload)) };
  if (!before) {
    if (stageProduct) {
      await db.query("INSERT INTO public.catalog_products(id,slug,name,status,type_key,type_version) VALUES ($1,$2,'Article','draft',$3,$4)", [productId, slug, type.key, type.version]);
      await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,net_weight_g) VALUES($1,$2,$3,'Article','draft',100)", [skuId, productId, code]);
    }
    await db.query("INSERT INTO public.catalog_draft_heads(draft_id,product_id,revision,status) VALUES($1,$2,1,'open')", [draftId, productId]);
  } else {
    await db.query("UPDATE public.catalog_draft_heads SET revision=$2 WHERE draft_id=$1", [draftId, revision]);
  }
  await db.query(`INSERT INTO public.catalog_draft_revisions(draft_id,revision,product_id,status,payload,command_key,fingerprint,actor_id)
    VALUES($1,$2,$3,'open',$4,$5,$6,'test-fixture')`, [draftId, revision, productId, json(payload), draftKey, source.fingerprint]);
  await db.query("INSERT INTO public.catalog_draft_command_receipts(draft_id,command_key,fingerprint,revision) VALUES($1,$2,$3,$4)",
    [draftId, draftKey, source.fingerprint, revision]);
  const candidateRef = `v1:${draftId}@${revision}/${before ? `${before.publicationId}@${before.revision}` : "unpublished"}`;
  const candidateDigest = hash(json(["catalog-candidate", 1, payload, [{ ...type, definitionDigest }], before]));
  const commandKey = `issue:${revision}`, fingerprint = hash(commandKey);
  const decisionKey = `approve:${revision}`;
  const time = (await db.query<{ now: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`)).rows[0]!.now;
  const decision: { schemaVersion: number; productId: string; candidateRef: string; candidateDigest: string;
    commandKey: string; action: "approve" | "revoke"; reason: string | null } =
    { schemaVersion: 2, productId, candidateRef, candidateDigest, commandKey: decisionKey, action: "approve", reason: null };
  const decisionFingerprint = hash(json([decision, actorId]));
  const product: CatalogPublishedProduct = { id: productId, slug, name: "Article", status: "draft", type, axes: [], attributes: {},
    primarySkuId: skuId, document, presentation: {}, source, content };
  const facts: CatalogPublishedSku = { id: skuId, productId, code, title: `Article ${revision}`, status: "draft", minQuantity: 1, isAddon: false, sellableStandalone: false,
    sellableInSubscription: false, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 },
    grossMass: null, options: {}, attributes: {}, facts: {} as Record<string, string>, identifiers: [], assetRefs: [], logisticsRef: null, memberships: [], source };
  const head = { publicationId: issueId, revision, documentDigest: document.digest };
  const base = { revision, ...data, approvalId, decision, decisionKey, decisionFingerprint, candidateDigest, candidateRef, commandKey, fingerprint, head,
    product, facts, time, skuRevisionId, before, canonicalText, issueId, source, document };
  return base;
}
export type Graph = Awaited<ReturnType<typeof graph>>;

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

export async function decisionRow(db: PoolClient, value: Graph) {
  await db.query(`INSERT INTO public.catalog_publication_decisions
    (id,product_id,candidate_ref,candidate_digest,candidate_reference_digest,action,actor_id,command_key,fingerprint,decided_at,reason)
    VALUES($1,$2,$3,$4,$5,$10,$6,$7,$8,$9,$11)`, [
    value.approvalId, value.productId, value.candidateRef, value.candidateDigest, hash(json([value.candidateRef,value.candidateDigest])),
    actorId, value.decisionKey, value.decisionFingerprint, value.time, value.decision.action, value.decision.reason,
  ]);
}

export async function decisionReceipt(db: PoolClient, value: Graph) {
  await db.query("INSERT INTO public.catalog_operator_receipts(kind,scope_id,command_key,fingerprint,actor_id,result) VALUES($6,$1,$2,$3,$4,$5)", [
    value.productId, value.decisionKey, value.decisionFingerprint, actorId,
    json({ ...value.decision, fingerprint: value.decisionFingerprint, actorId, decidedAt: value.time }), value.decision.action,
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
  existingDocument?: boolean; omitProductProjection?: boolean; extraSkuCount?: number; approvalTime?: string;
  inherit?: { skuId: string; revisionId: string; revision: number; digest: string };
} = {}) {
  if (!value.before && !options.existingDocument) await documentRow(db, value);
  const { productId, skuId, issueId, revision, before, head } = value;
  const extras = Array.from({ length: options.extraSkuCount ?? 0 }, () => {
    const skuId = randomUUID();
    return { ...value, skuId, skuRevisionId: randomUUID(), facts: { ...value.facts, id: skuId, code: `sku-${skuId}` } };
  });
  const issued = (options.inherit ? [] : [value, ...extras]).sort((left, right) => left.skuId.localeCompare(right.skuId));
  const factBytes = issued.map(sku => {
    const text = json(sku.facts);
    return options.rawFacts?.(text) ?? text;
  });
  const references = options.inherit ? [options.inherit] : issued.map((sku, index) => ({
    skuId: sku.skuId, revisionId: sku.skuRevisionId, revision, digest: hash(factBytes[index]!),
  }));
  const encoded = json({ schemaVersion: 2, product: value.product, skus: options.roster === "omit" ? [] : references });
  const state = options.rawState?.(encoded) ?? encoded;
  const recorded = {
    schemaVersion: 2, productId, commandKey: value.commandKey, fingerprint: value.fingerprint, actorId, previousHead: before, head,
    publicationDigest: hash(state), committedAt: options.receipt === "timestamp" ? "2000-01-01T00:00:00.000000Z" : value.time,
    changes: issued.map(sku => ({ productId, variantId: sku.skuId, sku: sku.facts.code, state: sku.facts.status, variantRevision: revision,
      publicationHead: head, draftRef: { draftId: value.draftId, revision } })),
  };
  async function issue() {
    await db.query(`INSERT INTO public.catalog_publications
      (id,product_id,revision,issued_count,approval_id,command_fingerprint,previous_id,draft_id,draft_revision,command_key,
        candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id,committed_at,primary_sku_revision_id)
      VALUES($1,$2,$3,$17,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$18)`,
    [issueId, productId, revision, value.approvalId, value.fingerprint, before?.publicationId, value.draftId, revision, value.commandKey,
      value.candidateRef, value.candidateDigest, value.documentId, state, hash(state), actorId, value.time, issued.length,
      options.inherit?.revisionId ?? value.skuRevisionId]);
  }
  if (options.order !== "child-first") await issue();
  const approval = { ...value, time: options.approvalTime ?? value.time };
  await decisionRow(db, approval);
  await decisionReceipt(db, approval);
  if (extras.length) await db.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,status,net_weight_g)
    SELECT item.id,$1,item.code,'Article','draft',100 FROM unnest($2::uuid[],$3::text[]) AS item(id,code)`, [
    productId, extras.map(sku => sku.skuId), extras.map(sku => sku.facts.code),
  ]);
  for (const [index, sku] of issued.entries()) await skuRow(db, sku, index + 1, factBytes[index]);
  if (options.head !== "omit") await db.query(`INSERT INTO public.catalog_publication_heads VALUES($1,$2,$3)
     ON CONFLICT (product_id) DO UPDATE SET publication_id=excluded.publication_id,revision=excluded.revision`, [productId, issueId, revision]);
  if (options.receipt !== "omit") await db.query("INSERT INTO public.catalog_operator_receipts VALUES('publish',$1,$2,$3,$4,$5,$6)", [
    productId, value.commandKey, value.fingerprint, actorId, issueId, json(recorded),
  ]);
  if (options.order === "child-first") await issue();
  if (!options.omitProductProjection) await db.query("UPDATE public.catalog_products SET publication_facts=$2,variant_axes=$3,attribute_values=$4 WHERE id=$1",
    [productId, json(value.product), value.product.axes, json(value.product.attributes)]);
  for (const { skuId, facts } of issued) {
    await db.query(`UPDATE public.catalog_skus SET title=$2,publication_facts=$3,
      sellable_standalone=$4,sellable_in_subscription=$5,option_values=$6,attribute_values=$7,
      net_content_dimension='mass',net_content_unit='openlup:g',net_content_unscaled=100,net_content_scale=0 WHERE id=$1`,
    [skuId, facts.title, json(facts), facts.sellableStandalone, facts.sellableInSubscription, json(facts.options), json(facts.attributes)]);
    for (const id of facts.identifiers) await db.query(`INSERT INTO public.catalog_sku_identifiers
      (catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,is_primary) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [skuId, id.issuer, id.scheme === "gs1:gtin" ? "gtin" : "other", id.scheme === "gs1:gtin" ? id.value.padStart(14, "0") : id.value,
      id.packagingLevel === "unit" ? "unit" : "collective", id.quantity, id.isPrimary]);
  }
  return recorded;
}
