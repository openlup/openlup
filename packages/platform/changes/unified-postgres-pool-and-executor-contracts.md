- Unify direct-PostgreSQL executor and pool-sharing contracts across `@openlup/platform`:
  - Re-export `SqlExecutor` and add `PostgresTransactionRunner` / `createPostgresTransactionRunner(pool)` in `@openlup/platform/data`.
  - Accept a non-owning borrowed `{ pool }` option across `PostgresDataGatewayOptions`, direct-PostgreSQL identity/communications/account-support/marketing stores, and `createPostgresMigrationRunner` (rejecting `{ pool, poolFactory }` fail-closed and never calling `pool.end()` on borrowed pools).
  - Parameterize `PostgresRoleFreeTransactionLane<G = unknown>` covariantly so `createPostgresRoleFreeTransactionLane` returns `PostgresRoleFreeTransactionLane<PgGatewayClient>`, eliminating unchecked executor casts and adding a runtime `isPgQueryExecutor` check in checkout recovery token storage.
  - Make `DataBindingDependencies.createSupabaseClient` optional so direct-PostgreSQL hosts can call `createDataBindings()` without a hosted-client stub while still failing closed (`OPENLUP_E_DATA_BINDING_SUPABASE_CLIENT_REQUIRED`) when the hosted capability is bound without a client factory.
  - Convert `@openlup/platform/marketing/server/postgres` from eager `pg` imports to lazy peer loading with `OPENLUP_E_PEER_MISSING` preservation.

Migration:

No action is required for existing 1.x callers: `PostgresRoleFreeTransactionLane<G = unknown>` defaults `G` to `unknown`, `PgGatewayClient.query` widens `values` to `readonly unknown[]`, and `DataBindingDependencies.createSupabaseClient` becomes optional while retaining identical runtime behavior whenever supplied.

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
