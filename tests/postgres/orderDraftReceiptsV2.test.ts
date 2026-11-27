import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { createAccountMutationsTemplate, type AccountMutationsStore, type AccountMutationsTemplate } from "./customerAccountMutations.fixture.js";
import * as destinationFixture from "./destinationDocumentFixture.js";
import { awaitReceiptWait, backendPid } from "./destinationReceiptFixture.js";
import { issue } from "./orderMoneyV2Guards.fixture.js";
import { capture, seedSku, transaction } from "./orderMoneyV2Storage.fixture.js";
import { asciiKey, assertRuntime, commandDigest, expectReceiptError, frame, history, keyOf, lookup, outcome, prepareReceipt, receipts,
  replaceRoutineText, restorePacket, scoped, unicodeKey, unicodeOwner, vectorOwner, writeReceipt } from "./orderDraftReceiptsV2.fixture.js";

const invalidHint = "Supply the documented receipt lookup with an authenticated owner, request key and lowercase SHA-256 command digest.";
const conflictHint = "Replay the original command, or use a new request key for newly accepted work. If the original command still conflicts, recover the receipt through its owner.";
let template: AccountMutationsTemplate;
let store: AccountMutationsStore;
let sku: Awaited<ReturnType<typeof seedSku>>;

beforeAll(async () => {
  template = await createAccountMutationsTemplate("bootstrap", "draft-receipts", undefined, undefined, { isolatedCluster: true });
  store = await template.clone("receipt-reads");
  await assertRuntime(store);
  sku = await seedSku(store.owner);
}, postgresSetupTimeoutMs);
afterAll(() => template?.close(), postgresTeardownTimeoutMs);

function legacyDraft(db: Pool, key: string) {
  const amount = { currency: "XXX", amountMinor: 100 };
  const line = { sku: sku.sku, quantity: 1, unitPriceGross: amount, lineSubtotalGross: amount };
  const context = { mode: "one_time", promoCodes: [] };
  const quote = { contractVersion: "commerce.v0", quote: { currency: "XXX", context, lines: [line], totalGross: amount } };
  const draft = { contractVersion: "commerce.v0", source: "commerce.order_draft.bff.v0", status: "draft",
    paymentStatus: "not_started", currency: "XXX", context, lines: [line], totals: { totalGross: amount } };
  return db.query("SELECT public.commerce_create_order_draft_with_outbox($1,$2,$3,NULL) AS result", [key, quote, draft]);
}

