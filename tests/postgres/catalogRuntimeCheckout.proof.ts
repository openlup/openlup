import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { checkoutOwnerRoutines } from "../../scripts/platform-migration-manifest.js";

const signature = "public.catalog_admission_runtime_checkout(text,text,uuid,jsonb)";
const assertion = "public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text)";
const malformed = "SELECT public.catalog_admission_runtime_checkout(NULL,NULL,NULL,NULL)";
const call = "SELECT public.catalog_admission_runtime_checkout('create','fixture-key',NULL,'{}')";
const refusal = { code: "55000", message: "catalog_admission_quote_authority_required",
  hint: "Governed checkout is unavailable for this selection. Use a supported offer or replay the original request." };

export function watchRuntimeCheckoutAclDelta(migrator: Pool) {
  const forward = readFileSync("db/platform/migrations/20261125090000_catalog_runtime_checkout_dark.sql", "utf8");
  const snapshot = `SELECT jsonb_build_array(
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY oid) FROM pg_auth_members m),
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY oid) FROM pg_default_acl a),
    (SELECT jsonb_agg(jsonb_build_array(oid,datdba,datacl::text) ORDER BY oid) FROM pg_database),
    (SELECT jsonb_agg(jsonb_build_array(oid,nspowner,nspacl::text) ORDER BY oid) FROM pg_namespace),
    (SELECT jsonb_agg(jsonb_build_array(oid,relowner,relacl::text) ORDER BY oid) FROM pg_class),
    (SELECT jsonb_agg(jsonb_build_array(attrelid,attnum,attacl::text) ORDER BY attrelid,attnum) FROM pg_attribute WHERE attacl IS NOT NULL),
    (SELECT jsonb_agg(jsonb_build_array(oid,proowner,proacl::text) ORDER BY oid) FROM pg_proc WHERE oid IS DISTINCT FROM to_regprocedure($1)),
    (SELECT jsonb_agg(pg_get_functiondef(oid) ORDER BY oid) FROM pg_proc WHERE oid=ANY($2::regprocedure[]))
  ) AS acl`;
  let observed = 0;
  migrator.on("connect", client => {
    const query = client.query.bind(client);
    const applyForward = async () => {
      const args = [signature, [assertion, ...checkoutOwnerRoutines]];
      const before = await query(snapshot, args);
      const result = await query(forward);
      assert.deepEqual((await query(snapshot, args)).rows, before.rows);
      observed++;
      return result;
    };
    // Pool.query uses the client's callback overload. Observe the promise-based migration call only.
    client.query = ((...args: unknown[]) => args[0] === forward
      ? applyForward()
      : Reflect.apply(query, client, args)) as typeof client.query;
  });
  return () => assert.equal(observed, 1, "the checkout forward must be observed once");
}

export async function proveRuntimeCheckout(bootstrap: Pool, runtime: Pool, migration: string, denied: readonly Pool[] = [], serviceRole = true) {
  const signatures = [signature, assertion, ...checkoutOwnerRoutines];
  const { rows } = await bootstrap.query(`SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.proacl::text AS raw,
    (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantee),pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
      ORDER BY a.grantee<>p.proowner,a.grantee) FROM aclexplode(p.proacl) a) AS acl
    FROM unnest($1::regprocedure[]) WITH ORDINALITY AS target(oid, ordinal)
    JOIN pg_proc p ON p.oid=target.oid ORDER BY target.ordinal`, [signatures]);
  assert.deepEqual(rows, signatures.map(name => {
    const grants = [[migration, migration, "EXECUTE", false]];
    if (serviceRole && (name === signature || name === assertion)) grants.push(["service_role", migration, "EXECUTE", false]);
    return { owner: migration, prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"],
      acl: grants, raw: `{${grants.map(([grantee]) => `${grantee}=X/${migration}`).join(",")}}` };
  }));
  for (const actor of denied) {
    assert.equal((await actor.query("SELECT current_user=session_user AS logged_in")).rows[0].logged_in, true);
    await assert.rejects(actor.query(malformed), { code: "42501" });
  }

  const locker = await bootstrap.connect(), db = await runtime.connect();
  try {
    await locker.query("BEGIN");
    await locker.query("LOCK TABLE public.commerce_orders, public.catalog_products, public.commerce_order_draft_receipts IN ACCESS EXCLUSIVE MODE");
    await db.query("CREATE TEMP TABLE commerce_orders(id text)");
    await db.query("BEGIN READ ONLY");
    await db.query("SET LOCAL lock_timeout='150ms'; SET LOCAL search_path=pg_temp,public,pg_catalog");
    for (const sql of [call, malformed]) {
      await db.query("SAVEPOINT call_dark");
      await assert.rejects(db.query(sql), refusal);
      await db.query("ROLLBACK TO SAVEPOINT call_dark");
    }
    if (serviceRole) {
      await db.query("SET LOCAL ROLE service_role");
      await assert.rejects(db.query(call), refusal);
    }
  } finally {
    await Promise.all([locker.query("ROLLBACK"), db.query("ROLLBACK")]);
    await db.query("DROP TABLE IF EXISTS pg_temp.commerce_orders");
    locker.release(); db.release();
  }
  const roles = (await bootstrap.query(`SELECT rolname,has_function_privilege(oid,$1,'EXECUTE') AS execute
    FROM pg_roles WHERE rolname=ANY($2) ORDER BY rolname`,
  [signature, ["anon", "authenticated", "openlup_catalog_publication", "openlup_checkout_owner", "platform_acquisition_runtime", "service_role"]])).rows;
  for (const role of roles) assert.equal(role.execute, role.rolname === "service_role", role.rolname);
  assert.equal(roles.some(role => role.rolname === "service_role"), serviceRole);
  assert.equal((await bootstrap.query("SELECT count(*)::int AS count FROM pg_default_acl")).rows[0].count, 0);
  const browser = await bootstrap.connect();
  try {
    for (const { rolname } of roles.filter(role => !role.execute)) {
      await browser.query(`BEGIN; SET LOCAL SESSION AUTHORIZATION ${rolname}`);
      try { await assert.rejects(browser.query(malformed), { code: "42501" }); }
      finally { await browser.query("ROLLBACK"); }
    }
  } finally { browser.release(); }
}
