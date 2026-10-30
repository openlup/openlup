import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { expect } from "vitest";

/** Exercise the actual new closed-owner guard/envelope inside rolled-back transactions. */
export async function channelInstallerWitness(db:PoolClient) {
  const sql=readFileSync("supabase/migrations/20261030122000_channel_purchased_source.sql","utf8");
  const guard=sql.slice(sql.indexOf("DO $$ DECLARE installer oid;"),sql.indexOf("GRANT USAGE ON SCHEMA public"));
  const start=sql.indexOf("DO $$ DECLARE fn record; installer");
  const envelope=sql.slice(start,sql.indexOf("END; $$;",start)+9);
  expect(guard).toContain("channel_purchase_writer_role_unsafe");expect(envelope).toContain("channel_purchase_schema_grant_authority_required");
  const snapshot=async()=>JSON.stringify((await db.query(`SELECT current_user active_role,session_user session_role,
    (SELECT to_jsonb(r) FROM pg_roles r WHERE rolname='openlup_channel_purchase_writer') attributes,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor) FROM pg_auth_members m WHERE roleid='openlup_channel_purchase_writer'::regrole OR member='openlup_channel_purchase_writer'::regrole) edges,
    (SELECT nspacl::text FROM pg_namespace WHERE nspname='public') schema_acl,
    (SELECT jsonb_agg(jsonb_build_array(p.oid::bigint,p.proowner::bigint,CASE WHEN p.proacl IS NULL THEN NULL ELSE
      coalesce((SELECT jsonb_agg(jsonb_build_array(a.grantor::bigint,a.grantee::bigint,a.privilege_type,a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type,a.is_grantable) FROM aclexplode(p.proacl)a),'[]'::jsonb) END) ORDER BY p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','private')) functions`)).rows[0]);
  async function refused(statement:string,message:string,code?:string) {
    await db.query("SAVEPOINT installer_refusal");
    try{await expect(db.query(statement)).rejects.toMatchObject({message:expect.stringContaining(message),...(code?{code}:{})});}
    finally{await db.query("ROLLBACK TO SAVEPOINT installer_refusal; RELEASE SAVEPOINT installer_refusal");}
  }
  const who=(await db.query("SELECT current_user installer,session_user admin,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) super")).rows[0];
  if(!/^[a-z_]+$/u.test(who.installer)||!/^[a-z_]+$/u.test(who.admin))throw new Error("unsafe fixture installer");
  const owned=(await db.query("SELECT oid::regprocedure::text signature FROM pg_proc WHERE proowner='openlup_channel_purchase_writer'::regrole ORDER BY oid")).rows;
  expect(owned).toHaveLength(6);
  // Trusted rollback-only preparation; production keeps its ADMIN-only/SET-false edge.
  const prepare=async()=>{
    if(!who.super)await db.query(`GRANT openlup_channel_purchase_writer TO ${who.installer} WITH ADMIN FALSE,SET TRUE,INHERIT TRUE GRANTED BY ${who.installer}`);
    for(const fn of owned)await db.query(`ALTER FUNCTION ${fn.signature} OWNER TO ${who.installer}`);
    if(!who.super)await db.query(`REVOKE openlup_channel_purchase_writer FROM ${who.installer} GRANTED BY ${who.installer}`);
  };
  await db.query("BEGIN");
  try {
    const baseline=await snapshot();
    await prepare();const before=await snapshot();
    const injections=[
      envelope.replace("EXECUTE format('ALTER FUNCTION %s OWNER TO openlup_channel_purchase_writer',fn.signature);","EXECUTE format('ALTER FUNCTION %s OWNER TO openlup_channel_purchase_writer',fn.signature); RAISE EXCEPTION 'synthetic_mid_owner';"),
      envelope.replace("EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO openlup_channel_purchase_writer',fn.signature);","EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO openlup_channel_purchase_writer',fn.signature); RAISE EXCEPTION 'synthetic_post_acl';"),
      envelope.replace("  EXECUTE format('SET LOCAL ROLE %I',installer);","  RAISE EXCEPTION 'synthetic_before_cleanup'; EXECUTE format('SET LOCAL ROLE %I',installer);"),
    ];
    for(const injected of injections){expect(injected).not.toBe(envelope);await refused(injected,"synthetic_");expect(await snapshot()).toBe(before);}
    await db.query(envelope);expect(await snapshot()).toBe(baseline);
  }finally{await db.query("ROLLBACK");}
  for(const create of [false,true]) {
    await db.query("BEGIN");
    try{if(create)await db.query("GRANT CREATE ON SCHEMA public TO openlup_channel_purchase_writer");const before=await snapshot();await prepare();await db.query(envelope);expect(await snapshot()).toBe(before);}
    finally{await db.query("ROLLBACK");}
  }
  for(const flag of ["LOGIN","SUPERUSER","CREATEDB","CREATEROLE","INHERIT","REPLICATION","BYPASSRLS"]) {
    await db.query("BEGIN");try{const before=await snapshot();await db.query(`SET LOCAL ROLE ${who.admin}; ALTER ROLE openlup_channel_purchase_writer ${flag}; SET LOCAL ROLE ${who.installer}`);await refused(guard,"channel_purchase_writer_role_unsafe");await db.query("ROLLBACK");await db.query("BEGIN");expect(await snapshot()).toBe(before);}finally{await db.query("ROLLBACK");}
  }
  const edges=["GRANT openlup_channel_purchase_writer TO anon WITH SET TRUE","GRANT openlup_channel_purchase_writer TO anon WITH INHERIT TRUE","GRANT anon TO openlup_channel_purchase_writer","GRANT openlup_channel_purchase_writer TO postgres WITH ADMIN FALSE,SET FALSE,INHERIT FALSE","GRANT openlup_channel_purchase_writer TO authenticated WITH ADMIN TRUE,SET FALSE,INHERIT FALSE","GRANT openlup_channel_purchase_writer TO authenticated WITH SET TRUE; GRANT authenticated TO anon WITH SET TRUE"];
  for(const edge of edges){await db.query("BEGIN");try{await db.query(`SET LOCAL ROLE ${who.admin}`);await db.query(edge);await db.query(`SET LOCAL ROLE ${who.installer}`);await refused(guard,"channel_purchase_writer_role_unsafe");}finally{await db.query("ROLLBACK");}}
  await db.query("BEGIN");
  try {
    await db.query(`SET LOCAL ROLE ${who.admin}`);
    await db.query("ALTER ROLE openlup_channel_purchase_writer RENAME TO channel_held_writer; CREATE ROLE channel_weak_installer NOLOGIN NOINHERIT CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS; SET LOCAL SESSION AUTHORIZATION channel_weak_installer");
    expect((await db.query("SELECT current_user caller,session_user authenticated,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0]).toEqual({caller:"channel_weak_installer",authenticated:"channel_weak_installer",rolsuper:false});
    await db.query(guard);const before=await snapshot();
    expect((await db.query("SELECT has_schema_privilege(current_user,'public','CREATE') authority")).rows[0].authority).toBe(false);
    await refused("SET LOCAL ROLE openlup_channel_purchase_writer","permission denied","42501");
    await refused(envelope,"channel_purchase_schema_grant_authority_required","42501");
    expect(await snapshot()).toBe(before);
  }finally{await db.query("ROLLBACK");}

}
