/** Sparse projections of canonical units, never an install chain. */
export const BUNDLE_MIGRATIONS = [
  { id: "20260812140000_sellable_bundle_catalog", catalogPath: "db/platform/migrations/20260812140000_sellable_bundle_catalog.sql", position: 16, sha256: "62fbf0910a3a7a2ee47e2d798933fe0a5a273fd1242cae7cc78ff237ba39e394", url: new URL("../../sql/20260812140000_sellable_bundle_catalog.sql", import.meta.url) },
  { id: "20260812210000_bundle_operator_write_boundary", catalogPath: "db/platform/migrations/20260812210000_bundle_operator_write_boundary.sql", position: 19, sha256: "d0ec6674d7eedf4cd3ce0d8ccd7345ebe2f93da635316a68a6bd178ec55b2679", url: new URL("../../sql/20260812210000_bundle_operator_write_boundary.sql", import.meta.url) },
] as const;

/** Catalog foundation projections; install the complete canonical catalogue. */
export const CATALOG_MIGRATIONS = [
  { id: "20260807140000_read_parity_catalog", catalogPath: "db/platform/migrations/20260807140000_read_parity_catalog.sql", position: 1, sha256: "fcf3827028c1651ae42a7c7d7472153825a3121c936d58a3d105befc7dece9ea", url: new URL("../../sql/20260807140000_read_parity_catalog.sql", import.meta.url) },
  { id: "20260810120000_storefront_catalog_attributes", catalogPath: "db/platform/migrations/20260810120000_storefront_catalog_attributes.sql", position: 8, sha256: "2bf938f5d0076193557bea834f86dbd9bcb7f3e2de00f99fb91cc1229b93a14b", url: new URL("../../sql/20260810120000_storefront_catalog_attributes.sql", import.meta.url) },
  { id: "20260827220000_catalog_document_revision_foundation", catalogPath: "db/platform/migrations/20260827220000_catalog_document_revision_foundation.sql", position: 58, sha256: "715e74d655b76d35b8a49e0d2a5625594a6c4856863f369cd1eadcd1fb1ae90e", url: new URL("../../sql/20260827220000_catalog_document_revision_foundation.sql", import.meta.url) },
  { id: "20260827220001_catalog_document_revision_foundation_validate", catalogPath: "db/platform/migrations/20260827220001_catalog_document_revision_foundation_validate.sql", position: 59, sha256: "f3cd7fb61dcebac1cf0468cf2d7c1f9dd036817ab0094c72864266e307b269de", url: new URL("../../sql/20260827220001_catalog_document_revision_foundation_validate.sql", import.meta.url) },
  { id: "20260908100000_catalog_draft_foundation", catalogPath: "db/platform/migrations/20260908100000_catalog_draft_foundation.sql", position: 61, sha256: "ac0d614cdb2874df8fbdbbbda4f9455986ef95241fe1334b0b54a1fa6478ab2e", url: new URL("../../sql/20260908100000_catalog_draft_foundation.sql", import.meta.url) },
] as const;
