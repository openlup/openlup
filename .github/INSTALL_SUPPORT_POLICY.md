# Install support policy

## One supported installation composition

The supported 1.x composition is the npm starter, PostgreSQL and the qualified
application image, at the exact versions and digest named by the stable
release/BOM. Use the shipped composition without substituting components.
A branch, arbitrary checkout, private package or source-preview snapshot does
not become supported merely because it builds. The
[versioning policy](VERSIONING_AND_EOL.md#support-window) owns the support window.

A source checkout can run bounded policy, inventory, typecheck, test and build
checks; follow [testing](../CONTRIBUTING.md#test-scope-and-diagnostics).
The optional [subscription reference](../docs/platform/SUBSCRIPTION_REFERENCE.md)
is a separate local evaluation profile. Neither route substitutes for the
release’s supported composition or qualifies a live provider.

## Current limits

Publication completeness is measured separately by
[the publication policy](PUBLICATION_COMPLETENESS.md). A complete public tree
alone does not establish installation or provider readiness.

The starter selects sandbox payments. The native rail can compose the reference
card provider through the explicit [host composition](../examples/neutral-store/host/provider-portable.ts),
with the complete database catalogue and host-owned configuration. The native
[payment schema descriptor](../packages/platform/src/payments/schemaCapabilities.ts)
supports the prepared store and payment-method setup; real-payment, method-setup
and card-replacement actions remain unconfigured in this starter.
Native payment-provider support and its limits are listed in the [reader limits](../packages/core/docs/guide/reference/limits.md).
The supplied portable composition covers the reference card provider only.
Offline PostgreSQL witnesses do not establish live-provider qualification.

The [public outcome projection](../docs/platform/OUTCOME_PROJECTION.md) is
generated from existing public package instruments. It is partial: witness
source is not an executed result, and the package instruments do not enumerate
every composed-store outcome. Partial, missing or unresolved evidence blocks
the affected claim. A generated package-set BOM binds artifact identities; it
does not establish installation, publication, provenance or support evidence.
See [distribution evidence](../docs/platform/DISTRIBUTION_EVIDENCE.md).

Added 2026-11-14: a separate blocking exact-set qualification job now follows
publication in the [registry workflow](workflows/registry-tutorial.yml).
It installs the exact npm set into the source-tag starter through the trusted
extractor, commits and uses its lock, verifies npm signatures/provenance against
the package release tags and source commit, then typechecks, builds and runs
application and development-loop tests. Older starter sources are explicitly
labelled reconstructed. An invisible or unattested set fails qualification.
The receipt is retained as one workflow artifact for 90 days; it is not a
release asset or a support certificate. The tutorial is blocking for its own
workflow run; PR admission is unchanged. See [distribution evidence](../docs/platform/DISTRIBUTION_EVIDENCE.md#exact-published-set-qualification)
for the exact boundary and manual requalification entry. This bounded proof
does not establish full installation, provider certification or stable support.

Before application-image publication, qualification also loads the BOM-bound OCI
archive, verifies its loaded manifest and configuration identities, and runs the
starter's lifecycle installation on the mirrored PostgreSQL 16 composition.
The existing sandbox purchase journey exercises that image; selected-row
restore/readback reuses the installed recovery witness on the same installation.
The receipt references the completed adjacent-set and schema-upgrade evidence
without rerunning it. Results and durations are retained for 90 days. This is
bounded preview evidence, not whole-store recovery or certification. A
first-party demo store supplies separate adoption evidence; neither activates
supported installation or stable maintenance.

The starter host binds native store actions against a local demonstration
PostgreSQL database. Without `publicOrigin`, it accepts only
`127.0.0.1:<listening-port>` and `localhost:<listening-port>` as Host authorities;
with `publicOrigin`, it accepts exactly that origin's canonical Host authority.
Configuration health does not establish a live store. The [image quickstart](../deploy/neutral-store/README.md) is limited to local
image build and rollback; its local A → B → A run passed. Public hosting is not
established; the binder stays application-owned.

The native account readers need explicit host sources for saved addresses,
billing profiles, payment/delivery preferences, account events and private-profile
views. A missing section refuses `host_binding_required`, rather than returning
an empty success. Complete consent choices and grants remain unavailable;
newsletter read/withdrawal is available, but a saved grant without evaluator
evidence refuses `host_binding_required`. Historical order detail without
captured money refuses `native_account_order_money_unavailable`; summaries retain
recorded total/currency and the line reader retains recorded amounts. Paid
provisional activation is read through its owned order companion, with no
subscription association invented before activation completes. See the
[native account boundary](../docs/platform/PLATFORM_PACKAGE_REFERENCE.md#native-account-persistence-reads).

The default sandbox selection and the explicit provider host composition have
separate configuration requirements. Support for the named installation does
not certify an application’s live provider setup or production readiness.

No hosting account or resource is supplied. Root `ui-*` counts remain shrink-only
reference-source debt. New neutral presentation is constrained to system fonts;
the root reference's font choices are not an inherited starter requirement.

## What is refused, in writing

The following are outside the supported installation. Reports depending on them
may be retained as information or feature requests, or closed without
investigation; that closure is not a judgement about the setup itself:

- hand-assembled installs that skip the shipped composition;
- substituting a different database engine, or a different major version of the
  shipped one;
- container orchestration, charts, or operators the project does not ship;
- bare-metal or virtual-machine installs assembled by hand;
- managed or serverless hosting variants (the disposable local Supabase
  evaluator above is local evidence, not a supported hosting variant);
- running only part of the platform, or replacing a shipped component with your
  own;
- an install modified before the problem was observed;
- any path a maintainer cannot reproduce from the exact released artifact set.

You may absolutely run the platform in any of those ways. The licence permits it
and the project has no objection. What is refused is the **support obligation**,
not the deployment.

## What this means when you file

A reference bug report states which bounded check or capability it concerns.
A stable support report asserts that it reproduces on the exact supported
release/BOM and composition. If it does not, say so explicitly and describe your
deviation; the report is then treated as information rather than as a defect,
and it may still be useful.

If a missing capability prevents reproduction, say so. That evidence may be
handled as a feature request.

## If you need something else supported

Nothing today buys a supported variant. If a hosted or supported offering exists
later, it will be additive and will be announced in the repository - never by
narrowing what the open path already does. The rule that guarantees that is in
`.github/TIER_POLICY.md`.
