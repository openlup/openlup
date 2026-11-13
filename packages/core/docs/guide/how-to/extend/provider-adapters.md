# Compose a provider adapter

Connect an external service by implementing its neutral OpenLup port and
selecting the implementation in your application's server composition.

## Provider adapters

An adapter translates service requests, verification evidence and failures into
the port's contract. Domain policy uses declared capabilities; it must not infer
behaviour from a provider name. Preserve the contract's identity, money, scope
and replay fields when translating requests and results.

Declare only capabilities the adapter can perform. An unavailable operation
must return the port's explicit refusal before effects, rather than report
success. Marketing-sync operations use `kind: "refused"` with reason
`unsupported` or `verification_pending` for the corresponding capability state.
Payment readback uses `kind: "unsupported"` when unavailable. Fulfillment ports
use their operation-specific result with refusal reason `unsupported`.

Construct and inject the adapter explicitly. Importing a contract or an opt-in
adapter does not install application routes, schedules or workers. Supply
credentials from the host when needed; keep secrets out of source, fixtures,
persisted diagnostics and logs.

## Adapter classes and templates

Choose the class matching the service's responsibility. Use these neutral
contracts as the template for your implementation:

| Class | Contract and construction | Offline check |
| --- | --- | --- |
| Email | Bind a guarded email transport; see the [communications API report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/communications.api.md). | Check transport acceptance and refusal behavior with communications conformance. |
| Marketing | Implement neutral profile, consent-readback and erasure ports from the [communications contracts report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/communications-contracts.api.md). Keep consent push separate. | Communications conformance covers marketing sync; consent push needs separate checks. |
| Payments | Implement the payment contract and declare capabilities from the [payments contracts report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/payments-contracts.api.md). | Use the conformance runner and fixtures in the [payments API report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/payments.api.md). |
| Fulfillment | Implement the operations you declare in the [fulfillment contracts report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/fulfillment-contracts.api.md). | Use the conformance runner with adapter-owned fixtures from the [fulfillment API report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/fulfillment.api.md). |
| Ecommerce events | Implement `EcommerceEventsPort` from the [communications contracts report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/communications-contracts.api.md), independently of profile and consent support. Declare the selected scope and qualification, keep the source, profile and mapping identity on retry, and recheck local authority before each effect. | Communications conformance covers email and marketing sync only; prove event acceptance, refusal without effects, replay and uncertain acceptance with your own offline sink. A passing offline check does not qualify a live account. |

