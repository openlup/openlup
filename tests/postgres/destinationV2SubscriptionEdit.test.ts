import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { createPostgresFulfillmentShipmentSpinePort } from "@openlup/platform/fulfillment";
import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPersonalDataContributorRegistry, createPostgresPrivacyStore, createPrivacyOperations } from "@openlup/platform/identity";
import { nativePrivacyContributors } from "../../server/runtime/auth/privacyBinding.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { composeJourneyRenewal, journeyCensus, prepareJourneyRenewal, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { bindDestinationOrder, deferred, destinationContext, destinationHash, documentTable, insertDestinationOrder, orderBindingTable, snapshot, testServicePin } from "./destinationDocumentFixture.js";
import { backendPid, receiptTable } from "./destinationReceiptFixture.js";

// Isolated cluster: destinationDocumentFixture.snapshot uses withCatalogAdmissionFence (cluster-wide pg_current_snapshot).
const resources = storeJourneyResources({ isolatedCluster: true });
let store: JourneyInstallation;
beforeAll(async () => { store = await resources.installation("destination-subscription"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

const selections = "public.subscription_destination_v2_selections";
const dialect = "subscription.destination.change.v2";
const call = "SELECT public.subscription_change_shipping_destination_v2($1,$2,clock_timestamp()) AS result";
const refusalKeys = ["cause", "code", "field", "fix", "observed", "outcome", "recheck"];
const original = {
  address: { city: "Zélvórë", countryCode: "XA", line1: "A 😀", line2: "2", postalCode: "00-001", subdivisionCode: "XA-01" },
  contact: { contactPhone: "+0000000", recipientName: "Fixture" },
};
const validated = { ...original, classificationKeys: ["first", "second"], policyRef: "fixture.policy", policyRevision: "r1" };
type Context = {
  clientId: string;
  scopeRef: string;
  owner: {
    installationRef: string;
    principalKind: string;
    principalRef: string;
    customerOrSessionRef: string;
  };
};
type Db = Pool | PoolClient;
const query = async (db: Db, sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0]?.result;
async function insertSubscription(db: Db, id: string, clientId: string) {
  await db.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,status,template_version)
    VALUES ($1,$2,28,clock_timestamp()+interval '28 days','active',7)`, [id, clientId]);
}
async function subject(db = store.owner) {
  const ctx = await destinationContext(db);
  await insertSubscription(db, ctx.scopeRef, ctx.clientId);
  return ctx;
}
function command(ctx: Context, extras: Record<string, unknown> = {}) {
  const { validated: projection, service, ...intent } = { dialect, subscriptionId: ctx.scopeRef,
    expectedTemplateVersion: 7, expectedSelectionRevision: null, requestKey: randomUUID(), original,
    validated, service: testServicePin, ...extras };
  const preimage = ["commerce.destination.request.v2", { ...intent, owner: ctx.owner }];
  return { ...intent, validated: projection, service, requestDigest: destinationHash(canonicalCatalogDraftJson(preimage)) };
}
const edit = (db: Db, ctx: Context, input: object = command(ctx)) => query(db, call, [ctx, input]);
const expire = (db: Db) => query(db, "SELECT public.commerce_destination_v2_expire(clock_timestamp(),1) AS result");
const current = (db: Db, ctx: Context) =>
  query(db, "SELECT public.subscription_destination_v2_current($1,$2) AS result", [ctx, ctx.scopeRef]);
const waitFor = async (db: Db, waiting: number, blocking: number) => {
  await expect.poll(() => query(db, "SELECT $2::int=ANY(pg_blocking_pids($1)) AS result", [waiting, blocking]), { timeout: 5000 }).toBe(true);
};
function refused(result: object, code: string, field: string) {
  expect(Reflect.ownKeys(result).sort()).toEqual(refusalKeys);
  expect(result).toMatchObject({ outcome: "refused", code, field });
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
}
async function effects(db: Db, ctx: Context) {
  return query(db, `SELECT jsonb_build_object(
    'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY snapshot_ref),'[]') FROM ${documentTable} d WHERE client_id=$2),
    'selections',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') FROM ${selections} s WHERE subscription_id=$1),
    'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY event_id),'[]') FROM ${receiptTable} r WHERE client_id=$2)) AS result`,
  [ctx.scopeRef, ctx.clientId]);
}

it("issues the golden vector, replays before fresh validation, and mints both IDs at equal address digest", async () => {
  const u = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const { owner } = store, ctx = { clientId: u(2), scopeRef: u(4),
    owner: { installationRef: "fixture", principalKind: "customer", principalRef: u(1), customerOrSessionRef: u(2) } };
  await owner.query("INSERT INTO public.clients(id,principal_id,email) VALUES($1,$2,'destination-golden@example.invalid')", [ctx.clientId, u(1)]);
  await insertSubscription(owner, ctx.scopeRef, ctx.clientId);
  const input = command(ctx, { requestKey: u(3) });
  expect(input.requestDigest).toBe("a7b40103f97ba0baead01263b954de5fe0edefe6fcdd2ac40cffa29c87c061b5");
  const first = await edit(owner, ctx, input);
  expect(first).toEqual({ outcome: "applied_from_next_parcel", subscriptionId: ctx.scopeRef,
    binding: { snapshotRef: expect.any(String), destinationDigest: expect.any(String), schemaVersion: 2, policyRevision: "r1" },
    selectionRevision: expect.any(String), eventId: expect.any(String), replayed: false });
  const second = await edit(owner, ctx, command(ctx, { expectedSelectionRevision: first.selectionRevision }));
  expect(second.outcome).toBe("applied_from_next_parcel");
  expect(second.binding.destinationDigest).toBe(first.binding.destinationDigest);
  expect(second.binding.snapshotRef).not.toBe(first.binding.snapshotRef);
  expect(second.selectionRevision).not.toBe(first.selectionRevision);
  expect(second.eventId).not.toBe(first.eventId);
  const recorded = await effects(owner, ctx);
  expect(recorded.documents).toHaveLength(2);
  for (const row of recorded.documents) {
    expect(row.purpose).toBeNull();
    expect(row.evidence_expires_at).toBe(row.issued_at);
    expect(destinationHash(row.document_text)).toBe(row.document_digest);
  }
  expect(recorded.receipts).toContainEqual(expect.objectContaining({ event_id: first.eventId, outcome: {
    binding: first.binding, selection: { kind: "subscription", scopeRef: ctx.scopeRef, selectionRevision: first.selectionRevision }, evidenceExpiresAt: null,
  } }));
  expect(await edit(owner, ctx, { ...input, validated: undefined, service: { obsolete: true } })).toEqual({ ...first, replayed: true });
  expect(await effects(owner, ctx)).toEqual(recorded);
  refused(await edit(owner, ctx), "destination_version_changed", "expectedSelectionRevision");
});

it("enforces closed SQL shapes with no effects and denies the qualified login", async () => {
  const { owner, runtime } = store, ctx = await subject(), input = command(ctx);
  const extra = <T extends object>(value: T) => ({ ...value, forbidden: "synthetic-invalid" });
  const before = await effects(owner, ctx);
  for (const [context, payload, code, field] of [
    [extra(ctx), input, "destination_owner_unlinked", "owner"],
    [{ ...ctx, owner: extra(ctx.owner) }, input, "destination_owner_unlinked", "owner"],
    [ctx, extra(input), "address_invalid_input", "command"],
    [ctx, command(ctx, { original: extra(original) }), "address_invalid_input", "original"],
    [ctx, command(ctx, { original: { ...original, address: extra(original.address) } }), "address_invalid_input", "original.address"],
    [ctx, command(ctx, { original: { ...original, contact: extra(original.contact) } }), "address_invalid_input", "original.contact"],
    [ctx, { ...input, validated: extra(validated) }, "address_invalid_input", "validated"],
    [ctx, { ...input, validated: { ...validated, address: extra(validated.address) } }, "address_invalid_input", "validated.address"],
    [ctx, { ...input, validated: { ...validated, contact: extra(validated.contact) } }, "address_invalid_input", "validated.contact"],
    [ctx, { ...input, validated: { ...validated, classificationKeys: [{}] } }, "address_invalid_input", "classificationKeys"],
    [ctx, { ...input, service: extra(testServicePin) }, "address_invalid_input", "service"],
    [ctx, { ...input, service: { ...testServicePin, carrierRef: "🪶".repeat(257) } }, "address_invalid_input", "service"],
    [ctx, command(ctx, { expectedTemplateVersion: 2147483648 }), "address_invalid_input", "expectedTemplateVersion"],
    [ctx, { ...input, expectedSelectionRevision: undefined }, "address_invalid_input", "expectedSelectionRevision"],
  ] as const) refused(await edit(owner, context, payload), code, field);
  expect(await effects(owner, ctx)).toEqual(before);
  const runtimeError = await edit(runtime, ctx, input).catch((error: Error & { code: string }) => error);
  expect(runtimeError).toMatchObject({ code: "42501" });
  expect(Object.getPrototypeOf(runtimeError)).toBe(DatabaseError.prototype);
  expect(Reflect.ownKeys(runtimeError).filter(key => key !== "stack" && key !== "message").sort())
    .toEqual(["code","column","constraint","dataType","detail","file","hint","internalPosition","internalQuery","length",
      "line","name","position","routine","schema","severity","table","where"]);
  expect(await query(runtime, `SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE') OR
    has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') AS result`, [selections])).toBe(false);
  const { scopeRef: _scope, ...receiptContext } = ctx;
  await expect(runtime.query("SELECT public.commerce_destination_v2_receipt_read($1,$2,$3,$4)",
    [receiptContext, dialect, input.requestKey, input.requestDigest])).rejects.toMatchObject({
    code: "22023", message: "destination_dialect_invalid", detail: "version", hint: "Use the supported entry.",
  });
  const receipt = {
    binding: { snapshotRef: randomUUID(), schemaVersion: 2, destinationDigest: "a".repeat(64), policyRevision: "r1" },
    selection: { scopeRef: ctx.scopeRef, kind: "subscription", selectionRevision: randomUUID() }, evidenceExpiresAt: null,
  };
  for (const outcome of [extra(receipt), { ...receipt, binding: extra(receipt.binding) },
    { ...receipt, selection: extra(receipt.selection) }, { ...receipt, evidenceExpiresAt: undefined }]) {
    refused(await query(owner, "SELECT public.commerce_destination_v2_receipt_commit_decision($1,$2,$3,$4,$5) AS result",
      [receiptContext, dialect, input.requestKey, input.requestDigest, outcome]), "destination_binding_invalid", "destination");
  }
  expect(await effects(owner, ctx)).toEqual(before);
  expect((await edit(owner, ctx, { ...input, service: { ...testServicePin, carrierRef: "🪶".repeat(256) } })).outcome)
    .toBe("applied_from_next_parcel");
});

it("rolls back a late receipt collision with both selection and document untouched", async () => {
  const { owner } = store, ctx = await subject(), first = await edit(owner, ctx);
  const input = command(ctx, { expectedSelectionRevision: first.selectionRevision }), before = await effects(owner, ctx);
  await owner.query(`CREATE FUNCTION public.test_subscription_receipt_collision() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RETURN NULL; END; $$;
    CREATE TRIGGER test_subscription_receipt_collision BEFORE INSERT ON ${receiptTable}
    FOR EACH ROW EXECUTE FUNCTION public.test_subscription_receipt_collision()`);
  try {
    refused(await edit(owner, ctx, input), "destination_idempotency_conflict", "idempotencyKey");
    expect(await effects(owner, ctx)).toEqual(before);
  } finally {
    await owner.query(`DROP TRIGGER test_subscription_receipt_collision ON ${receiptTable}; DROP FUNCTION public.test_subscription_receipt_collision()`);
  }
  expect((await edit(owner, ctx, input)).outcome).toBe("applied_from_next_parcel");
});

it("clears mixed privacy data and returns only the disposition on exact erased replay", async () => {
  const { owner, runtime } = store, ctx = await subject();
  const checkout = await snapshot(runtime, { ...ctx, scopeRef: randomUUID() });
  const input = command(ctx), issued = await edit(owner, ctx, input);
  const contributorStore = createPostgresPrivacyStore(), operator = randomUUID();
  await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [operator, `${operator}@example.invalid`]);
  await owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES($1,'admin','active','legacy',clock_timestamp())`, [operator]);
  const now = await query(owner, "SELECT clock_timestamp() AS result");
  const operations = createPrivacyOperations({ store: contributorStore,
    registry: createPersonalDataContributorRegistry(nativePrivacyContributors(contributorStore), { requiredContributorIds: ["identity"] }),
    now: () => now, randomId: randomUUID, unitOfWork: { async run<T>(work: (db: PgQueryExecutor) => Promise<T>) {
      const connection = await runtime.connect();
      try {
        await connection.query("BEGIN");
        const result = await work({ query: (sql, args) => connection.query(sql, args ? [...args] : undefined) });
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally { connection.release(); }
    } },
  });
  const actor = { principalId: operator }, target = { kind: "contact" as const, contactId: ctx.clientId };
  const exported = await operations.export(actor, target);
  expect(exported.documents.find(doc => doc.contributorId === "destination-documents")?.data).toEqual(expect.arrayContaining([
    expect.objectContaining({ snapshotRef: checkout.binding.snapshotRef }),
    expect.objectContaining({ snapshotRef: issued.binding.snapshotRef, evidenceExpiresAt: null,
      subscriptionSelections: [{ subscriptionId: ctx.scopeRef, selectionRevision: issued.selectionRevision, service: testServicePin }] }),
  ]));
  await runtime.query("SELECT public.subscription_apply_lifecycle_action($1,$2,$3,'cancel','{}',clock_timestamp())",
    [ctx.clientId, randomUUID(), ctx.scopeRef]);
  expect((await operations.erase(actor, { subject: target, idempotencyKey: randomUUID() })).outcome).toBe("ERASED");
  expect(await query(owner, "SELECT principal_id AS result FROM public.clients WHERE id=$1", [ctx.clientId])).toBeNull();
  const after = await effects(owner, ctx);
  expect(after.documents).toHaveLength(2);
  expect(after.documents.every((row: { document_text: unknown }) => row.document_text === null)).toBe(true);
  expect(after.selections).toEqual([{ subscription_id: ctx.scopeRef, snapshot_ref: issued.binding.snapshotRef,
    selection_revision: null, service: null }]);
  expect(after.receipts.map((row: { evidence_disposition: string; outcome: unknown }) => [row.evidence_disposition,row.outcome]))
    .toEqual([["erased", null], ["erased", null]]);
  expect(await edit(owner, ctx, { ...input, validated: null, service: null })).toEqual({ evidenceDisposition: "erased" });
  refused(await edit(owner, ctx, command(ctx, { requestKey: input.requestKey, expectedTemplateVersion: 8 })),
    "destination_idempotency_conflict", "idempotencyKey");
  refused(await edit(owner, ctx), "destination_owner_unlinked", "owner");
  expect(await effects(owner, ctx)).toEqual(after);
});

it("skips current and order-bound rows before LIMIT, then rechecks a late visible reference", async () => {
  const { owner, runtime } = await resources.installation("destination-subscription-expiry");
  const ctx = await subject(owner), first = await edit(owner, ctx);
  const second = await edit(owner, ctx, command(ctx, { expectedSelectionRevision: first.selectionRevision }));
  const checkoutCtx = { ...ctx, scopeRef: randomUUID() }, bound = await snapshot(runtime, checkoutCtx);
  await bindDestinationOrder(owner, checkoutCtx, bound);
  await owner.query(`UPDATE ${documentTable} SET issued_at=statement_timestamp()-interval '3 days',
    evidence_expires_at=statement_timestamp()-interval '3 days' WHERE snapshot_ref=$1`, [second.binding.snapshotRef]);
  await owner.query(`UPDATE ${documentTable} SET evidence_expires_at=clock_timestamp()-interval '2 days' WHERE snapshot_ref=$1`, [bound.binding.snapshotRef]);
  expect(await expire(owner)).toBe(1);
  expect((await effects(owner, ctx)).documents).toEqual(expect.arrayContaining([
    expect.objectContaining({ snapshot_ref: first.binding.snapshotRef, evidence_disposition: "expired", document_text: null }),
    expect.objectContaining({ snapshot_ref: second.binding.snapshotRef, evidence_disposition: "available" }),
    expect.objectContaining({ snapshot_ref: bound.binding.snapshotRef, evidence_disposition: "available" }),
  ]));
  const unpublished = command(ctx, { expectedSelectionRevision: second.selectionRevision });
  const writer = await owner.connect(), sweeper = await owner.connect(), holder = await owner.connect();
  try {
    const [sweeperPid, holderPid] = await Promise.all([sweeper, holder].map(backendPid));
    const submit = deferred<void>();
    await writer.query("BEGIN");
    const submitted = submit.promise.then(() => edit(writer, ctx, unpublished));
    expect(await expire(sweeper)).toBe(0);
    submit.resolve();
    const third = await submitted;
    expect(third.outcome).toBe("applied_from_next_parcel");
    expect(await expire(sweeper)).toBe(0);
    await writer.query("COMMIT");

    await holder.query("BEGIN");
    await holder.query("SELECT id FROM public.clients WHERE id=$1 FOR UPDATE", [ctx.clientId]);
    const pending = expire(sweeper);
    void pending.catch(() => undefined);
    await waitFor(owner, sweeperPid, holderPid);
    const retry = command(ctx, { expectedSelectionRevision: third.selectionRevision });
    refused(await edit(writer, ctx, retry), "destination_busy", "owner");
    await holder.query(`UPDATE ${selections} SET snapshot_ref=$2,selection_revision=$3 WHERE subscription_id=$1`,
      [ctx.scopeRef, second.binding.snapshotRef, second.selectionRevision]);
    await holder.query("COMMIT");
    expect(await pending).toBe(0);
    expect(await current(owner, ctx)).toMatchObject({ binding: second.binding });
    expect(await expire(owner)).toBe(1);
    expect(await edit(owner, ctx, unpublished)).toEqual({ ...third, replayed: true });
  } finally {
    await Promise.all([writer, sweeper, holder].map(async db => { await db.query("ROLLBACK"); db.release(); }));
  }
}, 45_000);

const legacy = (db: Db, ctx: Context) => query(db, `SELECT public.subscription_change_shipping_destination($1,$2,$3,$4,$5,7,clock_timestamp()) AS result`,
  [ctx.owner.principalRef, ctx.clientId, randomUUID(), ctx.scopeRef, { newAddress: {
    recipientName: "Fixture", line1: "Sample lane", city: "Example", postalCode: "00000", country: "ZZ",
  } }]);
it.each([true, false])("serializes with the real v1 edit (v2 first: %s)", async v2First => {
  const { owner, runtime } = store, ctx = await subject();
  const lead = await (v2First ? owner : runtime).connect(), follow = await (v2First ? runtime : owner).connect();
  const first = v2First ? edit : legacy, second = v2First ? legacy : edit;
  try {
    const leadPid = await backendPid(lead), followPid = await backendPid(follow);
    await lead.query("BEGIN");
    const result = await first(lead, ctx);
    const pending = second(follow, ctx);
    void pending.catch(() => undefined);
    await waitFor(owner, followPid, leadPid);
    await lead.query("COMMIT");
    const other = await pending;
    expect(v2First ? result.outcome : other.outcome).toBe("applied_from_next_parcel");
    expect(v2First ? other.outcome : result.outcome).toBe("applied_from_next_parcel");
  } finally {
    await lead.query("ROLLBACK");
    lead.release();
    follow.release();
  }
});

it("inherits the exact order pin and races real renewal prepare with no parcel, cycle or alignment writes from the edit", async () => {
  const db = await resources.installation("destination-subscription-renewal");
  const { owner, runtime } = db, purchase = await prepareJourneyRenewal(db);
  const ctx = { ...await destinationContext(owner, purchase.clientId), scopeRef: purchase.subscriptionId };
  const { at, version } = (await owner.query<{ at: Date; version: number }>(
    "SELECT clock_timestamp() AS at, template_version AS version FROM public.subscriptions WHERE id=$1", [ctx.scopeRef])).rows[0]!;
  await createPostgresFulfillmentShipmentSpinePort(owner, { portKey: "journey-parcel" })
    .createShipment({ idempotencyKey: "destination-subscription-parcel", orderId: purchase.orderId, requestedAt: at.toISOString() });
  const originScope = { ...ctx, scopeRef: randomUUID() }, origin = await snapshot(runtime, originScope);
  await owner.query(`INSERT INTO public.commerce_destination_v2_order_bindings(order_id,snapshot_ref,selection,service)
    VALUES($1,$2,$3,$4)`, [purchase.orderId, origin.binding.snapshotRef, origin.selection, testServicePin]);
  expect(await current(owner, ctx)).toEqual({ binding: origin.binding, selectionRevision: origin.selection.selectionRevision, service: testServicePin });
  const noSelection = () => edit(owner, ctx, command(ctx, { expectedTemplateVersion: version }));
  await owner.query(`UPDATE ${orderBindingTable} SET service=service||'{"forbidden":true}'::jsonb WHERE order_id=$1`, [purchase.orderId]);
  refused(await noSelection(), "destination_binding_invalid", "orderBindings");
  await owner.query(`UPDATE ${orderBindingTable} SET selection=NULL,service=NULL WHERE order_id=$1`, [purchase.orderId]);
  refused(await noSelection(), "destination_evidence_unavailable", "subscriptionId");
  await owner.query(`UPDATE ${orderBindingTable} SET selection=$2,service=$3 WHERE order_id=$1`, [purchase.orderId, origin.selection, testServicePin]);
  const duplicate = await insertDestinationOrder(owner, originScope);
  await owner.query(`INSERT INTO public.subscription_activations
    (order_id,client_id,subscription_id,cadence_days,state,payment_fingerprint,activation_idempotency_key,declare_idempotency_key,activated_at)
    VALUES($1,$2,$3,28,'active',repeat('a',64),$4,$5,clock_timestamp())`,
  [duplicate, ctx.clientId, ctx.scopeRef, randomUUID(), randomUUID()]);
  refused(await noSelection(), "destination_binding_invalid", "destination");
  await owner.query("DELETE FROM public.commerce_orders WHERE id=$1", [duplicate]);
  refused(await noSelection(), "destination_version_changed", "expectedSelectionRevision");
  function incumbentRows(rows: Awaited<ReturnType<typeof journeyCensus>>) {
    const { commerce_destination_v2_documents: _documents, commerce_destination_v2_receipts: _receipts,
      subscription_destination_v2_selections: _selections, ...incumbent } = rows;
    return incumbent;
  }
  await owner.query("SELECT public.subscription_delivery_alignment_set_mode('shadow')");
  expect(await query(owner, `SELECT public.subscription_delivery_alignment_admit_renewal(id,next_cycle_at,$2) AS result
    FROM public.subscriptions WHERE id=$1`, [ctx.scopeRef, at])).toMatchObject({ allowed: true, state: "shadow" });
  const beforeEdit = incumbentRows(await journeyCensus(owner));
  expect(beforeEdit.subscription_delivery_alignment_cases).toHaveLength(1);
  const edited = await edit(owner, ctx, command(ctx, { expectedTemplateVersion: version, expectedSelectionRevision: origin.selection.selectionRevision }));
  expect(edited.outcome).toBe("applied_from_next_parcel");
  expect(incumbentRows(await journeyCensus(owner))).toEqual(beforeEdit);

  const renewal = await composeJourneyRenewal(db, ctx.scopeRef, "succeeded", at.toISOString());
  const frozen = await renewal.input.store.buildCycleSnapshots(renewal.due), now = at.toISOString();
  const claim = await renewal.input.store.claimDue({ snapshot: frozen, workerId: "destination-locks", now });
  expect((await renewal.input.inventory.reserve({ operationId: claim.operationId, claimToken: claim.claimToken, now })).reserved).toBe(true);
  const sealed = () => query(owner, "SELECT cycle_snapshot::text AS result FROM public.subscription_renewal_operations WHERE id=$1", [claim.operationId]);
  const originalBytes = await sealed(), beforeReplays = await effects(owner, ctx);
  const prepare = (db: Db) => query(db, "SELECT public.commerce_prepare_subscription_renewal($1,$2,$3) AS result",
    [claim.operationId, claim.claimToken, now]);
  const blockedEdit = (db: Db) => edit(db, ctx, command(ctx, { expectedTemplateVersion: version, expectedSelectionRevision: edited.selectionRevision }));
  const writer = await owner.connect(), preparer = await runtime.connect();
  try {
    const writerPid = await backendPid(writer), preparerPid = await backendPid(preparer);
    await writer.query("BEGIN"); await preparer.query("BEGIN");
    refused(await blockedEdit(writer), "payment_blocked", "subscriptionId");
    const afterEdit = prepare(preparer);
    void afterEdit.catch(() => undefined);
    await waitFor(owner, preparerPid, writerPid);
    await writer.query("COMMIT");
    expect(await afterEdit).toMatchObject({ replayed: false, state: "attempt_prepared" });
    await preparer.query("ROLLBACK");

    await preparer.query("BEGIN");
    expect(await prepare(preparer)).toMatchObject({ replayed: false, state: "attempt_prepared" });
    const afterPrepare = blockedEdit(writer);
    void afterPrepare.catch(() => undefined);
    await waitFor(owner, writerPid, preparerPid);
    await preparer.query("COMMIT");
    refused(await afterPrepare, "payment_blocked", "subscriptionId");
    expect(await sealed()).toBe(originalBytes);
    expect(await effects(owner, ctx)).toEqual(beforeReplays);
  } finally {
    await Promise.all([writer, preparer].map(async db => { await db.query("ROLLBACK"); db.release(); }));
  }
}, 90_000);
