import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogHeadRef, CatalogPublishCommand } from "./contracts/lifecycle.js";
import type { CatalogProductTypeDefinition } from "./contracts/productTypes.js";
import type { CatalogPublishedSku } from "./publicationContracts.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import { validateCatalogAttributes } from "./attributeValidation.js";
import { prepareCatalogAttributeProjection } from "./attributeProjection.js";
import { canonicalizeCatalogCombinationV2 } from "./variantCombination.js";
import type { CatalogPublicationDocument, CatalogPublicationDraftEvidence, CatalogPublicationEvidence, ExpectedPublicationHead } from "./publicationEvidence.js";
import { matchesPublicationHead, publicationHeadSchema } from "./publicationEvidence.js";
import { decodePublicationPacket, requireDecodedPublication, decodeStoredPublicationSku, publicationDigest, publicationJson, SKU_PAGE_DEPTH } from "./publicationCodec.js";
import { isValidGtin } from "./foundationSchemas.js";
import { readPublicationDraftRecord } from "./publicationIntent.js";
import type { parseCatalogCandidateReference } from "./candidateService.js";
import type { compileCatalogPublication } from "./publicationValidation.js";
import { CatalogPublicationError, publicationIssue, publicationPriceRefusalReason, refusePublicationCommand, publicationRemedy,
  type AdmissionDiagnostic } from "./publicationError.js";
import { assertPublishedSkuIdentity } from "./publicationSkuIdentity.js";
import { canonicalCatalogPriceSetupCommand, catalogPriceSetupApplyResultSchema } from "../pricing/index.js";

type Plan = Awaited<ReturnType<typeof compileCatalogPublication>>;
type Reference = NonNullable<ReturnType<typeof parseCatalogCandidateReference>>;

function requireProjection(condition: unknown, code: AdmissionDiagnostic,
  outcome: CatalogPublicationError["outcome"] = "conflict"): asserts condition {
  if (!condition) refusePublicationCommand(code, outcome);
}
const same = (a: unknown, b: unknown) => publicationJson(a) === publicationJson(b);

export async function readNativeDraftEvidence(db: PgQueryExecutor, reference: Reference) {
  const current = readPublicationDraftRecord((await db.query("SELECT public.catalog_draft_record($1,$2) AS record",
    [reference.draftId, reference.draftRevision])).rows[0]?.record);
  const publication = current?.payload.schemaVersion === 3 ? current.payload.publication : undefined;
  const claimed = (publication?.evidence.drafts ?? []).map(({ draftId, revision }) => ({ draftId, revision }));
  const origins = (publication?.operations ?? []).flatMap(operation => operation.op === "register_document_revision"
    && operation.provenance.source === "retained_draft"
    ? [{ draftId: operation.provenance.draftId, revision: operation.provenance.draftRevision }] : []);
  const ids = new Set([reference.draftId, ...claimed.map(row => row.draftId), ...origins.map(row => row.draftId)]);
  // Attached issues and documents can supply omitted physical sources. These
  // rows are immutable and belong to the same product, whose draft head is unique.
  return {
    draftIds: [...ids],
    async read(): Promise<CatalogPublicationDraftEvidence[]> {
      if (!current) return [];
      const { rows } = await db.query(`WITH selected AS (
        SELECT $1::uuid AS draft_id,$2::integer AS revision,2147483647 AS issued
        UNION ALL SELECT x."draftId",x.revision,0
          FROM jsonb_to_recordset($3::jsonb) AS x("draftId" uuid,revision integer)
        UNION ALL SELECT p.draft_id,p.draft_revision,p.revision
          FROM public.catalog_publications p WHERE p.product_id=$4
        UNION ALL SELECT (d.provenance->>'draftId')::uuid,(d.provenance->>'draftRevision')::integer,0
          FROM public.catalog_product_document_revisions d WHERE d.product_id=$4
      ), sources AS (
        SELECT draft_id,revision,max(issued) AS issued FROM selected GROUP BY draft_id,revision
      )
      SELECT public.catalog_draft_record(r.draft_id,r.revision) AS record,
        jsonb_build_object('draftId',r.draft_id,'revision',r.revision,'commandKey',r.command_key,'fingerprint',r.fingerprint) AS receipt,
        jsonb_build_object('draftId',h.draft_id,'productId',h.product_id,'revision',h.revision,'status',h.status) AS head
      FROM sources s JOIN public.catalog_draft_revisions d ON (s.draft_id,s.revision)=(d.draft_id,d.revision)
      JOIN public.catalog_draft_command_receipts r
        ON (r.draft_id,r.command_key,r.revision,r.fingerprint)=(d.draft_id,d.command_key,d.revision,d.fingerprint)
      JOIN public.catalog_draft_heads h ON h.draft_id=d.draft_id
      WHERE h.product_id=$4 AND d.status='open' AND d.payload->'schemaVersion'='3'::jsonb
      ORDER BY s.issued DESC,s.draft_id,s.revision DESC`,
      [reference.draftId, reference.draftRevision, JSON.stringify([...claimed, ...origins]), current.productId]);
      return rows.flatMap(row => {
        const record = readPublicationDraftRecord(row.record);
        return record ? [{ record, head: row.head as CatalogPublicationDraftEvidence["head"],
          receipt: row.receipt as CatalogPublicationDraftEvidence["receipt"] }] : [];
      });
    },
  };
}

