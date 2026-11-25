import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPostgresCustomerSubscriptionSnapshotPort } from "@openlup/platform/account-support";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { createPostgresDestinationPortV2, type DestinationBindingV2, type DestinationContextV2 } from "@openlup/platform/commerce/server/destinations";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { journeyCensus, journeySelection, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { installAccountMutations } from "./customerAccountMutations.fixture.js";
import { bindDestinationOrder, destinationContext, destinationHash, documentTable, insertDestinationOrder, orderBindingTable, reachDestinationCutoff, snapshot, testServicePin } from "./destinationDocumentFixture.js";
import { backendPid, markReceiptClientErased } from "./destinationReceiptFixture.js";

const resources = storeJourneyResources({ isolatedCluster: true });
let store: JourneyInstallation;
beforeAll(async () => { store = await resources.installation("subscription-destination-reads"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

const forward = "db/platform/migrations/20261128060000_subscription_destination_read.sql";
const issuance = "db/platform/migrations/20261127030000_subscription_destination_v2.sql";
const table = "public.subscription_destination_v2_selections";
const rawRead = "SELECT public.commerce_read_destination_v2($1::jsonb,$2::text,$3::uuid,$4::jsonb) AS result";
const rawRecheck = "SELECT public.commerce_recheck_destination_v2($1::jsonb,$2::text,$3::uuid,$4::uuid,$5::jsonb,$6::jsonb) AS result";
const rawEdit = "SELECT public.subscription_change_shipping_destination_v2($1::jsonb,$2::jsonb,clock_timestamp()) AS result";
type Db = Pool | PoolClient;
const result = async (db: Db, sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0]?.result;
const read = (db: Db, ctx: DestinationContextV2, binding: unknown = null) =>
  result(db, rawRead, [ctx, "subscription", ctx.scopeRef, binding]);
const service = testServicePin;
type Pins = { binding: DestinationBindingV2; selectionRevision: string; service: typeof service };

async function subject(owner = store.owner): Promise<DestinationContextV2> {
  const ctx = await destinationContext(owner);
  await owner.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,status,template_version)
    VALUES($1,$2,28,clock_timestamp()+interval '28 days','active',7)`, [ctx.scopeRef, ctx.clientId]);
  return { ...ctx, owner: { ...ctx.owner, principalKind: "customer" } };
}
async function activation(ctx: DestinationContextV2, order: string, clientId = ctx.clientId) {
  return result(store.owner, `INSERT INTO public.subscription_activations
    (order_id,client_id,subscription_id,cadence_days,state,payment_fingerprint,activation_idempotency_key,declare_idempotency_key,activated_at)
    VALUES($1,$2,$3,28,'active',repeat('a',64),$4,$5,clock_timestamp()) RETURNING id AS result`,
  [order, clientId, ctx.scopeRef, randomUUID(), randomUUID()]);
}
async function inherited(ctx: DestinationContextV2) {
  const checkout = { ...ctx, scopeRef: randomUUID() };
  const issued = await snapshot(store.runtime, checkout);
  const order = await bindDestinationOrder(store.owner, checkout, issued);
  const origin = await activation(ctx, order);
  return { checkout, order, origin, pins: { binding: issued.binding, selectionRevision: issued.selection.selectionRevision, service } };
}
async function issueDirect(owner: Db, ctx: DestinationContextV2, revision: string | null = null): Promise<Pins> {
  const original = {
    address: { line1: "Fixture Lane", city: "Example", postalCode: "00000", countryCode: "XA", subdivisionCode: "XA-01" },
    contact: { recipientName: "Fixture", contactPhone: "+0000000" },
  };
  const intent = { dialect: "subscription.destination.change.v2", subscriptionId: ctx.scopeRef,
    expectedTemplateVersion: 7, expectedSelectionRevision: revision, requestKey: randomUUID(), original };
  const applied = await result(owner, rawEdit, [ctx, { ...intent,
    requestDigest: destinationHash(canonicalCatalogDraftJson(["commerce.destination.request.v2", { ...intent, owner: ctx.owner }])),
    validated: { ...original, classificationKeys: ["first", "second"], policyRef: "fixture", policyRevision: "r1" }, service }]);
  expect(applied.outcome).toBe("applied_from_next_parcel");
  return { binding: applied.binding, selectionRevision: applied.selectionRevision, service };
}
const rechecked = (ctx: DestinationContextV2, pins: Pins) => ({ binding: pins.binding, service: pins.service,
  selection: { kind: "subscription", scopeRef: ctx.scopeRef, selectionRevision: pins.selectionRevision } });
const recheck = (db: Db, ctx: DestinationContextV2, pins: Pins) =>
  result(db, rawRecheck, [ctx, "subscription", ctx.scopeRef, pins.selectionRevision, pins.binding, pins.service]);
const unavailable = ["Owned evidence could not be established.", "The operation requires evidence in the authenticated owner scope.",
  "Re-obtain evidence through the authenticated owner.", "Repeat the authorized subscription lookup."];
const absent = ["There is no current authorized selection.", "A retained subscription read requires an issued selection.",
  "Recover through direct address selection on a qualified edit rail.", "Verify the successful selection with the authorized read."];
const stale = ["The current subscription destination coordinates differ.", "The operation requires the current subscription destination coordinates.",
  "Read the current subscription destination with commerce_read_destination_v2 and a null expected binding.",
  "Repeat the operation with the verified current binding and pins."];
const malformed = ["A required input is missing or malformed.", "The destination operation requires valid authored input.",
  "Correct the indicated input.", "Resubmit valid authored input."];
const unlinked = ["Authorized linkage or scope is missing.", "The operation requires a linked customer and authorized scope.",
  "Establish authorized linkage or use authorized support.", "Sign in to the linked account and restart selection."];
const bindingInvalid = ["The supplied tuple is malformed.", "The operation requires an authoritative binding and sealed pins.",
  "Re-obtain authoritative evidence.", "Obtain the original owned tuple."];
const badDigest = ["The supplied digest differs from the verified digest.", "The supplied digest must identify the original document.",
  "Replay the original document and its digest.", "Replay the authentic pair."];
function refusal(actual: unknown, code: string, field: string, [observed, cause, fix, recheck]: string[]) {
  expect(Object.getPrototypeOf(actual)).toBe(Object.prototype);
  expect(actual).toStrictEqual({ outcome: "refused", code, field, observed, cause, fix, recheck });
}
const waitFor = async (owner: Db, waiting: number, blocking: number) => {
  await expect.poll(() => result(owner, "SELECT $2::int=ANY(pg_blocking_pids($1)) AS result", [waiting, blocking]), { timeout: 4_000 }).toBe(true);
};
const unavailableRead = (actual: unknown) => refusal(actual, "destination_evidence_unavailable", "subscriptionId", unavailable);
const absentRead = (actual: unknown) => refusal(actual, "destination_v2_selection_required", "subscriptionId", absent);

it("projects inherited evidence at its issued scope after cutoff and prefers the direct pointer without writes", async () => {
  const { owner, runtime } = store, ctx = await subject(), { checkout, order, pins } = await inherited(ctx);
  await reachDestinationCutoff(owner, pins.binding);
  const port = createPostgresDestinationPortV2(runtime), prior = await port.read(checkout, "order", order, pins.binding);
  if (!("document" in prior)) throw new Error("Expected order evidence");
  const before = await journeyCensus(owner);
  expect(await port.read(ctx, "subscription", ctx.scopeRef, null)).toStrictEqual(pins);
  expect(await port.read(ctx, "subscription", ctx.scopeRef, pins.binding))
    .toStrictEqual({ ...prior, ...rechecked(ctx, pins), evidenceExpiresAt: null });
  expect(await port.recheck(ctx, { kind: "subscription", scopeRef: ctx.scopeRef, expectedBinding: pins.binding,
    expectedSelectionRevision: pins.selectionRevision, expectedService: pins.service })).toStrictEqual(rechecked(ctx, pins));
  expect(await journeyCensus(owner)).toStrictEqual(before);

  const direct = await issueDirect(owner, ctx, pins.selectionRevision);
  const afterIssue = await journeyCensus(owner);
  expect(await read(runtime, ctx)).toStrictEqual(direct);
  expect(await recheck(runtime, ctx, direct)).toStrictEqual(rechecked(ctx, direct));
  expect(await read(runtime, ctx, direct.binding)).toStrictEqual({
    ...rechecked(ctx, direct), evidenceExpiresAt: null, documentDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    document: { ...direct.binding, revision: 1, owner: ctx.owner, clientId: ctx.clientId, policyRef: "fixture",
      address: { line1: "Fixture Lane", city: "Example", postalCode: "00000", country: "XA", subdivision: "XA-01" },
      contact: { recipientName: "Fixture", contactPhone: "+0000000" }, classificationKeys: ["first", "second"] },
  });
  refusal(await read(runtime, ctx, pins.binding), "destination_version_changed", "destination.snapshotRef", stale);
  refusal(await recheck(runtime, ctx, { ...pins, binding: { ...pins.binding, destinationDigest: "f".repeat(64) },
    selectionRevision: randomUUID(), service: { ...service, adapterRevision: "changed" } }),
  "destination_digest_mismatch", "destinationDigest", badDigest);
  for (const [candidate, field] of [
    [{ ...direct, binding: { ...direct.binding, policyRevision: "changed" }, selectionRevision: randomUUID() }, "destination.policyRevision"],
    [{ ...direct, selectionRevision: randomUUID(), service: { ...service, adapterRevision: "changed" } }, "selectionRevision"],
    [{ ...direct, service: { ...service, adapterRevision: "changed" } }, "selectedDelivery"],
  ] as const) refusal(await recheck(runtime, ctx, candidate), "destination_version_changed", field, stale);
  refusal(await result(runtime, rawRead, [ctx, "snapshot", direct.binding.snapshotRef, direct.binding]),
    "destination_evidence_unavailable", "destination.snapshotRef",
    [...unavailable.slice(0, 3), "Use the authorized checkout or order workflow to obtain evidence."]);
  expect(await journeyCensus(owner)).toStrictEqual(afterIssue);
});

it("separates authorized absence from missing, foreign, ambiguous, scrubbed and erased evidence", async () => {
  const { owner, runtime } = store, ctx = await subject(), foreign = await subject();
  absentRead(await read(runtime, ctx));
  const actor = await owner.connect();
  try {
    await actor.query("BEGIN; SET LOCAL ROLE authenticated");
    await actor.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ctx.owner.principalRef })]);
    const actorRead = createPostgresCustomerSubscriptionSnapshotPort({ async rpc(name) {
      expect(name).toBe("customer_subscription_control_snapshot_as_actor");
      return { data: await result(actor, "SELECT public.customer_subscription_control_snapshot_as_actor() AS result"), error: null };
    } });
    expect((await actorRead.getSnapshot())?.subscriptions.find(item => item.subscriptionId === ctx.scopeRef)?.templateVersion).toBe(7);
  } finally { await actor.query("ROLLBACK"); actor.release(); }

  const { order, pins } = await inherited(ctx);
  const foreignEvidence = await issueDirect(owner, foreign);
  const unrelated = await snapshot(runtime, { ...ctx, scopeRef: randomUUID() });
  const before = await journeyCensus(owner);
  unavailableRead(await read(runtime, { ...ctx, scopeRef: randomUUID() }));
  unavailableRead(await read(runtime, { ...foreign, scopeRef: ctx.scopeRef }));
  refusal(await read(runtime, { ...ctx, owner: { ...ctx.owner, principalRef: randomUUID() } }),
    "destination_owner_unlinked", "owner", unlinked);
  for (const prior of [foreignEvidence.binding, unrelated.binding, { ...pins.binding, snapshotRef: randomUUID() }]) {
    unavailableRead(await read(runtime, ctx, prior));
  }
  expect(await journeyCensus(owner)).toStrictEqual(before);

  await owner.query(`UPDATE ${orderBindingTable} SET selection=NULL, service=NULL WHERE order_id=$1`, [order]);
  unavailableRead(await read(runtime, ctx));
  const another = await insertDestinationOrder(owner, ctx);
  await activation(ctx, another);
  unavailableRead(await read(runtime, ctx));

  const erased = await subject(), erasedPins = await issueDirect(owner, erased);
  await markReceiptClientErased(owner, erased.clientId);
  unavailableRead(await read(runtime, erased, erasedPins.binding));
});

it("refuses forbidden keys at each raw JSON level and rejects unavailable stored projections without effects", async () => {
  const { owner, runtime } = store, ctx = await subject(), pins = await issueDirect(owner, ctx);
  const before = await journeyCensus(owner);
  for (const invalid of [{ ...ctx, forbidden: {} }, { ...ctx, owner: { ...ctx.owner, forbidden: {} } }]) {
    refusal(await read(runtime, invalid), "destination_owner_unlinked", "owner", unlinked);
  }
  refusal(await read(runtime, ctx, { ...pins.binding, forbidden: {} }), "destination_binding_invalid", "destination", bindingInvalid);
  refusal(await result(runtime, rawRead, [ctx, "subscription", ctx.scopeRef, "null"]), "destination_binding_invalid", "destination", bindingInvalid);
  refusal(await recheck(runtime, ctx, { ...pins, service: { ...service, forbidden: {} } } as Pins),
    "destination_binding_invalid", "selectedDelivery", bindingInvalid);
  refusal(await result(runtime, rawRead, [ctx, "subscription", null, null]), "address_invalid_input", "subscriptionId", malformed);
  refusal(await createPostgresDestinationPortV2(runtime).read(ctx, "subscription", "uncastable", null),
    "address_invalid_input", "subscriptionId", malformed);
  expect(await journeyCensus(owner)).toStrictEqual(before);

  const verified = await read(runtime, ctx, pins.binding);
  const document = verified.document;
  for (const changed of [
    { ...document, forbidden: {} }, { ...document, owner: { ...document.owner, forbidden: {} } },
    { ...document, address: { ...document.address, forbidden: {} } }, { ...document, contact: { ...document.contact, forbidden: {} } },
    { ...document, classificationKeys: [{ forbidden: {} }] },
  ]) {
    const text = canonicalCatalogDraftJson(["commerce.destination.document.v2", changed]);
    await owner.query(`UPDATE ${documentTable} SET document_text=$2,document_digest=$3 WHERE snapshot_ref=$1`,
      [pins.binding.snapshotRef, text, destinationHash(text)]);
    const stored = await journeyCensus(owner);
    unavailableRead(await read(runtime, ctx, pins.binding));
    expect(await journeyCensus(owner)).toStrictEqual(stored);
  }
  const otherCtx = await subject(), other = await inherited(otherCtx);
  await owner.query(`UPDATE ${orderBindingTable} SET selection=selection||'{"forbidden":{}}'::jsonb WHERE order_id=$1`, [other.order]);
  refusal(await read(runtime, otherCtx),
    "destination_binding_invalid", "orderBindings", [
      "Stored evidence failed verification.", "The stored binding and pins must match the issued evidence and scope.",
      "Send the retained evidence to the destination owner for review.",
      "After authorized resolution recheck retained evidence, or start a fresh selection where available.",
    ]);
});

it("holds the borrowed parent guard and resolves fresh pointers after both acquisition orders", async () => {
  const { owner, runtime } = store, ctx = await subject();
  const reader = await runtime.connect(), writer = await owner.connect();
  try {
    const [r, w] = await Promise.all([backendPid(reader), backendPid(writer)]);
    await reader.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await writer.query("SET statement_timeout='8s'");
    absentRead(await read(reader, ctx));
    const writing = issueDirect(writer, ctx);
    void writing.catch(() => undefined);
    await waitFor(owner, w, r);
    await reader.query("COMMIT");
    const first = await writing;

    await writer.query("BEGIN");
    const second = await issueDirect(writer, ctx, first.selectionRevision);
    const reading = read(reader, ctx);
    void reading.catch(() => undefined);
    await waitFor(owner, r, w);
    await writer.query("COMMIT");
    expect(await reading).toStrictEqual(second);
  } finally {
    await Promise.all([reader, writer].map(async db => {
      try { await db.query("ROLLBACK; RESET statement_timeout"); }
      finally { db.release(); }
    }));
  }
});

it("waits for incumbent renewal registration's order before its activation and rechecks the changed parent", async () => {
  const { owner, runtime } = store, ctx = await subject(), { order, origin, pins } = await inherited(ctx);
  const reader = await runtime.connect(), writer = await owner.connect();
  try {
    const [r, w] = await Promise.all([backendPid(reader), backendPid(writer)]);
    await writer.query("BEGIN; SET LOCAL statement_timeout='8s'");
    await writer.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE", [order]);
    const reading = recheck(reader, ctx, pins);
    void reading.catch(() => undefined);
    await waitFor(owner, r, w);
    await writer.query("SELECT 1 FROM public.subscription_renewal_registration__lock($1)", [order]);
    await writer.query(`UPDATE public.subscription_activations SET subscription_id=NULL,state='compensated',
      activated_at=NULL,payment_fingerprint=NULL,activation_idempotency_key=NULL,compensated_at=clock_timestamp() WHERE id=$1`, [origin]);
    await writer.query("COMMIT");
    unavailableRead(await reading);
    absentRead(await read(reader, ctx));
  } finally {
    await Promise.all([reader, writer].map(async db => {
      try { await db.query("ROLLBACK"); }
      finally { db.release(); }
    }));
  }
});

const slots = JSON.parse(readFileSync("config/reviewed-platform-forwards.json", "utf8")).nativeStoreForwardClass.slots as {
  path: string; createdFunctions: { signature: string }[]; replacedFunctions: { signature: string }[];
}[];
const signatures = (path: string, kind: "createdFunctions" | "replacedFunctions") =>
  slots.find(slot => slot.path === path)![kind].map(entry => entry.signature);
const replacements = signatures(forward, "replacedFunctions");
const created = [issuance, forward].flatMap(path => signatures(path, "createdFunctions"));
const all = [...new Set([...created, ...replacements, ...signatures(issuance, "replacedFunctions")])];
const attrs = async (db: Db, routines: string[]) => (await db.query(`SELECT signature, pg_get_userbyid(proowner) owner,
  prosecdef, provolatile, proconfig, proacl FROM unnest($1::text[]) signature JOIN pg_proc ON oid=signature::regprocedure ORDER BY signature`, [routines])).rows;
const rights = async (db: Db, roles: string[]) => (await db.query(`SELECT role, signature FROM unnest($1::text[]) role
  CROSS JOIN unnest($2::text[]) signature WHERE has_function_privilege(role,signature::regprocedure,'EXECUTE') ORDER BY role,signature`, [roles, all])).rows;
const helperCall = "SELECT public.subscription_destination_v2_read(NULL,NULL,NULL,NULL,NULL,false)";
async function denied(pending: Promise<unknown>, routine: string) {
  const error: unknown = await pending.catch((failure: unknown) => failure);
  expect(Object.getPrototypeOf(error)).toBe(DatabaseError.prototype);
  expect(Reflect.ownKeys(error as object).filter(key => key !== "stack" && key !== "message").sort()).toEqual([
    "code", "column", "constraint", "dataType", "detail", "file", "hint", "internalPosition", "internalQuery", "length",
    "line", "name", "position", "routine", "schema", "severity", "table", "where",
  ]);
  expect(error).toMatchObject({ code: "42501", message: `permission denied for function ${routine}`, detail: undefined, hint: undefined });
}

it("preserves effective attributes, denies private calls and closes function and table ACLs under browser defaults", async () => {
  const { owner, runtime } = store, roles = ["anon", "authenticated", "service_role", journeySelection.runtimeLogin];
  const baseline = await attrs(owner, all), baselineRights = await rights(owner, roles);
  expect(baselineRights.filter(row => created.includes(row.signature))).toEqual([]);
  expect(baseline.find(row => row.signature === signatures(forward, "createdFunctions")[0])).toMatchObject({
    owner: journeySelection.migrationLogin, prosecdef: false, provolatile: "v", proconfig: ["search_path=pg_catalog, pg_temp"],
  });
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query(`SET LOCAL ROLE ${journeySelection.migrationLogin};
      DROP FUNCTION ${created.join(", ")}; DROP TABLE ${table};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;`);
    await db.query(readFileSync(issuance, "utf8"));
    await db.query(readFileSync(forward, "utf8"));
    expect(await attrs(db, all)).toStrictEqual(baseline);
    expect(await rights(db, roles)).toStrictEqual(baselineRights);
    expect(await result(db, "SELECT relrowsecurity AS result FROM pg_class WHERE oid=$1::regclass", [table])).toBe(true);
    expect((await db.query(`SELECT role FROM unnest($1::text[]) role WHERE
      has_table_privilege(role,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_any_column_privilege(role,$2,'SELECT,INSERT,UPDATE,REFERENCES')`, [roles, table])).rows).toEqual([]);
    await db.query("RESET ROLE");
    for (const role of roles) {
      await db.query(`SET LOCAL ROLE ${role}; SAVEPOINT private_call`);
      await denied(db.query(helperCall), "subscription_destination_v2_read");
      await db.query("ROLLBACK TO SAVEPOINT private_call; RELEASE SAVEPOINT private_call; RESET ROLE");
    }
  } finally { await db.query("ROLLBACK"); db.release(); }
  await denied(runtime.query(rawEdit, [null, null]), "subscription_change_shipping_destination_v2");
  await denied(runtime.query(helperCall), "subscription_destination_v2_read");
});

it("upgrades the actual ordered predecessor prefix while keeping read and recheck ACLs and edit denial", async () => {
  const root = mkdtempSync(join(tmpdir(), "subscription-destination-prefix-"));
  try {
    const manifest = readPlatformMigrationManifest(process.cwd());
    if (manifest?.schemaVersion !== 3) throw new Error("Expected a complete platform migration manifest");
    for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
      const boundary = plan.forward.findIndex(unit => unit.file === forward);
      expect(boundary).toBeGreaterThan(0);
      plan.forward = plan.forward.slice(0, boundary);
      for (const unit of [plan.baseline, ...plan.forward]) {
        const target = join(root, unit.file);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(unit.file, target);
      }
    }
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(manifest));
    // Measure this prefix in its own cluster so later inventory changes cannot stale the fixture.
    const db = await installAccountMutations("separate", true, "destination-reads-prefix", root);
    try {
      const prefix = [manifest.qualified.baseline, ...manifest.qualified.forward];
      expect((await db.owner.query("SELECT catalog_path,sha256 FROM public.platform_schema_migrations ORDER BY position")).rows)
        .toStrictEqual(prefix.map(unit => ({ catalog_path: unit.file, sha256: unit.sha256 })));
      const before = await attrs(db.owner, replacements);
      const ctx = await subject(db.owner), pins = await issueDirect(db.owner, ctx);
      await denied(db.runtime.query(rawEdit, [null, null]), "subscription_change_shipping_destination_v2");
      const upgrade = await db.runner.apply();
      expect(upgrade.applied.slice(0, 1)).toStrictEqual([forward]);
      expect(await attrs(db.owner, replacements)).toStrictEqual(before);
      expect(await read(db.runtime, ctx)).toStrictEqual(pins);
      expect(await recheck(db.runtime, ctx, pins)).toStrictEqual(rechecked(ctx, pins));
      await denied(db.runtime.query(rawEdit, [null, null]), "subscription_change_shipping_destination_v2");
      await denied(db.runtime.query(helperCall), "subscription_destination_v2_read");
      expect(await db.runner.apply()).toStrictEqual({ applied: [] });
    } finally { await db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, postgresSetupTimeoutMs);