it("replays only the scoped command and original quote facts while legacy and current dependencies change", async () => {
  const a = await prepareReceipt(store, sku);
  const b = await prepareReceipt(store, sku);
  const idA = await transaction(store.owner, db => writeReceipt(db, a.input, a.quote, sku));
  const idB = await transaction(store.owner, db => writeReceipt(db, b.input, b.quote, sku));
  const legacy = await legacyDraft(store.runtime, keyOf(a.input));
  const originalA = outcome(idA, a.quote);
  expect(legacy.rows[0]!.result.orderDraft.orderId).not.toBe(`order_${idA}`);
  expect((await legacyDraft(store.runtime, keyOf(a.input))).rows[0]!.result.orderDraft)
    .toStrictEqual({ ...legacy.rows[0]!.result.orderDraft, replayed: true });
  expect(await scoped(store.runtime, a.input)).toStrictEqual(originalA);
  expect(await scoped(store.runtime, b.input)).toStrictEqual(outcome(idB, b.quote));
  expect(await scoped(store.runtime, lookup(vectorOwner("3")))).toBeNull();
  expect(await scoped(store.runtime, { ...a.input, requestKey: "unknown-request" })).toBeNull();
  expect(await history(store.owner, keyOf(a.input).toUpperCase())).toBeNull();
  expect(await history(store.owner, "f".repeat(64))).toBeNull();

  const changed = { ...a.input, commandDigest: "b".repeat(64) };
  // Temporarily disabled the digest comparison in a disposable database.
  await transaction(store.owner, async db => {
    await replaceRoutineText(db, "public.commerce_read_order_draft_receipt_v2(jsonb)", "customer::uuid, digest)", "customer::uuid, receipt.command_digest)");
    expect(await scoped(db, changed)).toStrictEqual(originalA);
  }, "ROLLBACK");
  await expectReceiptError(scoped(store.runtime, changed),
    "23505", "order_draft_idempotency_conflict", "/requestKey", conflictHint);
  const corrupt = await prepareReceipt(store, sku, randomUUID());
  await transaction(store.owner, db => writeReceipt(db, corrupt.input, corrupt.quote, sku, {
    principal_ref: a.input.owner.principalRef,
  }));
  await expectReceiptError(scoped(store.runtime, corrupt.input), "23505", "order_draft_idempotency_conflict", "/requestKey", conflictHint);
  const wrongParent = await prepareReceipt(store, sku, randomUUID());
  const mismatched = { ...wrongParent.input, owner: a.input.owner, requestKey: randomUUID() };
  await transaction(store.owner, db => writeReceipt(db, mismatched, wrongParent.quote, sku));
  await expectReceiptError(scoped(store.runtime, mismatched), "23505", "order_draft_idempotency_conflict", "/requestKey", conflictHint);

  await destinationFixture.reachDestinationCutoff(store.owner, a.quote.quote.destination);
  await store.owner.query("DELETE FROM public.commerce_destination_v2_checkout_selections WHERE snapshot_ref=$1",
    [a.quote.quote.destination.snapshotRef]);
  await transaction(store.owner, async peer => {
    await peer.query(`LOCK TABLE public.tax_calculations, public.commerce_settlement_intents,
      public.commerce_destination_v2_documents, public.commerce_destination_v2_checkout_selections,
      public.catalog_products IN ACCESS EXCLUSIVE MODE`);
    await peer.query(`SELECT 1 FROM public.${receipts} WHERE order_id=$1 FOR UPDATE`, [idA]);
    await transaction(store.runtime, async reader => {
      await reader.query("SET LOCAL lock_timeout='500ms'");
      expect(await scoped(reader, a.input)).toStrictEqual(originalA);
    });
  });
});

it("enforces the first fixed pointer and measures canonical UTF-8 and UTF-16 at the wire edges", async () => {
  const input = lookup(vectorOwner());
  const invalid: [unknown, string][] = [
    [null, "/"], [[], "/"], [{ ...input, unknown: 1, dialect: [] }, "/"],
    [{ ...input, dialect: false, owner: [] }, "/dialect"], [{ owner: input.owner }, "/dialect"],
    [{ ...input, owner: 1 }, "/owner"], [{ ...input, owner: null }, "/owner"],
    [{ ...input, owner: { ...input.owner, constructor: {} } }, "/owner"],
    [{ ...input, owner: {} }, "/owner/installationRef"],
    [{ ...input, owner: { ...input.owner, installationRef: "" } }, "/owner/installationRef"],
    [{ ...input, owner: { ...input.owner, installationRef: "a".repeat(255) + "𐐷" } }, "/owner/installationRef"],
    [{ ...input, owner: { ...input.owner, principalKind: null, principalRef: 0 } }, "/owner/principalKind"],
    [{ ...input, owner: { ...input.owner, principalRef: input.owner.principalRef.toUpperCase() } }, "/owner/principalRef"],
    [{ ...input, owner: { ...input.owner, principalRef: input.owner.principalRef + "\n" } }, "/owner/principalRef"],
    [{ ...input, owner: { ...input.owner, customerOrSessionRef: [] } }, "/owner/customerOrSessionRef"],
    [{ ...input, requestKey: undefined, commandDigest: false }, "/requestKey"],
    [{ ...input, requestKey: "   1234567  " }, "/requestKey"],
    [{ ...input, requestKey: "😀".repeat(7) }, "/requestKey"],
    [{ ...input, requestKey: "😀".repeat(121) }, "/requestKey"],
    ...[undefined, null, "A".repeat(64), "a".repeat(63), "a".repeat(65), "é".repeat(64)]
      .map((commandDigest): [unknown, string] => [{ ...input, commandDigest }, "/commandDigest"]),
  ];
  const pad = 8192 - Buffer.byteLength(canonicalCatalogDraftJson(input));
  const limit = { ...input, requestKey: " ".repeat(pad) + input.requestKey };
  const overflow = { ...limit, requestKey: limit.requestKey + " " };
  expect(Buffer.byteLength(canonicalCatalogDraftJson(limit))).toBe(8192);
  expect(Buffer.byteLength(canonicalCatalogDraftJson(overflow))).toBe(8193);
  // Temporarily disabled the 8192-byte bound in a disposable database.
  await transaction(store.owner, async db => {
    await replaceRoutineText(db, "public.commerce_read_order_draft_receipt_v2(jsonb)", "> 8192", "> 8193");
    expect(await scoped(db, overflow)).toBeNull();
  }, "ROLLBACK");
  invalid.push([overflow, "/"]);
  for (const [bad, pointer] of invalid) {
    await expectReceiptError(scoped(store.runtime, bad), "22023", "order_draft_receipt_invalid_input", pointer, invalidHint);
  }
  for (const permitted of [limit, { ...input, owner: { ...input.owner, installationRef: "a".repeat(254) + "😀" } },
    ...["12345678", "😀".repeat(8), "😀".repeat(120), "\t1234567", "\u00a01234567", "  12345678    "]
      .map(requestKey => ({ ...input, requestKey }))]) {
    expect(await scoped(store.runtime, permitted)).toBeNull();
  }
  for (const requestKey of ["request-\u0000", "request-\ud800"]) {
    expect(() => canonicalCatalogDraftJson({ ...input, requestKey })).toThrow("draft_json_invalid");
  }
});

