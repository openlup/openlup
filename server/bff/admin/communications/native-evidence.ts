import { readProcessEnvironment } from "../../../_lib/observability/runtimeProvenance.js";
import type { VercelRequest,VercelResponse } from "../../../_lib/types/vercel.js";
import { withObservedRoute } from "../../../_lib/observability/route.js";
import { sendBffSuccess,sendBffError,sendMethodNotAllowed } from "../../../_lib/bff/response.js";
import { readBearerToken } from "../../../_lib/admin-domain/auth.js";
import { resolveAdminAuthBinding } from "../../../runtime/auth/adminAuthBinding.js";
import { createNativeEvidenceBinding } from "../../../runtime/communications/nativeEvidenceBinding.js";
import { nativeEvidenceSchema } from "../../../../src/domains/communications/nativeEvidenceContracts.js";
/** The host's authorizer returns a verified admin principal, never an actor from the body. */
export function createNativeEvidenceHandler(input:{env:Record<string,string|undefined>;authorize(req:VercelRequest):Promise<string|null>}) {
 return async(req:VercelRequest,res:VercelResponse):Promise<void>=>{
  if(req.method!=="GET")return sendMethodNotAllowed(res,["GET"]);
  try{
   const operatorId=await input.authorize(req);if(!operatorId)return sendBffError(res,"UNAUTHORIZED","Admin session required");
   const binding=createNativeEvidenceBinding(input.env,{operatorId});
   try{sendBffSuccess(res,nativeEvidenceSchema.parse(await binding.read()));}finally{await binding.close();}
  }catch{sendBffError(res,"UPSTREAM_UNAVAILABLE","Native evidence unavailable");}
 };
}
export async function nativeEvidenceHandler(req:VercelRequest,res:VercelResponse):Promise<void>{
 return createNativeEvidenceHandler({env:readProcessEnvironment(),authorize:async request=>{
  const auth=resolveAdminAuthBinding(readProcessEnvironment()),token=readBearerToken(request);
  if(!auth.binding)throw new Error("admin_authorization_unavailable");
  return auth.binding.run(token,async port=>{const result=await port.authorize(token,{allowedRoles:["admin"]});return result.ok?result.principalId:null;});
 }})(req,res);
}
export default withObservedRoute({route:"/api/bff/admin/communications/native-evidence",domain:"communications",surface:"admin",risk:"mutation"},nativeEvidenceHandler);
