# M14 hosted Node/OCI recipe receipt

Status: development-preview parcel 10H, hosted Node/OCI working receipt PASS;
all three control reads accepted and exact repair source DCO-committed;
cycle-one full review and canonical verification pending.
Code/review base and current policy pin, checked independently:
`4fd84bfead64e11f76e0555117fe072d39807182`.

## Outcome, authority and boundary

Produce a **hosted Node/OCI recipe receipt (single synthetic VM)** through the
same recipe runner and `runSelfhostHost` witnesses. Bind immutable application
images to exact archived source and execute them by digest without registry
publication. Observe HTTP, browser UI and state readback over ordinary public
TLS; durable immediate and scheduled work, filesystem storage, captured email,
restart, admitted-job drain and A→B→A rollback. The Netlify/PaaS candidate stays
`PENDING`, owner `10H-paas`, reason `access not provided`; no rejection is inferred.
This is no production qualification, availability SLO or whole-M14 completion.

The active supervisor is the single writer in this assigned worktree. The
owner's delegated programme authority permits implementation, synthetic VM
containers/deployments, test-owned PostgreSQL 16, TLS certificates and cleanup,
then gated DCO as Bart Roszkowski <dev@openlup.com>, two fresh FULL reviews,
verification, draft PR and receipt-readiness. The programme merge grant remains
subject to current gates and freeze. No ready/enqueue while S1 freeze is active.
No RDS, IAM/account/settings, resource deletion, production, release dispatch,
npm publication, new dependency or provider mechanism is included.

## Acceptance, risk and proof

Use only the assigned VM namespace and the released public ports; reuse shared
Docker, Node 24.21.0 and AWS CLI. Append the private VM ledger before access.
Copy an exact unsigned WIP Git archive, run npm ci there and use a test-owned
PG16 container. Extend existing fixed witness inputs only as needed for public
TLS and namespaced Linux execution. Refuse undeclared targets, unsafe external
input files, mutable image references and insecure TLS before workload writes.
Keep credentials, certificates, exact target identities and raw errors private;
public receipts carry neutral target labels and a declared neutral region.

Measure evaluation against 900 seconds, pre-provisioned deployment against
1800 seconds and host swap against 3600 seconds. Record actual boundaries,
wall time, operator actions, failures, interventions and provisioning exclusions;
never substitute a successful retry's time for total effort. Verify containers,
images, listeners, certificate/key material and owned files absent, and release
80/443 with an independent final ledger readback. Owner resource teardown remains
separate from test-owned cleanup.

Cheap publication/catalogue, neutrality, structural and redacted secret checks
precede hosted work. Strict all-project typecheck and full lint precede the
first stabilized control/API read. No DCO before read acceptance. After acceptance,
commit, obtain two new full native reviews and run Mac load-gated canonical
verification with S1 priority, then submit a neutral draft PR and stop at the
freeze boundary. No new budgets, exceptions or suppressions.

## Execution and self-retro

Baseline before adding files: 6,699 tracked files / 50,703,630 bytes. No package
pack input, manifest, lockfile, export or budget change is planned. The assigned
branch began clean at the recorded base. Native review cycles: zero.
Simplicity pre-check: reuse the existing host witness and native Node HTTP
runtime seam for TLS; a new deployment service, proxy dependency, registry or
second lifecycle suite is unnecessary. Primary risks are leaking test endpoints,
misattributing local fixture results to hosted TLS, and leaving public listeners
or certificate material after failure. Completion evidence and a short self-retro
will be appended before the required read stop.

Working-proof regroup: first launch raced the completed database preparation
and refused its missing declaration before creating a receipt. The next launch
admitted that declaration but Git refused source observation because the
sudo-root worker was inspecting an archive owned by the unprivileged installer.
No application container was launched in either attempt. The two startup gaps
share split provisioning/execution ownership. Keep the existing runner controls:
finish setup first, make only this parcel's source root-owned, and enter its
private directory inside the single sudo invocation. No Git trust exception,
account/group change or runner bypass. The next discriminator is the unchanged
same-runner lifecycle with actual TLS UI/readback. Lesson: split provisioning
and execution identity → align owned files and one execution identity first.


