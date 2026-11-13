# Add catalog drafts to your own application
Moved to [Add OpenLup to an existing application](../../packages/core/docs/guide/how-to/build/own-stack.md#add-openlup-to-an-existing-application).

Moved to the [OpenLup guide](../../packages/core/docs/guide/how-to/build/own-stack.md). This README keeps only what you need to work on the sample inside this repository.

## Run outside the platform checkout
Moved to [Add OpenLup to an existing application](../../packages/core/docs/guide/how-to/build/own-stack.md#prepare-an-independent-application).

This directory is not a platform workspace or published package.
`package.template.json` is the sample's private manifest template;
`app.mjs` owns its route and authentication composition, and `run.mjs` owns its
loopback runner.

## Verify the boundary
Moved to [Add OpenLup to an existing application](../../packages/core/docs/guide/how-to/build/own-stack.md#verify-durable-replay).

The sample's own test is `verify.test.mjs` in this directory.

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
