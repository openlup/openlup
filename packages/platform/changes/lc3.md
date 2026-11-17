Adds an unbound native immediate base-price writer, validated preview/apply/readback
use case, PostgreSQL store and portable receipt/command contracts under pricing.
The command retains the draft-v2/v3 price-operation grammar and exact canonical
bytes. Later context, scheduling and list-lifecycle command extensions remain
reserved for a new payload version.

Migration: install the complete native catalogue through position 150,
`20261122180000_catalog_base_price_writer`, after the native readiness-input unit.
Old price readers continue reading ordinary price entries. New callers explicitly
bind a verified human administrator's session to the store and handler; the SQL
derives the actor, serializes receipt before price context, compares the expected
base and atomically closes/inserts at one database statement instant. No capability
is activated. Readiness reads native financial, agreement and audited cohort
evidence; missing proof hard-refuses independently of ordinary readiness reasons.
The existing global reason-membership aggregation defect remains unchanged: a
second invalid SKU can remain hidden by an already present aggregate price-shape
reason. This writer changes no agreed subscription money or schedule.

The catalogue-local receipt relation is authoritative transfer data. Retain its
exact fingerprints, actor metadata and responses with price history; no customer
foreign key or client-absorption rule is added. Rollback means unbinding callers;
retain committed history and receipts, and use a later expected-base command to
correct a price. Do not delete evidence or downgrade a live database.

Managed divergence design: a managed twin would use the existing managed
`price_lists`, `price_entries`, subscription, promotion and operational evidence
tables, plus a separately admitted catalogue receipt relation. Managed RLS must
deny direct receipt/price writes and expose bounded execution only to verified
active human administrators, excluding machine and revoked principals. Reconcile
the managed role/administrator authority with its incumbent policies; authorization
does not depend on a native-only role. The native readiness-input mapping and its
audited never-populated baseline delta require their managed equivalents. Existing
industry-specific catalogue columns are untouched; this price-only change needs
no relaxation. The managed rail does not supply this feature.

Stable 1.0 coordination (CD-S1-1): all new catalogue base-price writer symbols,
including contracts, schemas, handler/store ports and factories, canonical command
serialization and refusal helpers, are marked `@experimental` from their introduction.
They are outside the 1.0.0 SemVer promise. Existing catalogue readers retain their
current status. New result/kind unions and the hard-refusal reason tuple grow by
addition only (D3); no existing union member is removed or renamed.