Opt-in templates cover email, marketing, payments and fulfillment. Default
wiring selects none of them. Find their protocol-specific entries in the
[installed package export
map](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/package.json).
Keep their imports in your server composition. The neutral communications and
browser contracts entries do not export provider factories. Consult the [package
capability
reference](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/AGENTS.md#subpath-maturity)
for maturity.

### Node email protocol template

The Node-only email template composes the neutral runtime operations listed in
the [communications API report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/communications.api.md).
Select its protocol-specific entry through the installed export map above. Types
stay on the neutral entries.

Put the outbound request behind `createGuardedEmailTransport`. Supply a host
egress policy for every send: it selects the credential, effective recipient and
environment. A throwing policy returns `email_egress_policy_unavailable`, an
invalid decision returns `email_egress_policy_invalid`, and a blocked decision
returns `email_egress_blocked`, all before the sender runs. A `drop` decision
returns a suppressed result without sending. A raw transport passed to
`guardEmailTransport` returns `email_egress_unadmitted`.

Preserve optional message fields, the exact idempotency key and cancellation
signal, including an explicitly empty idempotency key. A successful 2xx response
can have no message ID; it means acceptance, not confirmed delivery. For
delivery observations, authenticate the original webhook bytes before JSON
parsing and exclude explicitly foreign environments before lookup or writes. Use
`processEmailObservation` with your lookup and atomic writer. Use
`runDeliveryReconciliation` to read existing message IDs and apply observations;
reconciliation must not send replacement messages. Your host supplies routing,
scheduling, storage and credential resolution.

Start host composition with `createInMemoryEmailTransport` and inspect its
captured envelopes before selecting a network transport. Supply the message
content, egress policy, credential selection, abort deadline and observation
store explicitly, bind the webhook to the untouched request bytes and the
selected environment, and schedule reconciliation only for existing message
identifiers. Your host owns retry policy: the template forwards an optional
`AbortSignal`, returns the HTTP status and bounded provider errors, never
retries a send and exposes no separate retry-after delay. A response without a
message ID is acceptance, not delivery; do not send a replacement automatically.
Provider idempotency keys expire after a provider-defined window, so keep your
local effect ledger independent of it and check the provider's idempotency
contract before choosing a retry horizon.

For this protocol template, signatures accept bare or `v1,` members and literal
keys or canonical base64 keys prefixed with `whsec_`. Supply a UTC-seconds
clock; the template enforces a bounded timestamp window, including its
endpoints. See the [maintainer protocol limits](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/docs/platform/CANONICAL_CONTRACTS.md#opt-in-node-protocol-adapter)
for the exact window. This policy is separate from the standard Auth verifier. The receiver defaults to
non-production. Lookup/apply failures return a fixed HTTP 500 response for
retry; attempt telemetry cannot overturn a successful observation. Unsupported
event types, missing message IDs and foreign-environment events return only an
HTTP disposition and do not converge state. Event metadata stays opaque. Webhook
and poll observations preserve raw `email.*` event types; the webhook inventory
only gates admission.

### Singleton marketing template

The Node factory implements profile, negative-consent, erasure and consent-push
ports alongside the marketing bridge and refusal-only newsletter port. Inject
fetch and clock for offline checks; construction installs no route or worker.

Use an account-scoped adapter when the external service shares profile and
consent state across audiences. For this singleton template, supply private
subject mappings, current authorization and local evidence, a credential
resolver and atomic account storage. Keep account operations at
`verification_pending` until account-specific
test readback establishes the required scopes, mappings and absence of unwanted
automation triggers.

The existing marketing bridge uses `MarketingAutomationProviderPort`. Its
`NewsletterSyncProviderPort` exposes no newsletter capabilities and returns
`status: "skipped"` with reason `unsupported` for sync and reconciliation.

Verify the private profile projection when writing; audience-scoped remote
consent remains unknown. Write only owned profile fields. Preserve the audience
on negative feedback; remote subscribed state never grants local permission.
Report incomplete readback as partial coverage. An audience-scoped erasure
request cannot become account-wide deletion, and acknowledgement cannot prove
completed erasure. If deletion readback is unavailable, refuse it with
`unsupported`.

This singleton template declares account-wide grant effects while local grants
remain audience-scoped. Check segments, backfills and double opt-in at effect
time; list-only withdrawal needs proof of safe scope. It supplies no import flag
or job-control API.

Declare whether a consent grant affects an audience or the whole account. For
account-wide effects, check every affected consent flow and prove that the
operation cannot clear suppression. Keep audience-only withdrawal separate from
explicit all-purpose withdrawal. Submit subjects separately and treat an
asynchronous job response as acceptance only.

Allow withdrawal despite an earlier unsettled grant, retaining
`reconcileRequired`. Restrict new grants until fresh, complete readback after
authenticated settlement resolves the race; if the subject is still subscribed,
issue a fresh withdrawal request ID. Do not automatically retry an uncertain
mutation. Share the atomic journal and mutable availability record across all
adapter instances for the account and environment. After restart, keep admission
quarantined until explicit host reconciliation and adapter reconstruction.

## Verify before connecting

Cover success, refusal, malformed or missing evidence, duplicates, out-of-order
observations and retry or replay with offline fixtures. A passing fixture check
does not prove account readiness, durable storage atomicity, a live integration,
a release or support tier, or authorization to perform live operations. Follow
[adapter conformance](adapter-conformance.md) to run the communications example
and check your implementation. Keep the adapter in your application's source or
propose it upstream through the [contribution
process](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/CONTRIBUTING.md#contribute-existing-adopter-code-then-refactor).
