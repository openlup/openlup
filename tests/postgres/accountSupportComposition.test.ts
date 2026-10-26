import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { checkReadiness, createSchemaProbe, type RequiredSchema, type ReadinessReport } from "@openlup/core/readiness";
import { createOperatorRecovery, createPostgresOperatorAuthority, type AccountSupportCapabilities } from "@openlup/platform/account-support";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import { createM12AccountSupportReferenceBinding, createM12OperatorSubscriptionActionRoute } from "../../server/runtime/public-reference/m12AccountSupportBinding.js";
import { createM11CommerceReferenceBinding } from "../../server/runtime/public-reference/m11CommerceBinding.js";
import { fixture, nativeHarness, openCase, replacement, units } from "../helpers/fulfillmentNative.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { AT, call, later, prepareOriginal, renewal } from "./subscriptionNativeFixture.js";
import { applyOperatorSubscriptionAction } from "../../src/domains/support/customer360Client.js";

const h = nativeHarness("m12-composition");
beforeAll(() => h.start(), postgresSetupTimeoutMs);
afterAll(() => h.stop(), postgresTeardownTimeoutMs);
const unavailable = { supported: false as const, refusalCode: "host_binding_required" as const };
const capabilities: AccountSupportCapabilities = {
  graph: "native", accountRead: unavailable, customer360Read: unavailable, invoiceAccess: unavailable,
  commerceRecovery: unavailable, configuredPurchase: unavailable, paymentMethodSetup: { supported: false, refusalCode: "unsupported" },
  operatorContact: { supported: false, refusalCode: "operator_subscription_authority_unavailable" }, operatorSubscription: { supported: true },
  subscriptions: NATIVE_SUBSCRIPTION_CAPABILITIES, communicationGifts: { supported: false, refusalCode: "unsupported_preference" },
};

