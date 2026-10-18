/** Opt-in local managed conformance. Run with Node, not the Docker Vitest harness. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { cwd, env } from "node:process";
import { readManagedMigrationChain } from "../../scripts/public-ci-pgtap.mjs";
import { createServiceRoleClient } from "../../server/_lib/admin-domain/auth.js";
import { createInviteAdminUserGateway, runInviteAdminUserUseCase, createSupabaseAdminAuth, createAdminPlatformMeHandler, managedOperatorMagicLinkEligibility, createRemoveAdminUserGateway, type InviteAdminUserClient, type RemoveAdminUserClient, type ManagedIdentityClient } from "@openlup/platform/identity";

const url = env.OPENLUP_MANAGED_CONFORMANCE_URL;
const key = env.OPENLUP_MANAGED_CONFORMANCE_SERVICE_KEY;
if (!url || !key) throw new Error("Managed invitation conformance requires OPENLUP_MANAGED_CONFORMANCE_URL and OPENLUP_MANAGED_CONFORMANCE_SERVICE_KEY; no skip is permitted");
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) throw new Error("Managed invitation conformance requires an already-running local disposable stack");
const databaseUrl = env.OPENLUP_MANAGED_CONFORMANCE_DATABASE_URL;
if (!databaseUrl || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname)) {
  throw new Error("Managed invitation conformance requires OPENLUP_MANAGED_CONFORMANCE_DATABASE_URL for a fresh local disposable stack");
}
const pool = new Pool({ connectionString: databaseUrl });
try {
  const existing = await pool.query("SELECT to_regclass('public.admin_users') AS relation");
  assert.equal(existing.rows[0].relation, null, "Managed conformance refuses an already-installed public schema; use a fresh disposable stack");
  const defaults = ["postgres", "supabase_admin"].flatMap(role => ["", " IN SCHEMA public"].flatMap(scope =>
    ["TABLES", "SEQUENCES", "FUNCTIONS"].map(kind => `ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role;`))).join("\n");
  const migrations = readManagedMigrationChain(cwd());
  await pool.query(["BEGIN;", readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"), defaults,
    // The shared runners use psql; node-postgres must omit only its pg_dump guard lines.
    "SET ROLE postgres;", ...migrations.map(({ contents }) => contents.replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, "")), "RESET ROLE;",
    // FIXTURE ONLY: these exact managed permissions are absent from the committed
    // chain. A separate reviewed managed forward must supply production grants.
    "GRANT SELECT (email), INSERT (id, email, role, membership_state, membership_provenance, membership_accepted_at) ON public.admin_users TO service_role;",
    "NOTIFY pgrst, 'reload schema';", "COMMIT;"].join("\n"));
} finally { await pool.end(); }
const service = createServiceRoleClient({ url, serviceRoleKey: key });
let ready = false;
for (let retry = 0; retry < 30; retry++) {
  const { error } = await service.from("admin_users").select("id, email").limit(1);
  if (!error) { ready = true; break; }
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(ready, "Disposable managed API did not expose the replayed schema and fixture-only grants");
const A = "d4200000-0000-4000-8000-000000000001";
const T = "d4200000-0000-4000-8000-000000000002";
const X = "d4200000-0000-4000-8000-000000000003";
const C = "d4200000-0000-4000-8000-000000000005";
const emails = new Map([[A, "invitation-admin@example.invalid"], [T, "invitation-target@example.invalid"], [X, "invitation-other@example.invalid"], [C, "invitation-concurrent@example.invalid"]]);
// Fixed synthetic identities make the fixture reviewable. It deliberately retains
// identities on success and failure; reset the disposable stack before another run.
for (const [id, email] of emails) {
  const { data: present } = await service.auth.admin.getUserById(id);
  assert.equal(present.user, null, "Fixture identities already exist; use a fresh disposable stack");
  const { data, error } = await service.auth.admin.createUser({ id, email, email_confirm: true });
  assert.equal(error, null); assert.equal(data.user?.id, id);
}
async function checked<T extends { error: unknown }>(value: PromiseLike<T>): Promise<T> { const result = await value; assert.equal(result.error, null); return result; }
await checked((service as unknown as ManagedIdentityClient).from("admin_users").insert({ id: A, email: emails.get(A), role: "admin", membership_state: "active", membership_provenance: "legacy", membership_accepted_at: new Date().toISOString() }));
async function session(principalId: string) {
  const { data } = await checked(service.auth.admin.generateLink({ type: "magiclink", email: emails.get(principalId)! }));
  assert.ok(data.properties);
  const actor = createServiceRoleClient({ url: url!, serviceRoleKey: key! });
  const verified = await checked(actor.auth.verifyOtp({ token_hash: data.properties.hashed_token, type: "magiclink" }));
  assert.equal(verified.data.user?.id, principalId);
  return { actor, token: verified.data.session!.access_token };
}
const admin = await session(A);
const gateway = createInviteAdminUserGateway(() => service as unknown as InviteAdminUserClient);
let notifications = 0;
const issue = (target = T) => runInviteAdminUserUseCase({ accessToken: admin.token, email: emails.get(target)!, role: "distributor" }, {
  gateway, activateMembership: gateway.activateMembership, siteUrl: "https://example.invalid",
  roleNotificationPort: { async sendRoleGranted() { notifications++; return { ok: true, skipped: false, skipReason: null, providerError: null, providerMessageId: "synthetic-receipt" }; } },
});
const first = await issue(); assert.equal(first.status, 200); assert.equal(first.body.code, "MEMBERSHIP_CREATED");
assert.equal(first.body.membershipState, "active"); assert.equal(first.body.invitationId, undefined); assert.equal(first.body.expiresAt, undefined);
const readMembership = async (id: string) => (await checked((service as unknown as ManagedIdentityClient).from("admin_users").select("id, role, membership_state, is_machine_actor").eq("id", id).maybeSingle())).data;
assert.equal((await readMembership(T))?.membership_state, "active");
assert.equal((await readMembership(T))?.is_machine_actor, false);
const repeated = await issue(); assert.equal(repeated.status, 200); assert.equal(repeated.body.code, "ALREADY_ACTIVE"); assert.equal(notifications, 1);
assert.equal(await managedOperatorMagicLinkEligibility(service, emails.get(T)!), "eligible");
const concurrent = await Promise.all([issue(C), issue(C)]);
assert.deepEqual(concurrent.map(result => result.status), [200, 200]);
assert.deepEqual(concurrent.map(result => result.body.code).sort(), ["ALREADY_ACTIVE", "MEMBERSHIP_CREATED"]);
assert.equal(notifications, 2);
const other = await session(X);
assert.equal((await createSupabaseAdminAuth(other.actor).authorize(other.token)).ok, false);
const target = await session(T);
assert.equal((await createSupabaseAdminAuth(target.actor).authorize(target.token)).ok, true);
const remover = createRemoveAdminUserGateway(() => admin.actor as unknown as RemoveAdminUserClient);
await checked(remover.revokeAdminUser(T));
assert.equal((await issue()).body.code, "MANAGED_REINVITE_UNSUPPORTED");
assert.equal((await readMembership(T))?.membership_state, "revoked");
assert.equal(await managedOperatorMagicLinkEligibility(service, emails.get(T)!), "not_allowlisted");
assert.equal((await checked(service.auth.admin.getUserById(T))).data.user?.id, T);
// Metadata cannot make a nonmember eligible or cause activation on entry.
await checked(service.auth.admin.updateUserById(X, { app_metadata: { operator_invitation: { phase: "invited", role: "admin", expiresAt: "2099-01-01T00:00:00.000Z" } } }));
assert.equal(await managedOperatorMagicLinkEligibility(service, emails.get(X)!), "not_allowlisted");
assert.equal((await createSupabaseAdminAuth(other.actor).authorize(other.token)).ok, false);
assert.equal(await readMembership(X), null);
const verified = await checked(service.auth.getUser(other.token));
let status = 0; let body: unknown;
const response = { status(value: number) { status = value; return response; }, json(value: unknown) { body = value; return response; }, setHeader() {}, getHeader() {} };
await createAdminPlatformMeHandler({ authenticateUser: async () => ({ ok: true, userId: verified.data.user!.id }), platformPort: { async getAdminMe(id) {
  const { data } = await checked((other.actor as unknown as ManagedIdentityClient).from("admin_users").select("role").eq("id", id).eq("membership_state", "active").maybeSingle());
  return { isAdmin: Boolean(data), role: data?.role === "distributor" ? "distributor" : data ? "admin" : null };
} } })({ method: "GET", query: {}, headers: {}, body: { principalId: C } } as never, response as never);
assert.equal(status, 200); assert.deepEqual(body, { ok: true, data: { isAdmin: false, role: null } }); assert.equal(await readMembership(X), null);
console.log("Managed immediate operator membership conformance passed; synthetic identities retained");
