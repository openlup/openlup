/** Sparse canonical catalogue projection, not a standalone installation chain.
 * Install the complete catalogue and verify its installed prefix and live inventory.
 */
export const RISK_MIGRATIONS = [
  { id: "20260813230000_post_order_control", catalogPath: "db/platform/migrations/20260813230000_post_order_control.sql", position: 26, sha256: "f24ff3ee3c1022f73162db03b8900c93614d3d6d4c6375cf4aad8a3c0f3360a7", url: new URL("../../../sql/20260813230000_post_order_control.sql", import.meta.url) },
] as const;
