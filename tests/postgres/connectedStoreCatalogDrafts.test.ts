import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalCatalogDraftJson, installCatalogDefinitions, type CatalogDraftPublicationStoredApplyResult as CatalogDraftApplyResult,
  type CatalogDraftPublicationStoredCommand as CatalogDraftCommand, type CatalogDraftPayloadV2, type CatalogDraftPayloadV3 } from "@openlup/platform/catalog";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeyCensus, journeyRpc, journeySelection, storeJourneyResources,
  type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const relations = ["catalog_draft_heads", "catalog_draft_revisions", "catalog_draft_command_receipts", "catalog_draft_sku_reservations",
  "catalog_type_versions", "catalog_definition_installs", "catalog_tax_classes", "catalog_skus", "catalog_products"] as const;
const packs = [1, 2].map(version => ({ id: "example:transfer", namespace: "example", version, openlupRange: "0.44.x", capabilities: { publish: false },
  types: [{ key: "example:transfer-item", version, units: [{ code: "openlup:piece", dimension: "count" as const, integral: true }],
    netContentUnits: ["openlup:piece"], dimensions: [], validatorRef: `sha256:${String(version).repeat(64)}`, validateContent: () => [] }],
  taxClasses: [{ key: "example:transfer-standard" }] }));
const resources = storeJourneyResources();
let source: JourneyInstallation, target: JourneyInstallation;
let before: Awaited<ReturnType<typeof journeyCensus>>, restored: typeof before;
let packet: Awaited<ReturnType<typeof captureStoreJourney>>;
let commands: { canonicalCommand: string; fingerprint: string; actorId: string; result: CatalogDraftApplyResult }[];

