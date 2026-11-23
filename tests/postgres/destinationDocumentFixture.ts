import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { expect } from "vitest";
import { receiptClient, receiptDialect } from "./destinationReceiptFixture.js";

export const documentTable = "public.commerce_destination_v2_documents";
export const selectionTable = "public.commerce_destination_v2_checkout_selections";
type Db = Pool | PoolClient;
const uuid = () => randomUUID();
export const destinationHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const originalAddress = { city: "Ze\u0301lvo\u0301rë", line1: " A 😀 ", line2: "2", postalCode: "00-001", countryCode: "xa", subdivisionCode: "xa-01" };
const validatedAddress = { city: "Zélvórë", line1: "A 😀", line2: "2", postalCode: "00-001", countryCode: "XA", subdivisionCode: "XA-01" };
const nativeAddress = { city: "Zélvórë", line1: "A 😀", line2: "2", postalCode: "00-001", country: "XA", subdivision: "XA-01" };
const addressPreimage = ["commerce.destination.v2", nativeAddress];
const golden = "a2882b0f667052364ed70a0287c97661f94d334da944e62e580a6fbd489646f9";

export async function destinationContext(owner: Db, clientId?: string) {
  const id = clientId ?? await receiptClient(owner);
  const principalRef = uuid();
  await owner.query("UPDATE public.clients SET principal_id=$2 WHERE id=$1", [id, principalRef]);
  return { clientId: id, scopeRef: uuid(), owner: { installationRef: "fixture-installation", principalKind: "customer",
    principalRef, customerOrSessionRef: id } };
}
type Context = Awaited<ReturnType<typeof destinationContext>>;
type Binding = { snapshotRef: string; schemaVersion: 2; destinationDigest: string; policyRevision: string };
type Issued = { binding: Binding; selection: { kind: "checkout"; scopeRef: string; selectionRevision: string };
  evidenceExpiresAt: string; eventId: string; replayed: boolean };
export function snapshotCommand(ctx: Context, requestKey = `destination-${uuid()}`) {
  const contact = { recipientName: 'Buyer "😀"\\', deliveryNotes: "Deliver to door" };
  const validated = { address: validatedAddress, contact, classificationKeys: ["declared.one", "second"],
    policyRef: "fixture.policy", policyRevision: "r1" };
  const command = { dialect: receiptDialect, requestKey, purpose: "checkout", scopeRef: ctx.scopeRef,
    original: { address: originalAddress, contact }, validated } as const;
  const preimage = ["commerce.destination.request.v2", { dialect: command.dialect, owner: ctx.owner,
    requestKey, purpose: command.purpose, scopeRef: ctx.scopeRef, original: command.original }];
  return { command: { ...command, requestDigest: destinationHash(canonicalCatalogDraftJson(preimage)) }, preimage };
}
export async function snapshot(db: Db, ctx: Context, command: Record<string, unknown> = snapshotCommand(ctx).command) {
  return (await db.query<{ value: Issued }>("SELECT public.commerce_snapshot_destination_v2($1,$2,clock_timestamp()) AS value",
    [ctx, command])).rows[0]!.value;
}
export async function readSnapshot(db: Db, ctx: Context, binding: Binding, id = binding.snapshotRef, kind = "snapshot") {
  return (await db.query("SELECT public.commerce_read_destination_v2($1,$2,$3,$4) AS value", [ctx, kind, id, binding])).rows[0]!.value;
}
export async function reachDestinationCutoff(owner: Db, binding: Binding) {
  await owner.query(`UPDATE ${documentTable} SET evidence_expires_at=statement_timestamp(), issued_at=statement_timestamp()-interval '24 hours'
    WHERE snapshot_ref=$1`, [binding.snapshotRef]);
}
export async function proveDocumentEncoderParity(owner: Db) {
  const ctx = { clientId: uuid(), scopeRef: uuid(), owner: { installationRef: 'Fixture "α"\\😀', principalKind: "customer",
    principalRef: uuid(), customerOrSessionRef: "fixture" } };
  ctx.owner.customerOrSessionRef = ctx.clientId;
  const { command, preimage } = snapshotCommand(ctx, 'fixture "key"\\😀');
  const binding = { snapshotRef: uuid(), schemaVersion: 2, destinationDigest: golden, policyRevision: command.validated.policyRevision };
  const document = { ...binding, revision: 1, owner: ctx.owner, clientId: ctx.clientId, policyRef: command.validated.policyRef,
    classificationKeys: command.validated.classificationKeys, address: nativeAddress, contact: command.validated.contact };
  const { line2: _line2, subdivision: _subdivision, ...minimal } = nativeAddress;
  for (const [label, vector, digest] of [
    ["address golden", addressPreimage, golden],
    ["full document", ["commerce.destination.document.v2", document], undefined],
    ["minimal document", ["commerce.destination.document.v2", { ...document, address: minimal, contact: {} }], undefined],
    ["original request", preimage, command.requestDigest],
  ] as const) {
    const expected = canonicalCatalogDraftJson(vector);
    const { rows: [row] } = await owner.query("SELECT public.commerce_destination_v2_canonical($1::jsonb) AS bytes",
      [JSON.stringify(vector)]);
    expect(row!.bytes, `${label} PostgreSQL/TypeScript bytes`).toBe(expected);
    expect(destinationHash(row!.bytes), label).toBe(digest ?? destinationHash(expected));
  }
}
