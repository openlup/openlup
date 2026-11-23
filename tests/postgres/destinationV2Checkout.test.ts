import type { Pool } from "pg";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { awaitReceiptWait, backendPid, idempotencyConflict, ownerUnlinked, receiptCall } from "./destinationReceiptFixture.js";
import { snapshotCommand, destinationContext, destinationHash, documentTable, readSnapshot, reachDestinationCutoff,
  selectionTable, snapshot } from "./destinationDocumentFixture.js";

const resources = storeJourneyResources();
let store: JourneyInstallation;
beforeAll(async () => { store = await resources.installation("destination-documents"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

const stale = { code: "55000", message: "destination_version_changed", detail: "destination.snapshotRef",
  hint: "Re-obtain current evidence. Checkout requires a fresh final quote and acceptance." };
const unavailable = { code: "55000", message: "destination_evidence_unavailable", detail: "destination.snapshotRef",
  hint: "Re-obtain evidence through the authenticated owner or review the privacy disposition." };
const digestMismatch = (detail: string) => ({ code: "55000", message: "destination_digest_mismatch", detail,
  hint: "Replay the original document and its digest." });
const row = (db: Pool, id: string) => db.query(`SELECT * FROM ${documentTable} WHERE snapshot_ref=$1`, [id]).then(r => r.rows[0]);
const selection = (db: Pool, scope: string) => db.query(`SELECT snapshot_ref, selection_revision FROM ${selectionTable} WHERE scope_ref=$1`, [scope]).then(r => r.rows);
const expire = (pool: Pool, limit: number | null) => pool.query("SELECT public.commerce_destination_v2_expire(clock_timestamp() + interval '30 days',$1) AS count", [limit]).then(r => r.rows[0].count);

it("coordinates exact concurrent snapshot replay before validated policy and preserves the originally issued selection", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), { command } = snapshotCommand(ctx);
  const writer = await runtime.connect(), retry = await runtime.connect();
  let pending: ReturnType<typeof snapshot> | undefined;
  try {
    await writer.query("BEGIN");
    const first = await snapshot(writer, ctx, command);
    const pid = await backendPid(retry);
    pending = snapshot(retry, ctx, { ...command, validated: { policyRevision: "replaced" } });
    void pending.catch(() => undefined);
    await awaitReceiptWait(owner, pid, "advisory", "ExclusiveLock");
    await writer.query("COMMIT");
    expect(await pending).toEqual({ ...first, replayed: true });
    const newIssue = await snapshot(runtime, ctx);
    expect(newIssue.binding.snapshotRef).not.toBe(first.binding.snapshotRef);
    expect(newIssue.selection.selectionRevision).not.toBe(first.selection.selectionRevision);
    expect(newIssue.binding.destinationDigest).toBe(first.binding.destinationDigest);
    expect(await snapshot(runtime, ctx, command)).toEqual({ ...first, replayed: true });
    expect(await selection(owner, ctx.scopeRef)).toEqual([{
      snapshot_ref: newIssue.binding.snapshotRef, selection_revision: newIssue.selection.selectionRevision,
    }]);
    const record = await row(owner, first.binding.snapshotRef);
    expect(record.evidence_expires_at.toISOString()).toBe(first.evidenceExpiresAt);
    expect(record.evidence_expires_at.getTime() - record.issued_at.getTime()).toBe(86_400_000);

    const changed = { ...command, original: { ...command.original, address: { ...command.original.address, line1: "A 😀" } } };
    await expect(snapshot(runtime, ctx, changed)).rejects.toMatchObject(idempotencyConflict);
    await expect(snapshot(runtime, { ...ctx, scopeRef: randomUUID() }, command)).rejects.toMatchObject(ownerUnlinked);
    const guest = { ...ctx, owner: { ...ctx.owner, principalKind: "checkout_session" } };
    await expect(snapshot(runtime, guest)).rejects.toMatchObject(ownerUnlinked);
    const unlinked = { ...ctx, owner: { ...ctx.owner, principalRef: randomUUID() } };
    await expect(snapshot(runtime, unlinked)).rejects.toMatchObject(ownerUnlinked);
    const invalid = snapshotCommand(ctx).command;
    for (const classificationKeys of [["z", "z"], [true], [null]]) {
      await expect(snapshot(runtime, ctx, { ...invalid, validated: { ...invalid.validated, classificationKeys } }))
        .rejects.toMatchObject({ message: "address_invalid_input", detail: "classificationKeys" });
    }
    expect(await receiptCall(runtime, "read", [{ clientId: ctx.clientId, owner: ctx.owner }, invalid.dialect, invalid.requestKey, invalid.requestDigest]))
      .toEqual({ kind: "absent" });
    expect((await snapshot(runtime, ctx, invalid)).replayed).toBe(false);
  } finally {
    await writer.query("ROLLBACK");
    await pending?.catch(() => undefined);
    writer.release(); retry.release();
  }
});

it("verifies the owned document's stored bytes and exact binding without returning repair values", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), other = await destinationContext(owner);
  const { binding, evidenceExpiresAt } = await snapshot(runtime, ctx);
  const id = binding.snapshotRef;
  const stored = await row(owner, id);
  const verified = await readSnapshot(runtime, ctx, binding);
  expect(verified).toEqual({ binding, document: expect.objectContaining({ ...binding, revision: 1, owner: ctx.owner, clientId: ctx.clientId,
    address: { city: "Zélvórë", line1: "A 😀", line2: "2", postalCode: "00-001", country: "XA", subdivision: "XA-01" } }),
    evidenceExpiresAt, documentDigest: destinationHash(stored.document_text) });
  expect(stored.document_text).toBe(canonicalCatalogDraftJson(["commerce.destination.document.v2", verified.document]));
  expect(binding.destinationDigest).toBe("a2882b0f667052364ed70a0287c97661f94d334da944e62e580a6fbd489646f9");
  for (const [context, ref] of [[other, id], [{ ...ctx, scopeRef: randomUUID() }, id], [ctx, randomUUID()]] as const) {
    await expect(readSnapshot(runtime, context, binding, ref)).rejects.toMatchObject(unavailable);
  }
  await expect(readSnapshot(runtime, ctx, binding, id, "order")).rejects.toMatchObject({ message: "destination_dialect_invalid", detail: "version" });
  await expect(readSnapshot(runtime, ctx, { ...binding, snapshotRef: randomUUID() }, id))
    .rejects.toMatchObject({ message: "destination_binding_invalid", detail: "destination" });
  await expect(readSnapshot(runtime, ctx, { ...binding, destinationDigest: "0".repeat(64) })).rejects.toMatchObject(digestMismatch("destinationDigest"));

  const write = (bytes: string, digest: string) => owner.query(`UPDATE ${documentTable} SET document_text=$2,document_digest=$3 WHERE snapshot_ref=$1`,
    [id, bytes, digest]);
  for (const [bytes, hash] of [["invalid JSON", stored.document_digest], [stored.document_text, "0".repeat(64)]]) {
    await write(bytes!, hash!);
    const error = await readSnapshot(runtime, ctx, binding).catch((reason: unknown) => reason);
    expect(error).toMatchObject(digestMismatch("documentDigest"));
    expect(error).not.toHaveProperty("repairValue");
    expect(error).not.toHaveProperty("value");
  }
  const changedOwner = canonicalCatalogDraftJson(["commerce.destination.document.v2", { ...verified.document, owner: other.owner }]);
  await write(changedOwner, destinationHash(changedOwner));
  await expect(readSnapshot(runtime, ctx, binding)).rejects.toMatchObject({ message: "destination_binding_invalid", detail: "destination" });
  const changedAddress = canonicalCatalogDraftJson(["commerce.destination.document.v2", {
    ...verified.document, address: { ...verified.document.address, line2: "Changed" },
  }]);
  await write(changedAddress, destinationHash(changedAddress));
  await expect(readSnapshot(runtime, ctx, binding)).rejects.toMatchObject(digestMismatch("destinationDigest"));
  await write(stored.document_text, stored.document_digest);
  expect(await readSnapshot(runtime, ctx, binding)).toEqual(verified);
  expect(await row(owner, id)).toEqual(stored);
});