beforeAll(async () => {
  source = await resources.installation("catalog-draft-source");
  for (const pack of packs) await installCatalogDefinitions(source.owner, pack);
  await source.owner.query("UPDATE public.catalog_tax_classes SET status='retired' WHERE key='example:transfer-standard'");
  commands = [];
  // Both open and abandoned heads retain historical revisions and reservations
  // for SKUs removed from the latest payload. The writer supplies database times.
  for (const abandoned of [false, true]) {
    const draftId = randomUUID(), productId = randomUUID(), skuId = randomUUID();
    const payload = { schemaVersion: 1 as const,
      product: { id: productId, type: { key: "synthetic:unit", version: 1 }, dimensions: [],
        sharedContent: { title: "Synthetic \"draft\" \\ value", nested: ["é", "e\u0301", null, 0.125] } },
      skus: [{ id: skuId, productId, code: `DRAFT-${skuId}`, options: {} }] };
    const input: CatalogDraftCommand[] = [
      { schemaVersion: 1, action: "create", draftId, commandKey: "create:é", expectedRevision: 0, payload },
      { schemaVersion: 1, action: "revise", draftId, commandKey: "revise:e\u0301", expectedRevision: 1,
        payload: { ...payload, skus: [] } },
      ...(abandoned ? [{ schemaVersion: 1 as const, action: "abandon" as const, draftId,
        commandKey: "abandon", expectedRevision: 2 }] : []),
    ];
    for (const command of input) {
      const canonicalCommand = canonicalCatalogDraftJson(command);
      const fingerprint = createHash("sha256").update(canonicalCommand).digest("hex");
      const actorId = "operator:Synthetic-é-e\u0301";
      const result = await journeyRpc<CatalogDraftApplyResult>(source.runtime, "catalog_draft_apply", [canonicalCommand, fingerprint, actorId]);
      expect(result).toMatchObject({ outcome: "committed", record: { actorId, fingerprint } });
      commands.push({ canonicalCommand, fingerprint, actorId, result });
    }
  }
  const draftId = randomUUID(), productId = randomUUID(), skuId = randomUUID();
  const payload: CatalogDraftPayloadV2 = { schemaVersion: 2,
    product: { id: productId, type: { key: "example:transfer-item", version: 1 }, dimensions: [], attributes: { "example:title": "Synthetic v2" } },
    skus: [{ id: skuId, productId, code: `V2-${skuId}`, options: {}, attributes: { "example:enabled": true },
      priceOperations: [{ schemaVersion: 1, commandKey: "price:v2", variantId: skuId, priceListId: randomUUID(), mode: "one_time", minQty: 1,
        amountKind: "gross", unitPriceMinor: 1234, expected: { entryId: null, unitPriceMinor: null } }] }] };
  for (const command of [
    { schemaVersion: 2, action: "create", draftId, commandKey: "v2:create", expectedRevision: 0, payload },
    { schemaVersion: 2, action: "revise", draftId, commandKey: "v2:revise", expectedRevision: 1,
      payload: { ...payload, skus: payload.skus.map(sku => ({ ...sku, priceOperations: sku.priceOperations!.map(price => ({ ...price, unitPriceMinor: 2345 })) })) } },
    { schemaVersion: 2, action: "abandon", draftId, commandKey: "v2:abandon", expectedRevision: 2 },
    { schemaVersion: 2, action: "resume", draftId, commandKey: "v2:resume", expectedRevision: 3 },
  ]) {
    const canonicalCommand = canonicalCatalogDraftJson(command), fingerprint = createHash("sha256").update(canonicalCommand).digest("hex"), actorId = "operator:Synthetic-v2";
    const result = await journeyRpc<CatalogDraftApplyResult>(source.runtime, "catalog_draft_apply", [canonicalCommand, fingerprint, actorId]);
    expect(result).toMatchObject({ outcome: "committed", record: { payload: { schemaVersion: 2 } } });
    commands.push({ canonicalCommand, fingerprint, actorId, result });
  }
  const v3DraftId = randomUUID(), v3ProductId = randomUUID(), v3SkuId = randomUUID();
  const publicationPayload: CatalogDraftPayloadV3 = { ...payload, schemaVersion: 3,
    product: { ...payload.product, id: v3ProductId, sharedContent: { schemaVersion: 1, catalogAction: "create", presentation: {},
      offerMemberships: [{ skuCode: "V3-TRANSFER", offerVersion: "example:offer", admitted: false }],
      requestedModes: [{ skuCode: "V3-TRANSFER", modes: [] }], publicationSkus: [] } },
    skus: [{ ...payload.skus[0], id: v3SkuId, productId: v3ProductId, code: "V3-TRANSFER", priceOperations: [] }],
    publication: { kind: "compensation", evidence: {}, operations: [
      { op: "set_derived_sku_facts", skuCode: "OMITTED", documentRevisionNo: 1, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 }, facts: { derived: 12 } },
    ] } };
  for (const command of [
    { schemaVersion: 3, action: "create", draftId: v3DraftId, commandKey: "v3:create", expectedRevision: 0, payload: publicationPayload },
    { schemaVersion: 3, action: "abandon", draftId: v3DraftId, commandKey: "v3:abandon", expectedRevision: 1 },
    { schemaVersion: 3, action: "resume", draftId: v3DraftId, commandKey: "v3:resume", expectedRevision: 2 },
  ]) {
    const canonicalCommand = canonicalCatalogDraftJson(command), fingerprint = createHash("sha256").update(canonicalCommand).digest("hex"), actorId = "operator:Synthetic-v3";
    const result = await journeyRpc<CatalogDraftApplyResult>(source.runtime, "catalog_draft_apply", [canonicalCommand, fingerprint, actorId]);
    expect(result).toMatchObject({ outcome: "committed", record: { payload: publicationPayload } });
    commands.push({ canonicalCommand, fingerprint, actorId, result });
  }
  // A populated live catalogue proves preservation as well as absence of
  // accidental publication of the separate draft product/SKU identities.
  const liveId = randomUUID(), listId = randomUUID();
  await source.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'transfer-live','Synthetic live product')", [liveId]);
  await source.owner.query("UPDATE public.catalog_products SET type_key='example:transfer-item',type_version=1 WHERE id=$1", [liveId]);
  await source.owner.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,
    net_content_dimension,net_content_unscaled,net_content_scale,net_content_unit,
    gross_mass_dimension,gross_mass_unscaled,gross_mass_scale,gross_mass_unit)
    VALUES($1,$1,'TRANSFER-LIVE','Synthetic live SKU','volume',1234567890123456789012345678901234567890,12,'example:custom-volume',
    'mass',9999999999999999999999999999999999999999,12,'example:custom-mass')`, [liveId]);
  await source.owner.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic list','ZZ','XXX',clock_timestamp())", [listId]);
  await source.owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'any',123,clock_timestamp())", [listId, liveId]);
  await source.owner.query(`UPDATE public.catalog_products SET attribute_values=
    '{"example:title":{"en":"Synthetic é","pl":"e\\u0301"},"example:enabled":false,"example:empty":[],"example:decimal":"-123456789012345678901234567890.123456789012"}'::jsonb WHERE id=$1`, [liveId]);
  await source.owner.query(`UPDATE public.catalog_skus SET attribute_values=
    '{"example:ref":"synthetic-private-reference","example:decimal":"0.000000000001"}'::jsonb WHERE id=$1`, [liveId]);
  // Unbound authoritative storage travels byte-for-byte, including declared display order.
  const optionBytes = Buffer.from('["catalog-combination",2,[["enabled","boolean",false],["finish","choice","matte"]]]', "utf8");
  await source.owner.query("UPDATE public.catalog_products SET variant_axes=ARRAY['finish','enabled'] WHERE id=$1", [liveId]);
  await source.owner.query(`UPDATE public.catalog_skus SET option_values='{"finish":{"kind":"choice","value":"matte"},"enabled":{"kind":"boolean","value":false}}'::jsonb,
    canonical_option_bytes=$2,combination_digest=$3 WHERE id=$1`, [liveId, optionBytes, createHash("sha256").update(optionBytes).digest()]);
  const legacyId = randomUUID();
  await source.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'transfer-legacy','Synthetic unmapped')", [legacyId]);
  await source.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,'TRANSFER-LEGACY','Synthetic unmapped')", [legacyId]);
  // A stale revision is derived data: capture counts it without carrying its payload.
  await source.owner.query(`INSERT INTO public.catalog_attribute_projection
    (sku_id,publication_revision,attribute_key,definition_version,value_ordinal,value_kind,text_value)
    VALUES($1,17,'example:stale',1,0,'text','stale-projection-must-not-travel')`, [liveId]);
  target = await resources.installation("catalog-draft-target");
  const pristine = await captureStoreJourney(target.owner, "pristine:catalog-drafts");
  before = await journeyCensus(source.owner);
  expect(before.catalog_attribute_projection).toHaveLength(1);
  // The whole target census must match retained authority with an empty projection.
  before = { ...before, catalog_attribute_projection: [] };
  packet = await captureStoreJourney(source.owner, "draft-source:catalog-drafts");
  expect(before.catalog_skus!.map(row => JSON.parse(row))).toEqual(expect.arrayContaining([expect.objectContaining({
    id: liveId, option_values: { finish: { kind: "choice", value: "matte" }, enabled: { kind: "boolean", value: false } },
    canonical_option_bytes: `\\x${optionBytes.toString("hex")}`,
    combination_digest: `\\x${createHash("sha256").update(optionBytes).digest("hex")}`,
    net_content_dimension: "volume", net_content_scale: 12, net_content_unit: "example:custom-volume",
    gross_mass_dimension: "mass", gross_mass_scale: 12, gross_mass_unit: "example:custom-mass",
  }), expect.objectContaining({ id: legacyId, option_values: null, canonical_option_bytes: null, combination_digest: null })]));
  expect(before.catalog_products!.map(row => JSON.parse(row))).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: liveId, variant_axes: ["finish", "enabled"] }), expect.objectContaining({ id: legacyId, variant_axes: null }),
  ]));
  expect(before.catalog_type_versions).toHaveLength(2);
  expect(before.catalog_definition_installs).toHaveLength(2);
  expect(before.catalog_tax_classes!.map(row => JSON.parse(row).status)).toEqual(["retired"]);
  expect(before.catalog_draft_heads!.map(row => JSON.parse(row).status).sort()).toEqual(["abandoned", "open", "open"]);
  expect(before.catalog_draft_revisions).toHaveLength(9);
  expect(before.catalog_draft_command_receipts).toHaveLength(9);
  expect(before.catalog_draft_sku_reservations).toHaveLength(3);
  expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine }))
    .toEqual({ captureSha256: packet.sha256, replayed: false, neutralizedHistoricalHoldNotifications: 0 });
  expect(packet.outsideProfileCensus.find(entry => entry.relation === "public.catalog_attribute_projection"))
    .toMatchObject({ rows: "1", disposition: "rebuildable" });
  expect(packet.emptyOutsideProfile).not.toContain("public.catalog_attribute_projection");
  expect(JSON.stringify(packet)).not.toContain("stale-projection-must-not-travel");
  expect([...packet.compatible.tables, ...packet.owned].some(entry => String(entry.table) === "catalog_attribute_projection")).toBe(false);
  expect((await target.owner.query("SELECT * FROM public.catalog_attribute_projection")).rows).toEqual([]);
  expect((await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine })).replayed).toBe(true);
  expect((await target.owner.query("SELECT * FROM public.catalog_attribute_projection")).rows).toEqual([]);
  restored = await journeyCensus(target.owner);
}, postgresSetupTimeoutMs);
afterAll(async () => {
  try {
    // One whole-census comparison covers restore and every command replay,
    // including no extra live products, SKUs, prices or other effects.
    if (target && before) expect(await journeyCensus(target.owner)).toEqual(before);
  } finally { await resources.close(); }
}, postgresTeardownTimeoutMs);

describe.each(relations)("%s", relation => {
  // 52 s rounds up 4x the 12,998 ms hosted case in Published Tree CI 43695486286:
  // storeJourneyTransfer.test.ts, "transfers one purchased store to a pristine
  // database and continues its open activation duty through the restricted runtime".
  // Installation and the single restore use the existing setup-hook deadline.
  it("transfer_round_trip_matrix", async () => {
    // PostgreSQL's raw JSON text compares every column, including microsecond
    // timestamps and JSONB payloads, without JavaScript row reserialization.
    expect(before[relation]!.length).toBeGreaterThan(0);
    expect(packet.owned.find(entry => entry.table === relation)!.rows).toEqual(before[relation]);
    expect(restored[relation]).toEqual(before[relation]);
    for (const { canonicalCommand, fingerprint, actorId, result } of commands) {
      if (result.outcome !== "committed") throw new Error("Fixture command did not commit");
      expect(await journeyRpc(target.runtime, "catalog_draft_apply", [canonicalCommand, fingerprint, actorId]))
        .toEqual({ outcome: "replayed", record: result.record });
    }
    for (const pack of packs) {
      expect(await installCatalogDefinitions(target.owner, pack)).toEqual(await installCatalogDefinitions(source.owner, pack));
    }
    const db = await target.owner.connect();
    try {
      await db.query("BEGIN READ ONLY");
      await db.query("SET LOCAL TimeZone='UTC'");
      const rows = await db.query<{ value: string }>(`SELECT to_jsonb(t)::text AS value
        FROM public."${relation}" t ORDER BY to_jsonb(t)::text`);
      expect(rows.rows.map(row => row.value)).toEqual(restored[relation]);
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
  }, 52_000);
});
