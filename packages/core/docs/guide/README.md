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
- Report a wrong page as an
  [issue](https://github.com/openlup/openlup/issues) that names the page and
  the installed version.

## Pages

The guide is being written. Each section below is listed with what it will
hold; a section marked "to be written" has no page yet.

| Section | What it holds | State |
| --- | --- | --- |
| Start | Whether OpenLup fits, its limits and maturity, and a tutorial from installing the packages to a running store. | to be written |
| How-to: build | Composing the packages, customizing the starter, adding OpenLup to an existing application. | to be written |
| How-to: extend | Adapters, providers and extension seams. | to be written |
| How-to: operate | Deployment and self-hosting, a production checklist, retention, shutdown and security hardening. | [Connect to PostgreSQL](how-to/operate/connect-postgresql.md), [Run OpenLup on your own host](how-to/operate/self-host.md), [Shut down a host cleanly](how-to/operate/shutdown.md), [Customer diagnostic history and retention](how-to/operate/diagnostics-and-retention.md); production checklist and security hardening to be written |
| Upgrade | The upgrade procedure and one page per release. | [Upgrade the database](upgrade/database-migrations.md), [Upgrade application files](upgrade/application-files.md); procedure and release pages to be written |
| Concepts | Architecture and ownership, one page per commerce domain, and the security model. | to be written |
| Reference | Exports, configuration keys, SQL catalogue, command line, refusal codes, capability maturity, limits, versioning and stability policy. | to be written |
| Troubleshooting | Symptom or refusal code, its cause and the fix. | to be written |
| Glossary | The words this guide uses. | to be written |

Until a section exists, the repository
[README](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/README.md)
is the starting point.

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
[CONTRIBUTING.md](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/CONTRIBUTING.md).
