# Native-store terms, guards, destination policy and measured test deadline

Status: two registry amendments committed. The destinations policy and renewal
prepare identity are staged for a combined control read. A measured test-timeout
patch is prepared separately and remains unapplied. Native review and canonical
verification remain pending. Original code base:
`2a59da4be321f6413ae384f49e66ae3145f881d4`. Pending-amendment base:
`1d698631c0c9c358d4d57934c19b9b0db62c692b`. Current instruction/reader revision:
`967ca62b6926afb8ddffb2aa41bd8ebd41d578a2` (2026-11-03). Current agent guidance
and the contributor-guide delta were read without integrating main.

## Outcome and boundary

This control change records four registry amendments, the last two pending read, in
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
- Add one exact `client_absorption_policy` block entry for
  `commerce_destinations` to the unbound destinations slot. The future table's
  client foreign key would otherwise leave a referencing table unclassified,
  causing lead absorption to refuse every absorption. Immutable delivery snapshots
  are blocked, like orders, rather than carried or rebound. This approves only
  the statement that the destinations forward will later contain; no SQL is added.


- Append `public.commerce_prepare_subscription_renewal(uuid,uuid,timestamptz)`
  to the unbound renewal-terminal slot's replaced functions with before-hash
  `76578042f03f95f7599fa5fc84b0c720fbc8cb17d4031b0a0be6a5c5ce0019fe`
  and `pg_catalog`. Claim locks the subscription before the operation. Prepare
  locks the operation before the cycle insert's foreign key locks the
  subscription, allowing concurrent workers to deadlock. Later feature SQL will
  replace prepare with the same header and take the subscription lock first.
  This approves the replacement identity only.

A separate test-only change is planned as the fourth commit. Its unapplied
patch gives the merge-group admission-entry-point case in
`scripts/reviewed-batch-forward.test.ts` an explicit 30-second per-case timeout. The callback, assertions, pull-request case deadline and global
configuration remain byte-identical. Measurements and scratch proof follow below.

The first approval was read at tree
`f25158da1bf0371e8c04b90f069f02f33fcb598e` and committed, with its accepted
prose update, as `f45f828d6853349332310e338a5c12f033dd7563`. The second approval
was committed separately as `1d698631c0c9c358d4d57934c19b9b0db62c692b`.
The proposed destinations and renewal-prepare amendments are staged together
above that base. Both earlier commits retain their identities.

Preserve all other registry bytes: existing functions, slot order, the consent
purpose check and three absorption statements, sealing state and feature
bindings. Pin only the corresponding exact production expectations.
The second commit changes only its one registry object, one production
expectation line and this record. The pending staged delta changes G3's one
statement, G7's one replacement object, their production expectations and this
record. The existing catalog
row remains unchanged.
No SQL, checker code, package file, export, manifest, lockfile or workflow changes.
No runtime behavior is added. Package-input delta is 0 B. No changed path is
reachable from the reference adopter's production composition: registry and
tests are repository tooling, and catalog and record are metadata/documentation.

The worker stopped before the first commit for the maintainer read. The first
two amendments were accepted for DCO and committed. This run authorizes the combined
staged registry delta, its checks, the unapplied timeout patch and one stabilized
control-read packet only. No
third commit, native prepare, review, canonical verification, push or integration
is authorized yet. After the read, a later lead instruction will govern commit,
stack integration and two fresh full control reviews. No release, publishing,
settings, credentials, resources or adopter endpoint action is authorized.

## Acceptance, risk and proof

The account-consent slot retains exact equality with the accepted trace slot.
The promoted-draft slot equals the first commit plus precisely one appended
replacement object, in the existing key order. Its raw registry delta must equal
that object alone; its raw test delta must equal the sole production expectation
line. Every slot's function lists stay unique and disjoint; no other slot lists
the new replacement identity. The four target slots stay unbound and the class unsealed.

Use trusted main's `nativeStoreFunctionDefinitions` over all numeric migrations
before the first class slot, retaining the last definition. The line-sum guard's
preimage must match the approved hash. Main's actual registry reader and
`assertCoLocatedForwardApproval` must accept the staged tree. Run the existing
native registry, real-PostgreSQL native catalog and qualified-admission suites,
ast-grep, public typecheck and lint through the focused resource gate. Regenerate
navigation and accept both scoped no-impact answers. Scan the second commit's
diff for private names and secrets. Relax no fixture, assertion or refusal.

The risk is an incorrect identity or unintended approval change. Four direct
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
the second run permitted only its commit and bounded checks. The current run
stops for the combined pending registry amendments and timeout-patch read.

