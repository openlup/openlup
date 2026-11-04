Add native order, subscription and shipment destination authority through
`commerce/server/destinations` and the bounded operator address branch. Exact
replay retains applicability; changed input and stale template versions refuse.
Dispatch-owned parcels keep their frozen address with `applied_from_next_parcel`.
The subscription event and deduplicated confirmation outbox commit atomically;
mail dispatch stays host-bound. Private address and binding rows join bounded
store transfer. No saved address book, destination privacy export/erasure, money
or delivery-alignment change. Hosts must display next-parcel applicability and
install the complete catalogue before composing this experimental entry.

Migration: Install the complete native catalogue before binding
`createPostgresDestinationPort`. Native operator address calls previously
returned the authority-unavailable refusal; they now use the bounded address
routine. Handle `applied_from_next_parcel` explicitly and show that the frozen
parcel retains its old destination. Do not treat it as fully applied current
delivery. The managed result type is unchanged. Hosts must bind checkout and
authoritative shipment reads themselves; no saved-address or mail route is added.