it("matches the canonical bytes and hashes, then captures and restores the exact Unicode receipt", async () => {
  const vectors = [
    [lookup(vectorOwner()), "f8484efffc7c4bac2b88023f7e455db623ec5b38182bc2ef1948fe236cac830e"],
    [lookup(vectorOwner("2")), "7edc4b70e973ef05ba408a6c334a47c020d5ed1ca2e78af0de14856bbaafd7c5"],
    [lookup(unicodeOwner, unicodeKey), "df391c5e384616b26985de88196eb6e81e76f11504cb5622bc19eb710d6fd3cf"],
  ] as const;
  for (const [input, key] of vectors) {
    const bytes = Buffer.from(canonicalCatalogDraftJson(frame(input.owner, input.requestKey)));
    const { rows: [sql] } = await store.owner.query(`SELECT convert_to(public.catalog_publication_canonical($1::jsonb,0),'UTF8') AS bytes,
      public.commerce_order_draft_storage_key_v2($2,$3) AS key`, [bytes.toString(), input.owner, input.requestKey]);
    expect(sql!.bytes).toStrictEqual(bytes);
    expect(sql!.key).toBe(key);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(key);
  }
  expect(Buffer.byteLength(canonicalCatalogDraftJson(frame(unicodeOwner, unicodeKey)))).toBe(252);
  const input = vectors[2][0];
  expect(keyOf({ ...input, requestKey: unicodeKey.trim() })).not.toBe(keyOf(input));
  const source = await template.clone("unicode-live-source");
  const target = await template.clone("unicode-live-target");
  const variant = await seedSku(source.owner);
  const contextImpl = destinationFixture.destinationContext;
  await source.owner.query("INSERT INTO public.clients(id,email,lifecycle_stage) VALUES($1,'unicode@example.invalid','customer')",
    [unicodeOwner.customerOrSessionRef]);
  const fixedScope = vi.spyOn(destinationFixture, "destinationContext").mockImplementationOnce(async db => {
    const context = await contextImpl(db, unicodeOwner.customerOrSessionRef);
    await db.query("UPDATE public.clients SET principal_id=$2 WHERE id=$1", [context.clientId, unicodeOwner.principalRef]);
    return { ...context, owner: { ...unicodeOwner, principalRef: unicodeOwner.principalRef as typeof context.owner.principalRef } };
  });
  const evidence = await issue(source, variant, false).finally(() => fixedScope.mockRestore());
  expect(evidence.clientId).toBe(unicodeOwner.customerOrSessionRef);
  const id = await transaction(source.owner, db => writeReceipt(db, input, evidence, variant));
  const original = outcome(id, evidence);
  const packet = await capture(source.owner, source.inventory, "live-receipts");
  expect(packet.requiredPrivacyContributorIds).toContain("order-draft-receipts");
  const attempts: string[] = [];
  const observingOwner = {
    async connect() {
      const db = await target.migrator.connect();
      return {
        query: (sql: string, values?: unknown[]) => {
          const table = /INSERT INTO (?:"public"|public)\."?([a-z0-9_]+)"?/u.exec(sql)?.[1];
          if (table) attempts.push(table);
          return db.query(sql, values);
        },
        release: (destroy?: boolean) => db.release(destroy),
      };
    },
  } as unknown as Pool;
  expect(await restorePacket(target, packet, observingOwner)).toMatchObject({ replayed: false });
  const receiptInsert = attempts.indexOf(receipts);
  expect(receiptInsert).toBeGreaterThan(-1);
  for (const parent of ["commerce_orders", "commerce_destination_v2_order_bindings", "commerce_order_tax_snapshots"]) {
    expect(attempts.indexOf(parent)).toBeGreaterThan(-1);
    expect(attempts.indexOf(parent)).toBeLessThan(receiptInsert);
  }
  const reread = await capture(target.migrator, target.inventory, "restored-live-receipts");
  expect(reread.owned.find(item => item.table === receipts)).toStrictEqual(packet.owned.find(item => item.table === receipts));
  expect(await scoped(target.runtime, input)).toStrictEqual(original);
  expect(await scoped(target.runtime, { ...input, requestKey: unicodeKey.trim() })).toBeNull();
}, postgresSetupTimeoutMs);

