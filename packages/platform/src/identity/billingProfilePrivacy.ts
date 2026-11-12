import type { PersonalDataContributor } from './privacyPorts.js';
import type { PrivacyJson } from './contracts/privacy.js';
import type { PgQueryExecutor } from '../data/index.js';
/** Editable profiles erase; frozen invoice buyer components follow the invoicing owner's retention boundary. */
export function createCustomerBillingPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
 const id='customer-billing',version='customer.billing-privacy.v1',resources=['customer.billing-profiles','invoicing.buyer-snapshots'];
 const obligations=[{owner:id,resource:resources[0]!,disposition:'erase' as const,reasonCode:'PRIVATE_BILLING_PROFILE',remote:false},{owner:'invoicing',resource:resources[1]!,disposition:'retain' as const,reasonCode:'INVOICE_DOCUMENT_RETENTION',remote:false}];
 return {id,version,ownedResources:resources,async prepareErasure(db){await db.query('SELECT public.customer_billing_prepare_erasure()');},async export(db,subject){const data=subject.contactId?(await db.query('SELECT public.customer_billing_export($1) AS data',[subject.contactId])).rows[0]?.data:{profiles:[],invoiceBuyers:[]};return{contributorId:id,version,data:data as PrivacyJson,coverage:{complete:true,included:resources,unavailable:[]},obligations};},async assessErasure(){return{obligations};},async eraseOrRetain(db,subject,assessment){if(subject.contactId)await db.query('SELECT public.customer_billing_erase($1)',[subject.contactId]);return{contributorId:id,version,obligations:assessment.obligations};}};
}
