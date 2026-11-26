import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createOrderDraftReceiptsPrivacyContributor, createPersonalDataContributorRegistry, createPostgresPrivacyStore, createPrivacyOperations, PrivacyRefusal, readRequiredPrivacyContributorIds,
  reconcilePostgresPrivacyErasure } from "@openlup/platform/identity";
import { personalDataDocumentSchema, type PrivacySubjectRef } from "@openlup/platform/identity/contracts";
import { readPlatformMigrationManifest, sha256, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { createAccountMutationsTemplate, installAccountMutations, type AccountMutationsStore, type AccountMutationsTemplate } from "./customerAccountMutations.fixture.js";
import { write } from "./orderMoneyV2Guards.fixture.js";
import { capture, expectSqlError, rejected, seedSku, snapshots, transaction } from "./orderMoneyV2Storage.fixture.js";
import { assertRuntime, contributorId, contributorVersion, disposition, expectReceiptError, history, immutableHint, insertReceipt, keyOf,
  obligations, operator, outcome, prepareReceipt, privacy, rawReceipt, receipts, replaceRoutineText, restorePacket, scoped, writeReceipt } from "./orderDraftReceiptsV2.fixture.js";

const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (manifest?.schemaVersion !== 3) throw new Error("Expected the native catalogue");
const first = manifest.forward.find(unit => unit.file.endsWith("_order_draft_receipts_v2.sql"))!;
const second = manifest.forward.find(unit => unit.file.endsWith("_order_draft_receipt_privacy_v2.sql"))!;
const guard = "commerce_order_draft_receipt_v2_immutable";
const evidenceGuard = "commerce_order_draft_receipt_v2_erasure_check";
const marks = "commerce_order_draft_receipt_erasure_marks";
const missingCode = "PRIVACY_CONTRIBUTOR_MISSING";
const incompleteCode = "PRIVACY_RECEIPT_COVERAGE_INCOMPLETE";
const unresolvedCode = "PRIVACY_OWNERSHIP_UNDECLARED";
let template: AccountMutationsTemplate;
let store: AccountMutationsStore;
let sku: Awaited<ReturnType<typeof seedSku>>;

beforeAll(async () => {
  template = await createAccountMutationsTemplate("bootstrap", "draft-receipt-privacy", undefined, undefined, { isolatedCluster: true });
  store = await template.clone("receipt-privacy");
  await assertRuntime(store);
  sku = await seedSku(store.owner);
}, postgresSetupTimeoutMs);
afterAll(() => template?.close(), postgresTeardownTimeoutMs);

const subjectFor = (contactId: string): PrivacySubjectRef => ({ kind: "contact", contactId });
type Db = Pool | PoolClient;
async function exportRows(db: Db, contact: string | null, principal: string | null) {
  return personalDataDocumentSchema.parse((await db.query(
    "SELECT public.commerce_export_order_draft_receipts_v2($1,$2) AS document", [contact, principal])).rows[0]!.document);
}
async function eraseRows(db: Db, contact: string | null, principal: string | null) {
  return (await db.query("SELECT public.commerce_erase_order_draft_receipts_v2($1,$2) AS changed", [contact, principal])).rows[0]!.changed;
}
function expectPrivacyError(error: unknown, code: string, governed = false) {
  expect(Object.getPrototypeOf(error)).toBe(PrivacyRefusal.prototype);
  expect(Reflect.ownKeys(error as object).filter(key => key !== "stack").sort())
    .toStrictEqual(governed ? ["code", "facts", "message", "name"] : ["code", "message", "name"]);
  expect(error).toMatchObject({ code, message: code, name: "PrivacyRefusal" });
}

it("seals the draft projection through mounted erasure, replay and erased restore", async () => {
  const source = await template.clone("receipt-erasure-source");
  const target = await template.clone("receipt-erasure-target");
  const variant = await seedSku(source.owner);
  const actor = await operator(source.owner);
  const { input, quote } = await prepareReceipt(source, variant);
  const id = await transaction(source.owner, db => writeReceipt(db, input, quote, variant));
  const expected = outcome(id, quote), key = keyOf(input);
  const before = await rawReceipt(source.owner, key);
  const mounted = privacy(source.runtime);
  for (const assignment of ["accepted_money_digest=repeat('b',64)", "destination_snapshot_ref=gen_random_uuid()"]) {
    const change = (db: PoolClient) => db.query(`UPDATE public.${snapshots} SET ${assignment} WHERE order_id=$1`, [id]);
    // Temporarily disabled the snapshot child guard in a disposable database.
    await transaction(source.owner, async db => {
      await db.query(`ALTER TABLE public.${snapshots} DISABLE TRIGGER trg_commerce_order_tax_snapshots_money_v2`);
      await change(db);
      expect(await history(db, key)).not.toStrictEqual(expected);
    }, "ROLLBACK");
    expectSqlError(await rejected(transaction(source.owner, change)), "23514", "commerce_order_money_v2_mismatch");
  }
  const subject = subjectFor(quote.clientId);
  const document = (await mounted.operations.export(actor, subject)).documents.find(value => value.contributorId === contributorId);
  expect(document).toStrictEqual(await exportRows(source.runtime, quote.clientId, input.owner.principalRef));
  expect(document?.data).toStrictEqual({ receiptChunks: [[{ orderId: id, installationRef: input.owner.installationRef,
    principalKind: "customer", principalRef: input.owner.principalRef, customerOrSessionRef: quote.clientId, createdAt: before.created_at }]] });
  expect(Object.keys(document!.data as object)).toStrictEqual(["receiptChunks"]);
  expect(document!.coverage.included).toContain("Retained order reference remains linked through the order owner");
  expect(document!.coverage.unavailable).toContain(
    "Derived replay key and command digest withheld. The key can link to a known original owner scope and request key.");

  const erase = { subject, idempotencyKey: randomUUID() };
  const value = await mounted.operations.erase(actor, erase);
  expect(value.outcome).toBe("ERASED");
  expect(value.obligations).toEqual(expect.arrayContaining([...obligations]));
  expect((await source.owner.query(`SELECT contributor_versions->>$2 AS version,dispositions FROM public.identity_privacy_erasures
    WHERE erasure_id=$1`, [value.erasureId, contributorId])).rows).toStrictEqual([{ version: contributorVersion,
    dispositions: expect.arrayContaining([disposition]) }]);
  const erasedBeforeRestore = { ...before, principal_ref: null, customer_or_session_ref: null };
  expect(await rawReceipt(source.owner, key)).toStrictEqual(erasedBeforeRestore);
  expect(await history(source.owner, key)).toStrictEqual(expected);
  const retained = { receiptChunks: [[{ orderId: id, installationRef: input.owner.installationRef,
    principalKind: "customer", createdAt: before.created_at }]] };
  for (const ref of [subject, { kind: "principal" as const, principalId: input.owner.principalRef }]) {
    const exported = (await mounted.operations.export(actor, ref)).documents.find(item => item.contributorId === contributorId);
    expect(exported?.data).toStrictEqual(retained);
    expect(exported?.coverage.complete).toBe(true);
    expect(exported?.obligations).toStrictEqual(obligations);
  }
  expect((await exportRows(source.runtime, randomUUID(), null)).data).toStrictEqual({ receiptChunks: [] });
  expect(await exportRows(source.runtime, quote.clientId, randomUUID())).toMatchObject({
    data: { receiptChunks: [] }, coverage: { complete: false, unavailable: expect.arrayContaining(["Receipt ownership unverified"]) },
  });
  expect(await scoped(source.runtime, input)).toBeNull();
  expect(await scoped(source.runtime, { ...input, owner: { ...input.owner, principalRef: randomUUID() } })).toBeNull();
  expect(await mounted.operations.erase(actor, erase)).toStrictEqual({ ...value, outcome: "ALREADY_ERASED" });

  const packet = await capture(source.owner, source.inventory, "erased-receipt");
  expect(await restorePacket(target, packet)).toMatchObject({ replayed: false });
  const restored = await capture(target.migrator, target.inventory, "restored-erased-receipt");
  expect(restored.owned.find(item => item.table === receipts)).toStrictEqual(packet.owned.find(item => item.table === receipts));
  expect(await rawReceipt(target.owner, key)).toStrictEqual(erasedBeforeRestore);
  expect(await history(target.owner, key)).toStrictEqual(expected);
  expect(await scoped(target.runtime, input)).toBeNull();
  expect(await privacy(target.runtime).operations.erase(actor, erase)).toStrictEqual({ ...value, outcome: "ALREADY_ERASED" });
}, postgresSetupTimeoutMs);

it("mounts safely before the declaration, then requires verified reconciliation for prior coverage", async () => {
  const prefix = structuredClone(manifest);
  for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) plan.forward = plan.forward.slice(0, plan.forward.findIndex(unit => unit.file === first.file));
  prefix.qualified.objectInventorySha256.bootstrapMigrator.withRestore = "568e25fb57b4c9776db35d11b179cb14668aa8ff1d2f334c941dc78927267a83";
  await withPlatformCatalog(prefix, async root => {
    const prior = await installAccountMutations("bootstrap", false, "before-draft-receipts", root);
    try {
      await assertRuntime(prior);
      const variant = await seedSku(prior.owner);
      const actor = await operator(prior.owner);
      const mounted = privacy(prior.runtime);
      const own = mounted.registry.contributors.find(value => value.id === contributorId)!;
      const callbacks = [vi.spyOn(own, "export"), vi.spyOn(own, "prepareErasure"), vi.spyOn(own, "assessErasure"), vi.spyOn(own, "eraseOrRetain")];
      const { input, quote } = await prepareReceipt(prior, variant);
      const { id } = await transaction(prior.owner, db => write(db, quote, variant));
      const subject = subjectFor(quote.clientId);
      expect((await mounted.operations.export(actor, subject)).documents.some(value => value.contributorId === contributorId)).toBe(false);
      const erase = { subject, idempotencyKey: randomUUID() };
      const value = await mounted.operations.erase(actor, erase);
      expect(value.outcome).toBe("ERASED");
      const ledger = () => prior.owner.query(`SELECT to_jsonb(e)::text AS row FROM public.identity_privacy_erasures e WHERE erasure_id=$1`, [value.erasureId]);
      const original = (await ledger()).rows;
      expect(original[0]!.row).not.toContain(contributorId);
      await transaction(prior.owner, async db => {
        await db.query(readFileSync(first.file, "utf8"));
        const between = createPrivacyOperations({ store: mounted.store, registry: mounted.registry,
          unitOfWork: { run: work => work(db) }, now: () => new Date(), randomId: randomUUID });
        expect(await readRequiredPrivacyContributorIds(db)).not.toContain(contributorId);
        expect((await between.export(actor, subject)).documents.some(item => item.contributorId === contributorId)).toBe(false);
        expect((await between.erase(actor, erase)).outcome).toBe("ALREADY_ERASED");
      }, "ROLLBACK");
      for (const callback of callbacks) expect(callback).not.toHaveBeenCalled();

      expect((await prior.runner.apply()).applied.slice(0, 2)).toStrictEqual([first.file, second.file]);
      expect(await readRequiredPrivacyContributorIds(prior.runtime)).toContain(contributorId);
      for (const unit of [first, second]) expect(sha256(readFileSync(unit.file, "utf8"))).toBe(unit.sha256);
      await insertReceipt(prior.owner, input, id);
      expectPrivacyError(await rejected(mounted.operations.erase(actor, erase)), incompleteCode, true);
      const withoutOwner = createPrivacyOperations({ store: mounted.store, unitOfWork: mounted.unitOfWork,
        registry: createPersonalDataContributorRegistry(mounted.registry.contributors.filter(item => item.id !== contributorId),
          { requiredContributorIds: [] }), now: () => new Date(), randomId: randomUUID });
      expectPrivacyError(await rejected(withoutOwner.export(actor, subject)), missingCode, true);
      expectPrivacyError(await rejected(withoutOwner.erase(actor, erase)), missingCode, true);

      const owner = privacy(prior.migrator);
      const approval = { erasure_id: value.erasureId, contributor_id: contributorId, evidence_ref: randomUUID() };
      const unitOfWork = { run: <T>(work: (db: PoolClient) => Promise<T>) => transaction(prior.migrator, async db => {
        await db.query("SAVEPOINT reconciliation");
        const result = await work(db);
        await db.query("RELEASE SAVEPOINT reconciliation");
        return result;
      }) };
      await expect(reconcilePostgresPrivacyErasure({ ...owner, actor, unitOfWork }, approval)).resolves.toStrictEqual(disposition);
      expect(await scoped(prior.runtime, input)).toBeNull();
      expect(await history(prior.owner, keyOf(input))).toStrictEqual(outcome(id, quote));
      expect(await mounted.operations.erase(actor, erase)).toStrictEqual({ ...value, outcome: "ALREADY_ERASED" });
      expect((await ledger()).rows).toStrictEqual(original);
      expect((await prior.owner.query(`SELECT erasure_id, contributor_id, evidence_ref FROM public.identity_privacy_erasure_reconciliations
        WHERE erasure_id=$1`, [value.erasureId])).rows).toStrictEqual([approval]);
    } finally { await prior.close(); }
  });
}, postgresSetupTimeoutMs);

