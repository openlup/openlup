import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { draftStoreJourney, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { awaitReceiptWait, backendPid, idempotencyConflict, ownerUnlinked, receiptArgs, receiptCall, receiptClient, receiptOutcome,
  receiptTable, type ReceiptArgs } from "./destinationReceiptFixture.js";

const resources = storeJourneyResources();
let store: JourneyInstallation;
const absent = { kind: "absent" };

beforeAll(async () => {
  store = await resources.installation("destination-receipts");
  await store.owner.query("CREATE TABLE public.receipt_fixture_effects (client_id uuid PRIMARY KEY)");
}, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

it("destination_replay_before_validation", async () => {
  const { clientId, orderId } = await draftStoreJourney(store);
  const args = receiptArgs(clientId), outcome = await receiptOutcome(store.owner);
  const [ctx, dialect, key, digest] = args;
  const v1 = () => store.runtime.query("SELECT public.commerce_register_order_destination($1,$2,$3,clock_timestamp()) AS value",
    [key, orderId, { recipientName: "Sample Buyer", line1: "1 Sample Lane", city: "Example", postalCode: "01001", country: "US" }],
  ).then(result => result.rows[0].value);
  const legacy = await v1();
  expect(await receiptCall(store.runtime, "read", args)).toEqual(absent);

  const first = await store.owner.connect(), retry = await store.owner.connect();
  const issue = async (db: PoolClient, fresh: () => Promise<unknown>) => {
    const held = await receiptCall(db, "lock", args);
    if (held.kind === "receipt") return held;
    await fresh();
    return receiptCall(db, "commit", args, outcome);
  };
  let pending: Promise<unknown> | undefined;
  try {
    await first.query("BEGIN");
    const committed = await issue(first, () => first.query("INSERT INTO public.receipt_fixture_effects VALUES($1)", [clientId]));
    expect(committed).toEqual({ kind: "receipt", eventId: expect.any(String), evidenceDisposition: "available", outcome });
    expect(await receiptCall(store.runtime, "read", args)).toEqual(absent);

    await retry.query("BEGIN");
    const pid = await backendPid(retry);
    pending = issue(retry, async () => { throw new Error("An exact replay reached fresh validation"); });
    void pending.catch(() => undefined);
    await awaitReceiptWait(store.owner, pid, "advisory", "ExclusiveLock");
    await first.query("COMMIT");
    expect(await pending).toEqual(committed);
    await retry.query("COMMIT");

    expect(await receiptCall(store.runtime, "read", args)).toEqual(committed);
    expect(await v1()).toEqual(legacy);
    const changed: ReceiptArgs = [ctx, dialect, key, "f".repeat(64)];
    await expect(receiptCall(store.runtime, "read", changed)).rejects.toMatchObject(idempotencyConflict);
    await expect(receiptCall(store.owner, "lock", changed)).rejects.toMatchObject(idempotencyConflict);
    expect(await receiptCall(store.runtime, "read", [{ ...ctx, clientId: await receiptClient(store.owner) }, dialect, key, digest])).toEqual(absent);
    expect(await receiptCall(store.runtime, "read", [{ ...ctx, owner: { ...ctx.owner, principalRef: "other" } }, dialect, key, digest])).toEqual(absent);
    expect((await store.owner.query(`SELECT event_id,event_schema_version,isfinite(created_at) AS finite FROM ${receiptTable} WHERE client_id=$1`, [clientId])).rows)
      .toEqual([{ event_id: (committed as { eventId: string }).eventId, event_schema_version: 1, finite: true }]);
    expect((await store.owner.query("SELECT client_id FROM public.receipt_fixture_effects WHERE client_id=$1", [clientId])).rows)
      .toEqual([{ client_id: clientId }]);

    for (const isolation of ["READ UNCOMMITTED", "REPEATABLE READ", "SERIALIZABLE"]) {
      for (const action of ["lock", "commit"] as const) {
        await retry.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await retry.query("SELECT count(*) FROM public.clients");
        await expect(receiptCall(retry, action, args, outcome)).rejects.toMatchObject({ code: "22023", message: "destination_isolation_unsupported" });
        await retry.query("ROLLBACK");
      }
    }
  } finally {
    await first.query("ROLLBACK");
    await pending?.catch(() => undefined);
    await retry.query("ROLLBACK");
    first.release(); retry.release();
  }
});

it("rolls back the effect with the receipt and allows an exact retry", async () => {
  const clientId = await receiptClient(store.owner);
  const args = receiptArgs(clientId), outcome = await receiptOutcome(store.owner);
  const db = await store.owner.connect();
  try {
    const fresh = async () => {
      await db.query("BEGIN");
      expect(await receiptCall(db, "lock", args)).toEqual(absent);
      await db.query("INSERT INTO public.receipt_fixture_effects VALUES($1)", [clientId]);
      return receiptCall(db, "commit", args, outcome);
    };
    await fresh();
    await db.query("ROLLBACK");
    expect(await receiptCall(store.runtime, "read", args)).toEqual(absent);
    const retried = await fresh();
    await db.query("COMMIT");

    await db.query("BEGIN");
    await db.query("DELETE FROM public.receipt_fixture_effects WHERE client_id=$1", [clientId]);
    await expect(receiptCall(db, "commit", args, outcome)).rejects.toMatchObject(idempotencyConflict);
    await db.query("ROLLBACK");
    expect(await receiptCall(store.runtime, "read", args)).toEqual(retried);
    expect((await db.query("SELECT client_id FROM public.receipt_fixture_effects WHERE client_id=$1", [clientId])).rows)
      .toEqual([{ client_id: clientId }]);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

it("refuses malformed scope, original bytes, and open or oversized successes", async () => {
  const clientId = await receiptClient(store.owner);
  const args = receiptArgs(clientId), outcome = await receiptOutcome(store.owner);
  const [ctx, dialect, , digest] = args;
  for (const owner of [null, { ...ctx.owner, installationRef: "😀".repeat(51) }, { ...ctx.owner, extra: "extra" }]) {
    await expect(store.runtime.query("SELECT public.commerce_destination_v2_receipt_read($1,$2,$3,$4)",
      [{ ...ctx, owner }, dialect, args[2], digest])).rejects.toMatchObject(ownerUnlinked);
  }
  for (const key of ["short", "😀".repeat(46), "key\u0007control", "\u00a0leading-whitespace", "trailing-whitespace\u202f"]) {
    await expect(receiptCall(store.runtime, "read", [ctx, dialect, key, digest])).rejects.toMatchObject({
      code: "22023", message: "address_invalid_input", detail: "idempotencyKey",
    });
  }
  for (const invalid of [
    { ...outcome, eventId: randomUUID() }, { ...outcome, replayed: false },
    { ...outcome, binding: { ...outcome.binding, address: "Synthetic" } },
    { ...outcome, binding: { ...outcome.binding, snapshotRef: "123E4567-E89B-12D3-A456-426614174000" } },
    { ...outcome, binding: { ...outcome.binding, schemaVersion: "2" } },
    // A JavaScript number would serialize 2.0 as 2 before PostgreSQL saw it.
    JSON.stringify(outcome).replace('"schemaVersion":2', '"schemaVersion":2.0'),
    { ...outcome, selection: { ...outcome.selection, kind: "other" } },
    { ...outcome, selection: { ...outcome.selection, scopeRef: "{123e4567-e89b-12d3-a456-426614174000}" } },
    { ...outcome, selection: { ...outcome.selection, selectionRevision: "123e4567e89b12d3a456426614174000" } },
    { ...outcome, evidenceExpiresAt: "infinity" },
    { ...outcome, evidenceExpiresAt: "2026-11-25T00:00:00Z" },
    { ...outcome, evidenceExpiresAt: "2026-11-25T00:00:00.123456Z" },
    { ...outcome, binding: { ...outcome.binding, policyRevision: "😀".repeat(1024) } },
  ]) {
    await expect(receiptCall(store.owner, "commit", args, invalid)).rejects.toMatchObject({
      code: "22023", message: "destination_binding_invalid", detail: "destination",
    });
  }
  expect(await receiptCall(store.runtime, "read", args)).toEqual(absent);
});
