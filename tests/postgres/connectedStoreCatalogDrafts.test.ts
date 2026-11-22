import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalCatalogSubscriptionProfileJson } from "@openlup/core/catalog";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalCatalogDraftJson, installCatalogDefinitions, readInstalledCatalogSubscriptionProfile, withCatalogPublicationRules, type CatalogDraftPublicationStoredApplyResult as CatalogDraftApplyResult,
  type CatalogDraftPublicationStoredCommand as CatalogDraftCommand, type CatalogDraftPayloadV2, type CatalogDraftPayloadV3 } from "@openlup/platform/catalog";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeyCensus, journeyRpc, journeySelection, storeJourneyResources,
  type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
const artifact = readFileSync(new URL("../../examples/neutral-store/owned/catalogue-rules.cjs", import.meta.url), "utf8");

const relations = ["catalog_draft_heads", "catalog_draft_revisions", "catalog_draft_command_receipts", "catalog_draft_sku_reservations",
  "catalog_type_versions", "catalog_definition_installs", "catalog_tax_classes", "catalog_skus", "catalog_products"] as const;
const profile = { key: "example:transfer-profile", version: 1, allowedCadences: [{ schemaVersion: 1, kind: "fixed_days", days: 28 }],
  policyRef: { key: "example:transfer-policy", version: 1 }, policyDigest: "a".repeat(64) } as const;
const packs = [1, 2].map(version => withCatalogPublicationRules({ id: "example:transfer", namespace: "example", version, openlupRange: "0.44.x", capabilities: { publish: false },
  types: [{ key: "example:transfer-item", version, units: [{ code: "openlup:piece", dimension: "count" as const, integral: true }],
    netContentUnits: ["openlup:piece"], dimensions: [], validateContent: () => [],
    ...(version === 2 && { subscriptionProfileRef: { key: profile.key, version: profile.version } }) }],
  ...(version === 2 && { subscriptionProfiles: [{ key: profile.key, version: profile.version }], subscriptionProfileDefinitions: [profile] }),
  taxClasses: [{ key: "example:transfer-standard" }] }, () => Buffer.from(artifact)));
const resources = storeJourneyResources();
let source: JourneyInstallation, target: JourneyInstallation;
let before: Awaited<ReturnType<typeof journeyCensus>>, restored: typeof before;
let packet: Awaited<ReturnType<typeof captureStoreJourney>>, pristine: typeof packet;
let commands: { canonicalCommand: string; fingerprint: string; actorId: string; result: CatalogDraftApplyResult }[];

async function traceRestore(owner: Pool, check: () => Promise<void>): Promise<string[]> {
  let statements: string[] = [];
  let stopTracing = () => {};
  const trace = (client: PoolClient) => {
    const query = vi.spyOn(client, "query");
    stopTracing = () => {
      statements = query.mock.calls.flatMap(([sql]) => typeof sql === "string" ? [sql] : []);
      query.mockRestore();
    };
  };
  owner.once("acquire", trace);
  try { await check(); }
  finally {
    owner.removeListener("acquire", trace);
    stopTracing();
  }
  return statements;
}

function expectNoWrites(statements: string[]): void {
  expect(statements.filter(sql => /^(INSERT|UPDATE|DELETE|GRANT|REVOKE|ALTER)\b/iu.test(sql.trim()))).toEqual([]);
}

async function withChangedInstallReceipts(change: (row: string) => string): Promise<typeof packet> {
  const corrupted = structuredClone(packet);
  const installs = corrupted.owned.find(entry => entry.table === "catalog_definition_installs")!;
  // Match capture's exact PostgreSQL row encoding after changing the proof fields.
  const { rows } = await source.owner.query<{ value: string }>(
    "SELECT payload::jsonb::text AS value FROM unnest($1::text[]) AS input(payload)", [installs.rows.map(change)]);
  installs.rows = rows.map(row => row.value);
  return rehashCapture(corrupted);
}

