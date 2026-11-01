Add native purchase holds through `createPostgresPurchaseReservationPort`: atomic
item batches, keyed release and bounded expiry on the existing reservation tables.
`createPostgresAbandonedCheckoutCompensationPort` cancels an abandoned checkout
and releases its purchase holds atomically without a runtime ledger grant.
Changed keyed input and elapsed initial expiry refuse. Existing ATP, renewal,
stock wait and retry count these hard holds. Lots, locations, balance counters
and movement history remain outside this slice. Hosts bind the checkout seam
and schedule expiry; dedicated promotion cancellation remains unbound. References
may identify people; hosts should use opaque values. No erasure path is provided.
Managed behavior is unchanged. No npm release or automatic host wiring is included.