it.each(["contact", "principal"] as const)("reconciles an earlier erasure that recorded only its %s alias", async kind => {
  const actor = await operator(store.owner);
  const fresh = await prepareReceipt(store, sku, randomUUID());
  const id = await transaction(store.owner, db => writeReceipt(db, fresh.input, fresh.quote, sku));
  const { customerOrSessionRef, principalRef } = fresh.input.owner;
  const contact = kind === "contact" ? customerOrSessionRef : null;
  const principal = kind === "principal" ? principalRef : null;
  if (principal) {
    await store.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)",
      [principal, `${principal}@example.invalid`]);
  }
  await store.owner.query("UPDATE public.clients SET principal_id=NULL WHERE id=$1", [customerOrSessionRef]);
  const subject = kind === "contact" ? subjectFor(customerOrSessionRef) : { kind, principalId: principalRef };
  const request = { subject, idempotencyKey: randomUUID() };
  const mounted = privacy(store.runtime);
  // Use the pre-declaration contributor set to produce an earlier erasure with genuine dispositions.
  const historical = createPrivacyOperations({ ...mounted, now: () => new Date(), randomId: randomUUID,
    store: { ...mounted.store, async readRequiredContributorIds(db) {
      return (await readRequiredPrivacyContributorIds(db)).filter(id => id !== contributorId);
    } } });
  const original = await historical.erase(actor, request);
  expect((await store.owner.query("SELECT client_id,principal_id FROM public.identity_privacy_erasures WHERE erasure_id=$1",
    [original.erasureId])).rows).toStrictEqual([{ client_id: contact, principal_id: principal }]);
  const unrelated = await ledgerRow(store.owner, actor.principalId, { customerOrSessionRef: null, principalRef: randomUUID() });
  expectPrivacyError(await rejected(mounted.operations.erase(actor, request)), incompleteCode, true);
  expect(await eraseRows(store.runtime, contact, principal)).toBe(-1);
  const reconcileSql = "SELECT public.commerce_erase_order_draft_receipts_v2($1,$2,$3) AS changed";
  expectSqlError(await rejected(store.runtime.query(reconcileSql, [contact, principal, original.erasureId])),
    "42501", "privacy_reconciliation_owner_required");
  expect((await store.migrator.query(reconcileSql, [contact, principal, unrelated.erasureId])).rows).toStrictEqual([{ changed: -1 }]);
  expect(await scoped(store.runtime, fresh.input)).toStrictEqual(outcome(id, fresh.quote));

  const owner = privacy(store.migrator);
  const registry = createPersonalDataContributorRegistry([createOrderDraftReceiptsPrivacyContributor()], { requiredContributorIds: [contributorId] });
  const approval = { erasure_id: original.erasureId, contributor_id: contributorId, evidence_ref: randomUUID() };
  await expect(reconcilePostgresPrivacyErasure({ ...owner, registry, actor }, approval)).resolves.toStrictEqual(disposition);
  expect(await rawReceipt(store.owner, keyOf(fresh.input))).toMatchObject({ principal_ref: null, customer_or_session_ref: null });
  expect(await mounted.operations.erase(actor, request)).toMatchObject({ erasureId: original.erasureId, outcome: "ALREADY_ERASED" });
  if (kind === "principal") {
    expect((await exportRows(store.runtime, null, principalRef)).coverage).toMatchObject({ complete: false,
      unavailable: expect.arrayContaining(["Retained receipt order references unavailable without a verified contact"]) });
  }
});

