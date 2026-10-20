import { createPostgresCommunicationPreferencesPort } from "../../adapters/postgres/communicationPreferences.js";
import type { UnsubscribeClient } from "../../../api/unsubscribe.js";
export function resolveCommunicationPreferenceBinding(env:Record<string,string|undefined>) {
 if(env.PLATFORM_BUNDLE!=="node-postgres")throw new Error("native_preference_bundle_required");
 if(!env.DATABASE_URL?.trim())throw new Error("database_url_required");
 if(!env.COMMUNICATIONS_BINDING?.trim()||!env.COMMUNICATIONS_MEMBERSHIP_PROVIDER?.trim())throw new Error("communications_preference_binding_required");
 const port=()=>createPostgresCommunicationPreferencesPort({connectionString:env.DATABASE_URL!},{binding:env.COMMUNICATIONS_BINDING!,providerKind:env.COMMUNICATIONS_MEMBERSHIP_PROVIDER!});
 return {async updatePreference(payload:{email:string;purpose:"tester_program"|"marketing_launch_offer"|"marketing_newsletter"},state:"denied"|"suppressed"){const selected=port();try{return await selected.updatePreference(payload,state);}finally{await selected.close();}},
  unsubscribeClient():UnsubscribeClient {
   return {from:()=>{throw new Error("native_legacy_tester_source_unavailable");},rpc:async(name,args)=>{
    if(name!=="communication_apply_unsubscribe"||args.p_source_table!==null||!Array.isArray(args.p_purposes)||args.p_purposes.length!==1||!["marketing_launch_offer","marketing_newsletter"].includes(String(args.p_purposes[0])))throw new Error("native_unsubscribe_unsupported");
    const result=await this.updatePreference({email:String(args.p_email),purpose:args.p_purposes[0] as "marketing_newsletter"|"marketing_launch_offer"},"suppressed");
    return {data:{status:result.alreadySuppressed?"already_suppressed":"applied",durablySuppressed:true,requestedPurposeCount:1,suppressedPurposeCount:1}};
   }};
  },
 };
}
