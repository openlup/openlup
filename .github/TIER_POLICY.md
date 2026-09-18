# Tier policy

The commercial model is **open core plus a hosted service**. This file states the
rule that decides what may ever sit behind payment, because a decision rule
written before there is money at stake is worth more than one written after.

## The one-way ratchet

**Anything published under Apache-2.0 stays open. Permanently. Open never
becomes paid.**

This is the binding rule of this document, and it runs in one direction only:

- code may move from withheld to open at any time;
- code may **never** move from open to paid, restricted, or withheld;
- a feature that shipped in the open core is not re-licensed, not moved behind a
  tier, not degraded, and not "moved to the hosted edition" in a later release.

The ratchet is not merely a promise. Under Apache-2.0, a released version stays
released and stays forkable by anyone, forever. The rule above commits the
project to not fighting that property, and to not doing the thing the licence
would technically permit for future versions.

Open is a licence state, not a maturity or support label. A community module can
be Apache-2.0 without being endorsed or supported, and an official-experimental
module can be open while remaining preview-only. The admission ladder is owned
solely by `.github/GOVERNANCE.md`; this licence/tier policy does not redefine its
states or promotion criteria. Promotion does not buy ownership from a
contributor, and community listing remains discovery rather than endorsement,
security review, compatibility or support. Only the governance classifications
that carry the stable compatibility obligation may enter a future supported
platform BOM.

## Where paid value is allowed to live

**In the operational layer, never in withheld code.** Hosting, provisioning,
scaling, backups, monitoring, upgrades performed for you, and a support
agreement with an actual response obligation - those are things a service does,
not things the code stops doing. Running the platform yourself must remain
genuinely possible, or the openness is decorative.

## The decision rule for any new module

Ask, in order:

1. **Was it promised as part of the working core?** If yes, it is open. There is
   no second question.
2. **Would removing it degrade a core module below "works and is useful"?** If
   yes, it is open. The test is the module's usefulness, not the size of the
   piece.
3. **Is it something the core never promised** - a distinct capability serving a
   different shape of business? Then it is a legitimate candidate for an
   additive paid package.

Commerce is **strictly additive**: paid work is built on top of a stabilized open
core, never carved out of it.

The project is currently in development preview. No stable platform BOM or
supported artifact exists yet, so `official-stable` and `core` describe the
promised destination and compatibility class, not a claim that today's source
checkout is a supported framework distribution.

## Named and refused

**Subscriptions, renewals, dunning, mandates, payment recovery, and the
transactional messaging engine are open core and will not be paid tiers.** They
are the reason this project exists and the thing the category paywalls; charging
for them would delete the project's own headline. This paragraph exists to make
that a commitment rather than a current preference.

Reasonable candidates for a future additive package are capabilities never
promised in the core - for example business-to-business ordering, multi-store
operation, or advanced analytics. Naming them here creates no obligation to build
them and no expectation that they will be paid.

## Today

There are no tiers. Everything the project publishes is open, and no paid package
or hosted service exists yet. When one does, this file is the rule it has to
satisfy.