it("withholds opposing aliases and verifies both one-coordinate export paths", async () => {
  const [a, b] = [await prepareReceipt(store, sku, randomUUID()), await prepareReceipt(store, sku, randomUUID())];
  const aId = await transaction(store.owner, db => writeReceipt(db, a.input, a.quote, sku,
    { principal_ref: b.input.owner.principalRef }));
  const bId = await transaction(store.owner, db => writeReceipt(db, b.input, b.quote, sku,
    { principal_ref: a.input.owner.principalRef }));
  const actors = await operator(store.owner);
  const mounted = privacy(store.runtime);
  // Temporarily disabled receipt ownership verification in a disposable database.
  await transaction(store.owner, async db => {
    await replaceRoutineText(db, "public.commerce_order_draft_receipt_privacy_matches_v2(uuid,uuid,uuid)",
      "v.agrees AND (p_principal IS NULL OR v.paired),", "true,");
    const unsafe = await exportRows(db, a.input.owner.customerOrSessionRef, a.input.owner.principalRef);
    expect(JSON.stringify(unsafe.data)).toContain(bId);
  }, "ROLLBACK");
  for (const value of [a, b]) {
    const { customerOrSessionRef: contact, principalRef: principal } = value.input.owner;
    for (const [c, p] of [[contact, principal], [contact, null], [null, principal]]) {
      const result = await exportRows(store.runtime, c, p);
      expect(result.data).toStrictEqual({ receiptChunks: [] });
      expect(result.coverage).toMatchObject({ complete: false, unavailable: expect.arrayContaining(["Receipt ownership unverified"]) });
      expect(JSON.stringify(result)).not.toContain(aId);
      expect(JSON.stringify(result)).not.toContain(bId);
      expect(await eraseRows(store.runtime, c, p)).toBe(-1);
    }
    expectPrivacyError(await rejected(mounted.operations.erase(actors,
      { subject: subjectFor(contact), idempotencyKey: randomUUID() })), unresolvedCode);
  }
  expect(await rawReceipt(store.owner, keyOf(a.input))).toMatchObject({ principal_ref: b.input.owner.principalRef });
  expect(await rawReceipt(store.owner, keyOf(b.input))).toMatchObject({ principal_ref: a.input.owner.principalRef });
  expect(await eraseRows(store.runtime, null, null)).toBe(0);

  const clean = await prepareReceipt(store, sku, randomUUID());
  const id = await transaction(store.owner, db => writeReceipt(db, clean.input, clean.quote, sku));
  const { customerOrSessionRef: contact, principalRef: principal } = clean.input.owner;
  const fields = { orderId: id, installationRef: clean.input.owner.installationRef, principalKind: "customer",
    createdAt: (await rawReceipt(store.owner, keyOf(clean.input))).created_at };
  expect((await exportRows(store.runtime, contact, null)).data).toStrictEqual({ receiptChunks: [[{ ...fields, customerOrSessionRef: contact }]] });
  expect((await exportRows(store.runtime, null, principal)).data).toStrictEqual({ receiptChunks: [[{ ...fields, principalRef: principal }]] });
  // A contact can establish the order without an available principal link.
  await store.owner.query("UPDATE public.clients SET principal_id=NULL WHERE id=$1", [contact]);
  const partial = await exportRows(store.runtime, contact, null);
  expect(partial.data).toStrictEqual({ receiptChunks: [[{ ...fields, customerOrSessionRef: contact }]] });
  expect(partial.coverage).toMatchObject({ complete: false,
    unavailable: expect.arrayContaining(["Receipt principal reference unavailable"]) });
  expect((await mounted.operations.export(actors, subjectFor(contact))).documents.find(item => item.contributorId === contributorId))
    .toStrictEqual(partial);
  expect((await exportRows(store.runtime, null, principal)).data).toStrictEqual({ receiptChunks: [] });
  expect(await eraseRows(store.runtime, contact, null)).toBe(-1);
});

