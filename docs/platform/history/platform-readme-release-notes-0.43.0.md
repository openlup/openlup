# Platform README release notes: 0.43.0 preparation

Status: historical evidence, archived on 2026-11-17.
The following block is preserved from the package README, with relative links
rebased. Its release-specific claims and checkpoints are not current composition
instructions. Use the [current package guidance](../../../packages/platform/README.md#upgrade-guidance)
and the selected release's [changelog](../../../packages/platform/CHANGELOG.md).

## Release notes

Invoicing exports explicit `createInvoiceServices`, `InvoiceServices` and inert
`createInvoiceContribution` through `/invoicing`, with no new composition entry.
`claimInvoiceSellerRevision` reads an injected selection before claim; the pinned
SQL wrappers persist it for eligible obligations. `InvoiceSellerRevision` is also
available from the type-only contracts entry. Legacy obligations keep fallback.

For the prepared `0.43.0` set, read the [adjacent-release migration and known
limitations](../../../packages/platform/CHANGELOG.md#0430) before selecting optional services. This set
adds neutral fulfillment capabilities, native dispatch, intake, reconciliation,
replacement arrival/alignment, delivery-contact correction and an offline
adapter testing entry. Native payment provider profiles preserve the existing
policy variants; a third provider needs a declaration plus its adapter. Apply
all seven ordered forwards at slots 135–141, through
`20261121100000_order_delivery_contact_correction.sql`, including the event-erasure
lock preparation and payment-profile forward. Hosts explicitly compose the
selected provider port, authorization, transactions, intake and schedules.
The starter still selects sandbox payments; portable payment composition covers
the reference card provider only. The warehouse adapter remains a reference
example, and offline evidence supplies no live provider/carrier qualification.
Apply the complete selected migration catalogue before composing the new native
bindings. Experimental
marketing uses browser-safe `./marketing`, type-only browser-safe
`./marketing/contracts`, and Node-only `./marketing/server` and
`./marketing/server/postgres`. Marketing contributions and bindings remain
inert and default-off. Experimental
account/support APIs use `./account-support` and the type-only
`./account-support/contracts`; reference bindings remain inert and default-off.
Apply the M12 support-authority forwards after complete same-rail predecessors
and follow the email-correction admission, claim, identity-commit and settlement
migration notes before replacing retired callers. Experimental
commerce schemas and ports use `./commerce` and `./commerce/contracts`;
handlers, adapters and checkout engines use the Node-only `./commerce/server`.
The commerce contribution and reference binding remain inert and default-off.
Install the complete native chain through the M17 purchased-source forward
(`20261030122000_channel_purchased_source.sql`). Use the complete packaged installer described below; individual module SQL
projections are not an install chain. Native runtime
roles need the ATP/exposure EXECUTE and underlying SELECT grants described in
the release notes.
Managed hosts apply the complete prefix through `20261030122000`, including
the two channel forwards, the support-authority forward and M11's nine forwards for preference/return ownership, operator receipts,
acquisition/finalize admission, ATP preview and starter graduation. Legacy
omitted-country input uses the configured settlement region; neutral commands
require explicit country. Starter graduation admits 14, 21 or 28 days; rollback
below that forward with a 21-day marker is unsupported, so roll forward.
The service-only ATP preview uses owner privileges and a fixed search path.
Retain exact applied failure-attempt attribution for the existing managed
dunning overloads; native attempt-replay parity remains registered. These
managed forwards authorize no host activation.
Preserve captured obligations and receipts on rollback.
M10 subscription services and contributions remain **EXPERIMENTAL and DEFAULT-OFF**.
Hosts explicitly supply readiness, execution, commands, mandatory G23 admission,
a population lease and M04 delivery. Factories activate no serving work. The inert
native reference composes renewal, dunning and stock wait; managed TypeScript
stock recovery and native multi-cycle prepaid retain their named unsupported
boundaries. The earlier M07 prepared-attempt-store refusal described the
pre-store checkpoint; `paymentSchemaDescriptor.preparedDurableStore` is now
`supported` with the appended store installed. Follow the older native-row
migration precautions when upgrading `0.22.0` data.
M09 invoicing remains **EXPERIMENTAL and DEFAULT-OFF**, available for explicit
provider/capability selection and ready host composition, including issue,
correction, independent duties, delivery/read-side and seller revision helpers.
Adopters must not activate unselected or unready invoicing; installation and
inert contributions register no runner, worker, route or schedule.
M06 managed-host proof classes remain pending in the
[M06 parity ledger](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m06-stock-reservations-delivery.md#parity-pending-rows).
Size comparison uses the published `0.42.0` tarball. Preparation and offline
adapter evidence grant no publication or provider-account certification.

The set requires Zod `^4.6.6` for GHSA-mrhx-c7xc-m3w5.
Public quote requests retain their collection limits and valid-input behavior;
oversized collections now fail with the size error before accumulating invalid
element errors. Package API and installed-consumer checks remain required.
The observation adapter explicitly retains minute-precision timestamps
alongside seconds/fractions, compact offsets and local timestamps. Calendar
validation still rejects impossible dates; validation never rewrites the raw
timestamp used in the webhook's idempotency key.

The experimental migration source may supply `assertSession` to observe host
facts once under the existing advisory lock, after exact ledger-prefix admission
and before status, dry-run or pending SQL. Every source uses catalog-bound locks
and admits only the canonical baseline ledger catalog shape before reading its
exact prefix. The fingerprint stays exact except for numeric `pg_attver` column version markers in a nonempty, one-dimensional array starting at index 1; every other attribute option refuses admission.
A pending unit locks an installed ledger before its first catalog
read in that transaction and preserves the connection's isolation setting. The
[migration owner](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/upgrade/database-migrations.md#select-the-complete-catalogue)
and [runner witness](https://github.com/openlup/openlup/blob/main/packages/platform/test/migrations/postgresRunner.test.ts) define that boundary;
this callback does not provision or qualify a hosted installation.

Customer checkout recovery entry points in `./commerce/server` provide signed-in
navigation tokens and cookie-authorized buyer mail with atomic bucket deduplication.
Both preserve earlier links and refuse renewal-cycle orders. See the
[customer recipe](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/checkout-recovery.md#add-customer-recovery-entry-points)
for session binding, PostgreSQL ports, lifetimes and host delivery/UI obligations.

Checkout recovery inspection in `./commerce/server` adds service-only original
and latest-descendant readers, capability-gated expired presentation and an
adopter-owned content validation fence. Inspection cannot authorize payment or
create a replacement. Renewal cycles refuse; initial declarations retain their
separate native identity. See the [inspection recipe](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/checkout-recovery.md#inspect-a-link-before-showing-recovery-controls).

Expired checkout recreation in `./commerce/server` adds a safety-first service,
service-only lineage preparation, native draft replay and transaction-bound
sandbox purchase/compensation adapters. The same adopter content fence gates
validation and recreation. The runtime rechecks source payment evidence under the source aggregate lock
before first stock or payment admission. A linked replacement cannot change its
predecessor. Preparation copies recorded buyer snapshots and leaves an absent
`invoiceBuyerSnapshot` key absent, allowing first-duty capture to select the owned
billing profile/address, then the marked shipping fallback. Recorded empty objects
remain explicit. Install the complete catalogue through
`20261110280000_checkout_recovery_buyer_snapshot.sql`; existing orders are not
backfilled. A replacement initial subscription receives a new
provisional declaration; its terminal predecessor and live subscriptions stay
unchanged. Renewal cycles refuse. The native prior-payment safety adapter in
`./payments` uses actual simulator attempts; real-provider paths retain their
named unsupported refusal. See the [recreation recipe](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/checkout-recovery.md#recreate-a-technically-expired-checkout)
for required host authority, executor binding and the real-money closure limit.

Atomic sandbox checkout guidance uses
`createPostgresPaymentRecoveryGuidancePort` in `./commerce/server`, with
`normalizeSandboxPaymentRecoveryEvidence` from `./payments`.
`readAuthorizedPaymentRecovery` binds validation-only token or verified cookie
authority and derives Core refusal actions. One service-only SQL statement
rechecks authority and reads status, raw activation/gap facts and bounded evidence.
Captured observations suppress refusal advice without claiming settlement.
Opaque native method references establish no method or operation; those guidance
fields remain unknown. Non-sandbox channels retain the existing named refusal.
The host keeps status capability opt-in, its legacy display fallback and response
shape. See the [atomic guidance recipe](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/checkout-recovery.md#show-payment-recovery-guidance-from-one-snapshot).

### Checkout token payment

The sandbox preview composes `createCheckoutRecoveryPayService`,
`createCheckoutRecoveryTokenPay` and `withCheckoutRecoveryPaymentHold` from
`commerce/server` with `createPostgresSandboxCheckoutRecoveryAttemptPort` from
`payments`. It retries on the same order/intent, binds method facts to the request
key and rechecks checkout authority under locks. Renewal cycles refuse; initial
declarations remain eligible. Hold policy/read ports stay host-owned. Other
channels keep the named native refusal. See the
[composition recipe](../../../packages/core/docs/guide/how-to/build/checkout-recovery.md#retry-payment-with-a-recovery-token)
and [PostgreSQL witnesses](../../../tests/postgres/checkoutRecoveryPay.test.ts).

### Exact inline checkout retry

`createCheckoutInlineRecovery` composes the exact configured continuation codec,
atomic guidance, native order reader, registered synthetic methods and
`createPostgresSandboxInlineRecoveryAttemptPort`. It requires the exact failed
predecessor, failed intent and permitted method action. Cookie authority is
checked before reads; bearer authority cannot widen it. The existing hold
wrapper gates fresh attempts. Durable nonce/rail replay returns the replacement
cookie and existing result without redispatch, including safe polling when
readback lags. Renewal cycles and observed success refuse. See the
[composition recipe](../../../packages/core/docs/guide/how-to/build/checkout-recovery.md#retry-the-exact-failed-attempt-inline)
and [PostgreSQL witnesses](../../../tests/postgres/checkoutInlineRecovery.test.ts).

<!-- End of the archived README block. -->
