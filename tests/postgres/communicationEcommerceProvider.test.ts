import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresOutboxStore } from "@openlup/outbox/postgres";
import { runOutboxDispatchWorker, uniqueRegistry } from "@openlup/outbox";
import { PLATFORM_EVENT_VOCABULARY } from "@openlup/core/outbox";
import { ecommerceInstallation, ecommercePaid } from "./communicationEcommerceFixture.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { createA1ReferenceBinding, type A1HostInputs } from "../../server/runtime/communications/a1ReferenceBinding.js";
import { createPostgresEcommerceEventHandler, createPostgresEcommerceEventProjection, ecommerceEventExportRequestSchema, ECOMMERCE_EXPORT_EVENT_TYPE } from "@openlup/platform/communications";
import type { EcommerceEventExportRequest } from "@openlup/platform/communications/contracts";
import { currencyExponent } from "@openlup/platform/market-packs";

let installation: Awaited<ReturnType<typeof ecommerceInstallation>>;
const now = () => new Date("2026-11-11T13:00:00.000Z");
beforeAll(async () => { installation = await ecommerceInstallation(); }, postgresSetupTimeoutMs);
afterAll(async () => { await installation?.close(); }, postgresTeardownTimeoutMs);

/** Actual adapter through the existing reference boundary, with synthetic account
 * qualification and fake HTTP. This does not certify any provider account. */
async function providerFixture(response?: () => Promise<Response>) {
  const binding = { account: "offline:provider", environment: "test", namespace: "synthetic", mappingVersion: "ecommerce-v1" };
  const candidate = { artifact: "synthetic", configuration: "explicit", environment: "test", database: "disposable", schema: "synthetic" };
  const values = new Map<string, string>();
  const state = { current: true, retained: undefined as EcommerceEventExportRequest | undefined, now: now().getTime(), calls: [] as Record<string, unknown>[] };
  const marketing: A1HostInputs["marketing"] = {
    binding, audience: { kind: "account-wide" }, subjectMapper: reference => reference === "subject:1" ? {
      binding, subjectReference: reference, id: "owned_1", generation: 1, erased: false, email: "synthetic@example.invalid", externalReference: "local:1", ownedFields: [], ownedProperties: [],
    } : undefined,
    authorizations: new Map(), localEvidence: new Map(), resolveCredential: () => ({ binding, key: "synthetic-only" }),
    storage: { availability: { account: binding.account, environment: binding.environment, busy: false, quarantined: false },
      get: async key => values.get(key) ?? null,
      compareAndSwap: async (key, expected, next) => { if ((values.get(key) ?? null) !== expected) return false; values.set(key, next); return true; } },
    now: () => state.now, rateIntervalMs: 1,
    events: { liveSinceMs: new Date("2026-11-11T11:00:00.000Z").getTime(),
      authorize: request => state.current && JSON.stringify(request) === JSON.stringify(state.retained),
      verification: { binding, revision: "2026-07-15", evidenceReference: "offline:synthetic-not-TEST", scopes: ["events:write"],
        sourceTypes: ["order.paid"], accountEffectsVerified: true, messageOwnershipVerified: true } },
    fetch: async (_url, input) => { state.calls.push(JSON.parse(String(input?.body))); state.now += 2; return response ? response() : new Response(null, { status: 202 }); },
  };
  const inputs: A1HostInputs = {
    migrationIdentity: candidate.schema,
    admission: { candidate, currentIdentity: () => candidate,
      observed: { loadedPackages: [{ name: "@openlup/core", version: "0.38.0", kind: "kernel" }, { name: "@openlup/platform", version: "0.38.0", kind: "rail" }], inventoryComplete: true },
      schemaProbe: { observe: async required => ({ database: candidate.database, version: candidate.schema, objects: required.objects.map(object => ({ object, present: true })) }) } },
    sender: { environmentTagName: "synthetic_env", policy: () => { throw new Error("unexpected email"); } },
    callback: { port: { findSend: async () => null, applyObservation: async () => {}, recordAttempt: async () => {} }, webhookSecret: "synthetic", environmentTagName: "synthetic_env", resolveReceiverEnvironmentTag: () => "non_production" },
    marketing,
    delivery: { database: { connectionString: "postgresql://unused.invalid/synthetic" }, options: { binding: "synthetic" }, resolveCredential: () => { throw new Error("unexpected credential"); }, now: () => now().toISOString(), graceMinutes: 1, limit: 1 },
  };
  const selected = (await createA1ReferenceBinding({ enabled: true, loadHostInputs: () => inputs }))!;
  return { binding, state, provider: selected.ports.marketing.events };
}

