# Add catalog drafts to your own application
Moved to [Add OpenLup to an existing application](../../packages/core/docs/guide/how-to/build/own-stack.md#add-openlup-to-an-existing-application).

Moved to the [OpenLup guide](../../packages/core/docs/guide/how-to/build/own-stack.md). This README keeps only what you need to work on the sample inside this repository.

Status: development-preview sample for `@openlup/core` and
`@openlup/platform` 0.36.0, with Node 24 and PostgreSQL 16.

This small Node application owns its HTTP routing and bearer-token authentication.
It composes `createCatalogDraftHandler`, `createCatalogProductTypeRegistry` and
`createPostgresCatalogDraftStore` from `@openlup/platform/catalog`, and
`createPostgresDataGateway` from `@openlup/platform/data`. These are public exports;
the app needs no starter, workspace aliases or private helper.

## Run outside the platform checkout

Moved to [Add OpenLup to an existing application](../../packages/core/docs/guide/how-to/build/own-stack.md#prepare-an-independent-application).

Prerequisites: a **disposable** PostgreSQL 16 database with the complete
`qualified-v2` portable catalogue installed, and its restricted runtime login.
That login must be able to assume the existing `service_role`; do not use the
migration or bootstrap login. Follow the
[installation and connection roles](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#connection-roles)
and [runtime connection recipe](https://github.com/openlup/openlup/blob/main/docs/platform/RUNTIME_AND_SELF_HOSTING.md#postgresql-connection-recipe).
Schema installation is a separate prerequisite, not a route in this application.
Sparse module SQL assets are not a complete installation chain.

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

Create `app.local.json` in the separate application directory with owner-only
read/write permissions. This filename is gitignored. Replace these placeholders
with the disposable database's restricted runtime connection string and a locally
generated token of 32 random bytes encoded as 64 lowercase hexadecimal characters:

```json
{
  "databaseUrl": "<restricted runtime connection string>",
  "operatorToken": "<64 lowercase hexadecimal characters>",
  "port": 3000
}
```

`port` is optional and defaults to 3000. Keep this external configuration file
out of Git and logs; runtime credentials and the token are not command-line
arguments. Feed the configuration file to the loopback runner on standard input:

```sh
node run.mjs < app.local.json
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

Moved to [Add OpenLup to an existing application](../../packages/core/docs/guide/how-to/build/own-stack.md#verify-durable-replay).

With `databaseUrl` in that same `app.local.json`, run `node --test verify.test.mjs`
from the separate application directory. The witness reads this fixed relative
path and generates its own short-lived local token, independently of `operatorToken`, and
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

Evidence (historical record, 2026-11-13):
With `databaseUrl` in that same `app.local.json`, run `node --test verify.test.mjs`
from the separate application directory. The witness reads this fixed relative
path and generates its own short-lived local token, independently of `operatorToken`, and
fresh UUIDs, exercises the actual HTTP route and inspects PostgreSQL rows through
the restricted service lane. It proves success, conflict refusal, replay after
recreating the application, and exactly one retained revision/receipt. It also
checks invalid credentials and rejects a request-supplied actor ID. Failure or
missing PostgreSQL is a test failure, never a skip. Each run retains its fresh
draft as evidence; discard the disposable installation when finished.