it("P1 probes the full installed catalogue and delegates the R5 API route to R4's native store and receipt", async () => {
  const f = await renewal(h.pool), operator = randomUUID(), principal = randomUUID();
  await h.pool.query("DELETE FROM public.subscription_renewal_operations WHERE id=$1", [f.operation]);
  await h.pool.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2),($3,$4)", [operator, `${operator}@example.invalid`, principal, `${principal}@example.invalid`]);
  await h.pool.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',$2)", [operator, AT]);
  await h.pool.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)", [operator]);
  await h.pool.query("UPDATE public.clients SET principal_id=$2,lifecycle_stage='customer' WHERE id=$1", [f.client, principal]);
  await h.pool.query("UPDATE public.subscriptions SET next_cycle_at=$2,started_at='2026-01-01' WHERE id=$1", [f.subscription, later(240)]);
  await h.pool.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [f.subscription]);
  let transactions = 0;
  const authority = createPostgresOperatorAuthority({ async run(work) {
    transactions++; const db = await h.pool.connect();
    try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
    catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  } }, { operatorId: operator, now: () => Date.parse(AT), recoveryPath: token => `/repair?token=${token}` });
  const api = createOperatorRecovery({ graph: "native", authority });
  const execute = vi.spyOn(api, "execute");
  const operatorRoute = createM12OperatorSubscriptionActionRoute(execute);
  // Full identity comes from all ordered migration bytes and the runner's checked ledger.
  const version = createHash("sha256").update(JSON.stringify(units)).digest("hex");
  const catalogue = { version, migration: units.at(-1)!.file };
  const probe = createSchemaProbe({ query: (text, values) => h.pool.query(text, values ? [...values] : undefined) }, async () => {
    const status = await h.runner().status();
    return { database: "m12-disposable", version: status.pending.length === 0 && status.applied.length === units.length ? version : null };
  });
  const objects: RequiredSchema["objects"] = [
    ...["subscriptions", "subscription_command_receipts", "customer_support_subscription_commands", "customer_support_subscription_audit_events"].map(name => ({ kind: "table" as const, name: `public.${name}` })),
    { kind: "function", name: "public.customer_support_apply_subscription_action_v1", signature: "uuid,uuid,text,jsonb,integer,text,timestamp with time zone" },
    // Command-only selection includes preview and apply, without starting a runner.
    ...["subscription_command_preview", "subscription_command_apply"].map(name => ({ kind: "function" as const, name: `public.${name}`, signature: "uuid,uuid,text,uuid,text,jsonb,timestamp with time zone" })),
  ];
  const binding = createM12AccountSupportReferenceBinding({ enabled: true, graph: "native", capabilities, commerce: null,
    operations: { operator: operatorRoute }, routes: [{ id: "operator", handle: operatorRoute }], dependsOn: [], version: "0.26.0", catalogue, ownerSchemas: [], requiredObjects: objects,
    readiness: async (schema): Promise<ReadinessReport> => checkReadiness({
      candidate: { artifact: "r5a", configuration: "native", environment: "local", database: "m12-disposable", schema: version }, inventoryComplete: true,
      loadedPackages: [{ name: "@openlup/core", version: "0.26.0", kind: "kernel" }, { name: "@openlup/platform", version: "0.26.0", kind: "rail", modules: ["account-support"] }],
      contributions: [{ ...binding.contributions[0]!, manifest: { ...binding.contributions[0]!.manifest, requiredSchema: schema } }],
      vocabulary: [], exemptions: [], bindings: { ports: binding.ports, routes: binding.routes, triggers: binding.triggers, env: {} }, schemaProbe: probe,
    }),
  });
  expect(transactions).toBe(0); expect(await binding.readiness()).toEqual({ kind: "ready" });
  const key = `composition-${randomUUID()}`;
  const request: Parameters<typeof operatorRoute>[0] = { actor: { operatorId: operator, graph: "native", role: "admin", isMachineActor: false },
    subject: { subjectId: f.client, subscriptionId: f.subscription }, command: { action: "apply_subscription_action", subscriptionId: f.subscription,
      subscriptionAction: "pause", expectedVersion: 1, idempotencyKey: key, payload: { pausePreset: "indefinite" } }, idempotencyKey: key, expectedVersion: 1, reason: null, evidence: [] };
  const route = binding.routes["@openlup/platform/account-support:operator"] as typeof binding.services.operations.operator;
  const result = await route(request);
  expect(transactions).toBe(1); expect(result).toMatchObject({ outcome: "applied", subscriptionStatus: "paused" });
  expect(result).not.toHaveProperty("ownerReceipt");
  expect(await execute.mock.results[0]!.value).toMatchObject({ outcome: "applied", ownerReceipt: { actorId: operator } });
  const stored = (await h.pool.query("SELECT response,xmin::text FROM public.customer_support_subscription_commands WHERE idempotency_key=$1", [key])).rows;
  expect(stored).toHaveLength(1);
  // SQL stores its internal action/timestamptz spelling; the donor BFF adds
  // command metadata after R4 decodes the settled result into ISO instants.
  const expectedWire = { contractVersion: "support.customer_360.v2",
    action: "apply_subscription_action", subscriptionAction: "pause", subscriptionId: f.subscription,
    outcome: "applied", subscriptionStatus: stored[0].response.subscriptionStatus,
    nextCycleAt: new Date(stored[0].response.nextCycleAt).toISOString(), templateVersion: stored[0].response.templateVersion,
    eventId: stored[0].response.eventId, appliedBy: stored[0].response.appliedBy };
  expect(result).toEqual(expectedWire);
  expect(await applyOperatorSubscriptionAction("operator-token", request.command, {
    fetcher: async () => Response.json({ ok: true, data: result }),
  })).toEqual(result);
  expect((await h.pool.query("SELECT status FROM public.subscriptions WHERE id=$1", [f.subscription])).rows).toEqual([{ status: "paused" }]);
  const replayed = await route(request);
  expect(replayed).toEqual({ ...expectedWire, outcome: "replayed" });
  expect(replayed).not.toHaveProperty("ownerReceipt");
  expect(await execute.mock.results[1]!.value).toMatchObject({ outcome: "replayed", ownerReceipt: { actorId: operator } });
  expect(await applyOperatorSubscriptionAction("operator-token", request.command, {
    fetcher: async () => Response.json({ ok: true, data: replayed }),
  })).toEqual(replayed);
  expect((await h.pool.query("SELECT response,xmin::text FROM public.customer_support_subscription_commands WHERE idempotency_key=$1", [key])).rows).toEqual(stored);
});


