import type { PgQueryExecutor } from "@openlup/platform/data";
import { PrivacyRefusal, type PersonalDataContributor } from "@openlup/platform/identity";
import { personalDataDocumentSchema, type PersonalDataObligation } from "@openlup/platform/identity/contracts";

const contributorId = "order-draft-receipts";
const version = "commerce.order-draft-receipts.v1";
const obligations: PersonalDataObligation[] = [
  { owner: contributorId, resource: "commerce.order-draft-receipt-owner-references", disposition: "erase",
    reasonCode: "RECEIPT_OWNER_REFERENCES_CLEARED", remote: false },
  { owner: contributorId, resource: "commerce.order-draft-receipt-retained-facts", disposition: "retain",
    reasonCode: "RECEIPT_REPLAY_EVIDENCE_RETAINED", remote: false },
];

export function createOrderDraftReceiptsPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
  return {
    id: contributorId, version, ownedResources: obligations.map(obligation => obligation.resource),
    async prepareErasure() {},
    async export(db, { contactId, principalId }) {
      const { rows } = await db.query("SELECT public.commerce_export_order_draft_receipts_v2($1, $2) AS document", [contactId, principalId]);
      return personalDataDocumentSchema.parse(rows[0]?.document);
    },
    async assessErasure() { return { obligations }; },
    async eraseOrRetain(db, { contactId, principalId }) {
      const { rows } = await db.query("SELECT public.commerce_erase_order_draft_receipts_v2($1, $2) AS changed", [contactId, principalId]);
      const changed = rows[0]?.changed;
      if (changed === -1) throw new PrivacyRefusal("PRIVACY_OWNERSHIP_UNDECLARED");
      if (typeof changed !== "number" || !Number.isInteger(changed) || changed < 0) throw new Error("receipt_erasure_result_invalid");
      return { contributorId, version, obligations };
    },
  };
}