const coord = "SELECT pg_advisory_xact_lock(hashtextextended($1,0))";
async function coordinatedRead(isolation: "READ COMMITTED" | "REPEATABLE READ", visibilityFence: boolean) {
  const { input, quote } = await prepareReceipt(store, sku, `${asciiKey}-${randomUUID()}`);
  const key = keyOf(input);
  const winner = await store.owner.connect();
  const loser = await store.runtime.connect();
  const ports = { verifier: vi.fn(), selection: vi.fn(), tax: vi.fn(), payment: vi.fn() };
  const begin = (db: PoolClient) => db.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  let restarted = false;
  try {
    await winner.query("BEGIN");
    await winner.query(coord, [key]);
    const winningId = await writeReceipt(winner, input, quote, sku);
    const xid = (await winner.query("SELECT pg_current_xact_id()::text AS xid")).rows[0]!.xid;
    await begin(loser);
    expect(await scoped(loser, input)).toBeNull();
    const pid = await backendPid(loser);
    const waiting = loser.query(coord, [key]);
    await awaitReceiptWait(store.owner, pid, "advisory", "ExclusiveLock");
    await winner.query("COMMIT");
    await waiting;

    if (isolation === "REPEATABLE READ" && visibilityFence) {
      const visible = (await loser.query("SELECT pg_visible_in_snapshot($1::xid8,pg_current_snapshot()) AS seen", [xid])).rows[0]!.seen;
      expect(visible).toBe(false);
      expect(await scoped(winner, input)).toStrictEqual(outcome(winningId, quote));
      await loser.query("ROLLBACK");
      await begin(loser);
      await loser.query(coord, [key]);
      restarted = true;
    }
    const observed = await scoped(loser, input);
    if (!observed) for (const port of Object.values(ports)) port();
    return { observed, expected: outcome(winningId, quote), restarted, ports };
  } finally {
    await Promise.all([winner.query("ROLLBACK"), loser.query("ROLLBACK")]);
    winner.release();
    loser.release();
  }
}

it.each(["READ COMMITTED", "REPEATABLE READ"] as const)("reads the winner after the key lock at %s", async isolation => {
  // Temporarily disabled the restart after stale visibility in a disposable database.
  if (isolation === "REPEATABLE READ") {
    const stale = await coordinatedRead(isolation, false);
    expect(stale.observed).toBeNull();
    expect(stale.ports.verifier).toHaveBeenCalledOnce();
  }
  const result = await coordinatedRead(isolation, true);
  expect(result.observed).toStrictEqual(result.expected);
  expect(result.restarted).toBe(isolation === "REPEATABLE READ");
  for (const port of Object.values(result.ports)) expect(port).not.toHaveBeenCalled();
});
