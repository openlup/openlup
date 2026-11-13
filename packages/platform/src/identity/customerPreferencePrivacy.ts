import type { PersonalDataContributor } from './privacyPorts.js';
import type { PrivacyJson } from './contracts/privacy.js';
import type { PgQueryExecutor } from '../data/index.js';
/** Compose with identity authorization, the subscriptions veto and account-event ownership. */
export function createCustomerPreferencePrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
  const id = 'customer-preferences', version = 'customer.preferences.v1', resource = 'customer.preferences';
  const obligations = [{ owner: id, resource, disposition: 'erase' as const, reasonCode: 'PRIVATE_CUSTOMER_PREFERENCE', remote: false }];
  return { id, version, ownedResources: [resource], async prepareErasure(db) { await db.query('SELECT public.customer_preferences_prepare_erasure()'); },
    async export(db, subject) {
      const data = subject.contactId ? (await db.query('SELECT public.customer_preferences_export($1::uuid) AS data', [subject.contactId])).rows[0]?.data : [];
      return { contributorId: id, version, data: data as PrivacyJson,
        coverage: { complete: true, included: [resource], unavailable: [] }, obligations };
    },
    async assessErasure() { return { obligations }; },
    async eraseOrRetain(db, subject, assessment) {
      if (subject.contactId) await db.query('SELECT public.customer_preferences_erase($1::uuid)', [subject.contactId]);
      return { contributorId: id, version, obligations: assessment.obligations };
    },
  };
}
