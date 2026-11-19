import { createNativeCatalogRenewalCodecV2, createNativeRenewalCodec, createPostgresRenewalSettlementPort, createPostgresRenewalStore } from "@openlup/platform/subscriptions";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { createPostgresCatalogPublication, installCatalogDefinitions, catalogDefinitionDigest, assertCatalogAcceptedReferenceV2, catalogAcceptedReferenceV2Schema, catalogDraftCommandV4Schema, createCatalogProductTypeRegistry, type CatalogPublicationRules } from "@openlup/platform/catalog";
import { canonicalCatalogDraftJson, type CatalogDraftPayloadV4, type CatalogHeadRef, type CatalogPublishCommand, type CatalogAcceptedReferenceV2 } from "@openlup/platform/catalog/contracts";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
const productId = "10000000-0000-4000-8000-000000000001", skuId = "20000000-0000-4000-8000-000000000001";
const legacySkuId = "20000000-0000-4000-0000-000000000001";
const draftId = "30000000-0000-4000-8000-000000000001", documentId = "40000000-0000-4000-8000-000000000001";
const definition = { key: "example:article", version: 1, units: [{ code: "openlup:g", dimension: "mass" as const, integral: false }], netContentUnits: ["openlup:g"], dimensions: [{ key: "finish", kind: "choice" as const, values: ["matte", "gloss"] }],
  axes: [{ key: "finish", attributeKey: "finish" }],
  attributes: [{ key: "finish", scope: "variant" as const, valueType: { kind: "enum" as const, values: [{ id: "matte" }, { id: "gloss" }] },
    required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: false, displayOrder: 0, labels: { en: "Finish" } }],
  validatorRef: `sha256:${"a".repeat(64)}`, validateContent: () => [] };
const registry = createCatalogProductTypeRegistry([definition]);
let rejectDerivationFor: string | undefined;
const rules: CatalogPublicationRules = { canonicalizeDocument: canonicalCatalogDraftJson, deriveSkuFacts: (document, sku) => {
  if (sku.code === rejectDerivationFor) throw new Error("Unrelated retained derivation unavailable");
  return { derived: (document as { derived: number }).derived };
}, validateProduct: () => [], classifySkuChange: () => "compatible" };
function input(): { payload: CatalogDraftPayloadV4 } {
  const document = { schemaVersion: 1, derived: 12 }, canonicalText = canonicalCatalogDraftJson(document), digest = createHash("sha256").update(canonicalText).digest("hex");
  const facts = { skuCode: "ARTICLE", title: "Synthetic article", minQuantity: 1, isAddon: false, facts: { derived: 12 } };
  return { payload: { schemaVersion: 4, product: { id: productId, type: { key: definition.key, version: 1 }, dimensions: [], slug: "article", primarySkuId: skuId,
    documentRevision: { id: documentId, productId, revisionNo: 1, schemaId: "example:document.v1", documentRef: "example:document", sourceRef: "example:source", digest },
    sharedContent: { schemaVersion: 1, catalogAction: "create", document, presentation: {}, publicationSkus: [facts], requestedModes: [{ skuCode: "ARTICLE", modes: [] }], offerMemberships: [] } },
    skus: [{ id: skuId, productId, code: "ARTICLE", options: {}, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 }, identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: "5901234123457", packagingLevel: "unit" }] }],
    publication: { kind: "release", evidence: {}, operations: [
      { op: "create_product", productId, productSlug: "article", name: "Synthetic article" },
      { op: "register_document_revision", productSlug: "article", revisionId: documentId, revisionNo: 1, documentRef: "example:document", sourceRef: "example:source", canonicalText, digest, provenance: { source: "current_draft" } },
      { op: "move_document_pointer", productSlug: "article", documentRevisionNo: 1 },
      { op: "create_sku", productSlug: "article", documentRevisionNo: 1, skuId, ...facts },
      { op: "create_identifier", skuCode: "ARTICLE", scheme: "gs1:gtin", issuer: "example", value: "5901234123457", packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null },
      { op: "set_primary_sku", productSlug: "article", skuCode: "ARTICLE" }, { op: "set_product_presentation", productSlug: "article", presentation: {} },
    ] } } };
}
const containers: PostgresContainer[] = [], pools: Pool[] = [];
let pool: Pool, db: PoolClient;
let obligationRows: Record<string, unknown>[] | undefined;
let staleAuthoredSource: boolean;
let acceptsRetainedRead: boolean;
let watchedSkuStatus: string | undefined;
let statusClocks: boolean[];
let globalReadiness: () => Promise<{ ready: boolean; reasons: string[] }>;
let readiness: (requirePrice: boolean, skus: readonly { code: string; sellableStandalone: boolean; sellableInSubscription: boolean }[]) => Promise<{ ready: boolean; reasons: string[] }>;
let authority: ReturnType<typeof createPostgresCatalogPublication<null>>;
let actor: NonNullable<Awaited<ReturnType<typeof authority.authorize>>>;
const admin = randomUUID();
beforeAll(async () => {
  const container = await runPostgresContainer({ name: `catalog-lifecycle-${process.pid}`, password: "synthetic-lifecycle" }); containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Lifecycle witnesses require real PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString }); pools.push(pool);
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) await pool.query(readFileSync(unit.file, "utf8"));
  await installCatalogDefinitions(pool, { id: "example:lifecycle", namespace: "example", version: 1, openlupRange: "0.44.x", capabilities: { publish: false }, types: [definition], taxClasses: [] });
  await pool.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'lifecycle@example.invalid')", [admin]);
  await pool.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())", [admin]);
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(containers, pools), postgresTeardownTimeoutMs);
beforeEach(async () => {
  db = await pool.connect(); await db.query("BEGIN");
  obligationRows = undefined;
  staleAuthoredSource = false;
  acceptsRetainedRead = false;
  watchedSkuStatus = undefined;
  statusClocks = [];
  rejectDerivationFor = undefined;
  readiness = async () => ({ ready: true, reasons: [] });
  globalReadiness = async () => ({ ready: true, reasons: [] });
  authority = createPostgresCatalogPublication({ registry, rules, authorizeHuman: async () => ({ ok: true, userId: admin, role: "admin", isMachineActor: false }),
    readiness: async (_db, state, requirePrice) => readiness(requirePrice, state.skus), verifyMedia: async () => false, globalReadiness: () => globalReadiness(),
    acceptedSource: async (_db, _context, binding) => acceptsRetainedRead ? binding : "unauthorized",
    transactions: { async run(work) {
      await db.query("SAVEPOINT publication");
      try {
        const result = await work({ query: (sql, values) => {
          // Read witnesses share this fixture's already-open transaction.
          if (sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY") return Promise.resolve({ rows: [] });
          if (obligationRows && sql.startsWith("SELECT public.catalog_bound_obligations_v2")) return Promise.resolve({ rows: obligationRows });
          if (staleAuthoredSource && sql.startsWith("SELECT revision,status FROM public.catalog_draft_heads WHERE draft_id=")) {
            return db.query(sql, values).then(result => ({ rows: result.rows.map(row => ({ ...row, status: "abandoned" })) }));
          }
          if (watchedSkuStatus && values?.[0] === watchedSkuStatus && sql.startsWith("UPDATE public.catalog_skus SET status=")) {
            const clock = "SELECT updated_at::text AS at FROM public.catalog_skus WHERE id=$1";
            return (async () => {
              const before = (await db.query(clock,[watchedSkuStatus])).rows[0].at;
              const result = await db.query(sql,values);
              statusClocks.push((await db.query(clock,[watchedSkuStatus])).rows[0].at > before);
              return result;
            })();
          }
          return db.query(sql, values);
        } });
        await db.query("RELEASE SAVEPOINT publication");
        return result;
      } catch (error) {
        await db.query("ROLLBACK TO SAVEPOINT publication");
        throw error;
      }
    } } });
  actor = (await authority.authorize(null))!;
});
afterEach(async () => { await db.query("ROLLBACK"); db.release(); });
async function publish(payload: CatalogDraftPayloadV4, revision = 0, head: CatalogHeadRef | null = null) {
  const command = { schemaVersion: 4, action: revision ? "revise" : "create", draftId,
    commandKey: `draft:${revision}`, expectedRevision: revision, payload }, text = canonicalCatalogDraftJson(command);
  const saved = (await db.query("SELECT public.catalog_draft_apply($1,$2,'operator:synthetic') AS result", [text, createHash("sha256").update(text).digest("hex")])).rows[0].result;
  expect(saved.outcome, JSON.stringify(saved)).toBe("committed");
  const candidateRef = `v1:${command.draftId}@${revision + 1}/${head ? `${head.publicationId}@${head.revision}` : "unpublished"}`;
  const candidateDigest = createHash("sha256").update('["catalog-candidate",1,').update(canonicalCatalogDraftJson(payload)).update(",")
    .update(canonicalCatalogDraftJson([{ ...payload.product.type, definitionDigest: catalogDefinitionDigest(definition) }])).update(",").update(canonicalCatalogDraftJson(head)).update("]").digest("hex");
  const publication: CatalogPublishCommand = { productId: payload.product.id, commandKey: `publish:${revision}`, candidateRef, candidateDigest, expectedHead: head, changes: [] };
  expect(await authority.decision({ schemaVersion: 2, action: "approve", productId: payload.product.id, commandKey: `approve:${revision}`, candidateRef, candidateDigest, reason: "Exact synthetic candidate" }, actor)).toMatchObject({ outcome: "committed" });
  return { result: await authority.publish(publication, actor), command: publication };
}
async function seed({ other = false, policy, gross = false }: { other?: boolean; policy?: string; gross?: boolean } = {}) {
  const { payload } = input();
  if (policy !== undefined) payload.skus[0]!.demandPolicyRef = policy;
  if (gross) payload.skus[0]!.grossMass = { ...payload.skus[0]!.netContent!, unscaled: "110" };
  if (other) {
    const id = randomUUID(), code = "OTHER", source = { ...payload.product.sharedContent.publicationSkus[0]!, skuCode: code };
    payload.product.dimensions = ["finish"];
    payload.skus[0]!.options = { finish: { kind: "choice", value: "matte" } };
    const identifier = { scheme: "gs1:gtin", issuer: "example", value: "5901234123464", packagingLevel: "unit" as const };
    payload.skus.push({ ...payload.skus[0]!, id, code, identifiers: [identifier], options: { finish: { kind: "choice", value: "gloss" } } });
    payload.product.sharedContent.publicationSkus.push(source);
    payload.product.sharedContent.requestedModes.push({ skuCode: code, modes: [] });
    payload.publication.operations.push(
      { op: "create_sku", productSlug: payload.product.slug!, documentRevisionNo: 1, skuId: id, ...source },
      { op: "create_identifier", skuCode: code, ...identifier, quantity: 1, isPrimary: true, label: null, sourceRef: null },
    );
  }
  const first = await publish(payload); expect(first.result.outcome, JSON.stringify(first.result)).toBe("committed");
  if (!("receipt" in first.result)) throw new Error("Missing publication receipt");
  const client = randomUUID(), subscription = randomUUID();
  await db.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,clock_timestamp()+interval '28 days')", [subscription, client]);
  return { payload, first, client, subscription, sku: payload.skus[0]!.id, code: payload.skus[0]!.code!, product: payload.product.id };
}
async function obligations(sku: string) { return (await db.query("SELECT public.catalog_bound_obligations_v2($1) AS result", [sku])).rows[0].result; }
it("catalog_legacy_binding_is_not_inferred_from_current_document", async () => {
  const f = await seed();
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,3,0,617,'XXX')", [f.subscription, f.sku]);
  if (!("receipt" in f.first.result)) throw new Error("Missing first head");
  const payload = structuredClone(f.payload), document = { schemaVersion: 1, derived: 12, label: "Later editorial document" };
  const canonicalText = canonicalCatalogDraftJson(document), digest = createHash("sha256").update(canonicalText).digest("hex"), revisionId = randomUUID();
  payload.product.sharedContent = { ...payload.product.sharedContent, catalogAction: "revise", document };
  payload.product.documentRevision = { ...payload.product.documentRevision!, id: revisionId, revisionNo: 2, digest };
  payload.publication.operations = [{ op: "register_document_revision", productSlug: payload.product.slug!, revisionId, revisionNo: 2, documentRef: "example:document", sourceRef: "example:source", canonicalText, digest, provenance: { source: "current_draft" } }, { op: "move_document_pointer", productSlug: payload.product.slug!, documentRevisionNo: 2 }];
  expect((await publish(payload,1,f.first.result.receipt.head)).result).toMatchObject({ outcome: "committed" });
  expect((await db.query("SELECT catalog_sku_revision_id FROM public.subscription_lines")).rows).toEqual([{ catalog_sku_revision_id: null }]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: [{ family: "template", skuRevisionId: null }] });
});
it("catalog_archive_refuses_outstanding_obligations", async () => {
  const f = await seed(), order = randomUUID();
  await db.query("WITH o AS (INSERT INTO public.commerce_orders(id,status,currency_code,total_amount_minor) VALUES($1,'fulfilled','XXX',617) RETURNING id) INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) SELECT id,$2,1,1,617,617 FROM o", [order, f.sku]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: [{ family: "outstanding_order", sourceId: order }] });
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
});
it("same-SKU binding refuses a foreign revision and preserves historical NULL", async () => {
  const f = await seed(), foreign = randomUUID();
  const constraint = (await db.query(`SELECT c.confdeltype,c.convalidated,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n) AS source_keys,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.n) AS target_keys
    FROM pg_constraint c WHERE c.conname='subscription_lines_catalog_sku_revision_fkey'`)).rows;
  expect(constraint).toEqual([{ confdeltype: "r", convalidated: true,
    source_keys: ["variant_id", "catalog_sku_revision_id"], target_keys: ["sku_id", "id"] }]);
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,1,0,617,'XXX')", [f.subscription,f.sku]);
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$2,'OTHER','Synthetic other')", [foreign, f.product]);
  const revision = (await db.query("SELECT id FROM public.catalog_sku_revisions WHERE sku_id=$1", [f.sku])).rows[0].id;
  await db.query("SAVEPOINT mismatch");
  await expect(db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code,catalog_sku_revision_id) VALUES($1,$2,1,0,617,'XXX',$3)", [f.subscription, foreign, revision])).rejects.toMatchObject({ code: "23503" });
  await db.query("ROLLBACK TO SAVEPOINT mismatch");
  expect((await db.query("SELECT catalog_sku_revision_id FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ catalog_sku_revision_id: null }]);
});
it.each(["SKU", "product"] as const)("LC5-A-005 refuses old raw status writes against governed %s facts", async subject => {
  const f = await seed(); await db.query("SAVEPOINT raw_status");
  const statement = subject === "SKU" ? "UPDATE public.catalog_skus SET status='active' WHERE id=$1"
    : "UPDATE public.catalog_products SET status='active' WHERE id=$1";
  await expect(db.query(statement, [subject === "SKU" ? f.sku : f.product])).rejects.toMatchObject({ code: "42501", message: "catalog_lifecycle_raw_status_fenced" });
  await db.query("ROLLBACK TO SAVEPOINT raw_status");
  expect(await authority.publish(f.first.command, actor)).toMatchObject({ outcome: "replayed", receipt: "receipt" in f.first.result ? f.first.result.receipt : null });
});

it.each([
  "admin_archive_catalog_sku", "admin_activate_catalog_product", "admin_archive_catalog_product",
  "admin_restore_catalog_product", "admin_deactivate_catalog_product",
] as const)("legacy lifecycle entrypoint refuses before state access: %s", async name => {
  const before = (await db.query("SELECT count(*) FROM public.catalog_publications")).rows;
  await db.query("SAVEPOINT legacy_entrypoint");
  await expect(db.query(`SELECT public.${name}(NULL,NULL)`)).rejects.toMatchObject({ code: "42501", message: "legacy_catalog_mutation_fenced" });
  await db.query("ROLLBACK TO SAVEPOINT legacy_entrypoint");
  expect((await db.query("SELECT count(*) FROM public.catalog_publications")).rows).toEqual(before);
});

async function archive(f: Awaited<ReturnType<typeof seed>>, skuCode?: string) {
  const payload = structuredClone(f.payload);
  payload.product.sharedContent.catalogAction = "revise";
  payload.publication.operations = skuCode
    ? [{ op: "set_sku_lifecycle", skuCode, expectedState: "draft", state: "archived" }]
    : [{ op: "set_product_lifecycle", productSlug: payload.product.slug!, expectedState: "draft", state: "archived", children: [] }];
  if (!("receipt" in f.first.result)) throw new Error("Missing first head");
  return (await publish(payload, 1, f.first.result.receipt.head)).result;
}
async function order(f: Awaited<ReturnType<typeof seed>>, status = "paid") {
  const id = randomUUID();
  await db.query("WITH o AS (INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,$3,'XXX',617) RETURNING id) INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) SELECT id,$4,1,1,617,617 FROM o", [id, f.client, status, f.sku]);
  return id;
}
async function frozen(f: Awaited<ReturnType<typeof seed>>, sku = f.code) {
  const id = randomUUID();
  await db.query("INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,claim_token,claim_generation,claimed_by,claimed_at,lease_expires_at) VALUES($1,$2,clock_timestamp(),2,$3,$4,$5::jsonb,$6,1,'synthetic',clock_timestamp(),clock_timestamp()+interval '1 minute')", [id, f.subscription, `synthetic-renewal-operation:${id}`, "a".repeat(64), JSON.stringify({ lines: [{ sku, quantity: 3 }] }), randomUUID()]);
  return id;
}

it.each(["attachment", "provisional order", "paid order", "unbound cycle", "frozen basket identity", "wait basket identity",
  "replacement roster", "contradictory resumed wait", "later attachment", "later attachment with proven edit", "provisional receipt", "paid receipt",
  "replacement receipt", "provisional acceptance", "paid acceptance", "provisional repeated SKU", "paid repeated SKU"] as const)(
  "LC5-PRE obligation sources refuse uncertain %s evidence", async kind => {
  const f = await seed({ other: true }), other = f.payload.skus[1]!;
  const unrelated = { ...f, sku: other.id, code: other.code! };
  if (kind === "unbound cycle") {
    await db.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,clock_timestamp(),'payment_pending')", [f.subscription]);
  } else if (kind === "frozen basket identity" || kind === "wait basket identity") {
    const id = await frozen(f);
    const lines = [{ sku: other.code, variantId: f.sku, quantity: 3 }];
    await db.query("UPDATE public.subscription_renewal_operations SET cycle_snapshot=$2::jsonb WHERE id=$1", [id,JSON.stringify({ lines })]);
    if (kind === "wait basket identity") {
      await db.query("UPDATE public.subscription_renewal_operations SET state='refused',terminal_outcome='refused',terminal_reason='method_unauthorized',terminal_at=clock_timestamp() WHERE id=$1", [id]);
      await db.query(`INSERT INTO public.subscription_stock_wait_cases(id,subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,
        state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits)
        SELECT $1,subscription_id,$2,id,scheduled_at,cycle_number,'waiting','{}',cycle_snapshot,operation_fingerprint,identity_key,'[]'
        FROM public.subscription_renewal_operations WHERE id=$3`, [randomUUID(),f.client,id]);
    }
  } else if (kind === "replacement roster" || kind === "replacement receipt") {
    const id = await order(unrelated,"cancelled");
    await replacement(unrelated,id);
    if (kind === "replacement roster") {
      await db.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,2,1,0,0)", [id,f.sku]);
    } else {
      await saveOrderQuote(id, [f.code, unrelated.code].map(sku => ({ sku, quantity: 1 })));
    }
  } else if (kind === "contradictory resumed wait") {
    const id = await order(unrelated,"fulfilled"), operation = await frozen(f, unrelated.code);
    await db.query("UPDATE public.commerce_order_items SET quantity=3,line_amount_minor=1851 WHERE order_id=$1", [id]);
    await db.query("UPDATE public.commerce_orders SET total_amount_minor=1851 WHERE id=$1", [id]);
    const cycle = randomUUID(), shipment = randomUUID(), wait = randomUUID();
    await db.query(`INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status,renewal_operation_id,renewal_operation_fingerprint)
      SELECT $1,subscription_id,scheduled_at,'paid',id,operation_fingerprint FROM public.subscription_renewal_operations WHERE id=$2`, [cycle,operation]);
    await db.query(`UPDATE public.commerce_orders SET subscription_cycle_id=$2,renewal_operation_id=$3,renewal_operation_fingerprint=$4
      WHERE id=$1`, [id,cycle,operation,"a".repeat(64)]);
    await db.query(`INSERT INTO public.commerce_settlement_intents(order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key,settled_at)
      VALUES($1,'sandbox','settled',1851,'XXX',$2,clock_timestamp())`, [id,`settled:${id}`]);
    await db.query("INSERT INTO public.fulfillment_inventory_reservations(renewal_operation_id,operation_fingerprint,source_key,status) VALUES($1,$2,'example','consumed')", [operation,"a".repeat(64)]);
    await db.query("INSERT INTO public.fulfillment_ports(port_key,provider_type) VALUES('lifecycle:manual','manual')");
    await db.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,status,create_idempotency_key,delivered_at) VALUES($1,$2,'lifecycle:manual','manual','delivered',$3,clock_timestamp())", [shipment,id,`parcel:${shipment}`]);
    await db.query("INSERT INTO public.fulfillment_parcel_reservation_sets(shipment_id,order_id) VALUES($1,$2)", [shipment,id]);
    await db.query("INSERT INTO public.fulfillment_parcel_lines(shipment_id,order_item_id,sku_id,sku,quantity) SELECT $1,id,sku_id,$2,quantity FROM public.commerce_order_items WHERE order_id=$3", [shipment,other.code,id]);
    await db.query(`INSERT INTO public.subscription_stock_wait_cases(id,subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits,order_id,cycle_id,fulfillment_id)
      SELECT $1,subscription_id,$2,id,scheduled_at,cycle_number,'resumed','{}',cycle_snapshot,$3,identity_key,'[]',$4,$5,$6
      FROM public.subscription_renewal_operations WHERE id=$7`, [wait,f.client,"b".repeat(64),id,cycle,shipment,operation]);
  } else if (kind.endsWith("acceptance") || kind.endsWith("repeated SKU")) {
    const provisional = kind.startsWith("provisional");
    const standing = await standingActive(f);
    const id = await order(f, provisional ? "pending_payment" : "paid");
    await db.query("UPDATE public.commerce_orders SET catalog_acceptance=$2::jsonb WHERE id=$1", [id,JSON.stringify({ schemaVersion: 2, lines: [standing.accepted] })]);
    if (kind.endsWith("acceptance")) {
      // A pre-existing contradiction reaches O before any deferred write check.
      await db.query("UPDATE public.commerce_order_items SET sku_id=$2 WHERE order_id=$1", [id,other.id]);
    } else {
      await db.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,2,1,617,617)", [id,f.sku]);
      await db.query("UPDATE public.commerce_orders SET total_amount_minor=1234 WHERE id=$1", [id]);
      const lines = [{ sku: f.code, quantity: 1 }, { sku: f.code, quantity: 1 }];
      await saveOrderQuote(id, lines);
      await db.query("UPDATE public.commerce_orders SET metadata=$2::jsonb WHERE id=$1",[id,JSON.stringify({ orderDraftSnapshot: { lines } })]);
      expect(await obligations(f.sku)).toMatchObject({ outcome: "complete",
        obligations: [expect.objectContaining({ sourceId: id, family: provisional ? "pending_activation" : "outstanding_order" })] });
      return;
    }
  } else {
    const id = await order(unrelated, kind.startsWith("provisional") ? "pending_payment" : "fulfilled");
    const lines = [f, unrelated].map((line,index) => ({ lineOrdinal: index+1, sku: line.code, quantity: 1, unitAmountMinor: 617 }));
    if (kind === "attachment" || kind.startsWith("later attachment")) {
      const { leaf } = await replacement(unrelated,id);
      await db.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,2,1,617,617)", [id,f.sku]);
      await db.query("UPDATE public.commerce_orders SET total_amount_minor=1234 WHERE id=$1", [id]);
      await db.query("INSERT INTO public.fulfillment_parcel_lines(shipment_id,order_item_id,sku_id,sku,quantity) SELECT $1,id,sku_id,$2,quantity FROM public.commerce_order_items WHERE order_id=$3 AND sku_id=$4",
        [leaf,f.code,id,f.sku]);
      await db.query("UPDATE public.fulfillment_shipments SET status='delivered',delivered_at=clock_timestamp() WHERE id=$1", [leaf]);
      await db.query("INSERT INTO public.subscription_activations(order_id,client_id,subscription_id,cadence_days,state,payment_fingerprint,activation_idempotency_key,declare_idempotency_key,activated_at) VALUES($1,$2,$3,28,'active',$4,$5,$6,clock_timestamp())", [id,f.client,f.subscription,"a".repeat(64),`active:${id}`,`declare:${id}`]);
      await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3::jsonb,clock_timestamp())", [id,f.subscription,JSON.stringify({ lines })]);
      await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref) VALUES($1,'XXX','example','sandbox',clock_timestamp(),'example')", [f.subscription]);
      await db.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,2,$2,1,617)", [f.subscription,other.code]);
      await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,1,1,617,'XXX')", [f.subscription,other.id]);
      if (kind.startsWith("later attachment")) await db.query("UPDATE public.subscriptions SET template_version=template_version+1 WHERE id=$1", [f.subscription]);
      if (kind === "later attachment with proven edit") {
        const event = randomUUID(), hash = "c".repeat(64);
        await db.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload) VALUES($1,$2,'subscription.customer_self_service.update_bundle',$3,$4::jsonb)",
          [event,f.subscription,`edit:${event}`,JSON.stringify({ action: "update_bundle", templateVersion: 2, quoteHash: hash })]);
        await db.query(`INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,quote_hash,expected_template_version,
          proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,status,expires_at,accepted_event_id,accepted_at)
          VALUES($1,$2,$3,$4,1,$5::jsonb,28,1234,617,'XXX','accepted',clock_timestamp()+interval '1 hour',$6,
            (SELECT occurred_at FROM public.subscription_events WHERE id=$6))`, [f.subscription,`quote:${event}`,"b".repeat(64),hash,
          JSON.stringify([{ variantId: unrelated.sku, quantity: 1, sortOrder: 0, isAddon: false, unitPriceMinor: 617 }]),event]);
        expect(await obligations(f.sku)).toEqual({ schemaVersion: 2, outcome: "complete", obligations: [] });
        return;
      }
    } else if (kind.endsWith("receipt")) {
      await saveOrderQuote(id,lines);
    } else {
      await db.query("UPDATE public.commerce_orders SET metadata=$2::jsonb WHERE id=$1", [id,JSON.stringify({ quoteSnapshot: { quote: { lines } } })]);
    }
  }
  expect(await obligations(f.sku)).toEqual({ schemaVersion: 2, outcome: "unknown", reason: "catalog_obligation_evidence_unknown" });
  if (!kind.endsWith("acceptance")) expect(await archive(f)).toMatchObject({ reason: "catalog_obligation_evidence_unknown" });
});
it.each([
  ["cadence retained", 1, false, "none"],
  ["cadence retained one roster lost", 1, false, "template"],
  ["cadence retained both rosters lost", 1, false, "both"],
  ["cadence retained after another edit", 2, false, "both"],
  ["replacement at version two", 1, true, "none"],
  ["replacement after another edit", 2, true, "none"],
  ["replacement with stale renewal roster", 2, true, "renewal"],
] as const)("LC5-C3-O versioned owner handoff: %s", async (_name, edits, replaces, drift) => {
  const f = await seed({ other: true });
  const target = { id: f.payload.skus[1]!.id, code: f.payload.skus[1]!.code! };
  const primary = { id: f.sku, code: f.code };
  const original = [primary, target];
  const orderId = await order(f, "fulfilled"), { leaf } = await replacement(f, orderId);
  await db.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,2,1,617,617)", [orderId, target.id]);
  await db.query("UPDATE public.commerce_orders SET total_amount_minor=1234 WHERE id=$1", [orderId]);
  await db.query("INSERT INTO public.fulfillment_parcel_lines(shipment_id,order_item_id,sku_id,sku,quantity) SELECT $1,id,$2,$3,quantity FROM public.commerce_order_items WHERE order_id=$4 AND sku_id=$2", [leaf, target.id, target.code, orderId]);
  await db.query("UPDATE public.fulfillment_shipments SET status='delivered',delivered_at=statement_timestamp() WHERE id=$1", [leaf]);
  const clock = (await db.query("SELECT statement_timestamp() AS now,statement_timestamp()+interval '1 hour' AS expiry")).rows[0];
  const lines = original.map((sku,index) => ({ lineOrdinal: index+1, sku: sku.code, quantity: 1, unitAmountMinor: 617 }));
  const purchase = { currency: "XXX", stockSourceKey: "synthetic", settlementChannelKey: "sandbox",
    unattendedChargeAuthorizedAt: clock.now, authorizationRef: "synthetic", payerAccountRef: null, methodRef: "synthetic",
    methodEvidenceRef: "synthetic", templateId: "synthetic", cadenceDays: 28, shippingAmountMinor: 0, acquisitionRef: null, lines };
  const priceList = randomUUID();
  await db.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Synthetic handoff','AA','XXX')", [priceList]);
  await db.query("UPDATE public.subscriptions SET currency_code='XXX',price_list_id=$2 WHERE id=$1", [f.subscription,priceList]);
  await db.query("INSERT INTO public.subscription_activations(order_id,client_id,subscription_id,cadence_days,state,payment_fingerprint,activation_idempotency_key,declare_idempotency_key,activated_at) VALUES($1,$2,$3,28,'active',$4,$5,$6,statement_timestamp())", [orderId,f.client,f.subscription,"a".repeat(64),`active:${orderId}`,`declare:${orderId}`]);
  await db.query("SELECT public.subscription_register_renewal_purchase($1,$2::jsonb)", [orderId,JSON.stringify(purchase)]);
  await db.query("SELECT public.subscription_complete_renewal_attachment($1)", [orderId]);
  for (const [index,sku] of original.entries()) {
    await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,1,$3,617,'XXX')", [f.subscription,sku.id,index]);
  }
  expect(await obligations(target.id)).toMatchObject({ outcome: "complete", obligations: expect.arrayContaining([
    expect.objectContaining({ family: "template", sourceId: f.subscription })]) });
  await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_minimum_base_units','1') ON CONFLICT(key) DO UPDATE SET value_text='1'");
  const previewActor = randomUUID(), applyActor = randomUUID(), action = "update_package_template";
  let lastEvent: string | undefined;
  for (let basis = 1; basis <= edits; basis++) {
    const roster = replaces ? [primary] : original;
    const base = roster.map(sku => ({ variantId: sku.id, qty: 1 })), addons: never[] = [];
    const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
    const baseLines = roster.map(sku => ({ variantId: sku.id, qty: 1,
      quoteLine: { sku: sku.code, quantity: 1, unitPriceGross: money(617), lineSubtotalGross: money(617) } }));
    const quoteHash = createHash("sha256").update(`${orderId}:${basis}`).digest("hex");
    const planDays = 28 + basis, compositionConstraint = { kind: "plan_days", value: planDays };
    const request = { planDays, base, addons };
    const snapshot = { baseLines, addonLines: [], compositionConstraint };
    const currentTotal = basis === 1 ? 1234 : roster.length * 617, newTotal = roster.length * 617;
    const totals = { currentRecurringPrice: money(currentTotal), newRecurringPrice: money(newTotal), delta: money(newTotal-currentTotal) };
    await db.query("SELECT public.subscription_quote_preview_record($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11)", [
      previewActor,f.client,f.subscription,action,quoteHash,basis,clock.expiry,JSON.stringify(request),JSON.stringify(snapshot),JSON.stringify(totals),clock.now]);
    const accepted = { ...request, expectedTemplateVersion: basis, acceptedQuoteHash: quoteHash };
    const result = (await db.query("SELECT public.subscription_package_edit_apply($1,$2,$3,$4,$5::jsonb,$6) AS result", [
      applyActor,f.client,`handoff:${orderId}:${basis}`,f.subscription,JSON.stringify({ ...accepted, request: accepted, ...snapshot, ...totals }),clock.now])).rows[0].result;
    expect(result).toMatchObject({ status: "applied", templateVersion: basis+1 });
    lastEvent = result.eventId;
    expect((await db.query("SELECT public.subscription_catalog_basis_transition($1,$2) AS result", [f.subscription,basis])).rows[0].result)
      .toMatchObject({ outcome: "proved", eventId: lastEvent, kind: "edit", from: basis, to: basis+1,
        basket: Object.fromEntries(roster.map(sku => [sku.code,1])) });
  }
  if (drift === "template" || drift === "both") {
    await db.query("DELETE FROM public.subscription_lines WHERE subscription_id=$1 AND variant_id=$2", [f.subscription,target.id]);
  }
  if (drift === "both") await db.query("DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=$1 AND sku=$2", [f.subscription,target.code]);
  if (drift === "renewal") await db.query("UPDATE public.subscription_renewal_term_lines SET sku=$2 WHERE subscription_id=$1", [f.subscription,target.code]);
  async function attemptArchive(path: "parent" | "sku") {
    await db.query("SAVEPOINT archive_handoff");
    try { return await archive(f, path === "sku" ? target.code : undefined); }
    finally { await db.query("ROLLBACK TO SAVEPOINT archive_handoff"); await db.query("RELEASE SAVEPOINT archive_handoff"); }
  }
  if (drift !== "none") {
    expect(await obligations(target.id)).toEqual({ schemaVersion: 2, outcome: "unknown", reason: "catalog_obligation_evidence_unknown" });
    expect(await attemptArchive("parent")).toMatchObject({ reason: "catalog_obligation_evidence_unknown" });
    expect(await attemptArchive("sku")).toMatchObject({ reason: "catalog_obligation_evidence_unknown" });
  } else if (replaces) {
    expect(await obligations(target.id)).toEqual({ schemaVersion: 2, outcome: "complete", obligations: [] });
    expect(await attemptArchive("parent")).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
    expect(await attemptArchive("sku")).toMatchObject({ reason: "catalog_archive_barrier_unavailable" });
  } else expect(await obligations(target.id)).toMatchObject({ outcome: "complete", obligations: expect.arrayContaining([
    expect.objectContaining({ family: "template", sourceId: f.subscription })]) });
});
async function saveOrderQuote(id: string, lines: readonly { sku: string; quantity: number }[]) {
  const payload = { orderDraft: { orderId: `order_${id}`, quoteSnapshot: { quote: { lines } } } };
  await db.query("INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload) VALUES($1,$2,$3,$4::jsonb)",
    [`synthetic:${id}`,"a".repeat(32),id,JSON.stringify(payload)]);
}
it.each(["active", "paused"])("template obligation blocks archive: %s including legacy NULL", async status => {
  const f = await seed();
  await db.query("UPDATE public.subscriptions SET status=$2 WHERE id=$1", [f.subscription, status]);
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,1,0,617,'XXX')", [f.subscription, f.sku]);
  expect(await archive(f)).toMatchObject({ outcome: "validation_issue", reason: "catalog_archive_refuses_outstanding_obligations" });
});
it("retained renewal lines block archive independently of the current template", async () => {
  const f = await seed();
  await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref) VALUES($1,'XXX','synthetic','sandbox',clock_timestamp(),'synthetic')", [f.subscription]);
  await db.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,$2,3,617)", [f.subscription, f.code]);
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
});
it("pending activation and missing attachment template block archive", async () => {
  const f = await seed(), id = await order(f, "pending_payment");
  await db.query("INSERT INTO public.subscription_activations(order_id,client_id,cadence_days,declare_idempotency_key) VALUES($1,$2,28,$3)", [id, f.client, `activate:${id}`]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: [{ family: "pending_activation", sourceId: id }] });
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
});
it("frozen renewal survives template replacement", async () => {
  const f = await seed(), id = await frozen(f);
  await db.query("UPDATE public.subscriptions SET template_version=template_version+1 WHERE id=$1", [f.subscription]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: [{ family: "frozen_renewal", sourceId: id }] });
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
});
it.each(["waiting", "stock_secured"])("stock wait obligation blocks archive: %s", async state => {
  const f = await seed(), operation = await frozen(f);
  const id = randomUUID();
  await db.query("INSERT INTO public.subscription_stock_wait_cases(id,subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits) SELECT $1,$2,$3,$4,scheduled_at,cycle_number,$5,'{}',$6::jsonb,operation_fingerprint,identity_key,'[]' FROM public.subscription_renewal_operations WHERE id=$4", [id, f.subscription, f.client, operation, state, JSON.stringify({ lines: [{ sku: f.code, quantity: 3 }] })]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: expect.arrayContaining([{ family: "stock_wait", sourceId: id, subscriptionId: f.subscription, skuId: f.sku, skuCode: f.code, skuRevisionId: null }]) });
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
});
it("unknown evidence and the unavailable barrier both refuse archive", async () => {
  const f = await seed();
  expect(await archive(f)).toMatchObject({ outcome: "dependency_unavailable", reason: "catalog_archive_barrier_unavailable" });
  const op = await frozen(f);
  await db.query("UPDATE public.subscription_renewal_operations SET cycle_snapshot='{}' WHERE id=$1", [op]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "unknown", reason: "catalog_obligation_evidence_unknown" });
  // Use a fresh command key because the failed archive has no publication receipt.
  expect((await publish({ ...f.payload, product: { ...f.payload.product, sharedContent: { ...f.payload.product.sharedContent, catalogAction: "revise" } }, publication: { kind: "release", evidence: {}, operations: [{ op: "set_product_lifecycle", productSlug: f.payload.product.slug!, expectedState: "draft", state: "archived", children: [] }] } }, 2, "receipt" in f.first.result ? f.first.result.receipt.head : null)).result).toMatchObject({ reason: "catalog_obligation_evidence_unknown" });
});
it("verifies the complete immutable acceptance tuple and refuses forged fields", async () => {
  const f = await seed();
  if (!("receipt" in f.first.result)) throw new Error("Missing first head");
  const publication = (await db.query("SELECT canonical_state FROM public.catalog_publications WHERE id=$1", [f.first.result.receipt.head.publicationId])).rows[0];
  const manifest = JSON.parse(publication.canonical_state);
  const referenceRow = manifest.skus[0];
  const skuRow = (await db.query("SELECT full_facts FROM public.catalog_sku_revisions WHERE id=$1", [referenceRow.revisionId])).rows[0];
  const page = { head: f.first.result.receipt.head, product: manifest.product }, sku = { reference: referenceRow, facts: JSON.parse(skuRow.full_facts) };
  const reference: CatalogAcceptedReferenceV2 = { schemaVersion: 2, skuId: f.sku, skuCode: f.code, skuRevisionId: sku.reference.revisionId,
    publicationHead: page.head, typeRef: page.product.type, definitionDigest: page.product.definitionDigest, optionDigest: sku.facts.optionDigest, netContent: sku.facts.netContent };
  expect(await assertCatalogAcceptedReferenceV2(db, reference)).toEqual(reference);
  for (const changed of [{ skuCode: "FORGED" }, { definitionDigest: "f".repeat(64) }, { optionDigest: "f".repeat(64) }, { publicationHead: { ...page.head, documentDigest: "f".repeat(64) } }, { netContent: { ...reference.netContent, unscaled: "999" } }]) {
    await db.query("SAVEPOINT tuple");
    await expect(assertCatalogAcceptedReferenceV2(db, { ...reference, ...changed })).rejects.toMatchObject({ code: "22023" });
    await db.query("ROLLBACK TO SAVEPOINT tuple");
  }
});

