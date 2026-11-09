import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { beforeAll, expect, it } from "vitest";
import { createCommunicationPurposeRegistry, createPostgresCommunicationSyncStore, createPostgresConsentEvaluator, createPostgresDeliveryReconciliationPort, runCommunicationSyncDispatch } from "@openlup/platform/communications";
import { createPostgresOutboxStore } from "@openlup/outbox/postgres";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresCatalogPayload, qualifiedAdminPostgresCatalogPayload, qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions, type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { closePostgres, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";

const file = "db/platform/migrations/20261101232000_customer_account_consents.sql";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const purposes = ["marketing_newsletter", "marketing_gifts_discounts"] as const;
const tables = ["customer_communication_preferences", "customer_communication_preference_events", "communication_recipient_consents", "customer_account_consent_events", "communication_native_sync_state", "outbox_events"];
const registry = createCommunicationPurposeRegistry([{ id: "marketing_gifts_discounts", classification: "marketing" }]);
const profiles = ["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"] as const;
beforeAll(async () => { if (!await dockerAvailable()) throw new Error("Account consents require real PostgreSQL"); // Solo without coverage across the five modes: 3.32–5.42 s; 30 s exceeds three times the maximum.
}, 30_000);

it.each(profiles)("atomic actor account choices and refusals on %s", async profile => {
  const container = await runPostgresContainer({ name: `account-consents-${profile}-${process.pid}`, password: "synthetic-conformance" });
  const pools: Pool[] = [], closers: (() => Promise<unknown>)[] = [];
  const pool = (url: string, options?: string) => { const value = new Pool({ connectionString: url, options }); pools.push(value); return value; };
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Account consent PostgreSQL unavailable");
    const owner = pool(container.connectionString), password = randomUUID();
    const m = "consent_m", r = "consent_r", s = "consent_s", o = "consent_o";
    const admin = profile.startsWith("admin-"), separate = profile === "separate" || admin;
    const operatorMode = profile === "admin-operator";
    const login = (name: string) => { const url = new URL(container.connectionString); url.username = name; if (name !== "postgres") url.password = password; return url.toString(); };
    if (separate) {
      await owner.query(`CREATE ROLE ${m} LOGIN ${admin ? "NOINHERIT NOSUPERUSER" : "INHERIT SUPERUSER"} ${admin && !operatorMode ? "CREATEROLE" : "NOCREATEROLE"} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await owner.query(`ALTER DATABASE postgres OWNER TO ${m}`);
    }
    if (profile !== "legacy") {
      for (const name of [r, s]) await owner.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    }
    if (operatorMode) {
      await owner.query(`CREATE ROLE ${o} LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      const operator = pool(login(o));
      for (const group of ["anon", "authenticated", "service_role", "platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"]) {
        await owner.query(`CREATE ROLE ${group} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`);
        await owner.query(`GRANT ${group} TO ${o} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
        await operator.query(`GRANT ${group} TO ${m} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ${o}`);
        if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(group)) await operator.query(`GRANT ${group} TO ${r} WITH ADMIN FALSE, INHERIT ${group === "service_role" ? "TRUE" : "FALSE"}, SET TRUE GRANTED BY ${o}`);
      }
    }
    const installation: { generation: "legacy" } | QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation = profile === "legacy" ? { generation: "legacy" }
      : admin ? operatorMode
        ? { generation: "qualified-admin", roleMode: "operator-provisioned", bootstrapLogin: "postgres", migrationLogin: m, runtimeLogin: r, restoreLogin: s, operatorLogin: o }
        : { generation: "qualified-admin", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: m, runtimeLogin: r, restoreLogin: s }
      : { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: separate ? m : "postgres", runtimeLogin: r, restoreLogin: s };
    const migrationUrl = login(installation.generation === "legacy" ? "postgres" : installation.migrationLogin);
    const migrator = pool(migrationUrl, installation.generation === "qualified-v2" ? qualifiedPostgresStartupOptions(installation) : installation.generation === "qualified-admin" ? qualifiedAdminPostgresStartupOptions(installation) : undefined);
    const runner = createPostgresMigrationRunner({ connectionString: migrationUrl }, { installation, poolFactory: () => migrator,
      catalogProjectionPayload: async client => {
        const payload = installation.generation === "qualified-v2" ? await qualifiedPostgresCatalogPayload(client, installation, "openlup:public-platform-migrations:v1")
          : installation.generation === "qualified-admin" ? await qualifiedAdminPostgresCatalogPayload(client, installation, "openlup:public-platform-migrations:v1")
          : selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
        // Actual canonical projector, including ACLs/roles: diagnostic for forward inventory refresh.
        mkdirSync(".context/scratch/g11c", { recursive: true });
        writeFileSync(`.context/scratch/g11c/inventory-${profile}.json`, JSON.stringify({ profile, sha256: hash(payload) }));
        return payload;
      } });
    await runner.apply();
    expect((await runner.apply()).applied).toEqual([]);
    // Package editing follows timed auto-resume delivered history in every plan; qualified plans also retain their completion tail.
    const tail = [{ catalog_path: "db/platform/migrations/20261109150000_subscription_auto_resume_paid_history.sql" },
      { catalog_path: "db/platform/migrations/20261109130000_subscription_exact_levers.sql" },
      { catalog_path: "db/platform/migrations/20261109120000_subscription_package_editor.sql" },
      { catalog_path: "db/platform/migrations/20261109113000_subscription_auto_resume_delivered_history.sql" },
      { catalog_path: "db/platform/migrations/20261109110000_checkout_recovery_link_lifecycle.sql" },
      { catalog_path: "db/platform/migrations/20261109100000_subscription_retry_resume.sql" },
      { catalog_path: "db/platform/migrations/20261106140000_subscriber_winback_policy.sql" },
      { catalog_path: "db/platform/migrations/20261106120000_subscription_notice_producers.sql" },
      { catalog_path: "db/platform/migrations/20261106100000_subscription_lifecycle_closure.sql" },
      { catalog_path: "db/platform/migrations/20261106060000_subscription_retry_recovery_truth.sql" },
      { catalog_path: "db/platform/migrations/20261106050000_customer_command_key_isolation.sql" },
      ...(profile === "legacy" ? [] : [{ catalog_path: "db/platform/migrations/q2_20261103200000_runtime_lock_and_conflict_completion.sql" }])];
    const ledger = (await owner.query("SELECT catalog_path FROM public.platform_schema_migrations ORDER BY position DESC LIMIT $1", [tail.length + 1])).rows;
    expect(ledger).toEqual([...tail, { catalog_path: file }]);
    const served = (await owner.query("SELECT prosrc FROM pg_proc WHERE oid='public.customer_communication_preferences_set_as_actor(boolean,timestamptz)'::regprocedure")).rows[0].prosrc;
    expect(readFileSync("db/platform/migrations/20261030110000_customer_newsletter_withdrawal.sql", "utf8")).toContain(`AS $$${served}$$;`);
    const header = (await owner.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.customer_account_communication_choice_set_as_actor(uuid,text,boolean,text)'::regprocedure")).rows[0];
    expect(header).toEqual({ prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] });
    // Legacy has no qualified login bootstrap; fixture grants membership to its isolated NOINHERIT login.
    if (profile === "legacy") {
      await owner.query(`CREATE ROLE ${r} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await owner.query(`GRANT authenticated TO ${r}`);
    }
    const runtime = pool(login(r));
    const actor = async <T>(principal: string | null, work: (client: PoolClient) => Promise<T>): Promise<T> => {
      const client = await runtime.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify(principal ? { sub: principal, role: "authenticated" } : {})]);
        await client.query("SET LOCAL ROLE authenticated");
        expect((await client.query("SELECT current_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser")).rows).toEqual([{ current_user: "authenticated", superuser: false }]);
        const result = await work(client); await client.query("COMMIT"); return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    };
    // Explicit table revokes and RLS keep both effective roles closed; actor definers below still work.
    if (installation.generation === "qualified-v2") {
      for (const table of ["customer_account_consent_events", "customer_account_consent_sync_targets"]) {
        for (const run of [<T>(work: (client: PoolClient) => Promise<T>) => actor(randomUUID(), work), async <T>(work: (client: PoolClient) => Promise<T>) => {
          const client = await runtime.connect();
          try { return await work(client); } finally { client.release(); }
        }]) {
          const rights = await run(async client => (await client.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') AS direct_access", [`public.${table}`])).rows[0]);
          expect(rights).toEqual({ direct_access: false });
          await expect(run(client => client.query(`SELECT * FROM public.${table}`))).rejects.toMatchObject({ code: "42501" });
          await expect(run(client => client.query(`DELETE FROM public.${table}`))).rejects.toMatchObject({ code: "42501" });
        }
      }
    }
    for (const table of ["customer_account_consent_events", "customer_account_consent_sync_targets"]) {
      expect((await owner.query("SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass", [`public.${table}`])).rows).toEqual([{ relrowsecurity: true }]);
      const roles = (await owner.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')")).rows;
      for (const role of roles) expect((await owner.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') AS direct_access", [role.rolname, `public.${table}`])).rows).toEqual([{ direct_access: false }]);
    }
    const subject = async (email = `${randomUUID()}@example.invalid`) => {
      const principal = randomUUID(), id = randomUUID();
      await owner.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)", [id, email, principal]);
      return { id, principal, email };
    };
    type Subject = Awaited<ReturnType<typeof subject>>;
    type Receipt = { permissionEventId: string; workId: string | null; replayed: boolean };
    const read = (customer: Subject, principal: string | null = customer.principal) => actor(principal, async client => (await client.query("SELECT public.customer_account_communication_choices_as_actor($1) AS result", [customer.id])).rows[0].result);
    const set = (customer: Subject, purpose: string | null, value: boolean | null, key: string | null, principal: string | null = customer.principal) => actor(principal, async client => (await client.query("SELECT public.customer_account_communication_choice_set_as_actor($1,$2,$3,$4) AS result", [customer.id, purpose, value, key])).rows[0].result);
    const snapshot = async () => {
      const rows: Record<string, unknown> = {};
      for (const table of tables) rows[table] = (await owner.query(`SELECT to_jsonb(t) AS row,xmin::text FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
      return rows;
    };
    const customer = await subject(" \u00a0Mixed.Reader@Example.invalid\ufeff "), stranger = await subject();
    const beforeRead = await snapshot();
    expect(await read(customer)).toMatchObject({ contractVersion: "customer.account_communication_choices.v1", contact: null,
      marketingNewsletter: { purpose: purposes[0], state: "unknown", granted: false, consentCopyVersion: null },
      marketingGiftsDiscounts: { purpose: purposes[1], state: "unknown", granted: false, consentCopyVersion: null } });
    expect(await snapshot()).toEqual(beforeRead);
    await expect(read(customer, null)).rejects.toMatchObject({ code: "42501", message: "account_consent_actor_required" });
    await expect(read(customer, stranger.principal)).rejects.toMatchObject({ code: "42501", message: "account_consent_client_not_owned" });
    await expect(read({ ...customer, id: randomUUID() })).rejects.toMatchObject({ code: "42501" });
    await expect(set(customer, purposes[0], true, "missing-actor", null)).rejects.toMatchObject({ code: "42501" });
    await expect(set(customer, purposes[0], true, "wrong-actor", stranger.principal)).rejects.toMatchObject({ code: "42501" });
    for (const [purpose, value, key] of [["marketing_launch_offer", true, "wrong-purpose"], [null, true, "null-purpose"], [purposes[0], null, "null-choice"], [purposes[0], true, ""], [purposes[0], true, "  "], [purposes[0], true, "bad\tkey"], [purposes[0], true, "k".repeat(257)]] as const) {
      await expect(set(customer, purpose, value, key)).rejects.toMatchObject({ code: "22023", message: "account_consent_invalid_input" });
    }
    await expect(set(customer, purposes[0], true, "unconfigured")).rejects.toMatchObject({ code: "55000" });
    expect(await snapshot()).toEqual(beforeRead);
    for (const table of ["customer_communication_preferences", "customer_communication_preference_events", "customer_account_consent_events", "customer_account_consent_sync_targets", "communication_recipient_consents", "communication_native_sync_state", "outbox_events"]) {
      expect((await owner.query("SELECT has_table_privilege('authenticated',$1,'INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege('authenticated',$1,'INSERT,UPDATE') AS dml", [`public.${table}`])).rows[0].dml).toBe(false);
      await expect(actor(customer.principal, client => client.query(`SELECT * FROM public.${table}`))).rejects.toMatchObject({ code: "42501" });
      await expect(actor(customer.principal, client => client.query(`DELETE FROM public.${table}`))).rejects.toMatchObject({ code: "42501" });
    }
    await owner.query("INSERT INTO public.customer_account_consent_sync_targets(binding,provider_kind,enabled) VALUES('account-test','synthetic',true)");
    const beforeInvalidTarget = await snapshot();
    for (const column of ["binding", "provider_kind"]) {
      await owner.query(`UPDATE public.customer_account_consent_sync_targets SET ${column}=$1`, ["invalid\tidentifier"]);
      try { await expect(set(customer, purposes[0], true, `invalid-target:${column}`)).rejects.toMatchObject({ code: "55000", message: "account_consent_sync_target_unavailable" }); }
      finally { await owner.query(`UPDATE public.customer_account_consent_sync_targets SET ${column}=$1`, [column === "binding" ? "account-test" : "synthetic"]); }
      expect(await snapshot()).toEqual(beforeInvalidTarget);
    }
    const invalidEmail = await subject("invalid-address");
    await expect(set(invalidEmail, purposes[0], true, "invalid-email")).rejects.toMatchObject({ code: "22023", message: "account_consent_email_invalid" });
    for (const signature of ["public.customer_account_communication_choices_as_actor(uuid)", "public.customer_account_communication_choice_set_as_actor(uuid,text,boolean,text)"]) {
      expect((await owner.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS anon,has_function_privilege('authenticated',$1,'EXECUTE') AS actor", [signature])).rows[0]).toEqual({ anon: false, actor: true });
    }
    const granted = await set(customer, purposes[0], true, "newsletter-grant");
    expect(granted).toMatchObject({ replayed: false, choices: { marketingNewsletter: { state: "granted", granted: true, source: "customer_communication_preferences", reason: "customer_self_service_grant", consentCopyVersion: "customer_account_marketing_newsletter.v1" }, marketingGiftsDiscounts: { state: "unknown" } } });
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => set(customer, purposes[1], true, "gifts-grant")));
    expect(concurrent.filter(value => !value.replayed)).toHaveLength(1);
    expect(new Set(concurrent.map(value => value.workId)).size).toBe(1);
    expect(concurrent[0].choices.marketingGiftsDiscounts).toMatchObject({ state: "granted", consentCopyVersion: "customer_account_marketing_gifts_discounts.v1" });
    const audit = (await owner.query("SELECT * FROM public.customer_account_consent_events WHERE id=$1", [granted.permissionEventId])).rows[0];
    expect(audit).toMatchObject({ principal_id: customer.principal, client_id: customer.id, requested_consent: true, effective_state: "granted", source: "customer_communication_preferences", reason: "customer_self_service_grant", consent_copy_version: "customer_account_marketing_newsletter.v1",
      source_ref: { route: "/api/bff/customers/communication-preferences", clientId: customer.id }, metadata: { actorType: "customer_self_service", captureMethod: "customer_account" }, work_id: granted.workId });
    expect(audit.captured_at).toBeInstanceOf(Date);
    expect(audit.recipient_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await owner.query("SELECT payload FROM public.outbox_events WHERE id=$1", [granted.workId])).rows[0].payload.permissionEventId).toBe(granted.permissionEventId);
    const fingerprint = hash(customer.email.trim().toLowerCase());
    expect((await owner.query("SELECT aggregate_id FROM public.outbox_events WHERE id=$1", [granted.workId])).rows[0].aggregate_id.replaceAll("-", "")).toBe(hash(JSON.stringify(["account-test", "synthetic", fingerprint])).slice(0, 32));
    const beforeReplay = await snapshot();
    expect(await set(customer, purposes[0], true, "newsletter-grant")).toMatchObject({ permissionEventId: granted.permissionEventId, workId: granted.workId, replayed: true });
    for (const [purpose, choice] of [[purposes[0], false], [purposes[1], true]] as const) await expect(set(customer, purpose, choice, "newsletter-grant")).rejects.toMatchObject({ code: "23505", message: "account_consent_idempotency_conflict" });
    await expect(set(customer, purposes[0], true, "newsletter-grant", stranger.principal)).rejects.toMatchObject({ code: "42501" });
    expect(await snapshot()).toEqual(beforeReplay);
    const withdrawn = await set(customer, purposes[1], false, "gifts-withdraw");
    expect(withdrawn.choices).toMatchObject({ marketingNewsletter: { state: "granted" }, marketingGiftsDiscounts: { state: "denied", reason: "customer_self_service_denial" } });
    expect((await set(customer, purposes[1], true, "gifts-grant")).choices.marketingGiftsDiscounts.state).toBe("denied");
    // A failed sync write rolls back preference, evaluator and permission event together.
    const beforeFault = await snapshot();
    await owner.query("ALTER TABLE public.communication_native_sync_state ADD CONSTRAINT account_test_refusal CHECK(event_kind <> 'subscribe') NOT VALID");
    try { await expect(set(customer, purposes[0], true, "fault")).rejects.toMatchObject({ code: "23514" }); }
    finally { await owner.query("ALTER TABLE public.communication_native_sync_state DROP CONSTRAINT account_test_refusal"); }
    expect(await snapshot()).toEqual(beforeFault);
    const suppressed = await subject();
    for (const purpose of purposes) await owner.query("INSERT INTO public.communication_recipient_consents(recipient_fingerprint,purpose,state) VALUES($1,$2,'suppressed')", [hash(suppressed.email), purpose]);
    const heldBefore = (await owner.query("SELECT * FROM public.communication_recipient_consents WHERE recipient_fingerprint=$1 ORDER BY purpose", [hash(suppressed.email)])).rows;
    for (const purpose of purposes) for (const value of [true, false]) {
      const result = await set(suppressed, purpose, value, `${purpose}:${value}`);
      expect(result.choices[purpose === purposes[0] ? "marketingNewsletter" : "marketingGiftsDiscounts"]).toMatchObject({ state: "suppressed", granted: false, source: null });
      expect((await owner.query("SELECT event_kind FROM public.communication_native_sync_state WHERE work_id=$1", [result.workId])).rows[0].event_kind).toBe("suppress");
    }
    expect((await owner.query("SELECT * FROM public.communication_recipient_consents WHERE recipient_fingerprint=$1 ORDER BY purpose", [hash(suppressed.email)])).rows).toEqual(heldBefore);
    // Existing actor setter's opt-in still does not grant or enqueue work.
    const legacy = await subject(); const beforeLegacy = await snapshot();
    await actor(legacy.principal, client => client.query("SELECT public.customer_communication_preferences_set_as_actor(true)"));
    expect((await owner.query("SELECT state FROM public.communication_recipient_consents WHERE recipient_fingerprint=$1", [hash(legacy.email)])).rows).toEqual([]);
    const afterLegacy = await snapshot();
    expect(afterLegacy.outbox_events).toEqual(beforeLegacy.outbox_events);
    await Promise.all([set(legacy, purposes[0], false, "new-withdraw"), actor(legacy.principal, client => client.query("SELECT public.customer_communication_preferences_set_as_actor(true)"))]);
    expect((await read(legacy)).marketingNewsletter.state).toBe("denied");
    // Provider suppression locked before the actor's grant must remain effective.
    const racing = await subject();
    await owner.query("INSERT INTO public.communication_recipient_consents(recipient_fingerprint,purpose,state) VALUES($1,$2,'granted')", [hash(racing.email), purposes[0]]);
    const blocker = await owner.connect(); await blocker.query("BEGIN");
    await blocker.query("UPDATE public.communication_recipient_consents SET state='suppressed' WHERE recipient_fingerprint=$1", [hash(racing.email)]);
    const pending = set(racing, purposes[0], true, "racing-grant");
    try {
      await expect.poll(async () => Number((await owner.query("SELECT count(*) FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [r])).rows[0].count)).toBeGreaterThan(0);
    } finally { await blocker.query("COMMIT"); blocker.release(); }
    expect((await pending).choices.marketingNewsletter.state).toBe("suppressed");
    if (profile !== "legacy") {
      const evaluator = createPostgresConsentEvaluator({ connectionString: login(r) }, { registry }); closers.push(() => evaluator.close());
      expect((await evaluator.evaluate({ email: customer.email, purpose: purposes[0] })).allowed).toBe(true);
      expect((await evaluator.evaluate({ email: customer.email, purpose: purposes[1] })).allowed).toBe(false);
      for (const purpose of purposes) expect((await evaluator.evaluate({ email: suppressed.email, purpose })).allowed).toBe(false);
      const store = createPostgresCommunicationSyncStore({ connectionString: login(r) }, { binding: "account-test", providerKind: "synthetic", rail: db => createPostgresOutboxStore(db) }); closers.push(() => store.close());
      const sent: { purpose: string; eventType: string; eventId: string }[] = [];
      const provider = { providerKind: "synthetic", capabilities: { subscribe: true, unsubscribe: true, suppress: true, unsuppress: false, doubleOptIn: false, emailChange: false, listMembership: false, webhookIdempotency: false, retryAfter: false },
        sync: async (event: { purpose: string; eventType: string; id: string }) => { sent.push({ purpose: event.purpose, eventType: event.eventType, eventId: event.id }); return { status: "sent" as const }; } };
      for (let i = 0; i < 20; i++) { const result = await runCommunicationSyncDispatch({ store, provider, registry }); expect(result.failures).toBe(0); if (result.checked === 0) break; }
      expect(sent.filter(event => event.purpose === purposes[1] && event.eventType === "subscribe")).toHaveLength(1);
      expect(sent.findIndex(event => event.eventId === concurrent[0].workId)).toBeLessThan(sent.findIndex(event => event.eventId === withdrawn.workId));
      expect((await owner.query("SELECT count(*)::int AS n FROM public.outbox_events WHERE status <> 'processed'")).rows[0].n).toBe(0);
      expect(new Set(sent.map(event => event.eventId)).size).toBe(sent.length);
      expect((await runCommunicationSyncDispatch({ store, provider, registry })).checked).toBe(0);
    }
    const reconnect = pool(login(r));
    const client = await reconnect.connect();
    try {
      await client.query("BEGIN"); await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: customer.principal })]);
      expect((await client.query("SELECT public.customer_account_communication_choices_as_actor($1) AS choices", [customer.id])).rows[0].choices.marketingGiftsDiscounts.state).toBe("denied");
      await client.query("ROLLBACK");
    } finally { client.release(); }
    console.info(`Account consent actor/refusal/ACL/worker proof passed: ${profile}`);
    if (profile !== "legacy") {
      // Both provider holds must suppress every marketing purpose, including previously granted gifts.
      const delivery = createPostgresDeliveryReconciliationPort({ connectionString: login(r) }, { binding: "account-provider-proof" });
      const evaluator = createPostgresConsentEvaluator({ connectionString: login(r) }, { registry });
      closers.push(() => delivery.close(), () => evaluator.close());
      for (const kind of ["bounced", "complained"] as const) {
        const recipient = await subject(), allPurposes = [...purposes, "marketing_launch_offer"];
        for (const purpose of purposes) await set(recipient, purpose, true, `before-provider-${kind}:${purpose}`);
        await owner.query("INSERT INTO public.communication_recipient_consents(recipient_fingerprint,purpose,state) VALUES($1,'marketing_launch_offer','granted')", [hash(recipient.email)]);
        for (const purpose of allPurposes) expect((await evaluator.evaluate({ email: recipient.email, purpose })).allowed).toBe(true);
        const stamp = new Date().toISOString(), messageId = `synthetic:account-${kind}`;
        const send = await delivery.registerNetworkTarget({ sourceKey: messageId, messageId, recipientEmail: recipient.email, templateReference: "synthetic", acceptedAt: stamp, evidence: "network_accepted" });
        const observation = { sendId: send.id, messageId, observationKey: messageId, kind, occurredAt: stamp, recipientEmail: recipient.email, source: "callback" as const };
        await delivery.applyObservation(observation);
        await delivery.applyObservation(observation);
        for (const purpose of allPurposes) {
          expect((await owner.query("SELECT state FROM public.communication_recipient_consents WHERE recipient_fingerprint=$1 AND purpose=$2", [hash(recipient.email), purpose])).rows).toEqual([{ state: "suppressed" }]);
          expect(await evaluator.evaluate({ email: recipient.email, purpose })).toMatchObject({ allowed: false, reason: "permission_suppressed" });
        }
        for (const purpose of purposes) expect((await set(recipient, purpose, true, `after-provider-${kind}:${purpose}`)).choices[purpose === purposes[0] ? "marketingNewsletter" : "marketingGiftsDiscounts"].state).toBe("suppressed");
      }
    }
    // Withdrawal is local even when sync cannot be registered; replay never backfills it.
    const unsynced: string[] = [];
    for (const mode of ["disabled", "absent"]) {
      const local = await subject();
      for (const purpose of purposes) await set(local, purpose, true, `${mode}:grant:${purpose}`);
      if (mode === "disabled") await owner.query("UPDATE public.customer_account_consent_sync_targets SET enabled=false");
      else await owner.query("DELETE FROM public.customer_account_consent_sync_targets");
      const workBefore = await snapshot();
      const receipts: { purpose: typeof purposes[number]; key: string; result: Receipt }[] = [];
      try {
        await expect(set(local, purposes[1], true, `${mode}:refused-grant`)).rejects.toMatchObject({ code: "55000" });
        for (const purpose of purposes) {
          const key = `${mode}:withdraw:${purpose}`, result = await set(local, purpose, false, key);
          expect(result).toMatchObject({ replayed: false, workId: null });
          expect(result.choices[purpose === purposes[0] ? "marketingNewsletter" : "marketingGiftsDiscounts"].state).toBe("denied");
          unsynced.push(result.permissionEventId); receipts.push({ purpose, key, result });
          const before = await snapshot();
          expect(await set(local, purpose, false, key)).toMatchObject({ permissionEventId: result.permissionEventId, workId: null, replayed: true });
          expect(await snapshot()).toEqual(before);
        }
        expect((await owner.query("SELECT marketing_newsletter_consent FROM public.customer_communication_preferences WHERE principal_id=$1", [local.principal])).rows)
          .toEqual([{ marketing_newsletter_consent: false }]);
        await owner.query("UPDATE public.communication_recipient_consents SET state='suppressed' WHERE recipient_fingerprint=$1 AND purpose=$2", [hash(local.email), purposes[1]]);
        const held = (await owner.query("SELECT * FROM public.communication_recipient_consents WHERE recipient_fingerprint=$1 AND purpose=$2", [hash(local.email), purposes[1]])).rows;
        const result = await set(local, purposes[1], false, `${mode}:held-withdraw`);
        unsynced.push(result.permissionEventId);
        expect(result).toMatchObject({ workId: null, choices: { marketingGiftsDiscounts: { state: "suppressed", granted: false } } });
        expect((await owner.query("SELECT * FROM public.communication_recipient_consents WHERE recipient_fingerprint=$1 AND purpose=$2", [hash(local.email), purposes[1]])).rows).toEqual(held);
        const after = await snapshot();
        expect(after.outbox_events).toEqual(workBefore.outbox_events);
        expect(after.communication_native_sync_state).toEqual(workBefore.communication_native_sync_state);
      } finally {
        await owner.query("INSERT INTO public.customer_account_consent_sync_targets(binding,provider_kind,enabled) VALUES('account-test','synthetic',true) ON CONFLICT(singleton) DO UPDATE SET enabled=true");
      }
      for (const { purpose, key, result } of receipts) {
        const before = await snapshot();
        expect(await set(local, purpose, false, key)).toMatchObject({ permissionEventId: result.permissionEventId, workId: null, replayed: true });
        expect(await snapshot()).toEqual(before);
      }
    }
    for (const email of ["not-an-email", "\u00a0", "bad\taddress@example.invalid", "x".repeat(321)]) {
      const local = await subject();
      for (const purpose of purposes) await set(local, purpose, true, `odd:grant:${purpose}`);
      await owner.query("UPDATE public.clients SET email=$2 WHERE id=$1", [local.id, email]);
      await expect(set(local, purposes[1], true, "odd:refused-grant")).rejects.toMatchObject({ code: "22023", message: "account_consent_email_invalid" });
      const beforeWork = await snapshot();
      const receipts: { purpose: typeof purposes[number]; result: Receipt }[] = [];
      for (const purpose of purposes) {
        const result = await set(local, purpose, false, `odd:withdraw:${purpose}`);
        expect(result).toMatchObject({ workId: null, replayed: false });
        expect(result.choices[purpose === purposes[0] ? "marketingNewsletter" : "marketingGiftsDiscounts"].state).toBe("denied");
        unsynced.push(result.permissionEventId); receipts.push({ purpose, result });
        const event = (await owner.query("SELECT recipient_fingerprint,metadata FROM public.customer_account_consent_events WHERE id=$1", [result.permissionEventId])).rows[0];
        expect(event).toMatchObject({ recipient_fingerprint: hash(email.trim().toLowerCase()), metadata: {
          syncDeferredReason: "email_invalid", recipientFingerprints: [hash(email.trim().toLowerCase()), hash(local.email)].sort(),
        } });
        const before = await snapshot();
        expect(await set(local, purpose, false, `odd:withdraw:${purpose}`)).toMatchObject({ permissionEventId: result.permissionEventId, workId: null, replayed: true });
        expect(await snapshot()).toEqual(before);
      }
      const afterWork = await snapshot();
      expect(afterWork.outbox_events).toEqual(beforeWork.outbox_events);
      expect(afterWork.communication_native_sync_state).toEqual(beforeWork.communication_native_sync_state);
      // Correcting back cannot resurrect the original grants; a fresh recipient stays unknown.
      await owner.query("UPDATE public.clients SET email=$2 WHERE id=$1", [local.id, local.email]);
      expect(await read(local)).toMatchObject({ marketingNewsletter: { state: "denied" }, marketingGiftsDiscounts: { state: "denied", source: "customer_communication_preferences" } });
      const corrected = `${randomUUID()}@example.invalid`;
      await owner.query("UPDATE public.clients SET email=$2 WHERE id=$1", [local.id, corrected]);
      expect(await read(local)).toMatchObject({ marketingNewsletter: { state: "unknown", granted: false }, marketingGiftsDiscounts: { state: "unknown", granted: false } });
      await set(local, purposes[1], true, "corrected:explicit-grant");
      const beforeReplay = await snapshot();
      expect(await set(local, purposes[1], false, "odd:withdraw:marketing_gifts_discounts"))
        .toMatchObject({ permissionEventId: receipts[1]!.result.permissionEventId, workId: null, replayed: true, choices: { marketingGiftsDiscounts: { state: "granted" } } });
      expect(await snapshot()).toEqual(beforeReplay);
      expect((await owner.query("SELECT state FROM public.communication_recipient_consents WHERE recipient_fingerprint=$1 AND purpose=$2", [hash(email.trim().toLowerCase()), purposes[1]])).rows).toEqual([{ state: "denied" }]);
    }
    const heldOdd = await subject();
    await set(heldOdd, purposes[1], true, "odd-held:grant");
    await owner.query("UPDATE public.communication_recipient_consents SET state='suppressed' WHERE recipient_fingerprint=$1 AND purpose=$2", [hash(heldOdd.email), purposes[1]]);
    const heldOddBefore = (await owner.query("SELECT * FROM public.communication_recipient_consents WHERE recipient_fingerprint=$1 AND purpose=$2", [hash(heldOdd.email), purposes[1]])).rows;
    await owner.query("UPDATE public.clients SET email='odd-held-address' WHERE id=$1", [heldOdd.id]);
    const heldOddResult = await set(heldOdd, purposes[1], false, "odd-held:withdraw");
    expect(heldOddResult).toMatchObject({ workId: null, choices: { marketingGiftsDiscounts: { state: "denied", granted: false } } });
    unsynced.push(heldOddResult.permissionEventId);
    expect((await owner.query("SELECT * FROM public.communication_recipient_consents WHERE recipient_fingerprint=$1 AND purpose=$2", [hash(heldOdd.email), purposes[1]])).rows).toEqual(heldOddBefore);
    await owner.query("UPDATE public.clients SET email=$2 WHERE id=$1", [heldOdd.id, heldOdd.email]);
    const heldReplayBefore = await snapshot();
    expect(await set(heldOdd, purposes[1], false, "odd-held:withdraw"))
      .toMatchObject({ permissionEventId: heldOddResult.permissionEventId, workId: null, replayed: true, choices: { marketingGiftsDiscounts: { state: "suppressed" } } });
    expect(await snapshot()).toEqual(heldReplayBefore);
    const localFault = await subject();
    await set(localFault, purposes[1], true, "sync-fault:grant");
    const beforeSyncFault = await snapshot();
    await owner.query("ALTER TABLE public.communication_native_sync_state ADD CONSTRAINT account_test_refusal CHECK(event_kind <> 'unsubscribe') NOT VALID");
    let denied;
    try { denied = await set(localFault, purposes[1], false, "sync-fault:withdraw"); }
    finally { await owner.query("ALTER TABLE public.communication_native_sync_state DROP CONSTRAINT account_test_refusal"); }
    expect(denied).toMatchObject({ workId: null, choices: { marketingGiftsDiscounts: { state: "denied" } } });
    unsynced.push(denied.permissionEventId);
    const afterSyncFault = await snapshot();
    expect(afterSyncFault.outbox_events).toEqual(beforeSyncFault.outbox_events);
    expect(afterSyncFault.communication_native_sync_state).toEqual(beforeSyncFault.communication_native_sync_state);
    expect(await set(localFault, purposes[1], false, "sync-fault:withdraw")).toMatchObject({ permissionEventId: denied.permissionEventId, workId: null, replayed: true });
    const query = readFileSync("docs/platform/DATA_AND_MIGRATIONS.md", "utf8").match(/```sql\n(-- account-consent-unsynced-denials[\s\S]*?)\n```/)?.[1];
    if (!query) throw new Error("Documented unsynced-denial read query missing");
    const pendingDenials = (await owner.query(query)).rows;
    expect(pendingDenials.map(row => row.id).sort()).toEqual(unsynced.sort());
    expect(pendingDenials.find(row => row.id === denied.permissionEventId).sync_deferred_reason).toBe("registration_failed");
  } finally { await closePostgres(container, pools, closers); }
// Solo without coverage across the five modes: 3.32–5.42 s; 30 s exceeds three times the maximum.
}, 30_000);
