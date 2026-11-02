import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { fixture as shipmentFixture, openCase, replacement, executor } from "../helpers/fulfillmentNative.js";
import { createPostgresDestinationPort } from "@openlup/platform/commerce/server/destinations";
import { createPostgresDeliveryAlignmentPort } from "@openlup/platform/fulfillment";
import { createPostgresOperatorAuthority } from "@openlup/platform/account-support";
import { AT, later, call, alignmentInvariant } from "./subscriptionNativeFixture.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined, owner: Pool, runtime: Pool;
const selection = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres",
 migrationLogin: "postgres", runtimeLogin: "g3_runtime", restoreLogin: "g3_restore" } as const;
const containerName = `g3-native-${process.pid}`;
const signatures = ["commerce_register_order_destination(text,uuid,jsonb,timestamp with time zone)",
 "commerce_read_destination(text,uuid)", "subscription_change_shipping_destination(uuid,uuid,text,uuid,jsonb,integer,timestamp with time zone)",
 "customer_support_change_shipping_destination(uuid,uuid,jsonb,integer,text,timestamp with time zone)"];
function connect() {
 owner = new Pool({ connectionString: container!.connectionString, options: qualifiedPostgresStartupOptions(selection) });
 const url = new URL(container!.connectionString); url.username = selection.runtimeLogin;
 runtime = new Pool({ connectionString: url.toString(), options: "-c role=service_role", max: 8 });
}
beforeAll(async () => {
 container = await runPostgresContainer({ name: containerName, password: "synthetic-conformance",
  runOptions: ["-e", "PGDATA=/var/lib/postgresql/g3-data"] });
 expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
 const root = new Pool({ connectionString: container.connectionString });
 for (const role of [selection.runtimeLogin, selection.restoreLogin]) await root.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
 await root.end(); connect();
 await createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation: selection, poolFactory: () => owner }).apply();
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, [owner, runtime]); }, postgresTeardownTimeoutMs);
const address = (name = "Old synthetic recipient") => ({ recipientName: name, line1: "Synthetic street 1", city: "Fixture", postalCode: "00000", country: "zz" });
async function fixture(activation = false) {
 const f = await shipmentFixture(owner, null, activation, activation), principal = randomUUID(), operator = randomUUID();
 await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2),($3,$4)", [principal, `${principal}@example.invalid`, operator, `${operator}@example.invalid`]);
 await owner.query("UPDATE public.clients SET principal_id=$2 WHERE id=$1", [f.client, principal]);
 await owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',$2)", [operator, AT]);
 await owner.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)", [operator]);
 const original = await createPostgresDestinationPort(runtime).registerOrder({ idempotencyKey: `register-${f.order}`, orderId: f.order, address: address(), now: AT });
 return { ...f, principal, operator, original };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const change = (f: Fixture, key: string, name = "New synthetic recipient", version = 1, db: Pool | PoolClient = runtime) => call(db,
 "customer_support_change_shipping_destination", [f.operator, f.subscription, { newAddress: address(name) }, version, key, AT]);
