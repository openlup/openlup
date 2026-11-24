import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFulfillmentParcelContactPrivacyContributor } from "@openlup/platform/identity";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { manifest, units } from "../helpers/fulfillmentNative.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { captureStoreJourney, journeyRpc, journeySelection, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { bindDestinationOrder, destinationContext, documentTable, insertDestinationOrder, reachDestinationCutoff, readSnapshot, snapshot, snapshotCommand, testServicePin } from "./destinationDocumentFixture.js";
import { awaitReceiptWait, backendPid, markReceiptClientErased } from "./destinationReceiptFixture.js";

const resources = storeJourneyResources();
let store: JourneyInstallation;
const forward = units.find(unit => unit.file.endsWith("_fulfillment_destination_contact_v2.sql"))!.file;
const port = "freeze-fixture";
const legacyContact = { schemaVersion: 1, source: "contact", revision: 1, recipientName: "Fixture", contactEmail: null,
  contactPhone: "+00001", line1: "Example Lane", line2: "Unit A", city: "Example", postalCode: "00000", country: "XA",
  deliveryInstructions: null, courierInstructions: null,
  selectedDelivery: { providerKind: "provider", providerRef: "provider", service: "service", carrierKind: "carrier" } };
const draftLine = { productRef: "product:fixture", packRef: "pack:fixture", lotNumber: "lot:fixture", lotCode: "other",
  expirationDate: null, expiresAt: "2028-02-29", discarded: { fixture: "do not freeze" } };
const lineProjection = { productRef: "product:fixture", packRef: "pack:fixture", lotRef: "lot:fixture", expirationDate: "2028-02-29" };