function rehashCapture(capture: typeof packet): typeof packet {
  const { sha256: _old, ...body } = capture;
  return { ...body, sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

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
  pristine = await captureStoreJourney(target.owner, "pristine:catalog-drafts");
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
  expect(before.catalog_draft_heads!.map(row => JSON.parse(row).status).sort()).toEqual(["abandoned", "open", "open", "open"]);
  expect(before.catalog_draft_revisions).toHaveLength(12);
  expect(before.catalog_draft_command_receipts).toHaveLength(12);
  expect(before.catalog_draft_sku_reservations).toHaveLength(4);
  // The owner normally inherits REPEATABLE READ on this target.
  await target.owner.query("ALTER DATABASE postgres SET default_transaction_isolation TO 'repeatable read'");
  await target.owner.query("SET default_transaction_isolation TO 'repeatable read'");
  expect((await target.owner.query("SHOW transaction_isolation")).rows).toEqual([{ transaction_isolation: "repeatable read" }]);
  const pristineCensus = await journeyCensus(target.owner);
  for (const rewriteManifest of [false, true]) {
    const corrupted = await withChangedInstallReceipts(row => {
      const value = JSON.parse(row);
      if (!value.receipt.subscriptionProfileDefinitions) return row;
      const changed = { ...profile, policyDigest: "b".repeat(64) };
      value.receipt.subscriptionProfileDefinitions = [{
        ...changed, profileDigest: createHash("sha256").update(canonicalCatalogSubscriptionProfileJson(changed)).digest("hex"),
      }];
      if (rewriteManifest) value.receipt.canonicalManifest = canonicalCatalogDraftJson({
        ...JSON.parse(value.receipt.canonicalManifest),
        subscriptionProfileDefinitions: value.receipt.subscriptionProfileDefinitions,
      });
      return JSON.stringify(value);
    });
    const statements = await traceRestore(target.owner, async () => {
      await expect(restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet: corrupted, freshTarget: pristine }))
        .rejects.toMatchObject({ code: "target_conflict", table: "catalog_definition_installs", cause: "catalog_profile_install_manifest_mismatch" });
    });
    expect(statements).toContainEqual(expect.stringContaining("catalog_definition_install_profile_manifest_matches"));
    expectNoWrites(statements);
    expect(await journeyCensus(target.owner)).toEqual(pristineCensus);
  }
  const reinstall = await target.owner.connect();
  try {
    await reinstall.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const { installedAt: _sourceTime, ...original } = await installCatalogDefinitions(source.owner, packs[1]);
    const receipt = await installCatalogDefinitions(reinstall, packs[1]);
    expect(receipt).toMatchObject(original);
    expect(await installCatalogDefinitions(reinstall, packs[1])).toEqual(receipt);
  } finally {
    try { await reinstall.query("ROLLBACK"); } finally { reinstall.release(); }
  }
  expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine }))
    .toEqual({ captureSha256: packet.sha256, replayed: false, neutralizedHistoricalHoldNotifications: 0 });
  expect(packet.outsideProfileCensus.find(entry => entry.relation === "public.catalog_attribute_projection"))
    .toMatchObject({ rows: "1", disposition: "rebuildable" });
  expect(packet.emptyOutsideProfile).not.toContain("public.catalog_attribute_projection");
  expect(JSON.stringify(packet)).not.toContain("stale-projection-must-not-travel");
  expect([...packet.compatible.tables, ...packet.owned].some(entry => String(entry.table) === "catalog_attribute_projection")).toBe(false);
  expect((await target.owner.query("SELECT * FROM public.catalog_attribute_projection")).rows).toEqual([]);
  expect((await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine })).replayed).toBe(true);
  expect(await readInstalledCatalogSubscriptionProfile(target.owner, profile))
    .toEqual(await readInstalledCatalogSubscriptionProfile(source.owner, profile));
  expect((await target.owner.query("SELECT * FROM public.catalog_attribute_projection")).rows).toEqual([]);
  restored = await journeyCensus(target.owner);
}, postgresSetupTimeoutMs);
afterAll(async () => {
  try {
    // One whole-census comparison covers restore and every command replay,
    // including no extra live products, SKUs, prices or other effects.
    if (restored) expect(await journeyCensus(target.owner)).toEqual(before);
  } finally { await resources.close(); }
}, postgresTeardownTimeoutMs);

