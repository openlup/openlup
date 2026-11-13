# Compose native bundle writes

Add bundle administration to your application's authorized operator surface.
Bind the native PostgreSQL write store behind your existing mutation and
activation gates.

## Choose the imports

Use `@openlup/platform/catalog` for bundle-write composition and
`@openlup/platform/catalog/contracts` for browser request contracts. Consult
the [API report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/catalog.api.md) and [contracts report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/catalog-contracts.api.md)
for their inventories.

## Describe the composition

Core's `Bundle` contract groups `coreLines` and `addonLines` with a
`CompositionConstraint`. Each `BundleLineRef` identifies a variant, quantity and
whether it is an extra. Your `CompositionRulesPort` validates and resizes the
composition using your own constraint data. These commerce contracts are
separate from runtime bundle selection and readiness descriptors.

## Provide the database and authorization

Install the [complete selected catalogue](../../upgrade/database-migrations.md#check-application-compatibility)
before binding the store. The bundle SQL list is not a complete installation
chain. Supply the native constructor's data connection and optional pool
configuration. Each operation uses a pooled transaction without changing the
connection role, so the login needs the routines' invoker privileges. Call
`close()` when the store's connection lifetime ends.

Alternatively, `createBundleAdminWriteStore` takes a `BundleWriteRoutineClient`
with `rpc` and the bounded `from(...).select(...).eq(...)` read used for the
stored composition constraint. Both factories share request marshalling and
`BundleRpcError` translation.

Authorize the human operator before calling the port. An `actorId` attributes
the write; it does not prove authorization. The native routines do not provide
an independent human-only activation gate. Keep that gate in your host handler,
alongside mutation and activation enablement. Importing the store creates no
route, credential, schema or grant.

## Bind the write operations

The port supplies `upsertDraft`, `updateDraft`, `cloneDraft`, `setComposition`,
`setTargetPrice`, `archive`, `restore`, `activate` and `deactivate`.
`loadCompositionConstraint` reads the stored rule envelope before a composition
change. Supply your `CompositionRulesPort` from `@openlup/core/bundle` when your
handler interprets application-owned composition constraints.

Use the request's `mode` to select `dry_run` or `commit`, and retain its
`idempotencyKey` for retries. Inspect `dryRun` and `idempotent` in the result.
The routines recognize previously recorded keys sequentially; this store adds
no concurrent-command guarantee. Do not treat that recognition as a full
command-fingerprint check.

## Preserve refusals

Catch `BundleRpcError` through its exported constructor or its `DomainRpcError`
base, then map its SQLSTATE and message in your transport. The shared handler
mapping distinguishes forbidden access, rule conflicts and missing records.
Keep the named routine refusal in the response details.

For example, activation refuses a missing bundle with `bundle_not_found`,
an unsupported fulfillment mode with `fulfillment_mode_unsupported`, an empty
composition with `composition_required_to_sell`, and a missing active price with
`price_required_to_sell`. Fix the named prerequisite before submitting another
command. Transport responses and route mounting remain application-owned.
