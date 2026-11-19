# Versioning and stability

Use the release policy to understand which application dependencies OpenLup
promises to preserve and how to plan an upgrade. Consult the
[versioning policy](https://github.com/openlup/openlup/blob/openlup-core-v1.2.0/.github/VERSIONING_AND_EOL.md)
for channel commitments, version format and support-window durations.

## Release evidence

Before relying on release commitments, require a versioned release
and bill of materials, an adopter application, public extension and adapter
conformance contracts, upgrade tools, and installation, compatibility,
provenance and first-party consumer evidence. The consumer evidence is a first-party
demo store installed from npm and a first-party production deployment; no
independent adoption is claimed. A package's `latest` tag or a
successful source build does not establish those guarantees. The
[install support policy](https://github.com/openlup/openlup/blob/openlup-core-v1.2.0/.github/INSTALL_SUPPORT_POLICY.md)
defines the installation and support boundary; use the
[current limits](limits.md) to choose an evaluation path.

## Public API

The public compatibility contract covers what your application consumes when
declared public or shipped as part of a module’s compatibility commitment:

- Package exports, types, call shapes, documented behavior and error codes.
- Domain and runtime event names, payloads, ordering and delivery semantics.
- Extension, module, adapter, registry and capability identifiers.
- Public HTTP routes, methods, request and response shapes, and errors.
- Configuration keys, schemas, defaults and documented environment behavior.
- Migration identities, order, ledger semantics and code compatibility with
  the expanded database schema during an upgrade.

An export snapshot covers only the package-export part of this contract.
Documented application dependencies cannot be reclassified as internal to
avoid compatibility obligations. Undeclared implementation details may change
in any release; check the selected channel’s commitments before relying on a
surface. The [generated maturity reference](maturity.md) lists subpath classifications
from each package’s `release-gates.json`; use that table rather than inferring
stability from a namespace’s name.

Stable subpaths follow SemVer from 1.0.0. Status, event, reason, command and
capability unions and literal sets are open: adding a value is a minor change.
Consumers must keep a default branch for unknown values. Removing, renaming or
narrowing an export, value or type requires a major release. Symbols tagged
`@experimental` inside a stable subpath are outside that promise. Experimental
subpaths may change in any minor release; testing subpaths are test support only.

## Version numbers

A release identifier alone promises neither compatibility nor a support window.
Where incompatible changes are permitted, release notes must name each affected
contract and its upgrade actions. Transition-specific notes apply only to the
adjacent transition they name.

For channels with semantic-versioning commitments, those commitments cover the
whole public contract:

- **Major:** may remove a previously deprecated contract after its compatibility
  bridge has been provided.
- **Minor:** adds contracts or deprecates existing ones without breaking them.
- **Patch:** fixes defects without intentionally changing the public contract.

A deprecation must keep the old behavior working, name its replacement and
explain the upgrade action. Keep the compatibility bridge for the period
required by the versioning policy, with explicit upgrade notes before removal.
Check that policy’s release prerequisites before claiming compatibility,
idempotency or adapter-extension commitments.

Upgrade matching `@openlup/*` packages as a set from the same commit. Read the
versioning policy for the package-set and tag conventions. A source release
artifact does not itself contain npm packages.

## Support window

Check the versioning policy for the [supported minor and maintenance scope](https://github.com/openlup/openlup/blob/openlup-core-v1.2.0/.github/VERSIONING_AND_EOL.md#support-window)
and end-of-life rules. Upgrade to the latest minor and reproduce a defect
there before reporting it. Releases outside their advertised support window
receive no fixes, including security fixes. Evaluation channels do not acquire
a support window merely because a later major exists.

## Exceptional cessation

If the unanswered-issue period specified by the versioning policy elapses,
the project enters exceptional cessation. A notice in that policy and at the
top of the
[repository README](https://github.com/openlup/openlup/blob/openlup-core-v1.2.0/README.md)
records the decision date, exact end-of-maintenance date and last supported
releases. The repository is archived on or after that date; channels without a
support commitment may be archived as soon as the condition is recorded.

If maintenance ends before an advertised support window is complete, the notice
must correct the support claim. Cessation does not erase the licence or prevent
forking a released artifact.

## Upgrades

Upgrade all `@openlup/*` packages together. Where ordered major upgrades are
required, do not skip a major even if doing so appears to work.

The [database upgrade guide](../upgrade/database-migrations.md#check-application-compatibility)
owns schema evolution and code-rollback limits. Before upgrading, take a backup
and test restoring it. Application rollback must not depend on a database down migration.

## Release policy

Each package's release and compatibility policies, as its release contract declares them.

<!-- generated:versioning -->
| Package | Section | Field | Value |
| --- | --- | --- | --- |
| `@openlup/core` | packageRelease | artifactChannel | npm-stable |
| `@openlup/core` | packageRelease | phase | platform-monorepo-phase-5 |
| `@openlup/core` | packageRelease | publicStability | stable-semver |
| `@openlup/core` | packageRelease | versionRule | MAJOR.MINOR.PATCH |
| `@openlup/core` | compatibilityPolicies | experimental | Experimental API; may change in any minor release. |
| `@openlup/core` | compatibilityPolicies | stable | Stable API under SemVer from 1.0.0. Unions and literal sets are open: adding a value is minor; consumers must keep a default branch for unknown values. Removing, renaming or narrowing an export, value or type is major. Symbols tagged @experimental within a stable subpath are outside this promise. |
| `@openlup/core` | compatibilityPolicies | testing | Test support only; not a runtime compatibility promise. |
| `@openlup/outbox` | packageRelease | artifactChannel | npm-stable |
| `@openlup/outbox` | packageRelease | phase | platform-monorepo-phase-5 |
| `@openlup/outbox` | packageRelease | publicStability | stable-semver |
| `@openlup/outbox` | packageRelease | versionRule | MAJOR.MINOR.PATCH |
| `@openlup/outbox` | compatibilityPolicies | experimental | Experimental API; may change in any minor release. |
| `@openlup/outbox` | compatibilityPolicies | stable | Stable API under SemVer from 1.0.0. Unions and literal sets are open: adding a value is minor; consumers must keep a default branch for unknown values. Removing, renaming or narrowing an export, value or type is major. Symbols tagged @experimental within a stable subpath are outside this promise. |
| `@openlup/outbox` | compatibilityPolicies | testing | Test support only; not a runtime compatibility promise. |
| `@openlup/platform` | packageRelease | artifactChannel | npm-stable |
| `@openlup/platform` | packageRelease | phase | platform-monorepo-phase-5 |
| `@openlup/platform` | packageRelease | publicStability | stable-semver |
| `@openlup/platform` | packageRelease | versionRule | MAJOR.MINOR.PATCH |
| `@openlup/platform` | compatibilityPolicies | experimental | Experimental API; may change in any minor release. |
| `@openlup/platform` | compatibilityPolicies | stable | Stable API under SemVer from 1.0.0. Unions and literal sets are open: adding a value is minor; consumers must keep a default branch for unknown values. Removing, renaming or narrowing an export, value or type is major. Symbols tagged @experimental within a stable subpath are outside this promise. |
| `@openlup/platform` | compatibilityPolicies | testing | Test support only; not a runtime compatibility promise. |

[Versioning and end-of-life policy](https://github.com/openlup/openlup/blob/openlup-core-v1.2.0/.github/VERSIONING_AND_EOL.md)
<!-- /generated:versioning -->
