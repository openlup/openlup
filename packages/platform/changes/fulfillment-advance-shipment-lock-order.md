For the next 1.x release. On the native rail, `public.fulfillment_advance_shipment`
acquires the parent `public.subscriptions` row lock before locking
`public.fulfillment_shipments`, matching the canonical delivery-alignment lock
order (`subscriptions` -> `fulfillment_shipments` -> `subscription_delivery_alignment_cases`)
and preventing `40P01` deadlocks against concurrent renewal admission.

Migration: apply the additive native forward
`20261124090000_fulfillment_advance_shipment_lock_order.sql`. No data rewrite,
privilege change, or TypeScript caller change is required.
