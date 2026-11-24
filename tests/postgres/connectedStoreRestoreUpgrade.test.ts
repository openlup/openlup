import { expect, it } from "vitest";
import { captureConnectedNativeStore, type ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { installAccountMutations, installAtAcquisitionSearchPathBoundary } from "./customerAccountMutations.fixture.js";
import { prepareOriginal, sandboxRenewal } from "./subscriptionNativeFixture.js";

type Store = Awaited<ReturnType<typeof installAccountMutations>>;
const ledger = "commerce_checkout_attempt_ledger";
const carriedRows = (packet: ConnectedNativeStoreCapture) => [...packet.compatible.tables, ...packet.owned];

function capture(store: Store, sourceId: string, pristine = false) {
  return captureConnectedNativeStore({
    sourceId, catalogueId: store.inventory, maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
    source: { async withSnapshot(work) {
      const client = await (pristine ? store.migrator : store.owner).connect();
      const restricted = pristine && store.installation.generation === "qualified-admin";
      try {
        if (restricted) await client.query("GRANT platform_acquisition_owner TO account_m WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY account_m");
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        try { if (restricted) await client.query("REVOKE platform_acquisition_owner FROM account_m GRANTED BY account_m"); }
        finally { client.release(); }
      }
    } },
  });
}

async function seed(store: Store) {
  const f = await sandboxRenewal(store.owner);
  await prepareOriginal(store.owner, f);
  const sku = f.snapshot.lines[0].sku;
  await store.owner.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,currency_code,unit_price_minor)
    SELECT $1,id,2,0,'XXX',100 FROM public.catalog_skus WHERE sku=$2`, [f.subscription, sku]);
  await store.owner.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload)
    VALUES($1,'fixture.retained','restore-upgrade-event','{"exact":9007199254740993}')`, [f.subscription]);
  await store.owner.query(`INSERT INTO public.catalog_sku_identifiers(catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,scheme)
    SELECT id,'fixture','gtin','05901234123457','unit',1,'gs1:gtin' FROM public.catalog_skus WHERE sku=$1`, [sku]);
  await store.owner.query(`INSERT INTO public.${ledger}(attempt_digest,requester_digest,email_digest,recorded_at_ms)
    VALUES(repeat('a',64),repeat('b',64),repeat('c',64),9007199254740993)`);
  await store.owner.query(`INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,quote_hash,
    expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,expires_at)
    VALUES($1,'fixture-quote',repeat('b',64),repeat('c',64),1,'[]',28,200,200,'XXX','2026-09-02')`, [f.subscription]);
}

const profiles = ["bootstrap", "separate", "admin-managed", "admin-operator"] as const;

it.each(profiles)("upgrades a populated %s source before capturing and restores every row byte for byte", async profile => {
  const stores: Store[] = [];
  try {
    const source = await installAtAcquisitionSearchPathBoundary(profile, "restore-upgrade-source", "before-pin", "current");
    stores.push(source);
    const earlierInventory = source.inventory;
    await seed(source);
    const { applied } = await source.runner.apply();
    expect(applied).toContainEqual(expect.stringMatching(/_acquisition_definer_search_path_pin\.sql$/u));
    expect(applied).toContainEqual(expect.stringMatching(/_function_search_path_pg_temp\.sql$/u));
    expect(source.inventory).not.toBe(earlierInventory);

    const target = await installAccountMutations(profile, false, "restore-upgrade-target");
    stores.push(target);
    if (target.installation.generation === "legacy") throw new Error("Qualified restore target required");
    expect(source.inventory).toBe(target.inventory);

    const packet = await capture(source, "upgraded-source");
    const ledgerRows = packet.compatible.tables.find(entry => entry.table === ledger)?.rows;
    expect(ledgerRows).toEqual([expect.stringContaining('"recorded_at_ms": 9007199254740993')]);
    expect(packet.owned.find(entry => entry.table === "subscription_edit_quotes")?.rows).toHaveLength(1);

    const freshTarget = await capture(target, "pristine-target", true);
    const input = { owner: target.migrator, installation: target.installation, packet, freshTarget };
    expect(await restoreConnectedNativeStore(input)).toMatchObject({ captureSha256: packet.sha256, replayed: false });
    expect(await restoreConnectedNativeStore(input)).toMatchObject({ captureSha256: packet.sha256, replayed: true });
    expect(carriedRows(await capture(target, "restored-target"))).toEqual(carriedRows(packet));
  } finally {
    await Promise.all(stores.map(store => store.close()));
  }
}, postgresSetupTimeoutMs);