it("enforces DB cutoff before cleanup, bounds expiry, and keeps original issue receipts", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), { command } = snapshotCommand(ctx);
  const old = await snapshot(runtime, ctx, command), latest = await snapshot(runtime, ctx);
  const separate = await destinationContext(owner), other = await snapshot(runtime, separate);
  expect(await expire(owner, 1)).toBe(0);
  await expect(expire(runtime, 1)).rejects.toMatchObject({ code: "42501" });
  for (const limit of [null, 0, -1, 1001]) {
    await expect(expire(owner, limit)).rejects.toMatchObject({ message: "address_invalid_input", detail: "limit" });
  }
  await reachDestinationCutoff(owner, old.binding);
  await reachDestinationCutoff(owner, latest.binding);
  await expect(readSnapshot(runtime, ctx, old.binding)).rejects.toMatchObject(stale);
  expect((await row(owner, old.binding.snapshotRef)).document_text).toEqual(expect.any(String));
  expect(await expire(owner, 1)).toBe(1);
  expect(await selection(owner, ctx.scopeRef)).toHaveLength(1);
  expect(await expire(owner, 1000)).toBe(1);
  expect(await selection(owner, ctx.scopeRef)).toEqual([]);
  expect((await row(owner, old.binding.snapshotRef))).toMatchObject({
    document_text: null, document_digest: null, evidence_disposition: "expired", binding: old.binding, owner_scope: ctx.owner,
  });
  await expect(readSnapshot(runtime, ctx, old.binding)).rejects.toMatchObject(stale);
  expect(await snapshot(runtime, ctx, command)).toEqual({ ...old, replayed: true });
  expect(await readSnapshot(runtime, separate, other.binding)).toMatchObject({ binding: other.binding });
  expect(await expire(owner, 1000)).toBe(0);
});

it("grants the restricted runtime only the four installed destination routines", async () => {
  const routines = [
    ["commerce_snapshot_destination_v2(jsonb,jsonb,timestamptz)", true, "v"],
    ["commerce_read_destination_v2(jsonb,text,uuid,jsonb)", true, "s"],
    ["commerce_destination_v2_export(uuid)", true, "s"],
    ["commerce_destination_v2_erase(uuid)", true, "v"],
    ["commerce_destination_v2_canonical(jsonb)", false, "s"],
    ["commerce_destination_v2_expire(timestamptz,integer)", false, "v"],
  ] as const;
  for (const [name, runtime, volatility] of routines) {
    expect((await store.owner.query(`SELECT prosecdef, provolatile, proconfig,
      has_function_privilege('service_role',oid,'EXECUTE') AS service,
      has_function_privilege('anon',oid,'EXECUTE') AS anon,
      has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated
      FROM pg_proc WHERE oid=$1::regprocedure`, [`public.${name}`])).rows)
      .toEqual([{ prosecdef: runtime, provolatile: volatility, proconfig: ["search_path=pg_catalog, pg_temp"],
        service: runtime, anon: false, authenticated: false }]);
  }
});
