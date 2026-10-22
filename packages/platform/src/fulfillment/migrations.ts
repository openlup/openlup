/** Byte-identical sparse projections; install the complete canonical catalogue. */
export const FULFILLMENT_MIGRATIONS = [
  { position: 5, catalogPath: "db/platform/migrations/20260808210000_fulfillment_shipment_rail.sql", sha256: "eb5824551903717f3868690909fcc2cb6a7f845abe5cb19bd4cff13103b1383d", url: new URL("../../sql/20260808210000_fulfillment_shipment_rail.sql", import.meta.url) },
  { position: 27, catalogPath: "db/platform/migrations/20260814000000_fulfillment_stock_evidence.sql", sha256: "df20c2491cb0196b4e28d19e7578c95bfa5c87b8f89fb0b6284c0e0695a3cc1d", url: new URL("../../sql/20260814000000_fulfillment_stock_evidence.sql", import.meta.url) },
  { position: 51, catalogPath: "db/platform/migrations/20260819150000_fulfillment_shipment_sequence.sql", sha256: "906706cf66a6a555aa1219b12eb674d937eaa099abde6da18766310af43aaa9f", url: new URL("../../sql/20260819150000_fulfillment_shipment_sequence.sql", import.meta.url) },
  { position: 73, catalogPath: "db/platform/migrations/20261022080000_fulfillment_command_ledger.sql", sha256: "c6806906cdb0b6931b29f7a5c7c800016e98d04e6ea956f3c1e219a6cdb7e9d1", url: new URL("../../sql/20261022080000_fulfillment_command_ledger.sql", import.meta.url) },
  { position: 74, catalogPath: "db/platform/migrations/20261022090000_fulfillment_delivery_alignment.sql", sha256: "d9966ae79fe77a0feae8317dc5b46ef2d8196dd0790b1cd0ee1b06ab58061499", url: new URL("../../sql/20261022090000_fulfillment_delivery_alignment.sql", import.meta.url) },
] as const;
