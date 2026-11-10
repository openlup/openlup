import type { PersonalDataContributor } from './privacyPorts.js';
import type { PrivacyJson } from './contracts/privacy.js';
import type { PgQueryExecutor } from '../data/index.js';

/** Compose with the existing identity transaction and subscriptions veto. */
export function createFulfillmentParcelContactPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
  const id = 'fulfillment-parcel-contacts', version = 'fulfillment.parcel-contacts.v1';
  const obligations = [{ owner: id, resource: 'fulfillment.parcel-contacts', disposition: 'erase' as const,
    reasonCode: 'PRIVATE_DELIVERY_CONTACT', remote: false },
    { owner: id, resource: 'fulfillment.parcel-contact-erasure-markers', disposition: 'retain' as const,
      reasonCode: 'PSEUDONYMOUS_ERASURE_FENCE', remote: false }];
  return {
    id, version, ownedResources: ['fulfillment.parcel-contacts', 'fulfillment.parcel-contact-erasure-markers'],
    async prepareErasure() {},
    async export(db, subject) {
      const data = subject.contactId ? (await db.query('SELECT public.fulfillment_export_parcel_contacts($1::uuid) AS data', [subject.contactId])).rows[0]?.data : [];
      return { contributorId: id, version, data: data as PrivacyJson,
        coverage: { complete: true, included: ['private parcel contacts', 'payload-free erasure markers'], unavailable: [] }, obligations };
    },
    async assessErasure() { return { obligations }; },
    async eraseOrRetain(db, subject, assessment) {
      if (subject.contactId) await db.query('SELECT public.fulfillment_erase_parcel_contacts($1::uuid)', [subject.contactId]);
      return { contributorId: id, version, obligations: assessment.obligations };
    },
  };
}