it("installs and calls the exact four pinned signatures through the restricted role", async () => {
 expect((await runtime.query("SELECT current_user,session_user")).rows).toEqual([{ current_user: "service_role", session_user: "g3_runtime" }]);
 for (const signature of signatures) {
  const row = (await owner.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure", [`public.${signature}`])).rows[0];
  expect(row).toEqual({ prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] });
 }
 const f = await fixture();
 expect(await call(runtime, "commerce_read_destination", ["order", f.order])).toEqual(f.original);
 const customer = await call(runtime, "subscription_change_shipping_destination", [f.principal, f.client, `customer-${randomUUID()}`, f.subscription, { newAddress: address("Future recipient") }, 1, AT]);
 expect(customer.outcome).toBe("applied_from_next_parcel");
 const result = await change(f, `operator-${randomUUID()}`);
 expect(result.outcome).toBe("applied");
 expect(result.appliedBy).toBe("customer_self_service_delegate");
 expect((await call(runtime, "commerce_read_destination", ["shipment", f.shipment])).destinationId).toBe(result.futureDestinationId);
});
it("narrows both private tables and refuses browser execution", async () => {
 for (const table of ["commerce_destinations", "commerce_destination_bindings"]) {
  await expect(runtime.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
  expect((await owner.query("SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass", [`public.${table}`])).rows).toEqual([{ relrowsecurity: true }]);
 }
 const db = await owner.connect();
 try { await db.query("SET ROLE anon"); await expect(call(db, "commerce_read_destination", ["order", randomUUID()])).rejects.toMatchObject({ code: "42501" }); }
 finally { await db.query("RESET ROLE"); db.release(); }
});
const port = (db: Pool | PoolClient = runtime) => createPostgresDestinationPort(db);
async function counts(f: Fixture) {
 return (await owner.query(`SELECT
 (SELECT count(*)::int FROM public.commerce_destinations WHERE client_id=$1) destinations,
 (SELECT count(*)::int FROM public.subscription_events WHERE subscription_id=$2) events,
 (SELECT count(*)::int FROM public.outbox_events WHERE aggregate_id=$2 AND event_type='subscription.address_changed') notices,
 (SELECT count(*)::int FROM public.customer_support_subscription_commands WHERE target_id=$2) commands,
 (SELECT count(*)::int FROM public.customer_support_subscription_audit_events WHERE target_id=$2) audits`, [f.client, f.subscription])).rows[0];
}
it("retains immutable registration after correction and strictly compares its original key", async () => {
 const f = await fixture(); await change(f, `correct-${randomUUID()}`);
 expect(await port().registerOrder({ idempotencyKey: `register-${f.order}`, orderId: f.order, address: address(), now: later(1) })).toEqual(f.original);
 expect((await port().read("order", f.order)).destinationId).not.toBe(f.original.destinationId);
 const before = await counts(f);
 await expect(port().registerOrder({ idempotencyKey: `register-${f.order}`, orderId: f.order, address: address("Changed"), now: AT })).rejects.toMatchObject({ code: "23505" });
 await expect(port().registerOrder({ idempotencyKey: `different-${f.order}`, orderId: f.order, address: address(), now: AT })).rejects.toMatchObject({ code: "23505" });
 expect(await counts(f)).toEqual(before);
});
it("replays before the version guard; changed input and stale version cannot write another effect", async () => {
 const f = await fixture(), key = `version-${randomUUID()}`;
 const first = await change(f, key); const before = await counts(f);
 await owner.query("UPDATE public.subscriptions SET template_version=2 WHERE id=$1", [f.subscription]);
 expect(await change(f, key)).toEqual({ ...first, outcome: "replayed", replayed: true });
 await expect(change(f, key, "Different")).rejects.toMatchObject({ code: "23505" });
 expect(await counts(f)).toEqual(before);
 const refusalKey = `stale-${randomUUID()}`;
 const refused = await change(f, refusalKey); expect(refused).toMatchObject({ outcome: "conflict", refusalCode: "version_conflict" });
 expect(await change(f, refusalKey)).toEqual(refused);
 expect(await counts(f)).toEqual({ ...before, commands: before.commands + 1, audits: before.audits + 1 });
});
it("normalizes fresh addresses, preserves selection, emits an attributed event and one deduplicated notice", async () => {
 const f = await fixture(), key = `normal-${randomUUID()}`;
 await owner.query("UPDATE public.fulfillment_shipments SET metadata=$2 WHERE id=$1", [f.shipment, { selectedDelivery: { pickupPoint: "synthetic-point" } }]);
 const result = await change(f, key, "  New synthetic recipient  ");
 const doc = await port().read("shipment", f.shipment);
 expect(doc.address).toMatchObject({ recipientName: "New synthetic recipient", country: "ZZ", contactPhone: null, label: null, deliveryNotes: null });
 expect((await owner.query("SELECT metadata FROM public.fulfillment_shipments WHERE id=$1", [f.shipment])).rows[0].metadata).toEqual({ selectedDelivery: { pickupPoint: "synthetic-point" } });
 const event = (await owner.query("SELECT * FROM public.subscription_events WHERE id=$1", [result.eventId])).rows[0];
 expect(event).toMatchObject({ event_type: "subscription.customer_self_service.change_shipping_address", payload: { actorKind: "operator", actorId: f.operator, outcome: "applied", appliesFrom: "current_parcel", futureDestinationId: doc.destinationId } });
 const notices = (await owner.query("SELECT * FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.address_changed'", [f.subscription])).rows;
 expect(notices).toHaveLength(1); expect(notices[0]).toMatchObject({ idempotency_key: `subscription.address_changed:${result.eventId}`, status: "pending", payload: { outcome: "applied", appliesFrom: "current_parcel" } });
 expect(JSON.stringify(notices[0].payload)).not.toContain("Synthetic street");
 await change(f, key, "  New synthetic recipient  ");
 expect(await counts(f)).toMatchObject({ destinations: 2, events: 1, notices: 1, commands: 1, audits: 1 });
 await owner.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
 SELECT aggregate_type,aggregate_id,event_type,idempotency_key,payload FROM public.outbox_events WHERE id=$1
 ON CONFLICT(event_type,idempotency_key) DO NOTHING`, [notices[0].id]);
 expect((await counts(f)).notices).toBe(1);
});
it("rolls back the address, bindings, event and receipts if the confirmation INSERT fails", async () => {
 const f = await fixture(), before = await counts(f);
 await owner.query("ALTER TABLE public.outbox_events ADD CONSTRAINT g3_test_notice_fault CHECK(event_type <> 'subscription.address_changed') NOT VALID");
 try { await expect(change(f, `fault-${randomUUID()}`)).rejects.toMatchObject({ code: "23514" }); }
 finally { await owner.query("ALTER TABLE public.outbox_events DROP CONSTRAINT g3_test_notice_fault"); }
 expect(await counts(f)).toEqual(before);
 expect(await port().read("order", f.order)).toEqual(f.original);
 expect((await owner.query("SELECT count(*)::int n FROM public.commerce_destination_bindings WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ n: 0 }]);
});
it("allows address during open dunning without a method, but preserves the donor next-cycle lock", async () => {
 const f = await fixture();
 await owner.query("INSERT INTO public.subscription_dunning_cases(subscription_id,client_id,idempotency_key) VALUES($1,$2,$3)", [f.subscription, f.client, `dunning-${f.subscription}`]);
 expect(await call(runtime, "subscription_command_apply", [f.principal, f.client, `pause-${randomUUID()}`, f.subscription, "pause", {}, AT])).toMatchObject({ status: "refused", reason: "subscription_command_payment_blocked" });
 expect(await port().changeShippingAddress({ actorId: f.principal, clientId: f.client, idempotencyKey: `address-${randomUUID()}`, subscriptionId: f.subscription, newAddress: address("Future during dunning"), expectedVersion: 1, now: AT })).toMatchObject({ outcome: "applied_from_next_parcel" });
 const next = (await owner.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].next_cycle_at;
 await owner.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'payment_pending')", [f.subscription, next]);
 expect(await change(f, `locked-${randomUUID()}`)).toMatchObject({ outcome: "refused", refusalCode: "payment_blocked" });
 expect((await owner.query("SELECT status FROM public.subscription_dunning_cases WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ status: "open" }]);
});
it("refuses invalid/saved addresses, foreign customers and machine operators without an address effect", async () => {
 const f = await fixture(), before = await counts(f);
 expect(await call(runtime, "customer_support_change_shipping_destination", [f.operator, f.subscription, { shippingAddressId: f.original.destinationId }, 1, `saved-${randomUUID()}`, AT])).toMatchObject({ outcome: "refused", refusalCode: "invalid_address" });
 await expect(call(runtime, "customer_support_change_shipping_destination", [f.operator, f.subscription, { newAddress: { ...address(), line2: "" } }, 1, `empty-${randomUUID()}`, AT])).rejects.toMatchObject({ code: "22023", message: "customer_support_subscription_command_invalid" });
 await expect(call(runtime, "subscription_change_shipping_destination", [randomUUID(), f.client, `foreign-${randomUUID()}`, f.subscription, { newAddress: address() }, 1, AT])).rejects.toMatchObject({ code: "42501" });
 await owner.query("INSERT INTO public.platform_control_operators(principal_id,active) VALUES($1,true)", [f.operator]);
 await expect(change(f, `machine-${randomUUID()}`)).rejects.toMatchObject({ code: "42501", message: "customer_support_command_requires_human" });
 expect(await counts(f)).toMatchObject({ destinations: before.destinations, events: 0, notices: 0 });
});
it.each(["active", "paused", "cancelled"])("characterizes status %s without moving cadence or a cycle", async status => {
 const f = await fixture(); await owner.query("UPDATE public.subscriptions SET status=$2 WHERE id=$1", [f.subscription, status]);
 const before = (await owner.query("SELECT cadence_days,next_cycle_at,template_version FROM public.subscriptions WHERE id=$1", [f.subscription])).rows;
 expect(await change(f, `status-${randomUUID()}`)).toMatchObject(status === "cancelled" ? { outcome: "refused", refusalCode: "invalid_transition" } : { outcome: "applied" });
 expect((await owner.query("SELECT cadence_days,next_cycle_at,template_version FROM public.subscriptions WHERE id=$1", [f.subscription])).rows).toEqual(before);
});
it("skips an already handed-over parcel while retaining an explicit future-only response on the public operator port", async () => {
 const f = await fixture(); await owner.query("UPDATE public.fulfillment_shipments SET status='handed_over',handed_over_at=$2 WHERE id=$1", [f.shipment, AT]);
 const authority = createPostgresOperatorAuthority({ run: work => work(runtime) }, { operatorId: f.operator, now: () => Date.parse(AT), recoveryPath: () => "/repair" });
 const input = { operatorId: f.operator, subscriptionId: f.subscription, subscriptionAction: "change_shipping_address" as const, payload: { newAddress: address("Future only") }, expectedVersion: 1, idempotencyKey: `handover-${randomUUID()}` };
 const result = await authority.applySubscriptionAction(input);
 expect(result).toMatchObject({ outcome: "applied_from_next_parcel", appliesFrom: "next_parcel", replayed: false });
 expect(await authority.applySubscriptionAction(input)).toMatchObject({ outcome: "applied_from_next_parcel", replayed: true });
 expect(await port().read("order", f.order)).toEqual(f.original);
 expect(await port().read("shipment", f.shipment)).toEqual(f.original);
});
async function frozenCommand(f: Fixture) {
 const frozen = await port().read("shipment", f.shipment), provider = `provider-${randomUUID()}`;
 const fingerprint = createHash("sha256").update(JSON.stringify(frozen.address)).digest("hex");
 const command = await call(runtime, "commerce_fulfillment_enqueue_provider_command", [f.shipment, provider, "dispatch_create", "1", randomUUID(), "a".repeat(64), fingerprint, null, "b".repeat(64), "c".repeat(64), "d".repeat(64), 2]);
 const claim = (await runtime.query("SELECT public.commerce_fulfillment_claim_provider_commands($1,'dispatch_create',1,$2,120) result", [provider, "e".repeat(64)])).rows[0].result;
 return { frozen, fingerprint, command, claim };
}
it("submits a frozen old recipient concurrently while address SQL holds the created shipment lock", async () => {
 const f = await fixture(), frozen = await frozenCommand(f), key = `race-${randomUUID()}`;
 const barrier = await owner.connect(), edit = await runtime.connect();
 const lock = `g3-proof:${f.subscription}`;
 await barrier.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lock]);
 await owner.query(`CREATE FUNCTION public.g3_test_address_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('g3-proof:'||NEW.subscription_id::text,0)); RETURN NEW; END; $$;
 CREATE TRIGGER g3_test_address_barrier BEFORE INSERT ON public.subscription_events FOR EACH ROW EXECUTE FUNCTION public.g3_test_address_barrier()`);
 let pending: ReturnType<typeof change> | undefined;
 try {
  const pid = (await edit.query("SELECT pg_backend_pid() pid")).rows[0].pid;
  let done = false;
  pending = change(f, key, "Future after frozen dispatch", 1, edit).finally(() => { done = true; });
  const deadline = Date.now() + 5000;
  while (!(await owner.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid])).rowCount) {
   if (Date.now() > deadline) throw new Error("Address did not reach its locked event barrier");
   await new Promise(resolve => setTimeout(resolve, 10));
  }
  const submit = await runtime.connect();
  try {
   await submit.query("BEGIN; SET LOCAL statement_timeout='1s'");
   expect(await call(submit, "commerce_fulfillment_mark_command_submitting", [frozen.command.commandId, frozen.claim.claimToken, frozen.claim.claimGeneration, frozen.claim.version, null])).toMatchObject({ status: "submitting" });
   await submit.query("COMMIT");
  } finally { await submit.query("ROLLBACK"); submit.release(); }
  expect(done).toBe(false); // Submission completed while address SQL still owns the shipment lock.
  expect((await owner.query("SELECT status FROM public.fulfillment_shipments WHERE id=$1", [f.shipment])).rows).toEqual([{ status: "created" }]);
  await barrier.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lock]);
  const changed = await pending;
  expect(changed).toMatchObject({ outcome: "applied_from_next_parcel", currentParcel: { reason: "dispatch_owned", destinationId: f.original.destinationId } });
  expect(await change(f, key, "Future after frozen dispatch")).toEqual({ ...changed, replayed: true });
  expect(await port().read("order", f.order)).toEqual(frozen.frozen);
  expect(await port().read("shipment", f.shipment)).toEqual(frozen.frozen);
  expect((await port().read("subscription", f.subscription)).destinationId).toBe(changed.futureDestinationId);
  const sent: unknown[] = [];
  const sendFrozen = async () => {
   const row = (await runtime.query("SELECT command_payload_fingerprint FROM public.commerce_fulfillment_provider_commands WHERE id=$1", [frozen.command.commandId])).rows[0];
   expect(createHash("sha256").update(JSON.stringify(frozen.frozen.address)).digest("hex")).toBe(row.command_payload_fingerprint);
   sent.push(frozen.frozen.address);
  };
  await sendFrozen(); expect(sent).toEqual([f.original.address]);
  const payload = (await owner.query("SELECT payload FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.address_changed'", [f.subscription])).rows[0].payload;
  expect(payload).toMatchObject({ outcome: "applied_from_next_parcel", appliesFrom: "next_parcel", futureDestinationId: changed.futureDestinationId });
  expect(JSON.stringify(payload)).not.toContain(f.original.destinationId);
  expect((await counts(f)).notices).toBe(1); // Pending confirmation did not gate dispatch.
 } finally {
  await barrier.query("SELECT pg_advisory_unlock_all()");
  await pending?.catch(() => undefined); edit.release(); barrier.release();
  await owner.query("DROP TRIGGER g3_test_address_barrier ON public.subscription_events; DROP FUNCTION public.g3_test_address_barrier()");
 }
});
it("serializes concurrent matching commands to one event, receipt, address and notice", async () => {
 const f = await fixture(), key = `duplicate-${randomUUID()}`;
 const results = await Promise.all([change(f, key), change(f, key)]);
 expect(results.map(r => r.replayed).sort()).toEqual([false, true]);
 expect(new Set(results.map(r => r.futureDestinationId)).size).toBe(1);
 expect(await counts(f)).toMatchObject({ destinations: 2, events: 1, notices: 1, commands: 1, audits: 1 });
});
it("preserves the late-delivery clamp through restricted runtime and never moves a cycle with an address change", async () => {
 await alignmentInvariant(owner);
 const mode = (await owner.query("SELECT public.subscription_delivery_alignment_get_mode() mode")).rows[0].mode;
 try {
  const f = await fixture(true);
  expect(await openCase(owner, f, "auto_align")).toMatchObject({ state: "protected", predecessor_cycle_number: 0 });
  const schedule = async () => (await owner.query("SELECT status,cadence_days,next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0];
  const before = await schedule(), key = `late-address-${randomUUID()}`;
  expect(await change(f, key)).toMatchObject({ outcome: "applied" }); expect(await schedule()).toEqual(before);
  const arrival = { requestKey: `late-arrival-${randomUUID()}`, parcelRef: f.shipment,
   deliveredAt: "2026-09-08T12:00:00Z", evidenceRef: `evidence:${f.shipment}` as const };
  const alignment = createPostgresDeliveryAlignmentPort(executor(runtime));
  await alignment.recordArrival(arrival);
  const after = await schedule();
  expect(after.status).toBe("active");
  expect(after.next_cycle_at.getTime()).toBe(Math.max(before.next_cycle_at.getTime(), Date.parse(arrival.deliveredAt) + before.cadence_days * 86400000));
  await alignment.recordArrival(arrival); await change(f, key);
  expect(await schedule()).toEqual(after);
 } finally { await owner.query("SELECT public.subscription_delivery_alignment_set_mode($1)", [mode]); }
});

it("keeps a sequentially frozen parcel old and submits with its confirmation notice still pending", async () => {
 const f = await fixture(), frozen = await frozenCommand(f);
 const changed = await change(f, `sequence-${randomUUID()}`);
 expect(changed.outcome).toBe("applied_from_next_parcel");
 expect((await owner.query("SELECT status FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.address_changed'", [f.subscription])).rows).toEqual([{ status: "pending" }]);
 expect(await call(runtime, "commerce_fulfillment_mark_command_submitting", [frozen.command.commandId, frozen.claim.claimToken, frozen.claim.claimGeneration, frozen.claim.version, null])).toMatchObject({ status: "submitting" });
 expect(await port().read("shipment", f.shipment)).toEqual(f.original);
 expect((await owner.query("SELECT status FROM public.commerce_orders WHERE id=$1", [f.order])).rows).toEqual([{ status: "paid" }]);
});
it("reads subscription purchase origin through activation and never inherits a current-order override", async () => {
 const f = await shipmentFixture(owner, null, true, true);
 const registered = await port().registerOrder({ idempotencyKey: `active-${f.order}`, orderId: f.order, address: address(), now: AT });
 expect(await port().read("subscription", f.subscription)).toEqual(registered);
 // Owner-only corruption probes cannot be authored by runtime; the bounded reader must still refuse drift.
 const other = await fixture();
 await owner.query("INSERT INTO public.commerce_destination_bindings(subscription_id,destination_id) VALUES($1,$2)", [f.subscription, other.original.destinationId]);
 await expect(port().read("subscription", f.subscription)).rejects.toMatchObject({ code: "22023", message: "commerce_destination_owner_mismatch" });
});
it("resolves a renewal's frozen destination instead of its subscription's later future address", async () => {
 const f = await fixture();
 await change(f, `future-${randomUUID()}`);
 const operation = randomUUID(), cycle = randomUUID(), order = randomUUID(), fingerprint = "f".repeat(64);
 await owner.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,identity_key,
 operation_fingerprint,cycle_snapshot,claim_token,claimed_by,claimed_at,lease_expires_at)
 VALUES($1,$2,'2026-10-01',2,$3,$4,$5,$6,'fixture',now(),now()+interval '1 hour')`, [operation, f.subscription,
 `subscription:${f.subscription}:cycle:2026-10-01T00:00:00.000Z`, fingerprint, { orderSnapshot: { shippingAddressRef: f.original.destinationId } }, randomUUID()]);
 await owner.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status,renewal_operation_id,renewal_operation_fingerprint) VALUES($1,$2,'2026-10-01','payment_pending',$3,$4)", [cycle, f.subscription, operation, fingerprint]);
 await owner.query("INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,renewal_operation_id,renewal_operation_fingerprint) VALUES($1,$2,$3,$4,$5)", [order, f.client, cycle, operation, fingerprint]);
 expect(await port().read("order", order)).toEqual(f.original);
 expect((await port().read("subscription", f.subscription)).destinationId).not.toBe(f.original.destinationId);
});


