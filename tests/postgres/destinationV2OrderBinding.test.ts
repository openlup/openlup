import { randomUUID } from "node:crypto";
import { createDestinationDocumentPrivacyContributor } from "@openlup/platform/identity";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
// eslint-disable-next-line no-restricted-imports -- run the private guard sequence on the claim writer
import { destinationV2Prelock } from "../../packages/platform/src/commerce/server/destinations/destinationV2Prelock.js";
// eslint-disable-next-line no-restricted-imports -- compare the SQL domain with the quote owner's exact validator
import { ref } from "../../packages/platform/src/pricing/quoteMoneyValidationV2.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { bindDestinationOrder, deferred, destinationContext, destinationFence, destinationHash, documentTable, insertDestinationOrder,
  orderBindingTable, readSnapshot, reachDestinationCutoff, recheckDestination, registerDestination,
  selectionTable, snapshot, testServicePin } from "./destinationDocumentFixture.js";
import { awaitReceiptWait, backendPid } from "./destinationReceiptFixture.js";

const resources = storeJourneyResources();
let store: JourneyInstallation;
beforeAll(async () => { store = await resources.installation("destination-order-binding"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);
const refused = (code: string, field: string) => expect.objectContaining({
  outcome: "refused", code, field, observed: expect.any(String), cause: expect.any(String), fix: expect.any(String), recheck: expect.any(String),
});
const unavailable = (field: string) => refused("destination_evidence_unavailable", field);
const stale = (field: string) => refused("destination_version_changed", field);

it.each([
  ["prohibited key", { constructor: "out-of-domain" }, "23514"],
  ["excess depth", { city: JSON.parse("[".repeat(49) + "null" + "]".repeat(49)) }, "22023"],
] as const)("withholds hash-matching stored evidence with %s on the typed paths", async (_kind, address, sqlstate) => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx);
  const order = await bindDestinationOrder(owner, ctx, issued);
  const { document } = await readSnapshot(runtime, ctx, issued.binding);
  const bytes = JSON.stringify(["commerce.destination.document.v2", { ...document, address }]);
  await owner.query(`UPDATE ${documentTable} SET document_text=$2,document_digest=$3 WHERE snapshot_ref=$1`,
    [issued.binding.snapshotRef, bytes, destinationHash(bytes)]);
  const invalid = expect.objectContaining({
    outcome: "refused", code: "destination_binding_invalid", field: "destination",
    fix: "Send the retained evidence to the destination owner for review.",
  });
  const read = () => readSnapshot(runtime, ctx, issued.binding, order, "order");
  const fresh = () => destinationFence(owner, ctx, issued, async writer => {
    await writer.query("SAVEPOINT corrupt_address");
    const id = await insertDestinationOrder(writer, ctx);
    try { return await registerDestination(writer, ctx, id, issued); }
    finally { await writer.query("ROLLBACK TO SAVEPOINT corrupt_address"); }
  });
  const exportDocuments = () => createDestinationDocumentPrivacyContributor().export(runtime, {
    contactId: ctx.clientId, principalId: ctx.owner.principalRef, identity: {},
  });
  await expect.soft(recheckDestination(runtime, ctx, issued)).resolves.toEqual(invalid);
  await expect.soft(fresh()).resolves.toEqual(invalid);
  await expect.soft(registerDestination(runtime, ctx, order, issued)).resolves.toEqual(invalid);
  await expect.soft(read()).resolves.toEqual(invalid);
  await expect(readSnapshot(runtime, ctx, issued.binding))
    .rejects.toMatchObject({ code: sqlstate, message: "catalog_publication_wire_invalid" });
  await expect(exportDocuments()).resolves.toEqual(expect.objectContaining({
    coverage: expect.objectContaining({ complete: false }),
    data: [{ snapshotRef: issued.binding.snapshotRef, evidenceDisposition: "available", issuedAt: expect.any(String),
      verification: { status: "failed", code: "destination_binding_invalid", field: "destination" } }],
  }));
});

