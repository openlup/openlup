# Support

OpenLup is maintained by a very small team in a deliberately quiet phase of the
project. This file says what that means for you in practice, so you can decide
what to rely on before you rely on it.

## There is no SLA

**Nothing in this project carries a service-level agreement.** There is no
guaranteed response or fix time, no guaranteed release date, and no guarantee
that any given issue will ever receive a reply or be accepted as a defect.
Issues may sit untouched. Questions may go unanswered. That is the stated
arrangement, not a failure of it.

No SLA does not erase the stable maintenance promise. Releases inside the
exact window and module scope below receive the
maintenance classes promised by `.github/VERSIONING_AND_EOL.md`; the project
does not promise a deadline for diagnosing or publishing any individual fix.

If you need a guaranteed response time, you need a commercial agreement, and
none is offered today. Do not deploy this on the assumption that someone is
continuously on call.

## Where to ask

| You have | Use |
|---|---|
| a defect in a supported stable artifact or a bounded reference check | a bug report issue |
| something the core should do and does not | a feature request issue |
| a suspected security vulnerability | the private route in `SECURITY.md` - never a public issue |
| a wrong, unclear or missing page of the guide | a documentation problem issue |
| a question about running the platform | read the documentation first; then a feature request describing what the documentation failed to answer |

Blank issues are disabled. Bug reports ask for a version and a reproduction;
feature requests ask for the problem, the current workaround, and why it belongs
in core; documentation problems ask for the page and the version it was read
at. Each form collects the details for its report type.

## Release channel decides the promise

The [versioning policy](VERSIONING_AND_EOL.md#two-release-channels) defines the
stable npm line and separate source snapshots. Support measures a report against
the release’s exact artifact set, the [supported installation](INSTALL_SUPPORT_POLICY.md)
and the [support window](VERSIONING_AND_EOL.md#support-window).
A branch or arbitrary checkout does not become supported because it builds.

## Module ownership decides the scope

- **Core** and **official-stable** modules are in scope only when they ship in
  the supported platform BOM and version.
- **Official-experimental** modules follow the [experimental API policy](../packages/core/docs/guide/reference/stability.md#public-api), even when used beside a
  stable platform release.
- **Community** modules are owned by their contributors. A catalogue or README
  listing is discovery, not OpenLup endorsement, security review, compatibility,
  or support.
- **Private** modules and source an adopter elects to eject or copy are owned by
  that adopter.

## What is in scope

Defects in the exact supported artifact set, reproduced on the supported
installation and a version inside the support window. Reports about bounded
reference checks or experimental capabilities remain useful best-effort evidence.

## What is out of scope

- Stable installs that deviate from the supported path, in any way, for any
  reason.
- Stable versions outside the support window.
- Your own code built on top of the platform, including ejected source and
  private extensions. That layer is yours.
- Community and official-experimental modules outside the stable contract.
- Integration with third-party services the project does not ship an adapter for.
- General programming help, architecture review, or consulting.
- Anything about a fork, once it has diverged.

## Before you file

Confirm the behaviour is wrong rather than merely surprising, and that the
project documents the expectation you are measuring against. A report that a
documented behaviour is undesirable is a feature request.

## Current state, stated plainly

The platform remains under active development. Capability coverage and live
provider qualification are bounded; [publication completeness](PUBLICATION_COMPLETENESS.md)
and [installation support](INSTALL_SUPPORT_POLICY.md) describe their separate
claims. Use the exact release/BOM rather than inferring support from a checkout.
