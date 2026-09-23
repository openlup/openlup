# Evaluate a subscription account

Status: development-preview implementation candidate. Publication and acceptance
evidence must name an immutable release; this document does not announce one.
Audience: an evaluator with an independent public checkout, testing local
subscription behaviour without an adopter repository or external providers.

## Scope and prerequisites

Use Node 24 and the npm version in `package.json`, Docker, and the Supabase CLI.
The selected profile uses the managed Supabase baseline shipped in this tree.
It does not mix that schema with the separate portable PostgreSQL migration lane.
The default public build remains the small static reference.

This profile sells one synthetic recurring item. Payment settlement is generated
by the trusted local adapter, matched to an issued attempt, then persisted through
the existing payment and subscription services. Browser input cannot select a
provider or mark a payment paid. Email confirmation uses the local captured mailbox.
No external payment, carrier or communication provider is configured.

The profile covers initial purchase, confirmed sign-in, own order/subscription,
and a local renewal-date summary and confirmation. A renewal date is the planned
renewal/charge date, never a promised delivery date. Automatic renewal, fulfillment,
failed-renewal recovery and delivery alignment are separate acceptance stages.

## Create an owned disposable installation

Run from this repository root. Choose an unused project name, absolute empty
directory and free port range. This command creates local containers and schema;
it refuses an unowned directory or conflicting project and never resets a shared DB.

```sh
npm ci
node scripts/public-reference/setup-subscription.mjs \
  --dir /tmp/openlup-reference-evaluation \
  --project-id openlup-reference-evaluation \
  --port-base 56820
OPENLUP_REFERENCE_PROFILE=subscription npm run build
node --env-file=/tmp/openlup-reference-evaluation/subscription.env \
  --conditions=core-source --import tsx server/runtime/public-reference/serve.ts
```

The generated mode-0600 environment contains only this disposable installation's
local credentials. Do not copy it into source, browser settings or reports. The
setup records and verifies its identity against the live database before reuse;
the runtime repeats that check before API operations. An old or mismatched setup
refuses instead of silently taking over another database.

For the example port range, visit `http://127.0.0.1:56830/subscribe`. Complete the
form with synthetic contact details. The server's captured outcome defaults to
success; it never charges money. Request the sign-in link after checkout, open
`http://127.0.0.1:56824`, and follow the captured email confirmation link. The
account displays the stored order and subscription. Select a different permitted
renewal date, inspect the summary, then confirm. The account refresh reads the
persisted result. If refresh fails after a write, refresh again before relying
on the displayed date.

Stop and restart only the Node process with the same command and environment;
keep the database volume. Sign in again if the session expired. The stored order,
subscription and changed date must remain. Re-running setup preserves the same
installation; it is not a reset command.

## Scoped operator read

First sign in with a separate synthetic operator email through the same public
account route and confirm its captured email. Then explicitly grant that already
confirmed identity a human operator membership in this local installation:

```sh
node --conditions=core-source --import tsx scripts/public-reference/grant-operator.mjs \
  --env-file /tmp/openlup-reference-evaluation/subscription.env \
  --email operator@example.test
```

The selected profile exposes only
`GET /api/bff/reference-journey/operator/subscription-readback?orderId=<UUID>`
with the operator's real Auth bearer token. It returns persisted order/payment
status and the linked subscription's status and next renewal date. It has no
listing or mutation endpoint. Ordinary customers, inactive memberships and machine
actors cannot use this route. The grant command is installation setup; the readback
itself must run through authenticated HTTP.

## Checks, limits and recovery

```sh
npm test
npx vitest run server/runtime/public-reference src/pages/account/v2/subscriptions/modals/RescheduleModal.test.tsx
npm --workspace @openlup/core run ci
npm run oss:published-tree -- --policy
npm run oss:published-tree -- --inventory
npm run oss:published-tree -- --typecheck
```

The public workflow owns the selected-profile build, composition tests and core
package CI. A separate real HTTP/browser journey proves auth, persistence and
restart; unit tests cannot replace it. Record the exact source revision and
installation identity, never bearer tokens or generated service credentials.

With the selected server running, the HTTP verifier creates a synthetic buyer,
confirms real captured email, checks checkout retry/concurrency and ownership
refusals, changes the renewal date, and reads it as a separately confirmed operator:

```sh
node scripts/public-reference/verify-subscription.mjs \
  --env-file /tmp/openlup-reference-evaluation/subscription.env
```

It prints the actual order, subscription and renewal date. After restarting only
Node, pass those exact outputs as `--resume-order`, `--resume-subscription` and
`--resume-date` with the same `--env-file` to check persistence. Each run signs in
two synthetic identities through the real local mailbox. The normal five requests
per IP per hour limit remains active; do not run repeated full trials against the
same installation or bypass the limiter. A browser trial needs its own remaining
sign-in request. No buyer, order, paid state or subscription is seeded by this check.

The server refuses non-loopback/hosted environments, an unconfirmed Auth setup,
external Auth providers, external SMTP, an ownership mismatch, unknown routes,
wrong methods and cross-origin mutations. An operator may choose the trusted
`refused` payment outcome in the generated environment before starting the server.
Changing that setting cannot rewrite a previously issued attempt; conflicting
replay refuses before another checkout write. A new buyer intent needs a new
idempotency key. The browser retains a key while retrying the same unchanged form.

See [runtime boundaries](RUNTIME_AND_SELF_HOSTING.md),
[canonical contracts](CANONICAL_CONTRACTS.md), and the
[install support policy](../../.github/INSTALL_SUPPORT_POLICY.md). This is a bounded
development profile, not a stable framework, production deployment or certified
provider integration.