it("P2 selected commerce recovery reaches native persistence once through R5 and preserves row/xmin state", async () => {
  const subscription = await renewal(h.pool), prepared = await prepareOriginal(h.pool, subscription);
  const held = await renewal(h.pool);
  await call(h.pool, "fulfillment_reserve_subscription_renewal", [held.operation, held.token, 900, AT]);
  const delivery = await fixture(h.pool);
  await openCase(h.pool, delivery, "protect"); await replacement(h.pool, delivery);
  await h.pool.query("UPDATE public.commerce_settlement_intents SET status='failed' WHERE id=$1", [prepared.settlementIntentId]);
  await h.pool.query("UPDATE public.commerce_orders SET created_at=now()-interval '2 hours' WHERE id=$1", [prepared.orderId]);
  const order = randomUUID();
  await h.pool.query("INSERT INTO public.commerce_orders(id,client_id,status,created_at) VALUES($1,$2,'pending_payment',now()-interval '2 hours')", [order, subscription.client]);
  await h.pool.query(`INSERT INTO public.commerce_settlement_intents(order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key)
    VALUES($1,'fixture','failed',200,$2,$3)`, [order, subscription.snapshot.currency, `settlement:${order}`]);
  const snapshot = async () => ({
    subscriptions: (await h.pool.query("SELECT *,xmin::text AS row_version FROM public.subscriptions ORDER BY id")).rows,
    reservations: (await h.pool.query("SELECT *,xmin::text AS row_version FROM public.fulfillment_inventory_reservations ORDER BY id")).rows,
    alignment: (await h.pool.query("SELECT *,xmin::text AS row_version FROM public.subscription_delivery_alignment_cases ORDER BY id")).rows,
    shipments: (await h.pool.query("SELECT *,xmin::text AS row_version FROM public.fulfillment_shipments ORDER BY id")).rows,
    orders: (await h.pool.query("SELECT *,xmin::text AS row_version FROM public.commerce_orders ORDER BY id")).rows,
  });
  const before = await snapshot();
  expect(before.reservations.map(row => row.status)).toEqual(expect.arrayContaining(["committed", "held"]));
  expect(before.alignment.length).toBeGreaterThan(0);
  const version = createHash("sha256").update(JSON.stringify(units)).digest("hex");
  const catalogue = { version, migration: units.at(-1)!.file };
  const probe = createSchemaProbe({ query: (text, values) => h.pool.query(text, values ? [...values] : undefined) }, async () => {
    const status = await h.runner().status();
    return { database: "m12-disposable", version: status.pending.length === 0 && status.applied.length === units.length ? version : null };
  });
  const executor = { query: vi.fn((text: string, values?: unknown[]) => h.pool.query(text, values)) };
  const readiness = async (schema: RequiredSchema): Promise<ReadinessReport> => checkReadiness({
      candidate: { artifact: "r5b", configuration: "native", environment: "local", database: "m12-disposable", schema: version }, inventoryComplete: true,
      loadedPackages: [{ name: "@openlup/core", version: "0.27.0", kind: "kernel" }, { name: "@openlup/platform", version: "0.27.0", kind: "rail", modules: ["account-support", "commerce"] }],
      contributions: binding.contributions.map(contribution => ({ ...contribution, manifest: { ...contribution.manifest, requiredSchema: schema } })),
      vocabulary: [], exemptions: [], bindings: { ports: binding.ports, routes: binding.routes, triggers: binding.triggers, env: {} }, schemaProbe: probe,
    });
  const commerceOwner = createM11CommerceReferenceBinding({ enabled: true, executor, commerce: {}, version: "0.27.0", catalogue,
    requiredObjects: [{ kind: "function", name: "public.inventory_new_purchase_stock_read", signature: "text,jsonb,timestamp with time zone" }],
    readiness });
  const binding = createM12AccountSupportReferenceBinding({ enabled: true, graph: "native", capabilities: { ...capabilities, commerceRecovery: { supported: true } },
    operations: {}, commerce: {}, commerceOwner, commerceRegistry: new Map(), ownerSchemas: [], requiredObjects: [], dependsOn: [],
    version: "0.27.0", catalogue, readiness });
  expect(executor.query).not.toHaveBeenCalled(); expect(await binding.readiness()).toEqual({ kind: "ready" });
  const enqueue = binding.commerceOwner!.services.recoveryReminders;
  expect(binding.ports["@openlup/platform/commerce:recoveryReminders"]).toBe(enqueue);
  expect(await enqueue(10)).toEqual({ enqueued1h: 1, enqueued20h: 0 });
  const reminders = async () => (await h.pool.query(`SELECT id,aggregate_id,idempotency_key,payload,xmin::text AS row_version
    FROM public.outbox_events WHERE event_type='commerce.checkout_recovery' ORDER BY id`)).rows;
  const first = await reminders();
  expect(first).toEqual([{ id: expect.any(String), aggregate_id: order, idempotency_key: `checkout_recovery:1h:${order}`,
    payload: { orderId: order, mode: "one_time", reminderHours: 1, expiresAt: expect.any(String) }, row_version: expect.any(String) }]);
  expect(await enqueue(10)).toEqual({ enqueued1h: 0, enqueued20h: 0 });
  expect(await reminders()).toEqual(first); expect(await snapshot()).toEqual(before);
  expect(executor.query).toHaveBeenCalledTimes(2);
});
