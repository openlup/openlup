- Add the experimental native operator shipment command factory for atomic label evidence, exact reservation consumption at handoff and tracking chronology with server actor and durable replay evidence.
- Preserve earlier-only delivered replay through the arrival recorder, operator-authorized latest-operation reads and fail-soft accounting composition after handoff. Historical missing reservation sets return a named zero-consumption result; unattributed cross-order tracking references refuse with the conflicting order reference. The documented limits describe manual resolution.

Migration: Apply the complete native catalogue through
`20261110230000_operator_shipment_commands.sql` before selecting these stores.
Tracking-reference writes through `fulfillment_record_evidence` (including spine
`recordTracking` with an evidence channel) require explicit
`metadata.providerKind` and READ COMMITTED. Missing provider identity or another
isolation level refuses before writing; non-tracking evidence is unchanged.

Install the complete selected native catalogue through `20261110230000_operator_shipment_commands.sql`. Hosts retain administrator authorization, provider selection, duty policy and connection ownership. No operator UI or live carrier call is added.

- The approved packed-byte cap of 3,023,741 B is retained. The higher approved code-file cap of 4,211 is retained; its prior measurement was 4,128 files plus 2% headroom. The released baseline is unchanged.
- Tracking-reference writers require READ COMMITTED and an explicit provider namespace, including shared shipment evidence. Exact handoff receipts replay before any new status transition.

Label URLs are durable operator-only operation evidence, and the full label and
tracking requests retain raw provider payloads/events in private operator
receipts. Hosts authorize these reads and govern retention of records and
backup/transfer copies; there is no automatic expiry or purge. Do not forward
operation payloads to customer routes. Replay preserves original evidence.