const lock = "LOCK TABLE public.identity_privacy_erasures IN SHARE ROW EXCLUSIVE MODE";
async function ledgerRow(db: Db, actor: string, owner: { customerOrSessionRef: string | null; principalRef: string | null }, evidence?: typeof disposition) {
  const erasureId = randomUUID(), idempotencyKey = randomUUID();
  await createPostgresPrivacyStore().saveReceipt(db,
    { contactId: owner.customerOrSessionRef, principalId: owner.principalRef, identity: {} },
    { principalId: actor }, idempotencyKey,
    { version: "identity.erasure.v1", erasureId, completedAt: new Date().toISOString(),
      outcome: "ERASED", obligations: evidence?.obligations ?? [] }, [
      { contributorId: "tax-calculations", version: "commerce.tax-calculations.v1", obligations: [] },
      evidence ?? { contributorId, version: contributorVersion, obligations: [] },
    ]);
  return { erasureId, idempotencyKey };
}

const refusesClear = (work: Promise<unknown>) => expectReceiptError(work, "55000", "order_draft_receipt_immutable", undefined, immutableHint);

it("requires transaction evidence from the runtime and refuses stale, wrong-subject and version-only records", async () => {
  const actor = await operator(store.owner);
  const a = await prepareReceipt(store, sku, randomUUID());
  const id = await transaction(store.owner, db => writeReceipt(db, a.input, a.quote, sku));
  const { customerOrSessionRef: contact, principalRef: principal } = a.input.owner;
  const key = keyOf(a.input), original = await rawReceipt(store.owner, key);
  const runtimeClear = (record?: (db: PoolClient) => Promise<unknown>) => transaction(store.runtime, async db => {
    await db.query(lock);
    expect(await eraseRows(db, contact, principal)).toBe(1);
    await record?.(db);
  });
  // Temporarily disabled the deferred evidence guard in a disposable database.
  await transaction(store.owner, async db => {
    await db.query(`ALTER TABLE public.${receipts} DISABLE TRIGGER ${evidenceGuard}`);
    await db.query(lock);
    await db.query("SET LOCAL ROLE service_role");
    expect(await eraseRows(db, contact, principal)).toBe(1);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.query("RESET ROLE");
    expect(await rawReceipt(db, key)).toMatchObject({ principal_ref: null, customer_or_session_ref: null });
  }, "ROLLBACK");
  await refusesClear(runtimeClear());
  const wrong = await prepareReceipt(store, sku, randomUUID());
  await refusesClear(runtimeClear(db => ledgerRow(db, actor.principalId, wrong.input.owner, disposition)));
  await refusesClear(runtimeClear(db => ledgerRow(db, actor.principalId, a.input.owner)));
  expect(await rawReceipt(store.owner, key)).toStrictEqual(original);

  const versionOnly = await ledgerRow(store.owner, actor.principalId, a.input.owner);
  const mounted = privacy(store.runtime);
  const covered = await mounted.store.findErasureReplay(store.runtime, subjectFor(contact), versionOnly.idempotencyKey);
  expect(covered?.coveredContributorIds).not.toContain(contributorId);
  await store.owner.query("UPDATE public.identity_privacy_erasures SET dispositions=$2 WHERE erasure_id=$1",
    [versionOnly.erasureId, JSON.stringify([disposition])]);
  expect(await eraseRows(store.runtime, contact, principal)).toBe(-1);
  await store.owner.query("INSERT INTO public.identity_privacy_erasure_reconciliations(erasure_id,contributor_id,evidence_ref) VALUES($1,$2,$3)",
    [versionOnly.erasureId, contributorId, randomUUID()]);
  expect(await eraseRows(store.owner, contact, principal)).toBe(-1);
  expect(await rawReceipt(store.owner, key)).toStrictEqual(original);
  expect(await history(store.owner, key)).toStrictEqual(outcome(id, a.quote));
});

