import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { expect } from "vitest";
// eslint-disable-next-line no-restricted-imports -- exercise the native fence at its private component boundary
import { withCatalogAdmissionFence } from "../../packages/platform/src/catalog/catalogAdmissionFence.js";
// eslint-disable-next-line no-restricted-imports -- verify the private guard sequence without adding an installed export
import { destinationV2Prelock } from "../../packages/platform/src/commerce/server/destinations/destinationV2Prelock.js";
import { receiptClient, receiptDialect } from "./destinationReceiptFixture.js";

export const documentTable = "public.commerce_destination_v2_documents";
export const selectionTable = "public.commerce_destination_v2_checkout_selections";
export const orderBindingTable = "public.commerce_destination_v2_order_bindings";
type Db = Pool | PoolClient;

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

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
  const preimage = snapshotPreimage(ctx, command);
  return { command: { ...command, requestDigest: destinationHash(canonicalCatalogDraftJson(preimage)) }, preimage };
}
export function snapshotPreimage(ctx: Context, command: { dialect: string; requestKey: string; purpose: string; original: object }): unknown[] {
  return ["commerce.destination.request.v2", { dialect: command.dialect, owner: ctx.owner,
    requestKey: command.requestKey, purpose: command.purpose, scopeRef: ctx.scopeRef, original: command.original }];
}
export async function snapshot(db: Db, ctx: Context, command: Record<string, unknown> = snapshotCommand(ctx).command) {
  return (await db.query<{ value: Issued }>("SELECT public.commerce_snapshot_destination_v2($1,$2,clock_timestamp()) AS value",
    [ctx, command])).rows[0]!.value;
}
export async function readSnapshot(db: Db, ctx: Context, binding: Binding, id = binding.snapshotRef, kind = "snapshot") {
  return (await db.query("SELECT public.commerce_read_destination_v2($1,$2,$3,$4) AS value", [ctx, kind, id, binding])).rows[0]!.value;
}
export async function reachDestinationCutoff(owner: Db, binding: Binding) {
  await owner.query(`UPDATE ${documentTable} SET evidence_expires_at=clock_timestamp(), issued_at=clock_timestamp()-interval '24 hours'
    WHERE snapshot_ref=$1`, [binding.snapshotRef]);
}
export const testServicePin = {
  deliverySelectionRef: "selected", providerRef: "provider", carrierRef: "carrier",
  serviceRef: "service", servicePolicyRevision: "service-policy", adapterRevision: "adapter",
};
const checkArgs = (ctx: Context, issued: Issued, pin: unknown) =>
  [ctx, "checkout", ctx.scopeRef, issued.selection.selectionRevision, issued.binding, pin];
export async function recheckDestination(db: Db, ctx: Context, issued: Issued, pin: unknown = testServicePin) {
  return (await db.query("SELECT public.commerce_recheck_destination_v2($1,$2,$3,$4,$5,$6) AS value",
    checkArgs(ctx, issued, pin))).rows[0]!.value;
}
export async function registerDestination(db: Db, ctx: Context, orderId: string, issued: Issued, pin: unknown = testServicePin) {
  const [context, ...args] = checkArgs(ctx, issued, pin);
  return (await db.query("SELECT public.commerce_register_order_destination_v2($1,$2,$3,$4,$5,$6,$7) AS value",
    [context, orderId, ...args])).rows[0]!.value;
}
export async function insertDestinationOrder(db: Db, ctx: Context, id = randomUUID()) {
  return (await db.query(`INSERT INTO public.commerce_orders (id,client_id,status,currency_code,total_amount_minor)
    VALUES ($1,$2,'pending_payment','XXX',0) RETURNING id`, [id, ctx.clientId])).rows[0]!.id as string;
}
export function destinationFence<T>(pool: Pick<Pool, "connect">, ctx: Context, issued: Issued, read: (db: PoolClient) => Promise<T>,
  key = randomUUID()) {
  return withCatalogAdmissionFence(pool, {
    key, clientId: ctx.clientId, priceListId: randomUUID(), skuIds: [randomUUID()],
    revisionIds: [], timeoutMs: 6000,
  }, read, { prelock: destinationV2Prelock(ctx, issued.binding.snapshotRef) });
}
export async function bindDestinationOrder(pool: Pool, ctx: Context, issued: Issued) {
  const key = randomUUID();
  const bind = () => destinationFence(pool, ctx, issued, async db => {
    const decision = await recheckDestination(db, ctx, issued);
    expect(decision).toEqual({ binding: issued.binding, selection: issued.selection, service: testServicePin });
    const order = await insertDestinationOrder(db, ctx);
    expect(await registerDestination(db, ctx, order, issued)).toEqual(issued.binding);
    return order;
  }, key);
  // The fence compares cluster-wide snapshots before the read runs, so concurrent shard transactions on a shared
  // template cluster can produce this transient refusal; its hint asks the caller to retry with the same idempotency
  // key, so retry boundedly with the same key.
  for (let attempt = 1; ; attempt++) {
    try {
      return await bind();
    } catch (error: unknown) {
      if (attempt >= 8 || !(error instanceof Error) || error.message !== "catalog_admission_visibility_changed") throw error;
    }
  }
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