it.each([
  ["D-accepted-typeRef", { typeRef: { key: "example:uninstalled", version: 1 } }],
  ["D-accepted-definitionDigest", { definitionDigest: "f".repeat(64) }],
  ["D-accepted-demandPolicyRef", { demandPolicyRef: "example:forged-policy@1" }],
] as const)("%s: only the supplied tuple field differs from retained facts", async (_rule, change) => {
  const standing = await standingActive(await seed());
  expect(await assertCatalogAcceptedReferenceV2(db, standing.accepted)).toEqual(standing.accepted);
  await db.query("SAVEPOINT supplied_tuple");
  await expect(assertCatalogAcceptedReferenceV2(db, { ...standing.accepted, ...change })).rejects.toMatchObject({ code: "22023", message: "catalog_accepted_reference_mismatch" });
  await db.query("ROLLBACK TO SAVEPOINT supplied_tuple");
});
it("D-acceptance-immutable: a captured order acceptance cannot be cleared", async () => {
  const standing = await standingActive(await seed()), order = randomUUID();
  const acceptance = { schemaVersion: 2, lines: [standing.accepted] };
  await db.query("INSERT INTO public.commerce_orders(id,currency_code,total_amount_minor,metadata,catalog_acceptance) VALUES($1,'XXX',0,$2::jsonb,$3::jsonb)",
    [order,JSON.stringify({ orderDraftSnapshot: { lines: [{ sku: standing.accepted.skuCode, quantity: 1 }] } }),JSON.stringify(acceptance)]);
  await db.query("SAVEPOINT immutable_acceptance");
  // No frozen snapshot exists, and NULL needs no tuple verification: only immutability refuses.
  await expect(db.query("UPDATE public.commerce_orders SET catalog_acceptance=NULL WHERE id=$1", [order])).rejects.toMatchObject({ code: "55000", message: "catalog_acceptance_immutable" });
  await db.query("ROLLBACK TO SAVEPOINT immutable_acceptance");
  expect((await db.query("SELECT catalog_acceptance FROM public.commerce_orders WHERE id=$1", [order])).rows).toEqual([{ catalog_acceptance: acceptance }]);
});
it("D-retained-v1-bytes: the new carrier is v2 and the legacy renderer keeps its bytes", async () => {
  const f = await seed(), standing = await standingActive(f), order = randomUUID();
  const acceptance = { schemaVersion: 2, lines: [standing.accepted] };
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code,catalog_sku_revision_id) VALUES($1,$2,3,0,617,'XXX',$3)", [f.subscription,f.sku,standing.accepted.skuRevisionId]);
  await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',0)", [order,f.client]);
  await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3::jsonb,clock_timestamp())", [order,f.subscription,JSON.stringify({ templateId: "synthetic", shippingAmountMinor: 0, acquisitionRef: null, renewalTerms: { version: "native.renewal-terms.v1" } })]);
  const legacy = (await db.query("SELECT public.subscription_renewal_purchase_terms($1)::text AS bytes", [f.subscription])).rows;
  await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref,catalog_acceptance) VALUES($1,'XXX','synthetic','sandbox',clock_timestamp(),'synthetic',$2::jsonb)", [f.subscription,JSON.stringify(acceptance)]);
  const current = (await db.query("SELECT public.subscription_renewal_purchase_terms_v2($1) AS facts", [f.subscription])).rows[0].facts;
  const expected = JSON.parse(legacy[0].bytes);
  expect(expected.renewalTerms.version).toBe("native.renewal-terms.v1");
  expect(current).toEqual({ ...expected, renewalTerms: { ...expected.renewalTerms, version: "native.renewal-terms.v2", catalogAcceptance: acceptance } });
  expect((await db.query("SELECT public.subscription_renewal_purchase_terms($1)::text AS bytes", [f.subscription])).rows).toEqual(legacy);
});

