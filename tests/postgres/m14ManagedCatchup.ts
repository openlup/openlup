// Managed first leg for the opt-in H1/H2 connected journey. This composes 8A's
// finite capture/restore and the existing object store; no transfer coordinator.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Pool } from "pg";
import { copyTransferObjects, createFilesystemTransferObjects,
  type TransferObject, type TransferObjectRead } from "@openlup/platform/portability";
import { assembleManagedRetainedTransfer, mapManagedRetainedBusiness,
  readManagedRetainedHistory, restoreManagedRetainedTransfer } from "../../server/adapters/postgres/connectedManagedRetained.js";
import { acquisitionLegacyDrain } from "../../server/runtime/marketing/acquisitionLegacyDrain.js";
import type { ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import type { QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { assertCatchupActivation, catchupDrain, interruptPool } from "./m14ConnectedCatchup.js";
import { captureManagedSource, managed, managedFixtureIds, seedManagedSource } from "./m14ManagedSourceFixture.js";

type Installation = { owner: Pool; runtime: Pool; runner: { status(): Promise<{ pending: unknown[] }> } };
type Transfer = ReturnType<typeof assembleManagedRetainedTransfer>;
const count = (capture: ConnectedNativeStoreCapture) =>
  Object.fromEntries([...capture.compatible.tables, ...capture.owned].map(table => [table.table, table.rows.length]));
const rows = (capture: ConnectedNativeStoreCapture) =>
  Object.fromEntries([...capture.compatible.tables, ...capture.owned].map(table => [table.table, table.rows]));
const historyKey = (transfer: Transfer) => transfer.retainedObject.key;
const managedObject = (name: string, bytes: Buffer): TransferObject => ({
  key: `managed-storage/retained/${name}`, version: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
  metadata: { contentType: "text/plain" }, access: "private-media" });
const objectInventory = (sourceId: string, object: TransferObject) => ({ sourceId,
  snapshot: { kind: "immutable" as const, id: object.version }, objects: [object] });
const privateMedia = (root: string) => createFilesystemTransferObjects({ root, maximumObjectBytes: 1024, access: "private-media" });
async function readBytes(read: TransferObjectRead, expected: TransferObject) {
  assert.deepEqual(read.object, expected);
  const chunks: Buffer[] = [];
  for await (const chunk of read.body) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.byteLength, expected.bytes);
  return bytes;
}

/** The managed fixture's only admitted writer and DDL lane is its setup pool.
 * No Auth, Storage API, router or application process is launched in this
 * pinned stack. seal() ends that pool before opening a read-only final reader. */
export async function managedFirstLeg(input: {
  scratch: string; final: Installation; installation: QualifiedAdminPostgresInstallation;
  createPreliminary: () => Promise<Installation>;
  captureNative: (db: Pool, sourceId: string) => Promise<ConnectedNativeStoreCapture>;
}) {
  const at = performance.now();
  let preliminary: Installation | undefined;
  try {
    await managed.start();
    await seedManagedSource();
    const managedObjects = await privateMedia(join(input.scratch, "managed-source-objects"));
    const oldObject = managedObject("synthetic.txt", Buffer.from("managed object before catch-up"));
    await managedObjects.createIfAbsent(oldObject, Buffer.from("managed object before catch-up"));
    preliminary = await input.createPreliminary();
    const pristinePreliminary = await input.captureNative(preliminary.owner, "managed-preliminary-pristine");
    let exportReads = 0;
    await assert.rejects(captureManagedSource(interruptPool(managed.owner, async sql => {
      if (sql.includes("AS value") && ++exportReads === 8) throw new Error("managed export interruption");
    })), { code: "database_unavailable" });
    assert.equal(exportReads, 8);
    const early = await captureManagedSource();
    const mappedEarly = await mapManagedRetainedBusiness({ capture: early,
      issuer: "https://issuer.example.invalid/managed", freshTarget: pristinePreliminary,
      targetOwner: preliminary.owner });
    const earlyTransfer = assembleManagedRetainedTransfer(mappedEarly);
    const earlyStore = await createFilesystemTransferObjects({ root: join(input.scratch, "managed-preliminary-history"),
      maximumObjectBytes: 64 * 1024 * 1024, access: "private-retained-history" });
    await earlyStore.createIfAbsent(earlyTransfer.retainedObject.object, earlyTransfer.retainedObject.bytes);
    const earlyMedia = await privateMedia(join(input.scratch, "managed-preliminary-objects"));
    const earlyObjectCopy = await copyTransferObjects({ inventory: objectInventory(managedFixtureIds.sourceId, oldObject),
      source: managedObjects, destination: earlyMedia, accessMapping: { "private-media": "private-media" },
      maximumObjectBytes: 1024, maximumTotalBytes: 1024 });
    assert.deepEqual(earlyObjectCopy.verifiedKeys, [oldObject.key]);
    let importInterrupted = false;
    const change = async () => {
      await managed.owner.query("UPDATE public.catalog_products SET name='Retained product updated' WHERE id=$1", [managedFixtureIds.productId]);
      await managed.owner.query("UPDATE public.communication_permissions SET state='denied' WHERE contact_id=$1", [managedFixtureIds.contactId]);
      await managed.owner.query("DELETE FROM public.catalog_products WHERE id=$1", [managedFixtureIds.deletedProductId]);
      await managed.owner.query("UPDATE storage.objects SET name='new.txt' WHERE bucket_id='retained' AND name='synthetic.txt'");
      const addedProduct = randomUUID();
      await managed.owner.query("INSERT INTO public.catalog_products(id,slug,status,name) VALUES($1,'retained-added','active','New retained product')", [addedProduct]);
      const newObject = managedObject("new.txt", Buffer.from("managed object after catch-up"));
      await managedObjects.createIfAbsent(newObject, Buffer.from("managed object after catch-up"));
      return { addedProduct, newObject };
    };
    let changed: Awaited<ReturnType<typeof change>> | undefined;
    let changeFailure: unknown;
    const interruptedOwner = interruptPool(preliminary.owner, async sql => {
      if (!importInterrupted && sql.startsWith('INSERT INTO public."commerce_orders"')) {
        importInterrupted = true;
        try { changed = await change(); }
        catch (error) { changeFailure = error; throw error; }
        throw new Error("managed import interruption after retained writes");
      }
    });
    await assert.rejects(restoreManagedRetainedTransfer({ owner: interruptedOwner, installation: input.installation,
      transfer: earlyTransfer, retainedObjects: earlyStore, freshTarget: pristinePreliminary }),
    { code: "database_unavailable" });
    if (changeFailure) throw changeFailure;
    assert(importInterrupted && changed);
    const finalChange = changed;
    assert.deepEqual(rows(await input.captureNative(preliminary.owner, "managed-import-rollback")), rows(pristinePreliminary));
    await restoreManagedRetainedTransfer({ owner: preliminary.owner, installation: input.installation,
      transfer: earlyTransfer, retainedObjects: earlyStore, freshTarget: pristinePreliminary });
    assert.equal((await restoreManagedRetainedTransfer({ owner: preliminary.owner, installation: input.installation,
      transfer: earlyTransfer, retainedObjects: earlyStore, freshTarget: pristinePreliminary })).replayed, true);
    assert.notDeepEqual(count(await input.captureNative(preliminary.owner, "managed-preliminary-filled")), count(pristinePreliminary));
    // The preliminary generation cannot take over: its source is still writable.
    const preliminaryRefusal = "managed writer not retired; preliminary generation remains inactive";
    let preliminaryActivated = false;
    assert.throws(() => {
      assertCatchupActivation({ sourceFrozen: false, graphPublished: true, filesystemPublished: true,
        requiresSidecar: true,
        qualified: true, generation: "managed-preliminary", finalGeneration: "managed-preliminary",
        serving: { observed: 1, allowed: 1, denied: 1 },
        drain: catchupDrain().env,
        effects: { accepted: 2, uncertain: 1, pending: 1 },
        sidecar: { required: true, physicalReadback: true, privacyCovered: true, objectsReadback: true,
          sourceDigest: earlyTransfer.retainedObject.sha256, targetDigest: earlyTransfer.retainedObject.sha256 } });
      preliminaryActivated = true;
    }, /catchup_activation_agreement_required/);
    assert.equal(preliminaryActivated, false);
    assert.equal((await managed.owner.query("SELECT name FROM public.catalog_products WHERE id=$1",
      [managedFixtureIds.productId])).rows[0]?.name, "Retained product updated");
    assert.deepEqual((await managed.owner.query("SELECT name FROM storage.objects WHERE bucket_id='retained' ORDER BY name")).rows,
      [{ name: "new.txt" }]);
    const finalReader = await managed.seal();
    const finalCapture = await captureManagedSource(finalReader);
    const pristineFinal = await input.captureNative(input.final.owner, "managed-final-pristine");
    const mappedFinal = await mapManagedRetainedBusiness({ capture: finalCapture,
      issuer: "https://issuer.example.invalid/managed", freshTarget: pristineFinal,
      targetOwner: input.final.owner });
    const finalTransfer = assembleManagedRetainedTransfer(mappedFinal);
    const firstStore = await createFilesystemTransferObjects({ root: join(input.scratch, "managed-final-history"),
      maximumObjectBytes: 64 * 1024 * 1024, access: "private-retained-history" });
    const firstMedia = await privateMedia(join(input.scratch, "managed-final-objects"));
    const finalObjectCopy = await copyTransferObjects({ inventory: objectInventory(managedFixtureIds.sourceId, finalChange.newObject),
      source: managedObjects, destination: firstMedia, accessMapping: { "private-media": "private-media" },
      maximumObjectBytes: 1024, maximumTotalBytes: 1024 });
    assert.deepEqual(finalObjectCopy.verifiedKeys, [finalChange.newObject.key]);
    await assert.rejects(firstMedia.read(oldObject.key, oldObject.version), { code: "absent" });
    await assert.rejects(restoreManagedRetainedTransfer({ owner: input.final.owner, installation: input.installation,
      transfer: finalTransfer, retainedObjects: firstStore, freshTarget: pristineFinal }), { code: "absent" });
    await firstStore.createIfAbsent(finalTransfer.retainedObject.object, finalTransfer.retainedObject.bytes);
    const read = await firstStore.read(historyKey(finalTransfer), finalTransfer.retainedObject.object.version);
    const readback = readManagedRetainedHistory(await readBytes(read, finalTransfer.retainedObject.object),
      finalTransfer.retainedObject.sha256);
    assert.deepEqual(readback, mappedFinal.retained);
    await restoreManagedRetainedTransfer({ owner: input.final.owner, installation: input.installation,
      transfer: finalTransfer, retainedObjects: firstStore, freshTarget: pristineFinal });
    const native = await input.captureNative(input.final.owner, "managed-first-leg-final");
    for (const table of [...mappedFinal.packet.compatible.tables, ...mappedFinal.packet.owned]) {
      const actual = [...native.compatible.tables, ...native.owned].find(item => item.table === table.table);
      assert.deepEqual(actual?.rows, table.rows, `mapped ${table.table} must survive first leg`);
    }
    assert.equal((await input.final.runner.status()).pending.length, 0);
    const productRows = mappedFinal.retained.rows.filter(row => row.relation === "public.catalog_products");
    assert(mappedEarly.retained.rows.some(row => row.relation === "public.catalog_products"
      && row.value.includes(managedFixtureIds.deletedProductId)));
    assert(productRows.some(row => row.value.includes("Retained product updated")));
    assert(productRows.some(row => row.value.includes(finalChange.addedProduct)));
    assert(!productRows.some(row => row.value.includes(managedFixtureIds.deletedProductId)));
    assert.equal(mappedFinal.retained.rows.filter(row => row.relation === "public.admin_audit_events").length, 1);
    const earlyStorage = mappedEarly.retained.rows.filter(row => row.relation === "storage.objects");
    const finalStorage = mappedFinal.retained.rows.filter(row => row.relation === "storage.objects");
    assert.equal(earlyStorage.length, 1);
    assert.equal(finalStorage.length, 1);
    assert.equal(finalStorage[0]!.rowIdentity, earlyStorage[0]!.rowIdentity);
    const deniedHistory = await createFilesystemTransferObjects({ root: join(input.scratch, "managed-final-history"),
      maximumObjectBytes: 64 * 1024 * 1024, access: "public" });
    await assert.rejects(deniedHistory.read(finalTransfer.retainedObject.key), { code: "denied" });
    const deniedMedia = await createFilesystemTransferObjects({ root: join(input.scratch, "managed-final-objects"),
      maximumObjectBytes: 1024, access: "public" });
    await assert.rejects(deniedMedia.read(finalChange.newObject.key), { code: "denied" });
    assert.deepEqual((await input.final.runtime.query("SELECT current_user,session_user")).rows,
      [{ current_user: input.installation.runtimeLogin, session_user: input.installation.runtimeLogin }]);
    const pendingOutbox = Number((await input.final.runtime.query("SELECT count(*) FROM public.outbox_events WHERE status='pending'")).rows[0]?.count);
    const owedDuties = Number((await input.final.runtime.query("SELECT count(*) FROM public.invoicing_duties WHERE status='owed'")).rows[0]?.count);
    const drain = catchupDrain();
    const activation = { sourceWriterRetired: true, graphPublished: true, sidecarReadback: true,
      mediaReadback: finalObjectCopy.verifiedKeys.length === 1, effectiveAccess: true,
      drainConfigured: acquisitionLegacyDrain(drain.env).state === "draining",
      effectsReconciled: pendingOutbox >= 1 && owedDuties === 1 };
    const requireAgreement = (facts: typeof activation) =>
      assert(Object.values(facts).every(Boolean), "managed_first_leg_activation_agreement_required");
    for (const key of Object.keys(activation) as (keyof typeof activation)[]) {
      assert.throws(() => requireAgreement({ ...activation, [key]: false }),
        /managed_first_leg_activation_agreement_required/);
    }
    requireAgreement(activation);
    return { transfer: finalTransfer, firstStore, firstMedia, finalMediaObject: finalChange.newObject, readback,
      obligations: { subscriptionId: managedFixtureIds.subscriptionId, failedIntentId: managedFixtureIds.intentId,
        paidIntentId: managedFixtureIds.paidIntentId, paidOrderId: managedFixtureIds.paidOrderId },
      report: { source: "pinned local managed installation", sourceId: managedFixtureIds.sourceId,
        preliminary: { captureSha256: early.sha256, counts: count(mappedEarly.packet),
          sidecarSha256: earlyTransfer.retainedObject.sha256, sidecarRows: mappedEarly.retained.rows.length,
          exportInterruptedAfterReads: exportReads, importInterruptedAfterWrites: importInterrupted,
          atomicRollback: true, resumedAndReplayed: true, objectCopied: earlyObjectCopy.copied,
          refusal: preliminaryRefusal, targetActivated: preliminaryActivated },
        final: { captureSha256: finalCapture.sha256, counts: count(mappedFinal.packet),
          sidecarSha256: finalTransfer.retainedObject.sha256, sidecarRows: mappedFinal.retained.rows.length,
          sidecarBytes: finalTransfer.retainedObject.bytes.byteLength, sourceWriterRetired: true,
          updatedRows: 2, addedRows: 1, deletedRows: 1, objectMetadataUpdated: 1,
          targetGenerationFresh: true, targetQualified: true, objectReadback: true,
          privateMediaCopied: finalObjectCopy.copied, obsoleteMediaAbsent: true },
        activation: { ...activation, refusalCases: Object.keys(activation).length, pendingOutbox, owedDuties },
        elapsedMs: Math.round(performance.now() - at), hostedQualification: false } };
  } finally { await managed.stop(); }
}

/** Copy the actual first-target private object to the second installation and
 * read its entire disposition back before any activation decision. */
export async function carryManagedSidecar(input: { scratch: string; first: Awaited<ReturnType<typeof managedFirstLeg>> }) {
  const { transfer, firstStore } = input.first;
  const secondStore = await createFilesystemTransferObjects({ root: join(input.scratch, "second-final-history"),
    maximumObjectBytes: 64 * 1024 * 1024, access: "private-retained-history" });
  const copied = await copyTransferObjects({ inventory: { sourceId: transfer.manifest.sourceId,
    snapshot: { kind: "quiesced", id: transfer.retainedObject.object.lineage!.snapshotId },
    objects: [transfer.retainedObject.object] }, source: firstStore, destination: secondStore,
  accessMapping: { "private-retained-history": "private-retained-history" },
  maximumObjectBytes: 64 * 1024 * 1024, maximumTotalBytes: 64 * 1024 * 1024 });
  assert.deepEqual(copied.verifiedKeys, [transfer.retainedObject.key]);
  const read = await secondStore.read(transfer.retainedObject.key, transfer.retainedObject.object.version);
  const retained = readManagedRetainedHistory(await readBytes(read, transfer.retainedObject.object),
    transfer.retainedObject.sha256);
  assert.deepEqual(retained, input.first.readback);
  const deniedHistory = await createFilesystemTransferObjects({ root: join(input.scratch, "second-final-history"),
    maximumObjectBytes: 64 * 1024 * 1024, access: "public" });
  await assert.rejects(deniedHistory.read(transfer.retainedObject.key), { code: "denied" });
  const secondMedia = await privateMedia(join(input.scratch, "second-final-managed-objects"));
  const mediaSource = { ...input.first.finalMediaObject, lineage: {
    sourceId: transfer.manifest.sourceId, snapshotId: input.first.finalMediaObject.version,
    sourceVersion: input.first.finalMediaObject.version } };
  const media = await copyTransferObjects({ inventory: objectInventory(transfer.manifest.sourceId, mediaSource),
    source: input.first.firstMedia, destination: secondMedia, accessMapping: { "private-media": "private-media" },
    maximumObjectBytes: 1024, maximumTotalBytes: 1024 });
  assert.deepEqual(media.verifiedKeys, [input.first.finalMediaObject.key]);
  await assert.rejects(secondMedia.read("managed-storage/retained/synthetic.txt"), { code: "absent" });
  const deniedMedia = await createFilesystemTransferObjects({ root: join(input.scratch, "second-final-managed-objects"),
    maximumObjectBytes: 1024, access: "public" });
  await assert.rejects(deniedMedia.read(input.first.finalMediaObject.key), { code: "denied" });
  return { copied, retained, objectSha256: transfer.retainedObject.sha256,
    rows: retained.rows.length, privacyCovered: true, mediaObjects: media.copied, objectsReadback: true };
}