it("U-1 refuses stripped profile evidence under the original digest before writes and preserves legacy receipts", async () => {
  const destination = await resources.installation("catalog-receipt-presence-target");
  const freshTarget = await captureStoreJourney(destination.owner, "pristine:catalog-receipt-presence");
  const original = await journeyCensus(destination.owner);
  for (const removeManifest of [true, false]) {
    const corrupted = await withChangedInstallReceipts(row => {
      const value = JSON.parse(row);
      if (!value.receipt.subscriptionProfileDefinitions) return row;
      expect(value.receipt.canonicalManifest).toEqual(expect.any(String));
      if (removeManifest) delete value.receipt.canonicalManifest;
      delete value.receipt.subscriptionProfileDefinitions;
      return JSON.stringify(value);
    });
    const statements = await traceRestore(destination.owner, async () => {
      await expect(restoreConnectedNativeStore({ owner: destination.owner, installation: journeySelection, packet: corrupted, freshTarget }))
        .rejects.toMatchObject({ code: "target_conflict", table: "catalog_definition_installs", cause: "catalog_profile_install_manifest_mismatch" });
    });
    expectNoWrites(statements);
    const profileRow = corrupted.owned.find(entry => entry.table === "catalog_definition_installs")!.rows.find(row => JSON.parse(row).pack_version === 2);
    expect(profileRow).toBeDefined();
    await expect(destination.owner.query(`INSERT INTO public.catalog_definition_installs
      SELECT * FROM jsonb_populate_record(NULL::public.catalog_definition_installs, $1::jsonb)`, [profileRow]))
      .rejects.toMatchObject({ code: "22023", message: "catalog_profile_install_manifest_mismatch" });
    expect(await journeyCensus(destination.owner)).toEqual(original);
  }
  await expect(restoreConnectedNativeStore({ owner: destination.owner, installation: journeySelection, packet, freshTarget }))
    .resolves.toMatchObject({ replayed: false });
  expect((await journeyCensus(destination.owner)).catalog_definition_installs).toEqual(before.catalog_definition_installs);
  for (const pack of packs) {
    expect(await installCatalogDefinitions(destination.owner, pack)).toEqual(await installCatalogDefinitions(source.owner, pack));
  }
}, postgresSetupTimeoutMs);

it("C-2 rejects a noncanonical profile manifest even when its digest matches", async () => {
  const destination = await resources.installation("catalog-canonical-manifest-target");
  const freshTarget = await captureStoreJourney(destination.owner, "pristine:catalog-canonical-manifest");
  const original = await journeyCensus(destination.owner);
  const corrupted = await withChangedInstallReceipts(row => {
    const value = JSON.parse(row);
    if (!value.receipt.subscriptionProfileDefinitions) return row;
    value.receipt.canonicalManifest = ` ${value.receipt.canonicalManifest}`;
    const digest = `profiles-v1:${createHash("sha256").update(value.receipt.canonicalManifest).digest("hex")}`;
    value.manifest_digest = digest;
    value.receipt.manifestDigest = digest;
    return JSON.stringify(value);
  });
  const statements = await traceRestore(destination.owner, async () => {
    await expect(restoreConnectedNativeStore({ owner: destination.owner, installation: journeySelection, packet: corrupted, freshTarget }))
      .rejects.toMatchObject({ code: "target_conflict", table: "catalog_definition_installs", cause: "catalog_profile_install_manifest_mismatch" });
  });
  expectNoWrites(statements);
  expect(await journeyCensus(destination.owner)).toEqual(original);
}, postgresSetupTimeoutMs);