beforeAll(async () => { store = await resources.installation("destination-parcel"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

async function pay({ owner, runtime }: Pick<JourneyInstallation, "owner" | "runtime">, order: string, line: Record<string, unknown> = draftLine, legacy = false) {
  const sku = randomUUID(), item = randomUUID(), actor = randomUUID();
  await owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES($1,'3pl',true) ON CONFLICT DO NOTHING", [port]);
  await owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1::uuid,$1::text,'Fixture')", [sku]);
  await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$1::uuid::text,'Fixture')", [sku]);
  const writer = await owner.connect();
  try {
    await writer.query("BEGIN");
    await writer.query("UPDATE public.commerce_orders SET total_amount_minor=100,status='paid',paid_at=clock_timestamp(),metadata=$2 WHERE id=$1",
      [order, { orderDraftSnapshot: { context: { mode: "one_time" }, lines: [line] }, ...(legacy ? { runtimeFinalize: { deliveryContact: legacyContact } } : {}) }]);
    await writer.query(`INSERT INTO public.commerce_order_items(id,order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
      VALUES($1,$2,$3,1,1,100,100)`, [item, order, sku]);
    await writer.query("COMMIT");
  } catch (error) { await writer.query("ROLLBACK"); throw error; }
  finally { writer.release(); }
  await owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Fixture operator')", [actor]);
  await owner.query(`INSERT INTO public.commerce_settlement_intents(order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key,settled_at)
    VALUES($1,'sandbox','settled',100,'XXX',$2,clock_timestamp())`, [order, order]);
  await owner.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    VALUES($1,$1,10,10,0,'sellable',clock_timestamp(),clock_timestamp()+interval '1 day',$1,$1,repeat('a',64))`, [sku]);
  await runtime.query(`SELECT public.fulfillment_reserve_purchase_order_items($1,$2,$3,$4,'succeeded',
    clock_timestamp()+interval '1 hour','{}',clock_timestamp())`, [`reserve:${order}`, order, sku, JSON.stringify([{ orderItemId: item, skuId: sku, quantity: 1 }])]);
  return { order, actor };
}

async function paidV2(input: { subject?: Awaited<ReturnType<typeof destinationContext>>; line?: Record<string, unknown>; name?: boolean; phone?: boolean } = {}) {
  const ctx = input.subject ? { ...input.subject, scopeRef: randomUUID() } : await destinationContext(store.owner);
  const command = snapshotCommand(ctx).command;
  const { recipientName, ...notes } = command.validated.contact;
  const contact = { ...notes, ...(input.name !== false ? { recipientName } : {}),
    ...(input.phone !== false ? { contactPhone: "+00001" } : {}), contactEmail: "fixture@example.test", courierInstructions: "Leave with reception",
    companyName: "Fixture company", label: "Fixture address label", taxId: "fixture-tax-id" };
  const issued = await snapshot(store.runtime, ctx, { ...command, validated: { ...command.validated, contact } });
  const order = await bindDestinationOrder(store.owner, ctx, issued);
  await reachDestinationCutoff(store.owner, issued.binding);
  const { actor } = await pay(store, order, input.line);
  return { order, actor, ctx, client: ctx.clientId, snapshotRef: issued.binding.snapshotRef, expected: {
    schemaVersion: 2, source: "destination_binding", revision: 1, binding: issued.binding, service: testServicePin,
    address: { city: "Zélvórë", line1: "A 😀", line2: "2", postalCode: "00-001", country: "XA", subdivision: "XA-01" },
    classificationKeys: command.validated.classificationKeys,
    recipient: { recipientName, contactPhone: "+00001", contactEmail: "fixture@example.test",
      deliveryInstructions: notes.deliveryNotes, courierInstructions: "Leave with reception" },
  } };
}

const handoff = (order: string, key = `handoff:${order}`, db = store.runtime) =>
  journeyRpc<{ fulfillmentRef: string; replayed: boolean }>(db, "fulfillment_ensure_paid_handoff", [key, order, "paid-fact", port]);
const oms = ({ order, actor }: { order: string; actor: string | null }, metadata: unknown = {}, key = `operator:${order}`) =>
  journeyRpc<{ fulfillmentOrderId: string }>(store.runtime, "fulfillment_operator_create_order", [key, order, port, actor, metadata]);
const directCapture = (id: string, value: unknown) => journeyRpc(store.runtime, "fulfillment_capture_parcel_contact", [id, value]);
const contactRows = async (db: Pool, client: string) => (await db.query(
  "SELECT shipment_id,contact,captured_at,erased_at FROM public.fulfillment_parcel_contacts WHERE client_id=$1 ORDER BY shipment_id", [client],
)).rows;
const effects = async (order: string) => (await store.owner.query(`SELECT
  (SELECT count(*)::int FROM public.fulfillment_shipments WHERE order_id=$1) AS shipments,
  (SELECT count(*)::int FROM public.fulfillment_shipment_operations WHERE order_id=$1) AS operations,
  (SELECT count(*)::int FROM public.fulfillment_parcel_reservation_sets WHERE order_id=$1) AS sets,
  (SELECT count(*)::int FROM public.fulfillment_parcel_lines l JOIN public.commerce_order_items i ON l.order_item_id=i.id WHERE i.order_id=$1) AS lines,
  (SELECT count(*)::int FROM public.fulfillment_parcel_line_reservations l JOIN public.fulfillment_inventory_reservations r ON l.reservation_id=r.id WHERE r.purchase_order_id=$1) AS reservations,
  (SELECT count(*)::int FROM public.fulfillment_paid_handoffs WHERE order_id=$1) AS handoffs,
  (SELECT count(*)::int FROM public.commerce_destination_bindings b JOIN public.fulfillment_shipments s ON s.id=b.shipment_id WHERE s.order_id=$1) AS legacy,
  (SELECT count(*)::int FROM public.subscription_delivery_alignment_cases WHERE predecessor_order_id=$1) AS alignment`, [order])).rows[0];
const ownPgKeys = ["code", "column", "constraint", "dataType", "detail", "file", "hint", "internalPosition", "internalQuery",
  "length", "line", "name", "position", "routine", "schema", "severity", "table", "where"];
async function refusal(call: Promise<unknown>, message: string, field?: string, hint?: string, code = "22023") {
  const error: unknown = await call.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect(Reflect.ownKeys(error as Error).filter(key => key !== "stack" && key !== "message").sort()).toEqual(ownPgKeys);
  expect(error).toMatchObject({ message, code, detail: field, hint });
}
const invalid = (call: Promise<unknown>, field: string) => refusal(call, "address_invalid_input", field, "Correct the indicated input.");
const unavailable = (call: Promise<unknown>) => refusal(call, "destination_evidence_unavailable", "shipmentId", "Re-obtain evidence through the authenticated owner.");
const storedInvalid = (call: Promise<unknown>) => refusal(call, "destination_binding_invalid", "destination", "Send the retained evidence to the destination owner for review.");

it("keeps the private routines owner-only when default privileges grant EXECUTE", async () => {
  const routines = [
    ["public.fulfillment_destination_contact_v2(uuid,uuid)", "SELECT public.fulfillment_destination_contact_v2(NULL::uuid,NULL::uuid)"],
    ["public.fulfillment_freeze_destination_contact_v2(uuid,jsonb,text)", "SELECT public.fulfillment_freeze_destination_contact_v2(NULL::uuid,'{}'::jsonb,'resolve')"],
    ["public.fulfillment_destination_line_snapshot_v2(jsonb)", "SELECT public.fulfillment_destination_line_snapshot_v2('{}'::jsonb)"],
  ] as const;
  const roles = ["anon", "authenticated", "service_role", journeySelection.runtimeLogin];
  const signatures = routines.map(([signature]) => signature);
  const owner = await store.owner.connect();
  try {
    await owner.query("BEGIN");
    await owner.query(`DROP FUNCTION ${signatures.join(", ")};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;`);
    await owner.query(readFileSync(forward, "utf8"));
    expect((await owner.query(`SELECT role, signature FROM unnest($1::text[]) AS r(role)
      CROSS JOIN unnest($2::text[]) AS f(signature) WHERE has_function_privilege(role, signature::regprocedure, 'EXECUTE')`,
    [roles, signatures])).rows).toEqual([]);
    for (const role of roles) {
      await owner.query(`SET LOCAL ROLE ${role}`);
      for (const [, sql] of routines) {
        await owner.query("SAVEPOINT denied_call");
        await expect(owner.query(sql)).rejects.toMatchObject({ code: "42501" });
        await owner.query("ROLLBACK TO SAVEPOINT denied_call; RELEASE SAVEPOINT denied_call");
      }
      await owner.query("RESET ROLE");
    }
  } finally { try { await owner.query("ROLLBACK"); } finally { owner.release(); } }
  for (const [, sql] of routines) await expect(store.runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
});

it("uses the real paid handoff and OMS opener, then preserves same-order replay and exact-current transfer", async () => {
  const paid = await paidV2(), operator = await paidV2();
  const fromHandoff = await handoff(paid.order), fromOms = await oms(operator);
  for (const [f, parcel, metadata, handoffs] of [
    [paid, fromHandoff.fulfillmentRef, {}, 1], [operator, fromOms.fulfillmentOrderId, { actorId: operator.actor }, 0],
  ] as const) {
    const rows = await contactRows(store.owner, f.client);
    expect(rows).toEqual([{ shipment_id: parcel, contact: f.expected, captured_at: expect.any(Date), erased_at: null }]);
    expect(Object.keys(rows[0].contact.recipient).sort()).toEqual([
      "contactEmail", "contactPhone", "courierInstructions", "deliveryInstructions", "recipientName",
    ]);
    expect((await store.owner.query(`SELECT s.metadata,op.payload,l.product_snapshot
      FROM public.fulfillment_shipments s JOIN public.fulfillment_shipment_operations op ON op.shipment_id=s.id
      JOIN public.fulfillment_parcel_lines l ON l.shipment_id=s.id WHERE s.id=$1`, [parcel])).rows)
      .toEqual([{ metadata, payload: { portKey: port, providerType: "3pl" }, product_snapshot: lineProjection }]);
    expect(await effects(f.order)).toEqual({ shipments: 1, operations: 1, sets: 1, lines: 1, reservations: 1, handoffs, legacy: 0, alignment: 0 });
  }
  expect(await handoff(paid.order)).toEqual({ ...fromHandoff, replayed: true });
  expect(await oms({ ...operator, actor: null }, { forbidden: {} })).toEqual({ ...fromOms, replayed: true });
  await refusal(oms(paid, {}, `operator:${operator.order}`), "commerce_fulfillment_destination_replay_conflict", "orderId", undefined, "23505");
  const target = await resources.installation("destination-parcel-target");
  const packet = await captureStoreJourney(store.owner, "destination-parcel");
  const freshTarget = await captureStoreJourney(target.owner, "destination-parcel-target");
  expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget })).toMatchObject({ replayed: false });
  expect(await contactRows(target.owner, paid.client)).toEqual(await contactRows(store.owner, paid.client));
  expect(await journeyRpc(target.runtime, "fulfillment_capture_parcel_contact", [fromHandoff.fulfillmentRef, paid.expected]))
    .toEqual({ replayed: true, contact: paid.expected });
});

it("rejects unknown fields and non-scalar classification entries at the runtime SQL boundary", async () => {
  const f = await paidV2(), { fulfillmentRef } = await handoff(f.order), expected = f.expected;
  const before = await contactRows(store.owner, f.client);
  const state = await effects(f.order);
  const nested = (["binding", "service", "address", "recipient"] as const).map(key => ({
    ...expected, [key]: { ...expected[key], forbidden: "synthetic sentinel" },
  }));
  const arrays = expected.classificationKeys.map((_, invalidIndex) => ({
    ...expected, classificationKeys: expected.classificationKeys.map((key, index) => index === invalidIndex ? { forbidden: key } : key),
  }));
  for (const value of [{ ...expected, forbidden: true }, ...nested, ...arrays]) await invalid(directCapture(fulfillmentRef, value), "contact");
  expect(await directCapture(fulfillmentRef, expected)).toEqual({ replayed: true, contact: expected });
  expect(await contactRows(store.owner, f.client)).toEqual(before);
  expect(await effects(f.order)).toEqual(state);
  await store.owner.query("UPDATE public.fulfillment_parcel_contacts SET contact=$2 WHERE shipment_id=$1", [fulfillmentRef, legacyContact]);
  await storedInvalid(directCapture(fulfillmentRef, expected));
  await store.owner.query("UPDATE public.fulfillment_parcel_contacts SET contact=$2 WHERE shipment_id=$1",
    [fulfillmentRef, { ...expected, service: { ...expected.service, adapterRevision: "changed" } }]);
  await storedInvalid(directCapture(fulfillmentRef, expected));
  await store.owner.query("DELETE FROM public.fulfillment_parcel_contacts WHERE shipment_id=$1", [fulfillmentRef]);
  await unavailable(directCapture(fulfillmentRef, expected));
  await unavailable(journeyRpc(store.runtime, "fulfillment_capture_order_contact_for_shipment", [fulfillmentRef]));
  expect(await contactRows(store.owner, f.client)).toEqual([]);
  expect(await effects(f.order)).toEqual(state);
});

it("keeps the released capture refusal for an unknown shipment with a v2 payload", async () => {
  const f = await paidV2();
  await refusal(directCapture(randomUUID(), f.expected), "fulfillment_parcel_contact_invalid");
  expect(await contactRows(store.owner, f.client)).toEqual([]);
});

it("refuses an erased frozen contact while the subject and order binding remain live", async () => {
  const f = await paidV2(), { fulfillmentRef } = await handoff(f.order);
  expect(await journeyRpc(store.runtime, "fulfillment_erase_parcel_contacts", [f.client])).toEqual({ erased: 1 });
  expect(await readSnapshot(store.runtime, f.ctx, f.expected.binding, f.order, "order")).toMatchObject({ binding: f.expected.binding });
  const erased = await contactRows(store.owner, f.client);
  expect(erased).toEqual([{ shipment_id: fulfillmentRef, contact: {}, captured_at: expect.any(Date), erased_at: expect.any(Date) }]);
  await unavailable(directCapture(fulfillmentRef, f.expected));
  await unavailable(journeyRpc(store.runtime, "fulfillment_capture_order_contact_for_shipment", [fulfillmentRef]));
  expect(await contactRows(store.owner, f.client)).toEqual(erased);
});

it("rolls back the complete opener on malformed metadata, line evidence or missing contact", async () => {
  const valid = await paidV2();
  const badDate = await paidV2({ line: { ...draftLine, expiresAt: "2027-02-29" } });
  const badRef = await paidV2({ line: { ...draftLine, lotRef: { forbidden: "fixture" } } });
  const shadowed = await paidV2({ line: { ...draftLine, lotCode: { forbidden: "fixture" } } });
  const noPhone = await paidV2({ phone: false }), noName = await paidV2({ name: false });
  const badDigest = await paidV2();
  await store.owner.query(`UPDATE ${documentTable} SET document_text=document_text||' ' WHERE snapshot_ref=$1`, [badDigest.snapshotRef]);
  for (const [f, run] of [
    [valid, () => invalid(oms(valid, { actorId: valid.actor }), "metadata")],
    [valid, () => invalid(journeyRpc(store.runtime, "fulfillment_create_shipment", [`direct:${valid.order}`, valid.order, port, { forbidden: "fixture" }]), "metadata")],
    [valid, () => invalid(journeyRpc(store.runtime, "fulfillment_route_order", [`route:${valid.order}`, valid.order, port]), "metadata")],
    [badDate, () => invalid(oms(badDate), "productSnapshot.expirationDate")],
    [badRef, () => invalid(handoff(badRef.order), "productSnapshot.lotRef")],
    [shadowed, () => invalid(handoff(shadowed.order), "productSnapshot.lotRef")],
    [noPhone, () => refusal(handoff(noPhone.order), "destination_contact_incomplete", "contact.contactPhone", "Send the original order evidence to the order owner for review.")],
    [noName, () => refusal(oms(noName), "destination_contact_incomplete", "contact.recipientName", "Send the original order evidence to the order owner for review.")],
    [badDigest, () => refusal(handoff(badDigest.order), "destination_digest_mismatch", "documentDigest", "Replay the original document and its digest.")],
  ] as const) {
    const before = await effects(f.order);
    await run();
    expect(await effects(f.order)).toEqual(before);
    expect(await contactRows(store.owner, f.client)).toEqual([]);
  }
  expect((await oms(valid)).fulfillmentOrderId).toEqual(expect.any(String));
});

it("exports and erases mixed contacts and refuses new evidence for an erased subject", async () => {
  const first = await paidV2(), unshipped = await paidV2({ subject: first.ctx });
  const v2 = await oms(first);
  const v1Order = await insertDestinationOrder(store.owner, first.ctx);
  await pay(store, v1Order, draftLine, true);
  const v1 = await handoff(v1Order);
  const contributor = createFulfillmentParcelContactPrivacyContributor();
  const subject = { contactId: first.client, principalId: first.ctx.owner.principalRef, identity: {} };
  const exported = await contributor.export(store.runtime, subject);
  expect(exported).toMatchObject({ contributorId: "fulfillment-parcel-contacts", version: "fulfillment.parcel-contacts.v3",
    coverage: { complete: true }, data: expect.arrayContaining([
      expect.objectContaining({ shipmentId: v1.fulfillmentRef, contact: legacyContact }),
      expect.objectContaining({ shipmentId: v2.fulfillmentOrderId, contact: first.expected }),
    ]) });
  const assessment = await contributor.assessErasure(store.runtime, subject);
  await contributor.eraseOrRetain(store.runtime, subject, assessment, { principalId: randomUUID() });
  await markReceiptClientErased(store.owner, first.client);
  expect(await contactRows(store.owner, first.client)).toEqual(expect.arrayContaining(
    [v1.fulfillmentRef, v2.fulfillmentOrderId].map(shipment_id => ({ shipment_id, contact: {}, captured_at: expect.any(Date), erased_at: expect.any(Date) })),
  ));
  await unavailable(directCapture(v2.fulfillmentOrderId, first.expected));
  const before = await effects(unshipped.order);
  await unavailable(handoff(unshipped.order));
  expect(await effects(unshipped.order)).toEqual(before);
  expect(await oms({ ...first, actor: null }, { forbidden: true })).toEqual({ ...v2, replayed: true });
});

it("rechecks erasure after the waiting subject guard", async () => {
  const f = await paidV2(), before = await effects(f.order);
  const eraser = await store.owner.connect(), opener = await store.runtime.connect();
  try {
    await eraser.query("BEGIN");
    await eraser.query("SELECT id FROM public.clients WHERE id=$1 FOR UPDATE", [f.client]);
    const pid = await backendPid(opener);
    const result = opener.query("SELECT public.fulfillment_ensure_paid_handoff($1,$2,$3,$4)",
      [`handoff:${f.order}`, f.order, "paid-fact", port]).then(() => null, (error: unknown) => error);
    await awaitReceiptWait(store.owner, pid, "transactionid", "ShareLock");
    await markReceiptClientErased(eraser, f.client);
    await eraser.query("COMMIT");
    const error = await result;
    expect(error).not.toBeNull();
    await unavailable(Promise.reject(error));
    expect(await effects(f.order)).toEqual(before);
    expect(await contactRows(store.owner, f.client)).toEqual([]);
  } finally { await eraser.query("ROLLBACK"); eraser.release(); opener.release(); }
});

it("frozen_dispatch_v1_bytes_unchanged", async () => {
  const first = manifest.forward.findIndex(unit => unit.file === forward);
  const root = mkdtempSync(join(tmpdir(), "parcel-contact-prefix-"));
  const container = await runPostgresContainer({ name: `parcel-prefix-${process.pid}`, password: "synthetic-conformance" });
  const db = new Pool({ connectionString: container.connectionString });
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const prefix = { ...manifest, forward: manifest.forward.slice(0, first), objectInventorySha256: "9b0e371a8a3c0bfd2f8651fd1ed8a79316e7a7f218b4de25f6e4f529e477e9e8" };
    for (const { file: path } of [prefix.baseline, ...prefix.forward]) {
      const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(path));
    }
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(prefix));
    const runner = (source = process.cwd()) => createPostgresMigrationRunner(
      { connectionString: container.connectionString }, { root: source, poolFactory: () => db },
    );
    await runner(root).apply();
    const ctx = await destinationContext(db), order = await insertDestinationOrder(db, ctx);
    await pay({ owner: db, runtime: db }, order, draftLine, true);
    const parcel = (await handoff(order, `handoff:${order}`, db)).fulfillmentRef;
    const frozen = async () => (await db.query(`SELECT public.fulfillment_native_dispatch_read_candidate($1,'provider')::text AS command,
      (SELECT contact::text FROM public.fulfillment_parcel_contacts WHERE shipment_id=$1) AS contact,
      (SELECT product_snapshot::text FROM public.fulfillment_parcel_lines WHERE shipment_id=$1) AS line`, [parcel])).rows[0];
    const attributes = async () => (await db.query(`SELECT to_jsonb(p)-'prosrc' AS attrs FROM pg_proc p
      WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[]) ORDER BY oid`, [[
      "fulfillment_open_shipment", "fulfillment_operator_create_order", "fulfillment_resolve_parcel_contact",
      "fulfillment_capture_parcel_contact", "fulfillment_capture_order_contact_for_shipment", "fulfillment_capture_new_parcel_reservations",
    ]])).rows;
    const before = await frozen(), attrs = await attributes();
    expect(JSON.parse(before.command)).toMatchObject({ contact: legacyContact, lines: [{ lotRef: draftLine.lotNumber, expirationDate: null }] });
    expect(JSON.parse(before.line)).toEqual(draftLine);
    expect((await runner().apply()).applied.slice(0, 1)).toEqual([forward]);
    expect(await frozen()).toEqual(before);
    expect(await attributes()).toEqual(attrs);
    expect(await handoff(order, `handoff:${order}`, db)).toEqual({ fulfillmentRef: parcel, replayed: true });
    const next = await insertDestinationOrder(db, ctx);
    await pay({ owner: db, runtime: db }, next, draftLine, true);
    await journeyRpc(db, "fulfillment_route_order", [`route:${next}`, next, port]);
    expect((await db.query("SELECT metadata FROM public.fulfillment_shipments WHERE order_id=$1", [next])).rows)
      .toEqual([{ metadata: { routing: "fallback" } }]);
  } finally { try { await closePostgres(container, db); } finally { rmSync(root, { recursive: true, force: true }); } }
}, postgresSetupTimeoutMs);
