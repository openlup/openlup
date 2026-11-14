# OpenLup guide

OpenLup is subscription-first, open-source commerce for direct-to-consumer
brands that sell physical products. This guide explains how to install,
compose, extend, operate and upgrade the `@openlup/*` packages.

**Status: development preview.** OpenLup does not yet offer a stable API, a
supported full-platform installation or an upgrade guarantee. Pin exact
versions and upgrade all `@openlup/*` packages together.

## Instructions for agents

- Read the copy of this guide that matches the installed `@openlup/core`
  version: the copy at that version's release tag. Do not rely on memory or on
  another version's pages.
- Never hardcode an OpenLup version; read it from the installed packages.
- Prefer the refusal-code reference to guessing what a refusal means.
- Report a wrong page through the [documentation problem form](https://github.com/openlup/openlup/issues/new?template=documentation_problem.yml), naming the page and the installed version.

## Pages

### Start

- [Is OpenLup for you?](start/README.md)
- [Adopt OpenLup from npm](start/adopt-from-npm.md)
- [Record a subscription cycle and process its event](start/tutorial.md)

### How-to: build

- [Compose account and support services](how-to/build/account-and-support.md)
- [Compose native bundle writes](how-to/build/bundles.md)
- [Recover abandoned checkouts and payments](how-to/build/checkout-recovery.md)
- [Customize the starter store](how-to/build/customize-the-starter.md)
- [Compose native fulfillment](how-to/build/fulfillment.md)
- [Compose invoicing](how-to/build/invoicing.md)
- [Compose marketing handlers](how-to/build/marketing.md)
- [Compose order management stores](how-to/build/oms-stores.md)
- [Deliver events with the outbox](how-to/build/outbox.md)
- [Add OpenLup to an existing application](how-to/build/own-stack.md)
- [Read prices for a quote](how-to/build/quote-prices.md)
- [Compose SEO and content slots](how-to/build/seo-and-content-slots.md)

### How-to: extend

- [Run an adapter conformance check](how-to/extend/adapter-conformance.md)
- [Choose an extension seam](how-to/extend/choose-an-extension-seam.md)
- [Take ownership of a copied component or page](how-to/extend/eject-source.md)
- [Compose a provider adapter](how-to/extend/provider-adapters.md)

### How-to: operate

- [Connect to PostgreSQL](how-to/operate/connect-postgresql.md)
- [Customer diagnostic history and retention](how-to/operate/diagnostics-and-retention.md)
- [Production checklist](how-to/operate/production-checklist.md)
- [Harden a deployment](how-to/operate/security-hardening.md)
- [Run OpenLup on your own host](how-to/operate/self-host.md)
- [Shut down a host cleanly](how-to/operate/shutdown.md)
- [Verify the published packages](how-to/operate/verify-published-packages.md)

### Upgrade

- [Upgrade an application](upgrade/README.md)
- [Upgrade the database](upgrade/database-migrations.md)
- [Upgrade application files](upgrade/application-files.md)
- [Upgrading to 0.40.0](upgrade/v0-40-0.md)
- [Upgrading to 0.41.0](upgrade/v0-41-0.md)
- [Upgrading to 0.42.0](upgrade/v0-42-0.md)

### Concepts

- [Architecture and ownership](concepts/architecture-and-ownership.md)
- [Catalogue and prices](concepts/catalogue-and-prices.md)
- [Checkout](concepts/checkout.md)
- [Fulfillment and delivery](concepts/fulfillment.md)
- [Idempotency](concepts/idempotency.md)
- [Identity](concepts/identity.md)
- [Marketing sync](concepts/marketing-sync.md)
- [Orders](concepts/orders.md)
- [Payments](concepts/payments.md)
- [Personal data](concepts/personal-data.md)
- [Security model](concepts/security-model.md)
- [Who owns what in the starter](concepts/starter-ownership.md)
- [Subscription engine](concepts/subscription-engine.md)
- [Subscriptions](concepts/subscriptions.md)

### Reference

- [Reference](reference/README.md)
- [AI-assisted contributions](reference/ai-contributions.md)
- [Command line](reference/cli.md)
- [Configuration keys](reference/configuration.md)
- [Exports](reference/exports.md)
- [Starter limits](reference/limits.md)
- [Maturity](reference/maturity.md)
- [Refusal codes](reference/refusal-codes.md)
- [SQL catalogue](reference/sql.md)
- [Versioning and stability](reference/stability.md)
- [Starter routes](reference/starter-routes.md)

### Troubleshooting

- [Troubleshooting](troubleshooting.md)

### Glossary

- [Glossary](glossary.md)

## Writing this guide

- One task or one concept per page.
- Open with the reader's goal.
- Give commands that run as written. TypeScript examples compile against the
  packages of the same release; an example that must not compile is fenced as
  `ts nocheck` and opens with a comment line that says why.
- State invariants and refusals plainly, with their refusal codes.
- Write for a reader outside the project: no task or milestone IDs, plan
  names, delivery-process vocabulary or details of one adopter's store.
- Pages carry no version, date or status. Versions, counts, export lists and
  capability maturity appear only in generated regions, which
  `npm run docs:check -- --write` refreshes from the code.
- Links between guide pages are relative. A link that leaves the guide is an
  absolute repository URL at the core release tag, which the same command
  rewrites on a version change.

How to change OpenLup itself is in
[CONTRIBUTING.md](https://github.com/openlup/openlup/blob/openlup-core-v0.42.0/CONTRIBUTING.md).
