# @openlup/platform for agents

## Purpose and kind

Kind: `rail`.

The package supplies runnable server infrastructure and optional commerce
capabilities. An application selects services and supplies ports, credentials,
policy, authorization and host composition. Imports do not activate services.
Follow the [stability policy](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/reference/stability.md#public-api); inspect each exported subpath’s maturity below.

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

Core supplies this Node-only executable. It searches the installed reader guide
and package files on invocation and grants no application policy, tool permission
or external-write authority. The application's own instructions govern.

## Subpath maturity

| Export | Role | Maturity |
| --- | --- | --- |
| `./account-support` | capability | stable |
| `./account-support/contracts` | capability | experimental |
| `./account-support/postgres` | capability | stable |
| `./account-support/read-contracts` | capability | experimental |
| `./accounting` | capability | experimental |
| `./accounting/contracts` | capability | experimental |
| `./accounting/testing` | capability | testing |
| `./adapter-kit` | rail | experimental |
| `./bff` | rail | stable |
| `./blob` | rail | stable |
| `./catalog` | capability | stable |
| `./catalog/contracts` | capability | stable |
| `./channels` | capability | stable |
| `./channels/contracts` | capability | stable |
| `./channels/server` | capability | stable |
| `./channels/testing` | capability | testing |
| `./commerce` | capability | stable |
| `./commerce/contracts` | capability | stable |
| `./commerce/server` | capability | stable |
| `./commerce/server/destinations` | capability | stable |
| `./commerce/server/native-checkout` | capability | stable |
| `./commerce/server/postgres` | capability | stable |
| `./communications` | capability | stable |
| `./communications/contracts` | capability | stable |
| `./communications/klaviyo` | capability | experimental |
| `./communications/resend` | capability | experimental |
| `./communications/testing` | capability | testing |
| `./company-identity` | capability | stable |
| `./company-identity/contracts` | capability | stable |
| `./company-identity/server` | capability | stable |
| `./composition` | rail | stable |
| `./data` | rail | stable |
| `./fulfillment` | capability | stable |
| `./fulfillment/contracts` | capability | stable |
| `./fulfillment/native` | capability | stable |
| `./fulfillment/omnipack` | capability | stable |
| `./fulfillment/testing` | capability | testing |
| `./catalog/testing` | capability | testing |
| `./http` | rail | stable |
| `./identity` | capability | stable |
| `./identity/contracts` | capability | experimental |
| `./inventory` | capability | stable |
| `./inventory/contracts` | capability | stable |
| `./invoicing` | capability | stable |
| `./invoicing/contracts` | capability | experimental |
| `./invoicing/postgres` | capability | stable |
| `./job-ledger` | rail | stable |
| `./kernel` | rail | stable |
| `./lifecycle` | rail | experimental |
| `./market-packs` | capability | stable |
| `./marketing` | capability | stable |
| `./marketing/contracts` | capability | stable |
| `./marketing/server` | capability | stable |
| `./marketing/server/postgres` | capability | stable |
| `./migrations` | rail | stable |
| `./observability` | rail | experimental |
| `./observability/contracts` | rail | experimental |
| `./observability/testing` | rail | testing |
| `./operations` | capability | stable |
| `./operations/contracts` | capability | stable |
| `./operations/server` | capability | stable |
| `./payments` | capability | stable |
| `./payments/contracts` | capability | stable |
| `./payments/stripe` | capability | stable |
| `./payments/testing` | capability | testing |
| `./payments/tpay` | capability | stable |
| `./portability` | rail | experimental |
| `./pricing` | capability | stable |
| `./pricing/browser` | capability | stable |
| `./pricing/contracts` | capability | stable |
| `./promotions` | capability | stable |
| `./promotions/contracts` | capability | experimental |
| `./risk` | capability | stable |
| `./risk/contracts` | capability | stable |
| `./risk/server` | capability | stable |
| `./scheduler` | rail | stable |
| `./shipping` | capability | stable |
| `./shipping/contracts` | capability | stable |
| `./shipping/testing` | capability | testing |
| `./storefront` | capability | experimental |
| `./storefront/testing` | capability | testing |
| `./subscriptions` | capability | stable |
| `./subscriptions/contracts` | capability | stable |
| `./tax` | capability | experimental |
| `./tax/contracts` | capability | experimental |
| `./tax/stripe` | capability | experimental |

This table follows `release-gates.json`: stable exports use SemVer from 1.0.0; experimental and testing exports are excluded; read [the changelog](CHANGELOG.md) before upgrading.

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
Context lookup searches the installed reader guide and package files, citing
local paths and line ranges. Read those installed files before changing the
application.

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

Catalogue recipes: `node_modules/@openlup/core/docs/guide/how-to/extend/catalogue-extension.md` (offline scope and pending owners).