it("AC-1 uses the same bidirectional profile reference check on install and restore", async () => {
  const destination = await resources.installation("catalog-profile-reference-target");
  const freshTarget = await captureStoreJourney(destination.owner, "pristine:catalog-profile-reference");
  const original = await journeyCensus(destination.owner);
  const pack = packs[1]!;
  const receipt = await installCatalogDefinitions(source.owner, pack);
  const manifest = JSON.parse(receipt.canonicalManifest!);
  const types = before.catalog_type_versions!.map(row => JSON.parse(row))
    .filter(row => row.version === pack.version).map(row => ({ canonicalDefinition: canonicalCatalogDraftJson(row.definition) }));
  const taxClasses = pack.taxClasses.map(({ key }) => ({ key, label: key }));
  for (const subscriptionProfiles of [[], [...manifest.subscriptionProfiles, { key: "example:undeclared", version: 1 }]]) {
    const canonicalManifest = canonicalCatalogDraftJson({ ...manifest, subscriptionProfiles });
    const manifestDigest = `profiles-v1:${createHash("sha256").update(canonicalManifest).digest("hex")}`;
    const corrupted = await withChangedInstallReceipts(row => {
      const value = JSON.parse(row);
      if (!value.receipt.subscriptionProfileDefinitions) return row;
      value.receipt = { ...value.receipt, canonicalManifest, manifestDigest };
      value.manifest_digest = manifestDigest;
      return JSON.stringify(value);
    });
    const refusal = "catalog_profile_install_manifest_mismatch";
    await expect(destination.owner.query("SELECT public.catalog_definition_install($1,$2,$3)", [
      pack.id, pack.version, { manifest: canonicalManifest, types, taxClasses },
    ])).rejects.toMatchObject({ code: "22023", message: refusal });
    const statements = await traceRestore(destination.owner, async () => {
      await expect(restoreConnectedNativeStore({ owner: destination.owner, installation: journeySelection, packet: corrupted, freshTarget }))
        .rejects.toMatchObject({ code: "target_conflict", table: "catalog_definition_installs", cause: refusal });
    });
    expectNoWrites(statements);
    expect(await journeyCensus(destination.owner)).toEqual(original);
  }
  await expect(restoreConnectedNativeStore({ owner: destination.owner, installation: journeySelection, packet, freshTarget }))
    .resolves.toMatchObject({ replayed: false });
  expect(await installCatalogDefinitions(destination.owner, pack)).toEqual(receipt);
}, postgresSetupTimeoutMs);

it("AC-2 checks admitted source receipt columns before casts or retained-row decoding", async () => {
  for (const fault of ["type", "name"]) {
    const corrupted = structuredClone(packet);
    const installs = corrupted.owned.find(entry => entry.table === "catalog_definition_installs")!;
    if (fault === "type") {
      installs.columns = installs.columns.map(column => column.name === "pack_version" ? { ...column, type: "text" } : column);
      installs.rows = installs.rows.map(row => JSON.stringify({ ...JSON.parse(row), pack_version: "nonnumeric" }));
    } else {
      installs.columns = installs.columns.map(column => column.name === "manifest_digest" ? { ...column, name: "renamed_digest" } : column);
      installs.rows = installs.rows.map(row => {
        const { manifest_digest, ...value } = JSON.parse(row);
        return JSON.stringify({ ...value, renamed_digest: manifest_digest });
      });
      // An unrelated undecodable retained row must not mask the shape refusal.
      corrupted.owned.find(entry => entry.table === "catalog_tax_classes")!.rows = ["invalid JSON"];
    }
    const statements = await traceRestore(target.owner, async () => {
      await expect(restoreConnectedNativeStore({
        owner: target.owner, installation: journeySelection, packet: rehashCapture(corrupted), freshTarget: pristine,
      })).rejects.toMatchObject({ code: "schema_conflict", table: "catalog_definition_installs", remedy: "upgrade the source, then capture" });
    });
    expect(statements).not.toContainEqual(expect.stringContaining("WHERE NOT public.catalog_definition_install_profile_manifest_matches"));
    expectNoWrites(statements);
  }
});

