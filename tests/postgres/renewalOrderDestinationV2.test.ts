import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createPostgresDestinationPortV2 } from "@openlup/platform/commerce/server/destinations";
import { createPostgresPrivacyStore } from "@openlup/platform/identity";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { composeNativePrivacy } from "../../server/runtime/auth/privacyBinding.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { installAccountMutations } from "./customerAccountMutations.fixture.js";
import { insertDestinationOrder, readSnapshot } from "./destinationDocumentFixture.js";
import { backendPid } from "./destinationReceiptFixture.js";
import {
  activate, bind, bookCycle, checkoutSignature, edit, insertLocalAttempt, ownerTransaction, prepareGraph,
  registerName, registerSignature, seedShipment, subject, type Destination, type Subject, type Target,
} from "./renewalOrderDestinationV2.fixture.js";
import { AT, call, type Db } from "./subscriptionNativeFixture.js";

const resources = storeJourneyResources({ isolatedCluster: true });
let store: JourneyInstallation;
const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (manifest?.schemaVersion !== 3) throw new Error("Complete native catalogue required");
const migration = manifest.forward.find(entry => entry.file.endsWith("_renewal_order_destination_v2.sql"));
if (!migration) throw new Error("Renewal destination migration missing");

beforeAll(async () => { store = await resources.installation("renewal-destination"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

const data = async (db: Db, sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows;
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
const malformedRequestPins = (selected: Destination) => [
  [{ ...selected, selectionRevision: null }, "destination"],
  [{ ...selected, service: { ...selected.service, adapterRevision: "" } }, "selectedDelivery"],
] as const;

async function invariant(db: Db, f: Subject) {
  return data(db, `SELECT
    (SELECT array_agg(row_to_json(c)::text ORDER BY id) FROM public.subscription_cycles c WHERE subscription_id=$1) AS cycles,
    (SELECT array_agg(row_to_json(a)::text ORDER BY id) FROM public.subscription_delivery_alignment_cases a WHERE subscription_id=$1) AS alignment,
    (SELECT row_to_json(s)::text FROM public.subscriptions s WHERE id=$1) AS subscription,
    (SELECT array_agg(row_to_json(o)::text ORDER BY cycle_key) FROM public.subscription_cycle_occurrences o WHERE subscription_id=$1) AS occurrences,
    (SELECT array_agg(row_to_json(s)::text ORDER BY s.id) FROM public.fulfillment_shipments s
      JOIN public.commerce_orders o ON o.id=s.order_id WHERE o.client_id=$2) AS shipments,
    (SELECT array_agg(row_to_json(e)::text ORDER BY observation_event_key) FROM public.subscription_cycle_delivery_evidence e
      WHERE e.obligation_ref=$3) AS evidence,
    (SELECT array_agg(row_to_json(x)::text ORDER BY obligation_ref) FROM public.subscription_cycle_delivery_assignments x
      JOIN public.subscription_cycle_occurrences o ON o.cycle_key=x.assigned_cycle_key WHERE o.subscription_id=$1) AS obligations`,
  [f.ctx.scopeRef, f.ctx.clientId, f.origin]);
}

async function assignedInvariant(db: Db, f: Subject) {
  const state = await invariant(db, f);
  expect(state[0].obligations.map((row: string) => JSON.parse(row))).toEqual([
    { obligation_ref: f.origin, assigned_cycle_key: f.pair.cycle_key, marker_cycle_key: null,
      qualifying_actual_arrival_at: null, applied_due_at: null },
  ]);
  return state;
}

async function effects(db: Db, f: Subject) {
  return data(db, `SELECT
    (SELECT array_agg((o.xmin::text, o.*)::text ORDER BY id) FROM public.commerce_orders o WHERE client_id=$1) AS orders,
    (SELECT array_agg((b.xmin::text, b.*)::text ORDER BY b.order_id) FROM public.commerce_destination_v2_order_bindings b
      JOIN public.commerce_orders o ON o.id=b.order_id WHERE o.client_id=$1) AS destinations,
    (SELECT array_agg((p.xmin::text, p.*)::text ORDER BY preparation_id) FROM public.subscription_cycle_preparations p WHERE cycle_key=$2) AS preparations,
    (SELECT array_agg((b.xmin::text, b.*)::text ORDER BY binding_seq) FROM public.subscription_cycle_tax_bindings b WHERE cycle_key=$2) AS fiscal,
    (SELECT array_agg((i.xmin::text, i.*)::text ORDER BY i.id) FROM public.commerce_settlement_intents i
      JOIN public.commerce_orders o ON o.id=i.order_id WHERE o.client_id=$1) AS intents,
    (SELECT array_agg((a.xmin::text, a.*)::text ORDER BY a.id) FROM public.payment_provider_attempts a
      JOIN public.subscription_cycle_preparations p ON p.payment_attempt_id=a.id WHERE p.cycle_key=$2) AS attempts,
    (SELECT count(*)::int FROM public.subscription_cycle_dispatch_grants g JOIN public.subscription_cycle_preparations p
      ON p.payment_attempt_id=g.payment_attempt_id WHERE p.cycle_key=$2) AS grants,
    (SELECT count(*)::int FROM public.commerce_fulfillment_provider_commands c JOIN public.commerce_orders o
      ON o.id=c.order_id WHERE o.client_id=$1) AS commands`, [f.ctx.clientId, f.pair.cycle_key]);
}

async function expectBindRefused(db: PoolClient, f: Subject, target: Target, refusal: Record<string, string>, reason: string,
  selected: Parameters<typeof bind>[3] = f.ny) {
  const before = await effects(db, f);
  await db.query("SAVEPOINT writer_call");
  await expect(bind(db, f.ctx, target.order, selected), reason).rejects.toMatchObject(refusal);
  await db.query("ROLLBACK TO SAVEPOINT writer_call; RELEASE SAVEPOINT writer_call");
  expect(await effects(db, f), reason).toStrictEqual(before);
}

async function prepare(db: PoolClient, f: Subject, selected: Destination, cycle: string, predecessor?: Target) {
  const target = await prepareGraph(db, f, selected, cycle, predecessor);
  expect(await bind(db, f.ctx, target.order, selected)).toStrictEqual(selected.binding);
  await insertLocalAttempt(db, f, target);
  return target;
}

async function stagePreparation(owner: Pool, f: Subject, selected = f.ny) {
  const cycle = await bookCycle(owner, f);
  return ownerTransaction(owner, async db => {
    const target = await prepareGraph(db, f, selected, cycle);
    // Satisfy the deferred payment references so the writer can run in a fresh transaction.
    await insertLocalAttempt(db, f, target);
    return target;
  });
}

async function noReplacementConfirmation(db: PoolClient) {
  expect(await data(db, `SELECT calls FROM pg_stat_xact_user_functions
    WHERE schemaname='public' AND funcname='subscription_delivery_alignment_confirm_replacement'`)).toEqual([]);
}

async function waitFor(observer: Db, waiting: PoolClient, blocker: PoolClient, relation = "subscriptions") {
  const [pid, blocking] = await Promise.all([backendPid(waiting), backendPid(blocker)]);
  return async () => expect.poll(async () => (await data(observer,
    `SELECT $2::int=ANY(pg_blocking_pids($1)) AND EXISTS (
      SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='tuple' AND relation=('public.' || $3)::regclass
    ) AS blocked`, [pid, blocking, relation]))[0]?.blocked, { timeout: 4_000 }).toBe(true);
}

it("upgrades in place with byte-identical checkout export and retained reads, including a cycle without acquisition activation", async () => {
  const prefix = structuredClone(manifest);
  for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) {
    const index = plan.forward.findIndex(entry => entry.file === migration.file);
    expect(index).toBeGreaterThan(0);
    plan.forward.splice(index);
  }
  const predecessorPin = "74fe3c59f86dc91724e0abd9c70264a7995cbd225cf92b5f6265fda3a99720f8";
  prefix.qualified.objectInventorySha256.bootstrapMigrator.withRestore = predecessorPin;
  const previousUnits = [prefix.qualified.baseline, ...prefix.qualified.forward].map(unit => unit.file);
  const suffix = manifest.qualified.forward.slice(prefix.qualified.forward.length).map(unit => unit.file);
  const predecessorRoutines = [checkoutSignature.split("(")[0]!.slice("public.".length),
    "commerce_destination_v2_check_retained", "commerce_destination_v2_export", "commerce_destination_v2_erase",
    "subscription_destination_v2_current", "subscription_destination_v2_read", "fulfillment_ensure_paid_handoff",
    "fulfillment_destination_contact_v2", "fulfillment_freeze_destination_contact_v2", "fulfillment_capture_parcel_contact",
    "fulfillment_capture_order_contact_for_shipment", "fulfillment_resolve_parcel_contact"];
  const definitions = (db: Db) => data(db, `SELECT proname::text, pg_get_functiondef(oid) AS definition, proacl, proowner, proconfig
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[]) ORDER BY oid`, [predecessorRoutines]);
  await withPlatformCatalog(prefix, async root => {
    const installation = await installAccountMutations("bootstrap", true, "renewal-destination-upgrade", root, process.cwd());
    try {
      expect(installation.inventory).toBe(predecessorPin);
      const previous = await definitions(installation.owner);
      expect(new Set(previous.map(row => row.proname))).toEqual(new Set(predecessorRoutines));
      const acquired = await subject(installation), historical = await subject(installation);
      expect((await installation.owner.query("DELETE FROM public.subscription_activations WHERE order_id=$1", [historical.origin])).rowCount).toBe(1);
      expect(await data(installation.owner, `SELECT o.subscription_cycle_id IS NOT NULL AS cycle,
        NOT EXISTS (SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id) AS no_activation,
        public.commerce_destination_v2_valid_pins(b.selection,b.service,d.scope_ref) AS valid,
        (public.commerce_destination_v2_check_document(d,'orderId')->>'verified')::boolean AS verified
        FROM public.commerce_orders o JOIN public.commerce_destination_v2_order_bindings b ON b.order_id=o.id
        JOIN public.commerce_destination_v2_documents d USING (snapshot_ref) WHERE o.id=$1`, [historical.origin]))
        .toEqual([{ cycle: true, no_activation: true, valid: true, verified: true }]);
      const checkoutBytes = (f: Subject) => data(installation.runtime, `SELECT
        convert_to(public.commerce_destination_v2_export($1)::text,'UTF8') AS exported,
        convert_to(public.commerce_read_destination_v2($2,'order',$3,$4)::text,'UTF8') AS retained,
        convert_to(public.commerce_read_destination_v2($2,'order',$3,$4::jsonb || '{"policyRevision":"old"}')::text,'UTF8') AS mismatch`,
      [f.ctx.clientId, f.checkout, f.origin, f.ny.binding]);
      const subjects = [acquired, historical];
      const before = await Promise.all(subjects.map(checkoutBytes));
      for (const [index, f] of subjects.entries()) {
        const [{ exported, retained, mismatch }] = before[index]!;
        expect(JSON.parse(exported.toString("utf8"))).toEqual([expect.objectContaining({
          document: expect.any(Object), orderBindings: [expect.objectContaining({ orderId: f.origin })],
        })]);
        expect(JSON.parse(retained.toString("utf8"))).toMatchObject({ binding: f.ny.binding });
        expect(JSON.parse(mismatch.toString("utf8"))).toMatchObject({ code: "destination_version_changed", field: "destination.policyRevision" });
      }
      const status = await installation.runner.status();
      expect(status.applied).toStrictEqual(previousUnits);
      expect(status.pending[0]).toBe(migration.file);
      expect(status.pending).toStrictEqual(suffix);
      expect(await installation.runner.apply()).toStrictEqual({ applied: suffix });
      expect(installation.inventory).toBe(manifest.qualified.objectInventorySha256.bootstrapMigrator.withRestore);
      expect(await definitions(installation.owner)).toStrictEqual(previous);
      expect(await Promise.all(subjects.map(checkoutBytes))).toStrictEqual(before);
    } finally {
      await installation.close();
    }
  });
}, postgresSetupTimeoutMs);

it("keeps the private destination writer dormant and both routines owner-only under permissive defaults", async () => {
  const { owner, runtime } = store;
  const classifier = "classify_order_destination";
  const signatures = [registerSignature, `public.${classifier}(uuid,public.commerce_destination_v2_documents,text)`];
  const routines = [[registerName, Array<null>(6).fill(null)], [classifier, [null, null, null]]] as const;
  const census = `SELECT p.provolatile, p.prosecdef, p.proconfig, p.proowner = t.relowner AS owned,
      ARRAY(SELECT privilege_type FROM aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) WHERE grantee <> p.proowner) AS grants
    FROM pg_proc p, pg_class t WHERE p.oid=$1::regprocedure AND t.oid='public.subscription_cycle_preparations'::regclass`;
  async function checkAcl(db: Db) {
    for (const [index, signature] of signatures.entries()) {
      expect(await data(db, census, [signature])).toEqual([{ provolatile: index ? "s" : "v", prosecdef: false,
        proconfig: ["search_path=pg_catalog, pg_temp"], owned: true, grants: [] }]);
    }
  }
  await checkAcl(owner);
  for (const [name, args] of routines) await expect(call(runtime, name, [...args])).rejects.toMatchObject({ code: "42501" });
  await expect(call(owner, registerName, Array<null>(6).fill(null))).rejects.toMatchObject({
    code: "22023", message: "address_invalid_input", detail: "subscriptionId", hint: "Correct the indicated input.",
  });
  expect(await call(owner, classifier, [null, null, null])).toMatchObject({ code: "destination_binding_invalid" });
  expect(await data(owner, `SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.oid <> $1::regprocedure
    AND (strpos(lower(p.prosrc), $2) > 0 OR EXISTS (SELECT 1 FROM pg_depend d
      WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_proc'::regclass AND d.refobjid=$1::regprocedure))`,
  [registerSignature, registerName])).toEqual([]);
  for (const root of ["server", "src", ...readdirSync("packages").map(name => `packages/${name}/src`)].filter(existsSync)) {
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" }).filter(file => /\.[cm]?[jt]sx?$/u.test(file))) {
      expect(readFileSync(`${root}/${file}`, "utf8").toLowerCase().includes(registerName), `${root}/${file}`).toBe(false);
    }
  }
  const definitions = new Map((await data(owner, `SELECT proname, string_agg(prosrc, ' ') AS body FROM pg_proc
    WHERE pronamespace='public'::regnamespace GROUP BY proname`)).map(({ proname, body }) => [proname, body]));
  const retainedRead = "commerce_destination_v2_read_retained";
  expect([...definitions].filter(([, body]) => body.includes(classifier)).map(([name]) => name).sort())
    .toEqual([registerName, retainedRead].sort());
  expect(definitions.get(registerName)).toContain(`${classifier}(p_order_id, v_document, 'prepare')`);
  expect(definitions.get(registerName)).toContain(`${classifier}(v_origin.order_id, v_document, 'acquisition')`);
  expect(definitions.get(retainedRead)).toContain(`${classifier}(v_bound.order_id, v_row, 'retained')`);
  expect(definitions.get(retainedRead)).not.toMatch(/selection\s*->>?\s*'kind'/u);
  expect(definitions.get("commerce_read_destination_v2")).toContain(retainedRead);
  await ownerTransaction(owner, async db => {
    const roles = (await data(db, `SELECT rolname::text AS role FROM pg_roles
      WHERE NOT rolsuper AND rolname !~ '^pg_' ORDER BY role`)).map(({ role }) => role as string);
    expect(roles).toEqual(expect.arrayContaining(["anon", "authenticated", "service_role", "transfer_runtime", "transfer_restore"]));
    await db.query(`DROP FUNCTION ${signatures.join(", ")};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      CREATE FUNCTION public.destination_default_acl_control() RETURNS boolean LANGUAGE sql AS 'SELECT true'`);
    expect(await data(db, `SELECT grantee::regrole::text AS role FROM pg_proc p, aclexplode(p.proacl)
      WHERE p.oid='public.destination_default_acl_control()'::regprocedure AND grantee NOT IN (0,p.proowner) ORDER BY role`))
      .toEqual(["anon", "authenticated", "service_role"].map(role => ({ role })));
    await db.query(readFileSync(migration.file, "utf8"));
    await checkAcl(db);
    for (const role of roles) for (const [name, args] of routines) {
      await db.query(`SAVEPOINT permission_check; SET LOCAL ROLE ${db.escapeIdentifier(role)}`);
      await expect(call(db, name, [...args]), role).rejects.toMatchObject({ code: "42501" });
      await db.query("ROLLBACK TO SAVEPOINT permission_check; RELEASE SAVEPOINT permission_check");
    }
  }, false);
});

it("reads the checkout and frozen inherited and explicit renewal destinations through the installed port", async () => {
  const { owner, runtime } = store, f = await subject(store);
  const port = createPostgresDestinationPortV2(runtime);
  const checkout = await port.read(f.checkout, "snapshot", f.ny.binding.snapshotRef, f.ny.binding);
  expect(checkout).toMatchObject({ binding: f.ny.binding, document: { address: { subdivision: "NY" } },
    evidenceExpiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/u) });
  expect(checkout).not.toHaveProperty("documentPurpose");

  expect(await port.read(f.ctx, "subscription", f.ctx.scopeRef, f.ny.binding)).toMatchObject({ binding: f.ny.binding, evidenceExpiresAt: null });
  expect(await port.recheck(f.ctx, { kind: "subscription", scopeRef: f.ctx.scopeRef, expectedSelectionRevision: f.ny.selectionRevision,
    expectedBinding: f.ny.binding, expectedService: f.ny.service })).toMatchObject({ binding: f.ny.binding });
  const booked = await bookCycle(owner, f), before = await assignedInvariant(owner, f);
  const east = await ownerTransaction(owner, async db => {
    await db.query("SET LOCAL track_functions='pl'");
    const target = await prepare(db, f, f.ny, booked);
    await noReplacementConfirmation(db);
    return target;
  });
  expect(await invariant(owner, f)).toStrictEqual(before);
  expect(await edit(owner, f.ctx, f.ny.selectionRevision)).toMatchObject({ outcome: "applied_from_next_parcel" });

  const replacing = await subject(store);
  const originalCycle = await bookCycle(owner, replacing);
  const original = await ownerTransaction(owner, db => prepare(db, replacing, replacing.ny, originalCycle));
  const originalRows = (await effects(owner, replacing))[0].destinations;
  const westSelection = await edit(owner, replacing.ctx, replacing.ny.selectionRevision);
  expect(await port.read(replacing.ctx, "subscription", replacing.ctx.scopeRef, null)).toMatchObject({ binding: westSelection.binding });
  expect(await port.read(replacing.ctx, "subscription", replacing.ctx.scopeRef, westSelection.binding)).toMatchObject({ evidenceExpiresAt: null });
  expect(await port.read(replacing.ctx, "snapshot", westSelection.binding.snapshotRef, westSelection.binding))
    .toMatchObject({ code: "destination_evidence_unavailable", field: "destination.snapshotRef" });
  const replacementCycle = await bookCycle(owner, replacing), beforeReplacement = await invariant(owner, replacing);
  const west = await ownerTransaction(owner, async db => {
    await db.query("SET LOCAL track_functions='pl'");
    const replacement = await prepare(db, replacing, westSelection, replacementCycle, original);
    await noReplacementConfirmation(db);
    return replacement;
  });
  expect(await invariant(owner, replacing)).toStrictEqual(beforeReplacement);
  expect((await effects(owner, replacing))[0].destinations).toEqual(expect.arrayContaining(originalRows));
  expect(await port.read(replacing.ctx, "order", original.order, replacing.ny.binding)).toStrictEqual(
    await port.read(replacing.checkout, "order", replacing.origin, replacing.ny.binding));
  expect(await edit(owner, replacing.ctx, westSelection.selectionRevision, {
    ...westSelection.service, adapterRevision: "later-adapter",
  })).toMatchObject({ outcome: "applied_from_next_parcel" });
  await call(owner, "commerce_destination_v2_expire", [new Date(), 1000]);
  const frozen = await port.read(replacing.ctx, "order", west.order, westSelection.binding);
  expect(frozen).toMatchObject({
    binding: westSelection.binding, document: { address: { subdivision: "CA" } },
    documentPurpose: "subscription", evidenceExpiresAt: null,
  });

  // Part 1 seeds shipments owner-side. Replace the renewal seeds with installed paid handoff in the follow-up.
  const [checkoutShipment, inheritedShipment, explicitShipment] = await Promise.all(
    [f.origin, east.order, west.order].map(order => seedShipment(owner, order)),
  );
  for (const [subject, ctx, order, shipment, selected, expected, origin] of [
    [f, f.checkout, f.origin, checkoutShipment, f.ny, checkout, "checkout"],
    [f, f.ctx, east.order, inheritedShipment, f.ny, checkout, "renewal"],
    [replacing, replacing.ctx, west.order, explicitShipment, westSelection, frozen, "renewal"],
  ] as const) {
    for (const [kind, id] of [["order", order], ["shipment", shipment]] as const) {
      expect(await port.read(ctx, kind, id, selected.binding)).toStrictEqual(expected);
      for (const [key, value] of Object.entries({ snapshotRef: randomUUID(), destinationDigest: "0".repeat(64), policyRevision: "old" })) {
        const remedy = origin === "checkout" ? "sealed checkout evidence through the authorized order workflow, then repeat the read; never"
          : "retained preparation evidence through the authorized order workflow, then repeat the read. Never";
        expect(await port.read(ctx, kind, id, { ...selected.binding, [key]: value })).toMatchObject({
          code: "destination_version_changed", field: key === "destinationDigest" ? key : `destination.${key}`,
          fix: "Use the binding recorded for the original order.",
          recheck: `Take the order's binding from its ${remedy} reselect for a placed order.`,
        });
      }
    }
    if (origin === "checkout") continue;
    await ownerTransaction(owner, async db => {
      await db.query(`UPDATE public.subscription_cycle_tax_bindings
        SET live_evidence=jsonb_set(live_evidence,'{service,adapterRevision}','"different"') WHERE cycle_key=$1`,
      [subject.pair.cycle_key]);
      const reader = createPostgresDestinationPortV2(db);
      for (const [kind, id] of [["order", order], ["shipment", shipment]] as const) {
        expect(await reader.read(ctx, kind, id, selected.binding)).toMatchObject({
          code: "destination_binding_invalid", field: "orderBindings",
        });
      }
    }, false);
    await ownerTransaction(owner, async db => {
      expect(await data(db, `UPDATE public.commerce_destination_v2_order_bindings b
        SET selection=jsonb_set(jsonb_set(b.selection,'{kind}','"checkout"'),'{scopeRef}',to_jsonb(d.scope_ref))
        FROM public.commerce_destination_v2_documents d WHERE b.order_id=$1 AND d.snapshot_ref=b.snapshot_ref
        RETURNING public.commerce_destination_v2_valid_pins(b.selection,b.service,d.scope_ref) AS valid,
          (public.commerce_destination_v2_check_document(d,'orderId')->>'verified')::boolean AS verified`, [order]))
        .toEqual([{ valid: true, verified: true }]);
      const reader = createPostgresDestinationPortV2(db);
      for (const [kind, id] of [["order", order], ["shipment", shipment]] as const) {
        expect(await reader.read(ctx, kind, id, selected.binding)).toMatchObject({
          code: "destination_binding_invalid", field: "orderBindings",
        });
      }
    }, false);
  }
});

it("preserves outstanding delivery obligations on commit and forced rollback without confirming a replacement", async () => {
  const { owner } = store, f = await subject(store), cycle = await bookCycle(owner, f);
  await seedShipment(owner, f.origin);
  const before = await effects(owner, f), delivery = await assignedInvariant(owner, f);
  await ownerTransaction(owner, async db => {
    await db.query("SET LOCAL track_functions='pl'");
    const target = await prepareGraph(db, f, f.ny, cycle);
    expect(await bind(db, f.ctx, target.order, f.ny)).toStrictEqual(f.ny.binding);
    expect(await data(db, "SELECT 1 FROM public.commerce_destination_v2_order_bindings WHERE order_id=$1", [target.order])).toHaveLength(1);
    expect(await data(db, "SELECT 1 FROM public.payment_provider_attempts WHERE id=$1", [target.attempt])).toEqual([]);
    expect(await invariant(db, f)).toStrictEqual(delivery);
    await noReplacementConfirmation(db);
  }, false);
  expect(await effects(owner, f)).toStrictEqual(before);
  expect(await invariant(owner, f)).toStrictEqual(delivery);
  await ownerTransaction(owner, async db => {
    await db.query("SET LOCAL track_functions='pl'");
    await prepare(db, f, f.ny, cycle);
    await noReplacementConfirmation(db);
  });
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

it("refuses each mismatched live fiscal pin with current destination arguments and leaves rows unchanged", async () => {
  const { owner } = store, f = await subject(store), target = await stagePreparation(owner, f);
  const before = await effects(owner, f), delivery = await invariant(owner, f);
  const mismatches = {
    binding: { ...f.ny.binding, policyRevision: "other-policy" },
    selectionRevision: randomUUID(),
    service: { ...f.ny.service, adapterRevision: "other-adapter" },
  };
  await ownerTransaction(owner, async db => {
    for (const [key, value] of Object.entries(mismatches)) {
      await db.query("SAVEPOINT fiscal_fixture");
      const changed = await db.query(`UPDATE public.subscription_cycle_tax_bindings
        SET live_evidence=jsonb_set(live_evidence,ARRAY[$2::text],$3::jsonb,false) WHERE cycle_key=$1`,
      [f.pair.cycle_key, key, JSON.stringify(value)]);
      expect(changed.rowCount, key).toBe(1);
      await expectBindRefused(db, f, target, unavailable("orderId"), key);
      expect(await invariant(db, f), key).toStrictEqual(delivery);
      await db.query("ROLLBACK TO SAVEPOINT fiscal_fixture; RELEASE SAVEPOINT fiscal_fixture");
    }
    expect(await effects(db, f)).toStrictEqual(before);
    expect(await bind(db, f.ctx, target.order, f.ny)).toStrictEqual(f.ny.binding);
  });
});

it.each(["subscriptions", "commerce_destination_v2_documents"])("checks all four deadlines after the final wait on %s", async relation => {
  const { owner } = store, f = await subject(store), target = await stagePreparation(owner, f);
  expect(await bind(owner, f.ctx, target.order, f.ny)).toStrictEqual(f.ny.binding);
  const blocker = await owner.connect(), writer = await owner.connect();
  try {
    for (const [table, column, key, id] of [
      ["subscription_cycle_generations", "lease_expires_at", "cycle_key", f.pair.cycle_key],
      ["subscription_cycle_stock_holds", "expires_at", "hold_incarnation_id", target.hold],
      ["fulfillment_inventory_reservations", "expires_at", "id", f.reservation],
      ["subscription_cycle_tax_bindings", "expires_at", "cycle_key", f.pair.cycle_key],
    ]) {
      await blocker.query("BEGIN");
      const coordinate = relation === "subscriptions" ? ["id", f.ctx.scopeRef] : ["snapshot_ref", f.ny.binding.snapshotRef];
      await blocker.query(`SELECT 1 FROM public.${relation} WHERE ${coordinate[0]}=$1 FOR UPDATE`, [coordinate[1]]);
      await writer.query("BEGIN; SET LOCAL lock_timeout='8s'; SET LOCAL statement_timeout='10s'");
      const wait = await waitFor(owner, writer, blocker, relation);
      const deadline = `UPDATE public.${table} SET ${column}=$2 WHERE ${key}=$1 RETURNING ${column}::text AS cutoff`;
      const [{ cutoff }] = await data(owner, deadline.replace("$2", "clock_timestamp()+interval '2 seconds'"), [id]);
      const before = await effects(owner, f), delivery = await invariant(owner, f);
      const pending = bind(writer, f.ctx, target.order, f.ny).catch((error: unknown) => error);
      await wait();
      expect(await data(owner, "SELECT clock_timestamp() < $1::timestamptz AS fresh", [cutoff])).toEqual([{ fresh: true }]);
      await blocker.query("SELECT pg_sleep_until($1::timestamptz + interval '10 milliseconds')", [cutoff]);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject(unavailable("orderId"));
      await writer.query("ROLLBACK");
      expect(await effects(owner, f)).toStrictEqual(before);
      expect(await invariant(owner, f)).toStrictEqual(delivery);
      await owner.query(deadline, [id, "2099-01-01T00:00:00Z"]);
    }
  } finally {
    await Promise.all([blocker.query("ROLLBACK"), writer.query("ROLLBACK")]);
    blocker.release();
    writer.release();
  }
}, 25_000);

it("prioritizes superseded acquisition availability over malformed request pins and distinguishes malformed stored pins", async () => {
  const { owner } = store, f = await subject(store), target = await stagePreparation(owner, f);
  expect(await edit(owner, f.ctx, f.ny.selectionRevision)).toMatchObject({ outcome: "applied_from_next_parcel" });
  const before = await effects(owner, f);
  const badPins = malformedRequestPins(f.ny);
  await ownerTransaction(owner, async db => {
    await expectBindRefused(db, f, target, stale("destination.snapshotRef"), "valid prior pins");
    for (const [selected, detail] of badPins) {
      await expectBindRefused(db, f, target, {
        code: "22023", message: "destination_binding_invalid", detail,
      }, `valid prior evidence with malformed ${detail}`, selected);
    }
    for (const [pin, change] of [
      ["selection", "selection=selection-'selectionRevision'"],
      ["service", "service=service-'adapterRevision'"],
      ["corrupt document", null],
    ] as const) {
      await db.query("SAVEPOINT checkout_fixture");
      const updated = change === null
        ? await db.query("UPDATE public.commerce_destination_v2_documents SET document_digest=repeat('1',64) WHERE snapshot_ref=$1", [f.ny.binding.snapshotRef])
        : await db.query(`UPDATE public.commerce_destination_v2_order_bindings SET ${change} WHERE order_id=$1`, [f.origin]);
      expect(updated.rowCount).toBe(1);
      const read = await readSnapshot(db, f.ctx, f.ny.binding, f.ctx.scopeRef, "subscription");
      expect(read).toMatchObject({ outcome: "refused", code: "destination_evidence_unavailable", field: "subscriptionId" });
      for (const selected of [f.ny, ...badPins.map(([selected]) => selected)]) {
        await expectBindRefused(db, f, target, pin === "corrupt document" ? unavailable() : invalidStoredPins, pin, selected);
      }
      await db.query("ROLLBACK TO SAVEPOINT checkout_fixture; RELEASE SAVEPOINT checkout_fixture");
    }
    await db.query("DELETE FROM public.commerce_destination_v2_order_bindings WHERE order_id=$1", [f.origin]);
    await expectBindRefused(db, f, target, unavailable(), "missing acquisition binding");
  }, false);
  expect(await effects(owner, f)).toStrictEqual(before);
});

it("refuses a renewal as an acquisition origin even with a verified checkout document and valid checkout pins", async () => {
  const { owner } = store, f = await subject(store), target = await stagePreparation(owner, f);
  await ownerTransaction(owner, async db => {
    const impostor = await insertDestinationOrder(db, f.ctx);
    await db.query(`UPDATE public.commerce_orders SET renewal_operation_id=$2,renewal_operation_fingerprint=$3 WHERE id=$1`,
      [impostor, f.pair.operation_id, f.root.fingerprint]);
    await db.query(`INSERT INTO public.commerce_destination_v2_order_bindings(order_id,snapshot_ref,selection,service)
      SELECT $1,snapshot_ref,selection,service FROM public.commerce_destination_v2_order_bindings WHERE order_id=$2`,
    [impostor, f.origin]);
    await db.query("UPDATE public.subscription_activations SET order_id=$1 WHERE order_id=$2", [impostor, f.origin]);
    expect(await call(db, "subscription_destination_v2_read", [f.ctx, f.ctx.scopeRef, f.ny.binding, f.ny.selectionRevision, f.ny.service, true]))
      .toMatchObject({ binding: f.ny.binding });
    await expectBindRefused(db, f, target, unavailable(), "renewal presented as inherited acquisition");
    expect(await edit(db, f.ctx, f.ny.selectionRevision)).toMatchObject({ outcome: "applied_from_next_parcel" });
    for (const [selected, field] of malformedRequestPins(f.ny)) {
      expect(await call(db, "subscription_destination_v2_read", [f.ctx, f.ctx.scopeRef, selected.binding,
        selected.selectionRevision, selected.service, true])).toMatchObject({ code: "destination_binding_invalid", field });
      await expectBindRefused(db, f, target, unavailable(), `superseded renewal with malformed ${field}`, selected);
    }
    expect(await data(db, "SELECT 1 FROM public.commerce_destination_v2_order_bindings WHERE order_id=$1", [target.order])).toEqual([]);
  }, false);
});

it.each(["inherited", "explicit"])("replays the %s binding with zero writes and refuses a different incumbent", async kind => {
  const { owner } = store, f = await subject(store);
  const selected = kind === "explicit" ? await edit(owner, f.ctx, f.ny.selectionRevision) as Destination : f.ny;
  const target = await stagePreparation(owner, f, selected);
  const original = await bind(owner, f.ctx, target.order, selected);
  expect(original).toStrictEqual(selected.binding);
  const beforeReplay = await effects(owner, f);
  await ownerTransaction(owner, async db => {
    const writeCounts = () => data(db, `SELECT relid, n_tup_ins, n_tup_upd, n_tup_del
      FROM pg_stat_xact_user_tables ORDER BY relid`);
    const beforeWrites = await writeCounts();
    expect(await bind(db, f.ctx, target.order, selected)).toStrictEqual(original);
    expect(await writeCounts()).toStrictEqual(beforeWrites);
  });
  expect(await effects(owner, f)).toStrictEqual(beforeReplay);

  await owner.query("UPDATE public.commerce_destination_v2_order_bindings SET service=$2 WHERE order_id=$1",
    [target.order, { ...selected.service, adapterRevision: "incumbent-adapter" }]);
  const occupied = await effects(owner, f);
  await expect(bind(owner, f.ctx, target.order, selected)).rejects.toMatchObject({
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
  await call(runtime, "commerce_destination_v2_erase", [erased.ctx.clientId]);
  expect(await data(owner, `SELECT evidence_disposition, owner_scope, scope_ref, binding, document_text, document_digest
    FROM public.commerce_destination_v2_documents WHERE snapshot_ref=$1`, [erased.ny.binding.snapshotRef]))
    .toEqual([{ evidence_disposition: "erased", owner_scope: null, scope_ref: null, binding: null, document_text: null, document_digest: null }]);
  expect(await data(owner, "SELECT selection, service FROM public.commerce_destination_v2_order_bindings WHERE order_id=$1",
    [erasedOrder.order])).toEqual([{ selection: null, service: null }]);
  await expect(bind(owner, erased.ctx, erasedOrder.order, erased.ny)).rejects.toMatchObject(unavailable());
  const actor = randomUUID(), id = erased.ctx.clientId;
  await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'privacy-admin@example.invalid')", [actor]);
  await owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES($1,'admin','active','legacy',now())`, [actor]);
  await owner.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [erased.ctx.scopeRef]);
  const { operations } = composeNativePrivacy({ store: createPostgresPrivacyStore(), unitOfWork: { run: work => ownerTransaction(runtime, work) } });
  expect(await operations.erase({ principalId: actor }, { subject: { kind: "contact", contactId: id }, idempotencyKey: randomUUID() }))
    .toMatchObject({ outcome: "ERASED" });
  const beforeErased = await effects(owner, erased);
  await expect(bind(owner, erased.ctx, erasedOrder.order, erased.ny)).rejects.toMatchObject(unavailable());
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
      expect(await readSnapshot(runtime, f.ctx, f.ny.binding, target.order, "order")).toMatchObject({ binding: f.ny.binding });
      expect(await data(owner, "SELECT 1 FROM public.subscription_destination_v2_selections WHERE subscription_id=$1",
        [f.ctx.scopeRef])).toEqual([]);
    }
  } finally {
    await Promise.all([editor.query("ROLLBACK"), writer.query("ROLLBACK")]);
    editor.release();
    writer.release();
  }
});
