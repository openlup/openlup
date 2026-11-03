import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresOperatorAuthority } from "@openlup/platform/account-support";
import { createPostgresSubscriptionCommandStore } from "@openlup/platform/subscriptions";
import { QUALIFIED_LOCK_AND_CONFLICT_COMPLETION_FILE } from "../../scripts/platform-migration-manifest.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import {
  qualifiedAdminPostgresStartupOptions, qualifiedPostgresStartupOptions,
  type QualifiedAdminPostgresInstallation, type QualifiedPostgresInstallation,
} from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { AT, later, renewal } from "./subscriptionNativeFixture.js";

// One generation per installer shape: superuser installer and operator-provisioned non-superuser M.
// The shared inventory witness measures every qualified role mode's grants, policies and row security.
const TABLE = "public.subscription_renewal_term_lines";
const password = "synthetic-runtime-lock";

for (const generation of ["qualified-v2", "qualified-admin"] as const) describe(`qualified runtime lock and conflict completion on ${generation}`, () => {
  let container: PostgresContainer | undefined;
  const pools: Pool[] = [];
  let owner: Pool, runtime: Pool, selection: QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation;
  const url = (name: string) => { const value = new URL(container!.connectionString); value.username = name; return value.toString(); };
  const pool = (connectionString: string, options?: string) => { const value = new Pool({ connectionString, options, max: 2 }); pools.push(value); return value; };

  beforeAll(async () => {
    container = await runPostgresContainer({ name: `qualified-runtime-lock-${generation}-${process.pid}`, password });
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const bootstrap = pool(container.connectionString);
    for (const role of ["lock_runtime", "lock_restore"]) await bootstrap.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    const principals = { bootstrapLogin: "postgres", runtimeLogin: "lock_runtime", restoreLogin: "lock_restore" };
    if (generation === "qualified-v2") {
      selection = { generation, roleMode: "installer-managed", migrationLogin: "postgres", ...principals };
    } else {
      await bootstrap.query(`CREATE ROLE lock_migration LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await bootstrap.query("ALTER DATABASE postgres OWNER TO lock_migration");
      await bootstrap.query(`CREATE ROLE lock_operator LOGIN NOINHERIT CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      const operator = pool(url("lock_operator"));
      for (const group of ["anon", "authenticated", "service_role", "platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"]) {
        await bootstrap.query(`CREATE ROLE ${group} NOLOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS; GRANT ${group} TO lock_operator WITH ADMIN TRUE,INHERIT FALSE,SET FALSE`);
        await operator.query(`GRANT ${group} TO lock_migration WITH ADMIN TRUE,INHERIT FALSE,SET FALSE GRANTED BY lock_operator`);
        if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(group)) {
          await operator.query(`GRANT ${group} TO lock_runtime WITH ADMIN FALSE,INHERIT ${group === "service_role" ? "TRUE" : "FALSE"},SET TRUE GRANTED BY lock_operator`);
        }
      }
      selection = { generation, roleMode: "operator-provisioned", operatorLogin: "lock_operator", migrationLogin: "lock_migration", ...principals };
    }
    owner = pool(url(selection.migrationLogin), selection.generation === "qualified-v2"
      ? qualifiedPostgresStartupOptions(selection) : qualifiedAdminPostgresStartupOptions(selection));
    await createPostgresMigrationRunner({ connectionString: url(selection.migrationLogin) }, { installation: selection, poolFactory: () => owner }).apply();
    runtime = pool(url("lock_runtime"), "-c lock_timeout=2s");
  }, postgresSetupTimeoutMs);
  afterAll(async () => { await closePostgres(container, pools); }, postgresTeardownTimeoutMs);

  async function fixture() {
    const f = await renewal(owner);
    await owner.query("DELETE FROM public.subscription_renewal_operations WHERE id=$1", [f.operation]);
    await owner.query("UPDATE public.subscriptions SET next_cycle_at=$2,started_at='2026-01-01' WHERE id=$1", [f.subscription, later(240)]);
    await owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [f.subscription]);
    return { ...f, actor: randomUUID() };
  }
  const lines = (subscription: string) => owner.query(`SELECT line_ordinal,sku,quantity,unit_amount_minor,created_at,updated_at FROM ${TABLE}
    WHERE subscription_id=$1 ORDER BY line_ordinal`, [subscription]).then(result => result.rows);
  const receipts = (actor: string) => owner.query(`SELECT command->>'action' AS action,status FROM public.subscription_command_receipts
    WHERE actor_id=$1 ORDER BY created_at,id`, [actor]).then(result => result.rows);
  const reach = (relation: string) => owner.query(`SELECT rolname FROM pg_roles r WHERE rolname !~ '^pg_'
    AND (has_table_privilege(r.oid,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(r.oid,$1,'SELECT,INSERT,UPDATE,REFERENCES')) ORDER BY 1`, [relation]).then(result => result.rows.map(row => row.rolname));
  const reachers = () => [...(generation === "qualified-admin" ? ["lock_migration"] : []), "lock_runtime", "postgres", "service_role"];
  const grants = (relation: string) => owner.query(`SELECT 'table' AS kind,NULL::name AS attname,pg_get_userbyid(a.grantee) AS grantee,a.privilege_type AS privilege
      FROM pg_class c,aclexplode(c.relacl) a WHERE c.oid=$1::regclass AND a.grantee<>c.relowner
    UNION ALL SELECT 'column',t.attname,pg_get_userbyid(x.grantee),x.privilege_type FROM pg_attribute t,aclexplode(t.attacl) x
      WHERE t.attrelid=$1::regclass AND t.attacl IS NOT NULL ORDER BY 1,2,3,4`, [relation]).then(result => result.rows);
  const policies = (table: string) => owner.query(`SELECT policyname,cmd,roles::text,qual,with_check FROM pg_policies
    WHERE schemaname='public' AND tablename=$1 ORDER BY 1`, [table]).then(result => result.rows);
  const operatorFixture = async () => {
    const operatorId = randomUUID(), principal = randomUUID();
    await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2),($3,$4)", [operatorId, `${operatorId}@example.invalid`, principal, `${principal}@example.invalid`]);
    await owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',$2)", [operatorId, AT]);
    await owner.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)", [operatorId]);
    return { operatorId, principal };
  };

  it("binds row security and enumerates every role with access to the term lines", async () => {
    expect((await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user")).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    expect((await owner.query("SELECT relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=$1::regclass", [TABLE])).rows)
      .toEqual([{ relrowsecurity: true, relforcerowsecurity: false, owner: selection.migrationLogin }]);
    expect((await owner.query(`SELECT policyname,cmd,roles::text,qual,with_check FROM pg_policies
      WHERE schemaname='public' AND tablename='subscription_renewal_term_lines' ORDER BY 1`)).rows).toEqual([
      { policyname: "qualified_rt_term_lines_delete", cmd: "DELETE", roles: "{service_role}", qual: "true", with_check: null },
      { policyname: "qualified_rt_term_lines_insert", cmd: "INSERT", roles: "{service_role}", qual: null, with_check: "true" },
      { policyname: "qualified_rt_term_lines_select", cmd: "SELECT", roles: "{service_role}", qual: "true", with_check: null },
      { policyname: "qualified_rt_term_lines_update_lock_only", cmd: "UPDATE", roles: "{service_role}", qual: "true", with_check: "false" },
    ]);
    expect((await owner.query(`SELECT pg_get_userbyid(a.grantee) AS grantee,a.privilege_type AS privilege FROM pg_class c,aclexplode(c.relacl) a
      WHERE c.oid=$1::regclass AND a.grantee<>c.relowner ORDER BY 1,2`, [TABLE])).rows)
      .toEqual(["DELETE", "INSERT", "SELECT"].map(privilege => ({ grantee: "service_role", privilege })));
    expect((await owner.query(`SELECT a.attname,pg_get_userbyid(x.grantee) AS grantee,x.privilege_type AS privilege FROM pg_attribute a,aclexplode(a.attacl) x
      WHERE a.attrelid=$1::regclass AND a.attacl IS NOT NULL ORDER BY 1,2,3`, [TABLE])).rows)
      .toEqual([{ attname: "updated_at", grantee: "service_role", privilege: "UPDATE" }]);
    // Every non-predefined role whose effective privileges reach the table, inherited ones included.
    expect((await owner.query(`SELECT rolname,rolsuper FROM pg_roles r WHERE rolname !~ '^pg_'
      AND (has_table_privilege(r.oid,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(r.oid,$1,'SELECT,INSERT,UPDATE,REFERENCES')) ORDER BY 1`, [TABLE])).rows).toEqual([
      ...(generation === "qualified-admin" ? [{ rolname: "lock_migration", rolsuper: false }] : []),
      { rolname: "lock_runtime", rolsuper: false }, { rolname: "postgres", rolsuper: true }, { rolname: "service_role", rolsuper: false },
    ]);
    for (const role of ["anon", "authenticated", "lock_restore"]) {
      expect((await owner.query(`SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_access,
        has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') AS column_access`, [role, TABLE])).rows, role)
        .toEqual([{ table_access: false, column_access: false }]);
    }
    const allowed = async (privilege: string, column?: string) => (await owner.query(column
      ? "SELECT has_column_privilege('lock_runtime',$1,$2,$3) AS allowed" : "SELECT has_table_privilege('lock_runtime',$1,$2) AS allowed",
      column ? [TABLE, column, privilege] : [TABLE, privilege])).rows[0].allowed;
    expect({ select: await allowed("SELECT"), insert: await allowed("INSERT"), delete: await allowed("DELETE"), update: await allowed("UPDATE"), truncate: await allowed("TRUNCATE") })
      .toEqual({ select: true, insert: true, delete: true, update: false, truncate: false });
    for (const column of ["subscription_id", "line_ordinal", "sku", "quantity", "unit_amount_minor", "created_at"]) expect(await allowed("UPDATE", column), column).toBe(false);
    expect(await allowed("UPDATE", "updated_at")).toBe(true);
    // Once row security is bound, the unit's own guard refuses a second application.
    await expect(owner.query(readFileSync(QUALIFIED_LOCK_AND_CONFLICT_COMPLETION_FILE, "utf8"))).rejects.toMatchObject({ code: "42501", message: "runtime_lock_completion_installer_must_own_targets" });
  });

  it("applies pause, resume, slide and cancel through the customer command store with receipts", async () => {
    const store = createPostgresSubscriptionCommandStore({ async withTransaction(work) {
      const client = await runtime.connect();
      try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    } });
    const f = await fixture(), before = await lines(f.subscription);
    const apply = (action: string, payload: Record<string, unknown> = {}) => store.apply({ actorId: f.actor, clientId: f.client, subscriptionId: f.subscription,
      idempotencyKey: `customer-${action}-${randomUUID()}`, action, payload, now: AT });
    expect(await apply("pause")).toMatchObject({ status: "applied", subscriptionStatus: "paused" });
    expect(await apply("resume")).toMatchObject({ status: "applied", subscriptionStatus: "active" });
    expect(await apply("slide_next_cycle", { newNextCycleAt: later(300) })).toMatchObject({ status: "applied", subscriptionStatus: "active" });
    expect(await apply("cancel")).toMatchObject({ status: "applied", subscriptionStatus: "cancelled" });
    expect(await receipts(f.actor)).toEqual(["pause", "resume", "slide_next_cycle", "cancel"].map(action => ({ action, status: "applied" })));
    expect(await lines(f.subscription)).toEqual(before);
  });

  it("applies pause, resume and slide through the operator support wrapper with owner receipts", async () => {
    const f = await fixture(), { operatorId, principal } = await operatorFixture(), before = await lines(f.subscription);
    await owner.query("UPDATE public.clients SET principal_id=$2,lifecycle_stage='customer' WHERE id=$1", [f.client, principal]);
    const authority = createPostgresOperatorAuthority({ run: work => work(runtime) }, { operatorId, now: () => Date.parse(AT), recoveryPath: token => `/repair?token=${token}` });
    const apply = (subscriptionAction: "pause" | "resume" | "slide_next_cycle", payload: Record<string, unknown>, expectedVersion: number) =>
      authority.applySubscriptionAction({ operatorId, subscriptionId: f.subscription, subscriptionAction, payload, expectedVersion,
        idempotencyKey: `operator-${subscriptionAction}-${randomUUID()}` });
    const version = (result: unknown) => (result as { templateVersion: number }).templateVersion;
    const paused = await apply("pause", { pausePreset: "indefinite", reason: "customer request" }, 1);
    expect(paused).toMatchObject({ outcome: "applied", subscriptionStatus: "paused", ownerReceipt: { actorId: operatorId } });
    const resumed = await apply("resume", {}, version(paused));
    expect(resumed).toMatchObject({ outcome: "applied", subscriptionStatus: "active", ownerReceipt: { actorId: operatorId } });
    expect(await apply("slide_next_cycle", { newNextCycleAt: later(300) }, version(resumed)))
      .toMatchObject({ outcome: "applied", subscriptionStatus: "active", ownerReceipt: { actorId: operatorId } });
    expect(await receipts(operatorId)).toEqual(["pause", "resume", "slide_next_cycle"].map(action => ({ action, status: "applied" })));
    expect(await lines(f.subscription)).toEqual(before);
  });

  it("refuses every actual update while keeping reads, row locks, inserts and deletes", async () => {
    const f = await fixture(), before = await lines(f.subscription);
    for (const [sql, args] of [
      [`UPDATE ${TABLE} SET updated_at=updated_at WHERE subscription_id=$1`, [f.subscription]],
      [`UPDATE ${TABLE} SET updated_at=now()`, []],
      [`UPDATE ${TABLE} SET sku=sku WHERE subscription_id=$1`, [f.subscription]],
      [`UPDATE ${TABLE} SET subscription_id=subscription_id WHERE subscription_id=$1`, [f.subscription]],
      [`INSERT INTO ${TABLE}(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,'conflict',1,1)
        ON CONFLICT (subscription_id,line_ordinal) DO UPDATE SET updated_at=excluded.updated_at`, [f.subscription]],
    ] as const) await expect(runtime.query(sql, [...args]), sql).rejects.toMatchObject({ code: "42501" });
    expect(await lines(f.subscription)).toEqual(before);
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      expect((await client.query(`SELECT line_ordinal FROM ${TABLE} WHERE subscription_id=$1 ORDER BY line_ordinal FOR UPDATE`, [f.subscription])).rows).toEqual([{ line_ordinal: 1 }]);
      expect((await client.query(`INSERT INTO ${TABLE}(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,2,'SKU-lock-witness',1,1)`, [f.subscription])).rowCount).toBe(1);
      expect((await client.query(`DELETE FROM ${TABLE} WHERE subscription_id=$1 AND line_ordinal=2`, [f.subscription])).rowCount).toBe(1);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    expect(await lines(f.subscription)).toEqual(before);
  });

  it("binds the recovery, control and claim-event targets and enumerates every role with access", async () => {
    for (const [table, prefix, column] of [["customer_recovery_commands", "recovery_commands", "created_at"], ["platform_control_operations", "control_operations", "created_at"]] as const) {
      const relation = `public.${table}`;
      expect((await owner.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass", [relation])).rows, table).toEqual([{ relrowsecurity: true, relforcerowsecurity: false }]);
      expect(await policies(table), table).toEqual([
        { policyname: `qualified_rt_${prefix}_insert`, cmd: "INSERT", roles: "{service_role}", qual: null, with_check: "true" },
        { policyname: `qualified_rt_${prefix}_select`, cmd: "SELECT", roles: "{service_role}", qual: "true", with_check: null },
        { policyname: `qualified_rt_${prefix}_update_lock_only`, cmd: "UPDATE", roles: "{service_role}", qual: "true", with_check: "false" },
      ]);
      expect(await grants(relation), table).toEqual([
        { kind: "column", attname: column, grantee: "service_role", privilege: "UPDATE" },
        ...["INSERT", "SELECT"].map(privilege => ({ kind: "table", attname: null, grantee: "service_role", privilege })),
      ]);
      expect(await reach(relation), table).toEqual(reachers());
    }
    const events = "public.commerce_promotion_claim_events";
    expect((await owner.query("SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass", [events])).rows).toEqual([{ relrowsecurity: false }]);
    expect(await policies("commerce_promotion_claim_events")).toEqual([]);
    expect(await grants(events)).toEqual([
      { kind: "column", attname: "claim_id", grantee: "service_role", privilege: "SELECT" },
      { kind: "column", attname: "event_key", grantee: "service_role", privilege: "SELECT" },
      { kind: "table", attname: null, grantee: "service_role", privilege: "INSERT" },
    ]);
    expect(await reach(events)).toEqual(reachers());
    for (const relation of ["public.customer_recovery_commands", "public.platform_control_operations", events]) for (const role of ["anon", "authenticated", "lock_restore"]) {
      expect((await owner.query(`SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_access,
        has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') AS column_access`, [role, relation])).rows, `${role} ${relation}`)
        .toEqual([{ table_access: false, column_access: false }]);
    }
  });

  it("issues and replays an operator recovery as the runtime while refusing receipt updates", async () => {
    const { operatorId } = await operatorFixture();
    const customer = randomUUID(), subscription = randomUUID(), cycle = randomUUID(), order = randomUUID(), caseId = randomUUID(), key = `recover-${randomUUID()}`;
    await owner.query("INSERT INTO public.clients(id,email,lifecycle_stage) VALUES($1,$2,'customer')", [customer, `${customer}@example.invalid`]);
    await owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,status,started_at,next_cycle_at) VALUES($1,$2,28,'active',now()-interval '1 month',now()+interval '7 days')", [subscription, customer]);
    await owner.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,now(),'payment_pending')", [cycle, subscription]);
    const setup = await owner.connect();
    try {
      await setup.query("BEGIN");
      await setup.query("INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,status,currency_code,total_amount_minor) VALUES($1,$2,$3,'pending_payment','XTS',100)", [order, customer, cycle]);
      await setup.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,100,100)", [order]);
      await setup.query("COMMIT");
    } catch (error) { await setup.query("ROLLBACK"); throw error; } finally { setup.release(); }
    await owner.query("INSERT INTO public.subscription_dunning_cases(id,subscription_id,cycle_id,client_id,idempotency_key) VALUES($1,$2,$3,$4,$5)", [caseId, subscription, cycle, customer, `case-${caseId}`]);
    await owner.query("INSERT INTO public.subscription_dunning_notifications(case_id,subscription_id,recipient_ref,notification_kind,template_slug) VALUES($1,$2,$3,'payment_failed','fixture')", [caseId, subscription, customer]);
    const issue = (token: string) => runtime.query("SELECT public.customer_support_issue_recovery($1,$2,$3,$4,$5,$6,now()+interval '1 day','/repair') AS result",
      [operatorId, customer, caseId, key, "a".repeat(64), token]).then(result => result.rows[0].result);
    const issued = await issue("b".repeat(64));
    expect(issued).toMatchObject({ outcome: "issued" });
    expect(await issue("c".repeat(64))).toEqual({ ...issued, outcome: "replayed" });
    expect((await owner.query("SELECT count(*)::int AS count FROM public.customer_recovery_commands WHERE idempotency_key=$1", [key])).rows).toEqual([{ count: 1 }]);
    await expect(runtime.query("UPDATE public.customer_recovery_commands SET created_at=created_at WHERE idempotency_key=$1", [key])).rejects.toMatchObject({ code: "55000" });
    await expect(runtime.query("UPDATE public.customer_recovery_commands SET response=response WHERE idempotency_key=$1", [key])).rejects.toMatchObject({ code: "42501" });
  });

  it("records and replays platform control writes as the runtime while refusing receipt updates", async () => {
    const operatorId = randomUUID(), setKey = `set-${randomUUID()}`, beatKey = `beat-${randomUUID()}`;
    await owner.query("INSERT INTO public.platform_control_operators(principal_id,active) VALUES($1,true)", [operatorId]);
    const set = () => runtime.query("SELECT * FROM public.platform_control_set_control($1,$2,$3,'fixture',true)", [operatorId, setKey, "b".repeat(64)]).then(result => result.rows);
    const beat = () => runtime.query("SELECT * FROM public.platform_control_record_heartbeat($1,$2,$3,'healthy',0,NULL,true)", [operatorId, beatKey, "c".repeat(64)]).then(result => result.rows);
    const first = await set();
    expect(first).toMatchObject([{ action: "set-control", replayed: false, revision: 1 }]);
    expect(await set()).toEqual([{ ...first[0], replayed: true }]);
    const recorded = await beat();
    expect(recorded).toMatchObject([{ action: "record-heartbeat", replayed: false }]);
    expect(await beat()).toEqual([{ ...recorded[0], replayed: true }]);
    expect((await owner.query("SELECT action FROM public.platform_control_operations WHERE idempotency_key IN ($1,$2) ORDER BY action", [setKey, beatKey])).rows)
      .toEqual([{ action: "record-heartbeat" }, { action: "set-control" }]);
    for (const sql of ["UPDATE public.platform_control_operations SET created_at=created_at WHERE idempotency_key=$1", "UPDATE public.platform_control_operations SET response=response WHERE idempotency_key=$1"]) {
      await expect(runtime.query(sql, [setKey]), sql).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("settles an order with a promotion claim as the runtime with exactly one event and no replay duplicate", async () => {
    const buyer = randomUUID(), order = randomUUID(), promotion = `lock-${randomUUID()}`;
    await owner.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [buyer, `${buyer}@example.invalid`]);
    await owner.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES($1,$2,true)", [promotion, { id: promotion, status: "active", code: null,
      name: "Example discount", trigger_type: "automatic", discount_type: "percentage", discount_value: 10, applies_to_kind: "order_total", applies_to_payload: {},
      stacking_rule: "exclusive", eligibility: {}, valid_from: "2026-01-01T00:00:00Z", valid_to: null, region_availability: ["ZZ"],
      redemption_limit_global: null, redemption_limit_per_customer: null }]);
    const setup = await owner.connect();
    try {
      await setup.query("BEGIN");
      await setup.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',900)", [order, buyer]);
      await setup.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,900,900)", [order]);
      const adjustment = (await setup.query(`INSERT INTO public.commerce_order_adjustments(order_id,kind,scope,amount_minor,promotion_id,definition_fingerprint)
        SELECT $1,'promotion_discount','order_total',100,promotion_id,definition_fingerprint FROM public.commerce_promotion_definitions WHERE promotion_id=$2 RETURNING id`, [order, promotion])).rows[0].id;
      await setup.query(`INSERT INTO public.commerce_promotion_claims(promotion_id,definition_fingerprint,adjustment_id,order_id,client_id,amount_off_minor,reserved_at,expires_at)
        SELECT promotion_id,definition_fingerprint,$1,$2,$3,100,now()-interval '1 hour',now()+interval '1 hour' FROM public.commerce_promotion_definitions WHERE promotion_id=$4`, [adjustment, order, buyer, promotion]);
      await setup.query("COMMIT");
    } catch (error) { await setup.query("ROLLBACK"); throw error; } finally { setup.release(); }
    const events = () => owner.query(`SELECT e.event_key,e.transition FROM public.commerce_promotion_claim_events e
      JOIN public.commerce_promotion_claims c ON c.id=e.claim_id WHERE c.order_id=$1 ORDER BY 1`, [order]).then(result => result.rows);
    const settle = (status: string) => runtime.query("UPDATE public.commerce_orders SET status=$2,paid_at=COALESCE(paid_at,now()) WHERE id=$1", [order, status]);
    await settle("paid");
    expect(await events()).toEqual([{ event_key: "redeemed:paid", transition: "redeemed" }]);
    expect((await owner.query("SELECT status FROM public.commerce_promotion_claims WHERE order_id=$1", [order])).rows).toEqual([{ status: "redeemed" }]);
    await settle("paid");
    await settle("fulfillment_pending");
    expect(await events()).toEqual([{ event_key: "redeemed:paid", transition: "redeemed" }]);
    const claim = (await owner.query("SELECT id FROM public.commerce_promotion_claims WHERE order_id=$1", [order])).rows[0].id;
    expect((await runtime.query(`INSERT INTO public.commerce_promotion_claim_events(claim_id,event_key,transition) VALUES($1,'redeemed:paid','redeemed')
      ON CONFLICT (claim_id,event_key) DO NOTHING`, [claim])).rowCount).toBe(0);
    expect((await runtime.query("SELECT claim_id,event_key FROM public.commerce_promotion_claim_events WHERE claim_id=$1", [claim])).rows).toEqual([{ claim_id: claim, event_key: "redeemed:paid" }]);
    for (const sql of [
      "SELECT transition FROM public.commerce_promotion_claim_events WHERE claim_id=$1",
      "SELECT claim_id FROM public.commerce_promotion_claim_events WHERE claim_id=$1 FOR UPDATE",
      "UPDATE public.commerce_promotion_claim_events SET event_key=event_key WHERE claim_id=$1",
      "DELETE FROM public.commerce_promotion_claim_events WHERE claim_id=$1",
    ]) await expect(runtime.query(sql, [claim]), sql).rejects.toMatchObject({ code: "42501" });
    expect(await events()).toEqual([{ event_key: "redeemed:paid", transition: "redeemed" }]);
  });
});
