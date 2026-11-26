import { createPostgresDestinationPort } from "@openlup/platform/commerce/server/destinations";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { Pool } from "pg";
import * as renewal from "@openlup/platform/subscriptions";
import { createPostgresFulfillmentStockSyncPort } from "@openlup/platform/fulfillment";
import type { RenewalPreparedSettlement, RenewalReservationResult, RenewalSettlementPort } from "@openlup/platform/subscriptions/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAccountLinkStore, createPostgresCustomerMePort, deriveOidcPrincipalId } from "@openlup/platform/identity";
import { createPostgresDataGateway, type PgGatewayClient } from "@openlup/platform/data";
import { createPostgresOrderReviewMediaPort } from "@openlup/platform/commerce/server";
import { captureConnectedNativeStore, connectedStoreClusterIdentitySql, type ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { mapManagedIdentityForConnectedRestore, restoreConnectedNativeStore, type ManagedIdentityMappingSource } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { createPostgresPartnerAcquisitionPort } from "../../server/adapters/postgres/partners/partnerAcquisitionRoutines.js";
import { createPartnerAcquisitionSubmitHandler } from "../../server/bff/partners/partnerAcquisitionDirect.js";
import type { VercelResponse } from "../../server/_lib/types/vercel.js";
import { OrderReviewMediaObjectStore } from "../../server/adapters/filesystem/orderReviewMediaObjectStore.js";
import { captureOrderReviewMediaFilesystem } from "../../server/adapters/filesystem/orderReviewMediaTransferInventory.js";
import { createOrderReviewMediaTransferReader } from "../../server/adapters/filesystem/orderReviewMediaTransferReader.js";
import { restoreOrderReviewMediaFilesystem } from "../../server/adapters/filesystem/orderReviewMediaTransferRestore.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { storeJourneyResources, type JourneyTargetTemplate } from "../helpers/storeJourney.js";
import {
  capture,
  census,
  consentRead,
  consentSet,
  dispatchNotices,
  mediaLimits,
  renewalAt,
  renewalDue,
  renewalFacts,
  restoreInstallation,
  seedRetainedTransferStore,
  selected,
  selection,
  transferredPrivacy,
  type Installation,
  type RetainedTransferSeed,
} from "./connectedStoreTransfer.fixture.js";

// Zero cluster-wide ROLE DDL and zero withCatalogAdmissionFence calls, so this suite
// can lease migrated template databases from the shared pgTemplateBroker.
const resources = storeJourneyResources();
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

function corruptDeclaredTotal(): ConnectedNativeStoreCapture {
  const copy = JSON.parse(JSON.stringify(seed.packet)) as ConnectedNativeStoreCapture;
  const orders = copy.compatible.tables.find(table => table.table === "commerce_orders")!;
  let changed = false;
  orders.rows = orders.rows.map(row => {
    if ((JSON.parse(row) as { id: string }).id !== seed.graph.order) return row;
    const corrupted = row.replace(/"total_amount_minor": 900(?=[,}])/, '"total_amount_minor": 901');
    if (corrupted === row) throw new Error("Deferred-total counterexample did not change the source row");
    changed = true; return corrupted;
  });
  if (!changed) throw new Error("Deferred-total counterexample source order missing");
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const { sha256: _inner, ...inner } = copy.compatible; copy.compatible.sha256 = hash(inner);
  const { sha256: _outer, ...outer } = copy; copy.sha256 = hash(outer);
  return copy;
}

describe("retained capture limits", () => {
  // About 4x the slowest hosted run (13,048 ms), rounded up to 5 s.
  it("counts personal consent history and attribution toward whole-capture row and byte limits", async () => {
    const index = seed.packet.owned.findIndex(table => table.table === "customer_account_consent_events");
    const ledger = seed.packet.owned[index]!;
    expect(ledger.rows).toHaveLength(5);
    const event = JSON.parse(ledger.rows[0]!) as Record<string, unknown>;
    expect(event).toMatchObject({ source: "customer_communication_preferences", source_ref: { route: "/api/bff/customers/communication-preferences" } });
    expect(event.recipient_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(event.principal_id).toEqual(expect.any(String));
    const prior = [...seed.packet.compatible.tables, ...seed.packet.owned.slice(0, index)];
    const priorRows = prior.reduce((total, table) => total + table.rows.length, 0);
    const priorBytes = prior.reduce((total, table) => total + table.rows.reduce((sum, row) => sum + Buffer.byteLength(row), 0), 0);
    const ledgerBytes = ledger.rows.reduce((total, row) => total + Buffer.byteLength(row), 0);
    for (const limits of [{ maximumRows: priorRows + ledger.rows.length - 1, maximumBytes: 64 * 1024 * 1024 },
      { maximumRows: 10000, maximumBytes: priorBytes + ledgerBytes - 1 }]) {
      await expect(captureConnectedNativeStore({ sourceId: "consent-limit-proof", catalogueId: selected.objectInventorySha256, ...limits,
        source: { async withSnapshot(work) {
          const client = await source.owner.connect();
          try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) }); await client.query("COMMIT"); return result; }
          catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
        } },
      })).rejects.toMatchObject({ code: "limit_exceeded", table: "customer_account_consent_events" });
    }
  }, 55_000);

  // About 4x the slowest hosted run (12,970 ms), rounded up to 5 s.
  it("counts terminal refusal source identities and times toward capture row and byte limits", async () => {
    const index = seed.packet.owned.findIndex(table => table.table === "subscription_notice_refusals");
    const retained = seed.packet.owned[index]!;
    expect(retained.rows).toHaveLength(6);
    const prior = [...seed.packet.compatible.tables, ...seed.packet.owned.slice(0, index)];
    const rowCount = prior.reduce((sum, table) => sum + table.rows.length, 0);
    const bytes = prior.reduce((sum, table) => sum + table.rows.reduce((total, row) => total + Buffer.byteLength(row), 0), 0);
    for (const limits of [{ maximumRows: rowCount + 5, maximumBytes: 64 * 1024 * 1024 },
      { maximumRows: 10000, maximumBytes: bytes + retained.rows.reduce((total, row) => total + Buffer.byteLength(row), 0) - 1 }]) {
      await capture(source.owner, "terminal-refusal-limits", limits).then(() => { throw new Error("Expected the terminal refusal capture limit"); },
        (error: { code: string; table?: string }) => expect({ code: error.code, table: error.table })
          .toEqual({ code: "limit_exceeded", table: "subscription_notice_refusals" }));
    }
  }, 55_000);

  // About 4x the slowest hosted run (13,155 ms), rounded up to 5 s.
  it("enforces actual cumulative row and byte limits at EACH address relation", async () => {
    for (const table of ["commerce_destinations", "commerce_destination_bindings"]) {
      const index = seed.packet.owned.findIndex(t => t.table === table);
      const prior = [...seed.packet.compatible.tables, ...seed.packet.owned.slice(0, index)];
      const rowsBefore = prior.reduce((n, t) => n + t.rows.length, 0);
      const bytesBefore = prior.reduce((n, t) => n + t.rows.reduce((m, row) => m + Buffer.byteLength(row), 0), 0);
      const relation = seed.packet.owned[index]!;
      expect(relation.rows.length).toBeGreaterThan(0);
      for (const limits of [
        { maximumRows: rowsBefore + relation.rows.length - 1, maximumBytes: 64 * 1024 * 1024 },
        { maximumRows: 10000, maximumBytes: bytesBefore + relation.rows.reduce((n, row) => n + Buffer.byteLength(row), 0) - 1 },
      ]) {
        await expect(captureConnectedNativeStore({ sourceId: "address-bounded", catalogueId: selected.objectInventorySha256, ...limits,
          source: { async withSnapshot(work) { const client = await source.owner.connect();
            try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); return await work({ query: (sql, args) => client.query(sql, args ? [...args] : undefined) }); }
            finally { await client.query("ROLLBACK"); client.release(); }
          } } })).rejects.toMatchObject({ code: "limit_exceeded", table });
      }
    }
  }, 55_000);
});