async function replacement(f: Awaited<ReturnType<typeof seed>>, id: string) {
  const predecessor = randomUUID(), leaf = randomUUID();
  await db.query("INSERT INTO public.fulfillment_ports(port_key,provider_type) VALUES('lifecycle:manual','manual')");
  await db.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,status,create_idempotency_key) VALUES($1,$2,'lifecycle:manual','manual','exception',$3)", [predecessor,id,`parcel:${predecessor}`]);
  await db.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,status,create_idempotency_key,replaces_shipment_id,sequence_no,replacement_reason) VALUES($1,$2,'lifecycle:manual','manual','in_transit',$3,$4,1,'lost')", [leaf,id,`parcel:${leaf}`,predecessor]);
  await db.query("INSERT INTO public.fulfillment_parcel_reservation_sets(shipment_id,order_id) VALUES($1,$2)", [leaf,id]);
  await db.query("INSERT INTO public.fulfillment_parcel_lines(shipment_id,order_item_id,sku_id,sku,quantity) SELECT $1,id,$2,$3,1 FROM public.commerce_order_items WHERE order_id=$4", [leaf,f.sku,f.code,id]);
  return { predecessor, leaf };
}
it("catalog_archive_refuses_undelivered_replacement", async () => {
  const f = await seed(), id = await order(f, "cancelled");
  await db.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [f.subscription]);
  const { predecessor, leaf } = await replacement(f,id);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: [{ family: "replacement", sourceId: leaf }] });
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
  await db.query("UPDATE public.fulfillment_shipments SET delivered_at=clock_timestamp(),status='delivered' WHERE id=$1", [leaf]);
  expect(await obligations(f.sku)).toEqual({ schemaVersion: 2, outcome: "complete", obligations: [] });
  expect((await db.query("SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1", [predecessor])).rows[0].delivered_at).toBeNull();
});
it("undelivered replacement without usable parcel identity refuses absence", async () => {
  const f = await seed(), id = await order(f, "cancelled");
  const { leaf } = await replacement(f,id);
  await db.query("UPDATE public.fulfillment_parcel_lines SET sku_id=NULL,sku=NULL WHERE shipment_id=$1", [leaf]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "unknown", reason: "catalog_obligation_evidence_unknown" });
  expect(await archive(f)).toMatchObject({ reason: "catalog_obligation_evidence_unknown" });
});
function graduationFacts(basis: number, sku: string) {
  return { renewalTerms: { version: "native.renewal-terms.v1", minimumPayableMinor: 1, normalCadenceDays: [28],
    starterPack: { schemaVersion: "1", basisTemplateVersion: basis, starterIntervalDays: 14,
      delivery2: { discountBps: 0, discountMinor: 0, basisSubtotalMinor: 617 },
      graduation: { cadenceDays: 28, lines: [{ sku, qty: 3, sortOrder: 0, isAddon: false,
        quoteLine: { unitPriceGross: { amountMinor: 617 }, lineSubtotalGross: { amountMinor: 1851 } } }] } } } };
}
it.each(["accepted edit", "accepted classic receipt", "accepted sized edit", "accepted package edit", "historical graduation",
  "wrong graduation quantity", "wrong graduation ordinal", "missing graduation ordinal", "unproven graduation addon", "carried graduation addon", "unpriced graduation addon",
  "prior core graduation addon", "lost historic graduation addon", "empty edit basket",
  "malformed marker", "partial delivery receipt", "foreign graduation key", "contradictory edit"] as const)(
  "LC5-A-022 LC5-A-023 graduation obligation verifies %s", async path => {
  const f = await seed({ other: path.includes("graduation addon") || path === "accepted package edit" }), id = randomUUID();
  await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',0)", [id,f.client]);
  const basis = (await db.query("SELECT template_version FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].template_version;
  const facts = graduationFacts(basis, f.code);
  if (path === "malformed marker") Object.assign(facts.renewalTerms.starterPack, { delivery2: undefined });
  if (path === "partial delivery receipt") Object.assign(facts.renewalTerms.starterPack.delivery2, { discountMinor: undefined });
  await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3::jsonb,clock_timestamp())", [id,f.subscription,JSON.stringify(facts)]);
  if (path === "malformed marker" || path === "partial delivery receipt") {
    expect(await obligations(f.sku)).toMatchObject({ outcome: "unknown", reason: "catalog_obligation_evidence_unknown" });
    expect(await archive(f)).toMatchObject({ reason: "catalog_obligation_evidence_unknown" });
    return;
  }
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: [{ family: "graduation", sourceId: id }] });
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
  await db.query("UPDATE public.subscriptions SET template_version=template_version+1 WHERE id=$1", [f.subscription]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "unknown" });
  const event = randomUUID();
  if (path.includes("graduation")) {
    const key = `${path === "foreign graduation key" ? "external:" : ""}starter-graduation:${f.subscription}:${basis}`;
    const quantity = path === "wrong graduation quantity" ? 1 : 3;
    const core = { lineOrdinal: path === "missing graduation ordinal" ? undefined : path === "wrong graduation ordinal" ? 2 : 1,
      sku: f.code, quantity, unitAmountMinor: 617 };
    const addon = { lineOrdinal: 2, sku: "OTHER", quantity: 1, unitAmountMinor: 100 };
    const lines = path.includes("graduation addon") ? [core, addon] : [core];
    const provedCarry = path === "carried graduation addon" || path === "unpriced graduation addon";
    const reportsCarry = provedCarry || path === "prior core graduation addon" || path === "lost historic graduation addon";
    const pricing = lines.filter(line => path !== "unpriced graduation addon" || line.sku !== addon.sku)
      .map(({ lineOrdinal: _ordinal, ...line }) => ({ ...line, isAddon: line.sku === "OTHER",
        quoteLine: line.sku === f.code ? facts.renewalTerms.starterPack.graduation.lines[0]!.quoteLine : {} }));
    if (reportsCarry) await db.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
      VALUES($1,$2,1,1,$3,100,'XXX')`, [f.subscription,f.payload.skus[1]!.id,path !== "prior core graduation addon"]);
    await db.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload) VALUES($1,$2,'subscription.starter_graduated',$3,$4::jsonb)", [event,f.subscription,key,
      JSON.stringify({ mode: "full", basisTemplateVersion: basis, templateVersion: basis+1, cadenceDays: 28,
        before: [{ ...core, lineOrdinal: 1 }, ...(reportsCarry ? [addon] : [])], lines, linePricing: pricing })]);
    if (path === "lost historic graduation addon") {
      await db.query("DELETE FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription]);
      await db.query("UPDATE public.subscriptions SET template_version=template_version+1 WHERE id=$1", [f.subscription]);
    }
    if (path !== "historical graduation" && !provedCarry) expect(await obligations(f.sku)).toMatchObject({ outcome: "unknown" });
    else expect(await obligations(f.sku)).toEqual({ schemaVersion: 2, outcome: "complete", obligations: [] });
    return;
  }
  if (path === "accepted sized edit" || path === "accepted package edit" || path === "accepted classic receipt") {
    const preview = randomUUID(), actorId = randomUUID(), previewActorId = randomUUID(), key = `sized:${event}`;
    const eventKey = `command:${createHash("sha256").update(`${actorId}:${key}`).digest("hex")}`;
    const action = path === "accepted package edit" ? "update_package_template" : "update_bundle", quoteHash = "c".repeat(64);
    const classic = path === "accepted classic receipt";
    const quoteLine = { sku: f.code, quantity: 3, unitPriceGross: { amountMinor: 617 } };
    const lines = [{ variantId: f.sku, qty: 3, sortOrder: 0, isAddon: false, quoteLine }];
    const pricing = [{ sku: f.code, quantity: 3, unitAmountMinor: 617, isAddon: false, quoteLine }];
    const command = { clientId: f.client, subscriptionId: f.subscription, action, payload: { acceptedQuoteHash: quoteHash, expectedTemplateVersion: basis } };
    const addonQuoteLine = { sku: "OTHER", quantity: 1, unitPriceGross: { amountMinor: 100 } };
    const quoted = action === "update_package_template" ? { baseLines: lines, addonLines: [{ variantId: f.payload.skus[1]!.id, qty: 1, quoteLine: addonQuoteLine }] } : { lines };
    if (action === "update_package_template") pricing.push({ sku: "OTHER", quantity: 1, unitAmountMinor: 100, isAddon: true, quoteLine: addonQuoteLine });
    const eventFacts = classic ? { action, payload: command.payload } : { action, quotePreviewId: preview, linePricing: pricing, payload: {} };
    const receipt = { status: "applied", subscriptionId: f.subscription, action, templateVersion: basis+1, eventId: event };
    await db.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload) VALUES($1,$2,$3,$4,$5::jsonb)", [event,f.subscription,`subscription.customer_self_service.${action}`,eventKey,JSON.stringify(eventFacts)]);
    if (classic) {
      await db.query(`INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,quote_hash,expected_template_version,
        proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,status,expires_at,accepted_event_id,accepted_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,28,0,1851,'XXX','accepted',clock_timestamp()+interval '1 hour',$7,
          (SELECT occurred_at FROM public.subscription_events WHERE id=$7))`,
      [f.subscription,`quote:${event}`,"b".repeat(64),quoteHash,basis,JSON.stringify([{ variantId: f.sku, quantity: 3, sortOrder: 0, isAddon: false, unitPriceMinor: 617 }]),event]);
    } else await db.query(`INSERT INTO public.subscription_quote_previews(id,subscription_id,client_id,actor_id,action,quote_hash,template_version,expires_at,status,request_payload,quote_snapshot,totals,accepted_at,accepted_idempotency_key,accepted_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 hour','accepted','{}',$8::jsonb,'{}',(SELECT occurred_at FROM public.subscription_events WHERE id=$9),$10,$9)`, [preview,f.subscription,f.client,previewActorId,action,quoteHash,basis,JSON.stringify(quoted),event,key]);
    await db.query("INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,'applied')",
      [actorId,key,f.subscription,f.client,"a".repeat(64),JSON.stringify(command),quoteHash,JSON.stringify(receipt)]);
    await db.query("UPDATE public.subscriptions SET template_version=template_version+1 WHERE id=$1", [f.subscription]);
    expect(await obligations(f.sku)).toEqual({ schemaVersion: 2, outcome: "complete", obligations: [] });
    return;
  }
  await db.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload) VALUES($1,$2,'subscription.customer_self_service.update_bundle',$3,$4::jsonb)", [event,f.subscription,`edit:${event}`,
    JSON.stringify({ templateVersion: basis + 1, quoteHash: (path === "contradictory edit" ? "d" : "c").repeat(64), action: "update_bundle" })]);
  const proposed = path === "empty edit basket" ? [] : [{ variantId: f.sku, quantity: 3, sortOrder: 0, isAddon: false, unitPriceMinor: 617 }];
  await db.query("INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,quote_hash,expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,status,expires_at,accepted_event_id,accepted_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,28,0,1851,'XXX','accepted',clock_timestamp()+interval '1 hour',$7,(SELECT occurred_at FROM public.subscription_events WHERE id=$7))", [f.subscription,`quote:${event}`,"b".repeat(64),"c".repeat(64),basis,JSON.stringify(proposed),event]);
  await db.query("UPDATE public.subscriptions SET template_version=template_version+1 WHERE id=$1", [f.subscription]);
  if (path !== "accepted edit") expect(await obligations(f.sku)).toMatchObject({ outcome: "unknown" });
  else expect(await obligations(f.sku)).toEqual({ schemaVersion: 2, outcome: "complete", obligations: [] });
});
it.each(["priced", "unpriced"] as const)("LC5-C3-O retains the owner's %s carry after a subsequent edit", async pricing => {
  const f = await seed({ other: true }), addon = f.payload.skus[1]!;
  const list = randomUUID(), activation = randomUUID(), delivery = randomUUID();
  const orderId = await order(f,"fulfilled"), parcel = await replacement(f,orderId);
  const original = [f.code, addon.code!].map((sku,index) => ({ lineOrdinal: index+1, sku, quantity: 1, unitAmountMinor: 617 }));
  await db.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,2,1,617,617)", [orderId,addon.id]);
  await db.query("UPDATE public.commerce_orders SET total_amount_minor=1234 WHERE id=$1", [orderId]);
  await db.query("INSERT INTO public.fulfillment_parcel_lines(shipment_id,order_item_id,sku_id,sku,quantity) SELECT $1,id,$2,$3,quantity FROM public.commerce_order_items WHERE order_id=$4 AND sku_id=$2",
    [parcel.leaf,addon.id,addon.code,orderId]);
  await db.query("UPDATE public.fulfillment_shipments SET status='delivered',delivered_at=statement_timestamp() WHERE id=$1", [parcel.leaf]);
  await db.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Synthetic graduation','AA','XXX')", [list]);
  await db.query(`UPDATE public.subscriptions SET price_list_id=$2,currency_code='XXX',cadence_days=14,
    started_at=statement_timestamp()-interval '28 days',next_cycle_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=$1`, [f.subscription,list]);
  await db.query(`INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status)
    SELECT $1::uuid,id,started_at,'paid' FROM public.subscriptions WHERE id=$3
    UNION ALL SELECT $2::uuid,id,started_at+interval '14 days','paid' FROM public.subscriptions WHERE id=$3`, [activation,delivery,f.subscription]);
  await db.query("UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1", [orderId,activation]);
  await db.query(`INSERT INTO public.subscription_activations(order_id,client_id,subscription_id,cadence_days,state,payment_fingerprint,activation_idempotency_key,declare_idempotency_key,activated_at)
    VALUES($1,$2,$3,14,'active',$4,$5,$6,statement_timestamp())`, [orderId,f.client,f.subscription,"a".repeat(64),`active:${orderId}`,`declare:${orderId}`]);
  const facts = graduationFacts(1, f.code);
  const renewalTerms = { ...facts.renewalTerms, ...(pricing === "priced" ? { linePricing: [{
    sku: addon.code, quantity: 1, unitAmountMinor: 617, isAddon: true, quoteLine: {},
  }] } : {}) };
  const purchase = { templateId: "synthetic", shippingAmountMinor: 0, acquisitionRef: null, renewalTerms, lines: original };
  await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3::jsonb,statement_timestamp())",
    [orderId,f.subscription,JSON.stringify(purchase)]);
  await db.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
    VALUES($1,$2,1,0,false,617,'XXX'),($1,$3,1,1,true,617,'XXX')`, [f.subscription,f.sku,addon.id]);
  await db.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref,next_cycle_number)
    VALUES($1,'XXX','example','sandbox',statement_timestamp(),'example',2)`, [f.subscription]);
  for (const line of original) await db.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,$2,$3,1,617)",
    [f.subscription,line.lineOrdinal,line.sku]);
  expect(await obligations(f.sku)).toMatchObject({ outcome: "complete", obligations: expect.arrayContaining([
    expect.objectContaining({ family: "graduation", sourceId: orderId })]) });
  const dueAt = (await db.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].next_cycle_at as Date;
  const owner = createPostgresRenewalStore(db,createNativeRenewalCodec(),work => work(db));
  await owner.buildCycleSnapshots({ subscriptionId: f.subscription, scheduledAt: dueAt.toISOString(), scheduledInstant: dueAt.getTime() });
  const event = (await db.query("SELECT id,payload FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.starter_graduated'", [f.subscription])).rows[0];
  expect(event.payload).toMatchObject({ carriedAddonSkus: [addon.code] });
  expect(event.payload.linePricing.map((row: { sku: string }) => row.sku)).toEqual(pricing === "priced" ? [f.code,addon.code] : [f.code]);
  await db.query("DELETE FROM public.subscription_lines WHERE subscription_id=$1 AND variant_id=$2", [f.subscription,addon.id]);
  await db.query("DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=$1 AND sku=$2", [f.subscription,addon.code]);
  await db.query("UPDATE public.subscriptions SET template_version=3 WHERE id=$1", [f.subscription]);
  const editId = randomUUID(), hash = "d".repeat(64), key = `after-graduation:${editId}`;
  await db.query(`INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload)
    VALUES($1,$2,'subscription.customer_self_service.update_bundle',$3,$4::jsonb)`,
    [editId,f.subscription,key,JSON.stringify({ action: "update_bundle", templateVersion: 3, quoteHash: hash })]);
  await db.query(`INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,quote_hash,expected_template_version,
    proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,status,expires_at,accepted_event_id,accepted_at)
    SELECT $1,$2,$3,$4,2,$5::jsonb,28,2468,1851,'XXX','accepted',occurred_at+interval '1 hour',id,occurred_at
    FROM public.subscription_events WHERE id=$6`,
    [f.subscription,key,"a".repeat(64),hash,JSON.stringify([{ variantId: f.sku, quantity: 3, sortOrder: 0, isAddon: false, unitPriceMinor: 617 }]),editId]);
  expect((await db.query("SELECT public.subscription_catalog_basis_transition($1,1) AS result", [f.subscription])).rows[0].result)
    .toMatchObject({ outcome: "proved", kind: "graduation", eventId: event.id, basket: { [f.code]: 3, [addon.code!]: 1 } });
  const result = await obligations(f.sku);
  expect(result).toMatchObject({ outcome: "complete" });
  expect(result.obligations).not.toEqual(expect.arrayContaining([expect.objectContaining({ family: "graduation" })]));
});
// Standing immutable active facts exercise servicing. This fixture does not qualify activation or the later price writer.
async function standingActive(f: Awaited<ReturnType<typeof seed>>, sellable = false, presentation = true, activeSibling = false) {
  if (!("receipt" in f.first.result)) throw new Error("Missing first head");
  const old = (await db.query("SELECT * FROM public.catalog_publications WHERE id=$1", [f.first.result.receipt.head.publicationId])).rows[0];
  const manifest = JSON.parse(old.canonical_state), reference = manifest.skus.find((entry: { skuId: string }) => entry.skuId === f.sku);
  const prior = (await db.query("SELECT * FROM public.catalog_sku_revisions WHERE id=$1", [reference.revisionId])).rows[0];
  const facts = { ...JSON.parse(prior.full_facts), lifecycleState: "active", status: "active", sellableStandalone: sellable };
  manifest.product = { ...manifest.product, lifecycleState: "active", status: "active", ...(presentation ? {} : { presentation: null }) };
  const publication = randomUUID(), revision = randomUUID(), text = canonicalCatalogDraftJson(facts), digest = createHash("sha256").update(text).digest("hex");
  manifest.skus = manifest.skus.map((entry: { skuId: string }) => entry.skuId === f.sku ? { ...reference, revisionId: revision, revision: 2, digest } : entry);
  const sibling = activeSibling ? f.payload.skus[1]!.id : undefined;
  let siblingRevision: { id: string; text: string; digest: string } | undefined;
  if (sibling) {
    const index = manifest.skus.findIndex((entry: { skuId: string }) => entry.skuId === sibling);
    const retained = (await db.query("SELECT full_facts FROM public.catalog_sku_revisions WHERE id=$1", [manifest.skus[index].revisionId])).rows[0];
    const canonical = canonicalCatalogDraftJson({ ...JSON.parse(retained.full_facts), lifecycleState: "active", status: "active" });
    siblingRevision = { id: randomUUID(), text: canonical, digest: createHash("sha256").update(canonical).digest("hex") };
    manifest.skus[index] = { skuId: sibling, revisionId: siblingRevision.id, revision: 2, digest: siblingRevision.digest };
  }
  const canonical = canonicalCatalogDraftJson(manifest), hash = createHash("sha256").update(canonical).digest("hex");
  await db.query("INSERT INTO public.catalog_lifecycle_write_capabilities(transaction_id,product_id,fingerprint) VALUES(pg_current_xact_id(),$1,$2)", [f.product,hash]);
  await db.query("UPDATE public.catalog_products SET status='active',publication_facts=$2::jsonb WHERE id=$1", [f.product,JSON.stringify(manifest.product)]);
  await db.query("UPDATE public.catalog_skus SET status='active',publication_facts=$2::jsonb,sellable_standalone=$3 WHERE id=$1", [f.sku,text,sellable]);
  await db.query("INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id) VALUES($1,$2,2,$3,$4,1,$5,$6,$7,$8,$6,$9)", [publication,f.product,old.id,old.draft_id,`standing:${publication}`,hash,old.document_revision_id,canonical,admin]);
  await db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,2,$4,$5,$6)", [revision,f.sku,f.product,publication,text,digest]);
  if (siblingRevision) {
    await db.query("UPDATE public.catalog_skus SET status='active',publication_facts=$2::jsonb WHERE id=$1", [sibling,siblingRevision.text]);
    await db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,2,$4,$5,$6)", [siblingRevision.id,sibling,f.product,publication,siblingRevision.text,siblingRevision.digest]);
  }
  await db.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=2 WHERE product_id=$1", [f.product,publication]);
  await db.query("DELETE FROM public.catalog_lifecycle_write_capabilities WHERE product_id=$1", [f.product]);
  const head = { ...f.first.result.receipt.head, publicationId: publication, revision: 2 };
  const accepted: CatalogAcceptedReferenceV2 = { schemaVersion: 2, skuId: f.sku, skuCode: f.code, skuRevisionId: revision, publicationHead: head,
    typeRef: manifest.product.type, definitionDigest: manifest.product.definitionDigest, optionDigest: facts.optionDigest, netContent: facts.netContent,
    ...(facts.demandPolicyRef === undefined ? {} : { demandPolicyRef: facts.demandPolicyRef }) };
  return { head, accepted };
}

