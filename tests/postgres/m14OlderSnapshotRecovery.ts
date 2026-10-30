// Finite local recovery composition; not a backup service or production gate.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { createIdentityPersonalDataContributor, createPersonalDataContributorRegistry, createPostgresPrivacyStore, createPostgresPrivacyUnitOfWork, createPrivacyOperations, createPostgresCustomerChallengeStore } from "@openlup/platform/identity";
import type { ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { captureOrderReviewMediaFilesystem, reconcileOrderReviewMediaFilesystem } from "../../server/adapters/filesystem/orderReviewMediaTransferInventory.js";
import { createOrderReviewMediaTransferReader } from "../../server/adapters/filesystem/orderReviewMediaTransferReader.js";
import { restoreOrderReviewMediaFilesystem } from "../../server/adapters/filesystem/orderReviewMediaTransferRestore.js";
import { createSubscriptionsPrivacyContributor } from "../../server/runtime/auth/subscriptionsPrivacyContributor.js";
import { catchupMediaLimits, mediaReferences } from "./m14ConnectedCatchup.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const recoveryRows = (graph: ConnectedNativeStoreCapture) => Object.fromEntries(
  [...graph.compatible.tables, ...graph.owned].map(table => [table.table, [...table.rows].sort()]));

/** Persist both files and their containing directory before declaring a boundary. */
export function persistRecoveryJson(path: string, value: unknown) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(join(path, ".."), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

/** Caller has retired media writers and paused all three admitted dispatches.
 * The coordinator performs no source mutation during this DB/object boundary. */
export async function persistOlderSnapshot(input: {
  scratch: string; db: Pool; mediaRoot: string;
  capture: (db: Pool, id: string) => Promise<ConnectedNativeStoreCapture>;
}) {
  const root = join(input.scratch, "older-snapshot"); mkdirSync(root, { mode: 0o700 });
  const boundary = { wall: new Date().toISOString(), monotonicMs: performance.now() };
  const graph = await input.capture(input.db, "pre-provider-acceptance");
  const references = await mediaReferences(input.db);
  const media = await captureOrderReviewMediaFilesystem({ root: input.mediaRoot, ...catchupMediaLimits });
  reconcileOrderReviewMediaFilesystem({ census: media, references });
  const mediaRoot = join(root, "media");
  await restoreOrderReviewMediaFilesystem({ root: mediaRoot, census: media, ...catchupMediaLimits,
    objects: createOrderReviewMediaTransferReader({ root: input.mediaRoot, maximumObjectBytes: 1024 }),
    temporary: createOrderReviewMediaTransferReader({ root: input.mediaRoot, maximumObjectBytes: 1024, area: "tmp" }) });
  // The source remains unchanged across the complete persisted boundary.
  assert.deepEqual(recoveryRows(await input.capture(input.db, "snapshot-seal-check")), recoveryRows(graph));
  assert.deepEqual(await captureOrderReviewMediaFilesystem({ root: mediaRoot, ...catchupMediaLimits }), media);
  persistRecoveryJson(join(root, "graph.json"), graph);
  persistRecoveryJson(join(root, "media.json"), media);
  persistRecoveryJson(join(root, "references.json"), references);
  const manifest = { format: "openlup.local-older-snapshot.v1", boundary,
    graphSha256: sha(readFileSync(join(root, "graph.json"))), mediaSha256: sha(readFileSync(join(root, "media.json"))),
    referencesSha256: sha(readFileSync(join(root, "references.json"))) };
  persistRecoveryJson(join(root, "manifest.json"), manifest);
  return { root, manifest };
}

/** Restore input is reloaded from persisted pre-failure bytes, never live source. */
export function loadOlderSnapshot(snapshot: Awaited<ReturnType<typeof persistOlderSnapshot>>) {
  const manifest = JSON.parse(readFileSync(join(snapshot.root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest, snapshot.manifest);
  const read = <T>(name: string, digest: string): T => {
    const bytes = readFileSync(join(snapshot.root, name)); assert.equal(sha(bytes), digest);
    return JSON.parse(bytes.toString("utf8")) as T;
  };
  return { graph: read<ConnectedNativeStoreCapture>("graph.json", manifest.graphSha256),
    media: read<Awaited<ReturnType<typeof captureOrderReviewMediaFilesystem>>>("media.json", manifest.mediaSha256),
    references: read<Awaited<ReturnType<typeof mediaReferences>>>("references.json", manifest.referencesSha256),
    mediaRoot: join(snapshot.root, "media"), boundary: snapshot.manifest.boundary };
}

export async function seedRecoveryPrivacy(owner: Pool, runtimeUrl: string) {
  const admin = randomUUID();
  await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'recovery-admin@example.invalid')", [admin]);
  await owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES($1,'admin','active','legacy','2020-01-01')`, [admin]);
  const subjects: RecoveryPrivacyObligation["subject"][] = [];
  for (const name of ["earlier", "later"]) {
    const subject = { principal: randomUUID(), contact: randomUUID(), receipt: randomUUID(), email: `${name}@recovery.example.invalid` };
    await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [subject.principal, subject.email]);
    await owner.query("INSERT INTO public.clients(id,principal_id,email,first_name,lifecycle_stage) VALUES($1,$2,$3,'Synthetic','lead')", [subject.contact, subject.principal, subject.email]);
    await owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at,membership_revoked_at,membership_revoked_by,membership_revocation_reason)
      VALUES($1,'distributor','revoked','legacy','2020-01-01','2021-01-01',$2,$3)`, [subject.principal, admin, subject.email]);
    subjects.push(subject);
  }
  const [earlier, later] = subjects;
  assert(earlier && later);
  const earlierAt = new Date().toISOString();
  await applyRecoveryPrivacy(runtimeUrl, { admin, subject: earlier, completedAt: earlierAt });
  return { admin, earlier, later };
}
export type RecoveryPrivacyObligation = { admin: string; subject: { principal: string; contact: string; receipt: string; email: string }; completedAt: string };

