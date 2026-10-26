import type { AccountSupportCapabilities } from "@openlup/platform/account-support/contracts";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createNativeSubscriptionDriver, createSelfServiceCommandFacade, type LegacySubscriptionRequest } from "@openlup/platform/account-support";
import { createPostgresSubscriptionCommandStore, type SubscriptionQueryExecutor } from "@openlup/platform/subscriptions";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { AT, later, renewal } from "./subscriptionNativeFixture.js";

let container: PostgresContainer | undefined, pool: Pool | undefined;
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("M12 self-service requires real PostgreSQL");
  container = await runPostgresContainer({ name: `m12-r3-self-service-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("M12 PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString });
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { poolFactory: () => pool! }).apply();
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

const capabilities: AccountSupportCapabilities = {
  graph: "native", accountRead: { supported: false, refusalCode: "host_binding_required" },
  customer360Read: { supported: false, refusalCode: "host_binding_required" }, invoiceAccess: { supported: false, refusalCode: "host_binding_required" },
  paymentMethodSetup: { supported: false, refusalCode: "unsupported" }, commerceRecovery: { supported: false, refusalCode: "host_binding_required" },
  configuredPurchase: { supported: false, refusalCode: "host_binding_required" },
  operatorSubscription: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
  operatorContact: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
  subscriptions: NATIVE_SUBSCRIPTION_CAPABILITIES, communicationGifts: { supported: false, refusalCode: "unsupported_preference" },
};

async function fixture() {
  const db = pool!, f = await renewal(db);
  await db.query("DELETE FROM public.subscription_renewal_operations WHERE id=$1", [f.operation]);
  await db.query("UPDATE public.subscriptions SET next_cycle_at=$2,started_at='2026-01-01' WHERE id=$1", [f.subscription, later(200)]);
  const list = (await db.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES('Self-service fixture','ZZ','XXX') RETURNING id")).rows[0].id;
  const sku = (await db.query("SELECT id FROM public.catalog_skus WHERE sku=$1", [f.snapshot.lines[0]!.sku])).rows[0].id;
  await db.query("UPDATE public.subscriptions SET price_list_id=$2,currency_code='XXX' WHERE id=$1", [f.subscription, list]);
  await db.query("UPDATE public.catalog_skus SET sellable_in_subscription=true,status='active' WHERE id=$1", [sku]);
  await db.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,valid_from) VALUES($1,$2,350,'2026-01-01')", [list, sku]);
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,2,0,100,'XXX')", [f.subscription, sku]);
  await db.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [f.subscription]);
  const context = { principalId: randomUUID(), clientId: f.client, graph: "native" as const };
  let now = AT, lastOwnerResult: Record<string, unknown> | undefined;
  const owner = createPostgresSubscriptionCommandStore({
    async withTransaction<T>(work: (executor: SubscriptionQueryExecutor) => Promise<T>): Promise<T> {
      const client = await db.connect();
      try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    },
  });
  const facade = createSelfServiceCommandFacade({ context, capabilities, nativeRawSubscription: {
    async preview(command) { lastOwnerResult = await owner.preview(command); return lastOwnerResult; },
    async apply(command) { lastOwnerResult = await owner.apply(command); return lastOwnerResult; },
  } });
  const driver = createNativeSubscriptionDriver<string, Record<string, unknown>, Record<string, unknown>>({ owner: facade.nativeRawSubscription!, now: () => now, previewProjection: record => record });
  return { ...f, db, sku, list, context, facade, now(at: string) { now = at; },
    preview: (request: LegacySubscriptionRequest) => driver.preview(context, request),
    apply: (request: LegacySubscriptionRequest) => driver.apply(context, request),
    ownerResult: () => lastOwnerResult,
    request(key: string): LegacySubscriptionRequest {
      // M10 update_bundle permits a new core total only when cadence also changes (stored: qty 2 / 28 days).
      return { subscriptionId: f.subscription, action: "update_bundle", idempotencyKey: key,
        payload: { cadenceDays: 21, coreLines: [{ variantId: sku, qty: 3 }], compositionConstraint: { kind: "units", value: 3 }, expectedTemplateVersion: 1 } };
    },
  };
}
/** Retain public row bytes and xmin, including receipts/quotes, to detect writes on replay. */
async function effects() {
  const db = pool!, tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const result: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    const name = String(tablename).replaceAll('"', '""');
    result[name] = (await db.query(`SELECT COALESCE(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${name}" t`)).rows[0];
  }
  return result;
}
async function state(f: Awaited<ReturnType<typeof fixture>>) {
  return (await f.db.query("SELECT status,next_cycle_at,template_version,xmin::text FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0];
}

it("C7 applies the exact bundle owner receipt then persists and replays stale-template refusal", async () => {
  const started = performance.now(), f = await fixture(), request = f.request("bundle-edit");
  const preview = await f.preview(request);
  expect(preview.kind, `bundle preview must project; owner=${JSON.stringify(f.ownerResult())}`).toBe("projected");
  if (preview.kind !== "projected") throw new Error("quote-required");
  const accepted = { ...request, payload: { ...request.payload, acceptedQuoteHash: preview.preview.quoteHash } };
  const applied = await f.apply(accepted); expect(applied).toBe(f.ownerResult());
  expect(applied).toMatchObject({ status: "applied", subscriptionId: f.subscription, action: "update_bundle", templateVersion: 2 });
  expect(applied.commandFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const stored = (await f.db.query("SELECT result,command_fingerprint FROM public.subscription_command_receipts WHERE actor_id=$1 AND idempotency_key=$2", [f.context.principalId, request.idempotencyKey])).rows[0];
  expect(applied).toEqual({ ...stored.result, commandFingerprint: stored.command_fingerprint });
  expect((await f.db.query("SELECT quantity,unit_price_minor::integer AS unit_price_minor FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ quantity: 3, unit_price_minor: 350 }]);
  const next = { ...f.request("stale-edit"), payload: { ...request.payload, expectedTemplateVersion: 2, cadenceDays: 14, coreLines: [{ variantId: f.sku, qty: 4 }], compositionConstraint: { kind: "units", value: 4 } } };
  const quote = await f.preview(next);
  expect(quote.kind, `second bundle preview must project; owner=${JSON.stringify(f.ownerResult())}`).toBe("projected");
  if (quote.kind !== "projected") throw new Error("quote-required");
  await f.db.query("UPDATE public.subscriptions SET template_version=template_version+1 WHERE id=$1", [f.subscription]);
  const stale = { ...next, payload: { ...next.payload, acceptedQuoteHash: quote.preview.quoteHash } };
  const beforeRefusal = await effects(), beforeState = await state(f), beforeEvents = (await f.db.query("SELECT * FROM public.subscription_events WHERE subscription_id=$1", [f.subscription])).rows;
  const refusal = await f.apply(stale); expect(refusal).toBe(f.ownerResult()); expect(refusal).toMatchObject({ status: "refused", reason: "subscription_edit_stale_template" });
  expect(await state(f)).toEqual(beforeState); expect((await f.db.query("SELECT * FROM public.subscription_events WHERE subscription_id=$1", [f.subscription])).rows).toEqual(beforeEvents);
  const afterRefusal = await effects();
  // A stale refusal updates only its existing command receipt.
  const { subscription_command_receipts: _beforeReceipt, ...beforeBusiness } = beforeRefusal;
  const { subscription_command_receipts: _afterReceipt, ...afterBusiness } = afterRefusal;
  expect(afterBusiness).toEqual(beforeBusiness);
  const beforeReplay = await effects(); expect(await f.apply(stale)).toEqual(refusal); expect(await effects()).toEqual(beforeReplay);
  console.info(`C7 ms=${Math.round(performance.now() - started)}`);
});

it("C8 same-day slide is a noop with no event/version write and zero-delta noop replay", async () => {
  const started = performance.now(), f = await fixture();
  const before = await state(f), events = (await f.db.query("SELECT * FROM public.subscription_events WHERE subscription_id=$1", [f.subscription])).rows;
  const request = { ...f.request("same-day-slide"), action: "slide_next_cycle", payload: { newNextCycleAt: new Date(before.next_cycle_at.getTime() + 3_600_000).toISOString() } };
  const result = await f.apply(request); expect(result).toBe(f.ownerResult()); expect(result).toMatchObject({ status: "noop", eventId: null });
  expect(await state(f)).toEqual(before); expect((await f.db.query("SELECT * FROM public.subscription_events WHERE subscription_id=$1", [f.subscription])).rows).toEqual(events);
  const snapshot = await effects(); expect(await f.apply(request)).toEqual({ ...result, status: "replayed", originalStatus: "noop" }); expect(await effects()).toEqual(snapshot);
  console.info(`C8 ms=${Math.round(performance.now() - started)}`);
});

it("C9 replays original receipts after later state/price/expiry and refuses changed payload without writes", async () => {
  const started = performance.now(), f = await fixture(), request = f.request("immutable-receipt");
  const quote = await f.preview(request);
  expect(quote.kind, `bundle preview must project; owner=${JSON.stringify(f.ownerResult())}`).toBe("projected");
  if (quote.kind !== "projected") throw new Error("quote-required");
  const accepted = { ...request, payload: { ...request.payload, acceptedQuoteHash: quote.preview.quoteHash } };
  const original = await f.apply(accepted); expect(original.status).toBe("applied");
  expect(await f.apply({ ...f.request("later-slide"), action: "slide_next_cycle", payload: { newNextCycleAt: later(300) } })).toMatchObject({ status: "applied" });
  await f.db.query("UPDATE public.price_entries SET unit_price_minor=900 WHERE price_list_id=$1", [f.list]); f.now(later(500));
  const before = await effects(); const replay = await f.apply(accepted);
  expect(replay).toBe(f.ownerResult()); expect(replay).toEqual({ ...original, status: "replayed", originalStatus: "applied" }); expect(await effects()).toEqual(before);
  expect(await f.apply({ ...accepted, payload: { ...accepted.payload, coreLines: [{ variantId: f.sku, qty: 4 }] } })).toMatchObject({ status: "refused", reason: "subscription_command_idempotency_conflict" });
  expect(await effects()).toEqual(before);
  console.info(`C9 ms=${Math.round(performance.now() - started)}`);
});
