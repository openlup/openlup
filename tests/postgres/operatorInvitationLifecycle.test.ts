/** Real-database fixture only. Missing Docker is a failure, never a passing skip. */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Pool } from "pg";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

async function operatorInvitationDatabase() {
  if (!await dockerAvailable()) throw new Error("Operator invitation conformance requires ephemeral PostgreSQL; Docker is unavailable");
  const containers: PostgresContainer[] = [];
  const pools: Pool[] = [];
  const roots: string[] = [];
  async function close() {
    await Promise.all(pools.map((pool) => pool.end()));
    await Promise.all(containers.map((container) => container.remove()));
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
  try {
    // Roles belong to a cluster, so each installation needs its own container.
    for (const name of ["fresh", "upgrade"]) {
      const container = await runPostgresContainer({ name: `operator-invitation-${name}-${process.pid}`, password: "synthetic-conformance" });
      containers.push(container);
      if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Operator invitation PostgreSQL readiness failed");
      pools.push(new Pool({ connectionString: container.connectionString }));
    }
    const [fresh, upgrade] = pools;
    const current = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
    const appended = ["db/platform/migrations/20261018120000_identity_operator_invitations.sql"];
    if (JSON.stringify(current.forward.slice(-appended.length).map((entry: { file: string }) => entry.file)) !== JSON.stringify(appended)) {
      throw new Error("Operator invitations must append the expected forward suffix");
    }
    // The predecessor run proves ordered path/hash/position continuity. Its old
    // object inventory is unavailable; only the completed current chain checks
    // the real selected-catalog projection against the committed inventory hash.
    const prefixPayload = "predecessor-ledger-prefix";
    const before = { ...current, forward: current.forward.slice(0, -appended.length),
      objectInventorySha256: createHash("sha256").update(prefixPayload).digest("hex") };
    const root = mkdtempSync(join(tmpdir(), "operator-invitation-predecessor-")); roots.push(root);
    for (const entry of [before.baseline, ...before.forward]) {
      const path = join(root, entry.file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, readFileSync(entry.file));
    }
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(before));
    const runner = (pool: Pool, selectedRoot = process.cwd()) => createPostgresMigrationRunner({ connectionString: "injected" }, {
      root: selectedRoot, poolFactory: () => pool,
      ...(selectedRoot === root ? { catalogProjectionPayload: async () => prefixPayload } : {}),
    });
    await runner(upgrade, root).apply();
    const ledger = (await upgrade.query("SELECT catalog_path, sha256, position FROM public.platform_schema_migrations ORDER BY position")).rows;
    expect(ledger).toEqual([before.baseline, ...before.forward].map((entry: { file: string; sha256: string }, position: number) => ({ catalog_path: entry.file, sha256: entry.sha256, position })));
    await runner(fresh).apply();
    return { fresh, upgrade, runner, close };
  } catch (error) { await close(); throw error; }
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDirectOperatorInvitationStore } from "@openlup/platform/identity";
const A = "d4100000-0000-4000-8000-000000000001";
const B = "d4100000-0000-4000-8000-000000000002";
const T = "d4100000-0000-4000-8000-000000000003";
const M = "d4100000-0000-4000-8000-000000000004";
let db: Awaited<ReturnType<typeof operatorInvitationDatabase>>;
async function seed(pool: Pool) {
  await pool.query(`INSERT INTO public.platform_human_principals (principal_id, email) VALUES
    ($1, 'admin-a@example.invalid'), ($2, 'admin-b@example.invalid'), ($3, 'invitee@example.invalid'), ($4, 'machine@example.invalid')`, [A, B, T, M]);
  await pool.query(`INSERT INTO public.platform_human_memberships (principal_id, role, membership_state, membership_provenance, membership_accepted_at)
    VALUES ($1, 'admin', 'active', 'legacy', now()), ($2, 'admin', 'active', 'legacy', now())`, [A, B]);
  await pool.query("INSERT INTO public.clients (id, email, principal_id) VALUES ($1, 'invitee@example.invalid', $2)", ["d4100000-0000-4000-8000-000000000005", T]);
  await pool.query("INSERT INTO public.platform_control_operators (principal_id, active) VALUES ($1, true)", [M]);
}
function store(pool: Pool) { return createDirectOperatorInvitationStore({ connectionString: "injected" }, { poolFactory: () => pool }); }
function issue(pool: Pool, role: "admin" | "distributor" = "distributor") {
  return store(pool).issue({ actorPrincipalId: A, targetPrincipalId: T, email: " INVITEE@example.invalid ", role, ttlSeconds: 60 });
}
async function expire(pool: Pool) {
  // Fixture time travel preserves the SQL duration constraint and tests the real clock.
  await pool.query("UPDATE public.identity_operator_invitations SET invited_at = clock_timestamp() - interval '61 seconds', expires_at = clock_timestamp() - interval '1 second' WHERE principal_id = $1", [T]);
}
async function journey(pool: Pool) {
  const lifecycle = store(pool);
  const identityBefore = (await pool.query("SELECT * FROM public.platform_human_principals ORDER BY principal_id")).rows;
  const customerLinksBefore = (await pool.query("SELECT * FROM public.clients ORDER BY id")).rows;
  const selfTarget = () => lifecycle.issue({ actorPrincipalId: A, targetPrincipalId: A, email: "admin-a@example.invalid", role: "admin", ttlSeconds: 60 });
  expect(await Promise.all([selfTarget(), selfTarget()])).toEqual([{ code: "MEMBERSHIP_ALREADY_ACTIVE" }, { code: "MEMBERSHIP_ALREADY_ACTIVE" }]);
  // Hold reciprocal actor reads together if the protocol permits them. Ordered
  // exclusive locks serialize those reads; unordered shared locks form a cycle.
  let readers = 0; let releaseReaders!: () => void;
  const bothReaders = new Promise<void>((resolve) => { releaseReaders = resolve; });
  const reciprocalPool = { connect: async () => {
    const client = await pool.connect();
    return { async query(sql: string, values?: unknown[]) {
      const result = await client.query(sql, values);
      if (sql.includes("FOR SHARE")) {
        if (++readers === 2) releaseReaders();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([bothReaders, new Promise<void>((resolve) => { timer = setTimeout(resolve, 250); })]); }
        finally { clearTimeout(timer); }
      }
      return result;
    }, release: () => client.release() };
  } } as unknown as Pool;
  expect(await Promise.all([
    store(reciprocalPool).issue({ actorPrincipalId: A, targetPrincipalId: B, email: "admin-b@example.invalid", role: "admin", ttlSeconds: 60 }),
    store(reciprocalPool).issue({ actorPrincipalId: B, targetPrincipalId: A, email: "admin-a@example.invalid", role: "admin", ttlSeconds: 60 }),
  ])).toEqual([{ code: "MEMBERSHIP_ALREADY_ACTIVE" }, { code: "MEMBERSHIP_ALREADY_ACTIVE" }]);
  await issue(pool);
  await lifecycle.remove({ actorPrincipalId: A, targetPrincipalId: T });
  await lifecycle.remove({ actorPrincipalId: A, targetPrincipalId: T });
  expect(await lifecycle.acceptOperatorInvitation(T)).toEqual({ code: "INVITATION_REVOKED" });
  expect((await pool.query("SELECT * FROM public.platform_human_memberships WHERE principal_id = $1", [T])).rows).toEqual([]);
  expect((await pool.query("SELECT phase FROM public.identity_operator_invitations WHERE principal_id = $1", [T])).rows).toEqual([{ phase: "cancelled" }]);
  expect((await pool.query("SELECT action FROM public.identity_operator_invitation_events WHERE principal_id = $1 AND action = 'cancel'", [T])).rows).toEqual([{ action: "cancel" }]);
  expect((await pool.query("SELECT * FROM public.platform_human_principals ORDER BY principal_id")).rows).toEqual(identityBefore);
  const commands = await Promise.all([issue(pool), issue(pool), issue(pool)]);
  expect(new Set(commands.map((v) => (v as { invitationId: string }).invitationId)).size).toBe(1);
  expect(commands.filter((v) => v.code === "INVITATION_REISSUED")).toHaveLength(1);
  expect((await pool.query("SELECT * FROM public.platform_human_memberships WHERE principal_id = $1", [T])).rows).toEqual([]);
  const first = commands[0]; expect(await issue(pool)).toEqual({ ...first, code: "ALREADY_INVITED" });
  expect(await issue(pool, "admin")).toEqual({ code: "INVITATION_ROLE_CONFLICT" });
  expect((await pool.query("SELECT action FROM public.identity_operator_invitation_events WHERE principal_id = $1 ORDER BY occurred_at", [T])).rows).toEqual([{ action: "issue" }, { action: "cancel" }, { action: "reissue" }]);
  const accepted = await Promise.all([lifecycle.acceptOperatorInvitation(T), lifecycle.acceptOperatorInvitation(T)]);
  expect(accepted.map((v) => v.code).sort()).toEqual(["ACTIVATED", "ALREADY_ACTIVE"]);
  await pool.query(`WITH stamp AS (SELECT clock_timestamp() AS at) UPDATE public.identity_operator_invitations
    SET invited_at = stamp.at - interval '61 seconds', expires_at = stamp.at - interval '1 second', accepted_at = stamp.at - interval '30 seconds', closed_at = stamp.at - interval '30 seconds'
    FROM stamp WHERE principal_id = $1`, [T]);
  expect(await lifecycle.read(T)).toMatchObject({ membershipState: "active" });
  expect(await issue(pool)).toEqual({ code: "MEMBERSHIP_ALREADY_ACTIVE" });
  expect((await pool.query("SELECT count(*)::int AS count FROM public.identity_operator_invitation_events WHERE principal_id = $1 AND action = 'accept'", [T])).rows[0].count).toBe(1);
  await lifecycle.remove({ actorPrincipalId: A, targetPrincipalId: T });
  expect(await lifecycle.acceptOperatorInvitation(T)).toEqual({ code: "INVITATION_REVOKED" });
  expect(await issue(pool, "admin")).toMatchObject({ code: "INVITATION_REISSUED" });
  expect((await pool.query("SELECT membership_state FROM public.platform_human_memberships WHERE principal_id = $1", [T])).rows[0].membership_state).toBe("revoked");
  expect(await lifecycle.acceptOperatorInvitation(T)).toEqual({ code: "ACTIVATED", role: "admin" });
  expect(await lifecycle.read(T)).toEqual({ principalId: T, role: "admin", membershipState: "active" });
  const persisted = (await pool.query(`SELECT m.role, m.membership_state, m.membership_provenance, m.membership_accepted_at,
    m.membership_revoked_at, m.membership_revoked_by, m.membership_revocation_reason, i.accepted_at, i.phase
    FROM public.platform_human_memberships m JOIN public.identity_operator_invitations i USING (principal_id) WHERE principal_id = $1`, [T])).rows[0];
  expect(persisted).toEqual({ role: "admin", membership_state: "active", membership_provenance: "invitation",
    membership_accepted_at: expect.any(Date), accepted_at: expect.any(Date), phase: "accepted",
    membership_revoked_at: null, membership_revoked_by: null, membership_revocation_reason: null });
  expect(persisted.membership_accepted_at).toEqual(persisted.accepted_at);
  await lifecycle.remove({ actorPrincipalId: A, targetPrincipalId: T });
  await issue(pool); await expire(pool);
  expect(await lifecycle.acceptOperatorInvitation(T)).toEqual({ code: "INVITATION_EXPIRED" });
  expect(await lifecycle.read(T)).toMatchObject({ membershipState: "expired" });
  const expiredId = (await pool.query("SELECT invitation_id FROM public.identity_operator_invitations WHERE principal_id = $1", [T])).rows[0].invitation_id;
  const reissued = await issue(pool); expect(reissued).toMatchObject({ code: "INVITATION_REISSUED" });
  expect((reissued as { invitationId: string }).invitationId).not.toBe(expiredId);
  await lifecycle.remove({ actorPrincipalId: A, targetPrincipalId: T });
  expect(await lifecycle.acceptOperatorInvitation(T)).toEqual({ code: "INVITATION_REVOKED" });
  await lifecycle.remove({ actorPrincipalId: A, targetPrincipalId: T });
  await expect(lifecycle.issue({ actorPrincipalId: B, targetPrincipalId: M, email: "machine@example.invalid", role: "admin", ttlSeconds: 60 })).resolves.toEqual({ code: "IDENTITY_CONFLICT" });
  expect(await lifecycle.acceptOperatorInvitation(M)).toEqual({ code: "NO_INVITATION" });
  await expect(lifecycle.issue({ actorPrincipalId: M, targetPrincipalId: T, email: "invitee@example.invalid", role: "admin", ttlSeconds: 60 })).rejects.toThrow("HUMAN_ADMIN_REQUIRED");
  await expect(lifecycle.remove({ actorPrincipalId: A, targetPrincipalId: A })).rejects.toThrow("SELF_REVOKE_FORBIDDEN");
  await lifecycle.remove({ actorPrincipalId: A, targetPrincipalId: B });
  // The retained native guard remains authoritative even for a trusted caller.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.platform_human_membership_revoke','true',true)");
    await expect(client.query("UPDATE public.platform_human_memberships SET role = 'distributor' WHERE principal_id = $1", [A])).rejects.toThrow("platform_human_last_admin_lockout");
  } finally { await client.query("ROLLBACK"); client.release(); }
  await expect(issue(pool)).resolves.toMatchObject({ code: "INVITATION_REISSUED" });
  // Force audit failure on accept, observe both membership and invitation rollback.
  const owner = await pool.connect();
  const failPool = { connect: async () => ({
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("INSERT INTO public.identity_operator_invitation_events")) throw new Error("planted_audit_failure");
      return owner.query(sql, values);
    }, release() {},
  }) } as unknown as Pool;
  try { await expect(store(failPool).acceptOperatorInvitation(T)).rejects.toThrow("planted_audit_failure"); } finally { owner.release(); }
  expect(await lifecycle.read(T)).toMatchObject({ membershipState: "invited" });
  expect((await pool.query("SELECT membership_state FROM public.platform_human_memberships WHERE principal_id = $1", [T])).rows[0].membership_state).toBe("revoked");
  expect((await pool.query("SELECT * FROM public.platform_human_principals ORDER BY principal_id")).rows).toEqual(identityBefore);
  expect((await pool.query("SELECT * FROM public.clients ORDER BY id")).rows).toEqual(customerLinksBefore);
  for (const table of ["identity_operator_invitations", "identity_operator_invitation_events"]) {
    const privileges = await pool.query("SELECT has_table_privilege(r, $1, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed FROM unnest(ARRAY['anon','authenticated']) AS r", [`public.${table}`]);
    expect(privileges.rows).toEqual([{ allowed: false }, { allowed: false }]);
  }
}
// A session-owned database barrier holds the first transaction immediately after
// its empty membership read. Observe the other transaction's target-lock wait
// before releasing it, so either ordering is independent of scheduler timing.
async function acceptanceRemovalRace(pool: Pool, firstCommand: "accept" | "remove") {
  const target = firstCommand === "accept" ? "d4100000-0000-4000-8000-000000000006" : "d4100000-0000-4000-8000-000000000007";
  const actor = firstCommand === "accept" ? "d4100000-0000-4000-8000-000000000008" : "d4100000-0000-4000-8000-000000000009";
  const email = `${firstCommand}-race@example.invalid`;
  await pool.query("INSERT INTO public.platform_human_principals (principal_id, email) VALUES ($1, $2)", [target, email]);
  await pool.query("INSERT INTO public.platform_human_principals (principal_id, email) VALUES ($1, $2)", [actor, `${firstCommand}-admin@example.invalid`]);
  await pool.query(`INSERT INTO public.platform_human_memberships (principal_id, role, membership_state, membership_provenance, membership_accepted_at)
    VALUES ($1, 'admin', 'active', 'legacy', now())`, [actor]);
  await store(pool).issue({ actorPrincipalId: actor, targetPrincipalId: target, email, role: "distributor", ttlSeconds: 60 });
  const barrierKey = firstCommand === "accept" ? 410006 : 410007;
  const barrier = await pool.connect();
  const pids: number[] = [];
  const pending: Promise<unknown>[] = [];
  function connection(hold: boolean) {
    return { connect: async () => {
      const client = await pool.connect();
      pids.push((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (hold && sql.startsWith("SELECT * FROM public.platform_human_memberships WHERE principal_id")) {
            await client.query("SELECT pg_advisory_xact_lock(4100, $1::integer)", [barrierKey]);
          }
          return result;
        },
        release: () => client.release(),
      };
    } } as unknown as Pool;
  }
  async function waitForLock(index: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (pids[index] !== undefined) {
        const waiting = await pool.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted", [pids[index]]);
        if (waiting.rowCount === 1) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected transaction ${index + 1} to wait at the database advisory barrier`);
  }
  const first = store(connection(true));
  const second = store(connection(false));
  const remove = (lifecycle: ReturnType<typeof store>) => lifecycle.remove({ actorPrincipalId: actor, targetPrincipalId: target, reason: "access_removed" });
  let results: unknown[] = [];
  try {
    await barrier.query("SELECT pg_advisory_lock(4100, $1::integer)", [barrierKey]);
    pending.push(firstCommand === "accept" ? first.acceptOperatorInvitation(target) : remove(first));
    await waitForLock(0);
    pending.push(firstCommand === "accept" ? remove(second) : second.acceptOperatorInvitation(target));
    await waitForLock(1);
    await barrier.query("SELECT pg_advisory_unlock(4100, $1::integer)", [barrierKey]);
    results = await Promise.all(pending);
  } finally {
    await barrier.query("SELECT pg_advisory_unlock_all()");
    barrier.release();
    await Promise.allSettled(pending);
  }
  expect(results).toEqual(firstCommand === "accept"
    ? [{ code: "ACTIVATED", role: "distributor" }, { revoked: true }]
    : [{ revoked: true }, { code: "INVITATION_REVOKED" }]);
  expect(await store(pool).read(target)).toEqual({ principalId: target, role: "distributor", membershipState: "revoked" });
  expect((await pool.query("SELECT membership_state FROM public.platform_human_memberships WHERE principal_id = $1", [target])).rows)
    .toEqual(firstCommand === "accept" ? [{ membership_state: "revoked" }] : []);
  const invitationEvents = (await pool.query("SELECT action, actor_kind, actor_principal_id FROM public.identity_operator_invitation_events WHERE principal_id = $1 ORDER BY occurred_at", [target])).rows;
  expect(invitationEvents).toEqual([
    { action: "issue", actor_kind: "human", actor_principal_id: actor },
    { action: firstCommand === "accept" ? "accept" : "cancel", actor_kind: "human", actor_principal_id: firstCommand === "accept" ? target : actor },
  ]);
  const revocations = (await pool.query("SELECT action, actor_principal_id, old_value, new_value FROM public.platform_human_membership_audit_events WHERE target_principal_id = $1", [target])).rows;
  if (firstCommand === "accept") {
    expect(revocations).toEqual([expect.objectContaining({ action: "revoke", actor_principal_id: actor,
      old_value: expect.objectContaining({ membershipState: "active" }), new_value: expect.objectContaining({ membershipState: "revoked" }) })]);
  } else expect(revocations).toEqual([]);
  expect(await store(pool).acceptOperatorInvitation(target)).toEqual({ code: "INVITATION_REVOKED" });
}

describe("operator invitations, complete canonical PostgreSQL catalogue", () => {
  beforeAll(async () => { db = await operatorInvitationDatabase(); }, 120000);
  afterAll(async () => { await db?.close(); });
  it("fresh install and exact predecessor ledger upgrade retain authority and lifecycle", async () => {
    await seed(db.upgrade);
    const legacy = (await db.upgrade.query("SELECT * FROM public.platform_human_memberships ORDER BY principal_id")).rows;
    const upgraded = await db.runner(db.upgrade).apply();
    expect(upgraded.applied).toEqual(["db/platform/migrations/20261018120000_identity_operator_invitations.sql"]);
    expect((await db.upgrade.query("SELECT * FROM public.platform_human_memberships ORDER BY principal_id")).rows).toEqual(legacy);
    await seed(db.fresh);
    for (const pool of [db.fresh, db.upgrade]) {
      expect((await db.runner(pool).apply()).applied).toEqual([]);
      await journey(pool);
      expect((await db.runner(pool).apply()).applied).toEqual([]);
    }
  }, 120000);

  // Reuse the complete installed catalogue from the journey above.
  it.each(["accept", "remove"] as const)("removal wins when %s holds the target lock first", async (firstCommand) => {
    await acceptanceRemovalRace(db.fresh, firstCommand);
  }, 20000);
});
