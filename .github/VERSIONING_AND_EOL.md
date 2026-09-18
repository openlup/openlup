# Versioning and end of life

## Two release channels

OpenLup separates **development preview** from **stable**. An immutable preview
identity makes an artifact reproducible; it does not make that artifact stable
or supported.

- **Development preview** is the current channel. It is for evaluation and
  first-party integration evidence, has no support window, and may contain
  incompatible changes. Every incompatible preview must name the affected
  contract and give explicit upgrade notes in that preview's release notes.
  Silent preview breakage is a defect.
- **Stable** begins only after the `P1-SF` stable-framework gate has produced a versioned platform
  release/BOM, a thin adopter app, public extension contracts and upgrade
  tooling, with the advertised clean install, typecheck, build, tests and
  upgrade proofs green. No current source checkout, private package, or preview
  release satisfies that gate.

## The public compatibility contract

Compatibility is decided by what an adopter consumes, not only by what a package
exports. The public contract includes all of these surfaces when they are
declared public or shipped by an official-stable/core module:

- package export names, types, call shapes, documented behavior and error codes;
- domain and runtime event names, payloads, ordering and delivery semantics;
- extension, module, adapter, registry and capability identifiers;
- public HTTP routes, methods, request/response shapes and error vocabulary;
- configuration keys, schemas, defaults and documented environment behavior;
- migration identifiers, ordering, ledger semantics and the compatibility of
  code with the expanded database schema during an upgrade.

The exported contract snapshot is evidence for the package-export part of this
contract, not a way to declare the other surfaces internal. A surface explicitly
marked experimental follows preview rules. An undeclared implementation detail
may change in any release, but maintainers may not turn a documented adopter
dependency into an internal merely to avoid a compatibility obligation.

## Stable semantic versioning

Stable releases follow semantic versioning across the whole public compatibility
contract.

- **Major** - may complete a previously announced removal after the deprecation
  bridge below.
- **Minor** - additive contracts and deprecations. A breaking change never ships
  in a stable minor.
- **Patch** - fixes with no intentional public contract change.

A stable public contract is not removed in the same release that deprecates it.
First ship a working bridge that keeps the old export, event, identifier, route,
configuration or schema behavior available while naming the replacement and
upgrade action. Keep that bridge through at least one supported stable minor,
and remove it no earlier than the next major with explicit upgrade notes. For
database changes this means expand -> compatible deploy -> backfill -> contract;
rollback must remain compatible with the expanded schema and never rely on a
production down migration.

## Support window

Once stable exists, the current **stable** major and the previous **stable**
major, if one exists, are supported. Development-preview trains are never a
previous stable major, regardless of whether their numeric version was `0.x`.
Nothing else is.

| Version | What it receives |
| --- | --- |
| current major, latest minor | fixes, security fixes, new features |
| current major, older minors | nothing - upgrade to the latest minor first |
| previous stable major, latest minor, if one exists | security fixes and critical-defect fixes only, for **six months** after the current major was released |
| anything older | nothing |

A defect report against an older minor of a supported major must reproduce on
the latest minor. Six months after a new stable major is released, its preceding
stable major, if one exists, is end of life and receives no fixes, including
security fixes. Preview `0.x` does not enter that calculation. The published
window is the advance notice; there is no separate end-of-life campaign.

## Exceptional cessation

This file solely owns the cessation trigger and mechanics. If issues go
unanswered for **six consecutive months**, the project enters exceptional
cessation; governance does not define a second trigger. The maintainer records
the decision here and at the top of the README, naming the decision date, exact
end-of-maintenance date and last supported releases. The repository is archived
on or after that date. If no stable channel ever existed, it may be archived as
soon as the six-month condition is recorded.

If maintainership ceases before an advertised stable window can be completed,
the project must not leave a false support claim standing. The record above is
the fail-honest path for the bus-factor-one project described in
`.github/GOVERNANCE.md`; it does not shorten a support window casually, erase
the licence or make an already released artifact unavailable to fork.

## Before stable

The project has not entered the stable channel. No current version is supported,
and the stable support window above does not apply. Preview releases can break,
but they still owe explicit, release-specific upgrade notes; "pre-1.0" is not
permission to make consumers discover a change from a failed build or migration.

## Upgrades

Stable upgrades are supported one major at a time, in order. Skipping a major is
not supported even when it appears to work. Preview upgrade notes describe only
the exact adjacent preview transition they name and do not create a general
support promise. Database schema changes are forward-only; there is no supported
downgrade path, so take a backup you have actually restored from at least once
before upgrading.