Hosted proof on 2026-10-30: the unchanged archived source WIP
`0382ff27f95c783454bdcf6c7eaaddbb4412cd4c`, tree
`8e2eee22d31eae51e8385318f8e4690bf0dcff5e`, returned `PASS_HOSTED_NODE`.
Both `nodeHosts` and `hostedRecipes["10H"]` are PASS; other hosted sections stay
pending. Source and compiled package bytes were checked before/after the run.
The separate setup called the existing restricted installer against a test-owned
TLS PG16 container using the profile's pinned image; no RDS was used. Both A/B
application images were built on the VM from the bundled exact source and
launched by their content-addressed SHA-256 image IDs without a registry push.
Ordinary Node and Chromium trust verified the public ACME certificate/name for
five UI/state readbacks. Four durable events yielded four captured deliveries,
zero duplicates; restart, admitted-callback drain, filesystem persistence and
A→B→A rollback all passed. Witness wall: 16.863 s; common-runner SSH action:
29.588 s. Receipt SHA-256:
`6eedab7309c7c73282ecdc26be8561898dfb96c18af901320c58ec043de2a108`.
Evidence: `.context/scratch/hosted-node-receipt/hosted-node-receipt.json`.

Measured operator evaluation: 417.869 s against 900 s, from first VM preflight
through the passing receipt, including image/dependency/browser caching, ACME,
PG setup and failed launches. Platform implementation, preceding Mac checks and
owner access/resource provisioning are excluded. Pre-provisioned deployment:
141.231 s against 1800 s, from the first invocation through full success,
including both failures, diagnosis/regroup and ownership correction. Same-VM
host swap: 4.085 s against 3600 s, from admitted A drain through B and rollback A;
this is code/host-process replacement on one VM, not physical VM migration.
Operator wall through independent cleanup readback: 555.761 s; 19 SSH actions
and four copies, no human intervention or automatic retry. A certificate-copy
glob also failed after issuance; a privileged path lookup reused that certificate.
All failures remain in private evidence rather than being excluded from timing.
Details: `.context/scratch/hosted-node-receipt/operator-effort.json`.

Fixture cleanup passed for roles/events, host containers, A/B images and state.
Operator cleanup then removed its PG16 container/tmpfs, support image references,
source/build/browser/archive files, external declaration and all ACME account,
certificate/key files. An independent second SSH readback proved zero namespaced
containers/networks/volumes, absent application/support images and owned files,
and no listeners on 80/443. The private ledger records PASS and releases both
public ports. Shared base tooling remains for concurrent parcels; owner AWS
resource teardown remains separate. No credential/key material was copied to
the Mac. Netlify/PaaS remains PENDING, `10H-paas`, `access not provided`.

Pre-read proof: pinned npm ci, workspace build, strict five-project typecheck
(0 unresolved edges/errors), full lint (0 errors, 33 existing warnings), policy
with docs regeneration, 6,700-path inventory, neutrality, structural rules,
whitespace and redacted secret scan passed. Focused tests passed 11/11 selected;
the unchanged local catalogue/PG case was unselected, with actual PG16 installation
and host execution observed in the VM proof. The initial typecheck ran before
workspace builds and failed on missing compiled edges; after the required build,
strict typecheck passed. One local build began at a sampled one-minute load of
8.96 before the threshold was acted on; the later lint used the corrected
load/process gate (60 s wait, admission load 4.80/5.64). Canonical verification
has not run and remains mandatory after read and review.

Self-retro: two startup failures exposed split setup/execution identity rather
than a missing host mechanism. Aligning only this parcel's owned files with one
root worker resolved it without a trust exception or account change. Sequencing
setup completion before invocation and checking the numeric load before launch
would have avoided the premature attempts. Reuse of native runtime TLS and the
existing lifecycle witnesses kept the change outside production package code,
SQL, dependencies, exports and budgets. Native cycles remain zero; no DCO,
reviewer request, push, PR, receipt or queue action has occurred. Stop for the
stabilized control read, then follow the remaining authorized delivery gates;
S1 freeze is still active.

