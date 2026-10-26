/** Sparse projections only. Install the complete native/managed prefix, never this list alone. */
export const ACCOUNT_SUPPORT_MIGRATIONS = {
  native: { units: [{ position: 87, catalogPath: "db/platform/migrations/20261026120000_account_support_operator_authority.sql",
    sha256: "ac1e31679179e712d7558e7b1d82e8113f264abf9aaa44c2562ab988acdc7508",
    url: new URL("../../sql/20261026120000_account_support_operator_authority.sql", import.meta.url) }] },
  managed: { units: ["supabase/migrations/20261026120100_account_support_current_authority.sql"] },
} as const;
