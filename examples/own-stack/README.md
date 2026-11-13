# Add catalog drafts to your own application

This README retains the sample's implementation constraints and verification record.

Status: development-preview sample for `@openlup/core` and
`@openlup/platform` 0.36.0, with Node 24 and PostgreSQL 16.

This small Node application owns its HTTP routing and bearer-token authentication.
It composes `createCatalogDraftHandler`, `createCatalogProductTypeRegistry` and
`createPostgresCatalogDraftStore` from `@openlup/platform/catalog`, and
`createPostgresDataGateway` from `@openlup/platform/data`. These are public exports;
the app needs no starter, workspace aliases or private helper.

## Run outside the platform checkout

`package.template.json` owns the sample's independent registry pins. Its SQL
prerequisite is PostgreSQL 16 with the complete `qualified-v2` catalogue and a
runtime login able to assume `service_role`.

`run.mjs` reads `databaseUrl`, `operatorToken` and optional `port` from stdin.
The token is 32 random bytes encoded as 64 lowercase hexadecimal characters;
port defaults to 3000. `app.mjs` limits request bodies to 64 KiB and binds only
`POST /drafts`. Its local session maps to `app:catalog-editor`; body and header
actor claims are not used as identity.

## Verify the boundary

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