it("checks exact stored evidence before stale selection advice on the guarded claim writer", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx), other = await destinationContext(owner);
  const carrier = await recheckDestination(runtime, ctx, issued);
  expect(carrier).toEqual({ binding: issued.binding, selection: issued.selection, service: testServicePin });
  expect((await runtime.query("SELECT public.commerce_recheck_destination_v2($1,'unsupported',$2,$3,$4,$5) AS value",
    [ctx, ctx.scopeRef, issued.selection.selectionRevision, issued.binding, testServicePin])).rows[0].value)
    .toEqual(refused("destination_dialect_invalid", "version"));
  expect(await recheckDestination(runtime, other, issued)).toEqual(unavailable("destination.snapshotRef"));
  expect(await recheckDestination(runtime, { ...ctx, owner: { ...ctx.owner, customerOrSessionRef: other.clientId } }, issued))
    .toEqual(refused("destination_owner_unlinked", "owner"));
  expect(await recheckDestination(runtime, ctx, { ...issued, binding: { ...issued.binding, policyRevision: "wrong" } }))
    .toEqual(stale("destination.policyRevision"));

  const selected = await snapshot(runtime, ctx);
  expect(selected.binding.destinationDigest).toBe(issued.binding.destinationDigest);
  const db = await owner.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await destinationV2Prelock(ctx, issued.binding.snapshotRef)(db);
    const decision = await recheckDestination(db, ctx, issued);
    await db.query("ROLLBACK");
    expect(decision).toEqual(stale("selectionRevision"));
    expect(Reflect.ownKeys(decision).sort()).toEqual(["cause", "code", "field", "fix", "observed", "outcome", "recheck"]);
    expect(Object.getPrototypeOf(decision)).toBe(Object.prototype);
  } finally { await db.query("ROLLBACK"); db.release(); }

  const sameRevision = { ...issued, selection: selected.selection };
  expect(await recheckDestination(runtime, ctx, sameRevision)).toEqual(stale("destination.snapshotRef"));
  expect(await recheckDestination(runtime, ctx, { ...issued, binding: { ...issued.binding, destinationDigest: "0".repeat(64) } }))
    .toEqual(refused("destination_digest_mismatch", "destinationDigest"));
  const { rows: [original] } = await owner.query(`SELECT document_text FROM ${documentTable} WHERE snapshot_ref=$1`, [issued.binding.snapshotRef]);
  await owner.query(`UPDATE ${documentTable} SET document_text=document_text||' ' WHERE snapshot_ref=$1`, [issued.binding.snapshotRef]);
  expect(await recheckDestination(runtime, ctx, issued)).toEqual(expect.objectContaining({
    code: "destination_digest_mismatch", field: "documentDigest",
    recheck: "Use authorized review to recover the pair, or start a fresh selection where issuance is available.",
  }));
  await owner.query(`UPDATE ${documentTable} SET document_text=$2 WHERE snapshot_ref=$1`, [issued.binding.snapshotRef, original.document_text]);
  await reachDestinationCutoff(owner, issued.binding);
  await owner.query("SELECT public.commerce_destination_v2_expire(clock_timestamp(),1000)");
  await owner.query(`DELETE FROM ${selectionTable} WHERE scope_ref=$1`, [ctx.scopeRef]);
  expect(await recheckDestination(runtime, ctx, issued)).toEqual(stale("destination.snapshotRef"));
  expect(await recheckDestination(runtime, ctx, selected)).toEqual(refused("destination_v2_selection_required", "destination.snapshotRef"));
});