it.each(["order", "edit"] as const)("LC5-PRE A3 refuses a valid retained tuple for the wrong %s basket", async carrier => {
  const f = await seed({ other: true }), standing = await standingActive(f);
  const other = f.payload.skus[1]!, acceptance = JSON.stringify({ schemaVersion: 2, lines: [standing.accepted] });
  const id = randomUUID();
  if (carrier === "order") {
    const otherOrder = await order({ ...f, sku: other.id });
    await db.query("SAVEPOINT wrong_acceptance");
    await db.query("UPDATE public.commerce_orders SET catalog_acceptance=$2::jsonb WHERE id=$1", [otherOrder,acceptance]);
    await expect(db.query("SET CONSTRAINTS trg_commerce_orders_line_sum IMMEDIATE"))
      .rejects.toMatchObject({ code: "22023", message: "catalog_acceptance_line_mismatch" });
  } else {
    const payload = { action: "update_bundle", linePricing: [{ sku: other.code, quantity: 1, unitAmountMinor: 617, isAddon: false, quoteLine: {} }] };
    await db.query("SAVEPOINT wrong_acceptance");
    await db.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,catalog_acceptance) VALUES($1,'subscription.customer_self_service.update_bundle',$2,$3::jsonb,$4::jsonb)", [f.subscription,`edit:${id}`,JSON.stringify(payload),acceptance]);
    await expect(db.query("SET CONSTRAINTS subscription_events_catalog_final IMMEDIATE"))
      .rejects.toMatchObject({ code: "22023", message: "catalog_acceptance_line_mismatch" });
  }
  await db.query("ROLLBACK TO SAVEPOINT wrong_acceptance");
});
it("LC5-PRE2 unbound orders keep the restricted legacy writer path", async () => {
  const f = await seed();
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  await db.query("SET CONSTRAINTS ALL DEFERRED");
  await db.query(`CREATE ROLE lifecycle_order_writer NOLOGIN;
    GRANT USAGE ON SCHEMA public TO lifecycle_order_writer;
    GRANT SELECT, INSERT ON public.commerce_orders, public.commerce_order_items TO lifecycle_order_writer;
    GRANT SELECT ON public.commerce_order_adjustments TO lifecycle_order_writer;
    SET LOCAL ROLE lifecycle_order_writer`);
  expect((await db.query("SELECT has_function_privilege(current_user,'public.catalog_order_evidence_v2(uuid,jsonb,jsonb,boolean)','EXECUTE') AS catalog_evidence")).rows)
    .toEqual([{ catalog_evidence: false }]);
  const id = await order(f,"pending_payment");
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  expect((await db.query("SELECT status,catalog_acceptance FROM public.commerce_orders WHERE id=$1",[id])).rows)
    .toEqual([{ status: "pending_payment", catalog_acceptance: null }]);
  await db.query("RESET ROLE");
});

it.each(["order at commit", "edit matches only event", "edit matches only preview"] as const)("LC5-PRE2 acceptance reconciles both owners for %s", async path => {
  const f = await seed({ other: true }), standing = await standingActive(f);
  const other = f.payload.skus[1]!;
  let reference = standing.accepted;
  if (path === "edit matches only preview") {
    const page = await authority.readbackV3(standing.head);
    if (page.outcome !== "page") throw new Error(JSON.stringify(page));
    const chosen = page.items.find(item => item.facts.id === other.id)!;
    reference = { ...reference, skuId: chosen.facts.id, skuCode: chosen.facts.code, skuRevisionId: chosen.reference.revisionId,
      netContent: chosen.facts.netContent, optionDigest: chosen.facts.optionDigest };
  }
  const acceptance = JSON.stringify({ schemaVersion: 2, lines: [reference] });
  const sku = f.code, id = randomUUID();
  await db.query("SAVEPOINT contradictory_acceptance");
  if (path === "order at commit") {
    const metadata = { orderDraftSnapshot: { lines: [{ sku, quantity: 1 }] } };
    await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor,metadata,catalog_acceptance) VALUES($1,$2,'XXX',617,$3::jsonb,$4::jsonb)",
      [id,f.client,JSON.stringify(metadata),acceptance]);
    await db.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,1,1,617,617)",[id,other.id]);
    await expect.soft(db.query("SET CONSTRAINTS trg_commerce_orders_line_sum, trg_commerce_order_items_line_sum IMMEDIATE"))
      .rejects.toMatchObject({ code: "22023", message: "catalog_acceptance_line_mismatch" });
  } else {
    const preview = randomUUID(), action = "update_bundle";
    const payload = { action, quotePreviewId: preview, linePricing: [{ sku, quantity: 1, unitAmountMinor: 617, isAddon: false, quoteLine: {} }] };
    await db.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload) VALUES($1,$2,'subscription.customer_self_service.update_bundle',$3,$4::jsonb)",
      [id,f.subscription,`edit:${id}`,JSON.stringify(payload)]);
    await db.query(`INSERT INTO public.subscription_quote_previews(id,subscription_id,client_id,actor_id,action,quote_hash,template_version,expires_at,status,request_payload,quote_snapshot,totals,accepted_at,accepted_idempotency_key,accepted_event_id)
      VALUES($1,$2,$3,$4,$5,$6,1,clock_timestamp()+interval '1 hour','accepted','{}',$7::jsonb,'{}',
        (SELECT occurred_at FROM public.subscription_events WHERE id=$8),$9,$8)`,
      [preview,f.subscription,f.client,randomUUID(),action,"b".repeat(64),JSON.stringify({ lines: [{ variantId: other.id, qty: 1, quoteLine: { sku: other.code } }] }),id,`accept:${id}`]);
    await db.query("UPDATE public.subscription_events SET catalog_acceptance=$2::jsonb WHERE id=$1",[id,acceptance]);
    await expect.soft(db.query("SET CONSTRAINTS subscription_events_catalog_final IMMEDIATE"))
      .rejects.toMatchObject({ code: "22023", message: "catalog_acceptance_line_mismatch" });
  }
  await db.query("ROLLBACK TO SAVEPOINT contradictory_acceptance");
});

it.each([
  "header before items", "zero receipt only", "changed receipt", "moved item", "unlinked edit", "missing preview acceptance",
  "wrong preview link", "changed preview", "changed classic quote", "customer scope",
] as const)("LC5-C3 A3 reconciles the final owners: %s", async path => {
  const f = await seed({ other: true }), standing = await standingActive(f), other = f.payload.skus[1]!;
  const acceptance = JSON.stringify({ schemaVersion: 2, lines: [standing.accepted] });
  const target = randomUUID(), mismatch = { code: "22023", message: "catalog_acceptance_line_mismatch" };
  const check = (trigger: string) => db.query(`SET CONSTRAINTS ${trigger} IMMEDIATE`);
  const rearm = async () => { await check("ALL"); await db.query("SET CONSTRAINTS ALL DEFERRED"); };
  const anchor = "final_owner";

  if (["header before items", "zero receipt only", "changed receipt", "moved item"].includes(path)) {
    const total = path === "header before items" ? 617 : 0;
    await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor,catalog_acceptance) VALUES($1,$2,'XXX',$3,$4::jsonb)",
      [target,f.client,total,acceptance]);
    if (path === "zero receipt only" || path === "changed receipt" || path === "moved item") await saveOrderQuote(target,[{ sku: f.code, quantity: 1 }]);
    if (total > 0 || path === "moved item") await db.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,1,1,$3,$3)", [target,f.sku,total]);
    await rearm();
    expect((await db.query("SELECT catalog_acceptance FROM public.commerce_orders WHERE id=$1", [target])).rows[0].catalog_acceptance).toEqual(JSON.parse(acceptance));
    if (path === "changed receipt") {
      await db.query(`SAVEPOINT ${anchor}`);
      await db.query("UPDATE public.commerce_order_draft_receipts SET response_payload=jsonb_set(response_payload,'{orderDraft,quoteSnapshot,quote,lines,0,sku}',to_jsonb($2::text)) WHERE order_id=$1", [target,other.code]);
      await expect(check("commerce_order_draft_receipts_catalog_final")).rejects.toMatchObject(mismatch);
      await db.query(`ROLLBACK TO SAVEPOINT ${anchor}`);
      expect((await db.query("SELECT response_payload#>>'{orderDraft,quoteSnapshot,quote,lines,0,sku}' AS sku FROM public.commerce_order_draft_receipts WHERE order_id=$1", [target])).rows)
        .toEqual([{ sku: f.code }]);
    } else if (path === "moved item") {
      const source = randomUUID();
      await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',0)", [source,f.client]);
      await db.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,2,1,0,0)", [source,other.id]);
      await rearm();
      await db.query(`SAVEPOINT ${anchor}`);
      await db.query("UPDATE public.commerce_order_items SET order_id=$1 WHERE order_id=$2", [target,source]);
      await expect(check("trg_commerce_order_items_line_sum")).rejects.toMatchObject(mismatch);
      await db.query(`ROLLBACK TO SAVEPOINT ${anchor}`);
      expect((await db.query("SELECT sku_id FROM public.commerce_order_items WHERE order_id=$1", [source])).rows).toEqual([{ sku_id: other.id }]);
    }
    return;
  }

  const classic = path === "changed classic quote" || path === "customer scope", linked = path !== "unlinked edit" && !classic;
  const action = classic ? "update_bundle" : "update_package_template", preview = randomUUID(), hash = "c".repeat(64), key = `accept:${target}`;
  const clock = (await db.query("SELECT statement_timestamp() AS at, statement_timestamp()+interval '1 hour' AS expiry")).rows[0];
  const quoteLine = { sku: f.code, quantity: 1, unitPriceGross: { amountMinor: 617 } };
  const proposed = [{ variantId: f.sku, qty: 1, quoteLine }];
  const payload = { action, ...(linked ? { quotePreviewId: preview } : {}),
    ...(classic ? { quoteHash: hash, templateVersion: 2 } : {
      linePricing: [{ sku: f.code, quantity: 1, unitAmountMinor: 617, isAddon: false, quoteLine }],
    }) };
  if (linked) {
    await db.query(`INSERT INTO public.subscription_quote_previews(id,subscription_id,client_id,actor_id,action,quote_hash,template_version,expires_at,status,request_payload,quote_snapshot,totals)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,'previewed','{}',$8::jsonb,'{}')`,
      [preview,f.subscription,f.client,randomUUID(),action,hash,clock.expiry,JSON.stringify({ baseLines: proposed, addonLines: [] })]);
  }
  await db.query(`SAVEPOINT ${anchor}`);
  await db.query(`INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload,catalog_acceptance,occurred_at)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`, [target,f.subscription,`subscription.customer_self_service.${action}`,key,JSON.stringify(payload),acceptance,clock.at]);
  if (path === "missing preview acceptance" || path === "wrong preview link") {
    if (path === "wrong preview link") {
      const unrelated = randomUUID();
      await db.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,occurred_at) VALUES($1,$2,$3,$4,$5)",
        [unrelated,f.subscription,`subscription.customer_self_service.${action}`,`unrelated:${target}`,clock.at]);
      await db.query("SELECT public.subscription_quote_preview_mark_accepted($1,$2,$3,$4)", [preview,key,unrelated,clock.at]);
    }
    await expect(check("subscription_events_catalog_final")).rejects.toMatchObject(mismatch);
    await db.query(`ROLLBACK TO SAVEPOINT ${anchor}`);
    expect((await db.query("SELECT accepted_event_id FROM public.subscription_quote_previews WHERE id=$1", [preview])).rows).toEqual([{ accepted_event_id: null }]);
    expect((await db.query("SELECT id FROM public.subscription_events WHERE id=$1", [target])).rows).toEqual([]);
    return;
  }
  if (linked) await db.query("SELECT public.subscription_quote_preview_mark_accepted($1,$2,$3,$4)", [preview,key,target,clock.at]);
  if (classic) {
    const lines = [{ variantId: f.sku, quantity: 1, sortOrder: 0, isAddon: false, unitPriceMinor: 617 }];
    await db.query(`INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,quote_hash,expected_template_version,
      proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,status,expires_at,accepted_event_id,accepted_at)
      VALUES($1,$2,$3,$4,1,$5::jsonb,28,617,617,'XXX','accepted',$6,$7,$8)`,
      [f.subscription,key,"d".repeat(64),hash,JSON.stringify(lines),clock.expiry,target,clock.at]);
  }
  await rearm();
  expect((await db.query("SELECT catalog_acceptance FROM public.subscription_events WHERE id=$1", [target])).rows[0].catalog_acceptance).toEqual(JSON.parse(acceptance));
  if (path === "unlinked edit") return;
  await db.query("SAVEPOINT corrupt_companion");
  if (classic) {
    await db.query("UPDATE public.subscription_edit_quotes SET proposed_lines=jsonb_set(proposed_lines,'{0,variantId}',to_jsonb($2::uuid)) WHERE accepted_event_id=$1", [target,other.id]);
    if (path === "customer scope") {
      const principal = randomUUID();
      await db.query("UPDATE public.clients SET principal_id=$2 WHERE id=$1", [f.client,principal]);
      await db.query("SET LOCAL ROLE authenticated");
      const proof = await db.query(`SELECT has_table_privilege(current_user,'public.subscription_events','SELECT') AS event_read,
        has_function_privilege(current_user,'public.catalog_edit_acceptance_final(uuid)','EXECUTE') AS evidence_exec`);
      expect(proof.rows).toEqual([{ event_read: false, evidence_exec: false }]);
      const scope = (sub: string) => db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub, role: "authenticated" })]);
      await scope(randomUUID());
      await db.query("SELECT public.catalog_customer_edit_acceptance_assert($1)", [target]);
      await scope(principal);
      await expect(check("subscription_edit_quotes_catalog_final")).rejects.toMatchObject(mismatch);
    } else await expect(check("subscription_edit_quotes_catalog_final")).rejects.toMatchObject(mismatch);
  } else {
    await db.query("UPDATE public.subscription_quote_previews SET quote_snapshot=jsonb_set(quote_snapshot,'{baseLines,0,quoteLine,unitPriceGross,amountMinor}','618') WHERE id=$1", [preview]);
    await expect(check("subscription_quote_previews_catalog_final")).rejects.toMatchObject(mismatch);
  }
  await db.query("ROLLBACK TO SAVEPOINT corrupt_companion");
  expect((await db.query("SELECT catalog_acceptance FROM public.subscription_events WHERE id=$1", [target])).rows[0].catalog_acceptance).toEqual(JSON.parse(acceptance));
});

function withdrawal(f: Awaited<ReturnType<typeof seed>>): CatalogDraftPayloadV4 {
  const payload = structuredClone(f.payload); payload.product.sharedContent.catalogAction = "revise";
  payload.publication.operations = [{ op: "set_product_lifecycle", productSlug: payload.product.slug!, expectedState: "active", state: "withdrawn", children: [{ skuCode: f.code, expectedState: "active" }] }];
  return payload;
}

it.each(["current", "historical"] as const)("LC5-PRE-L2B-11 %s observation uses governed withdrawal", async path => {
  const f = await seed(), standing = await standingActive(f, true);
  const result = (await publish(withdrawal(f),1,standing.head)).result;
  if (!("receipt" in result)) throw new Error(JSON.stringify(result));
  const head = result.receipt.head;
  const observation = path === "current" ? await authority.reads.current(f.product) : await authority.reads.readback(head);
  expect(observation).toMatchObject({ outcome: "found", observations: [expect.objectContaining({ variantId: f.sku, state: "withdrawn" })] });
});
it("catalog_withdraw_preserves_retained_subscription_read", async () => {
  const f = await seed(), standing = await standingActive(f), id = randomUUID();
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code,catalog_sku_revision_id) VALUES($1,$2,3,0,617,'XXX',$3)", [f.subscription,f.sku,standing.accepted.skuRevisionId]);
  await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',0)", [id,f.client]);
  await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3::jsonb,clock_timestamp())", [id,f.subscription,JSON.stringify({ templateId: "synthetic", shippingAmountMinor: 0, acquisitionRef: null, renewalTerms: { version: "native.renewal-terms.v1" } })]);
  await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref,catalog_acceptance) VALUES($1,'XXX','synthetic','sandbox',clock_timestamp(),'synthetic',$2::jsonb)", [f.subscription,JSON.stringify({ schemaVersion: 2, lines: [standing.accepted] })]);
  const before = (await db.query("SELECT to_jsonb(s) AS subscription,(SELECT jsonb_agg(to_jsonb(l)) FROM public.subscription_lines l WHERE l.subscription_id=s.id) AS lines FROM public.subscriptions s WHERE id=$1", [f.subscription])).rows;
  const retained = (await db.query("SELECT public.subscription_renewal_purchase_terms_v2($1) AS facts", [f.subscription])).rows;
  readiness = async () => { throw new Error("Unrelated activation readiness outage"); };
  expect((await publish(withdrawal(f),1,standing.head)).result).toMatchObject({ outcome: "committed" });
  expect((await db.query("SELECT public.subscription_renewal_purchase_terms_v2($1) AS facts", [f.subscription])).rows).toEqual(retained);
  expect((await db.query("SELECT to_jsonb(s) AS subscription,(SELECT jsonb_agg(to_jsonb(l)) FROM public.subscription_lines l WHERE l.subscription_id=s.id) AS lines FROM public.subscriptions s WHERE id=$1", [f.subscription])).rows).toEqual(before);
  expect(await assertCatalogAcceptedReferenceV2(db, standing.accepted)).toEqual(standing.accepted);
  expect((await db.query("SELECT status,sellable_standalone,sellable_in_subscription,publication_facts->>'lifecycleState' AS lifecycle FROM public.catalog_skus WHERE id=$1", [f.sku])).rows).toEqual([{ status: "active", sellable_standalone: false, sellable_in_subscription: false, lifecycle: "withdrawn" }]);
});
it("catalog_restore_rechecks_current_readiness", async () => {
  const f = await seed(), standing = await standingActive(f), payload = withdrawal(f);
  const withdrawn = (await publish(payload,1,standing.head)).result;
  if (!("receipt" in withdrawn)) throw new Error(JSON.stringify(withdrawn));
  payload.publication.operations = [{ op: "restore_product", productSlug: payload.product.slug!, expectedState: "withdrawn" }];
  readiness = async () => ({ ready: false, reasons: ["current_readiness_unavailable"] });
  expect((await publish(payload,2,withdrawn.receipt.head)).result).toMatchObject({ reason: "catalog_publication_v3_activation_readiness_failed" });
  expect((await db.query("SELECT publication_id FROM public.catalog_publication_heads WHERE product_id=$1", [f.product])).rows[0].publication_id).toBe(withdrawn.receipt.head.publicationId);
});
it("catalog_material_change_requires_successor_sku", async () => {
  const f = await seed();
  if (!("receipt" in f.first.result)) throw new Error("Missing first head");
  const payload = structuredClone(f.payload); payload.product.sharedContent.catalogAction = "revise";
  payload.skus[0]!.netContent!.unscaled = "200";
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: payload.product.slug!, presentation: {} }];
  expect((await publish(payload,1,f.first.result.receipt.head)).result).toMatchObject({ reason: "sku_identity_change_requires_new_sku" });
});
it.each(["receipt", "outbox"] as const)("late %s failure rolls back withdrawal, child facts, revisions and head", async point => {
  const f = await seed(), standing = await standingActive(f);
  const before = (await db.query("SELECT (SELECT jsonb_agg(to_jsonb(p)) FROM public.catalog_products p) AS products,(SELECT jsonb_agg(to_jsonb(s)) FROM public.catalog_skus s) AS skus,(SELECT jsonb_agg(to_jsonb(h)) FROM public.catalog_publication_heads h) AS heads,(SELECT count(*) FROM public.catalog_publications) AS publications,(SELECT count(*) FROM public.catalog_sku_revisions) AS revisions")).rows;
  await db.query("CREATE FUNCTION public.lifecycle_test_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_late_failure'; END; $$");
  const table = point === "receipt" ? "catalog_operator_receipts" : "outbox_events";
  const when = point === "outbox" ? " WHEN (NEW.event_type='catalog.publication.committed')" : " WHEN (NEW.kind='publish')";
  await db.query(`CREATE TRIGGER lifecycle_test_late_failure BEFORE INSERT ON public.${table} FOR EACH ROW${when} EXECUTE FUNCTION public.lifecycle_test_late_failure()`);
  expect((await publish(withdrawal(f),1,standing.head)).result).toMatchObject({ outcome: "dependency_unavailable" });
  expect((await db.query("SELECT (SELECT jsonb_agg(to_jsonb(p)) FROM public.catalog_products p) AS products,(SELECT jsonb_agg(to_jsonb(s)) FROM public.catalog_skus s) AS skus,(SELECT jsonb_agg(to_jsonb(h)) FROM public.catalog_publication_heads h) AS heads,(SELECT count(*) FROM public.catalog_publications) AS publications,(SELECT count(*) FROM public.catalog_sku_revisions) AS revisions")).rows).toEqual(before);
});

