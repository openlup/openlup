/** Sparse projections of canonical units, never an install chain. */
export const PAYMENT_MIGRATIONS = [
  { id: "20260810180000_payment_settlement_rail", catalogPath: "db/platform/migrations/20260810180000_payment_settlement_rail.sql", position: 10, sha256: "af153aadedc09c07b25f69300d335d8928526cad126646c1b9bf25341f1c2d0e", url: new URL("../../sql/20260810180000_payment_settlement_rail.sql", import.meta.url) },
  { id: "20260815150000_payment_truth_reconciliation", catalogPath: "db/platform/migrations/20260815150000_payment_truth_reconciliation.sql", position: 35, sha256: "dd38a601edc2f43f259eefc2cdb9af14fd37fe792a7f82e58c351bd373a88905", url: new URL("../../sql/20260815150000_payment_truth_reconciliation.sql", import.meta.url) },
  { id: "20260826100000_late_payment_shifts_the_subscription_cycle", catalogPath: "db/platform/migrations/20260826100000_late_payment_shifts_the_subscription_cycle.sql", position: 56, sha256: "992540b0f49713d604859926624b3bef09d5075b68b604f069dcbd688328e452", url: new URL("../../sql/20260826100000_late_payment_shifts_the_subscription_cycle.sql", import.meta.url) },
] as const;