it("refuses a direct clear by the granted runtime login even with matching new ledger evidence", async () => {
  const direct = await template.clone("direct-receipt-clear");
  await assertRuntime(direct);
  const actor = await operator(direct.owner);
  const variant = await seedSku(direct.owner);
  const fresh = await prepareReceipt(direct, variant);
  const id = await transaction(direct.owner, db => writeReceipt(db, fresh.input, fresh.quote, variant));
  const key = keyOf(fresh.input), original = await rawReceipt(direct.owner, key);
  const update = `UPDATE public.${receipts} SET principal_ref=NULL, customer_or_session_ref=NULL WHERE order_id=$1`;
  await direct.owner.query(`GRANT SELECT, UPDATE ON public.${receipts} TO service_role;
    CREATE POLICY test_direct_clear ON public.${receipts} TO service_role USING (true)`);
  await refusesClear(transaction(direct.runtime, async db => {
    await db.query(lock);
    await ledgerRow(db, actor.principalId, fresh.input.owner, disposition);
    await db.query(update, [id]);
  }));
  // Temporarily disabled the immediate trigger in this disposable database to exercise the deferred guard directly.
  await direct.owner.query(`ALTER TABLE public.${receipts} DISABLE TRIGGER ${guard}`);
  await refusesClear(transaction(direct.runtime, async db => {
    await db.query(lock);
    const recorded = await ledgerRow(db, actor.principalId, fresh.input.owner, disposition);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('order-draft-receipt-erasure:' || $1::uuid::text, 0))", [recorded.erasureId]);
    expect((await db.query(update, [id])).rowCount).toBe(1);
    await db.query(`SET CONSTRAINTS ${evidenceGuard} IMMEDIATE`);
  }));
  expect(await rawReceipt(direct.owner, key)).toStrictEqual(original);
  expectSqlError(await rejected(direct.runtime.query(`INSERT INTO public.${marks} VALUES (pg_current_xact_id(), $1, NULL)`, [id])),
    "42501", `permission denied for table ${marks}`);
}, postgresSetupTimeoutMs);

