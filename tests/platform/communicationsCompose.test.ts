import { expect,it } from "vitest";
import { createGuardedEmailTransport,guardEmailTransport,createInMemoryEmailTransport } from "@openlup/platform/communications";
it("composes two synthetic substitute transports through the installed guard and never treats capture or refusal as network delivery",async()=>{
 const message={from:"sender@example.invalid",to:"intended@example.invalid",subject:"Synthetic",html:"<p>Synthetic</p>"};
 let calls=0;
 const raw={providerKind:"synthetic",send:async()=>{calls++;throw new Error("raw effect forbidden");}};
 expect((await guardEmailTransport(raw).send(message)).outcome.ok).toBe(false);expect(calls).toBe(0);
 for(const providerKind of ["synthetic-a","synthetic-b"]){
  const transport=createGuardedEmailTransport({providerKind,policy:intendedRecipient=>({mode:"sandbox_sink",reason:"synthetic_sink",intendedRecipient,recipient:"sink@example.invalid",credential:"synthetic",environmentTag:"non_production"}),send:async(selected,context)=>{
   calls++;expect(selected.to).toBe("sink@example.invalid");expect(context.intendedRecipient).toBe(message.to);expect(context.environmentTag).toBe("non_production");
   return {outcome:{ok:true,resendId:`network:${providerKind}`,httpStatus:202,providerError:null,aborted:false},providerResponse:{accepted:true}};
  }});
  const result=await guardEmailTransport(transport).send(message);expect(result.outcome).toMatchObject({ok:true,egressMode:"sandbox_sink",resendId:`network:${providerKind}`});
 }
 const capture=createInMemoryEmailTransport();expect((await capture.send(message)).outcome.resendId).toMatch(/^in-memory-/);expect(calls).toBe(2);
});
