import { createPostgresCommunicationSyncStore, type NativeCommunicationsOptions } from "@openlup/platform/communications";
import type { PostgresDataGatewayEnv } from "@openlup/platform/data";
/** No remote call. The native store commits permission and existing-rail membership work together. */
export function createPostgresCommunicationPreferencesPort(env:PostgresDataGatewayEnv,options:NativeCommunicationsOptions & {providerKind:string}) {
 const store=createPostgresCommunicationSyncStore(env,{...options,rail:()=>{throw new Error("preference_binding_has_no_executor");}});
 return {close:store.close,updatePreference:(payload:{email:string;purpose:"tester_program"|"marketing_launch_offer"|"marketing_newsletter"},state:"denied"|"suppressed")=>store.registerPreference({...payload,state})};
}
