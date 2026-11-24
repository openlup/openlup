import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { expect } from "vitest";

type Db = Pool | PoolClient;
export const receiptTable = "public.commerce_destination_v2_receipts";
export const receiptDialect = "commerce.destination.snapshot.v2";
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const idempotencyConflict = { code: "23505", message: "destination_idempotency_conflict",
  detail: "idempotencyKey", hint: "Replay the original command or begin a distinct action." };
export const ownerUnlinked = { code: "22023", message: "destination_owner_unlinked",
  detail: "owner", hint: "Establish authorized linkage or use authorized support." };

export function receiptArgs(clientId: string, requestKey = `destination:${randomUUID()}`) {
  const owner = { installationRef: "fixture-installation", principalKind: "customer",
    principalRef: clientId, customerOrSessionRef: clientId };
  return [{ owner, clientId }, receiptDialect, requestKey, hash(canonicalCatalogDraftJson([
    "commerce.destination.request.v2", { dialect: receiptDialect, owner, requestKey, original: { line1: "Sample Lane" } },
  ]))] as const;
}
export type ReceiptArgs = ReturnType<typeof receiptArgs>;

export async function receiptOutcome(db: Db) {
  const { rows: [row] } = await db.query<{ cutoff: Date }>("SELECT clock_timestamp() + interval '24 hours' AS cutoff");
  return {
    binding: { snapshotRef: randomUUID(), schemaVersion: 2, destinationDigest: hash("fixture-destination"), policyRevision: "fixture-policy" },
    selection: { kind: "checkout", scopeRef: randomUUID(), selectionRevision: randomUUID() },
    evidenceExpiresAt: row!.cutoff.toISOString(),
  };
}
export async function receiptCall(db: Db, action: "read" | "lock" | "commit", args: ReceiptArgs, outcome?: object | string) {
  const placeholders = action === "commit" ? "$1,$2,$3,$4,$5" : "$1,$2,$3,$4";
  return (await db.query(`SELECT public.commerce_destination_v2_receipt_${action}(${placeholders}) AS value`,
    action === "commit" ? [...args, outcome] : [...args])).rows[0].value;
}

export async function receiptClient(db: Db, stage: "customer" | "lead" = "customer") {
  const id = randomUUID();
  await db.query("INSERT INTO public.clients(id,email,lifecycle_stage) VALUES($1,$2,$3)", [id, `${id}@example.invalid`, stage]);
  return id;
}

export async function markReceiptClientErased(owner: Db, client: string) {
  const actor = randomUUID();
  await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [actor, `${actor}@example.invalid`]);
  await owner.query(`INSERT INTO public.identity_privacy_erasures
    (erasure_id,idempotency_key,client_id,actor_principal_id,contract_version,contributor_versions,dispositions,retained_obligations,completed_at)
    VALUES (gen_random_uuid(),gen_random_uuid(),$1,$2,'identity.erasure.v1',
      '{"tax-calculations":"commerce.tax-calculations.v1"}','{}','[]',clock_timestamp())`, [client, actor]);
}

export async function backendPid(db: PoolClient): Promise<number> {
  return (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
}
export async function awaitReceiptWait(observer: Db, pid: number, lockType: string, mode: string) {
  await expect.poll(async () => (await observer.query(
    "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype=$2 AND mode=$3 AND NOT granted", [pid, lockType, mode],
  )).rowCount, { timeout: 4000 }).toBe(1);
}

export async function proveReceiptEncoderParity(ownerDb: Db) {
  const [ctx, dialect, , digest] = receiptArgs("03e49f4b-ff21-4e8f-81ca-3e54705a9c89");
  const owner = { ...ctx.owner, installationRef: 'inst-Łódź-"quoted"\\name', principalRef: "account-😀",
    customerOrSessionRef: "e\u0301-ß" };
  const requestKey = 'attempt-"escaped"\\📦';
  const vectors = [
    { dialect, owner, requestKey },
    { dialect, owner: { ...owner, installationRef: "other-installation" }, requestKey },
    { dialect, owner: { ...owner, principalKind: "checkout_session" }, requestKey },
    { dialect, owner: { ...owner, principalRef: "other-principal" }, requestKey },
    { dialect, owner: { ...owner, customerOrSessionRef: "other-session" }, requestKey },
    { dialect, owner, requestKey: `${requestKey}-2` },
    { dialect: "commerce.destination.other.v2", owner, requestKey },
  ];
  const hashes = new Set();
  for (const vector of vectors) {
    const preimage = ["commerce.destination.key.v2", vector];
    const canonical = canonicalCatalogDraftJson(preimage);
    const { rows: [row] } = await ownerDb.query("SELECT public.catalog_publication_canonical($1::jsonb,0) AS bytes", [JSON.stringify(preimage)]);
    expect(row.bytes).toBe(canonical);
    hashes.add(hash(canonical));
    if (vector.dialect === dialect) {
      const { rows: [scoped] } = await ownerDb.query(
        "SELECT public.commerce_destination_v2_receipt_scoped_key($1,$2,$3,$4) AS hash",
        [{ clientId: ctx.clientId, owner: vector.owner }, vector.dialect, vector.requestKey, digest],
      );
      expect(scoped.hash).toBe(hash(canonical));
    }
  }
  expect(hashes.size).toBe(vectors.length);
  await expect(ownerDb.query("SELECT public.commerce_destination_v2_receipt_scoped_key($1,$2,$3,$4)",
    [{ ...ctx, owner }, vectors.at(-1)!.dialect, requestKey, digest],
  )).rejects.toMatchObject({ code: "22023", message: "destination_dialect_invalid", detail: "version", hint: "Use the supported entry." });
}
