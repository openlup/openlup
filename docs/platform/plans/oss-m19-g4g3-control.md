# Purchase reservation and destination forward slots

Status: development-preview control; maintainer read accepted for DCO and native review.

Outcome: add the purchase-reservation (G4) and destination (G3) inventories to
the closed native forward class, plus three exact, ordered existing-table
statements for G4 alone. The registry remains unsealed with seven ordered slots.
This second control lands after the main class control and before either feature
forward. It contains no active SQL, feature implementation or package change.

Scope: the reviewed-forward registry and its class-local reader, adjacent inert
fixtures/tests, the data owner's closed-native-store section, publication catalog
rows and this record. Excluded: generic expand-only grammar, other classes,
function bodies, runtime qualification, feature hashes/bindings, gate budgets,
release, publishing, credentials, settings, production and adopter changes.

The coordinator authorized this bounded control through the inventory, table
narrowing and exact-statement decisions supplied to the worker. Foundation
supervises; the worker may edit, stage and run focused checks here. The coordinator
accepted the stabilized read and both scoped documentation-impact reasons for
DCO. The worker may sign, commit and supervise two independent native reviews;
this continuation stops at ready-for-verification. No canonical verification,
push, PR or queue is authorized by this continuation.
Feature owners retain real-PostgreSQL access, behavior and replay proof duties.

Assigned worktree: `oss-m19-g4g3-control`; branch:
`codex/oss-m19-g4g3-control`. Code/stack base and exported `OPENLUP_STACK_BASE`:
`8da87741d1aaac7fdce4daf62936cc2b00ab2f14`, the main control's committed head,
not yet on main. Fetched policy revision:
`09cd599bfef6bff74f4431b0cf7a00ebf80f1e6a` at handoff; applicable instruction
paths are unchanged from the start pin `3887ee7425fd0eddeecd9a8e2ef3e1420bcf640d`.
Main-control repairs may be integrated
when required; the assigned predecessor worktree remains read-only.

Smallest adequate design: a G4-only optional `existingTableStatements` list,
using the existing statement splitter and exact comparison as the data-statement
list does. Keeping the field separate preserves the existing data-only schema.
Validate its ALTER TABLE actions before use, require existing prefix targets,
and consume every listed statement exactly once in list order before the generic
fallback. No new general ALTER TABLE permission is added.

Acceptance: exact paths and eight new signatures/search paths match the supplied
inventories; no replacement or grant-only entry is added. G4's three whole
statements match the supplied writer companions. G3 is design-only: synthetic tables,
RLS, ACLs and four function headers prove lexical admission, not implementation.
Unknown/changed/extra/reordered statements, wrong-slot use, invalid list shapes,
unlisted functions and narrowing of tables outside their own slot must refuse.
Existing suites and issued class data remain unchanged and green. Actual base
and candidate npm packs must show zero added bytes/files.

Risk and proof: exact-match fallthrough could admit a changed ADD action through
the generic classifier; check list-target ALTERs before that fallback. Committed
inert fixtures discriminate this failure and missing/duplicate/order errors.
Run catalog/docs regeneration, focused class and existing-caller suites,
ast-grep, public typecheck and lint under focused resource admission as required.
Check the exact G4 Git blob/hash read-only. Record signature/header limits and
all evidence in the stable read packet. Native review and final verification
remain later gates, with zero reviewers/repair cycles consumed in this run.

Evidence: native-store 173, existing reviewed-forward 691, qualified 24, queue
189 and manifest 19 tests pass (1,096 total). Ast-grep and public five-project
typecheck pass with no diagnostics; lint has zero errors and 33 existing warnings.
Catalog/docs regeneration is structurally clean; the coordinator accepted the two
source-bound no-impact reasons, whose digests are recomputed for the signed tree.
Actual base
and candidate npm packs, including prepack builds, are byte-identical: core
182,871 packed bytes/229 files, outbox 41,407/42, platform 2,104,577/2,840.
All packed/unpacked byte and file deltas are zero. No package inputs changed.

The exact purchase writer blob at `71539d088390817ef27a0ff35617ff02f71a4af6`
matches SHA-256 `fc49ac715d08a8da12f0bb7ac3ae085743c82c628356345fb6e1acfb72196b41`.
Its three table companions, four headers/hashes and remaining DDL match the
inventory, but full lexical admission REFUSES: all six conditional blocks use
`END $$;` and the inherited control requires `END; $$;`. A scratch-only six-
semicolon change passes all 21 statements with synthetic empty-inventory G6/G2
predecessors and the actual base native prefix. This is diagnostic evidence,
not approval of different bytes, real predecessor ordering or runtime behavior.
The coordinator resolved this mismatch on the producer side: the six DO endings
must become `END; $$;`; the accepted control shape stays unchanged. Those six
semicolons, with only removal of the draft comment otherwise, are covered by the
existing feature read without another delta read. The feature owner records its
new whole-file hash in its own task record. This control neither edits that
writer nor claims independent verification of its repaired bytes. No grammar
widening is authorized or made here.

The destination section fixes all four signatures, argument types, defaults,
security attributes and both table definitions. Its synthetic lexical fixture
passes; actual function bodies, file/after-hashes and runtime proof do not exist
in this control. The inherited class pins signatures/search paths, not security
mode, language, defaults, return types, table columns or exact ACL inventory.
Those fixed design details retain feature-file binding/review duties. The money
stream confirmed in writing that the four destination signatures are final for
this control, with no replaced functions or triggers; both commerce_destinations
and commerce_destination_bindings enable RLS. New account-history and outbox
effects stay inside subscription_change_shipping_destination's body and add no
object. Its SQL bytes remain provisional until race, replay and transfer proofs
finish. A later closed-list change requires another small control; it does not
alter this candidate's inventory or broaden this control's proof claim.

Accepted read identity: staged tree
`71896eb256d961da5c9909a630bb95058930c42e`, binary staged-diff SHA-256
`4993507a53cb4bbc015607a9d545f6f9ebab5e2186c741bc5d56f792a28a7501`, eight paths.
This continuation changes only this record's prose before signing; the accepted
implementation, registry, fixtures and owner documentation are unchanged. The
G3 confirmation closes the read's sole condition. The post-prose staged identity
and native review evidence remain in the existing external read/task evidence.

Next boundary: two fresh independent native reviews, then ready-for-verification;
no canonical verify, push, PR or queue. The stack predecessor is still unlanded.
Main-control delivery and feature-specific proof remain required. At this
pre-review snapshot there are zero reviewers, repair cycles, receipt or expiry.

Self-retro: one stale five-row production expectation needed the two new rows;
the final refusal cases now isolate each table privilege instead of failing at
an earlier RLS statement. Keeping the existing DO refusal and a scratch witness
avoided a second control-grammar change outside the bounded exact-table design.