it("invalidates an unowned stale dispatch candidate without changing provider selection", async () => {
 const f = await fixture();
 const oldRevision = { schemaVersion: 1, source: `commerce-destination:${f.original.destinationId}`, revision: 1 };
 await owner.query("INSERT INTO public.fulfillment_dispatch_contexts(shipment_id,contact_revision,provider_ref) VALUES($1,$2,'warehouse-a')", [f.shipment, oldRevision]);
 const changed = await change(f, `stale-candidate-${randomUUID()}`);
 expect(changed.outcome).toBe("applied");
 const context = (await runtime.query("SELECT * FROM public.fulfillment_dispatch_contexts WHERE shipment_id=$1", [f.shipment])).rows[0];
 expect(context).toMatchObject({ provider_ref: "warehouse-a", withheld: false, contact_revision: { source: `commerce-destination:${changed.futureDestinationId}` } });
 expect(await call(runtime, "fulfillment_dispatch_claim", [`candidate-${randomUUID()}`, f.shipment, f.order, "parcel", "shadow", { providerRef: "warehouse-a", contactRevision: oldRevision, commandFingerprint: "a".repeat(64) }])).toMatchObject({ kind: "refused", refusal: { reason: "contact_stale" } });
});

it("preserves next-cycle ownership before a frozen native renewal has materialized its cycle", async () => {
 const f = await fixture();
 await port().changeShippingAddress({ actorId: f.principal, clientId: f.client, idempotencyKey: `initial-${randomUUID()}`, subscriptionId: f.subscription, newAddress: address("Claimed future"), expectedVersion: 1, now: AT });
 const next = (await owner.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].next_cycle_at.toISOString();
 const doc = await port().read("subscription", f.subscription), identity = await call(runtime, "subscription_renewal_identity", [f.subscription, next]);
 const snapshot = { contractVersion: "platform.subscription.renewal.v1", subscriptionId: f.subscription, clientId: f.client,
  scheduledAt: next, cycleNumber: 2, currency: "XXX", stockSourceKey: "fixture", settlementChannelKey: "sandbox",
  authorizationRef: "fixture", totalAmountMinor: 100, lines: [{ lineOrdinal: 1, sku: "fixture", quantity: 1, unitAmountMinor: 100 }],
  orderSnapshot: { shippingAddressRef: doc.destinationId } };
 await call(runtime, "subscription_claim_due_renewal", [identity, createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), snapshot, "fixture", 300, AT]);
 expect((await owner.query("SELECT count(*)::int n FROM public.subscription_cycles WHERE subscription_id=$1 AND scheduled_at=$2", [f.subscription, next])).rows).toEqual([{ n: 0 }]);
 expect(await change(f, `claimed-${randomUUID()}`)).toMatchObject({ outcome: "refused", refusalCode: "payment_blocked" });
 expect(await port().read("subscription", f.subscription)).toEqual(doc);
});

