import type { PgQueryExecutor } from "../data/index.js";
import type { PersonalDataContributor } from "./privacyPorts.js";
import type { PrivacyJson } from "./contracts/privacy.js";

type DestinationPrivacyOwner = {
  id: string;
  version: string;
  evidence: string;
  tombstones: string;
  reasonCode: string;
  included: string[];
  exportSql: string;
  eraseSql: string;
};

function destinationPrivacy({
  id, version, evidence, tombstones, reasonCode, included, exportSql, eraseSql,
}: DestinationPrivacyOwner): PersonalDataContributor<PgQueryExecutor> {
  const obligations = [
    { owner: id, resource: evidence, disposition: "erase" as const, reasonCode, remote: false },
    { owner: id, resource: tombstones, disposition: "retain" as const,
      reasonCode: "PSEUDONYMOUS_ERASURE_FENCE", remote: false },
  ];
  return {
    id, version, ownedResources: obligations.map(({ resource }) => resource),
    // Identity takes the ledger fence before resolving the subject.
    async prepareErasure() {},
    async export(db, subject) {
      const data = subject.contactId ? (await db.query(exportSql, [subject.contactId])).rows[0]!.data : [];
      return { contributorId: id, version, data: data as PrivacyJson, obligations,
        coverage: { complete: true, included, unavailable: [] } };
    },
    async assessErasure() { return { obligations }; },
    async eraseOrRetain(db, subject, assessment) {
      if (subject.contactId) await db.query(eraseSql, [subject.contactId]);
      return { contributorId: id, version, obligations: assessment.obligations };
    },
  };
}

/** @experimental Compose native destination receipt export and erasure with the identity privacy transaction. */
export function createDestinationReceiptPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
  return destinationPrivacy({
    id: "destination-receipts", version: "commerce.destination-receipts.v1",
    evidence: "commerce.destination-receipt-evidence", tombstones: "commerce.destination-receipt-tombstones",
    reasonCode: "PRIVATE_DESTINATION_RECEIPT_EVIDENCE",
    included: ["private destination receipt evidence", "destination receipt erasure metadata"],
    exportSql: "SELECT public.commerce_destination_v2_receipts_export($1::uuid) AS data",
    eraseSql: "SELECT public.commerce_destination_v2_receipts_erase($1::uuid)",
  });
}

/** @experimental Compose native checkout destination export and erasure with the identity privacy transaction. */
export function createDestinationDocumentPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
  return destinationPrivacy({
    id: "destination-documents", version: "commerce.destination-documents.v1",
    evidence: "commerce.destination-document-evidence", tombstones: "commerce.destination-document-tombstones",
    reasonCode: "PRIVATE_DESTINATION_DOCUMENT_EVIDENCE",
    included: ["private checkout destination documents", "destination document expiry and erasure metadata"],
    exportSql: "SELECT public.commerce_destination_v2_export($1::uuid) AS data",
    eraseSql: "SELECT public.commerce_destination_v2_erase($1::uuid)",
  });
}
