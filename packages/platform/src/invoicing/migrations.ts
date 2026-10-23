/** Sparse native projections, not an installation chain. Install the full catalogue. */
export const INVOICING_MIGRATIONS = {
  native: {
    correctionStorage: "child_document",
    fiscalScope: "explicit_host_facts",
    units: [
      { position: 7, catalogPath: "db/platform/migrations/20260809210000_accounting_document_rail.sql", sha256: "f5c6c4b3d5ccdd7c7137669edba7d45c63685edc57fe982e3e8fd559214ccc8e", url: new URL("../../sql/20260809210000_accounting_document_rail.sql", import.meta.url) },
      { position: 13, catalogPath: "db/platform/migrations/20260811150000_accounting_payout_rail.sql", sha256: "b127631196362d59ceb94700426766659589601c69a5adfb1b5d6bbeadf5b0db", url: new URL("../../sql/20260811150000_accounting_payout_rail.sql", import.meta.url) },
      { position: 15, catalogPath: "db/platform/migrations/20260812130000_accounting_document_lifecycle_rail.sql", sha256: "450ae24b8ba9438ea267cfbf52f9c78a790b1803f369c216577566952fa43b5f", url: new URL("../../sql/20260812130000_accounting_document_lifecycle_rail.sql", import.meta.url) },
      { position: 77, catalogPath: "db/platform/migrations/20261022190000_invoicing_durable_duties.sql", sha256: "2d7bf98924b4ef29b3e8f902d768e45dd9c850242f4358a0193a0c00d0f3d081", url: new URL("../../sql/20261022190000_invoicing_durable_duties.sql", import.meta.url) },
      { position: 78, catalogPath: "db/platform/migrations/20261022191000_invoicing_document_effects.sql", sha256: "0eac3453e2b82c43e4fff9e35bcd6daefdd0bb5f992937f7f411d690550428cf", url: new URL("../../sql/20261022191000_invoicing_document_effects.sql", import.meta.url) },
      { position: 79, catalogPath: "db/platform/migrations/20261022192000_invoicing_payment_decoupling.sql", sha256: "f4af30ee4c9365ea51bd0e95e5cc7ae869cf15dce5867fdd640f679438b36058", url: new URL("../../sql/20261022192000_invoicing_payment_decoupling.sql", import.meta.url) },
      { position: 80, catalogPath: "db/platform/migrations/20261022195000_invoicing_seller_revision.sql", sha256: "5a6348d9af296cfc6383894e3489f70af1f3bb5026c0cc329daa9f3f95802b22", url: new URL("../../sql/20261022195000_invoicing_seller_revision.sql", import.meta.url) },
    ],
  },
  managed: {
    correctionStorage: "base_row",
    fiscalScope: "host_managed_projection",
    units: [
      "supabase/migrations/20261022193000_invoicing_correction_claims.sql",
      "supabase/migrations/20261022193100_invoicing_correction_compatibility.sql",
      "supabase/migrations/20261022195100_invoicing_seller_revision.sql",
    ],
  },
} as const;
