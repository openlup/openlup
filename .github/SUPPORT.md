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

No SLA does not erase the future stable maintenance promise. Once stable
exists, releases inside the exact window and module scope below receive the
maintenance classes promised by `.github/VERSIONING_AND_EOL.md`; the project
does not promise a deadline for diagnosing or publishing any individual fix.

If you need a guaranteed response time, you need a commercial agreement, and
none is offered today. Do not deploy this on the assumption that someone is
continuously on call.

## Where to ask

| You have | Use |
|---|---|
| a defect in a bounded preview check/reference, or later a supported stable artifact | a bug report issue |
| something the core should do and does not | a feature request issue |
| a suspected security vulnerability | the private route in `SECURITY.md` - never a public issue |
| a question about running the platform | read the documentation first; then a feature request describing what the documentation failed to answer |

Blank issues are disabled. Every report goes through a form, because triage
without a version and a reproduction is not triage.

## Release channel decides the promise

The project has two release channels:

| Channel | Support posture |
| --- | --- |
| development preview | Current state. Evaluation and first-party integration evidence only; no supported version, response commitment, compatibility window, or production-readiness claim. Reproducible reports are still useful and may be handled on a best-effort basis. |
| stable | Future state after the `P1-SF` stable-framework gate. Only the exact platform BOM and artifacts named by a supported stable release fall inside the version window in `.github/VERSIONING_AND_EOL.md`. |

A branch, commit, private package, exported worktree, or arbitrary source checkout
does not become supported because it can be built. When the stable channel
exists, its release manifest will name the supported packages, images,
composition and thin-app artifact together. Support measures a report against
that artifact set and the install shape in `.github/INSTALL_SUPPORT_POLICY.md`,
not against whatever happened to be present in a checkout.

## Module ownership decides the scope

- **Core** and **official-stable** modules are in scope only when they ship in
  the supported platform BOM and version.
- **Official-experimental** modules follow preview rules, even when used beside a
  stable platform release.
- **Community** modules are owned by their contributors. A catalogue or README
  listing is discovery, not OpenLup endorsement, security review, compatibility,
  or support.
- **Private** modules and source an adopter elects to eject or copy are owned by
  that adopter.

## What is in scope

Today, useful best-effort reports about the bounded checks/reference or an
incomplete platform capability described in `.github/INSTALL_SUPPORT_POLICY.md`.
There is no full-platform candidate install to certify yet. Once stable exists,
defects in the exact supported artifact set, reproduced on that install path and
on a version inside the support window described in
`.github/VERSIONING_AND_EOL.md`.

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

The platform is under active development and has not been certified as ready to
self-host. Capability coverage on the portable runtime is measured and partial;
`.github/PUBLICATION_COMPLETENESS.md` names the commands that decide, and
`.github/INSTALL_SUPPORT_POLICY.md` states what the bounded public reference does
and does not prove. Treat every install as development preview until a stable release
explicitly names its supported BOM and artifacts.