/** Reuse the actual restricted-runtime erasure transaction, including retained
 * free-text redaction and replay. No direct data rewrite substitutes for it. */
export async function applyRecoveryPrivacy(runtimeUrl: string, obligation: RecoveryPrivacyObligation) {
  const store = createPostgresPrivacyStore(), unitOfWork = createPostgresPrivacyUnitOfWork({ connectionString: runtimeUrl });
  const registry = createPersonalDataContributorRegistry([
    createIdentityPersonalDataContributor(store, { retainedContactFields: {
      lifecycle_stage: { owner: "clients", resource: "clients.lifecycle_stage", disposition: "retain", reasonCode: "LIFECYCLE", remote: false },
    } }, () => obligation.subject.receipt), createSubscriptionsPrivacyContributor(),
  ], { requiredContributorIds: ["identity", "subscriptions"] });
  const operations = createPrivacyOperations({ store, unitOfWork, registry,
    now: () => new Date(obligation.completedAt), randomId: () => obligation.subject.receipt });
  const input = { subject: { kind: "contact" as const, contactId: obligation.subject.contact }, idempotencyKey: obligation.subject.receipt };
  try {
    const receipt = await operations.erase({ principalId: obligation.admin }, input);
    assert.equal(receipt.outcome, "ERASED");
    assert.deepEqual(await operations.erase({ principalId: obligation.admin }, input), { ...receipt, outcome: "ALREADY_ERASED" });
    return receipt;
  } finally { await unitOfWork.close(); }
}

export async function assertRecoveryPrivacy(db: Pool, runtimeUrl: string, seed: Awaited<ReturnType<typeof seedRecoveryPrivacy>>) {
  const challenge = createPostgresCustomerChallengeStore({ connectionString: runtimeUrl });
  try {
    for (const subject of [seed.earlier, seed.later]) {
      const contact = (await db.query("SELECT principal_id,email,first_name FROM public.clients WHERE id=$1", [subject.contact])).rows;
      assert.deepEqual(contact, [{ principal_id: null, email: `erased+${subject.receipt}@identity.invalid`, first_name: null }]);
      assert.deepEqual((await db.query("SELECT membership_state,membership_revocation_reason FROM public.platform_human_memberships WHERE principal_id=$1", [subject.principal])).rows,
        [{ membership_state: "revoked", membership_revocation_reason: null }]);
      assert.equal((await db.query("SELECT erasure_id FROM public.identity_privacy_erasures WHERE erasure_id=$1", [subject.receipt])).rows.length, 1);
      assert.deepEqual(await challenge.issue({ email: contact[0].email, tokenHash: sha(subject.receipt), expiresAt: new Date(Date.now() + 60_000).toISOString() }), { deliverable: false });
    }
  } finally { await challenge.close(); }
}

export function assertRecoveryReady(facts: { publications: boolean; privacy: boolean; reconciled: boolean; authorized: boolean; transferred: boolean }) {
  assert(Object.values(facts).every(value => value === true), "older_snapshot_recovery_fenced");
}
