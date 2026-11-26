import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { expect } from "vitest";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { createPostgresPrivacyStore } from "@openlup/platform/identity";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { composeNativePrivacy } from "../../server/runtime/auth/privacyBinding.js";
import type { AccountMutationsStore } from "./customerAccountMutations.fixture.js";
import { issue, write, type Evidence } from "./orderMoneyV2Guards.fixture.js";
import { capture, expectSqlError, insert, rejected, seedSku, transaction } from "./orderMoneyV2Storage.fixture.js";

export const receipts = "commerce_order_draft_receipts_v2";
export const contributorId = "order-draft-receipts";
export const contributorVersion = "commerce.order-draft-receipts.v1";
export const obligations = [
  { owner: contributorId, resource: "commerce.order-draft-receipt-owner-references", disposition: "erase",
    reasonCode: "RECEIPT_OWNER_REFERENCES_CLEARED", remote: false },
  { owner: contributorId, resource: "commerce.order-draft-receipt-retained-facts", disposition: "retain",
    reasonCode: "ORDER_REFERENCE_AND_DERIVED_REPLAY_KEY_RETAINED", remote: false },
] as const;
export const disposition = { contributorId, version: contributorVersion, obligations: [...obligations] };
export const immutableHint = "Read through the receipt lookup or use the authorized privacy operation to erase owner references.";
export const dialect = "commerce.order-draft.v2";
export const asciiKey = "request-key-0001";
export const unicodeKey = '  key-😀-"-\\-𐐷  ';
export const commandDigest = "a".repeat(64);
export const vectorOwner = (suffix = "1", installationRef = "installation-a") => ({
  installationRef, principalKind: "customer",
  principalRef: `00000000-0000-4000-8000-0000000000a${suffix}`,
  customerOrSessionRef: `00000000-0000-4000-8000-0000000000c${suffix}`,
});
export const unicodeOwner = vectorOwner("1", "install-😀");
type Owner = ReturnType<typeof vectorOwner>;
type Db = Pool | PoolClient;
type Sku = Awaited<ReturnType<typeof seedSku>>;

export const lookup = (owner: Owner, requestKey = asciiKey) => ({ dialect, owner, requestKey, commandDigest });
export type Lookup = ReturnType<typeof lookup>;
export const frame = (owner: Owner, requestKey: string) => ["order-draft-key.v2", dialect, owner, requestKey];
export const keyOf = (input: Lookup) => createHash("sha256").update(canonicalCatalogDraftJson(frame(input.owner, input.requestKey))).digest("hex");
export const scoped = async (db: Db, input: unknown) => (await db.query(
  "SELECT public.commerce_read_order_draft_receipt_v2($1::jsonb) AS result", [JSON.stringify(input)])).rows[0]!.result;
export const history = async (db: Db, key: string) => (await db.query(
  "SELECT public.commerce_read_order_draft_receipt_history_v2($1) AS result", [key])).rows[0]!.result;
export const rawReceipt = async (db: Db, key: string) => (await db.query(
  `SELECT to_jsonb(r) AS receipt FROM public.${receipts} r WHERE storage_key=$1`, [key])).rows[0]?.receipt;

export async function expectReceiptError(run: Promise<unknown>, code: string, message: string, detail: string | undefined, hint: string) {
  const error = await rejected(run);
  expectSqlError(error, code, message);
  expect(error).toMatchObject({ detail, hint, column: undefined, schema: undefined, table: undefined });
}

export async function replaceRoutineText(db: PoolClient, signature: string, original: string, replacement: string) {
  const definition: string = (await db.query("SELECT pg_get_functiondef($1::regprocedure) AS definition", [signature])).rows[0]!.definition;
  expect(definition).toContain(original);
  await db.query(definition.replace(original, replacement));
}

export async function principalFor(db: Db, clientId: string): Promise<string> {
  return (await db.query("SELECT principal_id FROM public.clients WHERE id=$1", [clientId])).rows[0]!.principal_id;
}

export async function insertReceipt(db: Db, input: Lookup, orderId: string, overrides: Record<string, unknown> = {}) {
  const { owner } = input;
  await insert(db, receipts, {
    storage_key: keyOf(input), installation_ref: owner.installationRef, principal_kind: owner.principalKind,
    principal_ref: owner.principalRef, customer_or_session_ref: owner.customerOrSessionRef,
    command_digest: input.commandDigest, order_id: orderId, ...overrides,
  });
}

export async function prepareReceipt(store: AccountMutationsStore, sku: Sku, requestKey = asciiKey, evidence?: Evidence) {
  const quote = evidence ?? await issue(store, sku, false);
  const input = lookup({
    installationRef: "installation-a", principalKind: "customer",
    principalRef: await principalFor(store.owner, quote.clientId), customerOrSessionRef: quote.clientId,
  }, requestKey);
  return { input, quote };
}

export function outcome(id: string, evidence: Evidence) {
  return { outcome: { orderId: id, status: "draft", paymentStatus: "not_started",
    acceptedMoneyDigest: evidence.quote.moneyDigest, destinationSnapshotRef: evidence.quote.destination.snapshotRef }, replayed: true };
}

export async function writeReceipt(db: PoolClient, input: Lookup, evidence: Evidence, sku: Sku, overrides?: Record<string, unknown>) {
  const { id } = await write(db, evidence, sku);
  await insertReceipt(db, input, id, overrides);
  return id;
}

export async function operator(db: Db) {
  const principalId = randomUUID();
  await db.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [principalId, `${principalId}@example.invalid`]);
  await db.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES($1,'admin','active','legacy',now())`, [principalId]);
  return { principalId };
}

export function privacy(pool: Pool) {
  const store = createPostgresPrivacyStore();
  const unitOfWork = { run: <T>(work: (db: PoolClient) => Promise<T>) => transaction(pool, work) };
  return { ...composeNativePrivacy({ store, unitOfWork }), store, unitOfWork };
}

export async function assertRuntime(store: AccountMutationsStore) {
  if (store.installation.generation === "legacy") throw new Error("Expected a qualified runtime");
  expect((await store.runtime.query("SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toStrictEqual([{ current_user: store.installation.runtimeLogin, session_user: store.installation.runtimeLogin,
      rolsuper: false, rolbypassrls: false }]);
}

export async function restorePacket(target: AccountMutationsStore, packet: Awaited<ReturnType<typeof capture>>, owner = target.migrator) {
  if (target.installation.generation === "legacy") throw new Error("Expected a qualified installation");
  const freshTarget = await capture(target.migrator, target.inventory, "pristine-receipt-target");
  expect(freshTarget.requiredPrivacyContributorIds).toStrictEqual(packet.requiredPrivacyContributorIds);
  return restoreConnectedNativeStore({ owner, installation: target.installation, packet, freshTarget });
}