it("preserves exact sealed replay and parent-authorized reads through cutoff, reselection and erasure", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx), foreign = await destinationContext(owner);
  const missing = await insertDestinationOrder(owner, ctx);
  expect(await registerDestination(runtime, ctx, missing, issued)).toEqual(unavailable("orderId"));
  const service = { ...testServicePin, adapterRevision: " \t𐌀é  " };
  const order = await destinationFence(owner, ctx, issued, async writer => {
    const id = await insertDestinationOrder(writer, ctx);
    expect(await registerDestination(writer, ctx, id, issued, service)).toEqual(issued.binding);
    return id;
  });
  expect((await owner.query(`SELECT service,encode(convert_to(service->>'adapterRevision','UTF8'),'hex') AS bytes
    FROM ${orderBindingTable} WHERE order_id=$1`, [order])).rows)
    .toEqual([{ service, bytes: Buffer.from(service.adapterRevision, "utf8").toString("hex") }]);
  const shipment = randomUUID();
  await owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('destination-bind-parcel','3pl',true)");
  await owner.query(`INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key)
    VALUES($1,$2,'destination-bind-parcel','3pl',$3)`, [shipment, order, randomUUID()]);
  const original = await readSnapshot(runtime, ctx, issued.binding);
  expect(await readSnapshot(runtime, ctx, issued.binding, order, "order")).toEqual(original);
  expect(await readSnapshot(runtime, ctx, issued.binding, shipment, "shipment")).toEqual(original);
  await reachDestinationCutoff(owner, issued.binding);
  const moved = await snapshot(runtime, ctx);
  expect(await registerDestination(runtime, ctx, order, issued, service)).toEqual(issued.binding);
  expect(await registerDestination(runtime, ctx, order, { ...issued,
    selection: { ...issued.selection, selectionRevision: moved.selection.selectionRevision },
  }, service)).toEqual(refused("destination_order_binding_occupied", "orderId"));
  expect(await registerDestination(runtime, ctx, order, issued, { ...service, serviceRef: "another-service" }))
    .toEqual(refused("destination_order_binding_occupied", "orderId"));
  expect(await registerDestination(runtime, ctx, order, moved, service)).toEqual(refused("destination_order_binding_occupied", "orderId"));
  await owner.query(`UPDATE ${orderBindingTable} SET service='{}' WHERE order_id=$1`, [order]);
  expect(await registerDestination(runtime, ctx, order, issued)).toMatchObject({
    code: "destination_binding_invalid", fix: "Send the retained evidence to the destination owner for review.",
  });
  await owner.query(`UPDATE ${orderBindingTable} SET service=$2 WHERE order_id=$1`, [order, service]);
  for (const [kind, id] of [["order", order], ["shipment", shipment]] as const) {
    expect(await readSnapshot(runtime, ctx, moved.binding, id, kind)).toEqual(expect.objectContaining({
      code: "destination_version_changed", field: "destination.snapshotRef", fix: "Use the binding recorded for the original order.",
    }));
    expect(await readSnapshot(runtime, ctx, issued.binding, id, kind)).toMatchObject({ binding: issued.binding, document: original.document });
  }
  const foreignRead = await readSnapshot(runtime, foreign, issued.binding, order, "order");
  const foreignBind = await registerDestination(runtime, foreign, order, issued, service);
  expect(foreignRead).toEqual(unavailable("orderId"));
  expect(foreignBind).toEqual(foreignRead);
  await runtime.query("SELECT public.commerce_destination_v2_erase($1)", [ctx.clientId]);
  expect(await readSnapshot(runtime, ctx, issued.binding, order, "order")).toEqual(foreignRead);
  expect(await registerDestination(runtime, ctx, order, issued, service)).toEqual(foreignBind);
  expect((await owner.query(`SELECT selection,service FROM ${orderBindingTable} WHERE order_id=$1`, [order])).rows)
    .toEqual([{ selection: null, service: null }]);
});

it("matches the quote ref code-point domain and preserves each sealed pin verbatim", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx);
  for (const [coordinate, accepted] of [
    ["", false], [" ", true], ["𐌀", true], ["é".repeat(256), true], ["é".repeat(257), false],
    ["𐌀".repeat(129), true], ["𐌀".repeat(256), true], ["𐌀".repeat(257), false], ["\t á \n", true],
  ] as const) {
    const pin = { ...testServicePin, adapterRevision: coordinate };
    expect(ref.safeParse(coordinate).success).toBe(accepted);
    expect(await recheckDestination(runtime, ctx, issued, pin)).toEqual(accepted
      ? { binding: issued.binding, selection: issued.selection, service: pin }
      : refused("destination_binding_invalid", "selectedDelivery"));
  }
  for (const pin of [null, 10, { ...testServicePin, extra: "extra" }, { ...testServicePin, carrierRef: false }]) {
    expect(await recheckDestination(runtime, ctx, issued, pin)).toEqual(refused("destination_binding_invalid", "selectedDelivery"));
  }
  for (const invalid of ["\u0000", "\uD800", "\uDFFF"]) {
    expect(ref.safeParse(invalid).success).toBe(false);
    await expect(recheckDestination(runtime, ctx, issued, { ...testServicePin, serviceRef: invalid }))
      .rejects.toMatchObject({ code: expect.stringMatching(/^22P0[25]$/u) });
  }
});