it("leaves an undelivered replacement and its alignment case unconfirmed", async () => {
 const f = await fixture(); await openCase(owner, f, "auto_align"); const parcel = await replacement(owner, f);
 const before = (await owner.query("SELECT to_jsonb(t) value FROM public.subscription_delivery_alignment_cases t WHERE subscription_id=$1", [f.subscription])).rows;
 const next = (await owner.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows;
 expect(await change(f, `undelivered-${randomUUID()}`)).toMatchObject({ outcome: "applied" });
 expect((await owner.query("SELECT to_jsonb(t) value FROM public.subscription_delivery_alignment_cases t WHERE subscription_id=$1", [f.subscription])).rows).toEqual(before);
 expect((await owner.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows).toEqual(next);
 expect((await owner.query("SELECT status,delivered_at FROM public.fulfillment_shipments WHERE id=$1", [parcel])).rows).toEqual([{ status: "created", delivered_at: null }]);
});

it("retains future-only replay, old parcel and its notice across a real PostgreSQL restart", async () => {
 const f = await fixture(), key = `restart-${randomUUID()}`; await frozenCommand(f);
 const changed = await change(f, key); const before = await counts(f);
 await runtime.end(); await owner.end();
 await promisify(execFile)("docker", ["restart", containerName]);
 expect(await waitForPostgresTcpReady(container!.connectionString)).toBe(true); connect();
 expect(await change(f, key)).toEqual({ ...changed, replayed: true });
 expect(await counts(f)).toEqual(before);
 expect(await port().read("shipment", f.shipment)).toEqual(f.original);
 expect((await port().read("subscription", f.subscription)).destinationId).toBe(changed.futureDestinationId);
});
