# Guest checkout contact client

Status: implemented and focused-proof complete; stabilized API read pending
(development preview).

## Outcome, scope and authority

Provide `createPostgresContactClientRegistrar` through the existing identity
entry. Exact lowercase lookup of trimmed email finds or inserts one unlinked
contact under concurrency, without exposing an email-uniqueness violation.
Optional profile defaults initialize new contacts and refresh existing unlinked
contacts; empty inputs never erase existing defaults. Optional journey facts
update `metadata.checkout`, preserving other metadata. Absent journey input
preserves opaque metadata exactly. An UPDATE predicate of `principal_id IS NULL`
protects a concurrently linked row. Linked rows retain all columns and versions.
The factory never assigns a principal; the existing mailbox challenge does that.

Worktree `oss-m19-st-reg`, branch `codex/oss-m19-st-reg`. Base and fetched policy
revision: `4d78e855cf8bbd57704f9503cd7bae28f96453a5`; origin remained unchanged at
handoff. The supervised task permits local implementation, focused proof, a
private API read packet and unsigned local WIP refs. This run stops before DCO
commit, native review, canonical verification, push, PR, merge or release.
Later DCO identity: Bart Roszkowski <dev@openlup.com>. Subsequent programme
delivery still follows the applicable maintainer grant and required gates.

The smallest adequate implementation reuses the role-free transaction lane,
unique email index and existing runtime capabilities. The permitted INSERT
columns create the contact, followed by a guarded profile/metadata UPDATE in
the same transaction. No new SQL asset, function, table, grant, package subpath,
dependency or AccountLinkStore/reconcile change is needed. The new factory is
opt-in by explicit host call; existing consumer implementations are unchanged.

The package leaf precedes the starter purchase contribution. Destination,
consent, full-intent journey-key replay and provider auth provisioning stay with
their host writers. Starter code and the complete purchase browser journey are
outside this change. The private record owns reference-adopter citations and
the detailed rule map; public explanations and characterization stay neutral.

## Acceptance and sufficient evidence

The real PostgreSQL suite uses the complete packaged qualified-v2 history and
an actual non-superuser, non-owner runtime with inherited service capabilities.
Its 15 passing cases discriminate creation/replay, 24 concurrent calls across
pools including a stronger default isolation, case/whitespace normalization,
plus/dot isolation, canonical lookup with padded peers, unlinked default/journey
refresh, blank-value preservation, opaque metadata preservation, byte-identical
linked rows, concurrent sign-in protection, preconnection invalid input,
commit-failure rollback, native draft/challenge/owned account-order continuation,
erased-shell refusal, fresh-address history isolation and erasure concurrency.
The last suite passed in 8.27 seconds; its named container and volume were removed.

All 42 identity unit files, every direct identity-barrel test consumer, package
boundary and import-map/outcome-projection checks passed: 3,802 existing cases,
with no skips. The final new suite adds 15 cases. Existing implementations and
imports remain unchanged; a final focused rerun covers the later optional-
metadata correction. No full canonical verification or percentage-coverage
claim is made by these focused runs.

Strict public typecheck passed all five projects with zero unresolved edges or
consumer errors. Builds, API snapshots, structural checks, neutrality and lint
passed. Full lint had zero errors and 66 existing-file warnings; final focused
lint of the changed source/test also passed. Secret and private-reference scans
cover the final candidate before the read snapshot.

Publication policy reports two obligations: the identity explanation is updated;
the test-owner no-impact trailer awaits the eventual non-merge DCO commit.
The new suite uses existing discovery, container infrastructure and packaged
migrations, changing no test command, selector or global setup. The private
packet carries the exact digest and proposed reason. No commit is manufactured
before the required API read to settle that obligation.

## Measured package and risks

