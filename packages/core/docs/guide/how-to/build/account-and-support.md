# Compose account and support services

Build customer account reads, self-service commands and operator recovery around
your application's verified identity and selected owner ports. Keep customer
routes and operator routes separately authorized.

## Choose the imports

Use `@openlup/platform/account-support` for the runtime factories below. Import
browser-shareable types from `@openlup/platform/account-support/contracts`,
including `AccountReadPort`, `Customer360ReadPort`, `SelfServiceCommandFacade`,
`OperatorRecoveryCommandEnvelope` and `InvoiceAccessPort`. Contribution descriptors
come from `@openlup/platform/composition`.

For capability maturity, consult the
[package reference](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/AGENTS.md#subpath-maturity).

## Bind reads to the customer

Pass separate `account` and `orders` ports to `createAccountReadFacade`. Its
`getAccount`, `listOrders` and `getOrderDetail` methods delegate directly to those
ports. The facade adds no authorization, pagination defaults, retries or error
mapping. Preserve the owner's nulls and failures when mapping results to HTTP.

To assemble an account snapshot, supply `AccountReadSources`,
`AccountReadProjectionPolicy` and an already authorized client row to
`readAccountSnapshot`. Independent sections load in parallel; subscription rows
are bounded before visibility filtering. Recurring money comes from captured
line subtotals. Empty, unpriced or mixed-currency lines leave the recurring amount
unknown. Your `withNextCharge` policy selects the payable-cycle and shipping
facts; your extension and presentation ports supply private fields and copy.

For native persistence, select `createPostgresCustomerOrderHistoryReadStore`
with a verified principal/client scope and `readInvoiceSummaries`, then
`createPostgresAccountReadSources` with that store, an order projection, a clock
and `additional` sources. Supply `readExtension` and `readNextCharges`; select
address, billing-profile, payment-preference, delivery-preference and event
sources explicitly. An absent optional section throws `host_binding_required`
with its `section`, rather than returning an empty success. The companion
`readPaidActivationGaps` reads owned paid orders whose subscription activation
is still missing.

Use `readCustomerOrderSummaries` with the desired limit and projection. It asks
the store to hide `cancelled` and `expired` orders. `readCustomerOrderDetail`
resolves the owned order before loading its lines and companions. Money uses
stored order facts; fulfillment interpretation and source attribution come from
your projection. Native detail refuses unavailable captured money with
`native_account_order_money_unavailable`.

## Authorize support and invoice reads

Compose `createCustomer360ReadFacade` with `authorize`, `journey`, `summary`
and `diagnostics`. Authorization runs before every source read. A false result
returns `{ kind: "denied" }` without reading the source; admitted calls preserve
arguments, nulls and thrown failures. This facade supplies no command authority.

Use `projectCustomer360Snapshot` with supplied journey, recovery, order and
contact evidence plus lifecycle and timeline policies. Recovery eligibility
requires a pending order for the same client; token availability also depends
on unexpired, unused, unrevoked evidence. Audit history is bounded and presented
chronologically. Unselected enrichment is omitted; failed or partial profile
enrichment produces warnings. Contact health, account linkage and sign-in
evidence remain separate facts. Subscription `paymentMethodKind` is omitted
when its source was unselected and null when the selected source has no value.

Pass `accountHistory` and `artifacts` ports to `createInvoiceAccess`. Before
resolving a download, it reads the history and checks the account, order and
document identifiers. A foreign document in a found history returns
`{ kind: "denied" }` before ticket resolution or artifact access. Preserve the
invoice owner's order-reference format. This composition supplies neither an
archive nor storage; `downloadOwnedInvoicePdf` delegates PDF validation to the
invoice reader.

## Select self-service commands

Call `createSelfServiceCommandFacade` with trusted `context`, matching
`capabilities` and only the command ports you select: managed or native
subscription commands, `profile`, `paymentMethod`, `commerce` and `recovery`.
Each returned method checks the principal before delegation or an unavailable
result. Raw and typed native commands must also carry the context's `clientId`.
Identity mismatches throw `customer_principal_mismatch`; inconsistent graph
selection throws `customer_graph_mismatch`.

Incomplete selected ports, or capabilities that require an absent command port,
throw `customer_self_service_lane_configuration_required`. Unselected ordinary
methods return `{ supported: false, refusalCode: "host_binding_required" }`.
Unselected payment-method and commerce methods retain their corresponding
capability refusal. Selected ports keep their own results and errors.

For the native legacy subscription port, provide `explicitPause`, `control` and
`ownershipRefusal`. Pause uses `explicitPause`; bundle updates check ownership
before applying. `subscriptionControl.getSnapshot` delegates to the control
snapshot and retains its nullability. `createNativeSubscriptionDriver` removes
`acceptedQuoteHash` only from preview input, retaining the apply payload and key.
`createPaymentMethodComposition` adapts a `MethodSetupPort` to the facade's
payment-method method; method collection does not itself redeem or charge.

For profile edits and invoice-correction requests, compose
`createCustomerAccountMutationSchemas`,
`createPostgresCustomerAccountMutationPort` and
`createCustomerAccountMutationHandlers`. Supply policy, verified scope, clock,
authentication, messages and a responder. Keep each query's commit boundary:
profile update and event append are separate commits.

For saved billing profiles, select `createPostgresCustomerBillingProfilePort`,
`createCustomerBillingProfileSchemas` and `createCustomerBillingProfilesHandler`.
Supply the principal/client pair, clock, tax policy, authentication and messages.
Default clearing, profile writing and event append can fail separately. Reusing
the request identifier executes again. Mount the handlers yourself; saving a
profile does not select it for checkout.

## Select operator recovery

Before constructing `createOperatorRecovery`, verify an active human
administrator and provision their operator seat. Choose a managed authority
with lazy identity-move and account-link ports, or a native authority. Supply an
`OperatorRecoveryCommandEnvelope` containing trusted actor and graph, confirmed
subject, original command key, expected version, reason and owner evidence.

The dispatcher rejects machine or non-admin actors with
`customer_support_command_requires_human`, graph/operator mismatches with
`customer_support_operator_scope_mismatch`, mismatched keys with
`customer_support_idempotency_conflict`, and inconsistent subject or version
envelopes with `customer_support_operator_command_invalid`. These checks do not
replace host membership verification.

`createManagedOperatorAuthority` needs an `OperatorRpcExecutor`, operator ID,
clock and recovery-path policy, with an optional opaque-token source. Its email
correction flow admits, claims and settles the change. The identity writer must
enforce the issued claim. Surface `customer_support_email_correction_in_progress`,
`customer_support_email_correction_failed` and
`customer_support_email_correction_repair_required` without inventing completion.

`createPostgresOperatorAuthority` needs a transaction executor and the same
authority options. Native email, phone and account linking return
`operator_subscription_authority_unavailable` before SQL. Inspect
`operatorAuthorityCapabilities` for action-specific limits: ordinary pause,
paid-up resume and cycle slide do not admit the short slide band, unpaid/expired
resume or prepared-attempt pause subcases.

A native `change_shipping_address` command with `newAddress` selects the
destination routine. It checks the key and expected version and records the
destination change with its audit effects. If dispatch already owns the current
parcel, `applied_from_next_parcel` includes `appliesFrom: "next_parcel"`,
`futureDestinationId` and `replayed`. Show that scope to the customer: the current
parcel retains its frozen destination. This command is not an address book.

For `linkThenApply`, provide distinct keys and separately committed link and
subscription operations. It completes the link, invokes `onLinked` without
awaiting its return, then applies the subscription command. A subscription
failure, refusal or next-parcel outcome returns `partial` with the completed
link; it does not roll back the link.

## Compose guarded entry points

`createAccountSupportBindings` captures your prebound operation map and graph.
An absent injected commerce operation returns `unsupported/host_binding_required`.
It does not construct another commerce executor. Pass selected operations to
`createAccountSupportServices` with explicit enablement and a readiness observer.
Disabled calls return `disabled` without observing readiness; selected calls
retain `schema_unknown` or `schema_unsatisfied` refusals before invoking owners.
Aliases of one callable share a guard; null operations stay null.

Pass guarded operations, version/schema metadata, explicit dependencies and any
route descriptors to `createAccountSupportContribution`. Null members remain
required ports without bindings; duplicate route IDs throw
`account_support_duplicate_route`. Construction mounts no route or schedule.
Your host maps refusals and admits routes before serving them. Install the
[complete selected catalogue](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/docs/platform/DATA_AND_MIGRATIONS.md#compatibility-lifecycle)
before selecting native operations; module SQL lists alone are not an installer.