At the pre-read freshness boundary, `origin/main` is
`591a8ec46d3cd74f7047b2a44ea4a50649158690`; root instructions, contribution,
AI policy and security files are unchanged from the starting policy pin.
The tested source still has package set 0.32.0; no current installed-package or
0.33.0 host proof is claimed. Main's package preparation is not merged into this
candidate merely for freshness. A later refused carry-over follows the existing
forced-integration route. The private control state still says S1 freeze ACTIVE.

The generated synthetic database declaration was
stored as a mode-600 external file inside the owned VM namespace, rather than
the standard external hosted-input directory. It and the generated password
were removed with namespace teardown; no account credential was copied or
included in the image/receipt. CD-M14-59 accepted this disclosed path deviation.

CD-M14-59 accepted initial candidate tree
`4e73ab81535bc1656a3bcd2c9e90ed90bdc39f92` and binary diff SHA-256
`e3279a178d67c35ece8e9478a136a97b7ccf542d9e2da490c7fa97c32308d883`
against `4fd84bfe`, with one required repair: admit declared public HTTPS DNS
origins without making the synthetic VM's DNS service a platform requirement.
The origin must have a DNS hostname rather than an IP literal, no userinfo,
non-root path, query or fragment, and no port except the HTTPS default or 443.
Special-use suffixes `.invalid`, `.test`, `.example`, `.localhost`, `.local`
and bare `localhost` refuse. The receipt records only the HTTPS scheme and
public-DNS class. The synthetic VM's already exercised origin remains accepted;
the host lifecycle path and witness inputs are unchanged, so no VM rerun is
required. The narrowed delta has focused success/refusal checks and needs its
own exact-tree read before sign-off. After S1, this parcel lands after 10I,
10O and 10R; the applicable forced-integration and additive-union rules apply.

Repair checks on the staged delta passed: publication policy with regenerated
documentation (one obligation, none unanswered), inventory and neutrality,
structural/syntax/whitespace checks, strict five-project typecheck (zero
unresolved edges and consumer errors), full lint (zero errors, 33 existing
warnings), and 11 selected focused recipe cases (one unchanged local PG
catalogue case unselected). The new assertions distinguish accepted synthetic
DNS and explicit 443 from IP literals, reserved names, userinfo, non-root
paths, queries, fragments and non-443 ports. No VM rerun is needed because
only admission and receipt metadata changed; the exercised origin still passes
the new predicate. The final redacted staged-tree secret scan and delta
identities are attached to the second read packet. Native cycles remain zero.
Self-retro for this bounded repair: typecheck and lint waited 180 and 661
seconds for the shared Mac slot; the repair introduced no new mechanism.


CD-M14-60 accepted the bounded origin delta. Computed evidence independently
matches accepted tree `8b1dfb0e40db48884478bcd83e20b6bdeb942390` and
`git diff --binary 4e73ab81 8b1dfb0e` SHA-256
`10664c626f143a32e46e3376d4ea2ae5075cfa72ea8e9decfeaa7f44f4090503`.
The first DCO commit, `a05de338ec1d4c555143d0ed05d6ab9ecf8bdb17`, has exactly
that tree. These are computed identities, not a claim of personal diff reading.
The earlier CD-M14-59 acceptance and disclosed input-path disposition remain
recorded above. S1 freeze is lifted; delivery still holds at a draft PR because
this parcel is fourth after 10I, 10O and 10R. The lead resumes queue delivery
after 10R merges.

The first native `prepare` refused carry-over against current main before any
session/report was admitted. Necessary CD-M14-30 recovery is a conflict-free
main merge with parents `a05de338ec1d4c555143d0ed05d6ab9ecf8bdb17` and
`9ad1534aa321b5c9c493b7a710538168f8f18292`. The automatic tree before this note
is `70b1d4e7d085faee40c60b28101e241276974673`. The parcel patch-id excluding
this task record is `c10acc2f1bc708f8d7eaab93732ccac2c9291ed8` both against
old base `4fd84bfe` and against new main `9ad1534a`. The catalogue merged
mechanically; there are no manual/union hunks or glue lines. Only this task
record is added to the automatic merge. The imported package preparation and
pgTAP planning text create no new hosted execution claim; the working VM
receipt remains tied to its exact earlier source and package set. Full current
source review and canonical verification remain required. Native cycles zero.


