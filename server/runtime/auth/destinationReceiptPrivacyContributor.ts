import type { PgQueryExecutor } from "@openlup/platform/data";
import type { PersonalDataContributor } from "@openlup/platform/identity";
import type { PrivacyJson } from "@openlup/platform/identity/contracts";

export function createDestinationReceiptPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
  const id = "destination-receipts";
  const version = "commerce.destination-receipts.v1";
  const obligations = [
    { owner: id, resource: "commerce.destination-receipt-evidence", disposition: "erase" as const,
      reasonCode: "PRIVATE_DESTINATION_RECEIPT_EVIDENCE", remote: false },
    { owner: id, resource: "commerce.destination-receipt-tombstones", disposition: "retain" as const,
      reasonCode: "PSEUDONYMOUS_ERASURE_FENCE", remote: false },
  ];
  return {
    id, version, ownedResources: obligations.map(({ resource }) => resource),
    // The identity store takes the ledger fence before resolving the subject.
    async prepareErasure() {},
    async export(db, subject) {
      const { contactId } = subject;
      const data = contactId ? (await db.query(
        "SELECT public.commerce_destination_v2_receipts_export($1::uuid) AS data", [contactId],
      )).rows[0]!.data : [];
      return { contributorId: id, version, data: data as PrivacyJson, obligations, coverage: { complete: true,
        included: ["private destination receipt evidence", "destination receipt erasure metadata"], unavailable: [] } };
    },
    async assessErasure() { return { obligations }; },
    async eraseOrRetain(db, subject, assessment) {
      if (subject.contactId) {
        await db.query("SELECT public.commerce_destination_v2_receipts_erase($1::uuid)", [subject.contactId]);
      }
      return { contributorId: id, version, obligations: assessment.obligations };
    },
  };
}
