import type { PersonalDataContributor } from '../identity/index.js';
import type { PgQueryExecutor } from '../data/index.js';
type PrivacyData=Awaited<ReturnType<PersonalDataContributor<PgQueryExecutor>['export']>>['data'];
/** Local event projection erasure; commercial source facts and replay fences remain. */
export function createEcommerceEventPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
  const id='communication-events',version='communication-events.privacy.v1';
  const obligations=[{owner:id,resource:'communication-events.projections',disposition:'erase' as const,reasonCode:'FROZEN_RECIPIENT_PROJECTION',remote:false},
    {owner:id,resource:'communication-events.source-and-replay-fences',disposition:'retain' as const,reasonCode:'COMMERCIAL_FACT_AND_DEDUPLICATION',remote:false},
    {owner:id,resource:'communication-events.provider-history',disposition:'retain' as const,reasonCode:'PROVIDER_ERASURE_OWNER_REQUIRED',remote:true}];
  return {id,version,ownedResources:obligations.map(value=>value.resource),
    async prepareErasure(){},
    async export(db,subject){
      const data=subject.contactId?(await db.query('SELECT public.communication_event_privacy($1::uuid,false) AS value',[subject.contactId])).rows[0]?.value:[];
      return {contributorId:id,version,data:data as PrivacyData,coverage:{complete:false,included:['local frozen event projections','replay fences'],unavailable:['provider event history','commercial source owners']},obligations};
    },
    async assessErasure(){return {obligations};},
    async eraseOrRetain(db,subject,assessment){
      if(subject.contactId)await db.query('SELECT public.communication_event_privacy($1::uuid,true)',[subject.contactId]);
      return {contributorId:id,version,obligations:assessment.obligations};
    }};
}