it("commits the runtime clear and evidence after releasing their savepoint", async () => {
  const actor = await operator(store.owner);
  const fresh = await prepareReceipt(store, sku, randomUUID());
  await transaction(store.owner, db => writeReceipt(db, fresh.input, fresh.quote, sku));
  const evidence = await transaction(store.runtime, async db => {
    await db.query(lock);
    await db.query("SAVEPOINT evidence");
    expect(await eraseRows(db, fresh.quote.clientId, fresh.input.owner.principalRef)).toBe(1);
    const recorded = await ledgerRow(db, actor.principalId, fresh.input.owner, disposition);
    await db.query("RELEASE SAVEPOINT evidence");
    return recorded;
  });
  expect((await store.owner.query("SELECT erasure_id FROM public.identity_privacy_erasures WHERE erasure_id=$1",
    [evidence.erasureId])).rows).toStrictEqual([{ erasure_id: evidence.erasureId }]);
  expect(await rawReceipt(store.owner, keyOf(fresh.input))).toMatchObject({ principal_ref: null, customer_or_session_ref: null });
  expect((await store.owner.query(`SELECT * FROM public.${marks}`)).rows).toStrictEqual([]);
});

it("preserves both owner references when the clear is rolled back to a savepoint", async () => {
  const fresh = await prepareReceipt(store, sku, randomUUID());
  await transaction(store.owner, db => writeReceipt(db, fresh.input, fresh.quote, sku));
  const key = keyOf(fresh.input), original = await rawReceipt(store.owner, key);
  await transaction(store.runtime, async db => {
    await db.query(lock);
    await db.query("SAVEPOINT clear_receipt");
    expect(await eraseRows(db, fresh.quote.clientId, fresh.input.owner.principalRef)).toBe(1);
    await db.query("ROLLBACK TO SAVEPOINT clear_receipt");
    await db.query("RELEASE SAVEPOINT clear_receipt");
  });
  expect(await rawReceipt(store.owner, key)).toStrictEqual(original);
  expect((await store.owner.query(`SELECT * FROM public.${marks}`)).rows).toStrictEqual([]);
});

