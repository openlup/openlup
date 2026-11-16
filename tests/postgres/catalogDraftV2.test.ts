import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { canonicalCatalogDraftJson, createCatalogDraftHandler, createCatalogProductTypeRegistry, createPostgresCatalogDraftStore,
  type CatalogDraftPayload, type CatalogDraftPayloadV2, type CatalogDraftStoredCommand, type CatalogDraftStoredApplyResult } from "@openlup/platform/catalog";
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
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(containers, pools), postgresTeardownTimeoutMs);

it("catalog_draft_v2_roundtrip_preserves_prices", async () => {
  const before = await commerce(), draftId = randomUUID(), payload = v2();
  const command = { schemaVersion: 2 as const, action: "create" as const, draftId, commandKey: "create:v2", expectedRevision: 0, payload };
  const handler = createCatalogDraftHandler({ store: createPostgresCatalogDraftStore(owner), registry, authorizeOperator: async () => ({ actorId }) });
  const created = await handler.execute(command, null);
  expect(created).toMatchObject({ outcome: "committed", record: { payload }, readiness: { publication: { status: "incomplete" }, commercial: { status: "inactive" } } });
  const reconnect = new Pool({ connectionString }); pools.push(reconnect);
  const reader = createPostgresCatalogDraftStore(reconnect);
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
