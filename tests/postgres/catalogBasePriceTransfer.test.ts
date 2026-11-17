import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { canonicalCatalogPriceSetupCommand } from "@openlup/platform/pricing";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeyCensus, journeySelection, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources(), actor = randomUUID(), sku = randomUUID(), list = randomUUID();
let source: JourneyInstallation, target: JourneyInstallation;
let original: Awaited<ReturnType<typeof journeyCensus>>;
let packet: Awaited<ReturnType<typeof captureStoreJourney>>, pristine: typeof packet;
let bytes: string, fingerprint: string, receipt: unknown;
beforeAll(async () => {
  source = await resources.installation("price-source"); target = await resources.installation("price-target");
  pristine = await captureStoreJourney(target.owner, "price-pristine");
  await source.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'price-transfer@example.invalid')", [actor]);
  await source.owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',statement_timestamp())", [actor]);
  await source.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'transfer-price','Synthetic price')", [sku]);
  await source.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,'TRANSFER-PRICE','Synthetic price')", [sku]);
  await source.owner.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic','ZZ','XXX',statement_timestamp()-interval '1 hour')", [list]);
  await source.owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'one_time',1000,statement_timestamp()-interval '1 hour'),($1,$2,'subscription',900,statement_timestamp()-interval '1 hour')", [list, sku]);
  await source.owner.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
  await source.runtime.query("SELECT public.commerce_capture_offer_policy_v2_legacy_baseline()");
  const previous = (await source.owner.query("SELECT id FROM public.price_entries WHERE mode='one_time'")).rows[0].id;
  bytes = canonicalCatalogPriceSetupCommand({ schemaVersion: 1, commandKey: "example:transfer-price", variantId: sku, priceListId: list,
    mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 1200, expected: { entryId: previous, unitPriceMinor: 1000 } });
  fingerprint = createHash("sha256").update(bytes).digest("hex");
  const db = await source.owner.connect();
  try {
    await db.query("BEGIN"); await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor })]);
    receipt = (await db.query("SELECT public.catalog_price_setup_apply($1,$2) AS result", [bytes, fingerprint])).rows[0].result;
    expect(receipt).toMatchObject({ outcome: "committed" }); await db.query("COMMIT");
  } finally { db.release(); }
  original = await journeyCensus(source.owner); packet = await captureStoreJourney(source.owner, "price-source");
}, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

it("transfer_preserves_base_price_receipts_history_and_exact_replay", async () => {
  expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine }))
    .toEqual({ captureSha256: packet.sha256, replayed: false, neutralizedHistoricalHoldNotifications: 0 });
  expect(await journeyCensus(target.owner)).toEqual(original);
  expect(original.catalog_price_setup_receipts).toHaveLength(1);
  const db = await target.owner.connect();
  try {
    await db.query("BEGIN"); await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor })]);
    expect((await db.query("SELECT public.catalog_price_setup_apply($1,$2) AS result", [bytes, fingerprint])).rows[0].result)
      .toEqual({ ...(receipt as Record<string, unknown>), outcome: "replayed" });
    await db.query("COMMIT");
  } finally { db.release(); }
  expect(await journeyCensus(target.owner)).toEqual(original);
  expect((await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine })).replayed).toBe(true);
});