async function projectedPaid(response?: () => Promise<Response>) {
  const h = await providerFixture(response);
  const fact = await installation.withTransaction(db => ecommercePaid(db));
  const projection = createPostgresEcommerceEventProjection({ binding: h.binding, liveSince: new Date("2026-11-11T11:00:00.000Z"),
    currency: { code: "USD", exponent: currencyExponent("USD"), provenance: "market-packs.currencyExponent:USD" }, now,
    withTransaction: installation.withTransaction,
    resolveTarget: async () => ({ subjectReference: "subject:1", profileId: "owned_1", generation: 1, authorityReference: "authority:paid:1" }) });
  await projection.initialize();
  expect((await projection.project()).projected).toBe(1);
  const duty = (await installation.db.query("SELECT id,payload FROM public.outbox_events WHERE event_type=$1 AND aggregate_id=$2::uuid", [ECOMMERCE_EXPORT_EVENT_TYPE, fact.order])).rows[0];
  const request = ecommerceEventExportRequestSchema.parse(duty.payload);
  h.state.retained = structuredClone(request);
  const handler = createPostgresEcommerceEventHandler({ binding: h.binding, provider: h.provider, now,
    withTransaction: installation.withTransaction, authorize: async () => h.state.current });
  const dispatch = () => runOutboxDispatchWorker({ store: createPostgresOutboxStore(installation.db), registry: uniqueRegistry([handler]),
    knownEventTypes: PLATFORM_EVENT_VOCABULARY.map(row => row.eventType),
    config: { batchSize: 10, maxAttempts: 8, visibilitySeconds: 300, backoffBaseSeconds: 1, backoffCapSeconds: 60, snoozeSeconds: 60, maxSnoozes: 8, softBudgetMs: 20000 } });
  return { ...h, fact, projection, duty, request, dispatch };
}

it("exports a real retained paid fact through PostgreSQL projection/outbox and the actual adapter once", async () => {
  const h = await projectedPaid();
  const settled = (await installation.db.query("SELECT outcome FROM public.commerce_settlement_transitions WHERE intent_id=$1::uuid", [h.fact.intent])).rows;
  expect(settled).toContainEqual(expect.objectContaining({ outcome: "succeeded" }));
  expect(await h.dispatch()).toMatchObject({ processed: 1, discarded: 0 });
  expect(h.state.calls).toHaveLength(1);
  expect(h.state.calls[0]).toMatchObject({ data: { attributes: { unique_id: `paid:${h.fact.order}`, value: 12.34, value_currency: "USD",
    profile: { data: { id: "owned_1" } }, metric: { data: { attributes: { name: "Placed Order" } } } } } });
  expect(await h.projection.project()).toEqual({ projected: 0, refused: 0, deferred: 0 });
  expect(await h.dispatch()).toMatchObject({ processed: 0, claimed: 0 });
  expect(h.state.calls).toHaveLength(1);
  expect((await installation.db.query("SELECT state FROM public.communication_event_receipts WHERE outbox_event_id=$1::uuid", [h.duty.id])).rows[0].state).toBe("accepted");
  expect((await installation.db.query("SELECT status FROM public.outbox_events WHERE event_type='commerce.order.paid' AND aggregate_id=$1::uuid", [h.fact.order])).rows[0].status).toBe("pending");
});

it("refuses revoked local authority after real enqueue without HTTP or undoing paid truth", async () => {
  const h = await projectedPaid(); h.state.current = false;
  expect(await h.dispatch()).toMatchObject({ processed: 0, discarded: 1 });
  expect(h.state.calls).toHaveLength(0);
  expect((await installation.db.query("SELECT status FROM public.commerce_orders WHERE id=$1::uuid", [h.fact.order])).rows[0].status).toBe("paid");
  expect((await installation.db.query("SELECT status FROM public.outbox_events WHERE id=$1::uuid", [h.duty.id])).rows[0].status).toBe("discarded");
  expect((await installation.db.query("SELECT state FROM public.communication_event_receipts WHERE outbox_event_id=$1::uuid", [h.duty.id])).rows[0].state).toBe("refused");
  expect((await installation.db.query("SELECT metadata->>'retainPayload' AS pin FROM public.outbox_events WHERE id=$1::uuid", [h.duty.id])).rows[0].pin).toBeNull();
});

it("completes a separate commerce invocation while export HTTP is still pending", async () => {
  let enter!: () => void, release!: (response: Response) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<Response>(resolve => { release = resolve; });
  const h = await projectedPaid(async () => { enter(); return held; });
  const exporting = h.dispatch();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let targetEffects = 0;
  try {
    await entered;
    const commerce = runOutboxDispatchWorker({
      store: createPostgresOutboxStore(installation.db),
      registry: uniqueRegistry([{ eventType: "commerce.order.paid", timeoutMs: 100,
        async handle(row) { if (row.aggregate_id === h.fact.order) targetEffects++; return { kind: "processed" as const }; } }]),
      knownEventTypes: PLATFORM_EVENT_VOCABULARY.map(row => row.eventType),
      config: { batchSize: 10, maxAttempts: 8, visibilitySeconds: 300, backoffBaseSeconds: 1,
        backoffCapSeconds: 60, snoozeSeconds: 60, maxSnoozes: 8, softBudgetMs: 20000 },
    });
    // The fake endpoint stays unresolved. Progress must precede its timeout.
    const progressed = await Promise.race([commerce.then(result => result.processed > 0),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
    expect(progressed).toBe(true);
    expect(targetEffects).toBe(1);
    expect(h.state.calls).toHaveLength(1);
    expect((await installation.db.query("SELECT status FROM public.outbox_events WHERE id=$1::uuid", [h.duty.id])).rows[0].status).toBe("processing");
  } finally {
    clearTimeout(timer);
    release(new Response(null, { status: 202 }));
    await exporting;
  }
  expect((await installation.db.query("SELECT status FROM public.commerce_orders WHERE id=$1::uuid", [h.fact.order])).rows[0].status).toBe("paid");
});
