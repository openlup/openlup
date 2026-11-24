import type { PgQueryExecutor } from "../data/index.js";
import type { PersonalDataContributor } from "./privacyPorts.js";
import type { PrivacyJson } from "./contracts/privacy.js";

type DestinationPrivacyOwner = {
  id: string;
  version: string;
  evidence: string;
  tombstones: string;
  reasonCode: string;
  retainedOrderBindings?: boolean;
  included: string[];
  exportSql: string;
  eraseSql: string;
  withheldNotice?: string;
};

function destinationPrivacy({
  id, version, evidence, tombstones, reasonCode, retainedOrderBindings, included, exportSql, eraseSql, withheldNotice,
}: DestinationPrivacyOwner): PersonalDataContributor<PgQueryExecutor> {
  const obligations = [
    { owner: id, resource: evidence, disposition: "erase" as const, reasonCode, remote: false },
    { owner: id, resource: tombstones, disposition: "retain" as const,
      reasonCode: "PSEUDONYMOUS_ERASURE_FENCE", remote: false },
    ...(retainedOrderBindings ? [
      { owner: id, resource: "commerce.destination-order-binding-pins", disposition: "erase" as const, reasonCode, remote: false },
      { owner: id, resource: "commerce.destination-order-binding-markers", disposition: "retain" as const,
        reasonCode: "PSEUDONYMOUS_ERASURE_FENCE", remote: false },
    ] : []),
  ];
  return {
    id, version, ownedResources: obligations.map(({ resource }) => resource),
    // Identity takes the ledger fence before resolving the subject.
    async prepareErasure() {},
    async export(db, subject) {
      // Both owner exports return an array of row objects; a withheld row carries `verification`.
      const data = (subject.contactId ? (await db.query(exportSql, [subject.contactId])).rows[0]!.data : []) as { [key: string]: PrivacyJson }[];
      const unavailable = withheldNotice && data.some(row => Object.hasOwn(row, "verification")) ? [withheldNotice] : [];
      return { contributorId: id, version, data, obligations,
        coverage: { complete: unavailable.length === 0, included, unavailable } };
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
    retainedOrderBindings: true,
    included: ["private checkout destination documents", "destination document expiry and erasure metadata",
      "verified order binding pins", "order binding erasure markers"],
    withheldNotice: "Review withheld destination evidence with the destination owner. After cutoff, run commerce_destination_v2_expire for unbound documents and export again.",
    exportSql: "SELECT public.commerce_destination_v2_export($1::uuid) AS data",
    eraseSql: "SELECT public.commerce_destination_v2_erase($1::uuid)",
  });
}
