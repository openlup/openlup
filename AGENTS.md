# OpenLup Public Agent Guide

Status: development-preview guidance. The authoritative text is authored at
`docs/platform/AGENT_GUIDE.md`; the publication projector places the same guide
at the public root as `AGENTS.md`, with only placement-specific link rewrites.

OpenLup is a subscription-commerce platform. The platform's public tree is a platform monorepo; an adopter owns its own application, brand, content, local policy, and integrations.
This guide governs work in that public tree only. It does not authorize releases, external mutations, or stable-framework claims.

## Orientation

Read these documents before changing a related boundary:

- [Platform documentation index](docs/platform/README.md)
- [Architecture and extensions](docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
- [Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md)
- [Runtime and self-hosting](docs/platform/RUNTIME_AND_SELF_HOSTING.md)
- [Canonical contracts](docs/platform/CANONICAL_CONTRACTS.md)
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md)

Treat code, tests, and machine-readable contracts as the implementation truth. Keep documentation aligned when a public boundary changes.
Do not copy a deployment-specific assumption into a platform contract.

## Architecture rules

- Keep browser-shareable contracts and clients separate from server use cases.
- Keep provider SDKs, HTTP clients, environment readers, and payload translation behind infrastructure and adapter boundaries.
- Put durable platform-data changes in ordered migrations; follow the compatibility lifecycle in [Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md).
- Keep an adopter's brand, copy, catalogue, local rules, and provider-specific composition outside generic platform code.
- Preserve the subscription invariant: a late delivery extends the next cycle;
  the monotonic clamp must never stack deliveries or move a cycle earlier.
  A replacement may settle delivery alignment as `aligned` only after it
  reached the customer. Its superseded predecessor is no longer an outstanding
  obligation, but an in-flight or undelivered replacement still is. Never call
  `subscription_delivery_alignment_confirm_replacement` for a replacement that
  did not arrive: that operation records the customer-facing fact "Parcel
  delivered" and shifts the cycle later.

## Extension and ownership rules

Prefer a documented port, configuration seam, event subscription, or theme/data boundary over modifying platform internals.
An adopter may keep an extension in its own source or propose it upstream, but an accepted change still needs an explicit compatibility and maintenance owner.

Copying a platform component or page into adopter source is source ejection. The adopter then owns its security, tests, compatibility work, and manual porting of later changes; the platform does not update that copy automatically.

## Change and verification rules

Keep changes small, test the affected public contract, and make failures actionable. An adapter must demonstrate its declared capabilities and refusal behaviour without relying on live provider access.
A migration, status mapping, or idempotency rule needs a regression test for its failure or replay boundary.

Use only the configuration and test fixtures supplied for the selected development profile. Do not place sensitive values in source, fixtures, logs, or documentation.
Follow [SECURITY.md](SECURITY.md) for reporting and handling a suspected vulnerability; this guide intentionally supplies no reporting address of its own.

## Release posture

The development preview is not a stable framework channel. Do not call a source checkout, preview artifact, extension seam, or self-host recipe stable or supported before `P1-SF` is complete.
A release or activation needs its own explicit authorization and evidence; ordinary code changes do not create that authority.
