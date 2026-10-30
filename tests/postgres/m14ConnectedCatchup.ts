// Finite fixture composition for runM14EffectHandover --catch-up. No production
// activation service, data delta engine or independent execution entrypoint.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool, QueryConfig } from "pg";
import { createPostgresOrderReviewLifecyclePort, createPostgresOrderReviewMediaPort } from "@openlup/platform/commerce/server";
import { type ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { OrderReviewMediaObjectStore } from "../../server/adapters/filesystem/orderReviewMediaObjectStore.js";
import { captureOrderReviewMediaFilesystem, reconcileOrderReviewMediaFilesystem, type OrderReviewMediaSourceReference } from "../../server/adapters/filesystem/orderReviewMediaTransferInventory.js";
import { stageOrderReviewMediaFilesystem } from "../../server/adapters/filesystem/orderReviewMediaTransferRestore.js";
import { createOrderReviewMediaTransferReader } from "../../server/adapters/filesystem/orderReviewMediaTransferReader.js";
import { reconcileOrderReviewMediaServing, type MediaServingProbe } from "../../server/adapters/filesystem/orderReviewMediaTransferAccess.js";
import { createOrderReviewMediaBffHandler } from "../../server/bff/order-review/media.js";
import { createAdminOrderReviewMediaBffHandler } from "../../server/bff/admin/order-review/media.js";
import type { OrderReviewRuntimeBinding } from "../../server/runtime/commerce/orderReviewBinding.js";
import { acquisitionLegacyDrain, refuseAcquisitionCommandDuringLegacyDrain } from "../../server/runtime/marketing/acquisitionLegacyDrain.js";
import { executor, fixture } from "../helpers/fulfillmentNative.js";

type Graph = ConnectedNativeStoreCapture;
type Restore = Parameters<typeof restoreConnectedNativeStore>[0];
export const catchupMediaLimits = { maximumFiles: 20, maximumObjectBytes: 1024, maximumTotalBytes: 4096 };
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const rows = (graph: Graph) => Object.fromEntries([...graph.compatible.tables, ...graph.owned].map(t => [t.table, t.rows]));
export const catchupCounts = (graph: Graph) => Object.fromEntries(Object.entries(rows(graph)).map(([table, values]) => [table, values.length]));

/** One fixture barrier shared by the refused and successful activation paths.
 * This consumes observed proof in the single writer; it certifies no other host. */
export function assertCatchupActivation(facts: {
  sourceFrozen: boolean; graphPublished: boolean; filesystemPublished: boolean;
  qualified: boolean; generation: string; finalGeneration: string;
  serving?: { observed: number; allowed: number; denied: number };
  drain?: Record<string, string>; effects?: { accepted: number; uncertain: number; pending: number };
}) {
  assert(facts.sourceFrozen && facts.graphPublished && facts.filesystemPublished && facts.qualified
    && facts.generation === facts.finalGeneration && facts.serving && facts.serving.observed > 0
    && facts.serving.allowed > 0 && facts.serving.denied > 0
    && facts.drain && acquisitionLegacyDrain(facts.drain).state === "draining"
    && facts.effects?.accepted === 2 && facts.effects.uncertain === 1 && facts.effects.pending === 1,
  "catchup_activation_agreement_required");
}

/** Inject a lost operation after real driver work; all rollback/unlock paths are the actual adapter's. */
export function interruptPool(owner: Pool, after: (sql: string) => Promise<void>): Pool {
  return { async connect() {
    const client = await owner.connect();
    return { async query(sql: string | QueryConfig, values?: unknown[]) {
      const result = typeof sql === "string" ? await client.query(sql, values) : await client.query(sql);
      await after(typeof sql === "string" ? sql : sql.text);
      return result;
    }, release: (destroy?: boolean) => client.release(destroy) };
  } } as unknown as Pool;
}

/** Prepare a real active/frozen/money/duty fixture before any source seal. */
export async function seedCatchup(input: { owner: Pool; runtime: Pool; mediaRoot: string; grant: string; subscription: string; client: string; order: string }) {
  const { owner, runtime, mediaRoot, grant, subscription } = input;
  await owner.query("INSERT INTO public.commerce_settings(key,value_minor) VALUES('catchup_updated',1),('catchup_deleted',2)");
  await owner.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
    VALUES($1,'XXX','fixture-stock','fixture-settlement','2020-01-02T03:04:05.654321Z','catchup-authorization')`, [subscription]);
  await owner.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,'retained-sku',1,9007199254740993)", [subscription]);
  const openOrder = randomUUID(), client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'pending_payment','XXX',9007199254740993)", [openOrder, input.client]);
    await client.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,9007199254740993,9007199254740993)", [openOrder]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await owner.query(`INSERT INTO public.commerce_settlement_intents(order_id,channel_key,amount_minor,currency_code,open_idempotency_key)
    VALUES($1,'fixture-settlement',9007199254740993,'XXX',$2)`, [openOrder, `owed-${openOrder}`]);
  await owner.query("INSERT INTO public.invoicing_duties(order_id,original_key) VALUES($1,'catchup-invoice-duty')", [input.order]);
  await owner.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,status,attempts)
    VALUES('subscription',$1,'retained.owed','catchup-effect-key','{"frozen":9007199254740993}','processing',3)`, [subscription]);
  const store = await OrderReviewMediaObjectStore.create(mediaRoot);
  const lifecycle = createPostgresOrderReviewLifecyclePort(executor(runtime));
  const media = createPostgresOrderReviewMediaPort(executor(runtime), { async run(work) {
    const client = await runtime.connect();
    try { await client.query("BEGIN"); const result = await work(executor(client)); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  } });
  // These are source fixture operations before retirement, through the existing
  // native intent/admit/finalize/confirm lifecycle, not invented retained rows.
  async function upload(name: string, bytes: Buffer) {
    const capabilityDigest = sha(randomUUID());
    const intent = await lifecycle.createMediaIntent({ grant, contentType: "image/png", byteLength: bytes.length,
      capabilityDigest, commandKey: `catchup-intent:${name}` });
    const writerRef = `catchup:${randomUUID()}`;
    const admitted = await media.admitUpload({ capabilityDigest, declaredContentType: "image/png", declaredByteLength: bytes.length, writerRef });
    assert.equal(admitted.kind, "lease"); assert(admitted.kind === "lease");
    const receipt = await store.writeTemp(writerRef, (async function* () { yield bytes; })(), bytes.length, admitted.reservation.leaseExpiresAt);
    assert(await media.finalizeUpload({ capabilityDigest, writerRef, leaseVersion: admitted.reservation.leaseVersion,
      digest: receipt.sha256, byteLength: receipt.bytes, promote: () => store.promote(receipt.tempRef, admitted.reservation.objectKey) }));
    await lifecycle.confirmMedia({ grant, mediaRef: intent.media.mediaRef, digest: receipt.sha256, commandKey: `catchup-confirm:${name}` });
    return { ref: intent.media.mediaRef, key: admitted.reservation.objectKey };
  }
  const other = await fixture(owner), otherGrant = `review-grant:${randomUUID()}`;
  const subject = `client:${other.client}`;
  await owner.query("INSERT INTO public.subscriber_profiles(subject_reference,revision,fingerprint) VALUES($1,1,$2)", [subject, "d".repeat(64)]);
  await owner.query("INSERT INTO public.subscriber_review_access_grants(order_id,kind,grant_reference,expires_at) VALUES($1,'review_request',$2,'2999-01-01')", [other.order, otherGrant]);
  await owner.query(`INSERT INTO public.subscriber_retention_intents(idempotency_key,subject_reference,subscription_id,source_reference,
    access_grant_reference,kind,template_reference,fingerprint,expected_revision,recipient_fingerprint,control_key,status,delivery_reference,attempt_count)
    VALUES($1,$2,$3,$4,$5,'review_request','retained.review',$6,1,$7,'retained.review','accepted','retained-other-delivery',1)`,
    [`retained-${other.order}`, subject, other.subscription, `order:${other.order}`, otherGrant, "e".repeat(64), "f".repeat(64)]);
  const partialDigest = sha(randomUUID()), partialWriter = `catchup-partial:${randomUUID()}`;
  const partial = await lifecycle.createMediaIntent({ grant, contentType: "image/png", byteLength: 100,
    capabilityDigest: partialDigest, commandKey: "catchup-retained-partial" });
  const partialAdmission = await media.admitUpload({ capabilityDigest: partialDigest, declaredContentType: "image/png", declaredByteLength: 100, writerRef: partialWriter });
  assert(partialAdmission.kind === "lease");
  const partialFile = await store.writeTemp(partialWriter, (async function* () { yield Buffer.from("retained partial body"); })(), 100, partialAdmission.reservation.leaseExpiresAt);
  assert(partialFile.bytes < 100);
  const bytes = Buffer.from("finite synthetic media before catch-up");
  const updated = await upload("updated", bytes);
  let changed = false;
  return { updated, otherGrant, partial: { ref: partial.media.mediaRef, key: partialFile.tempRef }, async change() {
    assert(!changed); changed = true;
    await owner.query("UPDATE public.commerce_settings SET value_minor=11 WHERE key='catchup_updated'");
    await owner.query("DELETE FROM public.commerce_settings WHERE key='catchup_deleted'");
    await owner.query("INSERT INTO public.commerce_settings(key,value_minor) VALUES('catchup_new',3)");
    const next = Buffer.from("finite synthetic media after catch-up with changed bytes");
    writeFileSync(join(mediaRoot, "objects", updated.key), next, { mode: 0o600 });
    await owner.query("UPDATE public.commerce_order_review_media SET observed_digest=$2,observed_byte_length=$3 WHERE media_reference=$1", [updated.ref, sha(next), next.length]);
    const added = await upload("new", next);
    return { updated: { ...updated, sha256: sha(next), bytes: next.length }, added };
  } };
}

export async function preliminaryCatchup(input: {
  owner: Pool; runtime: Pool; mediaRoot: string; grant: string; scratch: string;
  preliminary: Omit<Restore, "packet" | "freshTarget">;
  capture: (db: Pool, id: string) => Promise<Graph>;
  seed: Awaited<ReturnType<typeof seedCatchup>>;
}) {
  const at = performance.now();
  // The real read-only snapshot transaction has visited multiple tables before
  // I/O interruption. No partial packet is published; resume recaptures it.
  let reads = 0;
  await assert.rejects(input.capture(interruptPool(input.owner, async sql => {
    if (sql.includes("AS value") && ++reads === 8) throw new Error("synthetic export interruption");
  }), "interrupted-preliminary"), { code: "database_unavailable" });
  assert.equal(reads, 8);
  const packet = await input.capture(input.owner, "preliminary-source");
  writeFileSync(join(input.scratch, "preliminary-graph.json"), JSON.stringify(packet), { mode: 0o600, flag: "wx" });
  const media = await captureOrderReviewMediaFilesystem({ root: input.mediaRoot, ...catchupMediaLimits });
  const staged = await stageOrderReviewMediaFilesystem({ servingRoot: join(input.scratch, "serving-media"), generationId: "preliminary", census: media,
    objects: createOrderReviewMediaTransferReader({ root: input.mediaRoot, maximumObjectBytes: 1024 }),
    temporary: createOrderReviewMediaTransferReader({ root: input.mediaRoot, maximumObjectBytes: 1024, area: "tmp" }), ...catchupMediaLimits });
  const freshTarget = await input.capture(input.preliminary.owner, "pristine-preliminary");
  // Source changes while real preliminary target import is in progress. The
  // packet remains its earlier consistent snapshot and must never be promoted.
  let interrupted = false, changes: Awaited<ReturnType<typeof input.seed.change>> | undefined;
  const brokenOwner = interruptPool(input.preliminary.owner, async sql => {
    if (!interrupted && sql.startsWith('INSERT INTO public."fulfillment_shipments"')) {
      interrupted = true; changes = await input.seed.change();
      throw new Error("synthetic import interruption after retained writes");
    }
  });
  await assert.rejects(restoreConnectedNativeStore({ ...input.preliminary, owner: brokenOwner, packet, freshTarget }), { code: "database_unavailable" });
  assert(interrupted && changes);
  assert.deepEqual(rows(await input.capture(input.preliminary.owner, "after-import-rollback")), rows(freshTarget));
  const imported = await restoreConnectedNativeStore({ ...input.preliminary, packet, freshTarget });
  assert.equal(imported.replayed, false);
  assert.equal((await restoreConnectedNativeStore({ ...input.preliminary, packet, freshTarget })).replayed, true);
  assert.deepEqual(rows(await input.capture(input.preliminary.owner, "resumed-preliminary")), rows(packet));
  // Refuse before any takeover: roll back selection to the still-authoritative
  // source. This fixture has no target job/application process to release.
  let targetStarted = false;
  const activate = () => {
    assertCatchupActivation({ sourceFrozen: false, graphPublished: true, filesystemPublished: true,
      qualified: true, generation: "preliminary", finalGeneration: "final" }); targetStarted = true;
  };
  assert.throws(activate, /catchup_activation_agreement_required/);
  assert.equal(targetStarted, false);
  assert.equal((await createPostgresOrderReviewMediaPort(executor(input.runtime)).readAuthorized(input.grant, input.seed.updated.ref))?.media.observedDigest, changes.updated.sha256);
  const after = await input.capture(input.owner, "source-after-safe-rollback");
  assert.notDeepEqual(rows(after), rows(packet));
  return { packet, media, changes, staged, otherGrant: input.seed.otherGrant, partial: input.seed.partial, report: { exportInterruptedAfterTableReads: reads, exportResumedBy: "new atomic snapshot",
    importInterruptedAfterRetainedWrites: interrupted, atomicImportRolledBack: true, importResumedAndReplayed: true,
    refusal: "preliminary generation lacks final source seal and agreement", rollback: "source remains authoritative and authorizes changed media",
    targetStarted, counts: catchupCounts(packet), objects: media.objects.length, temporary: media.temporary.length,
    elapsedMs: Math.round(performance.now() - at) } };
}

export function assertFinalCatchup(preliminary: Awaited<ReturnType<typeof preliminaryCatchup>>, final: Graph) {
  const before = rows(preliminary.packet), after = rows(final);
  const settings = after.commerce_settings.map(row => JSON.parse(row) as { key: string; value_minor: number });
  assert.equal(settings.find(row => row.key === "catchup_updated")?.value_minor, 11);
  assert.equal(settings.find(row => row.key === "catchup_new")?.value_minor, 3);
  assert(!settings.some(row => row.key === "catchup_deleted"));
  assert(before.commerce_settings.some(row => JSON.parse(row).key === "catchup_deleted"));
  for (const table of ["subscription_renewal_terms", "subscription_renewal_term_lines", "commerce_settlement_intents", "invoicing_duties"]) {
    assert(before[table].length > 0); assert.deepEqual(after[table], before[table]);
  }
  const active = after.subscriptions.map(row => JSON.parse(row));
  assert(active.length > 0 && active.every(row => row.status === "active"));
  assert.deepEqual(after.subscriptions, before.subscriptions, "executor isolation does not pause subscriptions or move cycles");
}

export async function mediaReferences(db: Pool): Promise<OrderReviewMediaSourceReference[]> {
  return (await db.query<OrderReviewMediaSourceReference>(`SELECT media_reference AS "mediaReference",state,object_key AS "objectKey",
    observed_digest AS "observedDigest",observed_byte_length AS "observedByteLength",observed_content_type AS "observedContentType",
    temp_key AS "tempKey",writer_reference AS "writerReference",cleanup_receipt AS "cleanupReceipt",next_attempt_at::text AS "nextAttemptAt"
    FROM public.commerce_order_review_media ORDER BY media_reference`)).rows;
}

/** Actual handler + DB authorization + filesystem reads, without composing any timer or write-capable app. */
export async function catchupServing(input: { source: Pool; target: Pool; sourceRoot: string; targetRoot: string;
  grant: string; otherGrant: string; census: Awaited<ReturnType<typeof captureOrderReviewMediaFilesystem>>; references: OrderReviewMediaSourceReference[] }) {
  const sourceReader = createOrderReviewMediaTransferReader({ root: input.sourceRoot, maximumObjectBytes: 1024 });
  const targetReader = createOrderReviewMediaTransferReader({ root: input.targetRoot, maximumObjectBytes: 1024 });
  const ports = { source: createPostgresOrderReviewMediaPort(executor(input.source)), target: createPostgresOrderReviewMediaPort(executor(input.target)) };
  const probes: MediaServingProbe[] = input.census.objects.flatMap(object => {
    const row = input.references.find(value => value.objectKey === object.key); assert(row);
    const visible = row.state === "stored" || row.state === "confirmed";
    return (["customer", "admin"] as const).flatMap(route => (["anonymous", "customer-owner", "customer-other", "operator"] as const).map(actor => {
      const token = actor === "customer-owner" ? input.grant : actor === "customer-other" ? input.otherGrant : actor === "operator" ? "fixture-operator" : null;
      const path = `/api/bff/${route === "admin" ? "admin/" : ""}order-review/media/${row.mediaReference}`;
      const init: RequestInit = { headers: token ? { authorization: `Bearer ${token}` } : {} };
      return { key: object.key, route, actor, expectedAllowed: (row.state === "confirmed" && route === "customer" && actor === "customer-owner" || visible && route === "admin" && actor === "operator"),
        source: new Request(`http://source.test${path}`, init), target: new Request(`http://target.test${path}`, init) };
    }));
  });
  const fetchRoute = (async (request: Request) => {
    const source = new URL(request.url).hostname === "source.test", port = source ? ports.source : ports.target, reader = source ? sourceReader : targetReader;
    const ref = new URL(request.url).pathname.split("/").at(-1)!;
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    const binding = {
      async authorizeCustomerMedia(grant: string, mediaRef: string) {
        const object = await port.readAuthorized(grant, mediaRef);
        return object ? { media: object.media, open: async () => (await reader.read(object.objectKey)).body } : null;
      },
      async authorizeAdminMedia(actorRef: string, mediaRef: string) {
        const object = await port.readAdmin({ actorRef, mediaRef });
        return object ? { media: object.media, open: async () => (await reader.read(object.objectKey)).body } : null;
      },
    } as OrderReviewRuntimeBinding;
    const env = { PLATFORM_BUNDLE: "node-postgres" };
    const handler = new URL(request.url).pathname.includes("/admin/") ? createAdminOrderReviewMediaBffHandler({ env,
      authorize: async (_req, res) => { if (token === "fixture-operator") return "m14-fixture-admin"; res.status(403).json({ error: "denied" }); return null; },
      resolveBinding: async () => binding }) : createOrderReviewMediaBffHandler(async () => binding, env);
    let status = 200; const headers = new Headers(), chunks: Buffer[] = [];
    const res = Object.assign(new EventEmitter(), { setHeader(name: string, value: string) { headers.set(name, value); return res; },
      status(value: number) { status = value; return res; }, json(value: unknown) { chunks.push(Buffer.from(JSON.stringify(value))); return res; },
      write(value: Uint8Array) { chunks.push(Buffer.from(value)); return true; }, end() { return res; }, destroy(error: Error) { throw error; } });
    await handler({ method: "GET", headers: { authorization: request.headers.get("authorization") ?? undefined }, query: { mediaRef: ref } } as never, res as never);
    return new Response(Uint8Array.from(Buffer.concat(chunks)), { status, headers });
  }) as typeof fetch;
  const filesystem = reconcileOrderReviewMediaFilesystem({ census: input.census, references: input.references });
  const serving = await reconcileOrderReviewMediaServing({ objects: input.census.objects, references: input.references, probes, fetchRoute });
  assert(serving.observed > 0 && serving.allowed > 0 && serving.denied > 0);
  return { filesystem, serving, authorization: "actual native ports and BFF handlers; explicit synthetic operator authentication" };
}

export function catchupDrain() {
  const env = { OPENLUP_ACQUISITION_DRAIN_STARTED_AT: new Date(Date.now() - 1000).toISOString(), OPENLUP_ACQUISITION_DRAIN_MAX_SECONDS: "3600" };
  assert.equal(acquisitionLegacyDrain(env).state, "draining");
  let status = 0; const headers: Record<string, string> = {};
  const response = { setHeader(name: string, value: string) { headers[name] = value; return response; },
    status(value: number) { status = value; return response; }, json() { return response; } };
  assert(refuseAcquisitionCommandDuringLegacyDrain(response as never, env));
  assert.equal(status, 503); assert(Number(headers["Retry-After"]) > 0);
  assert.equal(acquisitionLegacyDrain({ ...env, OPENLUP_ACQUISITION_DRAIN_MAX_SECONDS: "" }).state, "invalid");
  return { env, observedStatus: status, maximumSeconds: 3600 };
}
