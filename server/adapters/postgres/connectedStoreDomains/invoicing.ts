export const invoicingDomain = {
  owned: {
    buyerSnapshots: [
      "invoicing_buyer_snapshots",
    ],
    cutoverAndDocuments: [
      "invoicing_cutover",
      "invoicing_document_observations",
      "invoicing_delivery_receipts",
      "invoicing_seller_revisions",
    ],
  },
  restore: {
    all: [
      "invoicing_cutover",
      "invoicing_duties",
      "invoicing_seller_revisions",
      "invoicing_buyer_snapshots",
      "invoicing_fact_revisions",
      "invoicing_effect_receipts",
      "invoicing_capture_faults",
      "invoicing_document_observations",
      "invoicing_delivery_receipts",
    ],
  },
  allowedInsertTriggers: {},
} as const;
