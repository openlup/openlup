import type { AdmittedReferenceCommunications } from "../communications/referenceComposition.js";
/** A disposable loopback host. No deployment policy alias, cadence or global route registration. */
export function communicationsReferenceMount(admission:AdmittedReferenceCommunications,origin:string,rawStreamRoutes:readonly string[] = []) {
 const parsed=new URL(origin);
 if(!["http:","https:"].includes(parsed.protocol)||!["127.0.0.1","localhost","[::1]"].includes(parsed.hostname)||parsed.origin!==origin||parsed.username||parsed.password)throw new Error("communications_reference_loopback_origin_required");
 if(rawStreamRoutes.some(id=>!admission.runtime.routes.some(route=>route.id===id)))throw new Error("communications_raw_route_unbound");
 admission.assertCurrent();
 return Object.freeze({admission,origin,rawStreamRoutes:Object.freeze([...rawStreamRoutes]),page:"/admin/communications"});
}
export type CommunicationsReferenceMount=ReturnType<typeof communicationsReferenceMount>;
