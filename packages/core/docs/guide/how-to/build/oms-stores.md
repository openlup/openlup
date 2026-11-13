# Compose order management stores

Compose order management (OMS) commands, operator reads and customer-support
journeys over your installation's PostgreSQL runtime connection. Authenticate
the principal and authorize each action in your application; constructing a
store does not grant authority.

## Choose the imports

Use `@openlup/platform/commerce` for browser-safe OMS schemas and pure list/read
builders, and type imports from `@openlup/platform/commerce/contracts` for DTOs
and ports. Node handlers, managed query hydration and
`buildOmsOrderDetailResponse` belong to `@openlup/platform/commerce/server`.

Select native OMS factories from `@openlup/platform/commerce/server/postgres`
using its [API report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/commerce-server-postgres.api.md). Select customer-support
journey persistence from `@openlup/platform/account-support/postgres` using its
[API report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/account-support-postgres.api.md).

The commerce factories take a host-owned `PgQueryExecutor`, whose type comes
from `@openlup/platform/data`. Supply the selected installation's restricted
runtime session over its installed schema. Connection-owning support stores
also need the optional `pg` peer.

## Separate commands from reads

Pass the executor to `createPostgresCommerceOmsPort` for hold creation/release,
mark-refunded and unpaid-order cancellation. The port passes original
idempotency keys and actor identifiers to SQL. Derive the actor from your
admitted operator context, never request input.

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
`projections`. Preserve one executor per logical order operation. Bind identity
extensions, provider evidence and presentation in your host projections. Read
operations without `queries` throw `CommerceOmsPersistenceError`. Supply
`respond` and `authorizeAdmin` to the admin handlers, and preserve final
response validation when extending schemas. Supply settlement policy in your
host. The mark-refunded handler also requires `mutationsEnabled`; false returns
`FORBIDDEN` before mutation.

Replacement creation belongs to fulfillment. Its
`createAdminCommerceOrderRequestReplacementShipmentHandler` is exported from
`@openlup/platform/fulfillment` and takes a replacement port, responder and admin
authorizer. Creation does not establish arrival. Confirm subscription delivery
alignment only after the replacement reaches the customer; that confirmation
records delivery and can move the next cycle later.

## Record return intent

Pass the executor to `createPostgresCommerceReturnsPort<Reason>` and call
`createRequest`, `approve` or `reject` with stable idempotency keys. The generic
reason type can narrow your application's vocabulary; SQL still decides which
reasons are valid. These calls record lifecycle intent. They do not receive
stock, restock it or execute refunds.

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

See the [account and support reference](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/README.md#account-and-support-contracts)
for the surrounding capability boundary.
