# Compose order management stores

Compose order management (OMS) commands, operator reads and customer-support
journeys over your installation's PostgreSQL runtime connection. Authenticate
the principal and authorize each action in your application; constructing a
store does not grant authority.

Install the [complete selected catalogue](../../upgrade/database-migrations.md)
before binding native stores, including human operator admission, unpaid
cancellation and return decisions.

## Choose the imports

Use `@openlup/platform/commerce` for browser-safe OMS schemas and pure list/read
builders, and type imports from `@openlup/platform/commerce/contracts` for DTOs
and ports. Node handlers, managed query hydration and
`buildOmsOrderDetailResponse` belong to `@openlup/platform/commerce/server`.

Select native OMS factories from `@openlup/platform/commerce/server/postgres`
using its [API report](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/platform/api/commerce-server-postgres.api.md). Select customer-support
journey persistence from `@openlup/platform/account-support/postgres` using its
[API report](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/platform/api/account-support-postgres.api.md).

The commerce factories take a host-owned `PgQueryExecutor`, whose type comes
from `@openlup/platform/data`. Supply the selected installation's restricted
runtime session over its installed schema. Connection-owning support stores
also need the optional `pg` peer.

## Separate commands from reads

Pass the executor to `createPostgresCommerceOmsPort` for hold creation/release,
mark-refunded and unpaid-order cancellation. The port passes original
idempotency keys and actor identifiers to SQL. Derive the actor from your
admitted operator context, never request input.

Resolve the operator again before each human command and replay, enforcing
active human-admin membership in your host. Native resolution requires an
existing Commerce operator UUID and either an active control principal or an
active human-admin membership with no control row of any state. Distributors,
revoked members and admins without a Commerce row do not resolve. Resolution
provisions nothing. Retain the Commerce row when withdrawing human access;
revoke membership instead. Deleting that row nulls hold attribution through
the existing foreign key and can make a human exception hold eligible for
automatic release. The machine path keeps its own admission policy.

Use `createPostgresCommerceOmsControlPlane` for operator resolution and
`control_plane_v1` list/detail reads. These reduced projections include order,
shipment, hold and operation information; they do not supply rich customer or
payment history. Bind them as `port` to
`createCommerceOmsControlPlaneListHandler` and
`createCommerceOmsControlPlaneDetailHandler` from the commerce server entry,
with your responder and `authorizeAdmin` callback. Your router owns dispatch to
these handlers.

The command port's `listOrders`, `getOrderDetail`, `addNote` and
`updateShippingAddress` throw `CommerceOmsPersistenceError`. Replacement requests
also throw that error unless you inject the optional replacement port. There
is no separate refusal code on these unavailable operations. SQL conflicts
mapped by the command adapter throw `CommerceOmsConflictError`; other database
failures throw `CommerceOmsPersistenceError`.

For managed rich reads, `createManagedCommerceOmsPort` takes a structural
`CommerceOmsRpcClient` plus a separate `queries` capability and optional
`projections`. Preserve exclusive executor ownership for each logical order
operation. Bind identity
extensions, provider evidence and presentation in your host projections. Read
operations without `queries` throw `CommerceOmsPersistenceError`. Supply
`respond` and `authorizeAdmin` to the admin handlers, and preserve final
response validation when extending schemas. Supply settlement policy in your
host. The mark-refunded handler also requires `mutationsEnabled`; false returns
`FORBIDDEN` before mutation.

Native unpaid cancellation locks current payment state and refuses in-flight,
captured or indeterminate evidence before recording its audit and releasing
the order's held purchase reservations. Refusals include
`oms_cancel_unpaid_order_payment_in_flight` and
`oms_cancel_unpaid_order_payment_already_moved`. A late capture stays a review
case. Mark-refunded accepts paid orders and records an external refund status;
it calls no provider and emits no refund notification or accounting reversal.
Object metadata keeps its keys; non-object metadata is retained as
`previousMetadata`. Actual refund sources retain their event duties. Neither
command changes an active subscription's lifecycle or schedule.

Replacement creation belongs to fulfillment. Its
`createAdminCommerceOrderRequestReplacementShipmentHandler` is exported from
`@openlup/platform/fulfillment` and takes a replacement port, responder and admin
authorizer. Creation does not establish arrival. Confirm subscription delivery
alignment only after the replacement reaches the customer; that confirmation
records delivery and can move the next cycle later.

For richer order-detail projections, supply your health classifier and evidence
readers. Omission leaves an unassessed `ok` snapshot with no attention reasons
or evidence identifiers; it does not evaluate provider health.

## Record return intent

Pass the executor to `createPostgresCommerceReturnsPort<Reason>` and call
`createRequest`, `approve` or `reject` with stable idempotency keys. The generic
reason type can narrow your application's vocabulary; SQL still decides which
reasons are valid. These calls record lifecycle intent. They do not receive
stock, restock it or execute refunds.

Fresh requests accept paid or fulfilled orders owned by the authenticated
customer, with one line per order item and quantity no greater than ordered.
Choose a subset of stored reason codes; another code refuses with
`commerce_return_request_create_invalid_input`. Replays normalize key/note
whitespace, UUIDs, line order and defaults. New SKUs use trimmed supplied text,
then the recorded order-item SKU, then `unknown`; historical null means
unrecorded. Older receipts retain their own fingerprints. A unique matching
trimmed-key alias replays its stored ID; ambiguous matches refuse with
`commerce_return_request_create_order_not_found` without rewriting history.
Partial approval requires an amount. Approval and rejection each record one
intent event; creating a request emits none.

## Recover system exception holds

Create `createPostgresProviderExceptionHealPort(executor)` and select candidates
through `readHealableProviderExceptionHolds`. It selects delivered shipments
with earlier exception evidence, excluding human-created holds and cancelled
or refunded orders.

Call `releaseDelivered` only with a row returned by that selection. It reuses a
deterministic key for the hold; it does not validate arbitrary caller-supplied
delivery evidence and never confirms a subscription replacement.

## Bind customer support

Construct `createPostgresCustomerSupportJourneyPort` with
`{ connectionString, operatorId }`, where `operatorId` comes from your admitted
operator context. The port supplies portable customer and journey reads,
recovery issuance and lead absorption. It owns its connection lane: call
`close()` during host teardown. Use `createLane` in the options if you supply
a custom lane; the commerce executor remains separately host-owned.

Empty connection and operator inputs throw `customer_support_database_url_required`
and `customer_support_operator_required`. Subscription commands and contact
email/phone corrections throw `operator_subscription_authority_unavailable`.
Recovery and lead-absorption inputs must match the configured operator;
a mismatch throws `customer_support_operator_scope_mismatch`. Import the shared
support error constructors from `@openlup/platform/account-support`.

For browser reads, use `@openlup/platform/account-support/read-contracts` for
portable-client and Customer 360 schemas and inferred types. It uses CSP-safe
validation. `@openlup/platform/account-support/contracts` remains type-only.
If composing `createCustomer360ReadFacade` from
`@openlup/platform/account-support`, provide `authorize`, `journey`, `summary`
and a separate `diagnostics` port. You own its admission and governance;
the journey store supplies no diagnostic-history route.

Follow [account and support composition](account-and-support.md) for the
surrounding read, command and privacy boundaries.
