import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { canonicalCatalogDraftJson, createCatalogDraftHandlerV2, createCatalogDraftHandlerV3, createCatalogDraftHandlerV4, createCatalogDraftHandler, createCatalogProductTypeRegistry, createPostgresCatalogDraftStoreV2, createPostgresCatalogDraftStoreV3, createPostgresCatalogDraftStoreV4, createPostgresCatalogDraftStore,
  type CatalogDraftPayload, type CatalogDraftPayloadV2, type CatalogDraftPayloadV3, type CatalogDraftPayloadV4, type CatalogDraftStoredCommand, type CatalogDraftStoredApplyResult } from "@openlup/platform/catalog";
import { journeyCensus } from "../helpers/storeJourney.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const forward = "db/platform/migrations/20261122150000_catalog_drafts_v2.sql";
const containers: PostgresContainer[] = [], pools: Pool[] = [];
let owner: Pool, connectionString: string;
const registry = createCatalogProductTypeRegistry([{ key: "example:article", version: 1,
  units: [{ code: "openlup:piece", dimension: "count", integral: true }, { code: "openlup:g", dimension: "mass", integral: false }],
  netContentUnits: ["openlup:piece"], dimensions: [], validatorRef: `sha256:${"a".repeat(64)}`, validateContent: () => [] }]);
const legacyId = randomUUID(), legacyProduct = randomUUID(), legacySku = randomUUID();
const legacyPayload: CatalogDraftPayload = { schemaVersion: 1, product: { id: legacyProduct, type: { key: "example:article", version: 1 }, slug: "legacy-draft",
  primarySkuId: legacySku, dimensions: [], sharedContent: { title: "Synthetic é e\u0301", nested: [null, true, "value"] },
  documentRevision: { id: randomUUID(), productId: legacyProduct, revisionNo: 1, schemaId: "example:document", documentRef: "example:document:1", sourceRef: "example:source:1", digest: "a".repeat(64) } },
  skus: [{ id: legacySku, productId: legacyProduct, code: `LEGACY-${legacySku}`, options: {}, netContent: { dimension: "count", unit: "openlup:piece", unscaled: "1", scale: 0 },
    identifiers: [{ scheme: "example:identity", issuer: "synthetic", value: "stable", packagingLevel: "case", quantity: 4 }], assetRefs: ["example:asset"],
    grossMass: { dimension: "mass", unit: "openlup:g", unscaled: "12345", scale: 2 }, priceRef: "example:price", logisticsRef: "example:logistics" }] };