it("refuses the clear outside a savepoint when the evidence inside it is rolled back", async () => {
  const actor = await operator(store.owner);
  const fresh = await prepareReceipt(store, sku, randomUUID());
  await transaction(store.owner, db => writeReceipt(db, fresh.input, fresh.quote, sku));
  const key = keyOf(fresh.input), original = await rawReceipt(store.owner, key);
  await refusesClear(transaction(store.runtime, async db => {
    await db.query(lock);
    expect(await eraseRows(db, fresh.quote.clientId, fresh.input.owner.principalRef)).toBe(1);
    await db.query("SAVEPOINT evidence");
    const recorded = await ledgerRow(db, actor.principalId, fresh.input.owner, disposition);
    await db.query("ROLLBACK TO SAVEPOINT evidence");
    await db.query("RELEASE SAVEPOINT evidence");
    expect((await db.query("SELECT erasure_id FROM public.identity_privacy_erasures WHERE erasure_id=$1",
      [recorded.erasureId])).rows).toStrictEqual([]);
  }));
  expect(await rawReceipt(store.owner, key)).toStrictEqual(original);
});

it("returns all verified records across the chunk boundary without using export for erasure", async () => {
  const one = await prepareReceipt(store, sku, randomUUID());
  const id = await transaction(store.owner, db => writeReceipt(db, one.input, one.quote, sku));
  const { customerOrSessionRef: contact, principalRef: principal } = one.input.owner;
  await transaction(store.owner, async db => {
    // Temporarily disabled the accepted-order triggers in a disposable database to generate bounded scan fixtures.
    await db.query(`ALTER TABLE public.commerce_orders DISABLE TRIGGER trg_commerce_orders_line_sum;
      ALTER TABLE public.${snapshots} DISABLE TRIGGER trg_commerce_order_tax_snapshots_money_v2;
      CREATE TEMP TABLE receipt_bulk_source ON COMMIT DROP AS
        SELECT gen_random_uuid() AS order_id,gen_random_uuid() AS calculation_id,gen_random_uuid() AS quote_id FROM generate_series(1,10000)`);
    await db.query(`INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,money_version)
      SELECT b.order_id, o.client_id,o.status,o.currency_code,o.total_amount_minor,o.money_version
      FROM receipt_bulk_source b CROSS JOIN public.commerce_orders o WHERE o.id=$1`, [id]);
    await db.query("INSERT INTO public.tax_calculations(calculation_id,state) SELECT calculation_id,'erased' FROM receipt_bulk_source");
    await db.query(`INSERT INTO public.${snapshots}
      SELECT (jsonb_populate_record(NULL::public.${snapshots}, to_jsonb(s) ||
        jsonb_build_object('order_id',b.order_id,'calculation_id',b.calculation_id,'accepted_quote_id',b.quote_id))).*
      FROM receipt_bulk_source b CROSS JOIN public.${snapshots} s WHERE s.order_id=$1`, [id]);
    await db.query(`INSERT INTO public.${receipts}(storage_key,installation_ref,principal_kind,principal_ref,customer_or_session_ref,command_digest,order_id)
      SELECT encode(sha256(convert_to(order_id::text,'UTF8')),'hex'),'installation-a','customer',$1,$2,repeat('a',64),order_id FROM receipt_bulk_source`, [principal, contact]);
    const result = await exportRows(db, contact, principal);
    const chunks = (result.data as { receiptChunks: Array<Array<{ orderId: string }>> }).receiptChunks;
    expect(chunks.map(chunk => chunk.length)).toStrictEqual([10000, 1]);
    const ordered = (await db.query(`SELECT order_id FROM public.${receipts} WHERE customer_or_session_ref=$1 ORDER BY order_id`, [contact])).rows.map(row => row.order_id);
    expect(chunks.flat().map(item => item.orderId)).toStrictEqual(ordered);

    await db.query("SET LOCAL enable_seqscan=off");
    const explain = (await db.query(`EXPLAIN SELECT order_id FROM public.${receipts}
      WHERE principal_ref=$1 OR customer_or_session_ref=$2`, [principal, contact])).rows.map(row => row["QUERY PLAN"]).join("\n");
    expect(explain).toContain(`${receipts}_principal_idx`);
    expect(explain).toContain(`${receipts}_customer_idx`);
    // Temporarily disabled export materialization in a disposable database.
    await db.query(`CREATE OR REPLACE FUNCTION public.commerce_export_order_draft_receipts_v2(p_contact uuid,p_principal uuid) RETURNS jsonb
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT (1/0)::text::jsonb $$`);
    await db.query(lock);
    expect(await eraseRows(db, contact, principal)).toBe(10001);
  }, "ROLLBACK");
}, postgresSetupTimeoutMs);

