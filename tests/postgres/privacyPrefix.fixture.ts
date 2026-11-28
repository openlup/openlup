import { randomUUID } from "node:crypto";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { createPersonalDataContributorRegistry, createPrivacyOperations, PrivacyRefusal, type NativePrivacyStore,
  type PersonalDataContributor } from "@openlup/platform/identity";
import type { PersonalDataObligation } from "@openlup/platform/identity/contracts";
import { composeNativePrivacy } from "../../server/runtime/auth/privacyBinding.js";
import { verifyMissingSubscriptionsPrivacySubject } from "../../server/runtime/auth/subscriptionsPrivacyContributor.js";

// A catalogue prefix that has the renewal occurrence storage but not the occurrence privacy reader supports only the
// incumbent subscriptions veto; the current runtime refuses there until the SQL is applied. Tests that pin other
// owners' behaviour on such a prefix mount this contributor set. The veto is the incumbent contributor verbatim
// (server/runtime/auth/subscriptionsPrivacyContributor.ts at d25a5c738).
const obligations: PersonalDataObligation[] = [
  { owner: "subscriptions", resource: "subscriptions.lifecycle", disposition: "retain", reasonCode: "IDENTITY_ONLY_ERASURE", remote: false },
  ...["consent", "invoices", "orders", "marketing"].map(owner => ({ owner, resource: `${owner}.personal-data`, disposition: "retain" as const, reasonCode: "OWNER_PATH_REQUIRED", remote: true })),
];
function createIncumbentSubscriptionsPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
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

/** The native privacy composition with the incumbent subscriptions veto, for a prefix before the occurrence privacy reader. */
export function composePrivacyBeforeOccurrenceReader<C extends PgQueryExecutor>(
  deps: { store: NativePrivacyStore<C>; unitOfWork: { run: <T>(work: (db: C) => Promise<T>) => Promise<T> } },
) {
  const current = composeNativePrivacy(deps as Parameters<typeof composeNativePrivacy>[0]);
  const contributors = current.registry.contributors.map(contributor => contributor.id === "subscriptions"
    ? createIncumbentSubscriptionsPrivacyContributor() : contributor);
  const registry = createPersonalDataContributorRegistry(contributors,
    { requiredContributorIds: [...contributors.map(contributor => contributor.id), ...current.registry.missingContributors] });
  const operations = createPrivacyOperations({ ...deps, registry, verifyMissingSubject: verifyMissingSubscriptionsPrivacySubject,
    now: () => new Date(), randomId: randomUUID } as Parameters<typeof createPrivacyOperations<PgQueryExecutor>>[0] & { store: NativePrivacyStore<PgQueryExecutor> });
  return { ...current, operations, registry };
}
