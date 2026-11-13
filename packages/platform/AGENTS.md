# @openlup/platform for agents

## Purpose and kind

Kind: `rail`.

The package supplies runnable server infrastructure and optional commerce
capabilities. An application selects services and supplies ports, credentials,
policy, authorization and host composition. Imports do not activate services.
This is a development preview; inspect each exported subpath's maturity below.

## Installed context lookup

From the application root, invoke the installed local executable:

```sh
./node_modules/.bin/openlup-context search "subscription renewal"
```

This MVP indexes English documentation. Translate Polish or other natural-language
tasks into concise English domain terms, or search an exact public symbol;
freeform Polish queries may miss relevant guidance. `--code` scans a bounded
set of application source paths; `--package-code` scans installed package `src/`
files. Both are opt-in and may be incomplete; direct `rg` remains available.

Choose the next lookup from the evidence needed: read a known path or symbol
directly; use `openlup-context` when the package owner or seam is unclear; then
open its cited source. For work spanning packages, follow the relevant exports,
callers and tests until each required contract has a witness. A ranked hit is a
starting point, not proof that all related constraints were found.

Core supplies this Node-only executable. It reads installed local snapshots on
invocation and grants no application policy, tool permission or external-write
authority. The application's own instructions govern.

## Subpath maturity

| Export | Role | Maturity |
| --- | --- | --- |
| `./account-support` | capability | experimental |
| `./account-support/contracts` | capability | experimental |
| `./account-support/postgres` | capability | experimental |
| `./account-support/read-contracts` | capability | experimental |
| `./bff` | rail | experimental |
| `./blob` | rail | experimental |
| `./catalog` | capability | experimental |
| `./catalog/contracts` | capability | experimental |
| `./channels` | capability | experimental |
| `./channels/contracts` | capability | experimental |
| `./channels/server` | capability | experimental |
| `./commerce` | capability | experimental |
| `./commerce/contracts` | capability | experimental |
| `./commerce/server` | capability | experimental |
| `./commerce/server/destinations` | capability | experimental |
| `./commerce/server/native-checkout` | capability | experimental |
| `./commerce/server/postgres` | capability | experimental |
| `./communications` | capability | experimental |
| `./communications/contracts` | capability | experimental |
| `./communications/klaviyo` | capability | experimental |
| `./communications/resend` | capability | experimental |
| `./company-identity` | capability | experimental |
| `./company-identity/contracts` | capability | experimental |
| `./company-identity/server` | capability | experimental |
| `./composition` | rail | experimental |
| `./data` | rail | experimental |
| `./fulfillment` | capability | experimental |
| `./fulfillment/contracts` | capability | experimental |
| `./fulfillment/native` | capability | experimental |
| `./fulfillment/omnipack` | capability | experimental |
| `./http` | rail | experimental |
| `./identity` | capability | experimental |
| `./identity/contracts` | capability | experimental |
| `./inventory` | capability | experimental |
| `./inventory/contracts` | capability | experimental |
| `./invoicing` | capability | experimental |
| `./invoicing/contracts` | capability | experimental |
| `./invoicing/postgres` | capability | experimental |
| `./job-ledger` | rail | experimental |
| `./kernel` | rail | experimental |
| `./lifecycle` | rail | experimental |
| `./market-packs` | capability | experimental |
| `./marketing` | capability | experimental |
| `./marketing/contracts` | capability | experimental |
| `./marketing/server` | capability | experimental |
| `./marketing/server/postgres` | capability | experimental |
| `./migrations` | rail | experimental |
| `./operations` | capability | experimental |
| `./operations/contracts` | capability | experimental |
| `./operations/server` | capability | experimental |
| `./payments` | capability | experimental |
| `./payments/contracts` | capability | experimental |
| `./payments/stripe` | capability | experimental |
| `./payments/testing` | capability | experimental |
| `./payments/tpay` | capability | experimental |
| `./portability` | rail | experimental |
| `./pricing` | capability | experimental |
| `./pricing/browser` | capability | experimental |
| `./pricing/contracts` | capability | experimental |
| `./promotions` | capability | experimental |
| `./promotions/contracts` | capability | experimental |
| `./risk` | capability | experimental |
| `./risk/contracts` | capability | experimental |
| `./risk/server` | capability | experimental |
| `./scheduler` | rail | experimental |
| `./shipping` | capability | experimental |
| `./shipping/contracts` | capability | experimental |
| `./subscriptions` | capability | experimental |
| `./subscriptions/contracts` | capability | experimental |

This table is checked against `release-gates.json`. Any preview version may
change an export; read [the changelog](CHANGELOG.md) before upgrading.

## Wiring example

The following example compiles in CI and declares jobs without starting a host:

```ts
import { createScheduledJobRegistry } from "@openlup/platform/scheduler";

export const jobs = createScheduledJobRegistry([
  { id: "app-cleanup", schedule: "0 * * * *", run: async () => {} },
]);
```

The application binds a scheduler, implements effects and supplies leases where
required; see [scheduled jobs](README.md#scheduled-jobs).

## Provider wiring recipes

For transactional email, email provider setup, marketing automation and ecommerce
events, start with the offline examples: the README's
[provider wiring recipes](README.md#provider-wiring-recipes) for marketing and
ecommerce events, and the
[captured delivery recipe](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#captured-delivery-and-protocol-observations)
for transactional email.

## Sources and declarations

Read the installed `src/`, exported `dist/` declarations and their declaration
maps before guessing a contract. The shipped SQL is applied only through the
explicit installation route in the [README](README.md#install-the-portable-postgresql-schema).
Repository links in context excerpts refer to the matching package release tag;
those repository files are not paths to create in the application.

## Readiness codes

Core's checker reports `OPENLUP_E_PORT_MISSING`, `OPENLUP_E_EVENT_UNHANDLED`,
`OPENLUP_E_EVENT_DUPLICATE`, `OPENLUP_E_SCHEDULE_UNBOUND`, `OPENLUP_E_SCHEMA_BEHIND`,
`OPENLUP_E_SET_MISMATCH` and `OPENLUP_E_ENV_MISSING`. Only a `ready` report admits
its exact selected candidate. Unknown observations refuse activation; metadata
alone does not establish SQL bodies, ACLs, provider recovery or hosted qualification.

## Using this package in an application

Use declared public exports. Do not edit `node_modules/@openlup/**`, patch,
fork, vendor, monkey-patch, shadow or restore a copied package engine
autonomously. Supply application-owned handlers, ports, configuration and policy
through documented seams. If a seam is missing, keep a local reproducer and
obtain authority before proposing it upstream; hold the dependent change or use
a compatible wrapper or rollback while preserving pending obligations.

Upgrade every `@openlup/*` package together, pin exact versions and read every
changelog's `Migration:` blocks. Apply the complete packaged migration chain
through the application's explicit installation route; never rewrite published
SQL. Optional peers and selected services need their own configuration, readiness
and application authorization. Installation does not activate a host or provider.

This guide describes the installed contract and grants no host/tool/external-write
authority. The application's own `AGENTS.md` governs. Inside the OpenLup monorepo,
the repository root `AGENTS.md` governs instead.