it("returns busy only for the existing order lock and reads the committed child in a new RC statement", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx);
  const order = await bindDestinationOrder(owner, ctx, issued);
  const holder = await owner.connect(), replay = await runtime.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE", [order]);
    expect(await registerDestination(replay, ctx, order, issued)).toEqual(refused("destination_busy", "orderId"));
    await holder.query("ROLLBACK");

    const committedPin = { ...testServicePin, serviceRef: "committed-after-order-lock" };
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ${orderBindingTable} IN ACCESS EXCLUSIVE MODE`);
    await holder.query(`UPDATE ${orderBindingTable} SET service=$2 WHERE order_id=$1`, [order, committedPin]);
    const pid = await backendPid(replay);
    pending = registerDestination(replay, ctx, order, issued, committedPin);
    void pending.catch(() => undefined);
    await awaitReceiptWait(owner, pid, "relation", "AccessShareLock");
    // A joined or earlier child read waits for the child table before it locks the order.
    await expect(owner.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE NOWAIT", [order]))
      .rejects.toMatchObject({ code: "55P03" });
    await holder.query("COMMIT");
    expect(await pending).toEqual(issued.binding);
  } finally { await holder.query("ROLLBACK"); await pending?.catch(() => undefined); holder.release(); replay.release(); }
});

it("rolls back the freshly inserted order before exposing the post-lock cutoff refusal", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx);
  const id = randomUUID();
  const result = await destinationFence(owner, ctx, issued, async writer => {
    expect(await recheckDestination(writer, ctx, issued)).toMatchObject({ binding: issued.binding });
    await insertDestinationOrder(writer, ctx, id);
    await reachDestinationCutoff(writer, issued.binding);
    throw { decision: await registerDestination(writer, ctx, id, issued) };
  }).catch(error => error.decision);
  expect(result).toEqual(stale("destination.snapshotRef"));
  expect((await owner.query(`SELECT 1 FROM public.commerce_orders WHERE id=$1 UNION ALL
    SELECT 1 FROM ${orderBindingTable} WHERE order_id=$1`, [id])).rows).toEqual([]);
  expect(await recheckDestination(runtime, ctx, issued)).toMatchObject({ binding: issued.binding });
});

it("uses current database time when a fresh bind statement crosses cutoff", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx);
  const result = await destinationFence(owner, ctx, issued, async writer => {
    const id = await insertDestinationOrder(writer, ctx);
    const { rows: [timing] } = await writer.query(`UPDATE ${documentTable}
      SET evidence_expires_at=clock_timestamp()+interval '1 second'
      WHERE snapshot_ref=$1 RETURNING evidence_expires_at`, [issued.binding.snapshotRef]);
    const decision = await writer.query(`WITH gate AS MATERIALIZED (
        SELECT statement_timestamp() < $8::timestamptz AS began_before,
          pg_sleep_until($8::timestamptz + interval '10 milliseconds')
      ) SELECT public.commerce_register_order_destination_v2($1,$2,$3,$4,$5,$6,$7) AS value
      FROM gate WHERE began_before`,
    [ctx, id, "checkout", ctx.scopeRef, issued.selection.selectionRevision, issued.binding, testServicePin, timing.evidence_expires_at]);
    throw { decision: decision.rows.map(row => row.value) };
  }).catch(error => error.decision);
  expect(result).toEqual([stale("destination.snapshotRef")]);
});

it("attempts the fresh-path order lock before checking the cutoff", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx);
  // A committed order lets a second writer hold the row lock while we exercise the RR entry.
  const order = await insertDestinationOrder(owner, ctx);
  await reachDestinationCutoff(owner, issued.binding);
  const holder = await owner.connect(), writer = await owner.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE", [order]);
    await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(await registerDestination(writer, ctx, order, issued)).toEqual(refused("destination_busy", "orderId"));
    await holder.query("ROLLBACK");
    expect(await registerDestination(writer, ctx, order, issued)).toEqual(stale("destination.snapshotRef"));
  } finally {
    await writer.query("ROLLBACK"); await holder.query("ROLLBACK"); writer.release(); holder.release();
  }
});

it("samples the cutoff after waiting for the fresh-path order lock statement and rolls back", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx);
  const order = await insertDestinationOrder(owner, ctx);
  const holder = await owner.connect();
  const ready = deferred<{ pid: number; cutoff: string }>();
  let bind: Promise<never> | undefined;
  try {
    await holder.query("BEGIN");
    // NOWAIT applies to the row. The relation lock lets the same statement wait while the row is held.
    await holder.query("LOCK TABLE public.commerce_orders IN EXCLUSIVE MODE");
    await holder.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE", [order]);
    bind = destinationFence(owner, ctx, issued, async writer => {
      const pid = await backendPid(writer);
      const { rows: [timing] } = await writer.query<{ cutoff: string }>(`UPDATE ${documentTable}
        SET evidence_expires_at=clock_timestamp()+interval '3 seconds'
        WHERE snapshot_ref=$1 RETURNING evidence_expires_at::text AS cutoff`, [issued.binding.snapshotRef]);
      ready.resolve({ pid, cutoff: timing!.cutoff });
      throw { decision: await registerDestination(writer, ctx, order, issued) };
    });
    void bind.catch(ready.reject);
    const { pid, cutoff } = await ready.promise;
    await awaitReceiptWait(owner, pid, "relation", "RowShareLock");
    expect((await holder.query(`SELECT pg_backend_pid() = ANY(pg_blocking_pids($1))
      AND clock_timestamp() < $2::timestamptz AS blocked_before_cutoff`, [pid, cutoff])).rows)
      .toEqual([{ blocked_before_cutoff: true }]);
    await holder.query("SELECT pg_sleep_until($1::timestamptz + interval '10 milliseconds')", [cutoff]);
    await holder.query("COMMIT");
    await expect(bind).rejects.toEqual({ decision: stale("destination.snapshotRef") });
    expect((await owner.query(`SELECT 1 FROM ${orderBindingTable} WHERE order_id=$1`, [order])).rows).toEqual([]);
    expect(await readSnapshot(runtime, ctx, issued.binding)).toMatchObject({
      binding: issued.binding, evidenceExpiresAt: issued.evidenceExpiresAt,
    });
  } finally {
    await holder.query("ROLLBACK");
    await bind?.catch(() => undefined);
    holder.release();
  }
}, 12000);

it.each([selectionTable, documentTable])("preserves fence contention for the guarded row in %s", async table => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx);
  const holder = await owner.connect(), waiter = await runtime.connect(), read = vi.fn();
  try {
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM ${table} WHERE snapshot_ref=$1 FOR UPDATE`, [issued.binding.snapshotRef]);
    await waiter.query("BEGIN");
    await waiter.query("SET LOCAL lock_timeout = '1s'");
    const acquire = table === selectionTable
      ? waiter.query("SELECT public.commerce_lock_destination_v2_selection($1,$2)", [ctx, ctx.scopeRef])
      : waiter.query("SELECT public.commerce_lock_destination_v2_document($1,$2,$3)", [ctx, ctx.scopeRef, issued.binding.snapshotRef]);
    await expect(acquire).rejects.toMatchObject({
      code: "55P03", message: `could not obtain lock on row in relation "${table.split(".")[1]}"`,
    });
    await waiter.query("ROLLBACK");
    await expect(destinationFence(owner, ctx, issued, read)).rejects.toMatchObject({
      message: "catalog_admission_fence_unavailable", hint: "Retry the same request with the same idempotency key.",
    });
    expect(read).not.toHaveBeenCalled();
  } finally { await waiter.query("ROLLBACK"); await holder.query("ROLLBACK"); waiter.release(); holder.release(); }
});

