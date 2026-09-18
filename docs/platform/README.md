# OpenLup Platform Documentation

Status: development-preview documentation. The platform is not yet a stable framework release or a supported adopter distribution.

This is the public documentation set for the OpenLup platform. It describes the portable platform boundary and the limits of the current preview. It does not grant release, hosting, upgrade, or support commitments.

## Start here

- [Agent guide](AGENT_GUIDE.md) — the complete public guide for coding agents and the source text projected to the public root `AGENTS.md`.
- [Architecture and extensions](ARCHITECTURE_AND_EXTENSIONS.md) — module ownership, extension seams, and source-ejection consequences.
- [Data and migrations](DATA_AND_MIGRATIONS.md) — compatibility-first schema evolution and adopter-owned data.
- [Runtime and self-hosting](RUNTIME_AND_SELF_HOSTING.md) — runtime boundaries and the limits of preview self-hosting.
- [Canonical contracts](CANONICAL_CONTRACTS.md) — status, idempotency, and provider-boundary rules.

## Preview boundary

The intended topology is one platform monorepo plus separately owned adopter applications. A source preview may make the platform available for evaluation; it does not make a source checkout an upgrade contract. Stable-framework claims wait for the separate `P1-SF` gate: a versioned release/BOM, a thin adopter app, public extension and conformance contracts, upgrade tooling, and passing public installation, build, test, compatibility, provenance, and independent-adopter evidence.

For contribution rules, read [CONTRIBUTING.md](../../CONTRIBUTING.md). For responsible disclosure and sensitive-material handling, read [SECURITY.md](../../SECURITY.md).
