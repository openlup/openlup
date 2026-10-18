import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPrivacyStore, createPostgresPrivacyUnitOfWork, createIdentityPersonalDataContributor, createPersonalDataContributorRegistry, createPrivacyOperations, createPostgresCustomerChallengeStore, createDirectOperatorInvitationStore, createPostgresOperatorIdentityStore } from "@openlup/platform/identity";
import { createSubscriptionsPrivacyContributor } from "../../server/runtime/auth/subscriptionsPrivacyContributor.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
const A = "d4300000-0000-4000-8000-000000000001", P = "d4300000-0000-4000-8000-000000000002", C = "d4300000-0000-4000-8000-000000000003", O = "d4300000-0000-4000-8000-000000000004", S = "d4300000-0000-4000-8000-000000000005", K = "d4300000-0000-4000-8000-000000000006";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const privacyPath = "db/platform/migrations/20261018190000_identity_privacy_erasures.sql";
export function registerIdentityPrivacyConformance(): void {
  describe("direct identity privacy, complete catalogue and exact predecessor", () => {
    const containers: PostgresContainer[] = [], pools: Pool[] = [];
    let predecessorRoot: string;
    let current: { baseline: { file: string; sha256: string }; forward: { file: string; sha256: string }[]; objectInventorySha256: string };
    const runner = (i: number, root = process.cwd()) => createPostgresMigrationRunner({ connectionString: containers[i].connectionString }, { root, poolFactory: () => pools[i] });
    beforeAll(async () => {
      if (!await dockerAvailable()) throw new Error("Identity privacy conformance requires Docker PostgreSQL");
      current = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
      const index = current.forward.findIndex(entry => entry.file === privacyPath);
      expect(index).toBeGreaterThan(0);
      const before = { ...current, forward: current.forward.slice(0, index), objectInventorySha256: "4dc4c0b7a83a4a49a085bf2c243d1e4223daa287912828261ee89c46d1a60627" };
      predecessorRoot = mkdtempSync(join(tmpdir(), "identity-privacy-predecessor-"));
      for (const entry of [before.baseline, ...before.forward]) { const path = join(predecessorRoot, entry.file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, readFileSync(entry.file)); }
      mkdirSync(join(predecessorRoot, "config")); writeFileSync(join(predecessorRoot, "config/platform-migration-manifest.json"), JSON.stringify(before));
      for (const label of ["fresh", "upgrade"]) {
        const container = await runPostgresContainer({ name: `identity-privacy-${label}-${process.pid}`, password: "synthetic-conformance" }); containers.push(container);
        if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Identity privacy PostgreSQL readiness failed");
        pools.push(new Pool({ connectionString: container.connectionString }));
      }
      await runner(1, predecessorRoot).apply();
      await seed(pools[1]);
      const beforeRows = await snapshot(pools[1]);
      await runner(0).apply();
      expect((await runner(1).apply()).applied).toEqual(current.forward.slice(index).map(entry => entry.file));
      expect(await snapshot(pools[1])).toEqual(beforeRows);
      for (const i of [0, 1]) {
        expect((await runner(i).apply()).applied).toEqual([]);
        const ledger = (await pools[i].query("SELECT catalog_path, sha256, position FROM public.platform_schema_migrations ORDER BY position")).rows;
        expect(ledger).toEqual([current.baseline, ...current.forward].map((entry, position) => ({ catalog_path: entry.file, sha256: entry.sha256, position })));
      }
      await seed(pools[0]);
    }, 120000);
    afterAll(async () => { for (const pool of pools) await pool.end(); for (const container of containers) await container.remove(); if (predecessorRoot) rmSync(predecessorRoot, { recursive: true, force: true }); });
    async function seed(pool: Pool) {
      await pool.query(`INSERT INTO public.platform_human_principals (principal_id,email) VALUES ($1,'privacy-admin@example.invalid'),($2,'privacy-subject@example.invalid'),($3,'privacy-other@example.invalid')`, [A,P,O]);
      await pool.query(`INSERT INTO public.platform_human_memberships (principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES ($1,'admin','active','legacy',now()),($2,'distributor','active','legacy',now())`, [A,P]);
      await pool.query(`INSERT INTO public.clients (id,email,principal_id,first_name,last_name,phone,country) VALUES ($1,'privacy-subject@example.invalid',$2,'Example','Person','000','XX'),($3,'privacy-other@example.invalid',$3,NULL,NULL,NULL,NULL)`, [C,P,O]);
      await pool.query("INSERT INTO public.subscriptions (id,client_id,status,cadence_days) VALUES ($1,$2,'active',28)", [S,C]);
    }
    async function snapshot(pool: Pool) { return {
      clients: (await pool.query("SELECT * FROM public.clients ORDER BY id")).rows,
      principals: (await pool.query("SELECT * FROM public.platform_human_principals ORDER BY principal_id")).rows,
      members: (await pool.query("SELECT * FROM public.platform_human_memberships ORDER BY principal_id")).rows,
      subscriptions: (await pool.query("SELECT * FROM public.subscriptions ORDER BY id")).rows,
    }; }
    function binding(index: number, receiptId = K) {
      const unitOfWork = createPostgresPrivacyUnitOfWork({ connectionString: containers[index].connectionString });
      const store = createPostgresPrivacyStore();
      const retainedContactFields = { lifecycle_stage: { owner: "clients", resource: "clients.lifecycle_stage", disposition: "retain" as const, reasonCode: "LIFECYCLE", remote: false } };
      const registry = createPersonalDataContributorRegistry([createIdentityPersonalDataContributor(store, { retainedContactFields }, () => receiptId), createSubscriptionsPrivacyContributor()], { requiredContributorIds: ["identity", "subscriptions"] });
      return { store, unitOfWork, operations: createPrivacyOperations({ store, unitOfWork, registry, now: () => new Date(), randomId: () => receiptId }) };
    }
    it("active/paused veto, rollback, actual challenge redemption, scoped pseudonymization and replay", async () => {
      for (const index of [0,1]) {
        const pool = pools[index], b = binding(index);
        const challengeStore = createPostgresCustomerChallengeStore({ connectionString: containers[index].connectionString });
        const operator = createPostgresOperatorIdentityStore({ connectionString: containers[index].connectionString });
        const invitations = createDirectOperatorInvitationStore({ connectionString: containers[index].connectionString });
        const input = { subject: { kind: "contact" as const, contactId: C }, idempotencyKey: K };
        try {
          for (const [status, code] of [["active","PRIVACY_ACTIVE_SUBSCRIPTION"],["paused","PRIVACY_RESUMABLE_SUBSCRIPTION"]]) {
            await pool.query("UPDATE public.subscriptions SET status = $2 WHERE id = $1", [S,status]); const before = await snapshot(pool);
            await expect(b.operations.erase({ principalId: A }, input)).rejects.toThrow(code);
            expect(await snapshot(pool)).toEqual(before);
          }
          await pool.query("UPDATE public.subscriptions SET status = 'cancelled' WHERE id = $1", [S]);
          await pool.query(`INSERT INTO public.identity_operator_invitations (principal_id,invitation_id,email_key,role,phase,invited_by,invited_at,expires_at) VALUES ($1,$2,'privacy-subject@example.invalid','distributor','invited',$3,now(),now()+interval '1 day')`, [P,K,A]);
          await pool.query(`INSERT INTO public.identity_operator_invitation_events (event_id,invitation_id,principal_id,action,actor_kind,actor_principal_id,old_value,new_value,occurred_at) SELECT $2,$2,$1,'issue','human',$3,'{}',to_jsonb(i),now() FROM public.identity_operator_invitations i WHERE principal_id=$1`, [P,K,A]);
          expect((await challengeStore.issue({ email: "privacy-subject@example.invalid", tokenHash: hash("customer"), expiresAt: new Date(Date.now()+600000).toISOString() })).deliverable).toBe(true);
          await pool.query(`INSERT INTO public.operator_identity_challenges (principal_id,email_fingerprint,token_hash,created_at,expires_at) VALUES ($1,$2,$3,now(),now()+interval '10 minutes')`, [P,hash("privacy-subject@example.invalid"),hash("operator")]);
          const before = await snapshot(pool);
          await pool.query("ALTER TABLE public.identity_privacy_erasures ADD CONSTRAINT synthetic_receipt_failure CHECK (false) NOT VALID");
          try { await expect(b.operations.erase({ principalId: A }, input)).rejects.toThrow(); }
          finally { await pool.query("ALTER TABLE public.identity_privacy_erasures DROP CONSTRAINT synthetic_receipt_failure"); }
          expect(await snapshot(pool)).toEqual(before);
          expect((await pool.query("SELECT * FROM public.customer_identity_challenges WHERE client_id=$1",[C])).rows).toHaveLength(1);
          const receipt = await b.operations.erase({ principalId: A }, input);
          expect(receipt.outcome).toBe("ERASED");
          const contact = (await pool.query("SELECT * FROM public.clients WHERE id=$1",[C])).rows[0];
          expect(contact).toMatchObject({ id:C, principal_id:null, first_name:null,last_name:null,phone:null,country:null });
          expect(contact.email).toBe(`erased+${K}@identity.invalid`);
          expect((await pool.query("SELECT * FROM public.clients WHERE id=$1",[O])).rows[0]).toEqual(before.clients.find(row => row.id===O));
          expect((await pool.query("SELECT * FROM public.subscriptions ORDER BY id")).rows).toEqual(before.subscriptions);
          expect((await pool.query("SELECT membership_state FROM public.platform_human_memberships WHERE principal_id=$1",[P])).rows[0].membership_state).toBe("revoked");
          expect((await pool.query("SELECT * FROM public.customer_identity_challenges WHERE client_id=$1",[C])).rows).toEqual([]);
          expect((await pool.query("SELECT * FROM public.operator_identity_challenges WHERE principal_id=$1",[P])).rows).toEqual([]);
          expect((await pool.query("SELECT public.customer_identity_challenge_redeem($1,now()) AS result",[hash("customer")])).rows[0].result).toBeNull();
          expect(await operator.redeem({ tokenHash: hash("operator") })).toBeNull();
          expect(await challengeStore.redeem({ tokenHash:hash("customer"),now:new Date().toISOString() })).toBeNull();
          expect(await challengeStore.issue({ email:contact.email,tokenHash:hash("after"),expiresAt:new Date(Date.now()+600000).toISOString() })).toEqual({deliverable:false});
          expect((await pool.query("SELECT * FROM public.identity_operator_invitations WHERE principal_id=$1",[P])).rows).toEqual([]);
          expect(JSON.stringify((await pool.query("SELECT old_value,new_value FROM public.identity_operator_invitation_events WHERE principal_id=$1",[P])).rows)).not.toContain("privacy-subject@example.invalid");
          expect(await invitations.issue({actorPrincipalId:A,targetPrincipalId:P,email:contact.email,role:"distributor",ttlSeconds:600})).toEqual({code:"IDENTITY_CONFLICT"});
          expect(await b.operations.erase({principalId:A},input)).toEqual({...receipt,outcome:"ALREADY_ERASED"});
          expect(await b.operations.erase({principalId:A},{...input,subject:{kind:"principal",principalId:P}})).toEqual({...receipt,outcome:"ALREADY_ERASED"});
          await expect(b.operations.erase({principalId:A},{...input,subject:{kind:"contact",contactId:O}})).rejects.toThrow("PRIVACY_IDEMPOTENCY_CONFLICT");
          expect((await pool.query("SELECT * FROM public.identity_privacy_erasures")).rows).toHaveLength(1);
          expect((await pool.query("SELECT * FROM public.platform_human_membership_audit_events WHERE target_principal_id=$1",[P])).rows).toHaveLength(1);
          for (const role of ["anon","authenticated"]) expect((await pool.query("SELECT has_table_privilege($1,'public.identity_privacy_erasures','SELECT,INSERT,UPDATE,DELETE') AS allowed",[role])).rows[0].allowed).toBe(false);
          await pool.query("GRANT SELECT ON public.identity_privacy_erasures TO PUBLIC");
          try { await expect(b.operations.erase({principalId:A},input)).rejects.toThrow("PRIVACY_STORE_PRIVILEGES_UNSAFE"); }
          finally { await pool.query("REVOKE SELECT ON public.identity_privacy_erasures FROM PUBLIC"); }
        } finally { await b.unitOfWork.close(); await challengeStore.close(); await invitations.close(); await operator.close(); }
      }
    },120000);
    it.each(["contact", "principal"] as const)("late raw issuance cannot re-link through package redemption with a %s receipt", async receiptKind => {
      const pool = pools[0], issuer = await pool.connect(), eraser = await pool.connect();
      const contactId = receiptKind === "contact" ? "d4300000-0000-4000-8000-000000000011" : "d4300000-0000-4000-8000-000000000012";
      const principalId = receiptKind === "contact" ? "d4300000-0000-4000-8000-000000000021" : "d4300000-0000-4000-8000-000000000022";
      const otherContactId = "d4300000-0000-4000-8000-000000000032";
      const email = `${receiptKind}@example.invalid`, tokenHash = hash(`late-${receiptKind}`);
      const b = binding(0, contactId);
      const challengePool = new Pool({ connectionString: containers[0].connectionString, options: "-c lock_timeout=100ms" });
      const store = createPostgresCustomerChallengeStore({ connectionString: containers[0].connectionString }, { poolFactory: () => challengePool });
      try {
        await pool.query("INSERT INTO public.platform_human_principals (principal_id,email) VALUES ($1,$2)", [principalId,email]);
        await pool.query("INSERT INTO public.clients (id,email,principal_id) VALUES ($1,$2,$3)", [contactId,email,principalId]);
        // Model the retained SQL issuer paused after its contact read, before its INSERT.
        await issuer.query("BEGIN");
        const stale = (await issuer.query("SELECT id,principal_id,email FROM public.clients WHERE id=$1", [contactId])).rows[0];
        expect(await b.operations.erase({ principalId: A }, { subject: { kind: "contact", contactId }, idempotencyKey: contactId })).toMatchObject({ outcome: "ERASED" });
        // A separate contact exercises principal fencing independently of contact fencing.
        const challengeContactId = receiptKind === "contact" ? stale.id : otherContactId;
        if (receiptKind === "principal") await pool.query("INSERT INTO public.clients (id,email,principal_id) VALUES ($1,$2,$3)", [otherContactId,"other-late@example.invalid",principalId]);
        await issuer.query(`INSERT INTO public.customer_identity_challenges
          (client_id,principal_id,email_fingerprint,token_hash,created_at,expires_at)
          VALUES ($1,$2,$3,$4,clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '10 minutes')`, [challengeContactId,stale.principal_id,hash(stale.email),tokenHash]);
        await issuer.query("COMMIT");
        // Erasure's EXCLUSIVE challenge lock must exclude the adapter before its receipt read/RPC.
        await eraser.query("BEGIN");
        await createPostgresPrivacyStore().prepareErasure(eraser);
        await expect(store.redeem({ tokenHash, now: new Date().toISOString() })).rejects.toMatchObject({ code: "55P03" });
        await eraser.query("ROLLBACK");
        expect(await store.redeem({ tokenHash, now: new Date().toISOString() })).toBeNull();
        expect((await pool.query("SELECT principal_id FROM public.clients WHERE id=$1", [contactId])).rows[0].principal_id).toBeNull();
        expect((await pool.query("SELECT used_at FROM public.customer_identity_challenges WHERE token_hash=$1", [tokenHash])).rows[0].used_at).toBeNull();
        const currentEmail = (await pool.query("SELECT email FROM public.clients WHERE id=$1", [challengeContactId])).rows[0].email;
        expect(await store.issue({ email: currentEmail, tokenHash: hash(`refused-${receiptKind}`), expiresAt: new Date(Date.now()+600000).toISOString() })).toEqual({ deliverable: false });
      } finally {
        await issuer.query("ROLLBACK"); await eraser.query("ROLLBACK");
        issuer.release(); eraser.release(); await b.unitOfWork.close(); await store.close();
      }
    });
    it("already revoked operators redact retained free text without another revocation", async () => {
      const pool = pools[0], b = binding(0, O);
      try {
        await pool.query(`INSERT INTO public.platform_human_memberships
          (principal_id,role,membership_state,membership_provenance,membership_accepted_at,membership_revoked_at,membership_revoked_by,membership_revocation_reason)
          VALUES ($1,'distributor','revoked','legacy',now()-interval '1 day',now(),$2,'privacy-other@example.invalid')`, [O,A]);
        await b.operations.erase({principalId:A},{subject:{kind:"contact",contactId:O},idempotencyKey:O});
        expect((await pool.query("SELECT role,membership_state,membership_revocation_reason FROM public.platform_human_memberships WHERE principal_id=$1",[O])).rows[0]).toEqual({role:"distributor",membership_state:"revoked",membership_revocation_reason:null});
        expect((await pool.query("SELECT * FROM public.platform_human_membership_audit_events WHERE target_principal_id=$1",[O])).rows).toEqual([]);
      } finally { await b.unitOfWork.close(); }
    });
    it("subscription activation cannot cross the held assessment lock", async () => {
      const pool = pools[0], reader = await pool.connect(), writer = await pool.connect();
      try {
        await reader.query("BEGIN"); await createSubscriptionsPrivacyContributor().prepareErasure(reader);
        await writer.query("BEGIN"); await writer.query("SET LOCAL lock_timeout='100ms'");
        await expect(writer.query("UPDATE public.subscriptions SET status='active' WHERE id=$1",[S])).rejects.toMatchObject({code:"55P03"});
        await writer.query("ROLLBACK"); await reader.query("COMMIT");
        await writer.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1",[S]);
      } finally { await reader.query("ROLLBACK"); await writer.query("ROLLBACK"); reader.release(); writer.release(); }
    });
    it("an already-running raw redemption holds erasure before any contact read", async () => {
      const pool = pools[0], redeemer = await pool.connect(), eraser = await pool.connect();
      try {
        await redeemer.query("BEGIN");
        await redeemer.query("SELECT * FROM public.customer_identity_challenges FOR UPDATE");
        await eraser.query("BEGIN"); await eraser.query("SET LOCAL lock_timeout='100ms'");
        await expect(eraser.query("LOCK TABLE public.customer_identity_challenges IN EXCLUSIVE MODE")).rejects.toMatchObject({code:"55P03"});
      } finally { await redeemer.query("ROLLBACK"); await eraser.query("ROLLBACK"); redeemer.release(); eraser.release(); }
    });
  });
}