Current integration checks passed: npm ci, strict typecheck (zero unresolved
edges/errors), policy/docs regeneration, inventory, neutrality, structural
rules, whitespace, redacted secret scan and full lint (zero errors). Lint's
66 warnings included a temporary materialized copy of the already scanned
staged tree; that owned copy was removed, retaining its tar and scan identity.
The source's prior 33 warnings are unchanged. The integration lint gate waited
1,922 seconds for another canonical run. Self-retro: retain the exact staged
scan as an archive after scanning so later source traversal sees one checkout;
this follows the existing local-verification review lesson. No runtime,
control or acceptance change was made during that wait.


Cycle-zero full native review bound to head
`a2b643f89575520143f719e011a6a50902431bcb`, tree
`e7630f91944c39f618b22b67fc1d5dbee789d370`, base `9ad1534a`.
Two new independent fresh FULL contexts completed and both returned FAIL;
reports and execution observations are retained in private task evidence and
recorded through the native interface. Open material cards are `HNR-A1` and
`M14-HOST-EMPTY-USERINFO`. Native verification refused missing PASS coverage.
There is one completed native candidate evaluation and no repair-cycle charge
yet. No continuation, canonical verify, push, PR or queue action occurred.

`HNR-A1` demonstrates that admitted root-slash origins become double-slash
request paths at the existing witness, and actual runtime routing returns 404.
`M14-HOST-EMPTY-USERINFO` demonstrates that URL parsing removes empty userinfo
syntax before username/password truthiness checks, violating the declared
refusal. The unsigned repair rejects raw authority delimiters, then returns the
canonical URL origin to the unchanged witness. Existing admission regressions
now assert canonical route consumption for root/default-port forms and refuse
both empty-userinfo forms. Runtime guidance explains both operations. The
original hosted origin is already canonical, so its executed lifecycle path is
unchanged; host witness and actor source are unchanged and no VM rerun is
required for this input-only repair. PaaS stays pending by design. The control
change needs a stabilized read before DCO, followed by two NEW FULL reviewers
closing both cards in the same native history and canonical verification.

Self-retro: URL normalization can erase forbidden syntax while leaving accepted
root slashes unsafe for string concatenation. Check raw authority syntax first,
then supply one canonical origin to the existing caller. This resolves both
observed mechanisms without a new host abstraction or dependency.

Unsigned repair proof passed: strict five-project typecheck (zero unresolved
edges/errors), full lint (zero errors, 33 existing warnings), policy/docs
regeneration, inventory/neutrality/structural/whitespace and 11 selected focused
cases (one unchanged PG catalogue case unselected). The repair lint gate waited
781 seconds. The exact staged tree is redacted-secret-scanned before each WIP
ref. Both native finding cards remain open pending the required control read,
DCO and two new fresh FULL reviews. The existing actor/host blobs and VM cleanup
remain unchanged; no repeat hosted run or external write occurred.


CD-M14-61 accepted the cycle-zero repair. Computed evidence matches tree
`8f3d997c071a618bf4f29df458d12d4cd8469429` and the binary delta from
`e7630f91944c39f618b22b67fc1d5dbee789d370`, SHA-256
`e0ae67feeeb2bb71198bd50e558670d439f6b5e41a7996ccdb76d831e7429d35`.
DCO commit `fad0030be95a846c80065420f8426eeb21cdbb3d` has exactly the
accepted repair tree. These identities are computed evidence. Both cards stay
open until the two new full reviews close them; no continuation was requested.

