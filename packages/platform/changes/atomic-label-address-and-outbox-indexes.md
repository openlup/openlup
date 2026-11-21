For the next 1.x release. Adds partial indexes for active `public.outbox_events`
rows and consolidates `recordLabel` (`createPostgresFulfillmentShipmentSpinePort`)
and `upsertAddress` (`createPostgresCustomerSavedAddressPort`) into single-round-trip
atomic PostgreSQL RPCs (`public.fulfillment_record_label_atomic` and
`public.customer_saved_address_upsert_atomic`).

Migration: apply the two additive native forwards
`20261124100000_outbox_active_partial_indexes.sql` and
`20261124110000_shipment_label_and_address_upsert_atomic.sql` before deploying
the updated `@openlup/platform` package. Historical per-step idempotency keys are
preserved, and failed `upsertAddress` or `recordLabel` calls now roll back
atomically instead of leaving partial commits.