it("checks live ACLs and refuses deletion, arbitrary updates, partial clears and re-identification", async () => {
  const actor = await operator(store.owner);
  const { input, quote } = await prepareReceipt(store, sku, randomUUID());
  const id = await transaction(store.owner, db => writeReceipt(db, input, quote, sku));
  const key = keyOf(input);
  expectSqlError(await rejected(store.runtime.query(`SELECT * FROM public.${receipts}`)), "42501", `permission denied for table ${receipts}`);
  expectSqlError(await rejected(history(store.runtime, key)), "42501", "permission denied for function commerce_read_order_draft_receipt_history_v2");
  const refuses = (work: Promise<unknown>) => expectReceiptError(work, "55000", "order_draft_receipt_immutable", undefined, immutableHint);
  const withoutLock = `UPDATE public.${receipts} SET principal_ref=NULL,customer_or_session_ref=NULL WHERE order_id=$1`;
  await refuses(store.owner.query(withoutLock, [id]));
  for (const query of [`DELETE FROM public.${receipts} WHERE order_id=$1`,
    `UPDATE public.${receipts} SET principal_ref=NULL WHERE order_id=$1`,
    `UPDATE public.${receipts} SET installation_ref='other' WHERE order_id=$1`,
    `UPDATE public.${receipts} SET principal_ref=NULL,customer_or_session_ref=NULL,command_digest=repeat('b',64) WHERE order_id=$1`]) {
    await refuses(transaction(store.owner, async db => { await db.query(lock); await db.query(query, [id]); }));
  }
  // Temporarily disabled the immediate guard in a disposable database.
  await transaction(store.owner, async db => {
    await db.query(`ALTER TABLE public.${receipts} DISABLE TRIGGER ${guard}`);
    expect((await db.query(`DELETE FROM public.${receipts} WHERE order_id=$1`, [id])).rowCount).toBe(1);
  }, "ROLLBACK");
  await privacy(store.runtime).operations.erase(actor, { subject: subjectFor(quote.clientId), idempotencyKey: randomUUID() });
  await refuses(transaction(store.owner, async db => { await db.query(lock); await db.query(withoutLock, [id]); }));
  await refuses(transaction(store.owner, async db => {
    await db.query(lock);
    await db.query(`UPDATE public.${receipts} SET principal_ref=$2,customer_or_session_ref=$3 WHERE order_id=$1`,
      [id, input.owner.principalRef, quote.clientId]);
  }));
});
