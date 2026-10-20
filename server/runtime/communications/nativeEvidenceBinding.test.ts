import { expect, it } from "vitest";
import { createNativeWebhookPort } from "./nativeEvidenceBinding.js";
it("maps admitted observations without converting open/click/unknown events into delivery", async () => {
 const effects:unknown[]=[];
 const port=createNativeWebhookPort({findByMessageId:async()=>({id:"send"}),applyObservation:async input=>{effects.push(input);}});
 for(const type of ["email.opened","email.clicked","email.scheduled","email.suppressed","unknown"]) await port.applyProviderEvent({emailSendId:"send",resendId:"network:synthetic",resendEventType:type,eventAt:"2026-10-20T10:00:00Z",metadata:{providerEventId:"event"}});
 expect(effects).toEqual([]);
 await port.applyProviderEvent({emailSendId:"send",resendId:"network:synthetic",resendEventType:"email.delivered",eventAt:"2026-10-20T10:00:00Z",metadata:{providerEventId:"event"}});
 expect(effects).toEqual([expect.objectContaining({kind:"delivered",source:"callback",observationKey:"event",recipientEmail:null})]);
});
