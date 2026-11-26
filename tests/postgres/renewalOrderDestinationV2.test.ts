import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { installAccountMutations } from "./customerAccountMutations.fixture.js";
import { destinationHash, insertDestinationOrder, readSnapshot } from "./destinationDocumentFixture.js";
import { backendPid, markReceiptClientErased } from "./destinationReceiptFixture.js";
import {
  activate, bind, bookCycle, checkoutSignature, edit, insertLocalAttempt, ownerTransaction, paidHandoff, prepareGraph, prepareOpening,
  registerName, registerSignature, subject, type Destination, type Subject, type Target,
} from "./renewalOrderDestinationV2.fixture.js";
import { AT, call, type Db } from "./subscriptionNativeFixture.js";

const resources = storeJourneyResources({ isolatedCluster: true });
let store: JourneyInstallation;
const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (manifest?.schemaVersion !== 3) throw new Error("Complete native catalogue required");
const forward = manifest.forward.find(entry => entry.file.endsWith("_renewal_order_destination_v2.sql"));
if (!forward) throw new Error("Renewal destination migration missing");
const migration = forward;
const installedManifest = manifest;

beforeAll(async () => { store = await resources.installation("renewal-destination"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

const data = async (db: Db, sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows;
const retained = (db: Db, f: Subject, target: Target, destination: Destination) =>
  readSnapshot(db, f.ctx, destination.binding, target.order, "order");
const unavailable = (detail = "subscriptionId") => ({
  code: "22023", message: "destination_evidence_unavailable", detail, hint: "Re-obtain evidence through the authenticated owner.",
});
const stale = (detail: string) => ({
  code: "22023", message: "destination_version_changed", detail,
  hint: "Read the current subscription destination with commerce_read_destination_v2 and a null expected binding. Rebuild the selected fiscal binding before preparing again.",
});
const invalidStoredPins = {
  code: "22023", message: "destination_binding_invalid", detail: "orderBindings",
  hint: "Send the retained evidence to the destination owner for review.",
};
const expectedSelection = (f: Subject, selected: Destination) =>
  ({ kind: "subscription", scopeRef: f.ctx.scopeRef, selectionRevision: selected.selectionRevision });

async function invariant(db: Db, f: Subject) {
  return data(db, `SELECT
    (SELECT array_agg(row_to_json(c)::text ORDER BY id) FROM public.subscription_cycles c WHERE subscription_id=$1) AS cycles,
    (SELECT array_agg(row_to_json(a)::text ORDER BY id) FROM public.subscription_delivery_alignment_cases a WHERE subscription_id=$1) AS alignment,
    (SELECT row_to_json(s)::text FROM public.subscriptions s WHERE id=$1) AS subscription,
    (SELECT array_agg(row_to_json(o)::text ORDER BY cycle_key) FROM public.subscription_cycle_occurrences o WHERE subscription_id=$1) AS occurrences,
    (SELECT array_agg(row_to_json(x)::text ORDER BY obligation_ref) FROM public.subscription_cycle_delivery_assignments x
      JOIN public.subscription_cycle_occurrences o ON o.cycle_key=x.assigned_cycle_key WHERE o.subscription_id=$1) AS obligations`,
  [f.ctx.scopeRef]);
}

async function effects(db: Db, f: Subject) {
  return data(db, `SELECT
    (SELECT array_agg((o.xmin::text, o.*)::text ORDER BY id) FROM public.commerce_orders o WHERE client_id=$1) AS orders,
    (SELECT array_agg((b.xmin::text, b.*)::text ORDER BY b.order_id) FROM public.commerce_destination_v2_order_bindings b
      JOIN public.commerce_orders o ON o.id=b.order_id WHERE o.client_id=$1) AS destinations,
    (SELECT array_agg((p.xmin::text, p.*)::text ORDER BY preparation_id) FROM public.subscription_cycle_preparations p WHERE cycle_key=$2) AS preparations,
    (SELECT array_agg((i.xmin::text, i.*)::text ORDER BY i.id) FROM public.commerce_settlement_intents i
      JOIN public.commerce_orders o ON o.id=i.order_id WHERE o.client_id=$1) AS intents,
    (SELECT array_agg((a.xmin::text, a.*)::text ORDER BY a.id) FROM public.payment_provider_attempts a
      JOIN public.subscription_cycle_preparations p ON p.payment_attempt_id=a.id WHERE p.cycle_key=$2) AS attempts,
    (SELECT count(*)::int FROM public.subscription_cycle_dispatch_grants g JOIN public.subscription_cycle_preparations p
      ON p.payment_attempt_id=g.payment_attempt_id WHERE p.cycle_key=$2) AS grants,
    (SELECT count(*)::int FROM public.commerce_fulfillment_provider_commands c JOIN public.commerce_orders o
      ON o.id=c.order_id WHERE o.client_id=$1) AS commands`, [f.ctx.clientId, f.pair.cycle_key]);
}

async function expectBindRefused(db: PoolClient, f: Subject, target: Target, refusal: Record<string, string>, reason: string) {
  const before = await effects(db, f);
  await db.query("SAVEPOINT writer_call");
  await expect(bind(db, f.ctx, target.order, f.ny), reason).rejects.toMatchObject(refusal);
  await db.query("ROLLBACK TO SAVEPOINT writer_call; RELEASE SAVEPOINT writer_call");
  expect(await effects(db, f), reason).toStrictEqual(before);
}

async function prepare(db: PoolClient, f: Subject, selected: Destination, cycle: string, predecessor?: Target) {
  const target = await prepareGraph(db, f, selected, cycle, predecessor);
  expect(await bind(db, f.ctx, target.order, selected)).toStrictEqual(selected.binding);
  await insertLocalAttempt(db, f, target);
  return target;
}

async function stagePreparation(owner: Pool, f: Subject) {
  const cycle = await bookCycle(owner, f);
  return ownerTransaction(owner, async db => {
    const target = await prepareGraph(db, f, f.ny, cycle);
    // Satisfy the deferred payment references so the writer can run in a fresh transaction.
    await insertLocalAttempt(db, f, target);
    return target;
  });
}

async function noReplacementConfirmation(db: PoolClient) {
  expect(await data(db, `SELECT calls FROM pg_stat_xact_user_functions
    WHERE schemaname='public' AND funcname='subscription_delivery_alignment_confirm_replacement'`)).toEqual([]);
}

async function waitFor(observer: Db, waiting: PoolClient, blocker: PoolClient) {
  const [pid, blocking] = await Promise.all([backendPid(waiting), backendPid(blocker)]);
  return async () => expect.poll(async () => (await data(observer,
    `SELECT $2::int=ANY(pg_blocking_pids($1)) AND EXISTS (
      SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='tuple' AND relation='public.subscriptions'::regclass
    ) AS blocked`, [pid, blocking]))[0]?.blocked, { timeout: 4_000 }).toBe(true);
}

it("measures the native predecessor, applies the destination forward first and preserves checkout registration bytes and ACL", async () => {
  const prefix = structuredClone(installedManifest);
  for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) {
    const index = plan.forward.findIndex(entry => entry.file === migration.file);
    expect(index).toBeGreaterThan(0);
    plan.forward.splice(index);
  }
  const previousUnits = [prefix.qualified.baseline, ...prefix.qualified.forward].map(unit => unit.file);
  const suffix = installedManifest.qualified.forward.slice(prefix.qualified.forward.length).map(unit => unit.file);
  const checkout = (db: Db) => data(db, `SELECT pg_get_functiondef(p.oid) AS definition, proacl, proowner, proconfig
    FROM pg_proc p WHERE p.oid=$1::regprocedure`, [checkoutSignature]);
  await withPlatformCatalog(prefix, async root => {
    const installation = await installAccountMutations("bootstrap", true, "renewal-destination-upgrade", root, process.cwd());
    try {
      const predecessorInventory = installation.inventory;
      expect(predecessorInventory).toMatch(/^[0-9a-f]{64}$/u);
      const previous = await checkout(installation.owner);
      expect(previous).toHaveLength(1);
      const status = await installation.runner.status();
      expect(status.applied).toStrictEqual(previousUnits);
      expect(status.pending[0]).toBe(migration.file);
      expect(status.pending).toStrictEqual(suffix);
      expect(await installation.runner.apply()).toStrictEqual({ applied: suffix });
      expect(installation.inventory).toBe(installedManifest.qualified.objectInventorySha256.bootstrapMigrator.withRestore);
      expect(installation.inventory).not.toBe(predecessorInventory);
      expect(await checkout(installation.owner)).toStrictEqual(previous);
    } finally {
      await installation.close();
    }
  });
}, postgresSetupTimeoutMs);

it("denies the private writer under browser and service default privileges and permits its installed owner", async () => {
  const { owner, runtime } = store;
  const args = [null, null, null, null, null, null];
  const roles = ["anon", "authenticated", "service_role", "transfer_runtime"];
  const census = `SELECT p.provolatile, p.prosecdef, p.proconfig, p.proowner::regrole::text AS owner,
      (SELECT t.relowner::regrole::text FROM pg_class t WHERE t.oid='public.subscription_cycle_preparations'::regclass) AS preparation_owner,
      EXISTS(SELECT 1 FROM aclexplode(p.proacl) WHERE grantee=0) AS public_grant
    FROM pg_proc p WHERE p.oid=$1::regprocedure`;
  expect(await data(owner, census, [registerSignature])).toEqual([
    { provolatile: "v", prosecdef: false, proconfig: ["search_path=pg_catalog, pg_temp"], owner: "transfer_owner",
      preparation_owner: "transfer_owner", public_grant: false },
  ]);
  await expect(call(runtime, registerName, args)).rejects.toMatchObject({ code: "42501" });
  await expect(call(owner, registerName, args)).rejects.toMatchObject({
    code: "22023", message: "address_invalid_input", detail: "subscriptionId", hint: "Correct the indicated input.",
  });
  await ownerTransaction(owner, async db => {
    await db.query(`DROP FUNCTION ${registerSignature};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      CREATE FUNCTION public.destination_default_acl_control() RETURNS boolean LANGUAGE sql AS 'SELECT true'`);
    expect(await data(db, `SELECT role FROM unnest($1::text[]) AS r(role)
      WHERE has_function_privilege(role,'public.destination_default_acl_control()','EXECUTE') ORDER BY role`, [roles]))
      .toEqual([...roles].sort().map(role => ({ role })));
    await db.query(readFileSync(migration.file, "utf8"));
    const privileges = await data(db, `SELECT role FROM unnest($1::text[]) AS r(role)
      WHERE has_function_privilege(role, $2::regprocedure, 'EXECUTE')`, [roles, registerSignature]);
    expect(privileges).toEqual([]);
    for (const role of roles) {
      await db.query(`SAVEPOINT permission_check; SET LOCAL ROLE ${role}`);
      await expect(call(db, registerName, args)).rejects.toMatchObject({ code: "42501" });
      await db.query("ROLLBACK TO SAVEPOINT permission_check; RELEASE SAVEPOINT permission_check");
    }
  }, false);
});

it("binds inherited New York and a replacement with explicit California, retaining both frozen carrier contacts and exports", async () => {
  const { owner, runtime } = store, f = await subject(store);
  const booked = await bookCycle(owner, f);
  const before = await invariant(owner, f);
  expect(before[0].alignment).toHaveLength(1);
  const lostAcknowledgement = new Error("Commit acknowledgement was lost");
  await expect(ownerTransaction(owner, async db => {
    await db.query("SET LOCAL track_functions='pl'");
    await prepare(db, f, f.ny, booked);
    await noReplacementConfirmation(db);
  }).then(() => { throw lostAcknowledgement; })).rejects.toBe(lostAcknowledgement);
  expect(await invariant(owner, f)).toEqual(before);
  const ca = await edit(owner, f.ctx, f.ny.selectionRevision);
  expect(ca.outcome).toBe("applied_from_next_parcel");
  const beforeReplay = await effects(owner, f);
  const receipt = await owner.query<Target>(`SELECT p.preparation_id AS preparation, p.order_id AS "order",
    p.cycle_id AS cycle, p.settlement_intent_id AS intent, p.payment_attempt_id AS attempt,
    a.payment_id AS payment, p.hold_incarnation_id AS hold, p.opening_key AS opening
    FROM public.subscription_cycle_preparations p JOIN public.payment_provider_attempts a ON a.id=p.payment_attempt_id
    WHERE p.opening_key=$1 AND p.cycle_key=$2`, [prepareOpening(f, 1), f.pair.cycle_key]);
  const east = receipt.rows[0]!;
  expect(receipt.rows).toHaveLength(1);
  expect(await retained(runtime, f, east, f.ny)).toMatchObject({
    binding: f.ny.binding, document: { address: { subdivision: "NY" } },
  });
  expect(await effects(owner, f)).toStrictEqual(beforeReplay);
  expect(beforeReplay[0]).toMatchObject({ grants: 0, commands: 0 });

  const firstParcel = await paidHandoff(store, east);
  expect(firstParcel.contact).toMatchObject({ binding: f.ny.binding, service: f.ny.service,
    address: { subdivision: "NY" }, recipient: { recipientName: "Sample Recipient" } });
  expect(await readSnapshot(runtime, f.ctx, f.ny.binding, firstParcel.shipment, "shipment")).toMatchObject({
    binding: f.ny.binding, document: { address: { subdivision: "NY" } },
  });

  const replacing = await subject(store);
  const originalCycle = await bookCycle(owner, replacing);
  const original = await ownerTransaction(owner, db => prepare(db, replacing, replacing.ny, originalCycle));
  const originalRows = (await effects(owner, replacing))[0].destinations;
  const westSelection = await edit(owner, replacing.ctx, replacing.ny.selectionRevision);
  expect(westSelection.outcome).toBe("applied_from_next_parcel");
  const replacementCycle = await bookCycle(owner, replacing);
  const beforeReplacement = await invariant(owner, replacing);
  const west = await ownerTransaction(owner, async db => {
    await db.query("SET LOCAL track_functions='pl'");
    const replacement = await prepare(db, replacing, westSelection, replacementCycle, original);
    await noReplacementConfirmation(db);
    return replacement;
  });
  expect(await invariant(owner, replacing)).toStrictEqual(beforeReplacement);
  expect((await effects(owner, replacing))[0].destinations).toEqual(expect.arrayContaining(originalRows));
  expect(await data(owner, `SELECT o.status, p.closed_unsent_at IS NOT NULL AS closed
    FROM public.subscription_cycle_preparations p JOIN public.commerce_orders o ON o.id=p.order_id
    WHERE p.preparation_id=$1`, [original.preparation])).toEqual([{ status: "cancelled", closed: true }]);
  const rows = await data(owner, `SELECT order_id, snapshot_ref, selection, service
    FROM public.commerce_destination_v2_order_bindings WHERE order_id=ANY($1) ORDER BY order_id`, [[original.order, west.order]]);
  const exported = await call(runtime, "commerce_destination_v2_export", [replacing.ctx.clientId]);
  for (const [target, selected, issuedScope] of [
    [original, replacing.ny, replacing.checkout.scopeRef], [west, westSelection, replacing.ctx.scopeRef],
  ] as const) {
    const selection = expectedSelection(replacing, selected);
    expect(rows).toContainEqual({ order_id: target.order, snapshot_ref: selected.binding.snapshotRef, selection, service: selected.service });
    expect(exported).toEqual(expect.arrayContaining([expect.objectContaining({
      snapshotRef: selected.binding.snapshotRef, scopeRef: issuedScope,
      orderBindings: expect.arrayContaining([{ orderId: target.order, selection, service: selected.service }]),
    })]));
  }
  expect(await edit(owner, replacing.ctx, westSelection.selectionRevision, {
    ...westSelection.service, adapterRevision: "later-adapter",
  })).toMatchObject({ outcome: "applied_from_next_parcel" });
  const replacementParcel = await paidHandoff(store, west);
  expect(replacementParcel.contact).toMatchObject({ binding: westSelection.binding, service: westSelection.service,
    address: { subdivision: "CA" }, recipient: { recipientName: "West Recipient" } });
  expect(await readSnapshot(runtime, replacing.ctx, westSelection.binding, replacementParcel.shipment, "shipment")).toMatchObject({
    binding: westSelection.binding, document: { address: { subdivision: "CA" } },
  });
});

it("rolls back the destination with preparation before creating the local attempt and leaves delivery state byte-identical", async () => {
  const { owner } = store, f = await subject(store), cycle = await bookCycle(owner, f);
  const before = await effects(owner, f), delivery = await invariant(owner, f);
  await ownerTransaction(owner, async db => {
    await db.query("SET LOCAL track_functions='pl'");
    const target = await prepareGraph(db, f, f.ny, cycle);
    expect(await bind(db, f.ctx, target.order, f.ny)).toStrictEqual(f.ny.binding);
    expect(await data(db, "SELECT 1 FROM public.commerce_destination_v2_order_bindings WHERE order_id=$1", [target.order])).toHaveLength(1);
    expect(await data(db, "SELECT 1 FROM public.payment_provider_attempts WHERE id=$1", [target.attempt])).toEqual([]);
    await noReplacementConfirmation(db);
  }, false);
  expect(await effects(owner, f)).toStrictEqual(before);
  expect(await invariant(owner, f)).toStrictEqual(delivery);
});

it("refuses stale snapshot, policy, selection and each service pin at the same payable without committing effects", async () => {
  const { owner } = store, f = await subject(store), cycle = await bookCycle(owner, f);
  const ca = await edit(owner, f.ctx, f.ny.selectionRevision);
  expect(ca.outcome).toBe("applied_from_next_parcel");
  const before = await effects(owner, f);
  const controls: [Destination, Record<string, string>][] = [
    [f.ny, stale("destination.snapshotRef")],
    [{ ...ca, binding: { ...ca.binding, policyRevision: "older" } }, stale("destination.policyRevision")],
    [{ ...ca, selectionRevision: randomUUID() }, stale("selectionRevision")],
    [{ ...ca, binding: { ...ca.binding, destinationDigest: "0".repeat(64) } },
      { code: "22023", message: "destination_digest_mismatch", detail: "destinationDigest", hint: "Replay the original document and its digest." }],
    ...Object.keys(ca.service).map((key): [Destination, Record<string, string>] =>
      [{ ...ca, service: { ...ca.service, [key]: "different" } }, stale("selectedDelivery")]),
  ];
  for (const [selected, refusal] of controls) {
    await expect(ownerTransaction(owner, async db => {
      const target = await prepareGraph(db, f, selected, cycle);
      await bind(db, f.ctx, target.order, selected);
    })).rejects.toMatchObject(refusal);
    expect(await effects(owner, f)).toStrictEqual(before);
  }
});

it("refuses a fiscal issuance with a different operation, generation or sequence, or an erased issuance, without writing", async () => {
  const { owner } = store, f = await subject(store), target = await stagePreparation(owner, f);
  const other = await subject(store), otherGeneration = randomUUID();
  await ownerTransaction(owner, async db => {
    for (const [source, generation] of [[other, f.pair.commercial_generation_id], [f, otherGeneration]] as const) {
      await db.query(`INSERT INTO public.subscription_cycle_generations
        (operation_id, commercial_generation_id, cycle_key, agreement, agreement_fingerprint, claim_token, lease_expires_at, lease_generation)
        SELECT operation_id, $3, cycle_key, agreement, agreement_fingerprint, claim_token, lease_expires_at, lease_generation
        FROM public.subscription_cycle_generations WHERE operation_id=$1 AND commercial_generation_id=$2`,
      [source.pair.operation_id, source.pair.commercial_generation_id, generation]);
    }
    const cases: [string, string, unknown[]][] = [
      ["operation", "operation_id=$2", [other.pair.operation_id]],
      ["generation", "commercial_generation_id=$2", [otherGeneration]],
      ["sequence", "binding_seq=$2", [2]],
      ["erased", "erased_at=clock_timestamp(), request_evidence=NULL", []],
    ];
    for (const [reason, change, args] of cases) {
      await db.query("SAVEPOINT issuance_fixture");
      expect((await db.query(
        `UPDATE public.subscription_cycle_tax_issuances SET ${change} WHERE hold_incarnation_id=$1`,
        [target.hold, ...args],
      )).rowCount, reason).toBe(1);
      await expectBindRefused(db, f, target, unavailable("orderId"), reason);
      await db.query("ROLLBACK TO SAVEPOINT issuance_fixture; RELEASE SAVEPOINT issuance_fixture");
    }
    expect(await bind(db, f.ctx, target.order, f.ny)).toStrictEqual(f.ny.binding);
  });
});

it("distinguishes malformed prior checkout pins from missing acquisition lineage after an explicit edit", async () => {
  const { owner } = store, f = await subject(store), target = await stagePreparation(owner, f);
  expect(await edit(owner, f.ctx, f.ny.selectionRevision)).toMatchObject({ outcome: "applied_from_next_parcel" });
  const before = await effects(owner, f);
  await ownerTransaction(owner, async db => {
    await expectBindRefused(db, f, target, stale("destination.snapshotRef"), "valid prior pins");
    for (const [pin, change] of [
      ["selection", "selection=selection-'selectionRevision'"],
      ["service", "service=service-'adapterRevision'"],
    ] as const) {
      await db.query("SAVEPOINT checkout_fixture");
      expect((await db.query(`UPDATE public.commerce_destination_v2_order_bindings SET ${change} WHERE order_id=$1`, [f.origin])).rowCount).toBe(1);
      const read = await readSnapshot(db, f.ctx, f.ny.binding, f.ctx.scopeRef, "subscription");
      expect(read).toMatchObject({ outcome: "refused", code: "destination_evidence_unavailable", field: "subscriptionId" });
      await expectBindRefused(db, f, target, invalidStoredPins, pin);
      await db.query("ROLLBACK TO SAVEPOINT checkout_fixture; RELEASE SAVEPOINT checkout_fixture");
    }
    await db.query("DELETE FROM public.commerce_destination_v2_order_bindings WHERE order_id=$1", [f.origin]);
    await expectBindRefused(db, f, target, unavailable(), "missing acquisition binding");
  }, false);
  expect(await effects(owner, f)).toStrictEqual(before);
});

it("returns the original binding on direct writer replay with zero writes and refuses a different incumbent", async () => {
  const { owner } = store, f = await subject(store), target = await stagePreparation(owner, f);
  const original = await bind(owner, f.ctx, target.order, f.ny);
  expect(original).toStrictEqual(f.ny.binding);
  const beforeReplay = await effects(owner, f);
  await ownerTransaction(owner, async db => {
    expect(await bind(db, f.ctx, target.order, f.ny)).toStrictEqual(original);
    expect(await data(db, `SELECT relname FROM pg_stat_xact_user_tables WHERE n_tup_ins+n_tup_upd+n_tup_del>0`)).toEqual([]);
  });
  expect(await effects(owner, f)).toStrictEqual(beforeReplay);

  await owner.query("UPDATE public.commerce_destination_v2_order_bindings SET service=$2 WHERE order_id=$1",
    [target.order, { ...f.ny.service, adapterRevision: "incumbent-adapter" }]);
  const occupied = await effects(owner, f);
  await expect(bind(owner, f.ctx, target.order, f.ny)).rejects.toMatchObject({
    code: "23505", message: "destination_order_binding_occupied", detail: "orderId",
    hint: "Resolve the existing binding without moving it.",
  });
  expect(await effects(owner, f)).toStrictEqual(occupied);
});

it("refuses a live principal mismatch on an otherwise valid preparation", async () => {
  const { owner } = store, f = await subject(store), target = await stagePreparation(owner, f);
  const wrongOwner = { ...f.ctx, owner: { ...f.ctx.owner, principalRef: randomUUID() } };
  const before = await effects(owner, f);
  await expect(bind(owner, wrongOwner, target.order, f.ny)).rejects.toMatchObject({
    code: "22023", message: "destination_owner_unlinked", detail: "owner",
    hint: "Establish authorized linkage or use authorized support.",
  });
  expect(await effects(owner, f)).toStrictEqual(before);
  expect(await bind(owner, f.ctx, target.order, f.ny)).toStrictEqual(f.ny.binding);
});

it("checks completed erasure before missing live linkage and rejects ambiguous acquisition without preparation effects", async () => {
  const { owner, runtime } = store;
  const erased = await subject(store), erasedCycle = await bookCycle(owner, erased);
  const erasedOrder = await ownerTransaction(owner, db => prepare(db, erased, erased.ny, erasedCycle));
  const { shipment } = await paidHandoff(store, erasedOrder);
  const assertLegacyRefusal = () => expect(call(runtime, "commerce_fulfillment_enqueue_provider_command", [
    shipment, "offline", "dispatch_create", "1", randomUUID(), ...Array(2).fill(destinationHash("command")), null,
    ...Array(3).fill(destinationHash("configuration")), 3,
  ])).rejects.toMatchObject({
    code: "22023", message: "destination_adapter_unsupported", detail: "selectedDelivery.providerRef",
    hint: "Use the qualified native dispatch workflow for the original order.",
  });
  await assertLegacyRefusal();
  await call(runtime, "commerce_destination_v2_erase", [erased.ctx.clientId]);
  await markReceiptClientErased(owner, erased.ctx.clientId);
  await owner.query("UPDATE public.clients SET principal_id=NULL WHERE id=$1", [erased.ctx.clientId]);
  const beforeErased = await effects(owner, erased);
  await assertLegacyRefusal();
  await expect(bind(owner, erased.ctx, erasedOrder.order, erased.ny)).rejects.toMatchObject(unavailable());
  expect(await retained(runtime, erased, erasedOrder, erased.ny)).toMatchObject({ code: "destination_evidence_unavailable" });
  expect(await data(owner, "SELECT selection, service FROM public.commerce_destination_v2_order_bindings WHERE order_id=$1",
    [erasedOrder.order])).toEqual([{ selection: null, service: null }]);
  expect(await effects(owner, erased)).toStrictEqual(beforeErased);

  const ambiguous = await subject(store), ambiguousCycle = await bookCycle(owner, ambiguous);
  await activate(owner, ambiguous.ctx, await insertDestinationOrder(owner, ambiguous.ctx));
  const beforeAmbiguous = await effects(owner, ambiguous);
  await expect(ownerTransaction(owner, async db => {
    const target = await prepareGraph(db, ambiguous, ambiguous.ny, ambiguousCycle);
    await bind(db, ambiguous.ctx, target.order, ambiguous.ny);
  })).rejects.toMatchObject(unavailable());
  expect(await effects(owner, ambiguous)).toStrictEqual(beforeAmbiguous);
});

it.each(["edit", "writer"] as const)("serializes direct writer contention on the subscription when %s wins", async winner => {
  const { owner, runtime } = store;
  const f = await subject(store), target = await stagePreparation(owner, f);
  const before = await effects(owner, f);
  const editor = await owner.connect(), writer = await owner.connect();
  try {
    const begin = "BEGIN; SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='10s'";
    await Promise.all([editor.query(begin), writer.query(begin)]);
    if (winner === "edit") {
      const wait = await waitFor(owner, writer, editor);
      const ca = await edit(editor, f.ctx, f.ny.selectionRevision);
      expect(ca.outcome).toBe("applied_from_next_parcel");
      const handled = bind(writer, f.ctx, target.order, f.ny).catch((error: unknown) => error);
      await wait();
      await editor.query("COMMIT");
      expect(await handled).toMatchObject(stale("destination.snapshotRef"));
      await writer.query("ROLLBACK");
      expect(await effects(owner, f)).toStrictEqual(before);
      expect(await readSnapshot(runtime, f.ctx, ca.binding, f.ctx.scopeRef, "subscription"))
        .toMatchObject({ binding: ca.binding, document: { address: { subdivision: "CA" } } });
    } else {
      const wait = await waitFor(owner, editor, writer);
      expect(await bind(writer, f.ctx, target.order, f.ny)).toStrictEqual(f.ny.binding);
      const editing = edit(editor, f.ctx, f.ny.selectionRevision).catch((error: unknown) => error);
      await wait();
      // Make the fixture's reserved operation own the next parcel while the edit is waiting.
      await writer.query("UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1", [f.ctx.scopeRef, AT]);
      await writer.query("COMMIT");
      expect(await editing).toMatchObject({ code: "payment_blocked", field: "subscriptionId" });
      await editor.query("COMMIT");
      expect(await retained(runtime, f, target, f.ny)).toMatchObject({ binding: f.ny.binding });
      expect(await data(owner, "SELECT 1 FROM public.subscription_destination_v2_selections WHERE subscription_id=$1",
        [f.ctx.scopeRef])).toEqual([]);
    }
  } finally {
    await Promise.all([editor.query("ROLLBACK"), writer.query("ROLLBACK")]);
    editor.release();
    writer.release();
  }
});
