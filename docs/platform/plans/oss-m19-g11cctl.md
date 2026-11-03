# Retained renewal terms reader and order line-sum guard approvals

Status: both inventory amendments accepted for DCO on 2026-11-03; native review
and canonical verification remain pending. Code base and freshly checked policy
revision: `2a59da4be321f6413ae384f49e66ae3145f881d4`.

## Outcome and boundary

This control change records two approvals in
`config/reviewed-platform-forwards.json`:

- Append `public.subscription_renewal_purchase_terms(uuid)` to the unbound
  account-consent slot's created functions with `pg_catalog, pg_temp`, after its
  three existing entries. The future narrow, owner-only reader exposes retained
  terms so renewals can price their second delivery, graduation and free-shipping
  threshold without direct table access. This approves the signature only.
- Append `public.commerce_order_assert_line_sum()` to the unbound promoted-draft
  slot's replaced functions, after its two existing entries, with before-hash
  `403236204ab35f1776bb1d43a0c9878872fc1547874772b7634b0216b8d837d4`
  and `public, pg_catalog`. Later feature SQL will replace the pre-class guard
  with the same header so its conservation check counts shipping adjustments.
  This approves the replacement identity only.

The first approval was read at tree
`f25158da1bf0371e8c04b90f069f02f33fcb598e` and committed, with its accepted
prose update, as `f45f828d6853349332310e338a5c12f033dd7563`. The second approval
is a separate commit above it; the first commit is not amended.

Preserve all other registry bytes: existing functions, slot order, the consent
purpose check and three absorption statements, sealing state and feature
bindings. Update only the two corresponding exact production expectations.
The second commit changes only its one registry object, one production
expectation line and this record. The existing catalog row remains unchanged.
No SQL, checker code, package file, export, manifest, lockfile or workflow changes.
No runtime behavior is added. Package-input delta is 0 B. No changed path is
reachable from the reference adopter's production composition: registry and
tests are repository tooling, and catalog and record are metadata/documentation.

The worker stopped before the first commit for the maintainer read. Both
amendments are now accepted for DCO; this step authorizes the second local commit
and its stated focused proof. Native prepare, review, canonical verification,
push and main integration are excluded. The row waits to stack on its
predecessor's frozen head before full review. No merge, release, publishing,
settings, credentials, resources or adopter endpoint action is authorized.

## Acceptance, risk and proof

The account-consent slot retains exact equality with the accepted trace slot.
The promoted-draft slot equals the first commit plus precisely one appended
replacement object, in the existing key order. Its raw registry delta must equal
that object alone; its raw test delta must equal the sole production expectation
line. Every slot's function lists stay unique and disjoint; no other slot lists
the new replacement identity. Both target slots stay unbound and class unsealed.

Use trusted main's `nativeStoreFunctionDefinitions` over all numeric migrations
before the first class slot, retaining the last definition. The line-sum guard's
preimage must match the approved hash. Main's actual registry reader and
`assertCoLocatedForwardApproval` must accept the staged tree. Run the existing
native registry, real-PostgreSQL native catalog and qualified-admission suites,
ast-grep, public typecheck and lint through the focused resource gate. Regenerate
navigation and accept both scoped no-impact answers. Scan the second commit's
diff for private names and secrets. Relax no fixture, assertion or refusal.

The risk is an incorrect identity or unintended approval change. Two direct
closed-list appends and existing exact production assertions are the smallest
adequate solution. No new parser, exception, abstraction or permanent harness is
needed. Future SQL retains its own header, conservation, pricing, security,
replay and real-database behavior proof. Focused compatibility is not hosted
admission, feature execution, installation or release qualification.

## Evidence history

The first amendment passed all 13 registry-reader suites: 2,035 cases, zero
failures or skips, on Node 24.21.0 and npm 11.19.0. Ast-grep, all five public
typecheck projects, lint, policy/navigation, private-name and Gitleaks scans
passed. Its trusted-main reader confirmed the exact trace slot and 0 B package
input delta. These results describe that earlier candidate, not the combined one.