it.each(["reselections", "erasures"] as const)("orders %s before and after the bound writer", async mutation => {
  const { owner, runtime } = store;
  for (const writerFirst of [true, false]) {
    const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx);
    const other = await runtime.connect(), readReady = deferred<string>(), finish = deferred<void>();
    const writerReady = deferred<number>();
    let first = true, bind: Promise<string> | undefined, changing: Promise<unknown> | undefined;
    const pair = { connect: async () => {
      const isWriter = first; first = false;
      const db = await owner.connect();
      if (isWriter) writerReady.resolve(await backendPid(db));
      return db;
    } };
    const read = vi.fn(async (writer: PoolClient) => {
      expect(await recheckDestination(writer, ctx, issued)).toMatchObject({ binding: issued.binding });
      const id = await insertDestinationOrder(writer, ctx);
      expect(await registerDestination(writer, ctx, id, issued)).toEqual(issued.binding);
      readReady.resolve(id);
      await finish.promise;
      return id;
    });
    const mutate = () => mutation === "reselections" ? snapshot(other, ctx) :
      other.query("SELECT public.commerce_destination_v2_erase($1) AS count", [ctx.clientId]).then(result => result.rows[0].count);
    const relation = mutation === "erasures";
    try {
      await other.query("BEGIN");
      const otherPid = await backendPid(other);
      if (!writerFirst) await mutate();
      bind = destinationFence(pair, ctx, issued, read);
      void bind.catch(error => { writerReady.reject(error); readReady.reject(error); });
      void readReady.promise.catch(() => undefined);
      if (writerFirst) {
        const order = await readReady.promise;
        changing = mutate();
        void changing.catch(() => undefined);
        await awaitReceiptWait(owner, otherPid, relation ? "relation" : "transactionid", relation ? "ShareRowExclusiveLock" : "ShareLock");
        finish.resolve();
        expect(await bind).toBe(order);
        if (relation) expect(await changing).toBe(1);
        else await changing;
        await other.query("COMMIT");
        if (relation) {
          expect((await owner.query(`SELECT order_id,snapshot_ref,selection IS NULL AND service IS NULL AS pins_scrubbed
            FROM ${orderBindingTable} WHERE order_id=$1`, [order])).rows)
            .toEqual([{ order_id: order, snapshot_ref: issued.binding.snapshotRef, pins_scrubbed: true }]);
        }
        expect(await registerDestination(runtime, ctx, order, issued)).toEqual(relation ? unavailable("orderId") : issued.binding);
      } else {
        await awaitReceiptWait(owner, await writerReady.promise, relation ? "relation" : "transactionid", "ShareLock");
        await other.query("COMMIT");
        await expect(bind).rejects.toMatchObject({ code: "40001", message: "catalog_admission_visibility_changed" });
        expect(read).not.toHaveBeenCalled();
      }
    } finally {
      finish.resolve();
      await other.query("ROLLBACK");
      other.release();
      await changing?.catch(() => undefined);
      await bind?.catch(() => undefined);
    }
  }
}, 20000);

