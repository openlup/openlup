import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { closePostgres, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { imageReference, readCiImage } from "../../scripts/ci-image-pull.mjs";
import { readReviewedForwardRegistry } from "../../scripts/reviewed-platform-forward.js";
import { batchSnapshot } from "./reviewedBatchCatalog.js";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "legacy");
const nativePath = "db/platform/migrations/20261026120000_account_support_operator_authority.sql";
const managedPath = "supabase/migrations/20261026120100_account_support_current_authority.sql";

it.each(["native", "managed"] as const)("upgrades the complete %s prefix, proves finite catalog/ACL delta and recovery replay without token rotation", async graph => {
  if (!await dockerAvailable()) throw new Error("M12 upgrade proof requires Docker PostgreSQL");
  const portable = graph === "native";
  const path = portable ? nativePath : managedPath;
  const fixture = readFileSync(`scripts/fixtures/reviewed-m12/${path}`);
  expect(readFileSync(path)).toEqual(fixture);
  if (portable) expect(readFileSync(`packages/platform/sql/${path.split("/").at(-1)}`)).toEqual(fixture);
  const pin = registry.supportAuthorityForwards![portable ? 0 : 1]!;
  expect(sha(fixture)).toBe(pin.sha256);
  const image = readCiImage("test-postgres");
  const spec = { name: `m12-upgrade-${graph}-${process.pid}`, password: "synthetic-conformance" };
  const container = portable ? await runPostgresContainer({ ...spec, image: imageReference(image, image.sources.at(-1)) }) : await runManagedCompatPostgres(spec);
  let pool: Pool | undefined; let scratch: string | undefined;
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("M12 PostgreSQL unavailable");
    pool = new Pool({ connectionString: portable ? container.connectionString : container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"), max: 1 });
    const db = pool;
    if (portable) {
      // Existing runner validates the full predecessor prefix and its measured inventory.
      scratch = mkdtempSync(join(tmpdir(), "m12-upgrade-"));
      const prefix = { ...manifest, forward: manifest.forward.filter((entry: { file: string }) => entry.file < nativePath),
        objectInventorySha256: "9dee58881dee9d5fe4267e09f1579a7c27197da6f4a40419b16901cbb9ded573" };
      for (const entry of [prefix.baseline, ...prefix.forward]) {
        const target = join(scratch, entry.file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(entry.file));
      }
      mkdirSync(join(scratch, "config")); writeFileSync(join(scratch, "config/platform-migration-manifest.json"), JSON.stringify(prefix));
      await createPostgresMigrationRunner({ connectionString: container.connectionString }, { root: scratch, poolFactory: () => db }).apply();
    } else {
      await db.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
      for (const role of ["postgres", "supabase_admin"]) for (const scope of ["", " IN SCHEMA public"]) for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
        await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC,anon,authenticated,service_role`);
      }
      await db.query("SET ROLE postgres; SET search_path=public,extensions");
      const pins = [...registry.batchedForwards!, ...registry.managedCommerceForwards!].filter(p => p.path.startsWith("supabase/migrations/"));
      const paths = [...new Set([...readdirSync("supabase/migrations").filter(p => p.endsWith(".sql")).map(p => `supabase/migrations/${p}`), ...pins.map(p => p.path)])].filter(p => p < managedPath).sort();
      for (const source of paths) {
        const frozen = pins.find(p => p.path === source);
        const fixturePath = frozen && `scripts/fixtures/${registry.managedCommerceForwards!.includes(frozen) ? "reviewed-m11" : "reviewed-m10"}/${source}`;
        const bytes = existsSync(source) ? readFileSync(source) : readFileSync(fixturePath!);
        if (frozen) { expect(sha(bytes), source).toBe(frozen.sha256); expect(bytes).toEqual(readFileSync(fixturePath!)); }
        await db.query(bytes.toString().replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
      }
    }
    await db.query("SET check_function_bodies=on; SET search_path=public,extensions");
    const before = await batchSnapshot(db);
    await db.query(fixture.toString());
    const after = await batchSnapshot(db);
    const creations = portable ? ["public.customer_support_apply_subscription_action_v1"] : ["public.customer_support_admit_subject_email_v1", "public.customer_support_claim_subject_email_v1", "public.customer_support_guard_identity_email_v1", "public.customer_support_settle_subject_email_v1", "public.customer_support_link_subject_account_v1"];
    const replacements = portable ? ["public.customer_support_issue_recovery", "public.customer_support_absorb_lead_v1"] : ["public.customer_support_correct_subject_email_v1", "public.customer_support_issue_recovery"];
    expect(after.functions.filter(f => !before.functions.some(b => b.oid === f.oid)).map(f => f.name).sort()).toEqual([...creations].sort());
    expect(after.functions.filter(f => before.functions.some(b => b.oid === f.oid && b.prosrc !== f.prosrc)).map(f => f.name).sort()).toEqual([...replacements].sort());
    expect(after.functions.filter(f => ![...creations, ...replacements].includes(f.name))).toEqual(before.functions.filter(f => !replacements.includes(f.name)));
    expect(after.data).toEqual(before.data);
    for (const name of [...creations, ...replacements]) {
      const functions = (await db.query("SELECT oid::regprocedure::text AS signature,prosecdef,proconfig FROM pg_proc WHERE oid=$1", [after.functions.find(f => f.name === name)!.oid])).rows;
      expect(functions).toHaveLength(1);
      // CD-9 gives managed link definer rights alongside the email workflow; recovery remains an invoker.
      const definer = !portable && ["public.customer_support_admit_subject_email_v1", "public.customer_support_claim_subject_email_v1", "public.customer_support_guard_identity_email_v1", "public.customer_support_settle_subject_email_v1", "public.customer_support_link_subject_account_v1"].includes(name);
      expect(functions[0].prosecdef, name).toBe(definer);
      for (const role of ["anon", "authenticated"]) expect((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, functions[0].signature])).rows[0].allowed).toBe(false);
      if (!portable) expect((await db.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS allowed", [functions[0].signature])).rows[0].allowed).toBe(name !== "public.customer_support_guard_identity_email_v1");
    }
    let measuredDigest: string | undefined;
    if (portable) {
      const client = await db.connect(); let digest: string;
      try { digest = sha(selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client))); } finally { client.release(); }
      console.info(`R4 native measured objectInventorySha256=${digest}`);
      measuredDigest = digest;
    } else {
      expect((await db.query("SELECT attname,attnotnull,atthasdef FROM pg_attribute WHERE attrelid='public.customer_support_subscription_commands'::regclass AND attname LIKE 'email_claim_%' ORDER BY attname")).rows).toEqual([
        { attname: "email_claim_token", attnotnull: false, atthasdef: false }, { attname: "email_claim_until", attnotnull: false, atthasdef: false },
      ]);
      expect((await db.query("SELECT tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgname='customer_support_identity_email_ownership'")).rows).toEqual([{ tgdeferrable: true, tginitdeferred: true }]);
      expect((await db.query("SELECT seqincrement::int,seqmin::text,seqcycle FROM pg_sequence WHERE seqrelid='public.customer_support_email_correction_sequence'::regclass")).rows).toEqual([{ seqincrement: 1, seqmin: "1", seqcycle: false }]);
      for (const name of ["customer_support_subscription_commands_kind_check", "customer_support_subscription_audit_events_kind_check", "admin_audit_events_action_check"]) {
        const constraint = (await db.query("SELECT pg_get_constraintdef(oid) AS definition,convalidated FROM pg_constraint WHERE conname=$1", [name])).rows[0];
        expect(constraint.convalidated).toBe(false); expect(constraint.definition).toContain(name.startsWith("admin") ? "operator_email_correction" : "account_link");
        if (name.startsWith("admin")) expect(constraint.definition).toContain("checkout_payment_link_mint");
      }
    }
    // Current issue body receives the same key with new throwaway token material;
    // its original durable token, notices and audit must remain byte/xmin identical.
    const operator = randomUUID(), customer = randomUUID(), subscription = randomUUID(), cycle = randomUUID(), order = randomUUID(), caseId = randomUUID();
    await db.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)", [operator]);
    if (!portable) await db.query("INSERT INTO public.admin_users(id,email,role,is_machine_actor) VALUES($1,$2,'admin',false)", [operator, `${operator}@example.invalid`]);
    await db.query("INSERT INTO public.clients(id,email,lifecycle_stage) VALUES($1,$2,'customer')", [customer, `${customer}@example.invalid`]);
    if (portable) {
      // Match the native helpers: no price list means no subscription currency context.
      await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,status,started_at,next_cycle_at) VALUES($1,$2,28,'active',now()-interval '1 month',now()+interval '7 days')", [subscription, customer]);
      await db.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,now(),'payment_pending')", [cycle, subscription]);
      // Mirror tests/helpers/fulfillmentNative.ts: commit the order and its matching line together.
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,status,currency_code,total_amount_minor) VALUES($1,$2,$3,'pending_payment','XTS',100)", [order, customer, cycle]);
        await client.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,100,100)", [order]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      await db.query("INSERT INTO public.subscription_dunning_cases(id,subscription_id,cycle_id,client_id,idempotency_key) VALUES($1,$2,$3,$4,$5)", [caseId, subscription, cycle, customer, `case-${caseId}`]);
      await db.query("INSERT INTO public.subscription_dunning_notifications(case_id,subscription_id,recipient_ref,notification_kind,template_slug) VALUES($1,$2,$3,'payment_failed','fixture')", [caseId, subscription, customer]);
    } else {
      // Mirror operator_subscription_actions_test.sql's open-dunning spine in statement order.
      const product = randomUUID(), variant = randomUUID(), payment = randomUUID(), intent = randomUUID();
      await db.query("INSERT INTO public.catalog_products(id,slug,name,status) VALUES($1,$2,'Operator Actions Product','active')", [product, `operator-actions-${product}`]);
      await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,pet_type,status,net_weight_g,kcal_per_unit) VALUES($1,$2,$3,'Operator Actions SKU','dog','active',400,350)", [variant, product, `OPERATOR-ACTIONS-${variant}`]);
      await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,currency,status,started_at,next_cycle_at,payment_method_ref,payment_method_kind) VALUES($1,$2,30,'XTS','active','2026-06-01T00:00:00Z','2026-09-30T00:00:00Z','pm_operator_actions','card')", [subscription, customer]);
      await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,qty,sort_order,is_addon,template_version) VALUES($1,$2,1,0,false,1)", [subscription, variant]);
      await db.query("INSERT INTO public.subscription_cycles(id,subscription_id,cycle_number,scheduled_at,status,engine_idempotency_key) VALUES($1,$2,2,'2026-07-15T00:00:00Z','retry_scheduled',$3)", [cycle, subscription, `cycle-${cycle}`]);
      await db.query("INSERT INTO public.commerce_orders(id,client_id,status,subtotal_cents,total_cents,mode,subscription_id,subscription_cycle_id) VALUES($1,$2,'pending_payment',1000,1000,'subscription_cycle',$3,$4)", [order, customer, subscription, cycle]);
      await db.query("INSERT INTO public.commerce_payments(id,order_id,provider,status,amount_cents) VALUES($1,$2,'test','failed',1000)", [payment, order]);
      await db.query("INSERT INTO public.commerce_payment_intents(id,target_kind,order_id,subscription_id,subscription_cycle_id,payment_id,amount_cents,status) VALUES($1,'subscription_cycle',$2,$3,$4,$5,1000,'failed')", [intent, order, subscription, cycle, payment]);
      await db.query("INSERT INTO public.subscription_dunning_cases(id,subscription_id,cycle_id,order_id,payment_intent_id,client_id,status,retry_attempt,recovered_at) VALUES($1,$2,$3,$4,$5,$6,'open',1,NULL)", [caseId, subscription, cycle, order, intent, customer]);
      await db.query("INSERT INTO public.subscription_dunning_notifications(case_id,subscription_id,cycle_id,order_id,payment_intent_id,recipient_kind,recipient_ref,notification_kind,template_slug,idempotency_key,retry_attempt) VALUES($1,$2,$3,$4,$5,'customer',$6,'payment_failed','fixture',$7,1)", [caseId, subscription, cycle, order, intent, customer, `notice-${caseId}`]);
    }
    const key = `recover-${randomUUID()}`;
    const issue = (token: string) => db.query("SELECT public.customer_support_issue_recovery($1,$2,$3,$4,$5,$6,now()+interval '1 day','/repair') AS result", [operator, customer, caseId, key, "a".repeat(64), token]);
    expect((await issue("b".repeat(64))).rows[0].result.outcome).toBe("issued");
    const effects = async () => {
      const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
      const rows: Record<string, unknown> = {};
      for (const { tablename } of tables) rows[tablename] = (await db.query(`SELECT to_jsonb(t) AS row,xmin::text AS xmin FROM public."${String(tablename).replaceAll('"', '""')}" t ORDER BY to_jsonb(t)::text`)).rows;
      return rows;
    };
    const saved = await effects(); expect((await issue("c".repeat(64))).rows[0].result.outcome).toBe("replayed"); expect(await effects()).toEqual(saved);
    // Frozen M12 issued-prefix measurement; later forwards do not change this subject.
    if (measuredDigest) expect(measuredDigest).toBe("cfe3a8b4fa6216f61b1cdd5f004cb0f7a967bc01d9e18ddacb2efee74742d3b3");
  } finally { await closePostgres(container, pool); if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}, 600_000);
