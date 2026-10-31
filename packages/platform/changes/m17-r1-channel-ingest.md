- Add experimental normalized channel contracts/helpers and Node ingest, retained paid-source, webhook/operator, pull and recovery bindings at existing Platform subpaths. Existing commerce owners retain order, payment, inventory and fulfillment effects.
- Preserve original capture/approval/BOM/money/payment identities and page/CAS receipts. Managed retained conversion uses the existing ATP hook and unchanged allocator; portable physical conversion refuses by name. Privacy lifecycle export/erasure is unavailable.

### Migration

Install the complete selected catalogue including the two new channel forwards; sparse `CHANNEL_INGEST_MIGRATIONS` package assets are byte-identical projections, not an install chain. Hosts explicitly supply provider decoding, owner ports, currency policy and enablement. Importing the package enables no route, job, simulator or provider. No npm publication or hosted/provider qualification is implied.

With the complete 0.35.0 catalogue, `outbox_events` also needs the owner path, so the generic utility refuses it; that owner path is reference-source only.
