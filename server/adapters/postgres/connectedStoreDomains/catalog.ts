export const catalogDomain = {
  owned: {
    // AUTHORITATIVE pack metadata; no customer FK or absorption/erasure duty.
    // Authoritative draft history and identity reservations, including abandoned drafts.
    // AUTHORITATIVE immutable publications, complete SKU revisions, scoped receipts and approval decisions.
    // The transient catalog_publication_pointer_capabilities table stays outside this profile;
    // the existing unknown-nonempty refusal requires it to be empty, rather than carrying authority.
    core: [
      "catalog_type_versions",
      "catalog_definition_installs",
      "catalog_tax_classes",
      "catalog_products",
      "catalog_product_document_revisions",
      "catalog_skus",
      "catalog_sku_identifiers",
      "catalog_draft_heads",
      "catalog_draft_revisions",
      "catalog_draft_command_receipts",
      "catalog_draft_sku_reservations",
      "catalog_publications",
      "catalog_sku_revisions",
      "catalog_publication_heads",
      "catalog_operator_receipts",
      "catalog_publication_decisions",
    ],
    // AUTHORITATIVE catalogue-local exact-command replay evidence.
    priceSetup: [
      "catalog_price_setup_receipts",
    ],
  },
  restore: {
    // AUTHORITATIVE pack metadata; no customer FK or absorption/erasure duty.
    core: [
      "catalog_type_versions",
      "catalog_definition_installs",
      "catalog_tax_classes",
      "catalog_products",
      "catalog_product_document_revisions",
      "catalog_skus",
      "catalog_sku_identifiers",
      "catalog_draft_heads",
      "catalog_draft_revisions",
      "catalog_draft_command_receipts",
      "catalog_draft_sku_reservations",
      "catalog_publications",
      "catalog_sku_revisions",
      "catalog_publication_heads",
      "catalog_operator_receipts",
      "catalog_publication_decisions",
    ],
    priceSetup: [
      "catalog_price_setup_receipts",
    ],
  },
  // Publication guards validate restored facts and the complete ledger. The
  // live-write binding triggers are scoped to the dedicated publication login.
  allowedInsertTriggers: {
    catalog_products: ["catalog_products_publication_pointer_fence", "catalog_publication_live_write", "catalog_products_lifecycle_projection_final"],
    catalog_skus: ["catalog_skus_publication_facts_admitted", "catalog_publication_live_write", "catalog_skus_lifecycle_write_fence"],
    catalog_sku_identifiers: ["catalog_publication_live_write"],
    catalog_product_document_revisions: ["catalog_publication_live_write"],
    catalog_publications: ["catalog_publications_issued", "catalog_publication_record_write_binding", "catalog_publications_open_draft"],
    catalog_price_setup_receipts: ["catalog_publication_live_write"],
    catalog_sku_revisions: ["catalog_sku_revisions_issued"],
    catalog_operator_receipts: ["catalog_receipts_issued"],
    catalog_publication_decisions: ["catalog_decisions_issued"],
    catalog_publication_heads: ["catalog_heads_issued"],
  },
} as const;
