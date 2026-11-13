# Add OpenLup to an existing application

Keep your application's HTTP routing and authentication while adding durable
catalog draft commands through public package exports. The own-stack example
shows this composition without a starter.

## Choose the imports and ports

Import `createCatalogDraftHandler`, `createCatalogProductTypeRegistry` and
`createPostgresCatalogDraftStore` from `@openlup/platform/catalog`.
Import `createPostgresDataGateway` from `@openlup/platform/data`.
Browser command types come from `@openlup/platform/catalog/contracts`.
Use the [package reference](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/AGENTS.md#subpath-maturity)
for capability maturity.

Your composition provides a database pool, a `CatalogDraftStorePort`, product
type definitions with `validateContent`, and `authorizeOperator`. The example
adapts store `apply`, `get` and `list` through `data.asService`, constructing the
PostgreSQL store inside each service transaction. Its application-owned
`example:item` type requires a nonblank title and permits incomplete drafts.
Draft authoring does not publish products, change prices, take payments or
change subscriptions.

Read [app.mjs](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/own-stack/app.mjs)
for the composition and
[run.mjs](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/own-stack/run.mjs)
for the loopback runner and shutdown behavior.

## Prepare an independent application

Use a disposable PostgreSQL 16 database with the complete `qualified-v2` portable
catalogue installed and a restricted runtime login that can assume
`service_role`. Do not use the bootstrap or migration login. Follow the
[connection roles](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/docs/platform/DATA_AND_MIGRATIONS.md#connection-roles)
and [runtime connection recipe](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/docs/platform/RUNTIME_AND_SELF_HOSTING.md#postgresql-connection-recipe).
Schema installation is a prerequisite; the example installs no schema. Sparse
module SQL assets do not form a complete installation chain.

From a checkout containing the example, copy it to a fresh directory outside
every OpenLup checkout and install its pinned registry dependencies:

```sh
app_dir=$(mktemp -d)
cp -R examples/own-stack/. "$app_dir/"
cd "$app_dir"
cp package.template.json package.json
npm install --ignore-scripts --omit=optional
```

Use the runtime requirements and matching package pins in
[package.template.json](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/own-stack/package.template.json).
The sample's pins are independent of the surrounding checkout. Keep the
generated lockfile in your application; use public imports rather than source
directory links or private build paths.

## Configure and run locally

Create the gitignored `app.local.json` in the copied application with owner-only
read/write permissions. Set `databaseUrl` to the restricted runtime connection
string. Generate a cryptographically random lowercase hexadecimal
`operatorToken` matching the configuration constraint in
[app.mjs](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/own-stack/app.mjs). Keep both values out of Git, logs and command-line arguments.

```json
{
  "databaseUrl": "<restricted runtime connection string>",
  "operatorToken": "<generated lowercase hexadecimal token>",
  "port": 3000
}
```

The `port` field is optional and defaults to 3000. Feed the configuration on
standard input:

```sh
chmod 600 app.local.json
node run.mjs < app.local.json
```

The runner listens on loopback. Its local bearer-token verifier maps the token
to `app:catalog-editor`; a caller-supplied actor or email does not decide identity.
Replace that verifier with your application's existing verified sessions before
exposing the service. The example supplies no login, token issuance, revocation
or operator directory. Keep the database login on the server. A database service
role is not HTTP authorization.

## Send a draft command

Send `POST /drafts` with `Content-Type: application/json` and an
`Authorization: Bearer <token>` header. For example, use this body through your
local client without putting credentials in shell history:

```json
{
  "schemaVersion": 1,
  "action": "create",
  "draftId": "00000000-0000-4000-8000-000000000001",
  "commandKey": "create-example-1",
  "expectedRevision": 0,
  "payload": {
    "schemaVersion": 1,
    "product": {
      "id": "00000000-0000-4000-8000-000000000002",
      "type": { "key": "example:item", "version": 1 },
      "dimensions": [],
      "sharedContent": { "title": "Sample item" }
    },
    "skus": []
  }
}
```

Creation returns `201/committed`; an exact retry returns `200/replayed` with the
original record. Changed input under the same key returns
`409/draft_command_key_reused`. Keep the key and payload unchanged for retry.
The handler checks stored command evidence before revalidating against the
current product registry.

Missing or invalid bearer credentials return `401/operator_required` before
database access. A request-supplied `actorId` fails the strict command schema
with `422/draft_input_invalid`. The HTTP adapter refuses unsupported content
types with `415/json_required`, bodies larger than 64 KiB with
`413/body_too_large` and malformed JSON with `400/invalid_json`. An unavailable dependency maps to a
service-unavailable response; do not interpret it as a successful write.

## Verify durable replay

From the copied application directory, run:

```sh
node --test verify.test.mjs
```

The verification reads `databaseUrl` from the local configuration and creates its
own temporary operator token, independently of your configured `operatorToken`,
and fresh identifiers. It checks HTTP admission, invalid credentials, refusal of
a caller-supplied actor ID, durable creation, changed-key-payload refusal and
exact replay after rebuilding the application instance. It inspects database rows
through the restricted service role and checks that one revision and one command
receipt remain after replay. Missing PostgreSQL fails verification. Each run
retains its generated draft; discard the disposable database when finished. Local
verification establishes neither hosted authentication nor production readiness.