it("erases binding pins reached through either parent and counts only the subject's documents", async () => {
  const { owner, runtime } = store;
  const erased = await destinationContext(owner), foreign = await destinationContext(owner);
  const [erasedDoc, foreignDoc] = await Promise.all([snapshot(runtime, erased), snapshot(runtime, foreign)]);
  const [erasedOrder, foreignOrder] = await Promise.all([insertDestinationOrder(owner, erased), insertDestinationOrder(owner, foreign)]);
  await owner.query(`INSERT INTO ${orderBindingTable}(order_id,snapshot_ref,selection,service)
    VALUES($1,$2,$3,$7),($4,$5,$6,$7)`, [erasedOrder, foreignDoc.binding.snapshotRef, foreignDoc.selection,
    foreignOrder, erasedDoc.binding.snapshotRef, erasedDoc.selection, testServicePin]);
  const markers = async () => (await owner.query(`SELECT order_id,snapshot_ref,selection,service
    FROM ${orderBindingTable} WHERE order_id IN ($1,$2)`, [erasedOrder, foreignOrder])).rows;
  expect(await markers()).toEqual(expect.arrayContaining([
    { order_id: erasedOrder, snapshot_ref: foreignDoc.binding.snapshotRef, selection: foreignDoc.selection, service: testServicePin },
    { order_id: foreignOrder, snapshot_ref: erasedDoc.binding.snapshotRef, selection: erasedDoc.selection, service: testServicePin },
  ]));
  expect((await runtime.query("SELECT public.commerce_destination_v2_erase($1) AS count", [erased.clientId])).rows).toEqual([{ count: 1 }]);
  expect(await markers()).toEqual(expect.arrayContaining([
    { order_id: erasedOrder, snapshot_ref: foreignDoc.binding.snapshotRef, selection: null, service: null },
    { order_id: foreignOrder, snapshot_ref: erasedDoc.binding.snapshotRef, selection: null, service: null },
  ]));
  expect(await readSnapshot(runtime, foreign, foreignDoc.binding)).toMatchObject({ binding: foreignDoc.binding });
});

