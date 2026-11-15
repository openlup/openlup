import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalCatalogDraftJson, type CatalogDraftApplyResult, type CatalogDraftCommand } from "@openlup/platform/catalog";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeyCensus, journeyRpc, journeySelection, storeJourneyResources,
  type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const relations = ["catalog_draft_heads", "catalog_draft_revisions", "catalog_draft_command_receipts", "catalog_draft_sku_reservations"] as const;
const resources = storeJourneyResources();
let source: JourneyInstallation, target: JourneyInstallation;
let before: Awaited<ReturnType<typeof journeyCensus>>, restored: typeof before;
let packet: Awaited<ReturnType<typeof captureStoreJourney>>;
let commands: { canonicalCommand: string; fingerprint: string; actorId: string; result: CatalogDraftApplyResult }[];

beforeAll(async () => {
  source = await resources.installation("catalog-draft-source");
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
  // A populated live catalogue proves preservation as well as absence of
  // accidental publication of the separate draft product/SKU identities.
  const liveId = randomUUID(), listId = randomUUID();
  await source.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'transfer-live','Synthetic live product')", [liveId]);
  await source.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,'TRANSFER-LIVE','Synthetic live SKU')", [liveId]);
  await source.owner.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic list','ZZ','XXX',clock_timestamp())", [listId]);
  await source.owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'any',123,clock_timestamp())", [listId, liveId]);
  target = await resources.installation("catalog-draft-target");
  const pristine = await captureStoreJourney(target.owner, "pristine:catalog-drafts");
  before = await journeyCensus(source.owner);
  packet = await captureStoreJourney(source.owner, "draft-source:catalog-drafts");
  expect(before.catalog_draft_heads!.map(row => JSON.parse(row).status).sort()).toEqual(["abandoned", "open"]);
  expect(before.catalog_draft_revisions).toHaveLength(5);
  expect(before.catalog_draft_command_receipts).toHaveLength(5);
  expect(before.catalog_draft_sku_reservations).toHaveLength(2);
  expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine }))
    .toEqual({ captureSha256: packet.sha256, replayed: false, neutralizedHistoricalHoldNotifications: 0 });
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
