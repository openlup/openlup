# OpenLup Platform Documentation

Status: development-preview documentation. The platform is not yet a stable framework release or a supported adopter distribution.

This is the public documentation set for the OpenLup platform. It describes the portable platform boundary and the limits of the current preview. It does not grant release, hosting, upgrade, or support commitments.

## Start here

- [Agent guide](AGENT_GUIDE.md) — the public guide for coding agents; the root `AGENTS.md` is its location-adjusted copy.
- [Architecture and extensions](ARCHITECTURE_AND_EXTENSIONS.md) — module ownership, extension seams, and source-ejection consequences.
- [Data and migrations](DATA_AND_MIGRATIONS.md) — compatibility-first schema evolution and adopter-owned data.
- [Runtime and self-hosting](RUNTIME_AND_SELF_HOSTING.md) — runtime boundaries and the limits of preview self-hosting.
- [Canonical contracts](CANONICAL_CONTRACTS.md) — status, idempotency, and provider-boundary rules.

## Preview boundary

The intended topology is one platform monorepo plus separately owned adopter applications. A source preview may make the platform available for evaluation; it does not make a source checkout an upgrade contract. Stable-framework claims wait for the separate `P1-SF` gate: a versioned release/BOM, a thin adopter app, public extension and conformance contracts, upgrade tooling, and passing public installation, build, test, compatibility, provenance, and independent-adopter evidence.

For contribution rules, read [CONTRIBUTING.md](../../CONTRIBUTING.md). For responsible disclosure and sensitive-material handling, read [SECURITY.md](../../SECURITY.md).

## Write or update a page

Keep current instructions near their existing owner: this index routes readers,
the linked platform pages own their contracts, and the root
[contribution guide](../../CONTRIBUTING.md) owns submission steps. Check code,
declared commands and the relevant release before describing a capability.
Label a page as current guidance, a proposal, or dated history; a historical
procedure must not look executable today. Name the available development-preview
profile and its support limits without implying a stable install.

For a new task-oriented page, copy only the fields that serve its readers:

```text
# <Task or contract>

Status: current development-preview guide | proposal | historical evidence (date)
Audience and purpose: <who needs this, and for what>
Available release/profile and support: <canonical release or policy link; limits>
Prerequisites: <exact tools and safe example inputs>
Steps: <working directory, command, expected result; mark state-changing steps>
Evidence: <code or release used to verify time-sensitive claims, and when>
Limits and recovery: <what this does not prove; refusal or safe retry route>
Owner and next links: <canonical contract, contribution or support page>
```

A reference contract may use its existing structure rather than this task
template. Keep release-specific changes in immutable release notes; correct
published mistakes forward. Update changed active pages with the same public
contribution that changes the behavior they explain. Avoid private project
links, credentials, moving version copies and new duplicate manuals.