it("all seven obligation families independently survive in one archive decision", async () => {
  const f = await seed(), id = await order(f), operation = await frozen(f);
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,1,0,617,'XXX')", [f.subscription,f.sku]);
  await db.query("INSERT INTO public.subscription_activations(order_id,client_id,cadence_days,declare_idempotency_key) VALUES($1,$2,28,$3)", [id,f.client,`activate:${id}`]);
  await replacement(f,id);
  await db.query("INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits) SELECT $1,$2,id,scheduled_at,cycle_number,'waiting','{}',cycle_snapshot,operation_fingerprint,identity_key,'[]' FROM public.subscription_renewal_operations WHERE id=$3", [f.subscription,f.client,operation]);
  const graduate = randomUUID(), basis = (await db.query("SELECT template_version FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].template_version;
  await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',0)", [graduate,f.client]);
  await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3::jsonb,clock_timestamp())", [graduate,f.subscription,JSON.stringify(graduationFacts(basis,f.code))]);
  const result = await obligations(f.sku);
  expect(result.outcome).toBe("complete");
  expect(new Set(result.obligations.map((value: { family: string }) => value.family))).toEqual(new Set(["template","pending_activation","frozen_renewal","outstanding_order","replacement","stock_wait","graduation"]));
  expect(await archive(f)).toMatchObject({ reason: "catalog_archive_refuses_outstanding_obligations" });
});
it("filtered evidence never becomes an empty complete obligation result", async () => {
  const f = await seed();
  await db.query("CREATE ROLE lifecycle_reader NOLOGIN");
  await db.query("GRANT SELECT ON public.catalog_skus TO lifecycle_reader");
  await db.query("GRANT EXECUTE ON FUNCTION public.catalog_bound_obligations_v2(uuid) TO lifecycle_reader");
  await db.query("SET LOCAL ROLE lifecycle_reader");
  const result = await obligations(f.sku);
  expect(["unknown","unavailable"]).toContain(result.outcome);
  await db.query("RESET ROLE");
});


it.each([
  ["LC5-D-008", "sku spelling"],
  ["LC5-D-009", "boolean stand-in"],
  ["LC5-D-010", "null lifecycle"],
  ["LC5-D-012", "absent pair"],
  ["LC5-D-012", "foreign pair"],
  ["LC5-D-012", "disabled pair"],
  ["LC5-D-056", "duplicate draft"],
  ["LC5-D-056", "duplicate media"],
  ["LC5-D-056", "asset order"],
  ["LC5-D-056", "asset capacity"],
  ["LC5-D-056", "bad reference"],
  ["LC5-PRE-L1A-1", "tab-prefixed media"],
  ["LC5-PRE-L1B-1", "tab-only asset"],
  ["LC5-PRE-L1A-1", "overlong UTF-16 reference"],
  ["LC5-A-002", "missing child key"],
  ["LC5-A-002", "duplicate child"],
  ["LC5-A-002", "child order"],
] as const)("draft grammar %s refuses %s before writing a revision or receipt", async (_rule, defect) => {
  const { payload } = input();
  const lifecycle = { op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "withdrawn",
    children: [{ skuCode: "ARTICLE", expectedState: "active" }, { skuCode: "OTHER", expectedState: "active" }] };
  const restore = { op: "restore_sku", skuCode: "ARTICLE", expectedState: "withdrawn" };
  const enable = { op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: true, sellableInSubscription: false };
  const evidence = { drafts: [{ draftId, revision: 1, commandKey: "draft:proof", fingerprint: "a".repeat(64) }],
    media: [{ skuCode: "ARTICLE", mediaRef: "example:media", revisionDigest: "b".repeat(64),
      assetRefs: Array.from({ length: 32 }, (_, index) => `example:asset-${String(index).padStart(2, "0")}`) }] };
  const publication = { ...payload.publication, operations: [...payload.publication.operations, lifecycle, restore, enable], evidence };
  const valid = { schemaVersion: 4, action: "create", draftId, commandKey: "draft:grammar", expectedRevision: 0,
    payload: { ...payload, publication } };
  const invalid = structuredClone(valid);
  const ops = invalid.payload.publication.operations, target = ops.at(-3) as typeof lifecycle;
  const flag = ops.at(-1) as typeof enable, retained = invalid.payload.publication.evidence;
  if (defect === "sku spelling") {
    Object.assign(ops.at(-2)!, { skuCode: " ARTICLE" });
    flag.skuCode = " ARTICLE";
  }
  if (defect === "boolean stand-in") Object.assign(flag, { sellableStandalone: "true", sellableInSubscription: true });
  if (defect === "null lifecycle") Object.assign(target, { expectedState: null });
  if (defect === "absent pair") ops.pop();
  if (defect === "foreign pair") flag.skuCode = "OTHER";
  if (defect === "disabled pair") flag.sellableStandalone = false;
  if (defect === "duplicate draft") retained.drafts.push(retained.drafts[0]!);
  if (defect === "duplicate media") retained.media.push(retained.media[0]!);
  if (defect === "asset order") retained.media[0]!.assetRefs.reverse();
  if (defect === "asset capacity") retained.media[0]!.assetRefs.push("example:asset-32");
  if (defect === "bad reference") retained.media[0]!.mediaRef = " example:media";
  if (defect === "tab-prefixed media") retained.media[0]!.mediaRef = "\texample:media";
  if (defect === "tab-only asset") retained.media[0]!.assetRefs[0] = "\t";
  if (defect === "overlong UTF-16 reference") retained.media[0]!.mediaRef = "😀".repeat(121);
  if (defect === "missing child key") Object.assign(target.children[0]!, { expectedState: undefined });
  if (defect === "duplicate child") target.children[1]!.skuCode = "ARTICLE";
  if (defect === "child order") target.children.reverse();
  async function apply(command: unknown) {
    const text = canonicalCatalogDraftJson(JSON.parse(JSON.stringify(command)));
    return (await db.query("SELECT public.catalog_draft_apply($1,$2,'operator:synthetic') AS result",
      [text, createHash("sha256").update(text).digest("hex")])).rows[0].result;
  }
  expect(await apply(invalid)).toMatchObject({ outcome: "validation_issue", reason: "publication_inputs_invalid" });
  for (const table of ["catalog_draft_heads", "catalog_draft_revisions", "catalog_draft_command_receipts"]) {
    expect((await db.query(`SELECT count(*)::int AS n FROM public.${table} WHERE draft_id=$1`, [draftId])).rows).toEqual([{ n: 0 }]);
  }
  const committed = await apply(valid);
  expect(committed).toMatchObject({ outcome: "committed" });
  expect(await apply(valid)).toEqual({ ...committed, outcome: "replayed" });
});

it.each([
  ["UTF-16 order", ["𐀀", "\uE000"], "example:policy", true],
  ["UTF-8-only order", ["\uE000", "𐀀"], "example:policy", false],
  ["tab-prefixed policy", [], "\texample:policy", false],
  ["tab-prefixed command key", [], "example:policy", false],
  ["tab-prefixed authored asset", [], "example:policy", false],
] as const)("LC5-PRE2 storage and draft codecs agree for %s", async (edge, assets, policy, admitted) => {
  const { payload } = input();
  payload.publication.evidence = { media: [{ skuCode: "ARTICLE", mediaRef: "example:media", assetRefs: [...assets], revisionDigest: "b".repeat(64) }] };
  payload.skus[0]!.demandPolicyRef = policy;
  if (edge === "tab-prefixed authored asset") payload.skus[0]!.assetRefs = ["\texample:asset"];
  const commandKey = edge === "tab-prefixed command key" ? "\tdraft:unicode" : "draft:unicode";
  const draft = { schemaVersion: 4, action: "create", draftId, commandKey, expectedRevision: 0, payload };
  const text = canonicalCatalogDraftJson(draft), hash = createHash("sha256").update(text).digest("hex");
  expect(catalogDraftCommandV4Schema.safeParse(draft).success).toBe(admitted);
  const apply = async () => (await db.query("SELECT public.catalog_draft_apply($1,$2,'operator:synthetic') AS result",[text,hash])).rows[0].result;
  const result = await apply();
  expect(result.outcome).toBe(admitted ? "committed" : "validation_issue");
  const stored = (await db.query("SELECT payload FROM public.catalog_draft_revisions WHERE draft_id=$1",[draftId])).rows;
  if (admitted) {
    expect(catalogDraftCommandV4Schema.parse({ ...draft, payload: stored[0].payload })).toEqual(draft);
    expect(await apply()).toEqual({ ...result, outcome: "replayed" });
  } else expect(stored).toEqual([]);
});

it.each((["parent", "sku"] as const).flatMap(path => ([
  ["LC5-A-009", "zero", "catalog_obligation_evidence_unknown"],
  ["LC5-A-009", "duplicate", "catalog_obligation_evidence_unknown"],
  ["LC5-A-009", "malformed", "catalog_obligation_evidence_unknown"],
  ["LC5-A-009", "foreign", "catalog_obligation_evidence_unknown"],
  ["LC5-A-009", "bound", "catalog_archive_refuses_outstanding_obligations"],
  ["LC5-A-010", "unknown", "catalog_obligation_evidence_unknown"],
  ["LC5-A-010", "unavailable", "catalog_obligation_evidence_unavailable"],
  ["LC5-A-034", "empty", "catalog_archive_barrier_unavailable"],
] as const).map(([rule, shape, reason]) => ({ path, rule, shape, reason }))))(
  "obligation result $rule $path $shape", async ({ path, shape, reason }) => {
    const f = await seed({ other: path === "sku" });
    const target = path === "sku" ? f.payload.skus[1]! : f.payload.skus[0]!;
    const empty = { result: { schemaVersion: 2, outcome: "complete", obligations: [] } };
    const entry = { family: "template", sourceId: f.subscription, subscriptionId: f.subscription,
      skuId: target.id, skuCode: target.code, skuRevisionId: null };
    obligationRows = shape === "empty" ? undefined : shape === "zero" ? [] : shape === "duplicate" ? [empty, empty]
      : shape === "unknown" || shape === "unavailable" ? [{ result: { schemaVersion: 2, outcome: shape, reason } }]
        : [{ result: { ...empty.result, obligations: [shape === "malformed" ? { ...entry, family: "malformed" }
          : shape === "foreign" ? { ...entry, skuId: randomUUID() } : entry] } }];
    const payload = structuredClone(f.payload);
    payload.product.sharedContent.catalogAction = "revise";
    payload.publication.operations = path === "parent"
      ? [{ op: "set_product_lifecycle", productSlug: payload.product.slug!, expectedState: "draft", state: "archived", children: [] }]
      : [{ op: "set_sku_lifecycle", skuCode: target.code!, expectedState: "draft", state: "archived" }];
    if (!("receipt" in f.first.result)) throw new Error("Missing initial receipt");
    const before = (await db.query("SELECT * FROM public.catalog_publication_heads")).rows;
    expect((await publish(payload, 1, f.first.result.receipt.head)).result).toMatchObject({ reason });
    expect((await db.query("SELECT * FROM public.catalog_publication_heads")).rows).toEqual(before);
  },
);

it.each([
  ["LC5-A-012", "incomplete attachment"],
  ["LC5-A-013", "unhanded provisional"],
  ["LC5-A-015", "recoverable refusal"],
  ["LC5-A-016", "contradictory basket"],
  ["LC5-A-016", "blank basket code"],
  ["LC5-A-017", "delivered unrelated item"],
  ["LC5-A-017", "missing item ledger"],
  ["LC5-A-019", "contradictory replacement"],
  ["LC5-A-021", "unproven resume"],
] as const)("obligation source %s with %s", async (_rule, shape) => {
  const f = await seed({ other: shape === "delivered unrelated item" });
  let expected: { outcome: string; obligations?: unknown[] } = { outcome: "unknown" };
  if (shape === "incomplete attachment" || shape === "unhanded provisional") {
    const id = await order(f, "pending_payment");
    if (shape === "incomplete attachment") {
      await db.query("INSERT INTO public.subscription_activations(order_id,client_id,subscription_id,cadence_days,state,payment_fingerprint,activation_idempotency_key,declare_idempotency_key,activated_at) VALUES($1,$2,$3,28,'active',$4,$5,$6,clock_timestamp())", [id,f.client,f.subscription,"a".repeat(64),`active:${id}`,`declare:${id}`]);
      await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,'{}',clock_timestamp())", [id,f.subscription]);
    } else {
      await db.query("UPDATE public.commerce_orders SET metadata=$2::jsonb WHERE id=$1",
        [id, JSON.stringify({ quoteSnapshot: { quote: { lines: [{ sku: f.code, quantity: 1 }] } } })]);
    }
    expected = { outcome: "complete", obligations: [expect.objectContaining({ family: "pending_activation", sourceId: id })] };
  } else if (shape === "recoverable refusal" || shape === "contradictory basket" || shape === "blank basket code" || shape === "unproven resume") {
    const operation = await frozen(f);
    if (shape === "recoverable refusal") {
      await db.query("UPDATE public.subscription_renewal_operations SET state='refused',terminal_outcome='refused',terminal_at=clock_timestamp(),terminal_reason='inventory_unavailable',claimed_at=clock_timestamp()-interval '2 seconds',lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [operation]);
      await db.query("UPDATE public.subscriptions SET next_cycle_at=(SELECT scheduled_at FROM public.subscription_renewal_operations WHERE id=$2) WHERE id=$1", [f.subscription,operation]);
      expected = { outcome: "complete", obligations: [expect.objectContaining({ family: "frozen_renewal", sourceId: operation })] };
    } else if (shape === "unproven resume") {
      const id = randomUUID(), provisional = await order(f, "pending_payment");
      await db.query("INSERT INTO public.subscription_stock_wait_cases(id,subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits,order_id) SELECT $1,$2,$3,id,scheduled_at,cycle_number,'resumed','{}',cycle_snapshot,operation_fingerprint,identity_key,'[]',$5 FROM public.subscription_renewal_operations WHERE id=$4", [id,f.subscription,f.client,operation,provisional]);
      expected = { outcome: "complete", obligations: expect.arrayContaining([expect.objectContaining({ family: "stock_wait", sourceId: id })]) };
    } else {
      const lines = [{ sku: shape === "blank basket code" ? " " : "OTHER", ...(shape === "contradictory basket" ? { skuCode: f.code } : {}), quantity: 3 }];
      await db.query("UPDATE public.subscription_renewal_operations SET cycle_snapshot=$2::jsonb WHERE id=$1", [operation,JSON.stringify({ lines })]);
    }
  } else if (shape === "missing item ledger") {
    await db.query("INSERT INTO public.commerce_orders(client_id,status,currency_code,total_amount_minor) VALUES($1,'paid','XXX',0)", [f.client]);
  } else {
    const id = await order(f, shape === "contradictory replacement" ? "cancelled" : "fulfilled");
    const { leaf } = await replacement(f,id);
    if (shape === "contradictory replacement") {
      await db.query("UPDATE public.fulfillment_parcel_lines SET sku='OTHER' WHERE shipment_id=$1", [leaf]);
    } else {
      const other = f.payload.skus[1]!.id;
      await db.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,2,1,0,0)", [id,other]);
      await db.query("UPDATE public.fulfillment_parcel_lines SET sku_id=$2,sku='OTHER',order_item_id=(SELECT id FROM public.commerce_order_items WHERE order_id=$3 AND line_ordinal=2) WHERE shipment_id=$1", [leaf,other,id]);
      await db.query("UPDATE public.fulfillment_shipments SET status='delivered',delivered_at=clock_timestamp() WHERE id=$1", [leaf]);
      expected = { outcome: "complete", obligations: [expect.objectContaining({ family: "outstanding_order", sourceId: id })] };
    }
  }
  expect(await obligations(f.sku)).toMatchObject(expected);
  expect(await archive(f)).toMatchObject({ reason: expected.outcome === "unknown" ? "catalog_obligation_evidence_unknown" : "catalog_archive_refuses_outstanding_obligations" });
});

type RetainedAuthorityFault = "unsupported retained version" | "noncanonical retained manifest" | "noncanonical retained sku";
async function seedInvalidRetainedSku(reference: CatalogAcceptedReferenceV2, fault: RetainedAuthorityFault): Promise<CatalogAcceptedReferenceV2> {
  const prior = (await db.query("SELECT * FROM public.catalog_publications WHERE id=$1", [reference.publicationHead.publicationId])).rows[0];
  const stored = (await db.query("SELECT full_facts FROM public.catalog_sku_revisions WHERE id=$1", [reference.skuRevisionId])).rows[0];
  const publicationId = randomUUID(), skuRevisionId = randomUUID(), revision = prior.revision + 1;
  const facts = JSON.parse(stored.full_facts);
  if (fault === "unsupported retained version") facts.schemaVersion = 99;
  const badFacts = (fault === "noncanonical retained sku" ? " " : "") + canonicalCatalogDraftJson(facts);
  const skuDigest = createHash("sha256").update(badFacts).digest("hex");
  const manifest = JSON.parse(prior.canonical_state);
  manifest.skus = manifest.skus.map((entry: { skuId: string }) => entry.skuId === reference.skuId
    ? { skuId: entry.skuId, revisionId: skuRevisionId, revision, digest: skuDigest } : entry);
  const canonical = (fault === "noncanonical retained manifest" ? " " : "") + canonicalCatalogDraftJson(manifest);
  const digest = createHash("sha256").update(canonical).digest("hex");
  await db.query("SET CONSTRAINTS catalog_publications_roster_final IMMEDIATE");
  await db.query("ALTER TABLE public.catalog_publications DISABLE TRIGGER catalog_publications_roster_final");
  if (fault === "noncanonical retained manifest")
    await db.query("ALTER TABLE public.catalog_publications DISABLE TRIGGER catalog_publications_record_admit");
  await db.query(`INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id)
    SELECT $1,product_id,revision+1,id,draft_id,draft_revision,$2,candidate_digest,document_revision_id,$3,$4,actor_id
    FROM public.catalog_publications WHERE id=$5`, [publicationId,`synthetic:stored:${publicationId}`,canonical,digest,prior.id]);
  if (fault === "noncanonical retained manifest")
    await db.query("ALTER TABLE public.catalog_publications ENABLE TRIGGER catalog_publications_record_admit");
  await db.query("ALTER TABLE public.catalog_publications ENABLE TRIGGER catalog_publications_roster_final");
  await db.query("SET CONSTRAINTS catalog_publications_roster_final DEFERRED");
  // Inject a coherent digest and manifest around one unsupported retained record.
  await db.query("ALTER TABLE public.catalog_sku_revisions DISABLE TRIGGER catalog_sku_revisions_record_admit");
  await db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [skuRevisionId,reference.skuId,prior.product_id,revision,publicationId,badFacts,skuDigest]);
  await db.query("ALTER TABLE public.catalog_sku_revisions ENABLE TRIGGER catalog_sku_revisions_record_admit");
  return { ...reference, skuRevisionId, publicationHead: { ...reference.publicationHead, publicationId, revision } };
}

it("LC5-PRE obligation authority rejects a noncanonical current manifest even with its matching hash", async () => {
  const f = await seed(), standing = await standingActive(f);
  expect(await obligations(f.sku)).toEqual({ schemaVersion: 2, outcome: "complete", obligations: [] });
  const { publicationHead } = await seedInvalidRetainedSku(standing.accepted, "noncanonical retained manifest");
  await db.query("SET CONSTRAINTS catalog_publication_heads_lifecycle_admit IMMEDIATE");
  await db.query("ALTER TABLE public.catalog_publication_heads DISABLE TRIGGER catalog_publication_heads_lifecycle_admit");
  await db.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=$3 WHERE product_id=$1",
    [f.product,publicationHead.publicationId,publicationHead.revision]);
  await db.query("ALTER TABLE public.catalog_publication_heads ENABLE TRIGGER catalog_publication_heads_lifecycle_admit");
  expect(await obligations(f.sku)).toEqual({ schemaVersion: 2, outcome: "unknown", reason: "catalog_obligation_evidence_unknown" });
});

