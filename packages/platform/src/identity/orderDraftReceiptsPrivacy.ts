import type { PgQueryExecutor } from "../data/index.js";
import { PrivacyRefusal, type PersonalDataContributor, type ResolvedPrivacySubject } from "./privacyPorts.js";
import { personalDataDocumentSchema } from "./contracts/privacy.js";
import { orderDraftReceiptContributorId as contributorId, orderDraftReceiptContributorVersion as version,
  orderDraftReceiptObligations, orderDraftReceiptReconciliationId } from "./orderDraftReceiptCoverage.js";

type ReceiptSubject = ResolvedPrivacySubject & { [orderDraftReceiptReconciliationId]?: string };

/** @experimental Native order draft receipt privacy. */
export function createOrderDraftReceiptsPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
  return {
    id: contributorId, version, ownedResources: orderDraftReceiptObligations().map(obligation => obligation.resource),
    async prepareErasure() {},
    async export(db, { contactId, principalId }) {
      const { rows } = await db.query("SELECT public.commerce_export_order_draft_receipts_v2($1, $2) AS document", [contactId, principalId]);
      return personalDataDocumentSchema.parse(rows[0]?.document);
    },
    async assessErasure() { return { obligations: orderDraftReceiptObligations() }; },
    async eraseOrRetain(db, subject: ReceiptSubject) {
      const { rows } = await db.query("SELECT public.commerce_erase_order_draft_receipts_v2($1, $2, $3) AS changed",
        [subject.contactId, subject.principalId, subject[orderDraftReceiptReconciliationId] ?? null]);
      const changed = rows[0]?.changed;
      if (changed === -1) throw new PrivacyRefusal("PRIVACY_OWNERSHIP_UNDECLARED");
      if (typeof changed !== "number" || !Number.isInteger(changed) || changed < 0) throw new Error("receipt_erasure_result_invalid");
      return { contributorId, version, obligations: orderDraftReceiptObligations() };
    },
  };
}
