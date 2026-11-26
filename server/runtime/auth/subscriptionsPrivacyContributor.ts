import type { PgQueryExecutor } from "@openlup/platform/data";
import { PrivacyRefusal, type PersonalDataContributor } from "@openlup/platform/identity";
import type { PersonalDataObligation } from "@openlup/platform/identity/contracts";
const obligations: PersonalDataObligation[] = [
  { owner: "subscriptions", resource: "subscriptions.lifecycle", disposition: "retain", reasonCode: "IDENTITY_ONLY_ERASURE", remote: false },
  ...["consent", "invoices", "orders", "marketing"].map(owner => ({ owner, resource: `${owner}.personal-data`, disposition: "retain" as const, reasonCode: "OWNER_PATH_REQUIRED", remote: true })),
];
const occurrenceEvidence: PersonalDataObligation = { owner: "subscriptions", resource: "subscriptions.occurrence-evidence",
  disposition: "retain", reasonCode: "RENEWAL_OCCURRENCE_RETENTION", remote: false };

async function readOccurrenceEvidence(db: PgQueryExecutor, contactId: string | null) {
  if (!contactId) return [];
  const access = await db.query(`SELECT has_function_privilege(
    to_regprocedure('public.customer_preferences_export(uuid)'), 'EXECUTE') AS allowed`);
  if (access.rows[0]?.allowed !== true) return [];
  const evidence = (await db.query(
    "SELECT public.customer_preferences_export($1::uuid)->'renewalOccurrences' AS evidence", [contactId],
  )).rows[0]?.evidence;
  return Array.isArray(evidence) ? evidence as Record<string, string | null>[] : [];
}

/** Reference-owned veto: identity never queries subscriptions or cancels them. */
export function createSubscriptionsPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
  return {
    id: "subscriptions", version: "subscriptions.privacy-veto.v1", ownedResources: ["subscriptions.lifecycle", occurrenceEvidence.resource],
    async prepareErasure(db) { await db.query("LOCK TABLE public.subscriptions IN SHARE MODE"); },
    async export(db, subject) {
      const rows = subject.contactId ? (await db.query("SELECT id, status FROM public.subscriptions WHERE client_id = $1 ORDER BY id", [subject.contactId])).rows : [];
      const subscriptions = rows.map(row => ({ id: String(row.id), status: String(row.status) }));
      const occurrences = subscriptions.length ? await readOccurrenceEvidence(db, subject.contactId) : [];
      return { contributorId: "subscriptions", version: "subscriptions.privacy-veto.v1",
        data: subscriptions.map(subscription => {
          const evidence = occurrences.filter(row => row.subscriptionId === subscription.id);
          return evidence.length ? { ...subscription, renewalOccurrences: evidence } : subscription;
        }),
        coverage: { complete: false, included: ["subscription IDs and statuses", ...(occurrences.length ? ["renewal occurrence evidence"] : [])],
          unavailable: ["full subscription export", "processor obligations"] },
        obligations: occurrences.length ? [...obligations, occurrenceEvidence] : obligations };
    },
    async assessErasure(db, subject) {
      if (subject.contactId) {
        const rows = (await db.query("SELECT status FROM public.subscriptions WHERE client_id = $1", [subject.contactId])).rows;
        if (rows.some(row => row.status === "active")) throw new PrivacyRefusal("PRIVACY_ACTIVE_SUBSCRIPTION");
        if (rows.some(row => row.status === "paused")) throw new PrivacyRefusal("PRIVACY_RESUMABLE_SUBSCRIPTION");
        if (rows.some(row => row.status !== "cancelled")) throw new PrivacyRefusal("PRIVACY_ASSESSMENT_UNAVAILABLE");
        if (rows.length && (await readOccurrenceEvidence(db, subject.contactId)).length) {
          return { obligations: [...obligations, occurrenceEvidence] };
        }
      }
      return { obligations };
    },
    async eraseOrRetain(_db, _subject, assessment) { return { contributorId: "subscriptions", version: "subscriptions.privacy-veto.v1", obligations: assessment.obligations }; },
  };
}
