/** Sparse projections only. Install the complete native/managed prefix, never this list alone. */
export const ACCOUNT_SUPPORT_MIGRATIONS = {
  native: { units: [{ position: 87, catalogPath: "db/platform/migrations/20261026120000_account_support_operator_authority.sql",
    sha256: "ac1e31679179e712d7558e7b1d82e8113f264abf9aaa44c2562ab988acdc7508",
    url: new URL("../../sql/20261026120000_account_support_operator_authority.sql", import.meta.url) },
    { position: 108, catalogPath: "db/platform/migrations/20261110120000_customer_account_events.sql",
      sha256: "a22217cedd0cb26352736a046ca2ccc48334a27dd14d494cacff8617323cf9c7", url: new URL("../../sql/20261110120000_customer_account_events.sql", import.meta.url) }] },
  managed: { units: ["supabase/migrations/20261026120100_account_support_current_authority.sql"] },
} as const;