it.each([
  ["LC5-D-017", "unsupported retained version", "catalog_accepted_reference_mismatch"],
  ["LC5-PRE-L2A-1", "noncanonical retained manifest", "catalog_accepted_reference_mismatch"],
  ["LC5-PRE-L2A-1", "noncanonical retained sku", "catalog_accepted_reference_mismatch"],
  ["LC5-A-026", "extra nested key", "catalog_accepted_reference_invalid"],
  ["LC5-A-026", "bad UUID", "catalog_accepted_reference_invalid"],
  ["LC5-A-026", "wrong quantity scalar", "catalog_accepted_reference_invalid"],
  ["LC5-A-027", "omitted policy", "catalog_accepted_reference_mismatch"],
  ["LC5-A-027", "wrong policy", "catalog_accepted_reference_mismatch"],
] as const)("accepted tuple %s refuses %s at SQL ingress", async (_rule, defect, message) => {
  const f = await seed({ policy: "example:policy@1" }), standing = await standingActive(f);
  const { demandPolicyRef: _policy, ...legacy } = standing.accepted;
  const reference = defect === "unsupported retained version" || defect === "noncanonical retained manifest" || defect === "noncanonical retained sku"
    ? await seedInvalidRetainedSku(standing.accepted, defect)
    : defect === "omitted policy" ? legacy : {
    ...standing.accepted,
    ...(defect === "extra nested key" ? { publicationHead: { ...standing.head, extra: true } } : {}),
    ...(defect === "bad UUID" ? { skuRevisionId: "malformed" } : {}),
    ...(defect === "wrong quantity scalar" ? { netContent: { ...standing.accepted.netContent, scale: "0" } } : {}),
    ...(defect === "wrong policy" ? { demandPolicyRef: "example:policy@2" } : {}),
  };
  expect(await assertCatalogAcceptedReferenceV2(db, standing.accepted)).toEqual(standing.accepted);
  await db.query("SAVEPOINT tuple_ingress");
  await expect(db.query("SELECT public.catalog_accepted_reference_assert_v2($1::jsonb)", [JSON.stringify(reference)]))
    .rejects.toMatchObject({ code: "22023", message });
  await db.query("ROLLBACK TO SAVEPOINT tuple_ingress");
  if (defect === "omitted policy") {
    expect((await publish(withdrawal(f),1,standing.head)).result).toMatchObject({ outcome: "committed" });
    expect(await assertCatalogAcceptedReferenceV2(db, standing.accepted)).toEqual(standing.accepted);
  }
});

it.each([
  ["LC5-D-026", "product withdrawal"],
  ["LC5-D-027", "child withdrawal"],
  ["LC5-D-027", "flag withdrawal"],
  ["LC5-D-028", "price-free withdrawal"],
  ["LC5-D-040", "structural parent restore"],
  ["LC5-D-042", "initial active primary"],
] as const)("readiness and effects %s for %s", async (_rule, path) => {
  const f = await seed();
  if (!("receipt" in f.first.result)) throw new Error("Missing initial receipt");
  const standing = path === "initial active primary" ? null : await standingActive(f, path === "flag withdrawal" || path === "price-free withdrawal");
  if (path === "initial active primary") {
    const payload = structuredClone(f.payload);
    payload.product.sharedContent.catalogAction = "revise";
    payload.publication.operations = [{ op: "set_product_lifecycle", productSlug: "article", expectedState: "draft", state: "active", children: [] }];
    const before = (await db.query("SELECT * FROM public.catalog_publication_heads")).rows;
    expect((await publish(payload, 1, f.first.result.receipt.head)).result).toMatchObject({ reason: "catalog_publication_v3_active_primary_required" });
    expect((await db.query("SELECT * FROM public.catalog_publication_heads")).rows).toEqual(before);
    return;
  }
  if (!standing) throw new Error("Missing active facts");
  if (path === "structural parent restore") {
    const withdrawn = (await publish(withdrawal(f),1,standing.head)).result;
    if (!("receipt" in withdrawn)) throw new Error(JSON.stringify(withdrawn));
    const payload = withdrawal(f);
    payload.publication.operations = [{ op: "restore_product", productSlug: "article", expectedState: "withdrawn" }];
    const calls: boolean[] = [];
    readiness = async price => { calls.push(price); return { ready: true, reasons: [] }; };
    expect((await publish(payload,2,withdrawn.receipt.head)).result).toMatchObject({ outcome: "committed" });
    expect(calls).toEqual([false]);
    expect((await db.query("SELECT publication_facts->>'lifecycleState' AS lifecycle,sellable_standalone,sellable_in_subscription FROM public.catalog_skus WHERE id=$1", [f.sku])).rows)
      .toEqual([{ lifecycle: "withdrawn", sellable_standalone: false, sellable_in_subscription: false }]);
    return;
  }
  const payload = withdrawal(f);
  if (path === "child withdrawal") {
    payload.publication.operations.unshift({ op: "set_sku_lifecycle", skuCode: f.code, expectedState: "active", state: "withdrawn" });
    Object.assign(payload.publication.operations[1]!, { children: [{ skuCode: f.code, expectedState: "withdrawn" }] });
  }
  if (path === "flag withdrawal" || path === "price-free withdrawal") {
    payload.publication.operations = [{ op: "set_eligibility", skuCode: f.code, sellableStandalone: false, sellableInSubscription: false }];
  }
  const current = async () => (await db.query(`SELECT to_jsonb(p)-ARRAY['updated_at','publication_facts'] AS product,
    to_jsonb(s)-ARRAY['updated_at','publication_facts','sellable_standalone','sellable_in_subscription'] AS sku,
    p.updated_at::text AS product_clock,s.updated_at::text AS sku_clock
    FROM public.catalog_products p JOIN public.catalog_skus s ON s.product_id=p.id WHERE s.id=$1`, [f.sku])).rows[0];
  await db.query("UPDATE public.catalog_products SET updated_at=clock_timestamp()-interval '1 day' WHERE id=$1", [f.product]);
  await db.query("UPDATE public.catalog_skus SET updated_at=clock_timestamp()-interval '1 day' WHERE id=$1", [f.sku]);
  const before = await current();
  readiness = async () => { throw new Error("Unrelated offer service unavailable"); };
  expect((await publish(payload,1,standing.head)).result).toMatchObject({ outcome: "committed" });
  const after = await current();
  expect(after.product).toEqual(before.product);
  expect(after.sku).toEqual(before.sku);
  expect(new Date(after.sku_clock).getTime()).toBeGreaterThan(new Date(before.sku_clock).getTime());
  if (path === "product withdrawal") expect(new Date(after.product_clock).getTime()).toBeGreaterThan(new Date(before.product_clock).getTime());
});

it.each(["parent", "child", "flags"] as const)("LC5-PRE-L1A-4 %s withdrawal uses sealed facts without rederiving an unrelated sibling", async path => {
  const f = await seed({ other: true }), standing = await standingActive(f, true, true, true), payload = withdrawal(f);
  payload.publication.operations = path === "parent"
    ? [{ op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "withdrawn",
      children: [{ skuCode: f.code, expectedState: "active" }, { skuCode: "OTHER", expectedState: "active" }] }]
    : path === "child"
      ? [{ op: "set_sku_lifecycle", skuCode: f.code, expectedState: "active", state: "withdrawn" }]
      : [{ op: "set_eligibility", skuCode: f.code, sellableStandalone: false, sellableInSubscription: false }];
  await db.query("UPDATE public.catalog_skus SET updated_at=clock_timestamp()-interval '1 day' WHERE id=$1", [f.sku]);
  const read = async () => (await db.query("SELECT updated_at,sellable_standalone,publication_facts->'facts' AS facts FROM public.catalog_skus WHERE id=$1", [f.sku])).rows[0];
  const before = await read();
  rejectDerivationFor = "OTHER";
  if (path === "child") watchedSkuStatus = f.sku;
  expect((await publish(payload,1,standing.head)).result).toMatchObject({ outcome: "committed" });
  const after = await read();
  expect(after).toMatchObject({ sellable_standalone: false, facts: before.facts });
  expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  if (path === "child") expect(statusClocks).toEqual([true]);
});

it.each([
  ["LC5-D-089", "manifest version"],
  ["LC5-A-006", "product projection"],
  ["LC5-D-015", "duplicate membership"],
  ["LC5-D-014", "sku version"],
  ["LC5-A-003", "live identity"],
  ["LC5-PRE-L1B-2", "legacy envelope with governed product"],
  ["LC5-PRE2-A-2", "legacy envelope with legacy product and governed roster"],
  ["LC5-C3-A2", "missing SKU attributes"],
  ["LC5-C3-B6", "empty shared content"],
  ["LC5-PRE-L1A-3", "noncanonical manifest"],
  ["LC5-PRE-L1B-3", "noncanonical sku"],
  ["LC5-PRE-L1B-3", "scalar option"],
  ["LC5-PRE-L1A-2", "empty logistics"],
  ["LC5-PRE2-A-3", "tabbed membership"],
  ["LC5-PRE2-B-3", "bad GTIN checksum"],
  ["LC5-PRE-L1B-4", "live product projection"],
] as const)("stored authority %s refuses %s", async (_rule, defect) => {
  const f = await seed(), standing = await standingActive(f);
  const publication = (await db.query("SELECT * FROM public.catalog_publications WHERE id=$1", [standing.head.publicationId])).rows[0];
  const facts = JSON.parse((await db.query("SELECT full_facts FROM public.catalog_sku_revisions WHERE id=$1", [standing.accepted.skuRevisionId])).rows[0].full_facts);
  if (defect === "live identity") {
    await db.query("INSERT INTO public.catalog_lifecycle_write_capabilities(transaction_id,product_id,fingerprint) VALUES(pg_current_xact_id(),$1,$2)", [f.product,"b".repeat(64)]);
    await db.query("UPDATE public.catalog_skus SET publication_facts=jsonb_set(publication_facts,'{id}',to_jsonb($2::uuid)) WHERE id=$1", [f.sku,randomUUID()]);
    expect(await obligations(f.sku)).toMatchObject({ outcome: "unknown", reason: "catalog_obligation_evidence_unknown" });
    return;
  }
  if (defect === "live product projection") {
    await db.query("INSERT INTO public.catalog_lifecycle_write_capabilities(transaction_id,product_id,fingerprint) VALUES(pg_current_xact_id(),$1,$2)", [f.product,"b".repeat(64)]);
    await db.query("UPDATE public.catalog_products SET status='draft' WHERE id=$1", [f.product]);
    expect(await obligations(f.sku)).toEqual({ schemaVersion: 2, outcome: "unknown", reason: "catalog_obligation_evidence_unknown" });
    return;
  }
  await db.query("SAVEPOINT authority_mutation");
  if (defect === "manifest version" || defect === "product projection" || defect.startsWith("legacy envelope") || defect === "noncanonical manifest" || defect === "empty shared content") {
    const manifest = JSON.parse(publication.canonical_state);
    if (defect === "manifest version") manifest.product.schemaVersion = 2;
    if (defect === "empty shared content") manifest.product.content = {};
    if (defect === "product projection") manifest.product.status = "draft";
    if (defect.startsWith("legacy envelope")) manifest.schemaVersion = 2;
    if (defect === "legacy envelope with legacy product and governed roster") {
      delete manifest.product.schemaVersion;
      delete manifest.product.lifecycleState;
      delete manifest.product.definitionDigest;
    }
    const text = (defect === "noncanonical manifest" ? " " : "") + canonicalCatalogDraftJson(manifest);
    const insert = db.query(`INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id)
      SELECT $1,product_id,revision+1,id,draft_id,draft_revision,$2,candidate_digest,document_revision_id,$3,$4,actor_id FROM public.catalog_publications WHERE id=$5`,
    [randomUUID(),"synthetic:authority",text,createHash("sha256").update(text).digest("hex"),publication.id]);
    if (defect === "legacy envelope with legacy product and governed roster") {
      await insert;
      await expect(db.query("SET CONSTRAINTS catalog_publications_roster_final IMMEDIATE"))
        .rejects.toMatchObject({ code: "23514", message: "catalog_publication_state_invalid" });
    } else await expect(insert).rejects.toMatchObject({ code: "23514", message: "catalog_publication_state_invalid" });
  } else {
    if (defect === "sku version") facts.schemaVersion = 99;
    if (defect === "missing SKU attributes") delete facts.attributes;
    if (defect === "duplicate membership") facts.memberships = [{ offerVersion: "example:offer@1", admitted: true }, { offerVersion: "example:offer@1", admitted: false }];
    if (defect === "scalar option") facts.options = { finish: "matte" };
    if (defect === "empty logistics") facts.logisticsRef = "";
    if (defect === "tabbed membership") facts.memberships = [{ offerVersion: "\texample:offer@1", admitted: true }];
    if (defect === "bad GTIN checksum") facts.identifiers[0].value = "5901234123458";
    const text = (defect === "noncanonical sku" ? " " : "") + canonicalCatalogDraftJson(facts);
    await expect(db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,3,$4,$5,$6)",
      [randomUUID(),f.sku,f.product,publication.id,text,createHash("sha256").update(text).digest("hex")]))
      .rejects.toMatchObject({ code: "23514", message: "catalog_publication_sku_revision_invalid" });
  }
  await db.query("ROLLBACK TO SAVEPOINT authority_mutation");
  expect(await assertCatalogAcceptedReferenceV2(db, standing.accepted)).toEqual(standing.accepted);
});

it("LC5-PRE2 mixed-version head refuses an already retained predecessor envelope with governed references", async () => {
  const f = await seed(), standing = await standingActive(f), id = randomUUID();
  const original = (await db.query("SELECT canonical_state FROM public.catalog_publications WHERE id=$1",[standing.head.publicationId])).rows[0].canonical_state;
  const manifest = JSON.parse(original);
  manifest.schemaVersion = 2;
  delete manifest.product.schemaVersion;
  delete manifest.product.lifecycleState;
  delete manifest.product.definitionDigest;
  const bytes = canonicalCatalogDraftJson(manifest), digest = createHash("sha256").update(bytes).digest("hex");
  await db.query("SAVEPOINT mixed_head");
  await db.query(`INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id)
    SELECT $1,product_id,revision+1,id,draft_id,draft_revision,$2,candidate_digest,document_revision_id,$3,$4,actor_id
    FROM public.catalog_publications WHERE id=$5`,[id,`synthetic:${id}`,bytes,digest,standing.head.publicationId]);
  await db.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=3 WHERE product_id=$1",[f.product,id]);
  await expect(db.query("SET CONSTRAINTS catalog_publication_heads_lifecycle_admit IMMEDIATE"))
    .rejects.toMatchObject({ code: "23514", message: "catalog_publication_state_invalid" });
  await db.query("ROLLBACK TO SAVEPOINT mixed_head");
  expect(await authority.reads.current(f.product)).toMatchObject({ outcome: "found",head: standing.head });
});

it.each([
  "v2 early head", "v3 late head and reuse", "missing at publication", "missing at head", "mixed early", "mixed late never head",
] as const)("LC5-C3 stored roster commits the complete dialect: %s", async path => {
  const f = await seed(), standing = await standingActive(f);
  const previous = standing.head.publicationId, pending = randomUUID();
  const prior = (await db.query("SELECT canonical_state FROM public.catalog_publications WHERE id=$1", [previous])).rows[0].canonical_state;
  const original = JSON.parse(prior);
  const priorFacts = JSON.parse((await db.query("SELECT full_facts FROM public.catalog_sku_revisions WHERE id=$1", [standing.accepted.skuRevisionId])).rows[0].full_facts);
  async function emit(publicationId: string, predecessor: string, version: 2 | 3, reference: unknown) {
    const manifest = structuredClone(original);
    manifest.schemaVersion = version;
    if (version === 2) for (const field of ["schemaVersion","lifecycleState","definitionDigest"]) delete manifest.product[field];
    manifest.skus = [reference];
    const wire = canonicalCatalogDraftJson(manifest);
    await db.query(`INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id)
      SELECT $1,product_id,revision+1,id,draft_id,draft_revision,$2,candidate_digest,document_revision_id,$3,$4,actor_id
      FROM public.catalog_publications WHERE id=$5`, [publicationId,`example:${publicationId}`,wire,createHash("sha256").update(wire).digest("hex"),predecessor]);
  }
  const facts = structuredClone(priorFacts);
  if (path === "v2 early head") for (const field of ["schemaVersion","lifecycleState","optionDigest"]) delete facts[field];
  const wire = canonicalCatalogDraftJson(facts);
  const reference = { skuId: f.sku, revisionId: randomUUID(), revision: 3, digest: createHash("sha256").update(wire).digest("hex") };
  const head = { ...standing.head, publicationId: pending, revision: 3 };
  const setHead = async (id: string, revision: number) => {
    await db.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=$3 WHERE product_id=$1", [f.product,id,revision]);
  };
  const addRevision = async (publication: string) => {
    await db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,3,$4,$5,$6)",
      [reference.revisionId,f.sku,f.product,publication,wire,reference.digest]);
  };

  await db.query("SAVEPOINT final_roster");
  if (path === "v2 early head") {
    await emit(pending,previous,2,reference);
    await setHead(pending,3);
    await addRevision(pending);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    expect(await authority.readbackV2(head)).toMatchObject({ outcome: "page", items: [{ facts, reference }] });
    expect(await authority.reads.readback(head)).toMatchObject({ outcome: "found", head });
  } else if (path === "v3 late head and reuse") {
    await emit(pending,previous,3,reference);
    await addRevision(pending);
    await setHead(pending,3);
    const next = randomUUID();
    await emit(next,pending,3,reference);
    await setHead(next,4);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    expect(await authority.readbackV3({ ...head, publicationId: next, revision: 4 }))
      .toMatchObject({ outcome: "page", items: [{ facts, reference }] });
    expect(await authority.reads.readback(head)).toMatchObject({ outcome: "found", head });
  } else {
    if (path === "mixed early") await emit(pending,previous,2,original.skus[0]);
    else if (path === "mixed late never head") {
      await emit(pending,previous,2,reference);
      const later = randomUUID();
      await emit(later,pending,3,reference);
      await addRevision(later);
      await setHead(later,4);
    } else {
      await emit(pending,previous,3,reference);
      if (path === "missing at head") await setHead(pending,3);
    }
    const trigger = path === "missing at head" ? "catalog_publication_heads_lifecycle_admit" : "catalog_publications_roster_final";
    await expect(db.query(`SET CONSTRAINTS ${trigger} IMMEDIATE`)).rejects.toMatchObject({ code: "23514",
      message: path.startsWith("mixed") ? "catalog_publication_state_invalid" : "catalog_publication_sku_revision_invalid" });
    await db.query("ROLLBACK TO SAVEPOINT final_roster");
    expect((await db.query("SELECT id FROM public.catalog_publications WHERE id=$1", [pending])).rows).toEqual([]);
    expect(await authority.reads.current(f.product)).toMatchObject({ outcome: "found", head: standing.head });
  }
});

it.each([null,"example:warehouse",17] as const)("LC5-C3 draft metadata SQL and codec agree on %j", async logisticsRef => {
  const { payload } = input();
  payload.publication.operations.push({ op: "set_sku_metadata", skuCode: "ARTICLE", logisticsRef: logisticsRef as string | null });
  const command = { schemaVersion: 4, action: "create", draftId, commandKey: "draft:metadata-wire", expectedRevision: 0, payload };
  const valid = typeof logisticsRef !== "number", wire = canonicalCatalogDraftJson(command), digest = createHash("sha256").update(wire).digest("hex");
  const apply = async () => (await db.query("SELECT public.catalog_draft_apply($1,$2,'operator:synthetic') AS result", [wire,digest])).rows[0].result;
  expect(catalogDraftCommandV4Schema.safeParse(command).success).toBe(valid);
  expect(await apply()).toMatchObject({ outcome: valid ? "committed" : "validation_issue" });
  expect(await apply()).toMatchObject({ outcome: valid ? "replayed" : "validation_issue" });
  const state = (await db.query(`SELECT
    (SELECT count(*) FROM public.catalog_draft_heads WHERE draft_id=$1) AS head,
    (SELECT count(*) FROM public.catalog_draft_sku_reservations WHERE draft_id=$1) AS reservations,
    (SELECT count(*) FROM public.catalog_draft_command_receipts WHERE draft_id=$1) AS receipts`, [draftId])).rows[0];
  expect(state).toEqual(valid ? { head: "1", reservations: "1", receipts: "1" } : { head: "0", reservations: "0", receipts: "0" });
});

