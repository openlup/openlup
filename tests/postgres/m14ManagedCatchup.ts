// Managed first leg for the opt-in H1/H2 connected journey. Compose 8A's
// typed projection with the existing native restore; history stays at source.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { mapManagedRetainedBusiness } from "../../server/adapters/postgres/connectedManagedRetained.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { acquisitionLegacyDrain } from "../../server/runtime/marketing/acquisitionLegacyDrain.js";
import type { ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import type { QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { assertCatchupActivation, catchupDrain, interruptPool } from "./m14ConnectedCatchup.js";
import { captureManagedSource, managed, managedFixtureIds, seedManagedSource } from "./m14ManagedSourceFixture.js";

type Installation = { owner: Pool; runtime: Pool; runner: { status(): Promise<{ pending: unknown[] }> } };
export type ManagedObligations = { subscriptionId: string; failedIntentId: string; paidIntentId: string;
  paidOrderId: string; productId: string; addedProduct: string; deletedProductId: string; consentFingerprint: string };
const tables = (capture: ConnectedNativeStoreCapture) => [...capture.compatible.tables, ...capture.owned];
const count = (capture: ConnectedNativeStoreCapture) =>
  Object.fromEntries(tables(capture).map(table => [table.table, table.rows.length]));
const rows = (capture: ConnectedNativeStoreCapture) =>
  Object.fromEntries(tables(capture).map(table => [table.table, table.rows]));
const archivedRelations = ["payment_provider_settlement_batches", "payment_provider_settlement_items",
  "commerce_idempotency_keys", "payment_external_refs", "admin_audit_events"] as const;
export async function assertManagedArchiveAbsent(db: Pool) {
  for (const table of archivedRelations) {
    const relation = (await db.query("SELECT to_regclass($1) AS relation", [`public.${table}`])).rows[0]?.relation;
    if (relation) assert.equal(Number((await db.query(`SELECT count(*) FROM public."${table}"`)).rows[0]?.count), 0,
      `history-only ${table} must have no target rows`);
  }
}

/** The fixture's only admitted writer and DDL lane is its setup pool. No
 * Auth/Storage API, router or application process starts in the managed stack.
 * seal() ends that pool before opening a read-only final reader. */
export async function managedFirstLeg(input: {
  final: Installation; installation: QualifiedAdminPostgresInstallation;
  createPreliminary: () => Promise<Installation>;
  captureNative: (db: Pool, sourceId: string) => Promise<ConnectedNativeStoreCapture>;
}) {
  const at = performance.now();
  try {
    await managed.start();
    await seedManagedSource();
    const preliminary = await input.createPreliminary();
    const pristinePreliminary = await input.captureNative(preliminary.owner, "managed-preliminary-pristine");
    await managed.owner.query(`INSERT INTO public.commerce_idempotency_keys
      (scope,idempotency_key,status,expires_at,metadata)
      VALUES('checkout','source-unexpired:1','completed','2099-01-01T00:00:00Z','{}')`);
    try {
      const blocked = await captureManagedSource();
      assert.equal(blocked.dispositions.find(row => row.relation === "public.commerce_idempotency_keys")?.disposition,
        "requires-active-mapping");
      await assert.rejects(mapManagedRetainedBusiness({ capture: blocked,
        issuer: "https://issuer.example.invalid/managed", freshTarget: pristinePreliminary,
        targetOwner: preliminary.owner }), { code: "unsupported_table", table: "public.commerce_idempotency_keys" });
    } finally {
      await managed.owner.query("DELETE FROM public.commerce_idempotency_keys WHERE idempotency_key='source-unexpired:1'");
    }
    let exportReads = 0;
    await assert.rejects(captureManagedSource(interruptPool(managed.owner, async sql => {
      if (sql.includes("AS value") && ++exportReads === 8) throw new Error("managed export interruption");
    })), { code: "database_unavailable" });
    assert.equal(exportReads, 8);
    const early = await captureManagedSource();
    const mappedEarly = await mapManagedRetainedBusiness({ capture: early,
      issuer: "https://issuer.example.invalid/managed", freshTarget: pristinePreliminary,
      targetOwner: preliminary.owner });
    let importInterrupted = false;
    const change = async () => {
      await managed.owner.query("UPDATE public.catalog_products SET name='Retained product updated' WHERE id=$1", [managedFixtureIds.productId]);
      await managed.owner.query("UPDATE public.communication_permissions SET state='denied' WHERE contact_id=$1", [managedFixtureIds.contactId]);
      await managed.owner.query("DELETE FROM public.catalog_products WHERE id=$1", [managedFixtureIds.deletedProductId]);
      const addedProduct = randomUUID();
      await managed.owner.query("INSERT INTO public.catalog_products(id,slug,status,name) VALUES($1,'retained-added','active','New retained product')", [addedProduct]);
      return { addedProduct };
    };
    let changed: Awaited<ReturnType<typeof change>> | undefined;
    let changeFailure: unknown;
    const interruptedOwner = interruptPool(preliminary.owner, async sql => {
      if (!importInterrupted && sql.startsWith('INSERT INTO public."commerce_orders"')) {
        importInterrupted = true;
        try { changed = await change(); }
        catch (error) { changeFailure = error; throw error; }
        throw new Error("managed import interruption after typed writes");
      }
    });
    await assert.rejects(restoreConnectedNativeStore({ owner: interruptedOwner, installation: input.installation,
      packet: mappedEarly.packet, freshTarget: pristinePreliminary }), { code: "database_unavailable" });
    if (changeFailure) throw changeFailure;
    assert(importInterrupted && changed);
    const finalChange = changed;
    assert.deepEqual(rows(await input.captureNative(preliminary.owner, "managed-import-rollback")), rows(pristinePreliminary));
    await restoreConnectedNativeStore({ owner: preliminary.owner, installation: input.installation,
      packet: mappedEarly.packet, freshTarget: pristinePreliminary });
    assert.equal((await restoreConnectedNativeStore({ owner: preliminary.owner, installation: input.installation,
      packet: mappedEarly.packet, freshTarget: pristinePreliminary })).replayed, true);
    assert.notDeepEqual(count(await input.captureNative(preliminary.owner, "managed-preliminary-filled")), count(pristinePreliminary));
    let preliminaryActivated = false;
    assert.throws(() => {
      assertCatchupActivation({ sourceFrozen: false, graphPublished: true, filesystemPublished: true,
        qualified: true, generation: "managed-preliminary", finalGeneration: "managed-preliminary",
        serving: { observed: 1, allowed: 1, denied: 1 }, drain: catchupDrain().env,
        effects: { accepted: 2, uncertain: 1, pending: 1 } });
      preliminaryActivated = true;
    }, /catchup_activation_agreement_required/);
    assert.equal(preliminaryActivated, false);
    const finalReader = await managed.seal();
    const finalCapture = await captureManagedSource(finalReader);
    const pristineFinal = await input.captureNative(input.final.owner, "managed-final-pristine");
    const mappedFinal = await mapManagedRetainedBusiness({ capture: finalCapture,
      issuer: "https://issuer.example.invalid/managed", freshTarget: pristineFinal,
      targetOwner: input.final.owner });
    const sourceProducts = (await finalReader.query("SELECT id,name FROM public.catalog_products ORDER BY id")).rows;
    assert(sourceProducts.some(row => row.id === managedFixtureIds.productId && row.name === "Retained product updated"));
    assert(sourceProducts.some(row => row.id === finalChange.addedProduct && row.name === "New retained product"));
    assert(!sourceProducts.some(row => row.id === managedFixtureIds.deletedProductId));
    const sourceConsent = (await finalReader.query("SELECT state FROM public.communication_permissions WHERE contact_id=$1",
      [managedFixtureIds.contactId])).rows;
    assert.deepEqual(sourceConsent, [{ state: "denied" }]);
    const contact = (await finalReader.query("SELECT normalized_email FROM public.communication_contacts WHERE id=$1",
      [managedFixtureIds.contactId])).rows;
    assert.equal(contact.length, 1);
    const consentFingerprint = createHash("sha256").update(contact[0]!.normalized_email).digest("hex");
    const sourceSettlement = (await finalReader.query("SELECT status FROM public.payment_provider_settlement_batches WHERE id=$1",
      [managedFixtureIds.settlementBatchId])).rows;
    const sourceItem = (await finalReader.query("SELECT status FROM public.payment_provider_settlement_items WHERE batch_id=$1",
      [managedFixtureIds.settlementBatchId])).rows;
    const sourceKey = (await finalReader.query("SELECT status,expires_at FROM public.commerce_idempotency_keys WHERE idempotency_key='source-expired:1'")).rows;
    assert.deepEqual(sourceSettlement, [{ status: "reconciled" }]);
    assert.deepEqual(sourceItem, [{ status: "matched" }]);
    assert.equal(sourceKey.length, 1);
    assert.equal(sourceKey[0]!.status, "completed");
    assert(new Date(sourceKey[0]!.expires_at).getTime() < Date.now());
    const archived = archivedRelations.map(table => finalCapture.dispositions.find(row => row.relation === `public.${table}`));
    assert.deepEqual(archived.map(row => ({ rows: row?.rows, disposition: row?.disposition })),
      archivedRelations.map(() => ({ rows: 1, disposition: "retained-history" })));
    const packetText = JSON.stringify(mappedFinal.packet);
    for (const marker of ["synthetic-batch:1", "source-expired:1", "settled-raw-payload-marker", "source-session:paid"])
      assert(!packetText.includes(marker), `source-archive marker ${marker} must not enter target packet`);
    const projectedProducts = tables(mappedFinal.packet).find(table => table.table === "catalog_products")?.rows.map(row => JSON.parse(row));
    assert(projectedProducts?.some(row => row.id === managedFixtureIds.productId && row.name === "Retained product updated"));
    assert(projectedProducts?.some(row => row.id === finalChange.addedProduct && row.name === "New retained product"));
    assert(!projectedProducts?.some(row => row.id === managedFixtureIds.deletedProductId));
    await restoreConnectedNativeStore({ owner: input.final.owner, installation: input.installation,
      packet: mappedFinal.packet, freshTarget: pristineFinal });
    const native = await input.captureNative(input.final.owner, "managed-first-leg-final");
    for (const table of tables(mappedFinal.packet)) {
      const actual = tables(native).find(item => item.table === table.table);
      assert.deepEqual(actual?.rows, table.rows, `mapped ${table.table} must survive first leg`);
    }
    await assertManagedArchiveAbsent(input.final.owner);
    assert.deepEqual((await input.final.runtime.query("SELECT name FROM public.catalog_products WHERE id=$1",
      [managedFixtureIds.productId])).rows, [{ name: "Retained product updated" }]);
    assert.deepEqual((await input.final.runtime.query("SELECT id FROM public.catalog_products WHERE id=$1",
      [managedFixtureIds.deletedProductId])).rows, []);
    assert.deepEqual((await input.final.runtime.query("SELECT name FROM public.catalog_products WHERE id=$1",
      [finalChange.addedProduct])).rows, [{ name: "New retained product" }]);
    assert.deepEqual((await input.final.runtime.query(`SELECT state FROM public.communication_recipient_consents
      WHERE recipient_fingerprint=$1 AND purpose='marketing_newsletter'`, [consentFingerprint])).rows, [{ state: "denied" }]);
    assert.deepEqual((await input.final.runtime.query("SELECT status,external_ref FROM public.commerce_settlement_intents WHERE id=$1",
      [managedFixtureIds.paidIntentId])).rows, [{ status: "settled", external_ref: "provider-paid:1" }]);
    assert.equal((await input.final.runner.status()).pending.length, 0);
    assert.deepEqual((await input.final.runtime.query("SELECT current_user,session_user")).rows,
      [{ current_user: input.installation.runtimeLogin, session_user: input.installation.runtimeLogin }]);
    const pendingOutbox = Number((await input.final.runtime.query("SELECT count(*) FROM public.outbox_events WHERE status='pending'")).rows[0]?.count);
    const owedDuties = Number((await input.final.runtime.query("SELECT count(*) FROM public.invoicing_duties WHERE status='owed'")).rows[0]?.count);
    const drain = catchupDrain();
    const activation = { sourceWriterRetired: true, graphPublished: true, typedReadback: true,
      effectiveAccess: true, drainConfigured: acquisitionLegacyDrain(drain.env).state === "draining",
      effectsReconciled: pendingOutbox >= 1 && owedDuties === 1 };
    const requireAgreement = (facts: typeof activation) =>
      assert(Object.values(facts).every(Boolean), "managed_first_leg_activation_agreement_required");
    for (const key of Object.keys(activation) as (keyof typeof activation)[])
      assert.throws(() => requireAgreement({ ...activation, [key]: false }), /managed_first_leg_activation_agreement_required/);
    requireAgreement(activation);
    return { obligations: { subscriptionId: managedFixtureIds.subscriptionId, failedIntentId: managedFixtureIds.intentId,
      paidIntentId: managedFixtureIds.paidIntentId, paidOrderId: managedFixtureIds.paidOrderId,
      productId: managedFixtureIds.productId, addedProduct: finalChange.addedProduct,
      deletedProductId: managedFixtureIds.deletedProductId, consentFingerprint },
      report: { source: "pinned local managed installation", sourceId: managedFixtureIds.sourceId,
        preliminary: { captureSha256: early.sha256, counts: count(mappedEarly.packet), exportInterruptedAfterReads: exportReads,
          importInterruptedAfterWrites: importInterrupted, atomicRollback: true, resumedAndReplayed: true,
          unexpiredCompletedKeyRefused: true,
          refusal: "managed writer not retired; preliminary generation remains inactive", targetActivated: preliminaryActivated },
        final: { captureSha256: finalCapture.sha256, counts: count(mappedFinal.packet), sourceWriterRetired: true,
          updatedRows: 2, addedRows: 1, deletedRows: 1, targetGenerationFresh: true, targetQualified: true,
          sourceArchive: archived.map(row => ({ relation: row!.relation, rows: row!.rows, disposition: row!.disposition })),
          typedSettledPayment: true, typedConsent: true, historyOnlyRowsAbsent: true },
        activation: { ...activation, refusalCases: Object.keys(activation).length, pendingOutbox, owedDuties },
        elapsedMs: Math.round(performance.now() - at), hostedQualification: false } };
  } finally { await managed.stop(); }
}
