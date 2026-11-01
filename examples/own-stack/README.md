# Add catalog drafts to your own application

Status: development-preview sample for `@openlup/core` and
`@openlup/platform` 0.36.0, with Node 24 and PostgreSQL 16.

This small Node application owns its HTTP routing and bearer-token authentication.
It composes `createCatalogDraftHandler`, `createCatalogProductTypeRegistry` and
`createPostgresCatalogDraftStore` from `@openlup/platform/catalog`, and
`createPostgresDataGateway` from `@openlup/platform/data`. These are public exports;
the app needs no starter, workspace aliases or private helper.

Catalog drafts show a real durable write, conflict and receipt replay with little
setup. Drafts remain commercially inactive; this example does not publish items,
change prices, execute payment or change a subscription. The application-owned
`example:item` type accepts a title and allows incomplete drafts.

## Run outside the platform checkout

Prerequisites: a **disposable** PostgreSQL 16 database with the complete
`qualified-v2` portable catalogue installed, and its restricted runtime login.
That login must be able to assume the existing `service_role`; do not use the
migration or bootstrap login. Follow the
[installation and connection roles](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#connection-roles)
and [runtime connection recipe](https://github.com/openlup/openlup/blob/main/docs/platform/RUNTIME_AND_SELF_HOSTING.md#postgresql-connection-recipe).
Schema installation is a separate prerequisite, not a route in this application.
Sparse module SQL assets are not a complete installation chain.

Copy this directory into a new directory outside **every** OpenLup checkout,
then run there. For example, replace both absolute paths before executing:

```sh
cp -R /absolute/platform-checkout/examples/own-stack /absolute/separate-app
cd /absolute/separate-app
cp package.template.json package.json
npm install --ignore-scripts --omit=optional
```

The private manifest template pins released registry versions. Keep the generated lockfile
in your own application. Do not replace dependencies with workspace links,
source directories or private `dist` imports. This directory is not a platform
workspace or published package.

Set `DATABASE_URL` externally to that disposable database's runtime connection
string. Keep it out of Git and logs. Generate the application's local operator
token and start its loopback listener:

```sh
export OPERATOR_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
node run.mjs
```

The sole command route is `POST /drafts` with `Content-Type: application/json`
and `Authorization: Bearer <your token>`. It accepts the public catalog draft
command, for example:

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

A new command returns HTTP 201 / `committed`. Repeating it returns HTTP 200 /
`replayed`, preserving the original record. Changing the payload under the same
key returns HTTP 409 / `draft_command_key_reused`. Missing or invalid credentials
return HTTP 401 before database access. Request bodies are limited to 64 KiB.

## Verify the boundary

With the same disposable runtime `DATABASE_URL`, run `node --test verify.test.mjs` from the separate
application directory. The witness generates its own short-lived local token and
fresh UUIDs, exercises the actual HTTP route and inspects PostgreSQL rows through
the restricted service lane. It proves success, conflict refusal, replay after
recreating the application, and exactly one retained revision/receipt. It also
checks invalid credentials and rejects a request-supplied actor ID. Failure or
missing PostgreSQL is a test failure, never a skip. Each run retains its fresh
draft as evidence; discard the disposable installation when finished.

The pre-provisioned local session maps only to `app:catalog-editor`. Neither a
request body, a header claiming an actor ID, nor an email decides identity.
OpenLup receives only the application-verified operator ID. Replace the token
verifier with your application's existing verified sessions/issuer integration
before exposing a service; this sample supplies no login, token issuance,
revocation, operator directory or hosted-authentication qualification. Keep the
database login server-side. The service role is a database capability, not proof
that the HTTP caller is an operator.

The [catalog owner](https://github.com/openlup/openlup/blob/main/src/domains/catalog/README.md) describes draft contracts
and limits. The [architecture guide](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#own-stack-integration-sample)
links this sample from the platform/adopter boundary. For production and release
claims, the platform's development-preview limits still apply.