The second amendment's independent preimage scan used trusted main's own helper
exported to ignored scratch. Across the complete 91-file numeric pre-class
prefix, its last guard definition is in
`db/platform/migrations/20260810180000_payment_settlement_rail.sql` and hashes to
`403236204ab35f1776bb1d43a0c9878872fc1547874772b7634b0216b8d837d4`.
Before the append, no slot listed that signature in any function list.
The second amendment passed the requested native registry (210 cases), real
PostgreSQL native catalog (126) and qualified-admission (24) suites: 360 cases,
zero failures or skips. Each ran after its own supplied focused resource gate.
Ast-grep, all five public typecheck projects and lint passed; lint retained
33 warnings in unchanged files and zero errors. No test assertion was rerun.

Trusted main's reader accepts the combined registry and its
`assertCoLocatedForwardApproval` accepts the staged tree relative to actual main
and to the first commit. The probe checks raw registry bytes and test source,
all slots' unique/disjoint lists, the signature's sole placement, both unbound
slots, unsealed class and unchanged package inputs (0 B).

Delta proof used this command, plus the probe's raw-byte equality assertions:

```sh
git diff --cached f45f828d6853349332310e338a5c12f033dd7563 -- config/reviewed-platform-forwards.json scripts/reviewed-native-store-forward.test.ts
```

It shows only the one appended replacement object (five added registry lines)
and one added production expectation line. The committed counterpart is
`git diff f45f828d6853349332310e338a5c12f033dd7563 HEAD -- config/reviewed-platform-forwards.json scripts/reviewed-native-store-forward.test.ts`.
No other registry or test byte changes.

The combined delta initially required fresh documentation-impact fingerprints;
both existing answers were refreshed for that source delta. Policy/docs-update
then passed both scoped reasons with no generated tracked change. Final checks
bind the staged candidate after this evidence update; private-name and secret
scans cover the second commit's diff.

No counted native review, repair cycle, receipt, expiry or canonical verification
stamp exists. The previously accepted first-commit stop remains historical;
this run permits only the second commit and its bounded focused checks.

Self-retro: a direct replacement-list append reuses the existing preimage and
refusal witnesses without changing a checker. The second run's largest focused admission wait was 31.69 seconds; its longest
stage was lint at 30.60 seconds. Historical first-run costs remain 395.60 seconds
for release history and a maximum 121.89-second admission wait. Refreshing the
two existing documentation answers was sufficient; no new process is justified.

## Documentation impact

The [closed native store forward owner](../DATA_AND_MIGRATIONS.md#closed-native-store-forwards)
still separates inventory approval, pinned search paths, immutable issued
bindings and later feature SQL. It does not enumerate either changed function
list. Neither approval claims an implemented API, installation or support.
Compatibility posture and contributor check instructions remain accurate.

<!-- openlup-task-doc-impact {"unit":"configuration","doc":"docs/platform/CANONICAL_CONTRACTS.md","anchor":"#compatibility-posture","digest":"sha256-b426913bcfe57d2e9f3b322e510694a0214bfca4e25e052a2f627f99cd0503f3","reason":"One created reader and one pre-class guard replacement are appended to two unbound slots, with exact pinned search paths and the replacement preimage. No SQL, issued binding, package export, runtime capability or compatibility promise changes. Compatibility posture and the data owner's separate inventory and feature-approval rules remain accurate."} -->
<!-- openlup-task-doc-impact {"unit":"tooling","doc":"CONTRIBUTING.md","anchor":"#development-preview-checks","digest":"sha256-5201070f6d9ece2a8cd8fad26c53c2e43558e1d0470ffba577bc855fabdcf23d","reason":"Only the exact production created-function and replaced-function expectations gain the approved identities, search paths and preimage. All synthetic fixtures, refusals, prefix, absence, purpose-check and absorption assertions remain intact. No reader grammar, test selection, command or verification requirement changes; contributor check instructions remain correct."} -->