Cycle-one `prepare` first refused carry-over after main advanced through its
stock-PostgreSQL shadow lane. Necessary CD-M14-30 integration has parents
`fad0030be95a846c80065420f8426eeb21cdbb3d` and
`78af32e40ce939ad55f6f8631217ef186795a3a4`; its automatic tree is
`addf1ec427ed5ee84dd56d18d5f77196ff246f2d` before this task note.
The parcel patch-id excluding this record is
`fc483aef2e001b42b20bb0aa257e98af39d35add` against both old base
`9ad1534a` and new main `78af32e4`. Contribution text and catalogue merged
mechanically, with no manual/union hunks or glue. Only this record changes
from the automatic merge. Current instruction freshness was checked at the new
main pin; the shadow lane's contribution instructions were read, and no
host/identity/receipt control imported from main changes this parcel's claims.
The shared heavy gate now serializes strict typecheck, lint and canonical
verification. Delivery still stops at a neutral draft PR for fourth landing.

The attempted duplicate pre-review checks remained queued for two 3,000-second
shared-gate windows (reported waits 3,006 and 3,005 seconds, claimed by earlier
parcels); no heavy stage started. Only this parcel's waiting process was stopped.
The owned repair source/tests/runtime guidance are byte-identical to accepted
`8f3d997c`; only this task record differs from its mechanical main merge.
Its already executed strict typecheck, lint and regression results remain the
pre-review evidence for those bytes. This is not full verification of the
integration: two new full reviews and the complete current canonical command
remain mandatory. Self-retro: do not place source-unchanged review behind a
duplicate broad check; preserve the existing proof and spend the shared slot
on the required post-review canonical gate. No control or proof gate is waived.


The lead resumed final integration after the three hosted predecessors landed.
The earlier unsigned proposed tree `09e43e6525ea52b55668c0415b9276b275135ffb`
was confirmed preserved by WIP commit `1f078dad2663813c767ed169f0c87ecf580e06a9`
before aborting that pending merge. No branch rewrite or ref deletion occurred.
Current merge parents are `86eb361f0fc7c73479f32e3bd1220c66b1742209` and
`18e1c9d3e1be45c6668923b71b21c7ef2317dc9a`; the resolved tree before this
note is `ed64d92c7388c93e6a9b73e742e726d430df9c21`.
CD-M14-74 covers the shared target list/usage, verbatim per-target early-return
admission, refusal-label union, original execution blocks and isolated worker
selection, single success-status check and catalogue union. The identical
network import is retained once and main's filesystem import is retained.
Runtime guidance inserts the owned Node paragraphs verbatim before main's RDS
replacement of the preexisting paragraph; Node tests are appended verbatim to
main's tests. No refusal predicate, host witness, claim or dependency changes.

CD-M14-70 zero-context patch-ids against old main `78af32e4` and incoming main
`18e1c9d3` are equal respectively for contribution guidance
`20972cb760f175e4e13b68ba21217f9d0f1ae83e`, runtime guidance
`f266589fee4d5cf28c7a3eb5367361a26fc766a5`, actor
`e87726d70695e3601ecc0ba3e2b9ed5857dab7e7`, recipe tests
`90e9eded9e8951958a29f46a642926ba86e3f985` and host witness
`c524172faae7c2a2f1b57d3a84d56004da609acd`. Parsed catalogue net entries are
also equal: exactly this task record added as `public-output`, none removed.
Runner hunks and computed identities are preserved in private integration
scratch. This evidence is recorded before the final review, as required by
CD-M14-67; later mechanical-merge evidence belongs only in scratch and the PR.

The pre-review follow-up is test-only under CD-M14-39: retain all prior
assertions, add Node to the existing cross-target refusal matrix and add public
and localhost trailing-dot origin refusals under CD-M14-63. No new fixture
privilege, setup seam or production behavior. Netlify/PaaS remains PENDING by
design, owner `10H-paas`, reason `access not provided`. The current grant now
permits final verification, neutral PR, readiness, receipt and queue after PASS;
the prior fourth-landing hold is satisfied. No hosted VM rerun is claimed.
Self-retro: moving shared-runner integration → wait for predecessor landing,
then preserve each admission branch and prove cross-target isolation once.