describe("retained graph transfer and replay", () => {
  // Each case owns a fresh qualified target and can run without another case.
  beforeEach(async () => {
    target = await targetTemplates.nextTarget(`target-${++targetNumber}`);
    pristine = await capture(target.owner, "owned-pristine-target");
  }, postgresSetupTimeoutMs);

  it.each(["aggregate_type='shipment'", "aggregate_id='00000000-0000-0000-0000-000000000001'",
    "payload=payload||'{\"unexpected\":true}'::jsonb", "metadata=metadata||'{\"unexpected\":true}'::jsonb",
    "status='processed'", "attempts=1", "processed_at=transaction_timestamp()", "error='synthetic conflict'",
    "created_at=transaction_timestamp()-interval '1 microsecond'", "available_at=transaction_timestamp()+interval '1 microsecond'", "xmin"])("refuses a restore-created reference notice with a mismatched fence: %s", async change => {
    const before = await census(target.owner);
    const connect = target.owner.connect.bind(target.owner);
    let injected = false;
    const observed = { async connect() {
      const db = await connect();
      return { async query(sql: string, values?: unknown[]) {
        const result = await db.query(sql, values);
        if (!injected && /^INSERT INTO public\."shipment_external_refs"/u.test(sql)) {
          // A subtransaction writes a distinct xmin without changing notice data.
          if (change === "xmin") await db.query("SAVEPOINT reference_notice_xmin");
          injected = (await db.query(`UPDATE public.outbox_events SET ${change === "xmin" ? "attempts=0" : change} WHERE event_type='commerce.shipment.dispatched' AND idempotency_key=$1 RETURNING id`,
            [`shipment_dispatched:${seed.historicalReferences.pruned}`])).rowCount === 1;
          if (change === "xmin") await db.query("RELEASE SAVEPOINT reference_notice_xmin");
        }
        return result;
      }, release: (destroy?: boolean) => db.release(destroy) };
    } } as unknown as Pool;
    await expect(restoreConnectedNativeStore({ owner: observed, installation: selection, packet: seed.packet, freshTarget: pristine }), change)
      .rejects.toMatchObject({ code: "target_conflict", table: "outbox_events", message: "postgres_transfer_target_conflict:outbox_events" });
    expect(injected, change).toBe(true);
    expect(await census(target.owner)).toEqual(before);
  });

  it("restores writer-produced renewal data and pending duties, then renews through the restricted runtime", async () => {
    await restore();
    expect((await restore()).replayed).toBe(true);
    for (const table of ["subscription_renewal_attachments", "subscription_method_state_events", "subscription_method_states",
      "subscription_renewal_terms", "subscription_renewal_term_lines", "subscription_activations"] as const) {
      const read = async (pool: Pool) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN READ ONLY");
          await client.query("SET LOCAL TimeZone='UTC'");
          return (await client.query(`SELECT to_jsonb(t)::text AS value FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
        } finally { await client.query("ROLLBACK"); client.release(); }
      };
      expect(await read(target.owner)).toEqual(await read(source.owner));
    }
    for (const table of ["subscription_renewal_attachments", "subscription_method_state_events"]) {
      await expect(target.runtime.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
    }
    const writer = renewal.createPostgresPurchaseRenewalWriter(target.runtime);
    expect(await writer.pending()).toContainEqual({ ...seed.pendingRenewal, hasPurchaseFacts: true });
    expect(await writer.complete(seed.pendingRenewal.orderId)).toMatchObject({ subscriptionId: seed.pendingRenewal.subscriptionId, replayed: false });
    expect(await writer.complete(seed.pendingRenewal.orderId)).toMatchObject({ replayed: true });
    await expect(writer.register(seed.pendingRenewal.orderId, { ...renewalFacts, payerAccountRef: "different@example.invalid" })).rejects.toThrow("purchase_conflict");
    expect(await writer.readMethod(seed.retainedRenewal.subscriptionId)).toMatchObject({ healthState: "healthy",
      methodRef: renewalFacts.methodRef, evidenceRef: "sandbox-repaired:customer@example.invalid" });
    // The row proof supplies current stock after restore through its production
    // writer; inventory-history transfer belongs to the final joined witness.
    await createPostgresFulfillmentStockSyncPort(target.runtime, { sourceKey: renewalFacts.stockSourceKey, readLocalInventoryStock: async () => [] })
      .recordProviderStockCurrent({ requestKey: "fixture-stock", snapshot: { providerRef: "sandbox-stock", collectedAt: renewalAt,
        sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot", skuRef: "retained-sku", totalQuantity: 100,
        forSaleQuantity: 100, reservedOrUnavailableQuantity: 0, syncRunId: "transfer-stock" }, inventoryClass: "sellable",
        lastSyncedAt: renewalAt, staleAfter: "2027-01-01T00:00:00.000Z" });
    const codec = renewal.createNativeRenewalCodec(), store = renewal.createPostgresRenewalStore(target.runtime, codec);
    const call = async <T = Record<string, unknown>>(name: string, values: unknown[]): Promise<T> =>
      (await target.runtime.query(`SELECT public.${name}(${values.map((_, index) => `$${index + 1}`).join(",")}) AS value`, values)).rows[0].value as T;
    const settlement: RenewalSettlementPort = {
      prepareRenewal: i => call<RenewalPreparedSettlement>("commerce_prepare_subscription_renewal", [i.operationId, i.claimToken, i.now]),
      acknowledgeExternalAttempt: async i => codec.readback(await call("commerce_acknowledge_subscription_renewal_attempt", [i.operationId, i.operationFingerprint, i.externalAttemptRef, i.acknowledgedAt])),
      recordTerminalOutcome: async i => codec.readback(await call("commerce_record_subscription_renewal_outcome", [i.operationId, i.eventKey, i.operationFingerprint, i.outcome, i.externalRef ?? null, i.reason ?? null, i.occurredAt])),
    };
    const due = (await store.listDue(100, renewalDue)).find(row => row.subscriptionId === seed.retainedRenewal.subscriptionId)!;
    const snapshot = await store.buildCycleSnapshots(due);
    expect(snapshot.cycle.status).toBe("correlated");
    expect(snapshot.payerAccountRef).toBe(renewalFacts.payerAccountRef);
    expect(await call("subscription_delivery_alignment_admit_renewal", [due.subscriptionId, due.scheduledAt, renewalDue]))
      .toMatchObject({ allowed: true, reason: "predecessor_delivered" });
    const rail = renewal.createPostgresSandboxRenewalRail(target.runtime, { scenario: "succeeded", now: () => renewalDue });
    const lifecycle = renewal.createPostgresRetryLifecycleBinding({ executor: target.runtime, async withTransaction(work) {
      const client = await target.runtime.connect();
      try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }, settlement: () => settlement, correlate: wire => codec.decode(wire).cycle, failureTemplate: "failed", recoveryPath: "/recover" });
    const result = await renewal.runOneAutomaticSubscriptionRenewal({ store, settlement: lifecycle.settlement, failureHandoff: lifecycle.failureHandoff,
      inventory: { expireReservations: async () => 0, reserve: i => call<RenewalReservationResult>("fulfillment_reserve_subscription_renewal", [i.operationId, i.claimToken, 900, i.now]) },
      paymentRails: { resolve: channel => channel === "sandbox" ? rail : null }, workerId: "transfer-renewal", policy: renewal.createSandboxRenewalPolicy(renewalFacts.methodRef),
    }, due, renewalDue);
    expect(result.status).toBe("succeeded");
    expect((await target.runtime.query("SELECT status FROM public.subscriptions WHERE id=$1", [seed.retainedRenewal.subscriptionId])).rows[0].status).toBe("active");
  }, 110_000);

  // Three real restore outcomes, full graph censuses and post-replay runtime
  // checks share one bounded hosted integration deadline; retry remains zero.
  it("preserves the connected retained graph, pruned history and exact replay under actual roles", async () => {
    const sourceBefore = await census(source.owner), targetBefore = await census(target.owner);
    const ledger = (await target.owner.query("SELECT to_jsonb(m)::text AS value FROM public.platform_schema_migrations m ORDER BY position")).rows;
    const keyIdentity = (await target.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows;
    const mediaInput = { root: seed.media.targetRoot, census: seed.media.census, ...mediaLimits,
      objects: createOrderReviewMediaTransferReader({ root: seed.media.sourceRoot, maximumObjectBytes: mediaLimits.maximumObjectBytes }),
      temporary: createOrderReviewMediaTransferReader({ root: seed.media.sourceRoot, maximumObjectBytes: mediaLimits.maximumObjectBytes, area: "tmp" }),
    };
    expect(await restoreOrderReviewMediaFilesystem(mediaInput)).toEqual({ replayed: false, objects: 2, temporary: 1 });
    // Files can publish before a failed DB transaction. The target stays inactive;
    // exact filesystem replay plus the original pristine DB baseline permits retry.
    await expect(restore(corruptDeclaredTotal())).rejects.toMatchObject({ code: "target_conflict" });
    expect(await census(target.owner)).toEqual(targetBefore);
    expect((await restoreOrderReviewMediaFilesystem(mediaInput)).replayed).toBe(true);
    const result = await restore();
    expect(result).toEqual({ captureSha256: seed.packet.sha256, replayed: false, neutralizedHistoricalHoldNotifications: 1 });
    expect(await census(target.owner)).toEqual(sourceBefore);
    await expect(transferredPrivacy(target).erase({ principalId: seed.retainedErasure.actor }, {
      subject: { kind: "principal", principalId: seed.erased }, idempotencyKey: seed.retainedErasure.key,
    })).resolves.toMatchObject({ outcome: "ALREADY_ERASED", erasureId: seed.retainedErasure.erasureId, obligations: [] });
    expect((await target.owner.query("SELECT to_jsonb(m)::text AS value FROM public.platform_schema_migrations m ORDER BY position")).rows).toEqual(ledger);
    expect((await target.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows).toEqual(keyIdentity);
    expect((await target.owner.query("SELECT 1 FROM public.outbox_events WHERE idempotency_key=$1", [`shipment_exception:${seed.prunedHold}`])).rows).toEqual([]);
    expect((await target.owner.query("SELECT 1 FROM public.outbox_events WHERE idempotency_key=$1", [`shipment_exception:${seed.retainedHold}`])).rows).toHaveLength(1);
    expect((await target.owner.query("SELECT unit_amount_minor::text AS value FROM public.subscription_renewal_term_lines WHERE subscription_id=$1", [seed.graph.subscription])).rows[0].value).toBe("9007199254740993");
    const tuples = (await target.owner.query("SELECT xmin::text FROM public.clients WHERE id=$1", [seed.graph.client])).rows;
    expect((await restore()).replayed).toBe(true);
    expect((await target.owner.query("SELECT xmin::text FROM public.clients WHERE id=$1", [seed.graph.client])).rows).toEqual(tuples);
    expect((await restoreOrderReviewMediaFilesystem(mediaInput)).replayed).toBe(true);
    const runtimeStore = await OrderReviewMediaObjectStore.create(seed.media.targetRoot);
    const mediaPort = createPostgresOrderReviewMediaPort(target.runtime);
    const authorized = await mediaPort.readAuthorized(seed.media.grant, seed.media.confirmedRef);
    if (!authorized) throw new Error("Retained review grant did not authorize its media under actual R");
    expect(await runtimeStore.inspect(authorized.objectKey)).toMatchObject({ exists: true,
      sha256: authorized.media.observedDigest, bytes: authorized.media.observedByteLength });
    const downloaded: Uint8Array[] = []; for await (const chunk of await runtimeStore.open(authorized.objectKey)) downloaded.push(chunk);
    expect(createHash("sha256").update(Buffer.concat(downloaded)).digest("hex")).toBe(authorized.media.observedDigest);
    expect(await mediaPort.readAuthorized(`review-grant:${randomUUID()}`, seed.media.confirmedRef)).toBeNull();
    expect(await mediaPort.readAuthorized(seed.media.grant, seed.media.pendingRef)).toBeNull();
    expect(await mediaPort.readAuthorized(seed.media.grant, seed.media.cleanupRef)).toBeNull();
    expect(await runtimeStore.inspect(seed.media.partialTemp)).toMatchObject({ exists: true, bytes: 8 });
    expect(await captureOrderReviewMediaFilesystem({ root: seed.media.targetRoot, ...mediaLimits })).toEqual(seed.media.census);
    const verified = await seed.identity.verifier.verifyToken(seed.identity.accessToken);
    if (!verified.ok) throw new Error("Retained source token did not verify at target");
    const gateway = createPostgresDataGateway({ connectionString: target.runtimeUrl }, { poolFactory: () => target.runtime });
    const me = (principalId: string) => gateway.asActor({ sub: principalId, role: "authenticated" }, db => createPostgresCustomerMePort(db as PgGatewayClient).getCustomerMe(principalId));
    expect(await me(verified.principal.principalId)).toMatchObject({ clientId: seed.graph.client, email: "retained@example.invalid" });
    const other = await seed.identity.verifier.verifyToken(await seed.identity.token("different-signed-subject"));
    if (!other.ok) throw new Error("Distinct owned subject token did not verify");
    expect(await me(other.principal.principalId)).toBeNull();
    const accounts = createPostgresAccountLinkStore({ connectionString: target.runtimeUrl });
    try {
      await expect(accounts.createAccount({ email: "erased@example.invalid", principalId: seed.erased, acquisitionSource: "direct", lifecycleStage: "lead" })).rejects.toThrow("account_erased_refused");
    } finally { await accounts.close(); }
    await expect(target.restore.query("SELECT id FROM public.clients")).rejects.toMatchObject({ code: "42501" });
    await expect(target.runtime.query("SET ROLE openlup_retained_import_owner")).rejects.toMatchObject({ code: "42501" });
    expect((await target.runtime.query("SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
      .toEqual([{ current_user: selection.runtimeLogin, session_user: selection.runtimeLogin, rolsuper: false, rolbypassrls: false }]);
    // Import never claims delivery. Only this explicit synthetic arrival after
    // recovery may shift the schedule, through the existing actual runtime rail.
    expect((await target.owner.query("SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1", [seed.successor])).rows[0].delivered_at).toBeNull();
    const arrival = () => target.runtime.query("SELECT public.fulfillment_record_alignment_arrival($1,$2,$3,$4)", ["retained-late-arrival", seed.successor, "2027-03-10T12:00:00.654321Z", "evidence:owned-arrival-evidence"]);
    await arrival();
    const schedule = (await target.owner.query("SELECT next_cycle_at::text FROM public.subscriptions WHERE id=$1", [seed.graph.subscription])).rows;
    await arrival();
    expect((await target.owner.query("SELECT next_cycle_at::text FROM public.subscriptions WHERE id=$1", [seed.graph.subscription])).rows).toEqual(schedule);
    expect(schedule[0].next_cycle_at).toBe("2027-04-07 12:00:00.654321+00");
  }, 115_000);

  // About 4x the slowest hosted run (28,914 ms), rounded up to 5 s.
  it("retains actor-written consent history, replay, suppression and trusted target across a store move", async () => {
    expect(pristine.owned.find(table => table.table === "customer_account_consent_sync_targets")!.rows).toEqual([]);
    await target.owner.query("INSERT INTO public.customer_account_consent_sync_targets(binding,provider_kind,enabled) VALUES('different-target','synthetic-provider',false)");
    try {
      await expect(restore()).rejects.toMatchObject({ code: "target_conflict" });
      expect((await target.owner.query("SELECT binding,enabled FROM public.customer_account_consent_sync_targets")).rows).toEqual([{ binding: "different-target", enabled: false }]);
    } finally { await target.owner.query("DELETE FROM public.customer_account_consent_sync_targets"); }
    await restore();
    expect(await census(target.owner)).toEqual(await census(source.owner));
    expect(await consentRead(target, seed.consent.principal, seed.graph.client)).toEqual(seed.consent.choices);
    expect(seed.consent.choices).toMatchObject({ marketingNewsletter: { state: "granted", granted: true }, marketingGiftsDiscounts: { state: "denied", granted: false } });
    expect(await consentRead(target, seed.consent.heldPrincipal, seed.consent.heldClient)).toEqual(seed.consent.heldChoices);
    expect(seed.consent.heldChoices.marketingGiftsDiscounts).toMatchObject({ state: "suppressed", granted: false });
    const beforeReplay = await census(target.owner);
    for (const [key, purpose, value, receipt] of [
      ["transfer-newsletter", "marketing_newsletter", true, seed.consent.newsletter],
      ["transfer-gift-grant", "marketing_gifts_discounts", true, seed.consent.giftGrant],
      ["transfer-gift-withdraw", "marketing_gifts_discounts", false, seed.consent.giftWithdraw],
    ] as const) expect(await consentSet(target, seed.consent.principal, seed.graph.client, purpose, value, key)).toEqual({ ...receipt, replayed: true, choices: seed.consent.choices });
    expect(await consentSet(target, seed.consent.heldPrincipal, seed.consent.heldClient, "marketing_gifts_discounts", true, "transfer-after-bounce"))
      .toEqual({ ...seed.consent.heldGrant, replayed: true, choices: seed.consent.heldChoices });
    await expect(consentSet(target, seed.consent.principal, seed.graph.client, "marketing_gifts_discounts", false, "transfer-gift-grant"))
      .rejects.toMatchObject({ code: "23505", message: "account_consent_idempotency_conflict" });
    expect(await census(target.owner)).toEqual(beforeReplay);
    expect((await restore()).replayed).toBe(true);
    const result = await consentSet(target, seed.consent.heldPrincipal, seed.consent.heldClient, "marketing_gifts_discounts", true, "target-still-held");
    expect(result.choices.marketingGiftsDiscounts).toMatchObject({ state: "suppressed", granted: false });
    expect((await target.owner.query("SELECT binding,provider_kind,event_kind FROM public.communication_native_sync_state WHERE work_id=$1", [result.workId])).rows)
      .toEqual([{ binding: "retained-account", provider_kind: "synthetic-provider", event_kind: "suppress" }]);
    expect((await target.owner.query("SELECT count(*)::int AS n FROM public.customer_account_consent_events")).rows[0].n)
      .toBe(beforeReplay.customer_account_consent_events.length + 1);
    expect((await target.owner.query("SELECT to_jsonb(t)::text AS value FROM public.customer_account_consent_sync_targets t")).rows.map(row => row.value))
      .toEqual(seed.packet.owned.find(table => table.table === "customer_account_consent_sync_targets")!.rows);
  }, 120_000);

  // About 4x the slowest hosted run (27,387 ms), rounded up to 5 s.
  it("retains terminal event and reminder refusals after changed policy, restore and replay", async () => {
    await restore();
    const rows = async () => (await target.runtime.query(`SELECT source,source_id,reason,
      to_char(refused_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,xmin::text,ctid::text
      FROM public.subscription_notice_refusals ORDER BY source,source_id`)).rows;
    const before = await rows();
    expect(before).toHaveLength(6);
    expect((await census(target.owner)).subscription_notice_refusals).toEqual((await census(source.owner)).subscription_notice_refusals);
    for (let replay = 0; replay < 2; replay++) {
      const sent = await dispatchNotices(target);
      for (const notice of seed.terminalNotices) expect(sent).not.toContain(`subscription-notice:${notice.source}:${notice.id}`);
      expect(await rows()).toEqual(before);
    }
    expect((await restore()).replayed).toBe(true);
    expect(await rows()).toEqual(before);
  }, 110_000);

  it("checks the identity mapper's erased-subject and conflict branches with synthetic records", async () => {
    const issuer = "https://issuer.example.invalid/managed";
    const liveManagedId = randomUUID(), erasedManagedId = randomUUID(), adminManagedId = randomUUID(), revokedManagedId = randomUUID();
    const liveClient = randomUUID(), erasedClient = randomUUID(), auditId = randomUUID(), erasureId = randomUUID();
    const created = "2025-01-01T00:00:00.123456Z", revokedAt = "2025-02-01T00:00:00.123456Z";
    const sourceRows = {
      clients: [
        { id: liveClient, created_at: created, updated_at: created, email: "shared@example.invalid", first_name: "Retained",
          last_name: null, phone: null, country: null, lifecycle_stage: "customer", acquisition_source: null,
          external_ref: null, metadata: {}, preferences: {}, auth_user_id: liveManagedId, identity_kind: "customer", marketing_contact_id: null },
        { id: erasedClient, created_at: created, updated_at: revokedAt, email: `erased+${erasedClient}@identity.invalid`, first_name: null,
          last_name: null, phone: null, country: null, lifecycle_stage: "inactive", acquisition_source: null,
          external_ref: null, metadata: {}, preferences: {}, auth_user_id: null, identity_kind: "customer", marketing_contact_id: null },
      ],
      adminUsers: [
        { id: adminManagedId, email: "shared@example.invalid", created_at: created, role: "admin", is_machine_actor: false,
          membership_state: "active", membership_provenance: "legacy", membership_accepted_at: created,
          membership_revoked_at: null, membership_revoked_by: null, membership_revocation_reason: null },
        { id: revokedManagedId, email: "revoked@example.invalid", created_at: created, role: "distributor", is_machine_actor: false,
          membership_state: "revoked", membership_provenance: "legacy", membership_accepted_at: created,
          membership_revoked_at: revokedAt, membership_revoked_by: adminManagedId, membership_revocation_reason: "policy" },
      ],
      revokeAudit: [{ id: auditId, actor_admin_id: adminManagedId, actor_email: "shared@example.invalid", actor_kind: "human",
        action: "revoke", source: "admin_ui", entity_type: "admin_user_membership", entity_id: revokedManagedId,
        target_admin_id: revokedManagedId, target_email: "revoked@example.invalid",
        old_value: { membershipState: "active", role: "distributor" },
        new_value: { membershipState: "revoked", revokedAt, revokedBy: adminManagedId, revocationReason: "policy" },
        occurred_at: revokedAt, idempotency_key: null, request_id: null }],
      erasures: [{ erasure_id: erasureId, idempotency_key: randomUUID(), client_id: erasedClient, principal_id: erasedManagedId,
        actor_principal_id: adminManagedId, contract_version: "identity.erasure.v1", contributor_versions: { identity: 1 },
        dispositions: [{ resource: "contact", disposition: "erased" }], retained_obligations: [], completed_at: revokedAt }],
      lifecycleEvents: [{ id: randomUUID(), client_id: liveClient, from_stage: null, to_stage: "customer", occurred_at: created },
        { id: randomUUID(), client_id: erasedClient, from_stage: "customer", to_stage: "inactive", occurred_at: revokedAt }],
    };
    const before = await census(target.owner);
    const keyIdentity = (await target.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows;
    const sourceClient = await source.owner.connect();
    let observed: ConnectedNativeStoreCapture["observation"];
    let sourceProjection: typeof sourceRows;
    try {
      await sourceClient.query("CREATE TEMP TABLE managed_identity_projection(kind text NOT NULL,payload jsonb NOT NULL)");
      for (const [kind, rows] of Object.entries(sourceRows)) for (const row of rows) {
        await sourceClient.query("INSERT INTO managed_identity_projection(kind,payload) VALUES($1,$2::jsonb)", [kind, JSON.stringify(row)]);
      }
      await sourceClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const fact = (await sourceClient.query<{ cluster: string; database: string; login: string; snapshot: string }>(`SELECT
        ${connectedStoreClusterIdentitySql} AS cluster,current_database() AS database,
        session_user::text AS login,txid_current_snapshot()::text AS snapshot`)).rows[0]!;
      observed = fact;
      // The local managed fixture is a PostgreSQL projection, not a provider-auth
      // token or source-key export. Read exact stored JSON values in one snapshot.
      const stored = async <T>(kind: string): Promise<T[]> => (await sourceClient.query<{ payload: string }>(
        "SELECT payload::text FROM managed_identity_projection WHERE kind=$1 ORDER BY payload::text", [kind]))
        .rows.map(row => JSON.parse(row.payload) as T);
      sourceProjection = {
        clients: await stored<(typeof sourceRows.clients)[number]>("clients"),
        adminUsers: await stored<(typeof sourceRows.adminUsers)[number]>("adminUsers"),
        revokeAudit: await stored<(typeof sourceRows.revokeAudit)[number]>("revokeAudit"),
        erasures: await stored<(typeof sourceRows.erasures)[number]>("erasures"),
        lifecycleEvents: await stored<(typeof sourceRows.lifecycleEvents)[number]>("lifecycleEvents"),
      };
      await sourceClient.query("COMMIT");
    } catch (error) { await sourceClient.query("ROLLBACK"); throw error; }
    finally { await sourceClient.query("DROP TABLE IF EXISTS managed_identity_projection").catch(() => undefined); sourceClient.release(); }
    const subjects = [liveManagedId, erasedManagedId, adminManagedId, revokedManagedId]
      .map(managedId => ({ managedId, subject: managedId }));
    const evidence: ManagedIdentityMappingSource = { sourceId: "representative-managed-identity", issuer,
      observation: observed, subjects, ...sourceProjection };
    const mapped = await mapManagedIdentityForConnectedRestore({ source: evidence, freshTarget: pristine, targetOwner: target.owner });
    const otherIssuer = await mapManagedIdentityForConnectedRestore({ source: { ...evidence,
      issuer: "https://other-issuer.example.invalid/managed" }, freshTarget: pristine, targetOwner: target.owner });
    expect(otherIssuer.subjects[0]!.principalId).not.toBe(mapped.subjects[0]!.principalId);
    expect(mapped.subjects).toEqual(subjects.map(({ managedId, subject }) => ({ managedId, issuer, subject,
      principalId: deriveOidcPrincipalId(issuer, subject) })));
    expect(mapped.packet.observation).toEqual(observed);
    expect(mapped.auditReferences).toEqual([{ sourceId: evidence.sourceId, sourceRowId: auditId, targetAuditId: auditId }]);
    expect(await restoreConnectedNativeStore({ owner: target.owner, installation: selection, packet: mapped.packet, freshTarget: pristine }))
      .toMatchObject({ replayed: false });
    expect((await target.owner.query("SELECT id,principal_id,email FROM public.clients ORDER BY id")).rows).toEqual([
      { id: liveClient, principal_id: deriveOidcPrincipalId(issuer, liveManagedId), email: "shared@example.invalid" },
      { id: erasedClient, principal_id: null, email: `erased+${erasedClient}@identity.invalid` },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect((await target.owner.query("SELECT principal_id,role,membership_state FROM public.platform_human_memberships ORDER BY principal_id")).rows)
      .toEqual([{ principal_id: deriveOidcPrincipalId(issuer, adminManagedId), role: "admin", membership_state: "active" },
        { principal_id: deriveOidcPrincipalId(issuer, revokedManagedId), role: "distributor", membership_state: "revoked" }]
        .sort((a, b) => a.principal_id.localeCompare(b.principal_id)));
    expect((await target.owner.query("SELECT actor_principal_id,target_principal_id,old_value,new_value FROM public.platform_human_membership_audit_events WHERE id=$1", [auditId])).rows)
      .toEqual([{ actor_principal_id: deriveOidcPrincipalId(issuer, adminManagedId),
        target_principal_id: deriveOidcPrincipalId(issuer, revokedManagedId), old_value: { membershipState: "active", role: "distributor" },
        new_value: { membershipState: "revoked", revokedAt, revokedBy: deriveOidcPrincipalId(issuer, adminManagedId),
          revocationReason: "policy", sourceAuditRef: { sourceId: evidence.sourceId, rowId: auditId } } }]);
    expect((await target.owner.query("SELECT principal_id,client_id,dispositions FROM public.identity_privacy_erasures WHERE erasure_id=$1", [erasureId])).rows)
      .toEqual([{ principal_id: deriveOidcPrincipalId(issuer, erasedManagedId), client_id: erasedClient,
        dispositions: [{ resource: "contact", disposition: "erased" }] }]);
    await expect(transferredPrivacy(target).erase({ principalId: deriveOidcPrincipalId(issuer, adminManagedId) }, {
      subject: { kind: "contact", contactId: erasedClient }, idempotencyKey: sourceRows.erasures[0]!.idempotency_key,
    })).rejects.toMatchObject({ code: "PRIVACY_RECEIPT_COVERAGE_INCOMPLETE",
      facts: { observed: expect.stringMatching(/fulfillment-parcel-contacts, identity, subscriptions/u) } });
    expect((await target.owner.query("SELECT email,first_name,last_name,phone,country,metadata,principal_id FROM public.clients WHERE id=$1", [erasedClient])).rows)
      .toEqual([{ email: `erased+${erasedClient}@identity.invalid`, first_name: null, last_name: null,
        phone: null, country: null, metadata: {}, principal_id: null }]);
    expect((await target.owner.query("SELECT from_stage,to_stage FROM public.customer_subject_lifecycle_events WHERE client_id=$1 ORDER BY occurred_at", [erasedClient])).rows)
      .toEqual([{ from_stage: "customer", to_stage: "inactive" }]);
    const accounts = createPostgresAccountLinkStore({ connectionString: target.runtimeUrl });
    try {
      await expect(accounts.createAccount({ email: "same@example.invalid", principalId: deriveOidcPrincipalId(issuer, erasedManagedId),
        acquisitionSource: "direct", lifecycleStage: "lead" })).rejects.toThrow("account_erased_refused");
    } finally { await accounts.close(); }
    expect((await target.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows).toEqual(keyIdentity);
    expect((await restoreConnectedNativeStore({ owner: target.owner, installation: selection, packet: mapped.packet, freshTarget: pristine })).replayed).toBe(true);
    const linkedSource = evidence.clients.find(row => row.auth_user_id === liveManagedId)!;
    const erasedSource = evidence.clients.find(row => row.id === erasedClient)!;
    const invalid = [
      { ...evidence, subjects: subjects.filter(value => value.managedId !== liveManagedId) },
      { ...evidence, erasures: [] },
      { ...evidence, clients: [{ ...evidence.clients[0], preferences: { hidden: true } }, evidence.clients[1]] },
      { ...evidence, adminUsers: [{ ...evidence.adminUsers[0], is_machine_actor: true }, evidence.adminUsers[1]] },
      { ...evidence, erasures: [{ ...evidence.erasures[0], principal_id: liveManagedId }] },
      { ...evidence, erasures: [{ ...evidence.erasures[0], unsupported_field: "retained-source-only" }] },
      { ...evidence, erasures: [...evidence.erasures, { ...evidence.erasures[0], erasure_id: randomUUID(),
        idempotency_key: randomUUID(), client_id: null, principal_id: adminManagedId }] },
      { ...evidence, adminUsers: evidence.adminUsers.map(row => row.id === revokedManagedId
        ? { ...row, email: `erased+${revokedManagedId}@identity.invalid` } : row) },
      { ...evidence, issuer: "https://issuer.example.invalid/managed#alias" },
      { ...evidence, revokeAudit: [{ ...evidence.revokeAudit[0], actor_admin_id: randomUUID() }] },
      { ...evidence, revokeAudit: [{ ...evidence.revokeAudit[0], unexpected_field: "unsafe" }] },
      { ...evidence, clients: evidence.clients.map(row => row.id === erasedClient ? { ...row, email: "erased+leak@example.invalid" } : row) },
    ];
    for (const candidate of invalid) await expect(mapManagedIdentityForConnectedRestore({ source: candidate, freshTarget: pristine, targetOwner: target.owner }))
      .rejects.toMatchObject({ code: "invalid_input" });
    const redactedOperator = { ...evidence,
      adminUsers: evidence.adminUsers.map(row => row.id === revokedManagedId
        ? { ...row, email: `erased+${revokedManagedId}@identity.invalid`, membership_revocation_reason: null } : row),
      revokeAudit: [{ ...evidence.revokeAudit[0], new_value: { membershipState: "revoked", revokedAt, revokedBy: adminManagedId } }],
      erasures: [...evidence.erasures, { ...evidence.erasures[0], erasure_id: randomUUID(),
        idempotency_key: randomUUID(), client_id: null, principal_id: revokedManagedId }],
    };
    const redactedMapping = await mapManagedIdentityForConnectedRestore({ source: redactedOperator,
      freshTarget: pristine, targetOwner: target.owner });
    const mappedRows = (table: string) => (redactedMapping.packet.compatible.tables.find(entry => entry.table === table)
      ?? redactedMapping.packet.owned.find(entry => entry.table === table))!.rows
      .map(row => JSON.parse(row) as Record<string, unknown>);
    expect(mappedRows("platform_human_principals")).toContainEqual(expect.objectContaining({
      principal_id: deriveOidcPrincipalId(issuer, revokedManagedId), email: `erased+${revokedManagedId}@identity.invalid` }));
    expect(mappedRows("platform_human_memberships")).toContainEqual(expect.objectContaining({
      principal_id: deriveOidcPrincipalId(issuer, revokedManagedId), membership_state: "revoked", membership_revocation_reason: null }));
    expect(mappedRows("identity_privacy_erasures")).toContainEqual(expect.objectContaining({
      principal_id: deriveOidcPrincipalId(issuer, revokedManagedId), client_id: null }));
    for (const field of [
      { old_value: { ...(evidence.revokeAudit[0]!.old_value as Record<string, unknown>), role: "admin" } },
      { new_value: { ...(evidence.revokeAudit[0]!.new_value as Record<string, unknown>), revokedBy: liveManagedId } },
      { new_value: { ...(evidence.revokeAudit[0]!.new_value as Record<string, unknown>), revokedAt: created } },
      { new_value: { ...(evidence.revokeAudit[0]!.new_value as Record<string, unknown>), revocationReason: "different" } },
    ]) await expect(mapManagedIdentityForConnectedRestore({ source: { ...evidence,
      revokeAudit: [{ ...evidence.revokeAudit[0], ...field }] }, freshTarget: pristine, targetOwner: target.owner }))
      .rejects.toMatchObject({ code: "target_conflict", table: "platform_human_membership_audit_events" });
    await expect(mapManagedIdentityForConnectedRestore({ source: { ...evidence,
      adminUsers: evidence.adminUsers.map(row => row.id === revokedManagedId
        ? { ...row, membership_revoked_by: revokedManagedId } : row) },
    freshTarget: pristine, targetOwner: target.owner }))
      .rejects.toMatchObject({ code: "target_conflict", table: "platform_human_membership_audit_events" });
    await expect(mapManagedIdentityForConnectedRestore({ source: { ...evidence, clients: [linkedSource,
      { ...linkedSource, id: randomUUID(), email: "other@example.invalid" }, erasedSource] },
    freshTarget: pristine, targetOwner: target.owner })).rejects.toMatchObject({ code: "target_conflict", table: "clients" });
    expect(before.clients).toEqual([]);
  }, 100_000);

  // About 4x the slowest hosted run (20,554 ms), rounded up to 5 s.
  it("retains private destinations, scoped bindings, support replay and exact address data after restore", async () => {
    await restore();
    // The existing census compares every field in UTC without truncating stored microseconds.
    const targetRows = await census(target.owner), sourceRows = await census(source.owner);
    for (const table of ["commerce_destinations", "commerce_destination_bindings", "subscription_command_receipts", "customer_support_subscription_commands", "customer_support_subscription_audit_events"]) {
      expect(targetRows[table]).toEqual(sourceRows[table]);
    }
    const original = await createPostgresDestinationPort(target.runtime).registerOrder({ idempotencyKey: `destination-${seed.graph.order}`, orderId: seed.graph.order,
      address: { recipientName: "Synthetic personal recipient", line1: "Synthetic personal street", city: "Fixture", postalCode: "00000", country: "ZZ" }, now: "2026-09-02T12:00:00Z" });
    expect(original).toEqual(seed.retainedDestination);
    const replay = await target.runtime.query("SELECT public.customer_support_change_shipping_destination($1,$2,$3,$4,$5,'2026-09-02T12:00:00Z') result", [seed.destinationCommand.operator, seed.destinationCommand.subscription, seed.destinationCommand.payload, seed.destinationCommand.version, seed.destinationCommand.key]);
    expect(replay.rows[0].result).toMatchObject({ replayed: true });
    await expect(target.runtime.query("SELECT public.customer_support_change_shipping_destination($1,$2,$3,$4,$5,'2026-09-02T12:00:00Z')", [seed.destinationCommand.operator, seed.destinationCommand.subscription, seed.destinationCommand.payload, seed.destinationCommand.version + 1, seed.destinationCommand.key])).rejects.toMatchObject({ code: "23505" });
  }, 85_000);

  it("drains every target acquisition command before opening a new installation-key namespace", async () => {
    const sourcePort = createPostgresPartnerAcquisitionPort({ connectionString: source.ownerUrl });
    const targetPort = createPostgresPartnerAcquisitionPort({ connectionString: target.ownerUrl });
    ports.push(sourcePort);
    try {
      const input = { idempotencyKey: "managed-drain-command-1", requesterKey: "synthetic-requester",
        policyVersion: "partner-inquiry-request-v1", sourcePath: "/partners/b2b-inquiries" as const,
        acceptedAt: new Date().toISOString(), request: { company: "Synthetic Partner", country: "US",
          firstName: "Ada", lastName: "Example", email: "drain-source@example.invalid", phone: "+15551234567", notes: null } };
      expect(await sourcePort.submit(input)).toMatchObject({ ok: true, replayed: false });
      expect(await sourcePort.submit(input)).toMatchObject({ ok: true, replayed: true });
      const sourceReceipt = (await source.owner.query("SELECT to_jsonb(c)::text AS value FROM acquisition_private.commands c WHERE scope='partner_submit' AND idempotency_key=$1", [input.idempotencyKey])).rows;
      expect(sourceReceipt).toHaveLength(1);
      const sourceDigest = (await source.owner.query("SELECT encode(acquisition_private.keyed_digest('transfer-probe','{}'::jsonb),'hex') AS digest")).rows[0].digest;
      const targetDigest = (await target.owner.query("SELECT encode(acquisition_private.keyed_digest('transfer-probe','{}'::jsonb),'hex') AS digest")).rows[0].digest;
      expect(targetDigest).not.toBe(sourceDigest);
      const keyIdentity = (await target.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows;

      const started = new Date(Date.now() - 1000).toISOString();
      const env = { OPENLUP_ACQUISITION_DRAIN_STARTED_AT: started, OPENLUP_ACQUISITION_DRAIN_MAX_SECONDS: "3600" };
      const request = (key: string, email: string) => ({ method: "POST", query: {}, headers: { "idempotency-key": key,
        "x-forwarded-for": "127.0.0.1" }, socket: { remoteAddress: "127.0.0.1" },
        body: { company: "Synthetic Partner", country: "US", firstName: "Ada",
        lastName: "Example", email, phone: "+15551234567", notes: null } });
      const response = () => {
        const headers: Record<string, string> = {};
        let statusCode = 0, body: unknown;
        const res = { setHeader(name: string, value: string) { headers[name] = value; return res; },
          status(value: number) { statusCode = value; return res; }, json(value: unknown) { body = value; return res; } } as unknown as VercelResponse;
        return { res, headers, get statusCode() { return statusCode; }, get body() { return body; } };
      };
      const during = response();
      await createPartnerAcquisitionSubmitHandler({ env, resolvePort: async () => targetPort })(
        request(input.idempotencyKey, "drain-source@example.invalid") as unknown as Parameters<ReturnType<typeof createPartnerAcquisitionSubmitHandler>>[0], during.res);
      expect(during.statusCode).toBe(503);
      expect(Number(during.headers["Retry-After"])).toBeGreaterThan(0);
      expect(during.body).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE",
        details: { reason: "acquisition_legacy_drain" } } });
      expect((await target.owner.query("SELECT count(*)::integer AS count FROM acquisition_private.commands")).rows[0].count).toBe(0);

      const ended = response();
      await createPartnerAcquisitionSubmitHandler({ env: { ...env, OPENLUP_ACQUISITION_DRAIN_ENDED_AT: new Date().toISOString() },
        resolvePort: async () => targetPort })(request(input.idempotencyKey, "drain-source@example.invalid") as unknown as Parameters<ReturnType<typeof createPartnerAcquisitionSubmitHandler>>[0], ended.res);
      expect(ended.statusCode).toBe(200);
      expect((await target.owner.query("SELECT count(*)::integer AS count FROM acquisition_private.commands WHERE scope='partner_submit' AND idempotency_key=$1", [input.idempotencyKey])).rows[0].count).toBe(1);

      const maximum = response();
      await createPartnerAcquisitionSubmitHandler({ env: { OPENLUP_ACQUISITION_DRAIN_STARTED_AT: new Date(Date.now() - 2000).toISOString(),
        OPENLUP_ACQUISITION_DRAIN_MAX_SECONDS: "1" }, resolvePort: async () => targetPort })(
        request("managed-drain-command-2", "drain-second@example.invalid") as unknown as Parameters<ReturnType<typeof createPartnerAcquisitionSubmitHandler>>[0], maximum.res);
      expect(maximum.statusCode).toBe(200);
      expect((await target.owner.query("SELECT count(*)::integer AS count FROM acquisition_private.commands WHERE scope='partner_submit'")).rows[0].count).toBe(2);
      expect((await source.owner.query("SELECT to_jsonb(c)::text AS value FROM acquisition_private.commands c WHERE scope='partner_submit' AND idempotency_key=$1", [input.idempotencyKey])).rows).toEqual(sourceReceipt);
      expect((await target.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows).toEqual(keyIdentity);
    } finally { await targetPort.close(); }
  }, 55_000);

  // About 4x the slowest hosted run (24,658 ms), rounded up to 5 s.
  it("round-trips open, event-backed and receipt-backed package previews under the current inventory", async () => {
    const captured = seed.packet.owned.find(table => table.table === "subscription_quote_previews");
    expect(captured?.columns).toContainEqual({ name: "accepted_noop_receipt_id", type: "uuid" });
    expect(captured?.rows).toHaveLength(3);
    expect(seed.packet.compatible.catalogueId).toBe(selected.objectInventorySha256);
    expect(pristine.compatible.catalogueId).toBe(seed.packet.compatible.catalogueId);
    const sourceRows = await census(source.owner);
    expect((await restore()).replayed).toBe(false);
    expect(await census(target.owner)).toEqual(sourceRows);
    expect((await target.owner.query(`SELECT q.status,e.event_type,r.idempotency_key AS receipt_key,
      s.client_id=q.client_id AS owned
      FROM public.subscription_quote_previews q JOIN public.subscriptions s ON s.id=q.subscription_id
      LEFT JOIN public.subscription_events e ON e.id=q.accepted_event_id
      LEFT JOIN public.subscription_command_receipts r ON r.id=q.accepted_noop_receipt_id
      ORDER BY q.status,r.idempotency_key NULLS FIRST`)).rows)
      .toEqual([
        { status: "accepted", event_type: "subscription.customer_self_service.update_package_template", receipt_key: null, owned: true },
        { status: "accepted", event_type: null, receipt_key: "retained-package-noop", owned: true },
        { status: "previewed", event_type: null, receipt_key: null, owned: true },
      ]);
    expect((await restore()).replayed).toBe(true);
    expect(await census(target.owner)).toEqual(sourceRows);
  }, 100_000);
});