Self-retro: a direct replacement-list append reuses the existing preimage and
refusal witnesses without changing a checker. The second run's largest focused admission wait was 31.69 seconds; its longest
stage was lint at 30.60 seconds. Historical first-run costs remain 395.60 seconds
for release history and a maximum 121.89-second admission wait. Refreshing the
two existing documentation answers was sufficient; no new process is justified.

## Third amendment proof before the combined update

The destinations slot starts with no data statements. The exact proposed entry is:

```sql
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('commerce_destinations', 'block', 'A delivery destination is an immutable delivery snapshot bound to the order or subscription that used it; never carry or rebind it when absorbing a lead.');
```

Trusted main's reader accepts this data-only addition to the unbound, unsealed
class. The statement uses exactly the same table, columns and INSERT VALUES
shape as all three existing account-consent absorption statements, and its
single-statement parse preserves its bytes. Main's 136 migration SQL files contain
no destination-table name, and no slot on main or the third-amendment base has a
policy statement for it. The earlier broad scratch scan tried the statement
splitter on unrelated historical SQL and refused an unsupported input; absence
was then proved directly from source bytes without changing a reader or criterion.

The third delta must equal the base plus exactly this one G3 statement. Only one
exact production expectation line is added; no synthetic fixture or refusal is
relaxed. The checks run under the supplied focused resource gate: the full direct
`scripts/*.test.ts` set and every initial registry-reader suite, including the
native and batch-forward real-PostgreSQL catalog proofs. Five initial registry
suites are covered by the full script set; eight database suites run separately.
Ast-grep, public typecheck, lint, trusted-main registry and co-located admission
probes, and staged private-name/Gitleaks scans remain required. Results and the
exact tree/diff identities are recorded in the control-read packet. The admission
probe compares this assigned base and staged tree using current main's code;
this branch has not integrated main and claims no hosted admission.

Third-amendment results on official Node 24.21.0 / npm 11.19.0: all 13 initial
registry-reader suites passed again (2,035 cases, zero failures or skips). All
58 direct script test files were selected with two workers and no file-exclusion
list: 2,889 cases passed, zero failed and one was skipped. The existing opt-in
catalog-policy overlap concurrency proof lacked its database URL and bundle;
no result is claimed for that proof. The eight database registry suites passed
332 cases with zero skips. Across the 66 distinct files, 3,221 cases passed.

Ast-grep, package build prerequisites, all five public typecheck projects and
lint passed. Trusted main's registry reader and `assertCoLocatedForwardApproval`
accept the staged data relative to the assigned base and the cumulative fork.
The raw registry equals the base plus exactly the one destination policy string;
the test equals the base plus exactly one production expectation line. The
source-only delta was captured with:

```sh
git diff --cached --binary --no-ext-diff --no-textconv --no-color 1d698631c0c9c358d4d57934c19b9b0db62c692b -- config/reviewed-platform-forwards.json scripts/reviewed-native-store-forward.test.ts
```

The final read packet binds the tree, full diff, exact hash command, current
policy, reader and staged private-name/Gitleaks checks after this evidence-only
record update. No package input, SQL, checker, catalog, manifest or workflow
changes: package-input delta remains 0 B. No third commit or native review was
made; the source head remains the third-amendment base.

Third-run retro: the full scripts stage took 590.14 seconds; focused admission
for it took 587.91 seconds, including one wait-window timeout. No test failed or
was rerun. Direct source-byte absence was sufficient after the broad scratch
splitter scan refused unrelated historical input; no new checker was needed.

## Pending renewal-prepare and timeout evidence

Trusted main's own `nativeStoreFunctionDefinitions` was exported to ignored
scratch and independently scanned all 91 numeric pre-class migrations in order.
The final definition of the renewal prepare signature is in
`db/platform/migrations/20260815120000_automatic_subscription_renewal.sql` and
hashes to `76578042f03f95f7599fa5fc84b0c720fbc8cb17d4031b0a0be6a5c5ce0019fe`.
Before this append, the signature appears in no slot on main or the candidate.
The renewal-terminal slot is unbound, the class unsealed and trusted main's
reader accepts the entry. All slots retain unique, disjoint function lists.
Only that slot's production replacement-signature expectation changes.