it.each([
  { z: 1e+21, a: 1e-7, b: 1e-6, c: 1e20, d: 1000000000000000100 },
  { "4294967295": false, "4294967294": true, "10": null, "2": [1, { key: "\tvalue" }] },
  { "\uffff": "BMP", "𐀀": "astral", "🙂": "supplementary", x: false },
])("LC5-PRE canonical stored authority matches the catalogue writer for %j", async value => {
  const text = canonicalCatalogDraftJson(value);
  await db.query("SET LOCAL extra_float_digits=0");
  expect((await db.query("SELECT public.catalog_lifecycle_canonical_v3($1::jsonb,false,0) AS bytes", [text])).rows).toEqual([{ bytes: text }]);
  expect((await db.query("SHOW extra_float_digits")).rows).toEqual([{ extra_float_digits: "0" }]);
});

it.each(["missing SKU attributes", "empty logistics", "scalar option", "noncanonical sibling", "tabbed membership", "bad GTIN checksum", "UTF-16 memberships", "UTF-8-only memberships"] as const)(
  "LC5-PRE shared authority and codecs agree on %s on R3, R4, A1 and O", async fault => {
  const f = await seed({ other: true }), standing = await standingActive(f);
  const stored = (await db.query("SELECT * FROM public.catalog_publications WHERE id=$1", [standing.head.publicationId])).rows[0];
  const manifest = JSON.parse(stored.canonical_state), [bad, good] = manifest.skus;
  const facts = JSON.parse((await db.query("SELECT full_facts FROM public.catalog_sku_revisions WHERE id=$1", [bad.revisionId])).rows[0].full_facts);
  const goodFacts = JSON.parse((await db.query("SELECT full_facts FROM public.catalog_sku_revisions WHERE id=$1", [good.revisionId])).rows[0].full_facts);
  if (fault === "missing SKU attributes") delete facts.attributes;
  if (fault === "empty logistics") facts.logisticsRef = "";
  if (fault === "scalar option") facts.options = { finish: "matte" };
  if (fault === "tabbed membership") facts.memberships = [{ offerVersion: "\texample:offer@1", admitted: true }];
  if (fault === "bad GTIN checksum") facts.identifiers[0].value = String(facts.identifiers[0].value).slice(0,-1) + "0";
  const admissible = fault === "UTF-16 memberships";
  if (admissible || fault === "UTF-8-only memberships") facts.memberships = (admissible ? ["𐀀", "\uE000"] : ["\uE000", "𐀀"])
    .map(offerVersion => ({ offerVersion, admitted: false }));
  const text = (fault === "noncanonical sibling" ? " " : "") + canonicalCatalogDraftJson(facts);
  const output = randomUUID(), revision = randomUUID(), digest = createHash("sha256").update(text).digest("hex");
  Object.assign(bad, { revisionId: revision, revision: 3, digest });
  const canonical = canonicalCatalogDraftJson(manifest);
  await db.query(`INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id)
    SELECT $1,product_id,revision+1,id,draft_id,draft_revision,$2,candidate_digest,document_revision_id,$3,$4,actor_id
    FROM public.catalog_publications WHERE id=$5`, [output,`example:${output}`,canonical,createHash("sha256").update(canonical).digest("hex"),stored.id]);
  // A persisted bad sibling isolates the downstream guards from write admission.
  if (!admissible) await db.query("ALTER TABLE public.catalog_sku_revisions DISABLE TRIGGER catalog_sku_revisions_record_admit");
  await db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,3,$4,$5,$6)",
    [revision,bad.skuId,f.product,output,text,digest]);
  if (!admissible) await db.query("ALTER TABLE public.catalog_sku_revisions ENABLE TRIGGER catalog_sku_revisions_record_admit");
  const head = { ...standing.head, publicationId: output, revision: 3 };
  const cursor = Buffer.from(canonicalCatalogDraftJson({ schemaVersion: 1, kind: "facts", productId: f.product, highWater: 3, before: 1 })).toString("base64url");
  const refusal = { outcome: "dependency_unavailable", reason: "catalog_publication_sku_revision_invalid" };
  if (admissible) {
    const page = await authority.readbackV3(head);
    expect(page).toMatchObject({ outcome: "page", items: [{ facts: { memberships: facts.memberships } }, expect.anything()] });
    return;
  }
  expect.soft(await authority.readbackV3(head,cursor)).toEqual(refusal);
  acceptsRetainedRead = true;
  const scope = authority.authorizeReadScope(null);
  expect.soft(await authority.resolveRetained({ kind: "order", sourceId: randomUUID(), lineId: randomUUID(), productId: f.product,
    skuId: good.skuId, skuRevisionId: good.revisionId, publicationId: output, documentRevisionId: stored.document_revision_id },scope)).toEqual(refusal);
  const tuple = { ...standing.accepted, publicationHead: head, skuId: good.skuId, skuCode: goodFacts.code, skuRevisionId: good.revisionId, optionDigest: goodFacts.optionDigest };
  await db.query("SAVEPOINT invalid_sibling");
  await expect.soft(db.query("SELECT public.catalog_accepted_reference_assert_v2($1::jsonb)", [JSON.stringify(tuple)]))
    .rejects.toMatchObject({ code: "22023", message: "catalog_accepted_reference_mismatch" });
  await db.query("ROLLBACK TO SAVEPOINT invalid_sibling");
  // Read a deliberately bad pre-guard row through the live-head boundary.
  // Clear the valid fixture's deferred head events before disabling its guard.
  await db.query("SET CONSTRAINTS catalog_publication_heads_lifecycle_admit IMMEDIATE");
  await db.query("ALTER TABLE public.catalog_publication_heads DISABLE TRIGGER catalog_publication_heads_lifecycle_admit");
  await db.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=3 WHERE product_id=$1", [f.product,output]);
  await db.query("ALTER TABLE public.catalog_publication_heads ENABLE TRIGGER catalog_publication_heads_lifecycle_admit");
  expect.soft(await obligations(good.skuId)).toMatchObject({ outcome: "unknown", reason: "catalog_obligation_evidence_unknown" });
});

it.each([
  ["LC5-D-018", "late prefix"],
  ["LC5-D-043", "missing presentation"],
  ["LC5-D-054", "restoration presentation"],
  ["LC5-A-004", "complete child roster"],
  ["LC5-A-004", "reversed child prefix"],
] as const)("publisher proof %s for %s", async (_rule, path) => {
  const f = await seed({ other: path.includes("child") });
  const standing = await standingActive(f, path === "missing presentation", !path.includes("presentation"));
  const payload = withdrawal(f);
  if (path === "missing presentation") {
    payload.skus[0]!.grossMass = { ...payload.skus[0]!.netContent!, unscaled: "110" };
    payload.publication.kind = "compensation";
    payload.publication.operations = [{ op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "active", children: [] }];
    expect((await publish(payload,1,standing.head)).result).toMatchObject({ reason: "catalog_publication_v3_presentation_required" });
    return;
  }
  if (path.includes("child")) {
    const effect = payload.publication.operations[0]!;
    if (effect.op !== "set_product_lifecycle") throw new Error("Missing withdrawal operation");
    effect.children.push({ skuCode: "OTHER", expectedState: "draft" });
    if (path === "reversed child prefix") payload.publication.operations.push({
      op: "set_sku_lifecycle", skuCode: f.code, expectedState: "active", state: "withdrawn",
    });
  }
  if (path === "late prefix") payload.publication.operations.push({
    op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "withdrawn", children: [],
  });
  const read = () => db.query("SELECT publication_id,revision FROM public.catalog_publication_heads WHERE product_id=$1", [f.product]).then(result => result.rows);
  const before = await read();
  const first = await publish(payload,1,standing.head);
  if (path === "late prefix" || path === "reversed child prefix") {
    expect(first.result).toMatchObject({ reason: "catalog_lifecycle_state_conflict" });
    expect(await read()).toEqual(before);
    return;
  }
  if (!("receipt" in first.result)) throw new Error(JSON.stringify(first.result));
  if (path === "complete child roster") {
    expect((await db.query("SELECT sku,publication_facts->>'lifecycleState' AS state FROM public.catalog_skus ORDER BY sku")).rows)
      .toEqual([{ sku: f.code, state: "withdrawn" }, { sku: "OTHER", state: "draft" }]);
    return;
  }
  payload.publication.operations = [{ op: "restore_product", productSlug: "article", expectedState: "withdrawn" }];
  expect((await publish(payload,2,first.result.receipt.head)).result).toMatchObject({ reason: "catalog_publication_v3_presentation_required" });
  expect(await read()).toEqual([{ publication_id: first.result.receipt.head.publicationId, revision: first.result.receipt.head.revision }]);
});

function authoredEnablement(payload: CatalogDraftPayloadV4, code: string) {
  const sku = payload.skus.find(sku => sku.code === code)!;
  sku.grossMass = { ...sku.netContent!, unscaled: "110" };
  sku.logisticsRef = "example:parcel";
  payload.product.sharedContent.requestedModes.find(row => row.skuCode === code)!.modes = ["one_time"];
  payload.product.sharedContent.offerMemberships = [{ skuCode: code, offerVersion: "example:offer@1", admitted: true }];
  return [
    { op: "set_sku_metadata", skuCode: code, logisticsRef: "example:parcel" },
    { op: "set_offer_membership", skuCode: code, offerVersion: "example:offer@1", admitted: true },
    { op: "set_eligibility", skuCode: code, sellableStandalone: true, sellableInSubscription: false },
  ] as const;
}

