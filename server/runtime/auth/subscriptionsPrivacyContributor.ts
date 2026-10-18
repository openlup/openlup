import type { PgQueryExecutor } from "@openlup/platform/data";
import { PrivacyRefusal, type PersonalDataContributor } from "@openlup/platform/identity";
import type { PersonalDataObligation } from "@openlup/platform/identity/contracts";
const obligations: PersonalDataObligation[] = [
  { owner: "subscriptions", resource: "subscriptions.lifecycle", disposition: "retain", reasonCode: "IDENTITY_ONLY_ERASURE", remote: false },
  ...["consent", "invoices", "orders", "marketing"].map(owner => ({ owner, resource: `${owner}.personal-data`, disposition: "retain" as const, reasonCode: "OWNER_PATH_REQUIRED", remote: true })),
];
/** Reference-owned veto: identity never queries subscriptions or cancels them. */
export function createSubscriptionsPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
  return {
    id: "subscriptions", version: "subscriptions.privacy-veto.v1", ownedResources: ["subscriptions.lifecycle"],
    async prepareErasure(db) { await db.query("LOCK TABLE public.subscriptions IN SHARE MODE"); },
    async export(db, subject) {
      const rows = subject.contactId ? (await db.query("SELECT id, status FROM public.subscriptions WHERE client_id = $1 ORDER BY id", [subject.contactId])).rows : [];
      return { contributorId: "subscriptions", version: "subscriptions.privacy-veto.v1", data: rows.map(row => ({ id: String(row.id), status: String(row.status) })), coverage: { complete: false, included: ["subscription IDs and statuses"], unavailable: ["full subscription export", "processor obligations"] }, obligations };
    },
    async assessErasure(db, subject) {
      if (subject.contactId) {
        const rows = (await db.query("SELECT status FROM public.subscriptions WHERE client_id = $1", [subject.contactId])).rows;
        if (rows.some(row => row.status === "active")) throw new PrivacyRefusal("PRIVACY_ACTIVE_SUBSCRIPTION");
        if (rows.some(row => row.status === "paused")) throw new PrivacyRefusal("PRIVACY_RESUMABLE_SUBSCRIPTION");
        if (rows.some(row => row.status !== "cancelled")) throw new PrivacyRefusal("PRIVACY_ASSESSMENT_UNAVAILABLE");
      }
      return { obligations };
    },
    async eraseOrRetain(_db, _subject, assessment) { return { contributorId: "subscriptions", version: "subscriptions.privacy-veto.v1", obligations: assessment.obligations }; },
  };
}
