import { expect, it } from "vitest";
import { runCommunicationSyncDispatch } from "../../src/communications/communicationSyncWorker.js";
import { nativeSyncEventType } from "../../src/communications/postgresCommunicationSync.js";

it("owns an exact target namespace and preserves the sole effect executor", async () => {
  expect(nativeSyncEventType("target-a")).not.toBe(nativeSyncEventType("target-b"));
  const effects: string[] = [];
  const result = await runCommunicationSyncDispatch({
    store: { claimBatch: async () => [{ id: "work", claimToken: "claim", contactId: "contact", normalizedEmail: "recipient@example.invalid", eventType: "subscribe", purpose: "marketing_newsletter", payload: {}, attemptCount: 0 }],
      markSent: async input => { effects.push(`settle:${input.claimToken}`); return true; }, markFailed: async () => { throw new Error("unexpected failure"); } },
    provider: { providerKind: "synthetic", capabilities: { subscribe: true, unsubscribe: true, suppress: true, unsuppress: false, doubleOptIn: false, emailChange: false, listMembership: false, webhookIdempotency: false, retryAfter: false }, sync: async () => { effects.push("membership"); return { status: "sent" }; } },
  });
  expect(effects).toEqual(["membership", "settle:claim"]);
  expect(result.sent).toBe(1);
});
it("keeps invalid trusted registration refusal ahead of database construction",async()=>{
 const {createPostgresCommunicationSyncStore}=await import("../../src/communications/postgresCommunicationSync.js");
 let connections=0;
 const store=createPostgresCommunicationSyncStore({connectionString:"injected"},{binding:"synthetic",providerKind:"synthetic",rail:()=>{throw new Error("unexpected rail");},poolFactory:()=>{connections++;throw new Error("unexpected database construction");}});
 try{await expect(store.registerWork({sourceKey:"synthetic",contactId:"synthetic",normalizedEmail:"invalid",eventType:"subscribe",purpose:"marketing_newsletter"})).rejects.toThrow("native_communications_email_invalid");expect(connections).toBe(0);}finally{await store.close();}
});
