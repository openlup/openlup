import type { PersonalDataContributor } from './privacyPorts.js';
import type { PrivacyJson } from './contracts/privacy.js';
import type { PgQueryExecutor } from '../data/index.js';
/** Compose with identity authorization, the subscriptions veto and account-event ownership. */
export function createCustomerSavedAddressPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
  const id = 'customer-saved-addresses', version = 'customer.saved-addresses.v1', resource = 'customer.saved-addresses';
  const obligations = [{ owner: id, resource, disposition: 'erase' as const, reasonCode: 'PRIVATE_SAVED_CONTACT', remote: false }];
  return { id, version, ownedResources: [resource], async prepareErasure(db) { await db.query('SELECT public.customer_saved_addresses_prepare_erasure()'); },
    async export(db, subject) {
      const data = subject.contactId ? (await db.query('SELECT public.customer_saved_addresses_export($1::uuid) AS data', [subject.contactId])).rows[0]?.data : [];
      return { contributorId: id, version, data: data as PrivacyJson,
        coverage: { complete: true, included: [resource], unavailable: [] }, obligations };
    },
    async assessErasure() { return { obligations }; },
    async eraseOrRetain(db, subject, assessment) {
      if (subject.contactId) await db.query('SELECT public.customer_saved_addresses_erase($1::uuid)', [subject.contactId]);
      return { contributorId: id, version, obligations: assessment.obligations };
    },
  };
}
