/** Sparse projections of canonical units, never an install chain. */
export const BUNDLE_MIGRATIONS = [
  { id: "20260812140000_sellable_bundle_catalog", catalogPath: "db/platform/migrations/20260812140000_sellable_bundle_catalog.sql", position: 16, sha256: "62fbf0910a3a7a2ee47e2d798933fe0a5a273fd1242cae7cc78ff237ba39e394", url: new URL("../../sql/20260812140000_sellable_bundle_catalog.sql", import.meta.url) },
  { id: "20260812210000_bundle_operator_write_boundary", catalogPath: "db/platform/migrations/20260812210000_bundle_operator_write_boundary.sql", position: 19, sha256: "d0ec6674d7eedf4cd3ce0d8ccd7345ebe2f93da635316a68a6bd178ec55b2679", url: new URL("../../sql/20260812210000_bundle_operator_write_boundary.sql", import.meta.url) },
] as const;
