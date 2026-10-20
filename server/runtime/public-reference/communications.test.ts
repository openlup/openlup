import { expect, it } from "vitest";
import { createPublicReferenceServer, startPublicReferenceServer } from "./serve.js";
it("refuses communications profile startup without admission and leaves ordinary policy inert", async () => {
 expect(()=>createPublicReferenceServer({env:{OPENLUP_REFERENCE_PROFILE:"communications"}})).toThrow(/admission/);
 await expect(startPublicReferenceServer({env:{OPENLUP_REFERENCE_PROFILE:"communications"},port:0})).rejects.toThrow(/admission/);
});
it("ordinary public HTTP has no communications operator page or mutation activation",async()=>{
 const server=createPublicReferenceServer({env:{}});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 try{expect((await fetch(`${origin}/admin/communications`)).status).toBe(404);expect((await fetch(`${origin}/api/bff/admin/communications/native-evidence`,{method:"POST"})).status).not.toBe(200);}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