async function seedSalePrices(skuId: string) {
  await db.query(`INSERT INTO public.commerce_settings(key,value_text)
    VALUES('settlement_region','ZZ'),('settlement_currency','XXX')
    ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text`);
  const list = (await db.query(`INSERT INTO public.price_lists(name,region_code,currency,status,created_at,valid_from,valid_to)
    VALUES('Effective list','ZZ','XXX','active',statement_timestamp()-interval '1 day',statement_timestamp()-interval '1 hour',statement_timestamp()+interval '1 day')
    RETURNING id`)).rows[0].id as string;
  const entries = (await db.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    VALUES($1,$2,'one_time',617,statement_timestamp()-interval '1 hour'),
      ($1,$2,'subscription',543,statement_timestamp()-interval '1 hour') RETURNING id,mode`, [list, skuId])).rows;
  return { list, base: entries.find(row => row.mode === "one_time")!.id as string,
    subscription: entries.find(row => row.mode === "subscription")!.id as string };
}

const salePriceCases = ["valid with newer future list", "newer non-effective list only", "newer expired list only",
  "newer list in another region", "newer list in another currency", "newer inactive list only", "newer effective list wins", "larger list ID on tied creation time",
  "zero base rows", "two base rows", "non-positive base", "net base", "missing subscription price",
  "two subscription prices", "non-positive subscription price", "policy owns subscription price", "any-mode override", "quantity tier", "future base row", "expired subscription price"] as const;
it.each(
  (["EL", "PA", "PR", "SA", "SR"] as const).flatMap(path => salePriceCases.map(price => ({ path, price }))),
)("LC5-D-051/052/053 price owner checks $price through $path", async ({ path, price }) => {
  const sibling = path === "EL" || path === "SA" || path === "SR";
  const f = await seed({ other: sibling, gross: true });
  const standing = await standingActive(f, false, true, path === "EL" || path === "SR");
  const sku = f.payload.skus[sibling ? 1 : 0]!, code = sku.code!;
  const prices = await seedSalePrices(sku.id);
  const payload = withdrawal(f);
  let head: CatalogHeadRef = standing.head, revision = 1;
  const advance = async () => {
    const result = (await publish(payload,revision++,head)).result;
    if (!("receipt" in result)) throw new Error(JSON.stringify(result));
    head = result.receipt.head;
  };
  if (path === "PR") await advance();
  if (path === "SR") {
    payload.publication.operations = [{ op: "set_sku_lifecycle", skuCode: code, expectedState: "active", state: "withdrawn" }];
    await advance();
  }
  const enable = authoredEnablement(payload, code);
  if (path === "PA") {
    // Establish a selling child first so the parent command carries no enabling operation.
    payload.publication.operations = [...enable];
    await advance();
    payload.publication.kind = "compensation";
  }
  const operation: CatalogDraftPayloadV4["publication"]["operations"][number] = path === "EL"
    ? { op: "set_sku_lifecycle", skuCode: code, expectedState: "active", state: "withdrawn" }
    : path === "PA" ? { op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "active", children: [] }
    : path === "PR" ? { op: "restore_product", productSlug: "article", expectedState: "withdrawn" }
    : path === "SA" ? { op: "set_sku_lifecycle", skuCode: code, expectedState: "draft", state: "active" }
    : { op: "restore_sku", skuCode: code, expectedState: "withdrawn" };
  payload.publication.operations = [...(path === "PA" ? [] : enable), operation];
  if (path === "PR") payload.publication.operations.push({ op: "restore_sku", skuCode: code, expectedState: "withdrawn" });
  if (price === "valid with newer future list" || price === "newer non-effective list only") {
    const future = (await db.query(`INSERT INTO public.price_lists(name,region_code,currency,status,valid_from)
      VALUES('Future list','ZZ','XXX','active',statement_timestamp()+interval '1 day') RETURNING id`)).rows[0].id;
    if (price === "newer non-effective list only") {
      await db.query("UPDATE public.price_entries SET price_list_id=$1 WHERE price_list_id=$2", [future,prices.list]);
    } else {
      const result = await db.query(`SELECT public.catalog_price_setup_sale_ready($1,$2) AS consulted,
        public.catalog_price_setup_sale_ready($1,$3) AS future`, [sku.id,prices.list,future]);
      expect(result.rows).toEqual([{ consulted: true, future: false }]);
    }
  } else if (price === "newer expired list only" || price === "newer list in another region" || price === "newer list in another currency" || price === "newer inactive list only") {
    const outside = (await db.query(`INSERT INTO public.price_lists(name,region_code,currency,status,valid_from,valid_to)
      VALUES('List outside the active selection',$1,$2,$4,statement_timestamp()-interval '2 hours',
        CASE WHEN $3::boolean THEN statement_timestamp()-interval '1 hour' END) RETURNING id`,
    [price === "newer list in another region" ? "ZY" : "ZZ",price === "newer list in another currency" ? "XYY" : "XXX",price === "newer expired list only",price === "newer inactive list only" ? "draft" : "active"])).rows[0].id;
    await db.query("UPDATE public.price_entries SET price_list_id=$1 WHERE price_list_id=$2",[outside,prices.list]);
  } else if (price === "newer effective list wins" || price === "larger list ID on tied creation time") {
    const tied = price === "larger list ID on tied creation time";
    await db.query(`INSERT INTO public.price_lists(id,name,region_code,currency,status,created_at,valid_from,valid_to)
      SELECT $2,'Competing list',region_code,currency,status,CASE WHEN $3::boolean THEN created_at ELSE statement_timestamp() END,valid_from,valid_to
      FROM public.price_lists WHERE id=$1`,[prices.list,tied ? "ffffffff-ffff-ffff-ffff-ffffffffffff" : "00000000-0000-0000-0000-000000000001",tied]);
  } else if (price === "zero base rows" || price === "missing subscription price") {
    await db.query("UPDATE public.price_entries SET active=false WHERE id=$1",[price === "zero base rows" ? prices.base : prices.subscription]);
  } else if (price === "two base rows" || price === "two subscription prices") {
    await db.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from,amount_kind)
      SELECT price_list_id,variant_id,mode,unit_price_minor,valid_from,amount_kind FROM public.price_entries WHERE id=$1`,
    [price === "two base rows" ? prices.base : prices.subscription]);
  } else if (price === "non-positive base" || price === "non-positive subscription price") {
    await db.query("UPDATE public.price_entries SET unit_price_minor=0 WHERE id=$1",[price === "non-positive base" ? prices.base : prices.subscription]);
  } else if (price === "future base row") {
    await db.query("UPDATE public.price_entries SET valid_from=statement_timestamp()+interval '1 day' WHERE id=$1",[prices.base]);
  } else if (price === "expired subscription price") {
    await db.query("UPDATE public.price_entries SET valid_to=statement_timestamp()-interval '30 minutes' WHERE id=$1",[prices.subscription]);
  } else if (price === "any-mode override" || price === "quantity tier") {
    await db.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,min_qty,unit_price_minor,valid_from)
      SELECT price_list_id,variant_id,$2,$3,unit_price_minor,valid_from FROM public.price_entries WHERE id=$1`,
    [prices.base,price === "any-mode override" ? "any" : "one_time",price === "quantity tier" ? 2 : 1]);
  } else if (price === "policy owns subscription price") {
    await db.query(`INSERT INTO public.subscription_price_policy_revisions
      (id,revision_no,price_list_id,region_code,currency,channel,effective_from,discount_bps,rounding_quantum_minor,rounding_rule,digest)
      SELECT id,1,$1,'ZZ','XXX','D2C',at,1000,10,'FLOOR_TO_QUANTUM',
        public.catalog_price_setup_policy_digest(id,1,$1,'ZZ','XXX','D2C',at,NULL,1000,10,'FLOOR_TO_QUANTUM')
      FROM (SELECT gen_random_uuid() AS id,date_trunc('milliseconds',statement_timestamp()-interval '1 hour') AS at) evidence`, [prices.list]);
  } else {
    await db.query("UPDATE public.price_entries SET amount_kind='net' WHERE id=$1",[prices.base]);
  }
  const commercial: string[] = [];
  readiness = async (priced, skus) => {
    if (priced) commercial.push(...skus.map(sku => sku.code));
    return { ready: true, reasons: [] };
  };
  const { result } = await publish(payload,revision,head);
  expect(commercial).toEqual([code]);
  if (price === "valid with newer future list") {
    expect(result).toMatchObject({ outcome: "committed" });
  } else {
    expect(result).toMatchObject({ outcome: "validation_issue", reason: "catalog_publication_v3_activation_readiness_failed" });
    expect((await db.query("SELECT publication_id FROM public.catalog_publication_heads WHERE product_id=$1",[f.product])).rows)
      .toEqual([{ publication_id: head.publicationId }]);
  }
});

it.each([
  ["LC5-D-013", "enable first"],
  ["LC5-D-012", "restore first"],
  ["LC5-D-055", "closed source"],
  ["LC5-D-042", "wrong primary"],
] as const)("native restoration %s with %s", async (_rule, mode) => {
  const f = await seed({ other: mode === "wrong primary" }), standing = await standingActive(f);
  const payload = withdrawal(f);
  if (mode === "wrong primary") {
    const operation = payload.publication.operations[0]!;
    if (operation.op !== "set_product_lifecycle") throw new Error("Missing parent withdrawal");
    operation.children.push({ skuCode: "OTHER", expectedState: "draft" });
  }
  const withdrawn = (await publish(payload,1,standing.head)).result;
  if (!("receipt" in withdrawn)) throw new Error(JSON.stringify(withdrawn));
  const code = mode === "wrong primary" ? "OTHER" : f.code, enabling = authoredEnablement(payload, code);
  const restore = mode === "wrong primary"
    ? { op: "set_sku_lifecycle", skuCode: code, expectedState: "draft", state: "active" } as const
    : { op: "restore_sku", skuCode: code, expectedState: "withdrawn" } as const;
  payload.publication.operations = [
    { op: "restore_product", productSlug: "article", expectedState: "withdrawn" },
    ...(mode === "restore first" ? [restore, ...enabling] : [...enabling, restore]),
  ];
  if (mode !== "closed source") await seedSalePrices(payload.skus.find(sku => sku.code === code)!.id);
  staleAuthoredSource = mode === "closed source";
  const result = (await publish(payload,2,withdrawn.receipt.head)).result;
  if (mode === "wrong primary" || mode === "closed source") {
    expect(result).toMatchObject({ reason: mode === "wrong primary"
      ? "catalog_publication_v3_active_primary_required" : "catalog_publication_draft_advanced" });
    expect((await db.query("SELECT publication_id FROM public.catalog_publication_heads WHERE product_id=$1", [f.product])).rows)
      .toEqual([{ publication_id: withdrawn.receipt.head.publicationId }]);
  } else {
    expect(result).toMatchObject({ outcome: "committed" });
    expect((await db.query("SELECT status,sellable_standalone FROM public.catalog_skus WHERE id=$1", [f.sku])).rows)
      .toEqual([{ status: "active", sellable_standalone: true }]);
  }
});

it.each((["parent", "activation", "restore", "eligibility", "parent restore"] as const).flatMap(path =>
  (["no membership", "enable then clear", "missing authored gross"] as const)
    .filter(defect => path !== "parent restore" || defect === "missing authored gross").map(defect => ({ path, defect })),
))("LC5-PRE readiness carries $defect through $path", async ({ path, defect }) => {
  const clearsLater = defect === "enable then clear";
  const other = path === "activation" || path === "restore" || clearsLater;
  const f = await seed({ other, gross: true });
  const standing = await standingActive(f, clearsLater && path === "parent", true, path === "restore" || clearsLater && path !== "activation");
  let head: CatalogHeadRef = standing.head, draftRevision = 1;
  const code = other ? "OTHER" : f.code, payload = withdrawal(f);
  if (path === "restore") {
    payload.publication.operations = [{ op: "set_sku_lifecycle", skuCode: code, expectedState: "active", state: "withdrawn" }];
    const result = (await publish(payload,draftRevision++,head)).result;
    if (!("receipt" in result)) throw new Error(JSON.stringify(result));
    head = result.receipt.head;
  }
  if (path === "parent restore") {
    const result = (await publish(payload,draftRevision++,head)).result;
    if (!("receipt" in result)) throw new Error(JSON.stringify(result));
    head = result.receipt.head;
  }
  const enablement = authoredEnablement(payload, code);
  if (defect === "no membership") payload.product.sharedContent.offerMemberships = [];
  if (defect === "missing authored gross") delete payload.skus.find(sku => sku.code === code)!.grossMass;
  const lifecycle: CatalogDraftPayloadV4["publication"]["operations"] = path === "parent"
    ? [{ op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "active", children: [] }]
    : path === "activation" ? [{ op: "set_sku_lifecycle", skuCode: code, expectedState: "draft", state: "active" }]
      : path === "restore" ? [{ op: "restore_sku", skuCode: code, expectedState: "withdrawn" }]
        : path === "parent restore" ? [
          { op: "restore_product", productSlug: "article", expectedState: "withdrawn" },
          { op: "restore_sku", skuCode: code, expectedState: "withdrawn" },
        ] : [];
  payload.publication.operations = [...enablement.filter(op => defect !== "no membership" || op.op !== "set_offer_membership"), ...lifecycle];
  if (clearsLater) {
    // A lifecycle effect can clear the flags without contradicting authored eligibility.
    payload.publication.operations.push({ op: "set_sku_lifecycle", skuCode: code, expectedState: "active", state: "withdrawn" });
  }
  const priced: string[] = [];
  if (defect === "no membership") await seedSalePrices(payload.skus.find(sku => sku.code === code)!.id);
  if (other && defect === "no membership") watchedSkuStatus = f.payload.skus[1]!.id;
  readiness = async (requirePrice, skus) => {
    if (requirePrice) priced.push(...skus.filter(sku => sku.sellableStandalone || sku.sellableInSubscription).map(sku => sku.code));
    const ready = !clearsLater || !priced.includes(code);
    return { ready, reasons: ready ? [] : ["price_evidence_unavailable"] };
  };
  const result = (await publish(payload,draftRevision,head)).result;
  if (defect === "no membership") {
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "committed" });
    expect(priced).toEqual([code]);
    if (other) expect(statusClocks).toEqual([true]);
  } else if (defect === "enable then clear") {
    expect(result, JSON.stringify(result)).toMatchObject({ reason: "catalog_publication_v3_activation_readiness_failed" });
    expect(priced).toEqual([code]);
  } else {
    expect(result, JSON.stringify(result)).toMatchObject({ reason: "catalog_publication_gross_mass_required" });
    expect(priced).toEqual([]);
  }
});

it.each(["activation", "restore"] as const)("LC5-PRE-L1A-5 structural readiness sees the dark sibling during parent %s", async mode => {
  const f = await seed({ other: true, gross: true }), standing = await standingActive(f), payload = withdrawal(f);
  let head: CatalogHeadRef = standing.head, revision = 1;
  if (mode === "restore") {
    const op = payload.publication.operations[0]!;
    if (op.op !== "set_product_lifecycle") throw new Error("Missing parent withdrawal");
    op.children.push({ skuCode: "OTHER", expectedState: "draft" });
    const result = (await publish(payload,revision++,head)).result;
    if (!("receipt" in result)) throw new Error(JSON.stringify(result));
    head = result.receipt.head;
  }
  payload.publication.operations = [
    mode === "activation" ? { op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "active", children: [] }
      : { op: "restore_product", productSlug: "article", expectedState: "withdrawn" },
    ...authoredEnablement(payload, f.code),
    ...(mode === "restore" ? [{ op: "restore_sku", skuCode: f.code, expectedState: "withdrawn" } as const] : []),
  ];
  const seen: string[] = [];
  readiness = async (price, skus) => {
    if (!price) seen.push(...skus.map(sku => sku.code));
    const ready = !seen.includes("OTHER");
    return { ready, reasons: ready ? [] : ["dark_child_structure_invalid"] };
  };
  expect((await publish(payload,revision,head)).result).toMatchObject({ reason: "catalog_publication_v3_activation_readiness_failed" });
  expect(seen).toContain("OTHER");
});

it("LC5-PRE-L1A-8 parent activation checks the authored source of an already-selling SKU with excluded offers", async () => {
  const f = await seed({ gross: true }), standing = await standingActive(f, true), payload = withdrawal(f);
  payload.publication.kind = "compensation";
  payload.publication.operations = [{ op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "active", children: [] }];
  staleAuthoredSource = true;
  expect((await publish(payload,1,standing.head)).result).toMatchObject({ reason: "catalog_publication_draft_advanced" });
});

it.each([
  ["LC5-D-041", "ending in withdrawal"],
  ["LC5-D-044", "explicit enablement"],
  ["LC5-D-044", "no explicit enablement"],
] as const)("readiness %s for activation %s", async (_rule, mode) => {
  const f = await seed({ gross: mode === "no explicit enablement" }), standing = await standingActive(f, mode === "no explicit enablement"), payload = withdrawal(f);
  if (mode !== "ending in withdrawal") payload.publication.operations = [
    { op: "set_product_lifecycle", productSlug: "article", expectedState: "active", state: "active", children: [] },
  ];
  if (mode === "no explicit enablement") {
    payload.publication.kind = "compensation";
    globalReadiness = async () => { throw new Error("Unrelated global offer gate"); };
    expect((await publish(payload,1,standing.head)).result).toMatchObject({ outcome: "committed" });
    return;
  }
  payload.publication.operations.unshift(...authoredEnablement(payload, f.code));
  if (mode === "explicit enablement") await seedSalePrices(f.sku);
  let commercial = 0, global = 0;
  readiness = async price => {
    if (price) commercial += 1;
    const ready = !price || mode !== "ending in withdrawal";
    return { ready, reasons: ready ? [] : ["price_evidence_unavailable"] };
  };
  globalReadiness = async () => { global += 1; return { ready: false, reasons: ["offer_evidence_unavailable"] }; };
  expect((await publish(payload,1,standing.head)).result).toMatchObject({ reason: "catalog_publication_v3_activation_readiness_failed" });
  expect(commercial).toBe(1);
  expect(global).toBe(mode === "explicit enablement" ? 1 : 0);
  expect((await db.query("SELECT status,sellable_standalone FROM public.catalog_skus WHERE id=$1", [f.sku])).rows).toEqual([{ status: "active", sellable_standalone: false }]);
});

it("LC5-D-067 a late projection mismatch never appends a publication, receipt or outbox event", async () => {
  const f = await seed(), standing = await standingActive(f);
  const read = () => db.query(`SELECT (SELECT jsonb_agg(to_jsonb(s)) FROM public.catalog_skus s) AS sku,
    (SELECT jsonb_agg(to_jsonb(h)) FROM public.catalog_publication_heads h) AS heads,
    (SELECT count(*) FROM public.catalog_publications) AS publications,
    (SELECT count(*) FROM public.catalog_operator_receipts WHERE kind='publish') AS receipts,
    (SELECT count(*) FROM public.outbox_events) AS events`).then(result => result.rows);
  const before = await read();
  await db.query("CREATE FUNCTION public.lifecycle_test_projection_mismatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.title:='Different synthetic title'; RETURN NEW; END; $$");
  await db.query("CREATE TRIGGER lifecycle_test_projection_mismatch BEFORE UPDATE OF publication_facts ON public.catalog_skus FOR EACH ROW EXECUTE FUNCTION public.lifecycle_test_projection_mismatch()");
  expect((await publish(withdrawal(f),1,standing.head)).result).toMatchObject({ reason: "catalog_publication_post_state_mismatch" });
  expect(await read()).toEqual(before);
});

it("LC5-A-028 native freezes persist exact accepted lines and replay after reconnect", async () => {
  const f = await seed(), standing = await standingActive(f), cycle = randomUUID(), orderId = randomUUID();
  const retained = await appendLegacyAcceptedSku(f,standing.accepted);
  f.sku = retained.skuId;
  f.code = retained.skuCode;
  await db.query("UPDATE public.subscriptions SET started_at=clock_timestamp()-interval '28 days',next_cycle_at=date_trunc('milliseconds',clock_timestamp())-interval '1 second' WHERE id=$1", [f.subscription]);
  await db.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) SELECT $1,id,started_at,'paid' FROM public.subscriptions WHERE id=$2", [cycle,f.subscription]);
  await db.query("WITH o AS (INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,status,currency_code,total_amount_minor) VALUES($1,$2,$3,'paid','XXX',1851) RETURNING id) INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) SELECT id,$4,1,3,617,1851 FROM o", [orderId,f.client,cycle,f.sku]);
  await db.query("INSERT INTO public.subscription_activations(order_id,client_id,subscription_id,cadence_days,state,payment_fingerprint,activation_idempotency_key,declare_idempotency_key,activated_at) VALUES($1,$2,$3,28,'active',$4,$5,$6,clock_timestamp())", [orderId,f.client,f.subscription,"a".repeat(64),`active:${orderId}`,`declare:${orderId}`]);
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,3,0,617,'XXX')", [f.subscription,f.sku]);
  const acceptance = { schemaVersion: 2, lines: [retained] };
  await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref,catalog_acceptance) VALUES($1,'XXX','synthetic','sandbox',clock_timestamp(),'synthetic',$2::jsonb)", [f.subscription,JSON.stringify(acceptance)]);
  await db.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,2147483647,$2,3,617)", [f.subscription,f.code]);
  const preparationTerms = graduationFacts(1,f.code);
  preparationTerms.renewalTerms.starterPack.delivery2 = { discountBps: 500, discountMinor: 100, basisSubtotalMinor: 1851 };
  await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3::jsonb,clock_timestamp())",
    [orderId,f.subscription,JSON.stringify({ templateId: "synthetic", shippingAmountMinor: 149, acquisitionRef: null, ...preparationTerms })]);
  const destination = randomUUID();
  await db.query("INSERT INTO public.commerce_destinations(id,client_id,address) VALUES($1,$2,$3::jsonb)", [destination,f.client,
    JSON.stringify({ recipientName: "Synthetic Buyer", line1: "1 Synthetic Lane", city: "Synthetic", postalCode: "00000", country: "ZZ" })]);
  await db.query("INSERT INTO public.commerce_destination_bindings(subscription_id,destination_id) VALUES($1,$2)", [f.subscription,destination]);
  // Fixture installation commits before the business transaction takes commerce locks.
  await db.query("COMMIT"); db.release(true); db = await pool.connect(); await db.query("BEGIN");
  const now = (await db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value")).rows[0].value;
  const codec = createNativeCatalogRenewalCodecV2(value => catalogAcceptedReferenceV2Schema.parse(value));
  const builder = createPostgresRenewalStore(db,codec,work => work(db)), due = (await builder.listDue(10,now)).find(value => value.subscriptionId === f.subscription);
  if (!due) throw new Error("Missing recorded due subscription");
  const previousRevision = (await db.query("SELECT id FROM public.catalog_sku_revisions WHERE sku_id=$1 AND revision=1", [f.sku])).rows[0].id;
  const bind = async (revision: string) => db.query("UPDATE public.subscription_lines SET catalog_sku_revision_id=$2 WHERE subscription_id=$1", [f.subscription,revision]);
  const snapshot = await builder.buildCycleSnapshots(due);
  expect(snapshot.frozenRevision).toBe("native.purchase-renewal.v3");
  expect(snapshot.pricingSnapshot).toMatchObject({ totalAmountMinor: 1900, discountAmountMinor: 100, shippingAmountMinor: 149 });
  const wire = codec.encode(snapshot);
  for (const fault of ["different nested basket", "different accepted roster", "wrong fingerprint", "missing fingerprint", "extra key",
    "rehashed total", "rehashed agreement policy", "rehashed nested key", "rehashed cycle counter", "rehashed shipping terms",
    "rehashed int4 ordinal overflow"] as const) {
    const changed = structuredClone(wire) as Record<string, unknown> & {
      frozenFingerprint?: string; lines: { sku: string; lineOrdinal: number }[];
      templateSnapshot: { lines: { sku: string; lineOrdinal: number }[] };
      orderSnapshot: { lines: { sku: string; lineOrdinal: number }[]; shippingQuoteRef: unknown };
      pricingSnapshot: Record<string, unknown>; cycle: Record<string, unknown>;
    };
    const wrongLines = fault === "different nested basket" || fault === "different accepted roster";
    if (wrongLines) changed.orderSnapshot.lines[0]!.sku = "FOREIGN";
    if (fault === "different accepted roster") {
      changed.lines[0]!.sku = "FOREIGN";
      changed.templateSnapshot.lines[0]!.sku = "FOREIGN";
    }
    if (fault === "wrong fingerprint") changed.frozenFingerprint = "d".repeat(64);
    if (fault === "missing fingerprint") delete changed.frozenFingerprint;
    if (fault === "extra key") {
      delete changed.frozenFingerprint;
      changed.unexpected = true;
      changed.frozenFingerprint = createHash("sha256").update(canonicalCatalogDraftJson(changed)).digest("hex");
    }
    if (fault === "rehashed total") changed.totalAmountMinor = changed.pricingSnapshot.totalAmountMinor = 1901;
    if (fault === "rehashed agreement policy") changed.pricingSnapshot.agreementPolicy = "invalid";
    if (fault === "rehashed nested key") changed.pricingSnapshot.extra = true;
    if (fault === "rehashed cycle counter") changed.cycle.logicalCycleNumber = 0;
    if (fault === "rehashed shipping terms") {
      const terms = { version: "shipping-threshold.v1", currency: "XXX", flatMinor: 149, freeThresholdMinor: 0 };
      changed.pricingSnapshot.shippingTerms = terms;
      changed.orderSnapshot.shippingQuoteRef = { kind: "retained_shipping", shippingAmountMinor: 149, terms };
    }
    if (fault === "rehashed int4 ordinal overflow") {
      for (const lines of [changed.lines, changed.templateSnapshot.lines, changed.orderSnapshot.lines]) lines[0]!.lineOrdinal = 2_147_483_648;
    }
    let claimHash = codec.fingerprint(snapshot);
    if (fault.startsWith("rehashed")) {
      delete changed.frozenFingerprint;
      claimHash = changed.frozenFingerprint = createHash("sha256").update(canonicalCatalogDraftJson(changed)).digest("hex");
      expect.soft(() => codec.decode(changed),fault).toThrow();
    }
    await db.query("SAVEPOINT governed_basket");
    const refusal = await db.query(`INSERT INTO public.subscription_renewal_operations(subscription_id,scheduled_at,cycle_number,identity_key,
      operation_fingerprint,cycle_snapshot,claim_token,claimed_by,claimed_at,lease_expires_at)
      VALUES($1,$2,1,$3,$4,$5::jsonb,$6,'synthetic',clock_timestamp(),clock_timestamp()+interval '1 minute')`,
    [f.subscription,due.scheduledAt,codec.identity(snapshot),claimHash,JSON.stringify(changed),randomUUID()])
      .then(() => ({ admitted: true }), (error: unknown) => error);
    expect.soft(refusal,fault).toMatchObject({ code: "22023", message: wrongLines || fault === "rehashed int4 ordinal overflow" ? "catalog_acceptance_line_mismatch" : "catalog_acceptance_snapshot_mismatch" });
    await db.query("ROLLBACK TO SAVEPOINT governed_basket");
  }
  await bind(previousRevision);
  await expect.soft(builder.buildCycleSnapshots(due)).rejects.toThrow("subscription_catalog_binding_mismatch");
  await db.query("SAVEPOINT catalog_refreeze");
  await expect.soft(builder.claimDue({ snapshot, workerId: "synthetic", now })).rejects.toThrow("subscription_catalog_binding_mismatch");
  await db.query("ROLLBACK TO SAVEPOINT catalog_refreeze");
  await bind(retained.skuRevisionId);
  expect.soft(await builder.buildCycleSnapshots(due)).toEqual(snapshot);
  expect(snapshot.orderSnapshot.lines[0]!.lineOrdinal).toBe(2_147_483_647);
  expect(codec.decode(codec.encode(snapshot))).toEqual(snapshot);
  const claim = await builder.claimDue({ snapshot, workerId: "synthetic", now });
  const boundSnapshot = codec.withDestination!(snapshot,destination);
  const rows = (await db.query("SELECT cycle_snapshot,catalog_acceptance FROM public.subscription_renewal_operations WHERE id=$1", [claim.operationId])).rows;
  expect(rows[0].catalog_acceptance).toEqual(acceptance);
  expect(rows[0].cycle_snapshot).toEqual(codec.encode(boundSnapshot));
  await db.query("COMMIT"); db.release(true); db = await pool.connect(); await db.query("BEGIN");
  const reconnected = createPostgresRenewalStore(db,createNativeCatalogRenewalCodecV2(value => catalogAcceptedReferenceV2Schema.parse(value)));
  expect(await reconnected.claimDue({ snapshot: boundSnapshot, workerId: "synthetic", now })).toMatchObject({ operationId: claim.operationId, replayed: true });
  await db.query("SAVEPOINT immutable_snapshot");
  await expect(db.query("UPDATE public.subscription_renewal_operations SET cycle_snapshot=jsonb_set(cycle_snapshot,'{totalAmountMinor}','1') WHERE id=$1", [claim.operationId])).rejects.toMatchObject({ code: "55000", message: "catalog_acceptance_snapshot_immutable" });
  await db.query("ROLLBACK TO SAVEPOINT immutable_snapshot");
  expect((await db.query("SELECT cycle_snapshot,catalog_acceptance FROM public.subscription_renewal_operations WHERE id=$1", [claim.operationId])).rows).toEqual(rows);
  await db.query("INSERT INTO public.fulfillment_inventory_reservations(renewal_operation_id,operation_fingerprint,source_key,status,expires_at) VALUES($1,$2,'synthetic','held',clock_timestamp()+interval '1 minute')", [claim.operationId,claim.operationFingerprint]);
  await db.query("UPDATE public.subscription_renewal_operations SET state='reserved' WHERE id=$1", [claim.operationId]);
  const settlement = createPostgresRenewalSettlementPort(db,codec,work => work(db));
  const prepare = { operationId: claim.operationId, claimToken: claim.claimToken, now };
  const prepared = await settlement.prepareRenewal(prepare);
  const money = (await db.query(`SELECT o.total_amount_minor::int AS total,
    (SELECT sum(line_amount_minor)::int FROM public.commerce_order_items WHERE order_id=o.id) AS items,
    (SELECT sum(amount_minor)::int FROM public.commerce_order_adjustments WHERE order_id=o.id) AS shipping
    FROM public.commerce_orders o WHERE o.id=$1`, [prepared.orderId])).rows;
  expect(money).toEqual([{ total: 1900, items: 1751, shipping: 149 }]);
  expect(await settlement.prepareRenewal(prepare)).toMatchObject({ replayed: true, orderId: prepared.orderId });
});

async function appendLegacyAcceptedSku(f: Awaited<ReturnType<typeof seed>>, reference: CatalogAcceptedReferenceV2): Promise<CatalogAcceptedReferenceV2> {
  const skuCode = "LEGACY-ARTICLE";
  const original = (await db.query("SELECT full_facts FROM public.catalog_sku_revisions WHERE id=$1",[reference.skuRevisionId])).rows[0].full_facts;
  const facts = { ...JSON.parse(original), id: legacySkuId, code: skuCode };
  const skuBytes = canonicalCatalogDraftJson(facts), skuDigest = createHash("sha256").update(skuBytes).digest("hex");
  const publicationId = randomUUID(), priorRevision = randomUUID(), currentRevision = randomUUID();
  const stored = (await db.query("SELECT canonical_state FROM public.catalog_publications WHERE id=$1",[reference.publicationHead.publicationId])).rows[0].canonical_state;
  const manifest = JSON.parse(stored);
  manifest.skus.unshift({ skuId: legacySkuId, revisionId: currentRevision, revision: 2, digest: skuDigest });
  const bytes = canonicalCatalogDraftJson(manifest), digest = createHash("sha256").update(bytes).digest("hex");
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$2,$3,'Legacy article')",[legacySkuId,f.product,skuCode]);
  await db.query(`INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id)
    SELECT $1,product_id,revision+1,id,draft_id,draft_revision,$2,candidate_digest,document_revision_id,$3,$4,actor_id
    FROM public.catalog_publications WHERE id=$5`,[publicationId,`synthetic:${publicationId}`,bytes,digest,reference.publicationHead.publicationId]);
  await db.query(`INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest)
    VALUES($1,$2,$3,1,$4,$5,$6),($7,$2,$3,2,$8,$5,$6)`,
    [priorRevision,legacySkuId,f.product,reference.publicationHead.publicationId,skuBytes,skuDigest,currentRevision,publicationId]);
  const result = { ...reference, skuId: legacySkuId, skuCode, skuRevisionId: currentRevision,
    publicationHead: { ...reference.publicationHead, publicationId, revision: reference.publicationHead.revision+1 } };
  expect(await assertCatalogAcceptedReferenceV2(db,result)).toEqual(result);
  return result;
}
