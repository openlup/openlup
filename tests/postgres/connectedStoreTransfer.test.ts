import { createPostgresAbandonedCheckoutCompensationPort, createPostgresPurchaseReservationPort } from "@openlup/platform/inventory";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresPaymentTruthPort } from "@openlup/platform/payments";
import { captureConnectedNativeStore, type ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { connectedStoreOutsideProfileRelations } from "../../server/adapters/postgres/connectedStoreDomains/index.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { storeJourneyResources, type JourneyTargetTemplate } from "../helpers/storeJourney.js";
import {
  capture,
  census,
  paymentAt,
  paymentObservation,
  paymentOptions,
  paymentPort,
  paymentReceive,
  restoreInstallation,
  seedRetainedTransferStore,
  selected,
  selection,
  type Installation,
  type RetainedTransferSeed,
} from "./connectedStoreTransfer.fixture.js";

// This file runs cluster-wide CREATE/GRANT/DROP ROLE in its filtered-reader witness,
// so keep it on its own isolated per-suite template container instead of the shared broker.
const resources = storeJourneyResources({ isolatedCluster: true });
const ports: { close(): Promise<void> }[] = [];
const mediaCleanup: { parent?: string } = {};
let targetNumber = 0;
let sourceTemplates: JourneyTargetTemplate, targetTemplates: JourneyTargetTemplate;
let source: Installation, target: Installation, pristine: ConnectedNativeStoreCapture;
let seed: RetainedTransferSeed;

beforeAll(async () => {
  [sourceTemplates, targetTemplates] = await Promise.all([
    resources.targetTemplate("transfer-source"),
    resources.targetTemplate("transfer-target"),
  ]);
  source = await sourceTemplates.clone("source");
  seed = await seedRetainedTransferStore(source, ports, mediaCleanup);
}, postgresSetupTimeoutMs);

afterAll(async () => {
  try { await resources.close(ports.map(port => () => port.close())); }
  finally { if (mediaCleanup.parent) await rm(mediaCleanup.parent, { recursive: true, force: true }); }
}, postgresTeardownTimeoutMs);

const restore = (capturePacket = seed.packet) => restoreInstallation(target, pristine, capturePacket);

describe("source-only capture boundaries", () => {
  // About 4x the slowest hosted run (12,820 ms), rounded up to 5 s.
  it("keeps an absent owned relation redacted and names an existing non-table relation", async () => {
    await source.owner.query("ALTER TABLE public.subscription_cancel_feedback RENAME TO capture_feedback_saved");
    try {
      await expect(capture(source.owner, "missing-owned-relation"))
        .rejects.toMatchObject({ code: "database_unavailable", table: undefined });
      await source.owner.query("CREATE VIEW public.subscription_cancel_feedback AS SELECT 1 AS unused");
      await expect(capture(source.owner, "non-table-owned-relation"))
        .rejects.toMatchObject({ code: "schema_conflict", table: "subscription_cancel_feedback" });
    } finally {
      await source.owner.query(`DROP VIEW IF EXISTS public.subscription_cancel_feedback;
        ALTER TABLE public.capture_feedback_saved RENAME TO subscription_cancel_feedback`);
    }
  });

  it("refuses a native capture login that row security would silently filter", async () => {
    const login = "transfer_filtered_reader";
    await source.owner.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'synthetic-transfer';
      GRANT pg_read_all_data TO ${login}`);
    const url = new URL(source.ownerUrl); url.username = login; url.password = "synthetic-transfer"; url.search = "";
    const reader = new Pool({ connectionString: url.toString(), max: 1 });
    const errors: unknown[] = [];
    try {
      expect(Number((await source.owner.query("SELECT count(*) FROM public.clients")).rows[0].count)).toBeGreaterThan(0);
      const client = await reader.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        // The baseline dump can leave a pooled session with this setting off.
        await client.query("SET LOCAL row_security = on");
        expect((await client.query("SELECT count(*)::int AS rows FROM public.clients")).rows).toEqual([{ rows: 0 }]);
        for (const table of ["commerce_destinations", "commerce_destination_bindings"]) {
          expect(Number((await source.owner.query(`SELECT count(*) n FROM public.${table}`)).rows[0].n)).toBeGreaterThan(0);
          expect((await client.query(`SELECT count(*)::int AS rows FROM public.${table}`)).rows).toEqual([{ rows: 0 }]);
          await client.query("SAVEPOINT address_filter; SET LOCAL row_security=off");
          await expect(client.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
          await client.query("ROLLBACK TO SAVEPOINT address_filter");
        }
        await expect(captureConnectedNativeStore({ sourceId: "native-filtered-login", catalogueId: selected.objectInventorySha256,
          maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
          source: { withSnapshot: work => work({ query: async (sql, values) => {
            try { return await client.query(sql, values ? [...values] : undefined); }
            catch (error) { errors.push((error as { code?: unknown }).code); throw error; }
          } }) } })).rejects.toMatchObject({ code: "database_unavailable" });
        expect(errors).toEqual(["42501"]);
      } finally { await client.query("ROLLBACK"); client.release(); }
    } finally {
      await reader.end();
      await source.owner.query(`DROP ROLE ${login}`);
    }
  }, 55_000);

  // About 4x the slowest hosted run (13,055 ms), rounded up to 5 s.
  it.each(["acquisition_private.address_references_extra", "other_private.address_references"])("refuses other private relation %s", async relation => {
    if (relation.startsWith("other_private.")) await source.owner.query("CREATE SCHEMA other_private");
    await source.owner.query(`CREATE TABLE ${relation}(value text); INSERT INTO ${relation} VALUES('synthetic-private-row')`);
    try {
      await expect(capture(source.owner, "source-with-other-private-relation"))
        .rejects.toMatchObject({ code: "unsupported_table", table: relation, message: `postgres_transfer_unsupported_table:${relation}` });
    } finally {
      await source.owner.query(`DROP TABLE ${relation}`);
      if (relation.startsWith("other_private.")) await source.owner.query("DROP SCHEMA other_private");
    }
  }, 55_000);
});

describe("connected store transfer core", () => {
  // Each case owns a fresh qualified target and can run without another case.
  beforeEach(async () => {
    target = await targetTemplates.nextTarget(`target-${++targetNumber}`);
    pristine = await capture(target.owner, "owned-pristine-target");
  }, postgresSetupTimeoutMs);

  it("validates the exact retained approval shape after the packet digest", async () => {
    const table = "identity_privacy_erasure_reconciliations";
    const entry = seed.packet.owned.find(row => String(row.table) === table);
    expect(entry?.rows).toHaveLength(1);
    const original = JSON.parse(entry!.rows[0]!) as Record<string, string>;
    const before = await census(target.owner);
    for (const row of [{ ...original, extra: "invalid" }, ...Object.keys(original).map(key => ({ ...original, [key]: { value: original[key] } }))]) {
      const { sha256, ...body } = structuredClone(seed.packet);
      body.owned.find(item => String(item.table) === table)!.rows[0] = JSON.stringify(row);
      const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      await expect(restore({ ...body, sha256 })).rejects.toMatchObject({ code: "invalid_input", table: undefined });
      await expect(restore({ ...body, sha256: digest })).rejects.toMatchObject({ code: "invalid_input", table });
    }
    expect(await census(target.owner)).toEqual(before);
  });

  it("compares declaration authority at capture, copy and replay even when the catalogue matches", async () => {
    const initial = ["communication-events", "customer-billing", "customer-preferences", "customer-saved-addresses",
      "destination-documents", "destination-receipts", "fulfillment-parcel-contacts", "identity", "order-draft-receipts", "subscriptions", "tax-calculations"];
    expect(seed.packet).toHaveProperty("requiredPrivacyContributorIds", initial);
    expect(pristine).toHaveProperty("requiredPrivacyContributorIds", initial);
    const declaration = "identity_privacy_required_contributors";
    expect([...seed.packet.owned, ...seed.packet.compatible.tables].some(entry => String(entry.table) === declaration)).toBe(false);
    expect(seed.packet.outsideProfileCensus.some(entry => entry.relation === `public.${declaration}`)).toBe(false);
    const read = () => target.owner.query(`SELECT contributor_id,ctid::text,xmin::text FROM public.${declaration} ORDER BY contributor_id`);
    const original = (await read()).rows;
    const append = (db: Pool) => db.query(`INSERT INTO public.${declaration}(contributor_id) VALUES ('fixture-owner') ON CONFLICT (contributor_id) DO NOTHING`);
    await append(source.owner);
    try {
      const drifted = await capture(source.owner, "different-privacy-declaration");
      expect(drifted.compatible.catalogueId).toBe(seed.packet.compatible.catalogueId);
      expect(drifted.requiredPrivacyContributorIds).toContain("fixture-owner");
      const before = await census(target.owner);
      await expect(restore(drifted)).rejects.toMatchObject({ code: "target_conflict" });
      expect(await census(target.owner)).toEqual(before);
    } finally { await source.owner.query(`DELETE FROM public.${declaration} WHERE contributor_id='fixture-owner'`); }
    expect(await restore()).toMatchObject({ replayed: false });
    expect(await restore()).toMatchObject({ replayed: true });
    expect((await read()).rows).toEqual(original);
    await append(target.owner);
    await expect(restore()).rejects.toMatchObject({ code: "target_conflict" });
  }, 90_000);

  // About 4x the slowest hosted run (24,807 ms), rounded up to 5 s.
  it("restores writer-created sandbox attempts, cyclic observations and terminal review truth, then continues once", async () => {
    const before = await census(source.owner);
    expect(JSON.stringify(seed.packet)).not.toContain("dispatch-only@example.invalid");
    expect((await restore()).replayed).toBe(false);
    expect(await census(target.owner)).toEqual(before);
    expect((await restore()).replayed).toBe(true);
    // Client.end() waits for the socket to close before nextTarget() force-drops this database.
    const restarted = new Client({ connectionString: target.runtimeUrl });
    const disconnected = vi.fn();
    restarted.once("end", disconnected);
    try {
      await restarted.connect();
      const port = paymentPort(restarted), truth = createPostgresPaymentTruthPort(restarted, paymentOptions);
      const p = seed.payments;
      expect(await port.readAttempt({ settlementIntentId: p.open.intentId })).toMatchObject({ id: p.open.attempt.id, state: "dispatched", latestObservation: null });
      expect((await port.beginAttempt(p.open.input)).replayed).toBe(true);
      await expect(port.beginAttempt({ ...p.open.input, idempotencyKey: `attempt:${randomUUID()}` })).rejects.toThrow("payment_simulator_attempt_unresolved");
      expect(await port.readAttempt({ settlementIntentId: p.fenced.intentId })).toMatchObject({ id: p.active.id, state: "indeterminate" });
      expect((await port.beginAttempt(p.nextInput)).replayed).toBe(true);
      await expect(port.beginAttempt({ ...p.nextInput, idempotencyKey: `attempt:${randomUUID()}` })).rejects.toThrow("payment_simulator_attempt_unresolved");
      await expect(port.recordObservation({ ...p.refused.input, idempotencyKey: `observation:${randomUUID()}`, outcome: "captured" })).rejects.toThrow("wrong_attempt");
      expect(await paymentReceive(restarted, p.fenced.attempt, p.refused.id)).toMatchObject({ status: 200, data: { replayed: true } });
      expect(await port.recordObservation(p.captured.input)).toEqual({ id: p.captured.id, replayed: true });
      expect((await paymentReceive(restarted, p.pending.attempt, p.captured.id)).status).toBe(200);
      expect(await paymentReceive(restarted, p.pending.attempt, p.captured.id)).toMatchObject({ status: 200, data: { replayed: true } });
      for (const current of [{ ...p.open, active: p.open.attempt }, { ...p.fenced, active: p.active }]) {
        const late = await paymentObservation(restarted, current.active, "captured");
        expect((await paymentReceive(restarted, current.active, late.id)).status).toBe(200);
        expect(await paymentReceive(restarted, current.active, late.id)).toMatchObject({ status: 200, data: { replayed: true } });
      }
      for (const current of [p.open, p.fenced, p.pending]) {
        expect((await target.owner.query("SELECT id FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [current.intentId])).rows).toHaveLength(1);
        expect((await target.owner.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.paid'", [current.orderId])).rows).toHaveLength(1);
      }
      const original = await createPostgresPaymentTruthPort(source.runtime, paymentOptions).readEvent(p.reviewEvent);
      expect(await truth.readEvent(p.reviewEvent)).toEqual(original);
      expect(original).toMatchObject({ event: { applicationStatus: "review_required", state: "open", outcome: "captured" }, financial: { orderStatus: "cancelled" } });
      expect(original!.event.reviewRequiredAt).toBeTruthy();
      const observation = (await port.readAttempt({ settlementIntentId: p.review.intentId }))!.latestObservation!;
      const reconciliation = { eventId: p.reviewEvent, idempotencyKey: randomUUID(), evidenceStatus: "observed" as const, outcome: "captured" as const,
        occurredAt: paymentAt, failure: null, evidence: { sourceKind: "reconciliation_read" as const, sourceReference: observation.id,
          observedStatus: observation.outcome, observedAt: observation.occurredAt, payloadFingerprint: observation.fingerprint, attemptRef: p.review.attempt.id } };
      expect((await truth.recordReconciliation(reconciliation)).event.applicationStatus).toBe("review_required");
      expect((await truth.recordReconciliation(reconciliation)).event.replayed).toBe(true);
      for (let n = 0; n < 2; n++) expect((await truth.sweepOpenEvents({ now: "2030-01-01T00:00:00Z", limit: 1000 })).eventIds).not.toContain(p.reviewEvent);
      expect(await paymentReceive(restarted, p.review.attempt, p.cancelled.id)).toMatchObject({ status: 200, data: { replayed: true } });
      expect((await target.owner.query("SELECT e.review_required_at IS NOT NULL AS review,e.outcome,o.status FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id JOIN public.commerce_orders o ON o.id=i.order_id WHERE e.id=$1", [p.reviewEvent])).rows)
        .toEqual([{ review: true, outcome: "captured", status: "cancelled" }]);
      const reviewTransitions = "SELECT id,outcome FROM public.commerce_settlement_transitions WHERE intent_id=$1 ORDER BY id";
      expect((await target.owner.query(reviewTransitions, [p.review.intentId])).rows).toEqual((await source.owner.query(reviewTransitions, [p.review.intentId])).rows);
      expect((await target.owner.query("SELECT id FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [p.review.intentId])).rows).toEqual([]);
      for (const table of ["payment_simulator_attempts", "payment_simulator_observations"] as const) {
        const rows = seed.packet.owned.find(data => data.table === table)!.rows;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.join()).not.toContain("dispatch-only@example.invalid");
        expect(rows.join()).not.toContain("rawPayload"); expect(rows.join()).not.toContain("payerEmail");
      }
    } finally { await restarted.end(); }
    expect(disconnected).toHaveBeenCalledOnce();
  }, 100_000);

  // About 4x the slowest hosted run (16,613 ms), rounded up to 5 s.
  it("rolls back the whole restore when a captured simulator observation is missing", async () => {
    const corrupted = structuredClone(seed.packet), observations = corrupted.owned.find(data => data.table === "payment_simulator_observations")!;
    observations.rows = observations.rows.filter(row => (JSON.parse(row) as { id: string }).id !== seed.payments.captured.id);
    const { sha256: _hash, ...body } = corrupted; corrupted.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const before = await census(target.owner);
    await expect(restore(corrupted)).rejects.toMatchObject({ code: "target_conflict" });
    expect(await census(target.owner)).toEqual(before);
  }, 70_000);

  // About 4x the slowest hosted run (14,260 ms), rounded up to 5 s.
  for (const table of ["payment_simulator_attempts", "payment_simulator_observations"] as const) it(`counts linkable ${table} rows and bytes toward the transfer limits`, async () => {
    const all = [...seed.packet.compatible.tables, ...seed.packet.owned], index = all.findIndex(data => data.table === table);
    const through = all.slice(0, index + 1), rows = through.reduce((sum, data) => sum + data.rows.length, 0);
    const bytes = through.reduce((sum, data) => sum + data.rows.reduce((total, row) => total + Buffer.byteLength(row), 0), 0);
    await expect(capture(source.owner, "sandbox-row-limit", { maximumRows: rows - 1, maximumBytes: 64 * 1024 * 1024 })).rejects.toMatchObject({ code: "limit_exceeded", table });
    await expect(capture(source.owner, "sandbox-byte-limit", { maximumRows: 10000, maximumBytes: bytes - 1 })).rejects.toMatchObject({ code: "limit_exceeded", table });
    const oversized = structuredClone(seed.packet), targetRows = oversized.owned.find(data => data.table === table)!;
    targetRows.rows = Array.from({ length: 10001 }, () => targetRows.rows[0]!);
    const { sha256: _hash, ...body } = oversized; oversized.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const before = await census(target.owner);
    await expect(restore(oversized)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(await census(target.owner)).toEqual(before);
  }, 60_000);

  // About 4x the slowest hosted run (25,145 ms), rounded up to 5 s.
  it("transfers purchase owners, lines and receipts losslessly and preserves replay and bounded capture", async () => {
    for (const table of ["subscription_activations", "commerce_checkout_compensations", "fulfillment_stock_current", "fulfillment_inventory_reservations", "fulfillment_inventory_reservation_lines", "fulfillment_purchase_reservation_receipts"]) {
      expect(seed.packet.owned.find(value => value.table === table)?.rows.length).toBeGreaterThan(0);
    }
    const heldClient = await source.owner.connect();
    try {
      await heldClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      for (const table of ["subscription_activations", "commerce_checkout_compensations", "fulfillment_purchase_reservation_receipts"]) {
        const index = seed.packet.owned.findIndex(value => value.table === table);
        const priorBytes = [...seed.packet.compatible.tables, ...seed.packet.owned.slice(0, index)]
          .reduce((sum, rowset) => sum + rowset.rows.reduce((total, row) => total + Buffer.byteLength(row), 0), 0);
        const bytes = seed.packet.owned[index]!.rows.reduce((sum, row) => sum + Buffer.byteLength(row), 0);
        await expect(captureConnectedNativeStore({ sourceId: "bounded-purchase-metadata", catalogueId: selected.objectInventorySha256,
          maximumRows: 10000, maximumBytes: priorBytes + bytes - 1, source: { withSnapshot: work => work({ query: (sql, values) => heldClient.query(sql, values ? [...values] : undefined) }) } }))
          .rejects.toMatchObject({ code: "limit_exceeded", table });
      }
    } finally { await heldClient.query("ROLLBACK"); heldClient.release(); }
    expect((await restore()).replayed).toBe(false);
    const sourceRows = await census(source.owner), targetRows = await census(target.owner);
    for (const table of ["subscription_activations", "commerce_checkout_compensations", "fulfillment_stock_current", "fulfillment_inventory_reservations", "fulfillment_inventory_reservation_lines", "fulfillment_purchase_reservation_receipts"]) {
      expect(targetRows[table]).toEqual(sourceRows[table]);
    }
    expect((await restore()).replayed).toBe(true);
    const cancellation = createPostgresAbandonedCheckoutCompensationPort(target.runtime, () => "2026-09-03T12:00:00Z");
    expect(await cancellation.cancelAbandonedOrder(seed.retainedCancellation)).toEqual({ cancelled: true });
    await expect(cancellation.cancelAbandonedOrder({ ...seed.retainedCancellation, reason: "changed" })).rejects.toMatchObject({ code: "23505" });
    const port = createPostgresPurchaseReservationPort(target.runtime);
    expect(await port.reserveOrderItems(seed.purchaseHold)).toMatchObject({ replayed: true, reservations: [{ reservationId: seed.purchaseHoldId }] });
    await expect(port.reserveOrderItems({ ...seed.purchaseHold, metadata: { note: "changed" } })).rejects.toMatchObject({ code: "23505" });
    expect((await target.owner.query("SELECT count(*)::int n FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1", [seed.purchaseHold.orderId])).rows).toEqual([{ n: 1 }]);
  }, 105_000);

  // About 4x the slowest hosted run (18,202 ms), rounded up to 5 s.
  it("preserves native JSON digits above the JavaScript exact integer range", async () => {
    const carried = await capture(source.owner, "native-json-number-source");
    await restore(carried);
    expect((await target.owner.query("SELECT payload->>'frozen' AS value FROM public.outbox_events WHERE idempotency_key='original-effect-key'"))
      .rows).toEqual([{ value: "9007199254740993" }]);
  }, 75_000);

  // About 4x the slowest hosted run (18,068 ms), rounded up to 5 s.
  it("refuses a changed known trigger body and an unknown INSERT trigger before importing rows", async () => {
    const before = await census(target.owner);
    const original = (await target.owner.query<{ definition: string }>(
      "SELECT pg_catalog.pg_get_functiondef('public.fulfillment_emit_shipment_exception_notification()'::regprocedure) AS definition")).rows[0]!.definition;
    try {
      // Keeping the admitted trigger name must not admit another function body.
      await target.owner.query(`CREATE OR REPLACE FUNCTION public.fulfillment_emit_shipment_exception_notification()
        RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
        BEGIN RAISE EXCEPTION 'unreviewed_trigger_executed' USING ERRCODE='P0001'; END; $$`);
      await expect(restore()).rejects.toMatchObject({ code: "schema_conflict" });
      expect(await census(target.owner)).toEqual(before);
    } finally { await target.owner.query(original); }
    try {
      await target.owner.query(`CREATE TRIGGER retained_transfer_unapproved AFTER INSERT ON public.commerce_order_holds
        FOR EACH ROW EXECUTE FUNCTION public.fulfillment_emit_shipment_exception_notification()`);
      await expect(restore()).rejects.toMatchObject({ code: "schema_conflict" });
      expect(await census(target.owner)).toEqual(before);
    } finally { await target.owner.query("DROP TRIGGER IF EXISTS retained_transfer_unapproved ON public.commerce_order_holds"); }
    expect(await census(target.owner)).toEqual(before);
  }, 75_000);

  // About 4x the slowest hosted run (30,363 ms), rounded up to 5 s.
  it("captures only the address-reference registry census and preserves the target installation registry", async () => {
    const references = [randomUUID(), randomUUID()];
    const localReference = randomUUID();
    const insertReference = (db: Pool, reference: string) => db.query(`INSERT INTO acquisition_private.address_references
      (source,reference,revision,provenance,created_at,updated_at)
      VALUES('census_fixture',$1,'v1','synthetic_fixture','2026-09-01T12:00:00Z','2026-09-01T12:00:00Z') RETURNING id`, [reference]);
    try {
      const ids: string[] = [];
      for (const reference of references) ids.push((await insertReference(source.owner, reference)).rows[0].id);
      await insertReference(target.owner, localReference);
      const sourcePacket = await capture(source.owner, "source-with-address-reference-registry");
      const freshTarget = await capture(target.owner, "target-with-own-address-reference-registry");
      expect(sourcePacket.outsideProfileCensus.filter(entry => entry.disposition !== "unsupported-empty").map(entry => entry.relation).sort())
        .toEqual([...connectedStoreOutsideProfileRelations.keys()].sort());
      expect(sourcePacket.outsideProfileCensus.find(entry => entry.relation === "acquisition_private.address_references"))
        .toEqual({ relation: "acquisition_private.address_references", owner: "platform_acquisition_owner", rows: "2", disposition: "target-address-references" });
      expect(freshTarget.outsideProfileCensus.find(entry => entry.relation === "acquisition_private.address_references")).toMatchObject({ rows: "1" });
      expect(sourcePacket.emptyOutsideProfile).not.toContain("acquisition_private.address_references");
      expect([...sourcePacket.compatible.tables, ...sourcePacket.owned].some(entry => String(entry.table) === "address_references")).toBe(false);
      for (const value of [...references, ...ids, "synthetic_fixture"]) expect(JSON.stringify(sourcePacket)).not.toContain(value);
      expect(JSON.stringify(freshTarget)).not.toContain(localReference);
      const before = (await target.owner.query("SELECT to_jsonb(t)::text AS value,ctid::text,xmin::text FROM acquisition_private.address_references t")).rows;
      const invalid = structuredClone(sourcePacket);
      invalid.owned.push({ table: "address_references", columns: [{ name: "reference", type: "text" }], rows: ['{"reference":"synthetic-private-row"}'] } as unknown as ConnectedNativeStoreCapture["owned"][number]);
      const { sha256: _old, ...body } = invalid;
      invalid.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      await expect(restoreConnectedNativeStore({ owner: target.owner, installation: selection, packet: invalid, freshTarget }))
        .rejects.toMatchObject({ code: "invalid_input", message: "postgres_transfer_invalid_input" });
      const connect = vi.fn(async () => { throw new Error("unexpected_database_connection"); });
      const disconnectedOwner = { connect } as unknown as Pool;
      for (const [relation, patch] of [
        ["acquisition_private.address_references", { columns: [{ name: "reference", type: "text" }] }],
        ["acquisition_private.address_references", { rowData: [{ reference: references[0] }] }],
        ["acquisition_private.address_references", { disposition: "new-target-installation-key" }],
        ["acquisition_private.address_references", { disposition: "unknown-disposition" }],
        ["acquisition_private.address_references", { rows: "-1" }],
        ["acquisition_private.address_references", { rows: "1.5" }],
        ["acquisition_private.address_references", { rows: "2\n" }],
        ["acquisition_private.address_references", { rows: 2 }],
        ["acquisition_private.installation_key", { disposition: "target-address-references" }],
        ["public.platform_schema_migrations", { disposition: "target-address-references" }],
        ["public.catalog_attribute_projection", { disposition: "unsupported-empty" }],
        ["public.catalog_attribute_projection", { rowData: [{ text_value: "stale" }] }],
        ["acquisition_private.cases", { rows: "1" }],
      ] as const) {
        const malformed = structuredClone(sourcePacket);
        Object.assign(malformed.outsideProfileCensus.find(entry => entry.relation === relation)!, patch);
        const { sha256: _hash, ...payload } = malformed;
        malformed.sha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
        await expect(restoreConnectedNativeStore({ owner: disconnectedOwner, installation: selection, packet: malformed, freshTarget }))
          .rejects.toMatchObject({ code: "invalid_input", message: "postgres_transfer_invalid_input" });
        expect(connect).not.toHaveBeenCalled();
      }
      expect((await restoreConnectedNativeStore({ owner: target.owner, installation: selection, packet: sourcePacket, freshTarget })).replayed).toBe(false);
      expect((await restoreConnectedNativeStore({ owner: target.owner, installation: selection, packet: sourcePacket, freshTarget })).replayed).toBe(true);
      expect((await target.owner.query("SELECT to_jsonb(t)::text AS value,ctid::text,xmin::text FROM acquisition_private.address_references t")).rows).toEqual(before);
      expect(await census(target.owner)).toEqual(await census(source.owner));
    } finally {
      await source.owner.query("DELETE FROM acquisition_private.address_references WHERE source='census_fixture'");
      await target.owner.query("DELETE FROM acquisition_private.address_references WHERE source='census_fixture'");
    }
  }, 125_000);

  // About 4x the slowest hosted run (19,769 ms), rounded up to 5 s.
  it("refuses nonempty acquisition cases despite the address-reference census exception", async () => {
    const id = randomUUID();
    const insertCase = (db: Pool) => db.query(`INSERT INTO acquisition_private.cases
      (id,case_reference,source_kind,lifecycle,dedupe_fingerprint,consent_version,policy_version,consent_accepted_at,locale,source_path,created_at,updated_at)
      VALUES($1,$2,'partner_inquiry','new',decode(repeat('cd',32),'hex'),'not-applicable','fixture-v1',
        '2026-09-01T12:00:00Z','und','/partners/b2b-inquiries','2026-09-01T12:00:00Z','2026-09-01T12:00:00Z')`, [id, `acquisition-case:${id}`]);
    await insertCase(source.owner);
    await insertCase(target.owner);
    const before = await census(target.owner);
    try {
      await expect(capture(source.owner, "source-with-acquisition-case"))
        .rejects.toMatchObject({ code: "unsupported_table", table: "acquisition_private.cases", message: "postgres_transfer_unsupported_table:acquisition_private.cases" });
      await expect(restore()).rejects.toMatchObject({ code: "unsupported_table", table: "acquisition_private.cases", message: "postgres_transfer_unsupported_table:acquisition_private.cases" });
      expect(await census(target.owner)).toEqual(before);
      expect((await target.owner.query("SELECT id FROM acquisition_private.cases")).rows).toEqual([{ id }]);
    } finally {
      await source.owner.query("DELETE FROM acquisition_private.cases WHERE id=$1", [id]);
      await target.owner.query("DELETE FROM acquisition_private.cases WHERE id=$1", [id]);
    }
  }, 80_000);

  // About 4x the slowest hosted run (19,152 ms), rounded up to 5 s.
  it("refuses private business omission and nonpristine targets without deleting existing obligations", async () => {
    const targetBefore = await census(target.owner);
    // An actual canonical private BUSINESS row must not disappear as if private
    // meant credentials. Its key fingerprint is synthetic; no key payload is read.
    await source.owner.query(`INSERT INTO acquisition_private.rate_limit_windows VALUES('requester',decode(repeat('ab',32),'hex'),now(),1,now())`);
    try { await expect(capture(source.owner, "source-with-private-business")).rejects.toMatchObject({ code: "unsupported_table", table: "acquisition_private.rate_limit_windows" }); }
    finally { await source.owner.query("DELETE FROM acquisition_private.rate_limit_windows WHERE key_kind='requester' AND key_fingerprint=decode(repeat('ab',32),'hex')"); }
    const setting = pristine.owned.find(table => table.table === "commerce_settings")!.rows
      .find(row => (JSON.parse(row) as { key: string }).key === "shipping_flat_minor")!;
    await target.owner.query("UPDATE public.commerce_settings SET value_minor=41 WHERE key='shipping_flat_minor'");
    try {
      await expect(restore()).rejects.toMatchObject({ code: "target_conflict" });
      expect((await target.owner.query("SELECT value_minor FROM public.commerce_settings WHERE key='shipping_flat_minor'")).rows[0].value_minor).toBe(41);
    } finally {
      await target.owner.query(`UPDATE public.commerce_settings t SET value_minor=p.value_minor,value_text=p.value_text,updated_at=p.updated_at
        FROM jsonb_populate_record(NULL::public.commerce_settings,$1::jsonb) p WHERE t.key=p.key`, [setting]);
    }
    const retainedNotification = seed.packet.compatible.tables.find(table => table.table === "outbox_events")!.rows.find(row => {
      const value = JSON.parse(row) as { event_type: string; idempotency_key: string };
      return value.event_type === "commerce.shipment.exception" && value.idempotency_key === `shipment_exception:${seed.retainedHold}`;
    });
    if (!retainedNotification) throw new Error("Retained source obligation fixture missing");
    await target.owner.query("INSERT INTO public.outbox_events SELECT (pg_catalog.jsonb_populate_record(NULL::public.outbox_events,$1::jsonb)).*", [retainedNotification]);
    try {
      await expect(restore()).rejects.toMatchObject({ code: "target_conflict" });
      expect((await target.owner.query("SELECT pg_catalog.to_jsonb(o)::text AS value FROM public.outbox_events o")).rows)
        .toEqual([{ value: retainedNotification }]);
    } finally {
      await target.owner.query("DELETE FROM public.outbox_events WHERE event_type='commerce.shipment.exception' AND idempotency_key=$1", [`shipment_exception:${seed.retainedHold}`]);
    }
    expect(await census(target.owner)).toEqual(targetBefore);
  }, 80_000);

  // About 4x the slowest hosted run (13,499 ms), rounded up to 5 s.
  it("bounds customer-linked purchase facts, method events and method state in transfer", async () => {
    const compatibleRows = seed.packet.compatible.tables.reduce((sum, table) => sum + table.rows.length, 0);
    const compatibleBytes = seed.packet.compatible.tables.reduce((sum, table) => sum + table.rows.reduce((bytes, row) => bytes + Buffer.byteLength(row), 0), 0);
    let rows = compatibleRows, bytes = compatibleBytes;
    for (const name of ["subscription_renewal_attachments", "subscription_method_state_events", "subscription_method_states", "subscription_activations"]) {
      const held = seed.packet.owned.find(table => table.table === name)!;
      expect(held.rows.length).toBeGreaterThan(0);
      rows += held.rows.length; bytes += held.rows.reduce((sum, row) => sum + Buffer.byteLength(row), 0);
      for (const limits of [{ maximumRows: rows - 1, maximumBytes: 64 * 1024 * 1024 }, { maximumRows: 10000, maximumBytes: bytes - 1 }]) {
        await expect(captureConnectedNativeStore({ sourceId: "bounded-renewal-source", catalogueId: selected.objectInventorySha256, ...limits,
          source: { async withSnapshot(work) {
            const client = await source.owner.connect();
            try {
              await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
              return await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
            } finally { await client.query("ROLLBACK"); client.release(); }
          } },
        })).rejects.toMatchObject({ code: "limit_exceeded", table: name });
      }
    }
    const oversized = structuredClone(seed.packet), held = oversized.owned.find(table => table.table === "subscription_method_states")!;
    held.rows = Array.from({ length: 10001 }, () => held.rows[0]);
    const { sha256: _old, ...body } = oversized;
    oversized.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    await expect(restore(oversized)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(await census(target.owner)).toEqual(Object.fromEntries([...pristine.compatible.tables, ...pristine.owned].map(table => [table.table, [...table.rows].sort()])));
  }, 55_000);

  it("restores historical references with an exact source outbox, preserving the retained notice once", async () => {
    const before = await census(source.owner);
    expect(before.shipment_external_refs).toEqual(expect.arrayContaining(Object.values(seed.historicalReferences).map(shipment =>
      expect.stringContaining(`historical-tracking:${shipment}`))));
    const notices = before.outbox_events.map(row => JSON.parse(row) as { event_type: string; idempotency_key: string });
    expect(notices.filter(row => row.event_type === "commerce.shipment.dispatched" && row.idempotency_key === `shipment_dispatched:${seed.historicalReferences.pruned}`)).toHaveLength(0);
    expect(notices.filter(row => row.event_type === "commerce.shipment.dispatched" && row.idempotency_key === `shipment_dispatched:${seed.historicalReferences.retained}`)).toHaveLength(1);
    expect(await restore()).toMatchObject({ replayed: false, neutralizedHistoricalHoldNotifications: 1 });
    expect(await census(target.owner)).toEqual(before);
    expect((await restore()).replayed).toBe(true);
    expect((await census(target.owner)).outbox_events).toEqual(before.outbox_events);
  }, 55_000);
});