it.each(["source", "target"] as const)("rejects malformed %s capture structure before connecting or decoding rows", async side => {
  const connect = vi.fn();
  const owner = { connect } as unknown as Pool;
  const undecodable = "invalid retained row for structural validation";
  type OwnedTable = typeof packet.owned[number];
  const malformedColumns: ((entry: OwnedTable) => void)[] = [
    entry => { Object.assign(entry, { columns: null }); },
    entry => { delete (entry as Partial<OwnedTable>).columns; },
    entry => { Object.assign(entry, { columns: { 0: entry.columns[0], length: entry.columns.length } }); },
    entry => { Object.assign(entry, { columns: [null, ...entry.columns.slice(1)] }); },
    entry => { Object.assign(entry.columns[0]!, { type: 0 }); },
  ];
  for (const corrupt of malformedColumns) {
    const source = structuredClone(packet);
    const fresh = structuredClone(pristine);
    source.compatible.tables[0]!.rows = [undecodable];
    const selected = side === "source" ? source : fresh;
    const installs = selected.owned.find(entry => entry.table === "catalog_definition_installs")!;
    if (side === "target") {
      // Also present a valid-shaped difference so the malformed target wins.
      const firstColumn = source.owned.find(entry => entry.table === "catalog_definition_installs")!.columns[0]!;
      firstColumn.name = "changed_column";
    }
    corrupt(installs);
    const input = { owner, installation: journeySelection, packet: rehashCapture(source), freshTarget: rehashCapture(fresh) };
    const decode = vi.spyOn(JSON, "parse");
    try {
      await expect(restoreConnectedNativeStore(input)).rejects.toMatchObject({ code: "invalid_input" });
      expect(connect).not.toHaveBeenCalled();
      expect(decode).not.toHaveBeenCalledWith(undecodable);
    } finally {
      decode.mockRestore();
    }
  }
});

const validator = "public.catalog_definition_install_profile_manifest_matches(text,integer,text,jsonb)";

it("U-2 reports schema_conflict before invoking a changed or missing receipt validator", async () => {
  const { rows } = await target.owner.query<{ definition: string }>("SELECT pg_get_functiondef($1::regprocedure) AS definition", [validator]);
  const expectSchemaConflictWithoutValidation = async () => {
    const statements = await traceRestore(target.owner, async () => {
      await expect(restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine }))
        .rejects.toMatchObject({ code: "schema_conflict" });
    });
    expect(statements).not.toContainEqual(expect.stringContaining("WHERE NOT public.catalog_definition_install_profile_manifest_matches"));
    expectNoWrites(statements);
  };
  await target.owner.query(`CREATE OR REPLACE FUNCTION public.catalog_definition_install_profile_manifest_matches(
    p_pack_id text, p_pack_version integer, p_digest text, p_receipt jsonb
  ) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
    BEGIN RAISE EXCEPTION 'unexpected_receipt_validator_execution'; END;
  $$`);
  try {
    await expectSchemaConflictWithoutValidation();
  } finally { await target.owner.query(rows[0].definition); }

  await target.owner.query(`ALTER FUNCTION ${validator} RENAME TO synthetic_hidden_receipt_validator`);
  try {
    await expectSchemaConflictWithoutValidation();
  } finally {
    await target.owner.query(`ALTER FUNCTION public.synthetic_hidden_receipt_validator(text,integer,text,jsonb)
      RENAME TO catalog_definition_install_profile_manifest_matches`);
  }
}, postgresSetupTimeoutMs);

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
