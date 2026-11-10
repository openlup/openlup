import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresCommerceOmsControlPlane } from "@openlup/platform/commerce/server/postgres";
import { assertNativeStoreForward, nativeStoreFunctionDefinitions, readReviewedForwardRegistry, sqlStatements } from "../../scripts/reviewed-platform-forward.js";
import { installOmsHuman, type OmsProfile } from "./omsHumanAdmission.fixture.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
const at="2026-11-10T16:00:00.000Z";
for(const profile of ["legacy","bootstrap","separate","admin-managed","admin-operator"] as OmsProfile[]) describe(`human OMS admission on ${profile}`,()=>{
  let db:Awaited<ReturnType<typeof installOmsHuman>>,child:ChildProcess|undefined,url:string;
  const tokens=new Map<string,string>();
  beforeAll(async()=>{db=await installOmsHuman(profile);},postgresSetupTimeoutMs);
  afterAll(async()=>{try{await stopHost();}finally{if(db)await db.close();}},postgresTeardownTimeoutMs);
  const resolveActor=(id:string)=>createPostgresCommerceOmsControlPlane(db.runtime).resolveOperator(id);
  async function principal(role:"admin"|"distributor"|null="admin",commerce=true,control?:boolean){
    const id=randomUUID();await db.owner.query("INSERT INTO public.platform_human_principals(principal_id,email,created_at) VALUES($1,$2,$3)",[id,`${id}@example.invalid`,at]);
    if(role)await db.owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,$2,'active','legacy',$3)",[id,role,at]);
    if(commerce)await db.owner.query("INSERT INTO public.commerce_operators(id,label,created_at) VALUES($1,'Synthetic operator',$2)",[id,at]);
    if(control!==undefined)await db.owner.query("INSERT INTO public.platform_control_operators(principal_id,active,created_at,updated_at) VALUES($1,$2,$3,$3)",[id,control,at]);
    const token=randomUUID();tokens.set(token,id);return{id,token};
  }
  async function order(){const id=randomUUID(),client=await db.owner.connect();try{await client.query("BEGIN");await client.query("INSERT INTO public.commerce_orders(id,status,currency_code,total_amount_minor,created_at,updated_at) VALUES($1,'paid','XXX',100,$2,$2)",[id,at]);await client.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,100,100)",[id]);await client.query("COMMIT");return id;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}
  async function stopHost(){
    if(!child)return;
    const current=child;child=undefined;
    const exited=once(current,"exit");current.send({type:"stop"});
    expect((await exited)[0]).toBe(0);
  }
  async function startHost(){
    await stopHost();
    child=fork(fileURLToPath(new URL("./omsHumanAdmission.host.mjs",import.meta.url)),[],{execArgv:[],stdio:["ignore","pipe","pipe","ipc"]});
    const ready=once(child,"message");child.send({type:"start",connectionString:db.runtimeUrl,tokens:[...tokens]});
    const [message]=await ready;url=`http://127.0.0.1:${message.port}`;
  }
  async function post(path:string,token:string,body:unknown){const response=await fetch(url+path,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});return{status:response.status,body:await response.json() as {data:{hold:{id:string;status:string};replayed:boolean};code?:string}};}
  it("resolves an active admin with no control row; HTTP hold/release survives replay, conflicts, uppercase IDs and host restart",async()=>{
    const admin=await principal(),orderId=await order();expect(await resolveActor(admin.id.toUpperCase())).toBe(admin.id);
    expect((await db.owner.query("SELECT 1 FROM public.platform_control_operators WHERE principal_id=$1",[admin.id])).rows).toEqual([]);
    await startHost();const request={idempotencyKey:randomUUID(),orderId:orderId.toUpperCase(),reason:"manual_support"};
    const first=await post("/hold",admin.token,request);expect(first.status).toBe(200);expect(first.body.data.replayed).toBe(false);
    expect((await db.owner.query("SELECT created_by FROM public.commerce_order_holds WHERE id=$1",[first.body.data.hold.id])).rows).toEqual([{created_by:admin.id}]);
    expect((await post("/hold",admin.token,request)).body.data.replayed).toBe(true);
    expect((await post("/hold",admin.token,{...request,reason:"risk_review"})).status).toBe(409);
    await startHost();expect((await post("/hold",admin.token,request)).body.data.replayed).toBe(true);
    const release={idempotencyKey:randomUUID(),holdId:first.body.data.hold.id.toUpperCase()};
    expect((await post("/release",admin.token,release)).body.data.hold.status).toBe("released");
    expect((await post("/release",admin.token,release)).body.data.replayed).toBe(true);
    expect((await post("/release",admin.token,{...release,idempotencyKey:randomUUID()})).status).toBe(409);
    expect((await post("/release",admin.token,{...release,idempotencyKey:randomUUID(),holdId:randomUUID()})).status).toBeGreaterThanOrEqual(400);
    expect((await db.owner.query("SELECT count(*)::int n FROM public.commerce_order_operations WHERE order_id=$1",[orderId])).rows[0].n).toBe(2);
  });
  it("refuses a distributor, revoked member and replay after revocation before writing",async()=>{
    const distributor=await principal("distributor"),admin=await principal(),orderId=await order();await startHost();
    const request={idempotencyKey:randomUUID(),orderId,reason:"manual_support"};
    expect(await resolveActor(distributor.id)).toBeNull();expect((await post("/hold",distributor.token,request)).status).toBe(403);
    expect((await post("/hold",admin.token,request)).status).toBe(200);
    const revoker=await principal("admin",false);
    await db.owner.query("SELECT public.platform_revoke_human_membership($1,$2,$3)",[revoker.id,admin.id,"Synthetic withdrawal"]);
    expect(await resolveActor(admin.id)).toBeNull();expect((await post("/hold",admin.token,request)).status).toBe(403);
    expect((await db.owner.query("SELECT count(*)::int n FROM public.commerce_order_operations WHERE order_id=$1",[orderId])).rows[0].n).toBe(1);
  });
  it("requires a preprovisioned Commerce row, never inserts one, and refuses unknown or unlinked principals",async()=>{
    const missing=await principal("admin",false),unlinked=await principal(null),before=(await db.owner.query("SELECT count(*) FROM public.commerce_operators")).rows;
    for(const id of [missing.id,unlinked.id,randomUUID()])expect(await resolveActor(id)).toBeNull();
    expect((await db.owner.query("SELECT count(*) FROM public.commerce_operators")).rows).toEqual(before);
  });
  it("excludes every control row from the human route while preserving active machine resolution",async()=>{
    const inactive=await principal("admin",true,false),machine=await principal(null,true,true),both=await principal("admin",true,true);
    const missingMachine=await principal(null,false,true);expect(await resolveActor(missingMachine.id)).toBeNull();
    expect(await resolveActor(inactive.id)).toBeNull();expect(await resolveActor(machine.id)).toBe(machine.id);expect(await resolveActor(both.id)).toBe(both.id);
    await startHost();expect((await post("/hold",both.token,{idempotencyKey:randomUUID(),orderId:await order(),reason:"manual_support"})).status).toBe(403);
    await db.owner.query("UPDATE public.platform_control_operators SET active=false WHERE principal_id=$1",[machine.id]);expect(await resolveActor(machine.id)).toBeNull();
  });
  it("preserves invoker/STABLE attributes, exact ACL and preimage; body contains no provisioning",async()=>{
    const signature="public.oms_control_resolve_operator(uuid)",connection=await db.migrator.connect();
    const facts=async()=>(await connection.query("SELECT prosecdef,provolatile,proconfig,proacl::text,proowner::regrole::text FROM pg_proc WHERE oid=$1::regprocedure",[signature])).rows;
    const original=readFileSync("db/platform/migrations/20260817100000_oms_control_plane_operator_bridge.sql");
    try{await connection.query("BEGIN");const current=await facts();expect(current[0]).toMatchObject({prosecdef:false,provolatile:"s",proconfig:["search_path=pg_catalog"]});
      await connection.query(sqlStatements(original.toString()).find(sql=>sql.startsWith("CREATE FUNCTION"))!.replace("CREATE FUNCTION","CREATE OR REPLACE FUNCTION"));expect(await facts()).toEqual(current);
    }finally{await connection.query("ROLLBACK");connection.release();}
    const registry=readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));const slot=registry.nativeStoreForwardClass!.slots.at(-1)!;
    expect(slot.replacedFunctions[0]!.beforeSha256).toBe(nativeStoreFunctionDefinitions(original,[signature],true).get(signature));
    const forward=readFileSync(slot.path,"utf8");expect(forward).not.toMatch(/\bINSERT\b/u);expect(forward).not.toMatch(/\bGRANT\b/u);
    expect((await db.owner.query("SELECT EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(p.proacl) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') allowed",[signature])).rows[0].allowed).toBe(false);
    for(const role of ["anon","authenticated"])expect((await db.owner.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[role,signature])).rows[0].allowed).toBe(false);
  });
});

it("admits the exact resolver replacement and refuses a different recorded preimage",()=>{
  const registry=readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
  const slot=registry.nativeStoreForwardClass!.slots.at(-1)!,bytes=readFileSync(slot.path);
  const prefix=readdirSync("db/platform/migrations").filter(file=>/^\d{14}_.+\.sql$/u.test(file)).sort().map(file=>({path:`db/platform/migrations/${file}`,bytes:readFileSync(`db/platform/migrations/${file}`)})).filter(file=>file.path<slot.path);
  expect(()=>assertNativeStoreForward(registry,slot.path,bytes,prefix)).not.toThrow();
  slot.replacedFunctions[0]!.beforeSha256="0".repeat(64);
  registry.nativeStoreForwards!.at(-1)!.functions[0]!.beforeSha256="0".repeat(64);
  expect(()=>assertNativeStoreForward(registry,slot.path,bytes,prefix)).toThrow("actual base function before-hash drifted");
});