Real npm packs on the official toolchain compare exact main with this candidate.
Main: 2,439,455 B packed, 1,952,891 B code, 11,467,472 B unpacked, 3,024 files.
Candidate: 2,443,357 B packed, 1,956,169 B code, 11,481,886 B unpacked, 3,027 files.
Delta: +3,902 B packed, +3,278 B code, +14,414 B unpacked, +3 files. All existing
caps pass. The assumed landing position is current main plus this leaf, before
the starter purchase row, with no additional unmerged predecessors assumed.
Remeasure if the actual landing position changes. No cap or budget is changed.

Host admission, requester quota and validated input precede the call. Internal
client/created/linked facts grant no account access; created/linked must never
reach a browser and found/created receive the same guest response. An unverified
address may name an existing client, but its linked profile remains untouched.
Host-owned retention covers unpurchased contacts and opaque journey metadata;
the existing privacy policy requires an explicit disposition for populated
metadata. A receipt-bound shell refuses, while its freed address starts a fresh
client with no erased history. No erased-address suppression lookup is added.
The separate legacy account-link lookup can still diagnose padded-row ambiguity;
the existing exact-match challenge continuation is proved to remain usable.

## Measured per-case deadline

A predecessor's hosted full-root shard reached 10,726 ms on a PostgreSQL case
that measured 2,759.601 ms locally, a 3.886794× observed ratio; see the
[price-read measurement](oss-m19-st-qa.md#execution-evidence). One focused run
of this suite on Node 24.21.0/npm 11.19.0, one Vitest worker and real PostgreSQL
passed all 15 unchanged cases in 7.84 seconds. The table records each case;
scaled hosted values are estimates, not hosted measurements of this suite.

The required explicit 24-call cross-pool race deadline uses the existing third
argument convention. Its 45.220417-ms local cost × 3.886793779 = 175.762 ms estimated
hosted cost; approximately 4× headroom, as used by the existing heavy PostgreSQL
transfer and price-reader witnesses, gives 703.050 ms. The explicit 30,000-ms
deadline is max(703.050 ms, the existing 30,000-ms coverage floor), preserving
the coverage budget while using the existing PostgreSQL deadline value instead
of an arbitrary larger value. No other case exceeds 5,000 ms locally or an
estimated 5,000 ms, half the ordinary default. Their deadlines stay unchanged.
The optional duration manifest's 1.5× factor weighs whole-file pins; this
workflow supplies no manifest, so the explicit per-case argument is sufficient.
Global deadlines and retry: 0 are unchanged. This timeout-only edit changes no
assertion, fixture or production behavior; the measurement is not rerun.

| Case | Local ms | Scaled hosted estimate ms | Explicit deadline ms |
| --- | ---: | ---: | ---: |
| Creation / provenance | 13.364 | 51.943 | — |
| 24-call cross-pool race | 45.220 | 175.762 | 30,000 |
| Case / whitespace / aliases | 8.006 | 31.118 | — |
| Linked-row byte and version equality | 11.987 | 46.589 | — |
| Unlinked profile / journey refresh | 10.124 | 39.350 | — |
| Previously blank defaults | 3.653 | 14.200 | — |
| Absent-journey opaque metadata | 4.484 | 17.429 | — |
| Concurrent challenge redemption | 19.686 | 76.514 | — |
| Invalid input before connection | 0.286 | 1.113 | — |
| Canonical peer absent | 19.514 | 75.846 | — |
| Canonical peer present | 16.379 | 63.662 | — |
| Deferred commit rollback | 5.790 | 22.504 | — |
| Native draft / owned-account continuation | 9.887 | 38.428 | — |
| Erased shell / freed address | 26.452 | 102.812 | — |
| Concurrent erasure | 26.058 | 101.281 | — |

## Self-retro

Source and retained identity data resolved two initially inconsistent
requirements before delivery. Guest defaults and bookkeeping then followed the
explicitly approved scope. Source inspection found that concatenating an empty
JSON object could mutate opaque legacy metadata; a minimal absence guard and
real-PostgreSQL witness closed that defect. Focused admission waiting dominated
wall time; recorded evidence avoided repeating unaffected consumer checks after
the final isolated fix. No process/control change or automatic successor is added.