const legacyCommands: CatalogDraftStoredCommand[] = [
  { schemaVersion: 1, action: "create", draftId: legacyId, commandKey: "create:é", expectedRevision: 0, payload: legacyPayload },
  { schemaVersion: 1, action: "revise", draftId: legacyId, commandKey: "revise", expectedRevision: 1,
    payload: { ...legacyPayload, product: { ...legacyPayload.product, sharedContent: { title: "Synthetic revision two" } } } },
  { schemaVersion: 1, action: "abandon", draftId: legacyId, commandKey: "abandon", expectedRevision: 2 },
];
let legacyResults: CatalogDraftStoredApplyResult[], historical: unknown;
let v2BeforeV3: { command: object; record: unknown }[];
const v3Forward = "db/platform/migrations/20261122160000_catalog_drafts_v3.sql";
const actorId = "operator:Synthetic-é-e\u0301";
async function apply(db: Pool | PoolClient, command: CatalogDraftStoredCommand | object, actor = actorId) {
  const text = canonicalCatalogDraftJson(command), fingerprint = createHash("sha256").update(text).digest("hex");
  return (await db.query("SELECT public.catalog_draft_apply($1,$2,$3) AS result", [text, fingerprint, actor])).rows[0].result as CatalogDraftStoredApplyResult;
}
function v2(productId = randomUUID(), skuId = randomUUID()): CatalogDraftPayloadV2 {
  return { schemaVersion: 2, product: { id: productId, type: { key: "example:article", version: 1 }, dimensions: [], sharedContent: { title: "Synthetic v2" }, attributes: {} },
    skus: [{ id: skuId, productId, code: `V2-${skuId}`, options: {}, attributes: {}, netContent: { dimension: "count", unit: "openlup:piece", unscaled: "2", scale: 0 },
      priceOperations: [{ schemaVersion: 1, commandKey: `price:${skuId}`, variantId: skuId, priceListId: randomUUID(), mode: "one_time", minQty: 1,
        amountKind: "gross", unitPriceMinor: 1234, expected: { entryId: null, unitPriceMinor: null } }] }] };
}
async function commerce() {
  const census = await journeyCensus(owner);
  for (const table of ["catalog_draft_heads", "catalog_draft_revisions", "catalog_draft_command_receipts", "catalog_draft_sku_reservations"]) delete census[table];
  return census;
}
beforeAll(async () => {
  const container = await runPostgresContainer({ name: `catalog-draft-v2-${process.pid}`, password: "synthetic-catalog-draft" }); containers.push(container);
  connectionString = container.connectionString;
  if (!await waitForPostgresTcpReady(connectionString)) throw new Error("Draft v2 witnesses require real PostgreSQL");
  owner = new Pool({ connectionString }); pools.push(owner);
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) { if (unit.file === forward) break; await owner.query(readFileSync(unit.file, "utf8")); }
  legacyResults = [];
  for (const command of legacyCommands) { const result = await apply(owner, command); expect(result).toMatchObject({ outcome: "committed" }); legacyResults.push(result); }
  historical = (await owner.query("SELECT to_jsonb(r)::text AS value FROM public.catalog_draft_revisions r ORDER BY revision")).rows;
  await owner.query(readFileSync(forward, "utf8"));
  expect((await owner.query("SELECT to_jsonb(r)::text AS value FROM public.catalog_draft_revisions r ORDER BY revision")).rows).toEqual(historical);
  const product = (await owner.query("INSERT INTO public.catalog_products(slug,name) VALUES('draft-v2-live','Synthetic live') RETURNING id")).rows[0].id;
  const sku = (await owner.query("INSERT INTO public.catalog_skus(product_id,sku,title) VALUES($1,'DRAFT-V2-LIVE','Synthetic live') RETURNING id", [product])).rows[0].id;
  const list = (await owner.query("INSERT INTO public.price_lists(name,region_code,currency,valid_from) VALUES('Synthetic list','ZZ','XXX',clock_timestamp()) RETURNING id")).rows[0].id;
  await owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'one_time',1234,clock_timestamp())", [list, sku]);
  const client = (await owner.query("INSERT INTO public.clients(email) VALUES('draft-v2@example.invalid') RETURNING id")).rows[0].id;
  const subscription = (await owner.query("INSERT INTO public.subscriptions(client_id,cadence_days,next_cycle_at,price_list_id,currency_code) VALUES($1,28,clock_timestamp()+interval '28 days',$2,'XXX') RETURNING id", [client, list])).rows[0].id;
  await owner.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,2,0,1234,'XXX')", [subscription, sku]);
  await owner.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
    VALUES($1,'XXX','synthetic','sandbox',clock_timestamp(),'synthetic:authorization')`, [subscription]);
  await owner.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,'DRAFT-V2-LIVE',2,1234)", [subscription]);
  const cycle = (await owner.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at) SELECT id,next_cycle_at FROM public.subscriptions WHERE id=$1 RETURNING id", [subscription])).rows[0].id;
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    const order = (await db.query("INSERT INTO public.commerce_orders(client_id,subscription_cycle_id,status,currency_code,total_amount_minor) VALUES($1,$2,'pending_payment','XXX',2468) RETURNING id", [client, cycle])).rows[0].id;
    await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,sku_id,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,$2,2,1234,2468)", [order, sku]);
    await db.query("COMMIT");
  } finally { await db.query("ROLLBACK"); db.release(); }
  v2BeforeV3 = [];
  const v2Id = randomUUID();
  for (const command of [
    { schemaVersion: 2, action: "create", draftId: v2Id, commandKey: "v2:before-v3", expectedRevision: 0, payload: v2() },
    { schemaVersion: 2, action: "abandon", draftId: v2Id, commandKey: "v2:abandoned-before-v3", expectedRevision: 1 },
  ]) {
    const result = await apply(owner, command);
    if (result.outcome !== "committed") throw new Error("v2 receipt missing before v3 upgrade");
    v2BeforeV3.push({ command, record: result.record });
  }
  const rows = await journeyCensus(owner);
  await owner.query(readFileSync(v3Forward, "utf8"));
  expect(await journeyCensus(owner)).toEqual(rows);
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(containers, pools), postgresTeardownTimeoutMs);

it("catalog_draft_v2_roundtrip_preserves_prices", async () => {
  const before = await commerce(), draftId = randomUUID(), payload = v2();
  const command = { schemaVersion: 2 as const, action: "create" as const, draftId, commandKey: "create:v2", expectedRevision: 0, payload };
  const handler = createCatalogDraftHandlerV2({ store: createPostgresCatalogDraftStoreV2(owner), registry, authorizeOperator: async () => ({ actorId }) });
  const created = await handler.execute(command, null);
  expect(created).toMatchObject({ outcome: "committed", record: { payload }, readiness: { publication: { status: "incomplete" }, commercial: { status: "inactive" } } });
  const reconnect = new Pool({ connectionString }); pools.push(reconnect);
  const reader = createPostgresCatalogDraftStoreV2(reconnect);
  expect((await reader.get({ draftId, revision: 1 }, actorId))?.payload).toEqual(payload);
  const revised = structuredClone(payload); revised.skus[0].priceOperations![0].unitPriceMinor = 2345;
  revised.skus[0].priceOperations![0].expected = { entryId: randomUUID(), unitPriceMinor: 0 };
  expect(await apply(reconnect, { ...command, action: "revise", commandKey: "revise:v2", expectedRevision: 1, payload: revised })).toMatchObject({ outcome: "committed", record: { revision: 2, payload: revised } });
  expect((await reader.get({ draftId, commandKey: command.commandKey }, actorId))?.payload).toEqual(payload);
  expect(await apply(reconnect, command)).toMatchObject({ outcome: "replayed", record: { payload } });
  expect(await apply(reconnect, { ...command, commandKey: "stale", action: "revise" })).toMatchObject({ outcome: "conflict", reason: "revision_conflict" });
  expect(await apply(reconnect, { ...command, payload: revised })).toMatchObject({ outcome: "conflict", reason: "command_key_reused" });
  expect(await apply(reconnect, command, "operator:other")).toMatchObject({ outcome: "unauthorized", reason: "operator_mismatch" });
  expect(await commerce()).toEqual(before);
});
it("catalog_draft_v1_replay_is_unchanged", async () => {
  const before = await commerce(), reconnect = new Pool({ connectionString }); pools.push(reconnect);
  const handler = createCatalogDraftHandler({ store: createPostgresCatalogDraftStore(reconnect), registry: createCatalogProductTypeRegistry([]), authorizeOperator: async () => ({ actorId }) });
  for (const [index, command] of legacyCommands.entries()) {
    const original = legacyResults[index]; if (original.outcome !== "committed") throw new Error("Legacy receipt missing");
    expect(await apply(reconnect, command)).toEqual({ outcome: "replayed", record: original.record });
    expect(await handler.execute(command, null)).toEqual({ outcome: "replayed", record: original.record });
  }
  expect((await owner.query("SELECT to_jsonb(r)::text AS value FROM public.catalog_draft_revisions r WHERE draft_id=$1 ORDER BY revision", [legacyId])).rows).toEqual(historical);
  expect(await commerce()).toEqual(before);
});
it("catalog_resume_preserves_abandoned_receipt", async () => {
  const before = await commerce(), draftId = randomUUID(), payload = v2();
  await apply(owner, { schemaVersion: 2, action: "create", draftId, commandKey: "create", expectedRevision: 0, payload });
  const abandon = { schemaVersion: 2, action: "abandon", draftId, commandKey: "abandon", expectedRevision: 1 };
  const abandoned = await apply(owner, abandon);
  const reservations = (await owner.query("SELECT to_jsonb(r)::text AS value FROM public.catalog_draft_sku_reservations r WHERE draft_id=$1", [draftId])).rows;
  const resume = { schemaVersion: 2, action: "resume", draftId, commandKey: "resume", expectedRevision: 2 };
  const resumed = await apply(owner, resume);
  expect(resumed).toMatchObject({ outcome: "committed", record: { revision: 3, status: "open", payload } });
  if (abandoned.outcome !== "committed" || resumed.outcome !== "committed") throw new Error("Receipt missing");
  expect(await apply(owner, abandon)).toEqual({ outcome: "replayed", record: abandoned.record });
  expect(await apply(owner, resume)).toEqual({ outcome: "replayed", record: resumed.record });
  expect(await apply(owner, { ...resume, commandKey: "already-open", expectedRevision: 3 })).toMatchObject({ outcome: "conflict", reason: "draft_not_abandoned" });
  expect((await owner.query("SELECT to_jsonb(r)::text AS value FROM public.catalog_draft_sku_reservations r WHERE draft_id=$1", [draftId])).rows).toEqual(reservations);
  expect(await commerce()).toEqual(before);
});
it("catalog_legacy_revise_refuses_abandoned", async () => {
  const before = await journeyCensus(owner);
  expect(await apply(owner, { schemaVersion: 1, action: "revise", draftId: legacyId, commandKey: "new-revise", expectedRevision: 3, payload: legacyPayload }))
    .toMatchObject({ outcome: "conflict", reason: "draft_abandoned", currentRevision: 3 });
  expect(await apply(owner, { schemaVersion: 1, action: "resume", draftId: legacyId, commandKey: "legacy-resume", expectedRevision: 3 }))
    .toMatchObject({ outcome: "validation_issue", reason: "command_invalid" });
  expect(await journeyCensus(owner)).toEqual(before);
});
it("retains atomic rollback, reservation races, permission and version refusals", async () => {
  const before = await journeyCensus(owner), command = { schemaVersion: 2, action: "create", draftId: randomUUID(), commandKey: "rollback", expectedRevision: 0, payload: v2() };
  const db = await owner.connect();
  try { await db.query("BEGIN"); expect((await apply(db, command)).outcome).toBe("committed"); await db.query("ROLLBACK"); }
  finally { db.release(); }
  expect(await journeyCensus(owner)).toEqual(before);
  for (const schemaVersion of [0, 3]) expect((await apply(owner, { ...command, schemaVersion })).outcome).toBe("validation_issue");
  const bad = structuredClone(command); bad.payload.skus[0].priceOperations![0].unitPriceMinor = 0;
  expect(await apply(owner, bad)).toMatchObject({ outcome: "validation_issue", reason: "price_operation_invalid" });
  expect(await journeyCensus(owner)).toEqual(before);
  await owner.query("CREATE ROLE draft_v2_observer NOLOGIN");
  const observer = await owner.connect();
  try {
    await observer.query("SET ROLE draft_v2_observer");
    await expect(apply(observer, command)).rejects.toMatchObject({ code: "42501" });
  } finally { await observer.query("RESET ROLE"); observer.release(); }
  const skuId = randomUUID(), first = { ...command, draftId: randomUUID(), commandKey: "race:first", payload: v2(randomUUID(), skuId) },
    second = { ...command, draftId: randomUUID(), commandKey: "race:second", payload: v2(randomUUID(), skuId) };
  const results = await Promise.all([apply(owner, first), apply(owner, second)]);
  expect(results.map(result => result.outcome).sort()).toEqual(["committed", "conflict"]);
  const loser = results[0].outcome === "conflict" ? first : second;
  expect((await owner.query("SELECT * FROM public.catalog_draft_heads WHERE draft_id=$1", [loser.draftId])).rows).toEqual([]);
  expect((await owner.query("SELECT * FROM public.catalog_draft_revisions WHERE draft_id=$1", [loser.draftId])).rows).toEqual([]);
});
it("resumes legacy abandonment without rewriting the v1 payload or old receipts", async () => {
  const abandoned = legacyResults[2]; if (abandoned.outcome !== "committed") throw new Error("Legacy receipt missing");
  const result = await apply(owner, { schemaVersion: 2, action: "resume", draftId: legacyId, commandKey: "v2:resume-legacy", expectedRevision: 3 });
  expect(result).toMatchObject({ outcome: "committed", record: { revision: 4, status: "open", payload: abandoned.record.payload } });
  expect(await apply(owner, legacyCommands[2])).toEqual({ outcome: "replayed", record: abandoned.record });
});

function v3(): CatalogDraftPayloadV3 {
  const base = v2();
  return { ...base, schemaVersion: 3, product: { ...base.product, sharedContent: {
    schemaVersion: 1, catalogAction: "create", document: { source: "example:source" }, presentation: { routePath: { en: "/synthetic" } },
    offerMemberships: [{ skuCode: base.skus[0].code!, offerVersion: "example:offer", admitted: false }],
    requestedModes: [{ skuCode: base.skus[0].code!, modes: [] }],
    publicationSkus: [{ skuCode: base.skus[0].code!, title: "Synthetic", minQuantity: 1, isAddon: false, facts: {} }],
  } }, publication: { kind: "release", evidence: { media: [{ skuCode: base.skus[0].code!, mediaRef: "example:media", assetRefs: ["example:asset"], revisionDigest: "b".repeat(64) }] },
    operations: [
      { op: "create_product", productId: base.product.id, productSlug: "synthetic", name: "Synthetic" },
      { op: "set_eligibility", skuCode: base.skus[0].code!, sellableStandalone: false, sellableInSubscription: false },
      { op: "set_derived_sku_facts", skuCode: "OMITTED-SKU", documentRevisionNo: 1, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 }, facts: { derived: 12 } },
    ] } };
}
it("catalog_draft_v3_roundtrip_and_resume_preserve_publication_inputs", async () => {
  const before = await commerce(), draftId = randomUUID(), payload = v3();
  const command = { schemaVersion: 3, action: "create", draftId, commandKey: "v3:create", expectedRevision: 0, payload };
  const handler = createCatalogDraftHandlerV3({ store: createPostgresCatalogDraftStoreV3(owner), registry, authorizeOperator: async () => ({ actorId }) });
  const created = await handler.execute(command, null);
  expect(created).toMatchObject({ outcome: "committed", record: { payload } });
  const reconnect = new Pool({ connectionString }); pools.push(reconnect);
  const reader = createPostgresCatalogDraftStoreV3(reconnect);
  const record = await reader.get({ draftId, revision: 1 }, actorId);
  expect(record?.payload).toEqual(payload);
  expect(canonicalCatalogDraftJson(record?.payload)).toBe(canonicalCatalogDraftJson(payload));
  const text = canonicalCatalogDraftJson(command);
  expect(record?.fingerprint).toBe(createHash("sha256").update(text).digest("hex"));
  const abandon = { schemaVersion: 3, action: "abandon", draftId, commandKey: "v3:abandon", expectedRevision: 1 };
  const abandoned = await handler.execute(abandon, null);
  const reservations = (await owner.query("SELECT to_jsonb(r)::text AS row FROM public.catalog_draft_sku_reservations r WHERE draft_id=$1", [draftId])).rows;
  const resume = { schemaVersion: 3, action: "resume", draftId, commandKey: "v3:resume", expectedRevision: 2 };
  expect(await handler.execute(resume, null)).toMatchObject({ outcome: "committed", record: { revision: 3, status: "open", payload } });
  if (abandoned.outcome !== "committed" || created.outcome !== "committed") throw new Error("v3 receipts missing");
  expect(await handler.execute(abandon, null)).toEqual({ outcome: "replayed", record: abandoned.record });
  expect(await handler.execute(command, null)).toEqual({ outcome: "replayed", record: created.record });
  expect((await owner.query("SELECT to_jsonb(r)::text AS row FROM public.catalog_draft_sku_reservations r WHERE draft_id=$1", [draftId])).rows).toEqual(reservations);
  const altered = structuredClone(command); altered.payload.publication.operations.reverse();
  expect(await handler.execute(altered, null)).toMatchObject({ outcome: "conflict", reason: "draft_command_key_reused" });
  expect(await apply(owner, { ...resume, schemaVersion: 4 })).toMatchObject({ outcome: "validation_issue", reason: "command_invalid" });
  expect(await commerce()).toEqual(before);
});
it("catalog_draft_v2_replay_is_unchanged_after_v3", async () => {
  const before = await commerce();
  const handler = createCatalogDraftHandlerV2({ store: createPostgresCatalogDraftStoreV2(owner), registry: createCatalogProductTypeRegistry([]), authorizeOperator: async () => ({ actorId }) });
  for (const { command, record } of v2BeforeV3) {
    expect(await apply(owner, command)).toEqual({ outcome: "replayed", record });
    expect(await handler.execute(command, null)).toEqual({ outcome: "replayed", record });
  }
  expect(await commerce()).toEqual(before);
});
it("catalog_draft_v3_refuses_unknown_fields_and_rolls_back_without_live_effects", async () => {
  const before = await journeyCensus(owner), command = { schemaVersion: 3, action: "create", draftId: randomUUID(), commandKey: "v3:rollback", expectedRevision: 0, payload: v3() };
  const db = await owner.connect();
  try { await db.query("BEGIN"); expect((await apply(db, command)).outcome).toBe("committed"); await db.query("ROLLBACK"); }
  finally { db.release(); }
  expect(await journeyCensus(owner)).toEqual(before);
  const bad = structuredClone(command); Object.assign(bad.payload.publication.operations[0], { extra: true });
  expect(await apply(owner, bad)).toMatchObject({ outcome: "validation_issue", reason: "publication_inputs_invalid" });
  const wrongPrice = structuredClone(command); wrongPrice.payload.skus[0].priceOperations![0].unitPriceMinor = 0;
  expect(await apply(owner, wrongPrice)).toMatchObject({ outcome: "validation_issue", reason: "price_operation_invalid" });
  const store = createPostgresCatalogDraftStoreV2(owner), canonicalCommand = canonicalCatalogDraftJson(command), fingerprint = createHash("sha256").update(canonicalCommand).digest("hex");
  expect(await store.apply({ canonicalCommand, fingerprint, actorId })).toMatchObject({ outcome: "validation_issue", reason: "command_invalid" });
  expect(await journeyCensus(owner)).toEqual(before);
});

it("preserves raw v4 revisions across save, abandon, resume, list and receipt replay", async () => {
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as { forward: { file: string }[] };
  for (const { file } of manifest.forward.slice(manifest.forward.findIndex(unit => unit.file === v3Forward) + 1))
    await owner.query(readFileSync(file, "utf8"));
  const draftId = randomUUID(), legacy = v3(), skuCode = legacy.skus[0]!.code!;
  const payload: CatalogDraftPayloadV4 = { ...legacy, schemaVersion: 4,
    skus: legacy.skus.map(sku => ({ ...sku, demandPolicyRef: "example:policy" })),
    publication: { ...legacy.publication, operations: [
      { op: "set_eligibility", skuCode, sellableStandalone: true, sellableInSubscription: false },
      { op: "restore_sku", skuCode, expectedState: "withdrawn" },
    ] } };
  const command = { schemaVersion: 4, action: "create", draftId, commandKey: "v4:first", expectedRevision: 0, payload };
  const store = createPostgresCatalogDraftStoreV4(owner);
  const handler = createCatalogDraftHandlerV4({ store, registry, authorizeOperator: async () => ({ actorId }) });
  const base = { ...command, draftId: randomUUID() };
  for (const operations of [
    [{ op: "set_sku_status", skuCode, status: "active" }],
    payload.publication.operations.slice(1),
    [{ op: "set_product_lifecycle", productSlug: "synthetic", expectedState: "active", state: "withdrawn",
      children: [{ skuCode, expectedState: "active" }, { skuCode, expectedState: "draft" }] }],
  ]) {
    const invalid = { ...base, payload: { ...payload, publication: { ...payload.publication, operations } } };
    expect(await handler.execute(invalid, null)).toMatchObject({ outcome: "validation_issue" });
    expect(await apply(owner, invalid)).toMatchObject({ outcome: "validation_issue" });
  }
  expect(await apply(owner, { ...base, schemaVersion: 3 })).toMatchObject({ outcome: "validation_issue" });
  const result = await handler.execute(command, null);
  if (result.outcome !== "committed") throw Error(JSON.stringify(result));
  const reconnect = new Pool({ connectionString }); pools.push(reconnect);
  const reader = createPostgresCatalogDraftStoreV4(reconnect);
  const abandon = { schemaVersion: 4, action: "abandon", draftId, commandKey: "v4:abandon", expectedRevision: 1 };
  expect(await apply(reconnect, { ...abandon, schemaVersion: 3 })).toMatchObject({ outcome: "validation_issue" });
  expect(await handler.execute(abandon, null)).toMatchObject({ outcome: "committed", record: { status: "abandoned", payload } });
  expect(await handler.execute({ ...abandon, action: "resume", commandKey: "v4:resume", expectedRevision: 2 }, null))
    .toMatchObject({ outcome: "committed", record: { status: "open", payload } });
  expect((await reader.list({ limit: 100 }, actorId)).items.find(row => row.draftId === draftId)?.payload).toEqual(payload);
  const original = await reader.get({ draftId, revision: 1 }, actorId);
  expect(canonicalCatalogDraftJson(original?.payload)).toBe(canonicalCatalogDraftJson(payload));
  expect(await handler.execute(command, null)).toEqual({ outcome: "replayed", record: result.record });
  await expect(createPostgresCatalogDraftStoreV3(reconnect).get({ draftId }, actorId)).rejects.toThrow("invalid_store_response");
});