it("installs private destination bindings with four runtime identities and restrictive parents", async () => {
  const db = await store.owner.connect();
  try {
    await db.query("BEGIN");
    const { rows: [relation] } = await db.query("SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass", [orderBindingTable]);
    expect(relation).toEqual({ relrowsecurity: true });
    const { rows: present } = await db.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') ORDER BY rolname",
    );
    const roles = present.map(({ rolname }) => rolname);
    expect(roles).toEqual(expect.arrayContaining(["anon", "authenticated"]));
    const { rows: effective } = await db.query(`SELECT rolname,
      has_table_privilege(oid,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS "table",
      has_any_column_privilege(oid,$1,'SELECT,INSERT,UPDATE,REFERENCES') AS "column"
      FROM pg_roles WHERE rolname = ANY($2) ORDER BY rolname`, [orderBindingTable, roles]);
    expect(effective).toEqual(roles.map(rolname => ({ rolname, table: false, column: false })));
    const identities = [
      "public.commerce_lock_destination_v2_selection(jsonb,uuid)",
      "public.commerce_lock_destination_v2_document(jsonb,uuid,uuid)",
      "public.commerce_recheck_destination_v2(jsonb,text,uuid,uuid,jsonb,jsonb)",
      "public.commerce_register_order_destination_v2(jsonb,uuid,text,uuid,uuid,jsonb,jsonb)",
    ];
    for (const signature of identities) {
      const attributes = await db.query("SELECT provolatile,prosecdef FROM pg_proc WHERE oid=$1::regprocedure", [signature]);
      expect(attributes.rows, signature).toEqual([{ provolatile: "v", prosecdef: true }]);
      const { rows } = await db.query(`SELECT rolname, has_function_privilege(oid,$1::regprocedure,'EXECUTE') AS execute
        FROM pg_roles WHERE rolname = ANY($2) ORDER BY rolname`, [signature, roles]);
      expect(rows).toEqual(roles.map(rolname => ({ rolname, execute: rolname === "service_role" })));
    }
    const ctx = await destinationContext(db);
    const orderId = await insertDestinationOrder(db, ctx);
    const { rows: [document] } = await db.query(`INSERT INTO ${documentTable}
      (snapshot_ref,client_id,purpose,issued_at,evidence_expires_at,evidence_disposition)
      VALUES(gen_random_uuid(),$1,'checkout',clock_timestamp(),clock_timestamp(),'erased') RETURNING snapshot_ref`, [ctx.clientId]);
    await db.query(`INSERT INTO ${orderBindingTable}(order_id,snapshot_ref) VALUES($1,$2)`, [orderId, document.snapshot_ref]);
    for (const [sql, key, code] of [
      [`UPDATE ${orderBindingTable} SET selection='{}' WHERE order_id=$1`, orderId, "23514"],
      [`UPDATE ${orderBindingTable} SET service='{}' WHERE order_id=$1`, orderId, "23514"],
      ["DELETE FROM public.commerce_orders WHERE id=$1", orderId, "23503"],
      [`DELETE FROM ${documentTable} WHERE snapshot_ref=$1`, document.snapshot_ref, "23503"],
    ]) {
      await db.query("SAVEPOINT destination_constraint");
      await expect(db.query(sql, [key])).rejects.toMatchObject({ code });
      await db.query("ROLLBACK TO SAVEPOINT destination_constraint");
    }
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});