export async function publicationRelationFence(db: PgQueryExecutor, productId: string) {
  const { rows } = await db.query("SELECT current_user = 'openlup_catalog_publication' AS restricted");
  if (rows[0]?.restricted === true) await db.query("SELECT public.catalog_publication_lock_projection()");
  else await db.query(`LOCK TABLE public.catalog_products, public.catalog_skus, public.catalog_sku_identifiers,
    public.catalog_product_document_revisions, public.catalog_attribute_projection IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  await db.query("SELECT id FROM public.catalog_products WHERE id=$1 FOR NO KEY UPDATE NOWAIT", [productId]);
  await db.query("SELECT product_id FROM public.catalog_publication_heads WHERE product_id=$1 FOR NO KEY UPDATE NOWAIT", [productId]);
  await db.query("SELECT id FROM public.catalog_skus WHERE product_id=$1 ORDER BY id FOR NO KEY UPDATE NOWAIT", [productId]);
}

async function readPublicationHead(db: PgQueryExecutor, productId: string) {
  // READ COMMITTED gives this statement a fresh view after the fence.
  const { rows: [row] } = await db.query(`SELECT p.canonical_state,p.digest,
    public.catalog_publication_head_ref($1,p.id) AS head,
    EXISTS(SELECT 1 FROM public.catalog_products WHERE id=$1) AS live
    FROM (SELECT $1::uuid AS product_id) scope
    LEFT JOIN public.catalog_publication_heads h USING(product_id)
    LEFT JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id)`, [productId]);
  return row;
}

export async function readPreviousPublication(db: PgQueryExecutor, productId: string,
  expected: ExpectedPublicationHead | null, checkLive: boolean) {
  const row = await readPublicationHead(db, productId);
  const head = publicationHeadSchema.nullable().parse(row?.head);
  requireProjection(matchesPublicationHead(expected, head), "head_conflict");
  requireProjection(head || row?.live === false, "catalog_publication_lineage_unknown", "unsupported");
  const manifest = head ? requireDecodedPublication(decodePublicationPacket({ manifest: row?.canonical_state })) : null;
  if (manifest) {
    requireProjection(publicationDigest(manifest) === row?.digest && manifest.product.id === productId
      && manifest.product.document?.digest === head?.documentDigest, "catalog_publication_manifest_invalid", "validation_issue");
    if (checkLive) {
      await assertPublishedSkuIdentity(db, productId);
      const live = (await db.query("SELECT public.catalog_publication_live_matches($1,$2::jsonb,$3::jsonb) AS matches",
        [productId, JSON.stringify(manifest.product), JSON.stringify(manifest.skus)])).rows[0]?.matches;
      requireProjection(live === true, "catalog_publication_live_drift");
    }
  }
  const retained = new Map<unknown, Record<string, unknown>>();
  if (manifest?.skus.length) {
    const { rows } = await db.query(`SELECT r.id,r.sku_id,r.revision,r.digest,r.full_facts
      FROM public.catalog_sku_revisions r WHERE product_id=$1 AND id=ANY($2::uuid[])`,
    [productId, manifest.skus.map(row => row.revisionId)]);
    for (const row of rows) retained.set(row.id, row);
  }
  const skus = (manifest?.skus ?? []).map(ref => {
    const row = retained.get(ref.revisionId);
    const sku = decodeStoredPublicationSku(row?.full_facts);
    requireProjection(row && ref.skuId === row.sku_id && ref.revision === row.revision && ref.digest === row.digest
      && ref.skuId === sku.id && sku.productId === productId && publicationDigest(sku, undefined, SKU_PAGE_DEPTH) === ref.digest,
    "catalog_publication_sku_revision_invalid", "validation_issue");
    return sku;
  });
  const { rows: documents } = await db.query(`SELECT jsonb_build_object('id',d.id,'productId',d.product_id,'revisionNo',d.revision_no,
    'schemaId',d.schema_id,'documentRef',d.document_ref,'sourceRef',d.source_ref,'digest',d.digest) AS reference,
    d.provenance,origin.canonical
    FROM public.catalog_product_document_revisions d
    LEFT JOIN LATERAL (
      SELECT op->>'canonicalText' AS canonical FROM public.catalog_draft_revisions r
      JOIN public.catalog_draft_command_receipts c
        ON (r.draft_id,r.revision,r.command_key,r.fingerprint)=(c.draft_id,c.revision,c.command_key,c.fingerprint)
      CROSS JOIN LATERAL jsonb_array_elements(r.payload #> '{publication,operations}') AS op
      WHERE r.product_id=d.product_id AND r.status='open' AND d.provenance=jsonb_build_object(
        'draftId',r.draft_id,'draftRevision',r.revision,'draftCommandKey',r.command_key,'draftFingerprint',r.fingerprint)
        AND op->>'op'='register_document_revision' AND op->>'revisionId'=d.id::text AND op->>'digest'=d.digest
        AND (op->>'canonicalText')::jsonb=d.document_payload
        AND encode(sha256(convert_to(op->>'canonicalText','UTF8')),'hex')=d.digest
    ) origin ON true WHERE d.product_id=$1 ORDER BY d.revision_no`, [productId]);
  const evidence: Omit<CatalogPublicationEvidence, "drafts"> = {
    head, product: manifest?.product ?? null, skus,
    documents: documents.map(row => ({ reference: row.reference as CatalogPublicationDocument["reference"],
      canonicalText: typeof row.canonical === "string" ? row.canonical : "", provenance: row.provenance as CatalogPublicationDocument["provenance"] })),
    documentRevisionHighWater: (documents.at(-1)?.reference as CatalogPublicationDocument["reference"] | undefined)?.revisionNo ?? 0,
  };
  return { head, manifest, evidence };
}

export async function assertCurrentPublicationRoster(db: PgQueryExecutor, productId: string) {
  const row = await readPublicationHead(db, productId);
  if (row?.head) requireDecodedPublication(decodePublicationPacket({ manifest: row.canonical_state }));
}

const effectivePriceList = `SELECT id,region_code,currency FROM public.price_lists
  WHERE region_code=public.catalog_price_setup_region_code() AND currency=public.catalog_price_setup_settlement_currency()
    AND status='active' AND valid_from<=statement_timestamp() AND (valid_to IS NULL OR valid_to>statement_timestamp())
  ORDER BY created_at DESC,id DESC LIMIT 1`;

function refusePriceOperation(operation: Plan["priceOperations"][number], reason: unknown, outcome: CatalogPublicationError["outcome"]): never {
  const parsed = publicationPriceRefusalReason.safeParse(reason);
  if (!parsed.success) return refusePublicationCommand("catalog_publication_price_unavailable", "dependency_unavailable");
  const code = parsed.data;
  if (code === "price_list_not_found")
    throw new CatalogPublicationError(publicationIssue(code, "pricing", "skus.priceOperations.priceListId", operation.priceListId), outcome);
  if (code !== "command_key_reused") return refusePublicationCommand(code, outcome);
  throw new CatalogPublicationError({
    ...publicationIssue(code, "pricing", "skus.priceOperations", operation.commandKey),
    detail: `Price command "${operation.commandKey}". ${publicationRemedy(code)}`,
  }, outcome);
}

async function claimPrices(db: PgQueryExecutor, operations: Plan["priceOperations"], priced: CatalogPublishedSku[]) {
  const claims = new Map<string, unknown>();
  const contexts = new Map<string, { priceListId: string; variantId: string }>();
  for (const operation of [...operations].sort((a, b) => Buffer.compare(Buffer.from(a.commandKey), Buffer.from(b.commandKey)))) {
    requireProjection(!claims.has(operation.commandKey), "catalog_publication_price_key_reused", "validation_issue");
    const text = canonicalCatalogPriceSetupCommand(operation);
    const { rows } = await db.query("SELECT public.catalog_price_setup_claim($1,encode(sha256(convert_to($1,'UTF8')),'hex')) AS result", [text]);
    const result = rows[0]?.result as { outcome?: string; reason?: string } | undefined;
    if (result?.outcome !== "claimed" && result?.outcome !== "replayed") {
      const outcome = result?.outcome;
      refusePriceOperation(operation, result?.reason,
        outcome === "conflict" || outcome === "unauthorized" || outcome === "validation_issue" ? outcome : "dependency_unavailable");
    }
    claims.set(operation.commandKey, result);
    contexts.set(`${operation.priceListId}:${operation.variantId}`, operation);
  }
  const selectedId = priced.length ? (await db.query(effectivePriceList)).rows[0]?.id : undefined;
  const listId = typeof selectedId === "string" ? selectedId : undefined;
  if (listId) for (const sku of priced) {
    contexts.set(`${listId}:${sku.id}`, { priceListId: listId, variantId: sku.id });
  }
  for (const key of [...contexts.keys()].sort()) {
    const operation = contexts.get(key)!;
    await db.query("SELECT public.catalog_price_setup_lock_context($1,$2)", [operation.priceListId, operation.variantId]);
  }
  return { claims, listId };
}

async function assertSkuPrices(db: PgQueryExecutor, priced: CatalogPublishedSku[], reservedList: string | undefined) {
  if (!priced.length) return;
  // The effective list, individual entries and policy are read together after the LC3 context waits.
  // Port the donor's SKU eligibility price check and its separate overriding-entry check.
  const { rows } = await db.query(`
    WITH list AS (${effectivePriceList}), policy AS (
      SELECT count(*) AS history, count(*) FILTER (WHERE effective) AS effective_count,
        bool_and(p.rounding_rule='FLOOR_TO_QUANTUM' AND p.rounding_quantum_minor>0 AND p.discount_bps BETWEEN 0 AND 10000
          AND p.digest=public.catalog_price_setup_policy_digest(
            p.id,p.revision_no,p.price_list_id,p.region_code,p.currency,p.channel,p.effective_from,
            CASE WHEN p.closed_from_open THEN NULL ELSE p.effective_to END,p.discount_bps,p.rounding_quantum_minor,p.rounding_rule))
          FILTER (WHERE effective) AS valid,
        min(p.discount_bps) FILTER (WHERE effective) AS discount,
        min(p.rounding_quantum_minor) FILTER (WHERE effective) AS quantum
      FROM public.subscription_price_policy_revisions p JOIN list l
        ON (p.price_list_id,p.region_code,p.currency)=(l.id,l.region_code,l.currency)
      CROSS JOIN LATERAL (SELECT p.effective_from<=statement_timestamp()
        AND (p.effective_to IS NULL OR p.effective_to>statement_timestamp()) AS effective) timing
      WHERE p.channel='D2C'
    )
    SELECT sku.id,list.id AS list_id, price.invalid_shape,
      COALESCE(price.base_count=1 AND price.base_minor>0 AND (
        (policy.history=0 AND price.subscription_count=1 AND price.subscription_valid=1)
        OR (policy.history>0 AND policy.effective_count=1 AND policy.valid AND price.subscription_count=0
          AND (price.base_minor::bigint*(10000-policy.discount)/10000/NULLIF(policy.quantum,0))*policy.quantum>0)
      ), false) AS ready
    FROM unnest($1::uuid[]) sku(id) LEFT JOIN list ON true CROSS JOIN policy
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE e.mode='one_time' AND e.min_qty=1) AS base_count,
        min(e.unit_price_minor) FILTER (WHERE e.mode='one_time' AND e.min_qty=1 AND e.amount_kind='gross') AS base_minor,
        count(*) FILTER (WHERE e.mode='subscription') AS subscription_count,
        count(*) FILTER (WHERE e.mode='subscription' AND e.min_qty=1 AND e.amount_kind='gross'
          AND e.unit_price_minor>0) AS subscription_valid,
        bool_or(e.mode='any' OR e.amount_kind<>'gross' OR e.min_qty<>1) AS invalid_shape
      FROM public.price_entries e WHERE e.price_list_id=list.id AND e.variant_id=sku.id AND e.active
        AND e.valid_from<=statement_timestamp() AND (e.valid_to IS NULL OR e.valid_to>statement_timestamp())
        AND e.mode IN ('one_time','subscription','any')
    ) price ORDER BY sku.id`, [priced.map(sku => sku.id)]);
  const codes = new Map<unknown, string>(priced.map(sku => [sku.id, sku.code]));
  for (const row of rows) {
    requireProjection(row.list_id, "price_list_not_active", "validation_issue");
    requireProjection(row.list_id === reservedList, "catalog_publication_price_readiness", "validation_issue");
    if (row.ready && !row.invalid_shape) continue;
    const code = row.ready ? "catalog_publication_sku_price_shape_invalid" : "catalog_publication_sku_price_not_ready";
    throw new CatalogPublicationError(publicationIssue(code, "activation", "skus", codes.get(row.id)));
  }
}

async function applyPrices(db: PgQueryExecutor, operations: Plan["priceOperations"], claims: Map<string, unknown>, actor: string) {
  for (const operation of operations) {
    const claim = claims.get(operation.commandKey) as { outcome: string };
    const raw = claim.outcome === "replayed" ? claim : (await db.query(
      "SELECT public.catalog_price_setup_apply_claimed($1::jsonb,statement_timestamp()) AS result", [JSON.stringify(claim)])).rows[0]?.result;
    const result = catalogPriceSetupApplyResultSchema.safeParse(raw);
    requireProjection(result.success, "catalog_publication_price_unavailable", "dependency_unavailable");
    if (!("receipt" in result.data)) refusePriceOperation(operation, result.data.reason, result.data.outcome);
    const { receipt } = result.data;
    requireProjection(receipt.actorId === actor && receipt.commandKey === operation.commandKey && receipt.variantId === operation.variantId
      && receipt.priceListId === operation.priceListId && (receipt.previous?.entryId ?? null) === operation.expected.entryId
      && (receipt.previous?.unitPriceMinor ?? null) === operation.expected.unitPriceMinor && receipt.current.unitPriceMinor === operation.unitPriceMinor,
    "catalog_publication_price_changed");
    const effective = (await db.query(`SELECT entry.id,entry.unit_price_minor FROM public.price_entries entry
      JOIN public.price_lists list ON list.id=entry.price_list_id
      WHERE entry.variant_id=$1 AND entry.price_list_id=$2 AND entry.mode='one_time' AND entry.min_qty=1 AND entry.active
        AND entry.amount_kind='gross' AND entry.valid_from<=statement_timestamp()
        AND (entry.valid_to IS NULL OR entry.valid_to>statement_timestamp())
        AND list.status='active' AND list.region_code=public.catalog_price_setup_region_code()
        AND list.currency=public.catalog_price_setup_settlement_currency() AND list.valid_from<=statement_timestamp()
        AND (list.valid_to IS NULL OR list.valid_to>statement_timestamp())
      ORDER BY entry.id LIMIT 2 FOR NO KEY UPDATE OF entry`, [operation.variantId, operation.priceListId])).rows;
    requireProjection(effective.length === 1 && effective[0]?.id === receipt.current.entryId
      && effective[0]?.unit_price_minor === operation.unitPriceMinor, "catalog_publication_price_changed");
  }
}

async function storeSku(db: PgQueryExecutor, sku: CatalogPublishedSku, definition: CatalogProductTypeDefinition,
  axes: string[], create: boolean) {
  const identity = canonicalizeCatalogCombinationV2({ definition, axes, options: sku.options });
  const values = [publicationJson(sku, undefined, SKU_PAGE_DEPTH), Buffer.from(identity.canonicalOptionBytes), Buffer.from(identity.combinationDigest)];
  const statements = `SELECT f.id,f."productId",f.code,f.title,f.status,f."minQuantity",f."isAddon",
    f."sellableStandalone",f."sellableInSubscription",f.attributes,f.options,$2::bytea,$3::bytea,
    (f."netContent"->>'unscaled')::integer,f."netContent"->>'dimension',f."netContent"->>'unit',
    (f."netContent"->>'scale')::integer,(f."netContent"->>'unscaled')::numeric,
    f."grossMass"->>'dimension',f."grossMass"->>'unit',(f."grossMass"->>'scale')::integer,(f."grossMass"->>'unscaled')::numeric,
    f."assetRefs"->>0,$1::jsonb
    FROM jsonb_to_record($1::jsonb) AS f(id uuid,"productId" uuid,code text,title text,status text,"minQuantity" integer,"isAddon" boolean,
      "sellableStandalone" boolean,"sellableInSubscription" boolean,attributes jsonb,options jsonb,
      "netContent" jsonb,"grossMass" jsonb,"assetRefs" jsonb)`;
  const columns = `id,product_id,sku,title,status,min_order_qty,is_addon,sellable_standalone,sellable_in_subscription,
    attribute_values,option_values,canonical_option_bytes,combination_digest,net_weight_g,net_content_dimension,net_content_unit,
    net_content_scale,net_content_unscaled,gross_mass_dimension,gross_mass_unit,gross_mass_scale,gross_mass_unscaled,asset_ref,publication_facts`;
  // The creation snapshot precedes later status, eligibility, and SKU effects.
  // Its final update installs the complete neutral projection in one row mutation.
  const { rows } = await db.query(create
    ? `INSERT INTO public.catalog_skus(${columns}) ${statements} RETURNING id`
    : `WITH next(${columns}) AS (${statements})
      UPDATE public.catalog_skus s SET (title,status,min_order_qty,is_addon,sellable_standalone,sellable_in_subscription,
        attribute_values,option_values,canonical_option_bytes,combination_digest,net_weight_g,net_content_dimension,net_content_unit,
        net_content_scale,net_content_unscaled,gross_mass_dimension,gross_mass_unit,gross_mass_scale,gross_mass_unscaled,asset_ref,publication_facts,updated_at)
      = (n.title,n.status,n.min_order_qty,n.is_addon,n.sellable_standalone,n.sellable_in_subscription,
        n.attribute_values,n.option_values,n.canonical_option_bytes,n.combination_digest,n.net_weight_g,n.net_content_dimension,n.net_content_unit,
        n.net_content_scale,n.net_content_unscaled,n.gross_mass_dimension,n.gross_mass_unit,n.gross_mass_scale,n.gross_mass_unscaled,n.asset_ref,n.publication_facts,clock_timestamp())
      FROM next n WHERE (s.id,s.product_id,s.sku)=(n.id,n.product_id,n.sku) RETURNING s.id`, values);
  requireProjection(rows.length === 1, "catalog_publication_sku_identity_changed");
}

async function checkPublicationGtins(db: PgQueryExecutor, sku: CatalogPublishedSku) {
  for (const value of sku.identifiers) {
    if (value.scheme !== "gs1:gtin") continue;
    requireProjection(isValidGtin(value.value), "catalog_publication_gtin_invalid", "validation_issue");
    const conflicting = (await db.query(`SELECT 1 FROM public.catalog_sku_identifiers
      WHERE identifier_kind='gtin' AND normalized_value ~ '^[0-9]{8,14}$'
        AND lpad(normalized_value,14,'0')=$1 AND (catalog_sku_id,issuer)<>($2::uuid,$3::text) LIMIT 1`,
      [value.value.padStart(14, "0"), sku.id, value.issuer])).rows[0];
    requireProjection(!conflicting, "catalog_publication_gtin_conflict");
  }
}

async function storeIdentifiers(db: PgQueryExecutor, sku: CatalogPublishedSku, compensate: boolean) {
  const identifiers = sku.identifiers.map(identifier => ({
    ...identifier, normalized: identifier.scheme === "gs1:gtin" ? identifier.value.padStart(14, "0") : identifier.value,
    kind: identifier.scheme === "gs1:gtin" ? "gtin" : "other", pack: identifier.packagingLevel === "unit" ? "unit" : "collective",
  }));
  const values = [sku.id, JSON.stringify(identifiers)];
  if (compensate) {
    await db.query(`DELETE FROM public.catalog_sku_identifiers i WHERE i.catalog_sku_id=$1
      AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS keep(issuer text,normalized text)
        WHERE (i.issuer,i.normalized_value)=(keep.issuer,keep.normalized))`, values);
    await db.query(`UPDATE public.catalog_sku_identifiers i SET is_primary=false WHERE i.catalog_sku_id=$1 AND i.is_primary
      AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS keep(issuer text,normalized text,"isPrimary" boolean)
        WHERE keep."isPrimary" AND (i.issuer,i.normalized_value)=(keep.issuer,keep.normalized))`, values);
  }
  const { rows } = await db.query(`INSERT INTO public.catalog_sku_identifiers AS i
    (catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,is_primary,scheme)
    SELECT $1,issuer,kind,normalized,pack,quantity,"isPrimary",CASE WHEN kind='gtin' THEN 'gs1:gtin' END
    FROM jsonb_to_recordset($2::jsonb) AS value(issuer text,kind text,normalized text,pack text,quantity integer,"isPrimary" boolean)
    ON CONFLICT(issuer,normalized_value) DO UPDATE SET identifier_kind=EXCLUDED.identifier_kind,pack_kind=EXCLUDED.pack_kind,
      quantity=EXCLUDED.quantity,is_primary=EXCLUDED.is_primary,scheme=EXCLUDED.scheme
    WHERE i.catalog_sku_id=EXCLUDED.catalog_sku_id RETURNING i.id`, values);
  requireProjection(rows.length === identifiers.length, "catalog_publication_identifier_conflict");
}

export async function stagePublication(db: PgQueryExecutor, previous: Awaited<ReturnType<typeof readPreviousPublication>>,
  definition: CatalogProductTypeDefinition, plan: Plan, command: CatalogPublishCommand, actor: string, fingerprint: string,
  compensation: boolean, references?: CatalogAttributeReferencePort) {
  const { product, skus } = plan;
  const prior = new Map(previous.evidence.skus.map(sku => [sku.id, sku]));
  const versions = new Map(previous.manifest?.skus.map(ref => [ref.skuId, ref.revision]));
  const transitions = skus.flatMap(sku => {
    const before = prior.get(sku.id);
    if (!before || before.status === sku.status || sku.status === "draft") return [];
    return [{ variantId: sku.id, expectedRevision: versions.get(sku.id), state: sku.status === "archived" ? "withdrawn" : sku.status }];
  });
  const expected = new Map(transitions.map(item => [item.variantId, item]));
  requireProjection(command.changes.every(item => expected.has(item.variantId) && same(item, expected.get(item.variantId))),
    "catalog_publication_lifecycle_assertion_changed");
  const changed = skus.filter(sku => !prior.has(sku.id) || !same(prior.get(sku.id), sku));
  const projected = compensation ? skus : changed;
  for (const sku of projected) await checkPublicationGtins(db, sku);
  const attributeRows = prepareCatalogAttributeProjection(await validateCatalogAttributes(definition, {
    productAttributes: product.attributes, skus: skus.map(({ id, attributes }) => ({ id, attributes })),
  }, references), String((previous.head?.revision ?? 0) + 1));
  if (!attributeRows.prepared) {
    const issue = attributeRows.issues[0];
    throw new CatalogPublicationError(issue ? publicationIssue(issue.code, undefined, issue.path) : "catalog_publication_attributes_invalid");
  }
  // The relation fence holds through issuance. Compare final effects with the
  // actual row even when compensation projects an unchanged sealed SKU.
  const { rows } = await db.query(`SELECT s.id,s.status,s.sellable_standalone,s.sellable_in_subscription,p.status AS product_status
    FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id WHERE s.product_id=$1`, [product.id]);
  const live = new Map(rows.map(row => [row.id, row]));
  const authoredPriceChecks = new Set(plan.pricedSkuCodes);
  const priced = skus.filter(sku => {
    if (authoredPriceChecks.has(sku.code)) return true;
    const before = live.get(sku.id);
    const active = before?.status === "active" && (product.status !== "active" || before.product_status === "active");
    return sku.status === "active" && (sku.sellableStandalone && !(active && before?.sellable_standalone)
      || sku.sellableInSubscription && !(active && before?.sellable_in_subscription));
  });
  const { claims, listId } = await claimPrices(db, plan.priceOperations, priced);
  const currentDocuments = new Map(plan.documents.map(doc => [doc.reference.id, doc]));
  const allDocuments = new Map([...previous.evidence.documents, ...plan.documents].map(doc => [doc.reference.revisionNo, doc.reference.id]));
  async function movePointer(id: string) {
    const { rows } = await db.query("SELECT current_document_revision_id FROM public.catalog_products WHERE id=$1", [product.id]);
    if (rows[0]?.current_document_revision_id === id) return;
    await db.query(`INSERT INTO public.catalog_publication_pointer_capabilities(transaction_id,product_id,revision_id,command_fingerprint)
      VALUES(pg_current_xact_id(),$1,$2,$3)`, [product.id, id, fingerprint]);
    const moved = (await db.query(`UPDATE public.catalog_products SET current_document_revision_id=$2
      WHERE id=$1 AND current_document_revision_id IS DISTINCT FROM $2 RETURNING id`, [product.id, id])).rows;
    const remaining = (await db.query(`SELECT 1 FROM public.catalog_publication_pointer_capabilities
      WHERE transaction_id=pg_current_xact_id() AND product_id=$1`, [product.id])).rows;
    requireProjection(moved.length === 1 && !remaining.length, "catalog_publication_pointer_capability_unconsumed");
  }
  for (const [index, operation] of plan.operations.entries()) {
    if (operation.op === "create_product") {
      await db.query("INSERT INTO public.catalog_products(id,slug,name,status) VALUES($1,$2,$3,'draft')",
        [operation.productId, operation.productSlug, operation.name]);
    } else if (operation.op === "register_document_revision") {
      const entry = currentDocuments.get(operation.revisionId);
      if (!entry) continue;
      const { reference, canonicalText, provenance } = entry;
      await db.query(`INSERT INTO public.catalog_product_document_revisions
        (id,product_id,revision_no,schema_id,document_ref,source_ref,document_payload,digest,provenance)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb) ON CONFLICT(id) DO NOTHING`,
      [reference.id, reference.productId, reference.revisionNo, reference.schemaId, reference.documentRef,
        reference.sourceRef, canonicalText, reference.digest, JSON.stringify(provenance)]);
    } else if (operation.op === "move_document_pointer") {
      const id = allDocuments.get(operation.documentRevisionNo);
      requireProjection(id, "catalog_publication_document_invalid");
      await movePointer(id);
    } else if (operation.op === "create_sku") {
      const sku = plan.creations.get(index);
      requireProjection(sku, "catalog_publication_sku_revision_invalid");
      await storeSku(db, sku, definition, product.axes, true);
    }
  }
  if (compensation && product.document) await movePointer(product.document.id);
  for (const sku of projected) {
    await storeSku(db, sku, definition, product.axes, false);
    await storeIdentifiers(db, sku, compensation);
  }
  await db.query(`UPDATE public.catalog_products SET slug=$2,name=$3,status=$4,type_key=$5,type_version=$6,variant_axes=$7,
    attribute_values=$8,primary_sku_id=$9,publication_facts=$10,updated_at=clock_timestamp() WHERE id=$1`,
  [product.id, product.slug, product.name, product.status, product.type.key, product.type.version, product.axes,
    JSON.stringify(product.attributes), product.primarySkuId, publicationJson(product)]);
  if (attributeRows.rows.length) await db.query(`INSERT INTO public.catalog_attribute_projection
    SELECT * FROM jsonb_populate_recordset(NULL::public.catalog_attribute_projection,$1::jsonb)`, [JSON.stringify(attributeRows.rows)]);
  try { await applyPrices(db, plan.priceOperations, claims, actor); }
  catch (error) {
    if (error instanceof CatalogPublicationError) throw error;
    const sql = error as { message?: string } | null;
    if (sql?.message === "catalog_price_setup_expected_state_mismatch") refusePublicationCommand("catalog_publication_price_changed", "conflict");
    if (sql?.message === "catalog_price_setup_readiness_would_fail") refusePublicationCommand("catalog_publication_price_readiness", "validation_issue");
    throw error;
  }
  await assertSkuPrices(db, priced, listId);
  if (plan.activating || priced.length) {
    const { rows } = await db.query("SELECT public.commerce_offer_policy_v2_readiness() AS result");
    const result = rows[0]?.result as { ready?: boolean } | undefined;
    requireProjection(result?.ready === true, "catalog_publication_price_readiness", "validation_issue");
  }
}
