# Compose account and support services

Build customer account reads, self-service commands and operator recovery around
your application's verified identity and selected owner ports. Keep customer
routes and operator routes separately authorized.

## Choose the imports

Use `@openlup/platform/account-support` for runtime composition and
`@openlup/platform/account-support/contracts` for browser-shareable types.
See the [runtime API report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/account-support.api.md) and
[contracts API report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/account-support-contracts.api.md)
for their inventories. Contribution descriptors come from
`@openlup/platform/composition`. Owner DTOs retain generic frozen money and
private extensions.

For capability maturity, consult the
[package reference](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/AGENTS.md#subpath-maturity).

## Bind reads to the customer

Pass separate `account` and `orders` ports to `createAccountReadFacade`. Its
`getAccount`, `listOrders` and `getOrderDetail` methods delegate directly to
those ports. The facade adds no query, diagnostic policy, authorization,
pagination defaults, retries or error mapping. Preserve the owner's nulls and
failures when mapping results to HTTP.

To assemble an account snapshot, supply `AccountReadSources`,
`AccountReadProjectionPolicy` and an already authorized client row to
`readAccountSnapshot`. Independent sections load in parallel; subscription rows
are bounded before visibility filtering, and the order store is asked for a
bounded number of recent orders. Subscription assembly and action-evidence reads run
alongside each other. Recurring money comes from captured line subtotals. Empty,
unpriced or mixed-currency lines leave the recurring amount unknown. Your
`withNextCharge` policy selects the payable-cycle and shipping facts; your
extension and presentation ports supply private fields and copy.

For native persistence, select `createPostgresCustomerOrderHistoryReadStore`
with a verified principal/client scope and `readInvoiceSummaries`, then
`createPostgresAccountReadSources` with that store, an order projection, a clock
and `additional` sources. Supply `readExtension` and `readNextCharges`; select
address, billing-profile, payment-preference, delivery-preference and event
sources explicitly. An absent optional section throws `host_binding_required`
with its `section`, rather than returning an empty success. The companion
`readPaidActivationGaps` reads owned paid orders whose subscription activation
is still missing. A saved newsletter flag is not effective consent; complete
grants and choices are outside these account reads. Use
`readPostgresCustomerAccountClient` for owned identity lookup,
`createPostgresCustomerSubscriptionSnapshotPort` for actor-bound subscription
snapshots and `createPostgresCustomerNewsletterPreferencesPort` for newsletter
read/withdrawal.

Use `readCustomerOrderSummaries` with the desired limit and projection. It asks
the store to hide `cancelled` and `expired` orders. `readCustomerOrderDetail`
resolves the owned order before loading its lines and companions. Money uses
stored headers and lines, including effective delivery discount and currency;
fulfillment interpretation and source attribution come from your projection.
Native detail refuses unavailable captured money with
`native_account_order_money_unavailable`.

Every native query rechecks the principal/client pair, including companion reads.
Use a server-authorized executor on the restricted runtime lane; these factories
create no connection. Native tracking URLs come from recorded observations;
a tracking identifier alone supplies no URL. `readPaidActivationGaps` returns
`orderId` and `paidAt` keyed by order, without inventing a provisional
subscription. Terminalized settlement intents appear as cancelled in order
history. The subscription source maps stored `composition_constraint` to
`sizeConstraint`; your editor interprets that constraint, while line amounts
remain frozen subscription prices. An aggregate snapshot needs every selected
section even when independent profile, order and subscription reads succeed.

Bind actor snapshot/newsletter readers through an already verified actor
gateway. They preserve database errors and null ownership results. If the
newsletter reader sees a saved grant without evaluator evidence, it throws
`host_binding_required` for `newsletterConsent`. It exposes withdrawal, without
a grant command or a complete purpose-choice interface.

## Authorize support and invoice reads

Compose `createCustomer360ReadFacade` with `authorize`, `journey`, `summary`
and `diagnostics`. Authorization runs before every source read. A false result
returns `{ kind: "denied" }` without reading the source; admitted calls preserve
arguments, nulls and thrown failures. This facade supplies no command authority.

Use `projectCustomer360Snapshot` with supplied journey, recovery, order and
contact evidence plus lifecycle and timeline policies. Recovery eligibility
requires a pending order for the same client; token availability also depends on
unexpired, unused, unrevoked evidence. Audit history is bounded and presented
chronologically, retaining a bounded set of the newest events. Unselected enrichment is
omitted; failed or partial profile enrichment produces warnings. Contact health,
account linkage and sign-in evidence remain separate facts. Subscription
`paymentMethodKind` is omitted when its source was unselected and null when the
selected source has no value.

Pass `accountHistory` and `artifacts` ports to `createInvoiceAccess`. Before
resolving a download, it reads the history and checks the account, order and
document identifiers. A foreign or unknown document returns `{ kind: "denied" }`
before ticket resolution or artifact access. Preserve the invoice owner's
order-reference format. This composition supplies neither an archive nor
storage; `downloadOwnedInvoicePdf` delegates PDF validation to the invoice
reader.

Standard UUID account/order/document identifiers compare without letter-case
differences; opaque host references remain case-sensitive. Preserve the original
echoed values rather than normalizing every reference indiscriminately.

## Select self-service commands

Call `createSelfServiceCommandFacade` with trusted `context`, matching
`capabilities` and only the command ports you select: managed or native
subscription commands, `profile`, `paymentMethod`, `commerce` and `recovery`.
Every returned command lane is callable. Each method checks the principal before
delegation or an unavailable result. Raw and typed native commands must also
carry the context's `clientId`; omitted, undefined, null or foreign values
refuse before the owner runs. Identity mismatches throw
`customer_principal_mismatch`; inconsistent graph selection throws
`customer_graph_mismatch`.

Incomplete selected ports, or capabilities that require an absent command port,
throw `customer_self_service_lane_configuration_required`. Unselected ordinary
methods return `{ supported: false, refusalCode: "host_binding_required" }`.
Unselected payment-method and commerce methods retain their corresponding
capability refusal, using `paymentMethodSetup` and `commerceRecovery`
respectively by identity. `configuredPurchase` also requires a commerce port;
generic bundle commands and command-bound receipts require a selected
subscription command port. Selected ports keep their results, nulls and errors.

For the native legacy subscription port, provide `explicitPause`, `control` and
`ownershipRefusal`. Pause uses `explicitPause`; bundle updates check ownership
before quote validation and applying, canonicalizing the subscription ID to
lowercase first. Missing ownership throws your supplied refusal. Other actions
retain the control port's own refusal; preview uses its preview method.
`subscriptionControl.getSnapshot` delegates to the control snapshot and retains
its nullability. `createNativeSubscriptionDriver` removes `acceptedQuoteHash`
only from preview input, retaining the apply payload and key.
`createPaymentMethodComposition` adapts a `MethodSetupPort` to the facade's
payment-method method; method collection does not itself redeem or charge.

Pass an already resolved `LegacySubscriptionRequest` to
`encodeNativeSubscriptionCommand(context, request, now)`.
`decodeNativeSubscriptionPreview` validates native quote fields before invoking
`previewProjection`; non-preview records retain the owner's result by identity.
The codec invents no currency, cutoff, address or payment-method facts. The
facade's trailing `ControlSnapshot = unknown` generic preserves your snapshot
type and its nullability through the input and returned methods.

Command envelopes carry explicit charge-timing confirmation for order-now and
reactivation, structured pause/cancel surveys and save-offer facts, and an
optional slide reason. Historical survey/offer strings remain valid carriers;
these declarations do not select a retention offer or install a browser binding.

For profile edits and invoice-correction requests, compose
`createCustomerAccountMutationSchemas`,
`createPostgresCustomerAccountMutationPort` and
`createCustomerAccountMutationHandlers`. Supply policy, verified scope, clock,
authentication, messages and a responder. Keep each query's commit boundary:
profile update and event append are separate commits. These profile/correction
handlers supply no saved address book, billing-profile management or editor UI;
compose those separately.

For saved billing profiles, select `createPostgresCustomerBillingProfilePort`,
`createCustomerBillingProfileSchemas` and `createCustomerBillingProfilesHandler`.
Supply the principal/client pair, clock, tax policy, authentication and messages.
Default clearing, profile writing and event append can fail separately. Reusing
the request identifier executes again. Mount the handlers yourself; saving a
profile does not select it for checkout.

## Preserve profile and event semantics

Select the mutation port as the self-service facade's `profile` lane. It also
supplies `requestInvoiceCorrection` and metadata-only `readEvents` for the
latest 20 events. Profile names collapse whitespace; empty or null clears a
field, and omission preserves it. Email is not an editable field. Your phone
policy supplies a calling prefix with nine local digits.

The schema policy may narrow, but cannot widen, these limits: command keys
8–180 characters, nonempty names 2–80, correction reasons 8–500, at most 20
requested fields of 1–80 characters, and nonempty notes up to 500 characters.
Invalid policy construction throws `customer_account_policy_invalid`.

A recorded profile-event key returns the current profile without another write.
If the event append fails after the profile write, the write remains committed;
a retry without that event can mutate again. Keep those separate query commits
and do not claim concurrent exactly-once mutation. Correction requests verify
document ownership through the order, then append an acknowledgement. Repeating
their key creates another event. This path has no issued/current-status gate,
fiscal correction executor, operator consumer, notification or refund.

Event payloads contain personal data. Register
`createAccountEventPrivacyContributor` and require `account-support` in identity's
privacy registry. Supply a privileged payload reader and an explicit retain or
unresolved policy. Unavailable export remains visible; missing reader or policy
does not permit erasure. With both configured, a retain assessment leaves
payloads in place even when that reader reports export unavailable. Identity
field clearing does not erase these events. No retention duration or deletion
worker is installed. Runtime event routines are service-only; the table's
client-column census grant is not payload-read authority.

## Manage billing profiles

The billing-profile handler supports GET/POST/PATCH/DELETE with authenticated
identity, strict requests/responses and your responder/messages. Consumer
signatures require no driver types. Tax policy cannot widen the fixed limits
or bypass the ten-digit weighted checksum. Customer-supplied verification level,
source and evidence are stored facts, not a registry verification workflow.

Updating a missing or foreign profile refuses with
`customer_billing_profile_not_found`. Deleting such an ID acknowledges zero
rows and still records the event. A failed default write may leave defaults
cleared; an append failure may leave the profile saved. Reusing an event key
executes again. Keep this behavior distinct from profile-edit replay.

Register `createCustomerBillingPrivacyContributor` from
`@openlup/platform/identity` and require `customer-billing`, alongside identity,
subscription vetoes and the separate account-event contributor. It exports
exact profiles and frozen invoice-buyer components, erases editable profiles
and retains frozen buyers under the invoicing owner's document-retention rule.
No default duration is supplied. Clearing client fields does not cover these
rows. Closed routines receive service-only execution; browser roles have no
direct profile access.

Profile rows block lead absorption. The service role's client-ID census access
does not permit arbitrary profile payload reads; use the closed owned routines.

Finite native capture/qualified restore carries exact profiles, buyer components
and account-event history; buyer components follow invoice duties. Replay does
not rewrite them. Legacy installations serve as capture sources; the smaller
compatible-row copier is separate. A managed source with nonempty profiles and
no typed transfer path refuses. Transfer grants no credentials or target
activation. Follow [buyer capture](invoicing.md#freeze-the-invoice-buyer) before
installing fiscal facts: later profile edits cannot rewrite a captured buyer.

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
enforce the issued claim. Surface
`customer_support_email_correction_in_progress`,
`customer_support_email_correction_failed` and
`customer_support_email_correction_repair_required` without inventing
completion. Original attribution remains durable when another authorized human
resumes the command. Phone, recovery, absorption and subscription results remain
their owners' objects.

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
link, retaining the subscription result for a next-parcel outcome. It does not
roll back the link or claim that the current parcel changed. The helper neither
creates nor verifies your keys or transaction boundaries.

## Compose guarded entry points

`createAccountSupportBindings` captures your prebound operation map and graph.
The separate `commerce(key, ...args)` accepts a nullable injected operation map.
An absent map or member returns `unsupported/host_binding_required`; selected
results retain identity and the concrete request/result type relation, including
owner refusals and unknown availability. It does
not construct another commerce executor. Pass selected operations to
`createAccountSupportServices` with explicit enablement and a readiness
observer. Disabled calls return `disabled` without observing readiness; selected
calls retain `schema_unknown` or `schema_unsatisfied` refusals before invoking
owners. Aliases of one callable share a guard; null operations stay null. Guards
retain known request/result types and add the binding refusal to the result
union without replacing owner refusals or thrown errors.

Pass guarded operations, version/schema metadata, explicit dependencies and any
route descriptors to `createAccountSupportContribution`. Null members remain
required ports without bindings; duplicate route IDs throw
`account_support_duplicate_route`. The descriptor has empty triggers, handlers,
emissions and schedules. Construction mounts no route or schedule. Your host
maps refusals and admits routes before serving them. Install the [complete
selected
catalogue](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/docs/platform/DATA_AND_MIGRATIONS.md#compatibility-lifecycle)
before selecting native operations; module SQL lists alone are not an installer.