The timeout patch is held in ignored scratch for the same control read. The
unmodified merge-group case measured 4.53079525 seconds in isolation and
5.6134835 seconds in the earlier full 58-file scripts run with two workers,
a loaded/isolated ratio of 1.238962. Four times the slower observation is
22.453934 seconds, rounded up to the existing 30-second per-case value.
The contributor guide's deterministic-fixture section requires measured,
bounded integration deadlines. This file uses numeric third-argument deadlines,
and the stock-evidence replay and connected-store transfer PostgreSQL suites
use 30 seconds. Per-case registration isolates the deadline to merge-group.

A disposable copy of the earlier G3 staged source accepted the patch and passed the full
batch-forward file, 691 cases with zero failures or skips in 276.29 seconds.
The patch was reversed and the copy removed. The actual test source remains
unchanged. After acceptance and a lead instruction, the third commit will contain
the combined staged G3 and G7 registry amendments. A fourth commit will apply
exactly the accepted timeout patch and update this record with its application
and measurements. Both commits require DCO sign-off.

The current rerun selects the full direct script set immediately after the
scanner resource gate admits it, with one full set on the host. Registry database
suites and static checks use focused admission. Trusted-main reader and
co-located approval probes, policy/navigation and staged private-name/Gitleaks
scans bind the resulting tree. Results follow.

Current combined-source results on official Node 24.21.0 / npm 11.19.0:
all 13 initial registry suites passed (2,035 cases, zero failures or skips).
The full 58-file direct scripts set passed 2,889 cases, with zero failures
and 1 existing opt-in skip. That skip is the catalog-policy overlap concurrency
witness, which requires its supplied database URL and bundle. The eight database
registry suites passed 332 cases, with zero failures or skips. Across
66 distinct files, 3,221 cases passed. The scanner lane admitted the full set
before it started immediately, with two workers and the exclusion list unset.
Its wall time was 467.26 seconds after 664.13 seconds of admission wait.

Ast-grep, build prerequisites, all five public typecheck projects and lint passed.
Lint reported zero errors and the existing 33 warnings. Trusted main's reader
and co-located approval probe accept the combined registry. The full source
checks ran on tree `e15dd5b819be6d05c3853f05df61f0106d7d778d`.
This final result-prose update changes only the task record. Final policy,
reader, private-name and Gitleaks results bind the staged read candidate.
The policy's initial index-reconciliation refusal was resolved by staging the
intended files, then its two delta-bound no-impact fingerprints were refreshed.
No generated tracked output was added.

The raw-byte proof constructs the complete registry and test from the second
commit plus exactly G3's statement and G7's object and expected signature. The
combined source-delta command remains:

```sh
git diff --cached --binary --no-ext-diff --no-textconv --no-color 1d698631c0c9c358d4d57934c19b9b0db62c692b -- config/reviewed-platform-forwards.json scripts/reviewed-native-store-forward.test.ts
```

Current-run retro: the scanner gate initially counted a waiting shell's planned
scanner invocation as active work. Its descendants were only the gate and sleep;
that wrapper exited before admission. Other workers' processes were left alone.
The existing registry assertions and trusted-main helper prove both additions
directly, keeping the timeout proposal separate until control-read acceptance.


## Documentation impact

The [closed native store forward owner](../DATA_AND_MIGRATIONS.md#closed-native-store-forwards)
still separates inventory approval, pinned search paths, immutable issued
bindings and later feature SQL. Its generic exact-statement list rules remain
correct. These amendments claim no implemented API, installation or support.
Compatibility posture and contributor check instructions remain accurate.

<!-- openlup-task-doc-impact {"unit":"configuration","doc":"docs/platform/CANONICAL_CONTRACTS.md","anchor":"#compatibility-posture","digest":"sha256-8bbb2bdf78bf1794322f4836058186b56b818355916e624b682c9c907d6feaae","reason":"One created reader, two pre-class function replacement identities and one exact absorption-policy block statement are added to four unbound slots. No SQL, issued binding, package export, runtime capability or compatibility promise changes. Compatibility posture and the data owner's separate inventory and feature-approval rules remain accurate."} -->
<!-- openlup-task-doc-impact {"unit":"tooling","doc":"CONTRIBUTING.md","anchor":"#development-preview-checks","digest":"sha256-37194aaeb036258b7b64e8bc88dd423a272f0e46e994e91b073b239b3c632a84","reason":"Only exact production function and data-statement expectations gain the four registry entries and their pins. The separately proposed timeout remains unapplied. Synthetic fixtures, refusals, prefix, absence, purpose-check and prior absorption assertions remain intact. No reader grammar, test selection, command or verification requirement changes; contributor check instructions remain correct."} -->
