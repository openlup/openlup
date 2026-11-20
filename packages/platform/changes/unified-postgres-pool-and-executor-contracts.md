- Unify direct-PostgreSQL executor and pool-sharing contracts across `@openlup/platform`:
  - Re-export `SqlExecutor` and add `PostgresTransactionRunner` / `createPostgresTransactionRunner(pool)` in `@openlup/platform/data`.
  - Accept a non-owning borrowed `{ pool }` option across `PostgresDataGatewayOptions`, direct-PostgreSQL identity/communications/account-support/marketing stores, and `createPostgresMigrationRunner` (rejecting `{ pool, poolFactory }` fail-closed and never calling `pool.end()` on borrowed pools).
  - Parameterize `PostgresRoleFreeTransactionLane<G = unknown>` covariantly and add a typed overload on `createPostgresRoleFreeTransactionLane<G>(...)` (retaining `PostgresRoleFreeTransactionLane<unknown>` when unparameterized for 1.x compatibility, while accepting supertypes such as `PgGatewayClient`, `SqlExecutor`, or `PgQueryExecutor` for typed callbacks without unchecked casts) plus a runtime `isPgQueryExecutor` check in checkout recovery token storage.
  - Make `DataBindingDependencies.createSupabaseClient` optional so direct-PostgreSQL hosts can call `createDataBindings()` without a hosted-client stub while still failing closed (`OPENLUP_E_DATA_BINDING_SUPABASE_CLIENT_REQUIRED`) when the hosted capability is bound without a client factory.
  - Convert `@openlup/platform/marketing/server/postgres` from eager `pg` imports to lazy peer loading with `OPENLUP_E_PEER_MISSING` preservation.

Migration:

Code that reads `DataBindingDependencies.createSupabaseClient` must handle
`undefined`. Existing `PgGatewayClient.query` implementations keep their 1.2.0
signature. For typed rows or readonly query values, wrap the client with
`asPostgresSqlExecutor` from `@openlup/platform/data`.

Before (separate pools per store and stubbed hosted client factory):
```ts
const bindings = createDataBindings({ createSupabaseClient: stubClient });
const store = createPostgresAccountLinkStore({ connectionString });
```

After (single application-owned pool shared across direct-PostgreSQL stores):
```ts
const bindings = createDataBindings();
const runner = createPostgresTransactionRunner(sharedPool);
const store = createPostgresAccountLinkStore({ connectionString: "" }, { pool: sharedPool });
```
