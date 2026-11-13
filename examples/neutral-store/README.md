# Neutral store

This starter is an application inside the OpenLup source repository, separate
from its npm workspaces. It combines public package entries with application-owned
configuration, browser pages and a local demonstration host.

From this checkout's root, using Node.js 24 and npm 11.19.0 after installing the
root dependencies and building the packages, run:

```sh
cd examples/neutral-store
npm run build
npm start
```

This serves the database-free UI at `http://127.0.0.1:4319`. Stop with Ctrl-C.
For a different configuration or port, use
`npm start -- --configuration coffee --port 4320`. On macOS and Linux,
`npm run dev` provides the [watched edit loop](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#edit-and-refresh).
This preview does not bind database-backed purchase or account actions.

Read the [guide](../../packages/core/docs/guide/README.md), follow the small
[npm tutorial](../../packages/core/docs/guide/start/tutorial.md), or prepare an
[independent starter application](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#prepare-the-application).
Use [starter customization](../../packages/core/docs/guide/how-to/build/customize-the-starter.md),
[routes](../../packages/core/docs/guide/reference/starter-routes.md),
[limits](../../packages/core/docs/guide/reference/limits.md) and
[ownership](../../packages/core/docs/guide/concepts/starter-ownership.md) for reader guidance.
The [execution record](docs/proof.md) retains development evidence.

The headings below preserve existing links to moved guidance.

## Local UI edit loop

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#edit-and-refresh).

## Current candidate

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md).

## Order controls and documents

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#account-and-operator-bindings).

## Start from an exact source archive

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#prepare-the-application).

## Run the local application

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#run-the-local-demonstration).

## Host origin and local sessions

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#protect-local-sessions-and-messages).

## Customize and upgrade

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md).

## Install-only fictional catalogue

Moved to [the reader guide](../../packages/core/docs/guide/concepts/starter-ownership.md#own-configuration-and-data-onboarding).

## Customer subscription editors

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#configure-subscription-editing).

## Reset an interrupted first install

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#reset-an-interrupted-first-install).

## Data boundary

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md).

## Pages and proof

Moved to [the reader guide](../../packages/core/docs/guide/reference/starter-routes.md).

## Neutral inputs and local transport

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#run-the-local-demonstration).

## Operator support roster and catalogue authoring

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#provision-operator-rosters).

#### Commerce operator roster for hold and release admission

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#provision-operator-rosters).

## Acquisition and unbound operator actions

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#replace-acquisition-location-choices).

## Guest purchase and later sign-in

Moved to [the reader guide](../../packages/core/docs/guide/concepts/starter-ownership.md#checkout-continuation-and-recovery).

## Native quote and acquisition composition

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#purchase-composition-boundaries).

## Recovery admission and private capture

Moved to [the reader guide](../../packages/core/docs/guide/concepts/starter-ownership.md#checkout-continuation-and-recovery).

### Scheduled sandbox renewal checkpoint

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#run-a-bounded-background-pass).

### Private paid-order receipts

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#paid-order-message-capture).

## Subscription care candidate

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#subscription-care).

### Candidate changes

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#subscription-care).

### Checkout and account candidate changes

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#account-and-operator-bindings).

## Expired checkout recovery and order holds

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#expired-checkout-recovery-and-order-holds).

## Unpaid cancellation and manual refund records

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#unpaid-cancellation-and-manual-refund-records).

## Return requests and decisions

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#return-requests-and-decisions).

## Optional payment guidance

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#optional-payment-guidance).

## Operator shipment evidence

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#operator-shipment-evidence).

## Saved addresses and scoped preferences

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#saved-addresses-and-scoped-preferences).

## Sandbox token payment and exact continuation

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#sandbox-token-payment-and-exact-continuation).

## Billing profiles and frozen invoice buyers

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#billing-profiles-and-frozen-invoice-buyers).
