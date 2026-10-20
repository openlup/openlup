import { requestBff } from "../../lib/bff/client.js";
import { nativeEvidenceSchema, type NativeEvidence } from "./nativeEvidenceContracts.js";
export function getNativeEvidence(accessToken:string,signal?:AbortSignal):Promise<NativeEvidence> {
 return requestBff("/api/bff/admin/communications/native-evidence",nativeEvidenceSchema,{method:"GET",headers:{Authorization:`Bearer ${accessToken}`},signal});
}
