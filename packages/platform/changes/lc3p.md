Add unbound native offer-policy readiness inputs for the catalogue price writer.
Existing subscriptions receive the legacy policy pair and a default-false fixture
marker; future ordinary inserts default to pending acquisition. Installation
records immutable marking-time count, membership fingerprint and database time.
The separately audited, parameterless service capture inserts its baseline once.
A fresh installation can capture zero only with genuine empty marking provenance;
a populated marking becoming empty retains the empty-baseline refusal.

Migration: Apply the complete native migration catalogue. Old readers ignore the
additive evidence columns. New price-writer integration must call the read-only
input checks on its transaction before and after provisional prices, propagate
hard domain/provenance refusals, and retain ordinary acquisition reasons. Audit
the complete legacy non-fixture cohort, including paused and cancelled rows,
before explicitly invoking `commerce_capture_offer_policy_v2_legacy_baseline()`
through the existing service SQL boundary. Installation and transfer never
capture a baseline. Capture replay returns the original audit. Transfer carries
marking and baseline bytes, reconciling only the actual pristine target marking
row. Code rollback leaves the additive evidence and immutable audit in place;
never reset a baseline to make a failed comparison pass. No capability is enabled,
no application is composed, and no agreement is repriced or rescheduled.

Managed divergence design: A managed twin would add the same policy and fixture
columns to its subscriptions and separate cohort-marking/baseline tables. Keep
marking owner-written and immutable to ordinary service DML; use RLS for service
SELECT/INSERT on baselines, deny browser access and UPDATE/DELETE, and retain the
service-authorized audited capture. Its promotion, order and agreement adapters
must establish their own actual domain/history evidence. The native helper roles
are expressible through those RLS policies. No food-column relaxation applies:
this change authors no product or SKU shape. The managed rail does not supply
this feature.
