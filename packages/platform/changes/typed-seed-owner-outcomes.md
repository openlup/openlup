---
type: fix
---

Native stock-current writes and reminder schedule installation expose named
rejections for changed stock replay and schedule changes blocked by open orders.
The starter installer reports the affected stock SKU or the number of blocking
orders, with the repair and recheck instructions.

Migration:

- Apply the complete ordered SQL migration chain. Match
  `FulfillmentStockReplayConflictError` from `@openlup/platform/fulfillment`
  and `CheckoutRecoveryScheduleChangeBlockedError` from
  `@openlup/platform/commerce/server` using `instanceof`. The original
  driver error is the non-enumerable `cause`. Read `blockingOrders` as a decimal
  string after checking the reminder class. Roll back explicit transactions
  after a refused write.
- The SQL raises retain their existing state, message and hint and add private
  `DETAIL` values. Update exact driver snapshots where applicable. Against
  predecessor schemas the owners pass through the original rejections.
- Starter checkout classifies a stock write as a command conflict only for
  the nominal replay rejection. A raw stock `23505`, including a refusal from
  a predecessor schema, takes the operational failure path. Check the
  package and migration versions when investigating that response.
- Handle the two named reports from the demonstration installer by their
  first-line codes. Restore the original stock inputs for the reported SKU
  or wait for the reminder blockers to clear, then rerun `./lifecycle up`.
