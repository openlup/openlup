import { checkReadiness, type CandidateIdentity, type Contribution, type LoadedPackage, type ReadinessInput, type SchemaProbePort } from "@openlup/core/readiness";
import { createCommunicationsContribution } from "@openlup/platform/communications";
import { observeReferencePackages } from "../outbox/candidateAdmission.js";
import { communicationsRequiredSchema, type CommunicationsBundle } from "./communicationsSchema.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
const dependencies=["data","identity","http"] as const;
/** Inert construction; all effects use the exact selected callables admitted below. */
export function createReferenceCommunications(input:{bundle:CommunicationsBundle;migrationIdentity:string;routes:Contribution["routes"];schedules:Contribution["schedules"];ports:Record<string,unknown>;handlers?:Contribution["handlers"]}) {
 const routes=input.routes.map(route=>Object.freeze({...route})), schedules=input.schedules.map(schedule=>Object.freeze({...schedule}));
 if(new Set(routes.map(route=>route.id)).size!==routes.length || new Set(schedules.map(schedule=>schedule.id)).size!==schedules.length)throw new Error("communications_duplicate_binding");
 return Object.freeze({bundle:input.bundle,requiredSchema:communicationsRequiredSchema(input.bundle,input.migrationIdentity),routes:Object.freeze(routes),schedules:Object.freeze(schedules),handlers:input.handlers??[],ports:Object.freeze({...input.ports})});
}
export type ReferenceCommunications=ReturnType<typeof createReferenceCommunications>;
/** A host composing other selected modules supplies their real contributions in this single admission. */
export async function admitReferenceCommunications(input:{runtime:ReferenceCommunications;candidate:CandidateIdentity;currentIdentity():CandidateIdentity;schemaProbe:SchemaProbePort;observed?:{loadedPackages:readonly LoadedPackage[];inventoryComplete:boolean};contributions?:readonly Contribution[];bindings?:ReadinessInput["bindings"];vocabulary?:ReadinessInput["vocabulary"];exemptions?:ReadinessInput["exemptions"]}) {
 const runtime=input.runtime,identity={...input.candidate},observed=input.observed??observeReferencePackages();
 const version=observed.loadedPackages.find(pkg=>pkg.name==="@openlup/platform")?.version??"";
 const supplied=input.contributions??[];
 // These are entry-only dependencies. A selected identity/data/HTTP implementation must supply its own actual contribution.
 const foundation:Contribution[]=dependencies.filter(id=>!supplied.some(c=>c.manifest.module?.id===id)).map(id=>({manifest:{name:"@openlup/platform",version,kind:"rail",module:{id,kind:"rail",provides:[`./${id}`],dependsOn:[]},emits:[],handles:[],schedules:[],routes:[],requiredPorts:[],env:[]},handlers:[],schedules:[],routes:[]}));
 const modules=[...foundation,...supplied].map(c=>c.manifest.module?.id).filter((id):id is string=>Boolean(id));
 const contribution=createCommunicationsContribution({version,requiredSchema:runtime.requiredSchema,routes:runtime.routes,schedules:runtime.schedules,handlers:runtime.handlers,requiredPorts:Object.keys(runtime.ports)});
 const bindings:ReadinessInput["bindings"]={ports:{...input.bindings?.ports,...Object.fromEntries(Object.entries(runtime.ports).map(([key,value])=>[`@openlup/platform/communications:${key}`,value]))},routes:{...input.bindings?.routes,...Object.fromEntries(runtime.routes.map(route=>[`@openlup/platform/communications:${route.id}`,route.handle]))},triggers:{...input.bindings?.triggers,...Object.fromEntries(runtime.schedules.map(schedule=>[`@openlup/platform/communications:${schedule.id}`,schedule.run]))},env:{...input.bindings?.env}};
 const report=await checkReadiness({candidate:identity,loadedPackages:observed.loadedPackages.map(pkg=>pkg.name==="@openlup/platform"?{...pkg,modules:[...new Set([...modules,"communications"])]}:pkg),inventoryComplete:observed.inventoryComplete,contributions:[...foundation,...supplied,contribution],bindings,schemaProbe:input.schemaProbe,vocabulary:input.vocabulary??[],exemptions:input.exemptions??[]});
 const assertCurrent=()=>{if(report.state!=="ready")throw new Error("communications_candidate_not_admitted");const current=input.currentIdentity();if(Object.keys(identity).some(key=>identity[key as keyof CandidateIdentity]!==current[key as keyof CandidateIdentity]))throw new Error("communications_candidate_admission_stale");};
 return {admitted:report.state==="ready",report,runtime,assertCurrent,
  route:async(id:string,req:VercelRequest,res:VercelResponse)=>{assertCurrent();const route=runtime.routes.find(route=>route.id===id);if(!route)throw new Error("communications_route_unbound");return route.handle(req as never,res as never);},
  run:async(id:string)=>{assertCurrent();const schedule=runtime.schedules.find(schedule=>schedule.id===id);if(!schedule)throw new Error("communications_schedule_unbound");return schedule.run();},
 };
}
export type AdmittedReferenceCommunications=Awaited<ReturnType<typeof admitReferenceCommunications>>;
