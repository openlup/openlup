/** Test-owned HTTP process; no production starter route is mounted by this fixture. */
import { createServer } from "node:http";
import { Pool } from "pg";
import { createPostgresCommerceOmsControlPlane, createPostgresCommerceOmsPort } from "@openlup/platform/commerce/server/postgres";
import { createAdminCommerceOrderHoldHandler, createAdminCommerceOrderReleaseHoldHandler } from "@openlup/platform/commerce/server";
let pool, server;
process.on("message", async message => {
  if (message.type === "stop") {
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await pool.end(); process.disconnect(); return;
  }
  if (message.type !== "start") return;
  pool=new Pool({connectionString:message.connectionString});
  const tokens=new Map(message.tokens);
  server=createServer(async(req,res)=>{try{
    let body="";for await(const chunk of req)body+=String(chunk);
    const id=tokens.get(String(req.headers.authorization??"").replace(/^Bearer /u,""));
    const authorizeAdmin=async()=>{
      if(!id)return{ok:false,code:"UNAUTHORIZED",message:"Session required"};
      const member=(await pool.query("SELECT m.role,m.membership_state,EXISTS(SELECT 1 FROM public.platform_control_operators c WHERE c.principal_id=m.principal_id) AS machine FROM public.platform_human_memberships m WHERE m.principal_id=$1",[id])).rows[0];
      if(!member||member.role!=="admin"||member.membership_state!=="active"||member.machine)return{ok:false,code:"FORBIDDEN",message:"Active human administrator required"};
      const actor=await createPostgresCommerceOmsControlPlane(pool).resolveOperator(id);
      return actor?{ok:true,userId:actor,isMachineActor:false}:{ok:false,code:"FORBIDDEN",message:"Commerce authority unavailable"};
    };
    const send=(r,status,value)=>{r.writeHead(status,{"content-type":"application/json"});r.end(JSON.stringify(value));};
    const respond={sendMethodNotAllowed:r=>send(r,405,{}),sendBffSuccess:(r,data)=>send(r,200,{data}),sendBffError:(r,code)=>send(r,code==="UNAUTHORIZED"?401:code==="FORBIDDEN"?403:code==="CONFLICT"?409:code==="BAD_REQUEST"?400:503,{code})};
    const deps={authorizeAdmin,omsPort:createPostgresCommerceOmsPort(pool),respond};
    const handler=req.url==="/hold"?createAdminCommerceOrderHoldHandler(deps):createAdminCommerceOrderReleaseHoldHandler(deps);
    await handler({method:req.method,body:JSON.parse(body)},res);
  }catch{res.writeHead(500);res.end();}});
  server.listen(0,"127.0.0.1",()=>process.send({port:server.address().port}));
});
