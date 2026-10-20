/** Sparse projections of canonical units, never an install chain. */
export const INVENTORY_MIGRATIONS = [
  { id: "20260814000000_fulfillment_stock_evidence", catalogPath: "db/platform/migrations/20260814000000_fulfillment_stock_evidence.sql", position: 27, sha256: "df20c2491cb0196b4e28d19e7578c95bfa5c87b8f89fb0b6284c0e0695a3cc1d", url: new URL("../../sql/20260814000000_fulfillment_stock_evidence.sql", import.meta.url) },
  { id: "20260815120000_automatic_subscription_renewal", catalogPath: "db/platform/migrations/20260815120000_automatic_subscription_renewal.sql", position: 33, sha256: "edef131f4f483a009e0bb6728a071ab78b6c9ac2aa8047aa7107646a11baec73", url: new URL("../../sql/20260815120000_automatic_subscription_renewal.sql", import.meta.url) },
] as const;
