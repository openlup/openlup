# Install support policy

## Bounded preview evidence now; one supported path after stable

There is no full-platform candidate reproduction path yet. A clean checkout of
the exact development-preview revision can run `npm ci`, the public policy,
inventory and typecheck gates, `npm test`, and `npm run build`. Its optional
OCI/Compose artifacts are release-proof inputs, not a supported consumer
entrypoint yet: no public command prepares their immutable image and port
inputs. The bounded checks and build do not start or prove a database,
migrations, scheduler, API, checkout, mutations or subscriptions, and must not
be presented as evidence for those capabilities.

There is also an **opt-in disposable local subscription reference** with a
separate owned Supabase setup, captured payment and mailbox, and a selected
Node server profile. Its [evaluation instructions](../docs/platform/SUBSCRIPTION_REFERENCE.md)
can demonstrate one recurring buyer/account/renewal path when the real HTTP
journey is run and recorded. It does not turn the static default, bounded
checks, or source checkout into a full-platform candidate, supported install,
provider certification or stable self-host promise.

After the `P1-SF` stable-framework gate closes, there will be exactly one
supported path: install the exact platform release/BOM and artifact set named by
a supported stable release, and bring up its shipped composition without
substituting components. A branch, commit, arbitrary source checkout, private
package, or source-preview bridge never becomes supported merely because it
builds.

One supported path is a choice, not a limitation of effort. A project that supports every
deployment shape ends up supporting none of them well, because each variant
multiplies the states a maintainer has to hold in mind before answering a single
question. Fixing the path is what makes "it reproduces" mean something.

## Current status, stated before you rely on it

**No full path is certified, and the platform is not yet declared ready to
self-host.** The repository measures its own progress toward that, and the
measurement is public and partial - see `.github/PUBLICATION_COMPLETENESS.md`
for the commands that decide. Until those report a complete, installable tree,
treat every install as pre-release and expect breakage.

Preview reports may describe a failure in the bounded checks/reference above or
provide useful evidence about an incomplete platform capability. They are not
required to certify reproduction on a full install that does not exist. The
stable support obligation activates only for a release that names a supported
BOM and artifacts; until then no install is supported.

## What is refused, in writing

The following are outside the bounded preview reference today and outside the
supported stable path later. Preview issues that depend on them may be retained
as information or feature requests, but they are not certified platform-install
reproductions. Once stable exists, support issues depending on them may be closed
without investigation; that closure is not a judgement about the setup itself:

- hand-assembled installs that skip the shipped composition;
- substituting a different database engine, or a different major version of the
  shipped one;
- container orchestration, charts, or operators the project does not ship;
- bare-metal or virtual-machine installs assembled by hand;
- managed or serverless hosting variants (the disposable local Supabase
  evaluator above is preview evidence, not a supported hosting variant);
- running only part of the platform, or replacing a shipped component with your
  own;
- an install modified before the problem was observed;
- any path a maintainer cannot reproduce from the exact released artifact set
  once the stable channel exists.

You may absolutely run the platform in any of those ways. The licence permits it
and the project has no objection. What is refused is the **support obligation**,
not the deployment.

## What this means when you file

A preview bug report states which bounded check, reference surface or incomplete
capability it concerns; it does not assert that a full-platform candidate install
exists. A stable support report asserts that it reproduces on the exact supported
release/BOM and composition. If it does not, say so explicitly and describe your
deviation; the report is then treated as information rather than as a defect,
and it may still be useful.

If the missing full-platform path prevents reproduction, say so. That evidence
helps define the future install contract and may be handled as a feature request.

## If you need something else supported

Nothing today buys a supported variant. If a hosted or supported offering exists
later, it will be additive and will be announced in the repository - never by
narrowing what the open path already does. The rule that guarantees that is in
`.github/TIER_POLICY.md`.
