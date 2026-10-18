/** Opt-in proof against a fresh disposable local managed stack; no fixture erasure grants. */
import { createSchemaProbe } from "@openlup/core/readiness";
import { identityRequiredSchema } from "../../server/runtime/auth/identitySchema.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cwd, env } from "node:process";
import { Pool } from "pg";
import { readManagedMigrationChain } from "../../scripts/public-ci-pgtap.mjs";
import { createServiceRoleClient } from "../../server/_lib/admin-domain/auth.js";
import { createManagedPrivacyStore, createIdentityPersonalDataContributor, createPersonalDataContributorRegistry, createPrivacyOperations, type ManagedIdentityClient } from "@openlup/platform/identity";
const url = env.OPENLUP_MANAGED_CONFORMANCE_URL, key = env.OPENLUP_MANAGED_CONFORMANCE_SERVICE_KEY, database = env.OPENLUP_MANAGED_CONFORMANCE_DATABASE_URL;
const local = (value: string) => ["localhost","127.0.0.1","[::1]"].includes(new URL(value).hostname);
if (!url || !key || !database || !local(url) || !local(database)) throw new Error("Managed privacy conformance requires a fresh disposable local stack and OPENLUP_MANAGED_CONFORMANCE_URL, OPENLUP_MANAGED_CONFORMANCE_SERVICE_KEY, OPENLUP_MANAGED_CONFORMANCE_DATABASE_URL");
const P = "d4400000-0000-4000-8000-000000000001", C = "d4400000-0000-4000-8000-000000000002";
const pool = new Pool({connectionString:database});
try {
  assert.equal((await pool.query("SELECT to_regclass('public.clients') AS relation")).rows[0].relation,null,"Use a fresh disposable managed public schema");
  const defaults = ["postgres","supabase_admin"].flatMap(role => [""," IN SCHEMA public"].flatMap(scope => ["TABLES","SEQUENCES","FUNCTIONS"].map(kind => `ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role;`))).join("\n");
  const migrations = readManagedMigrationChain(cwd());
  // The shared runners use psql; node-postgres must omit only its pg_dump guard lines.
  await pool.query(["BEGIN;",readFileSync("scripts/public-reference/subscription-prereqs.sql","utf8"),defaults,"SET ROLE postgres;",...migrations.map(({ contents }) => contents.replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, "")),"RESET ROLE;","NOTIFY pgrst, 'reload schema';","COMMIT;"].join("\n"));
  const inventory = identityRequiredSchema("node-supabase", "complete");
  const connection = await pool.connect();
  try {
    const probe = createSchemaProbe(connection, async () => ({ database: "owned", version: "complete" }));
    assert.deepEqual((await probe.observe(inventory)).objects.filter(entry => entry.present !== true), []);
    await connection.query("BEGIN");
    try {
      await connection.query("ALTER TABLE public.clients DROP COLUMN created_at CASCADE");
      assert.deepEqual((await probe.observe(inventory)).objects.filter(entry => entry.present !== true), [
        { object: { kind: "column", name: "public.clients.created_at" }, present: false },
      ]);
    } finally { await connection.query("ROLLBACK"); }
  } finally { connection.release(); }
  const client = createServiceRoleClient({url,serviceRoleKey:key});
  const created = await client.auth.admin.createUser({id:P,email:"privacy-managed@example.invalid",email_confirm:true});
  assert.equal(created.error,null); assert.equal(created.data.user?.id,P);
  await pool.query("INSERT INTO public.clients (id,email,auth_user_id) VALUES ($1,'privacy-managed@example.invalid',$2)",[C,P]);
  const before = (await pool.query("SELECT * FROM public.clients WHERE id=$1",[C])).rows;
  const store = createManagedPrivacyStore();
  const registry = createPersonalDataContributorRegistry([createIdentityPersonalDataContributor(store,{retainedContactFields:{}},() => C)],{requiredContributorIds:["identity","subscriptions"]});
  let entries = 0;
  const operations = createPrivacyOperations({store,registry,unitOfWork:{run: work => { entries++; return work(client as unknown as ManagedIdentityClient); }},now:() => new Date(),randomId:() => C});
  await assert.rejects(() => operations.erase({principalId:P},{subject:{kind:"contact",contactId:C},idempotencyKey:C}),/MANAGED_PRIVACY_ERASURE_UNAVAILABLE/);
  assert.equal(entries,0);
  const exported = await operations.export({principalId:P},{kind:"contact",contactId:C});
  assert.equal(exported.documents[0].coverage.complete,false);
  assert.ok(exported.documents[0].coverage.unavailable.includes("contact.country"));
  assert.deepEqual(exported.missingContributors,["subscriptions"]);
  assert.deepEqual((await pool.query("SELECT * FROM public.clients WHERE id=$1",[C])).rows,before);
  assert.equal((await client.auth.admin.getUserById(P)).data.user?.id,P);
  const grants = (await pool.query("SELECT has_column_privilege('service_role','public.clients','first_name','UPDATE') AS update_name,has_column_privilege('service_role','public.clients','country','SELECT') AS read_country")).rows[0];
  assert.deepEqual(grants,{update_name:false,read_country:false});
  console.log("Managed privacy export and no-mutation refusal passed; synthetic identities retained");
} finally { await pool.end(); }
