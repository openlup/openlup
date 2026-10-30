# M14 hosted OIDC recipe receipt

Status: development-preview parcel 10I; working hosted receipt PASS;
both control reads were accepted before their DCO commits. Fresh repair-tree
review and canonical verification remain required. The queue freeze is lifted.
Code base:
`6700bcfe7cc63eca7d2bbbd466ebf1daa364ef88`.
Instruction freshness was independently refreshed before handoff at
`4fd84bfead64e11f76e0555117fe072d39807182`; the added evidence-routing guidance
and documentation owner update were read. No catch-up merge was performed.

## Outcome and boundary

Produce a hosted OIDC recipe receipt (single synthetic issuer on a test VM)
through the existing recipe-conformance runner and real Keycloak witnesses.
Use a digest-pinned issuer behind public ACME TLS, synthetic realms and clients,
and ordinary certificate verification. This is neither production qualification
nor an SLO. Other hosted recipes, managed transfer, release and adoption remain
outside this parcel.

The active supervisor is the single writer in the assigned task worktree.
The programme grant permits implementation, synthetic deployments on the named
test VM, owned cleanup, DCO as Bart Roszkowski <dev@openlup.com>, two fresh FULL
reviews, verification and neutral PR submission. Merge authority applies only
after all gates and the current queue freeze are satisfied. Account, IAM,
network settings, resource deletion, production, release dispatch and publishing
remain outside authority. No S3 or RDS use is required. Private VM coordination,
exact endpoints and credentials stay outside public text. A stabilized runner
declaration/control read is required before DCO. Delivery follows the current
programme landing order.

## Acceptance and sufficient proof

Reuse real authorization-code/PKCE login, session/logout, refresh and expiry,
customer/operator separation, pending/revoked membership denial, signing-key
rotation and retired-key refusal after actual wall-clock cache expiry. A hosted
target declaration must refuse unsafe or undeclared issuers before connection;
credentials must retain the existing external owner-only file boundary and
sanitized diagnostics. The receipt must distinguish the hosted issuer from its
disposable supporting database and report pending unrelated sections honestly.
Measure wall time, actions, interventions and owned cleanup/absence, including
test realms, containers, listeners and certificate material.

Run cheap policy/catalogue/inventory/neutrality/structural and redacted secret
checks and focused refusal tests before the VM run. Run strict all-project
typecheck and load-gated lint before the first read. Snapshot unsigned WIP while
that read is pending; DCO, two new fresh-context FULL reviewers and load-gated
canonical verification follow acceptance. Keep VM ports 80/443 only for the run.

## Execution and self-retro

Initial tracked inventory, measured before adding this record: 6,698 files /
50,657,380 bytes. No package exports, dependencies or budget increases planned.
Native review has not started; no cycles, findings, PR or receipt exists.
Simplicity pre-check: pass a declared hosted issuer to the existing lifecycle
witness instead of adding another verifier, authentication mechanism or provider
registry. Main risks are targeting the wrong issuer, leaking credentials,
incomplete teardown and attributing local proof to a hosted endpoint.
Self-retro: initial source inspection identified the local-only target boundary
before any VM mutation; no further process change is justified yet.

Pinned Node 24.21.0/npm 11.19.0 installation and package builds passed.
Cheap publication policy (two obligations, zero unanswered), 6,699-path inventory,
neutrality, structural checks, whitespace and redacted candidate/history scans
passed. The direct no-network declaration discriminator passed 18 assertions;
the focused recipe suite passed 12/12 in 3.41 seconds after a measured 300-second
machine-slot wait. Realm-cleanup tests cover successful and partial provisioning
while preserving an unrelated realm. No native review cycle has been consumed.
The assigned VM's initial 80/443 listeners were absent. Ubuntu-signed Docker,
Compose and Certbot packages were installed with downloaded package checksums
recorded privately. The exact recipe Keycloak digest was pulled, and public ACME
certificate issuance succeeded. Port 80 was freed immediately afterward;
443 has not yet been started. No S3, RDS, IAM, Node or AWS CLI operation occurred.

Execution regroup before a third launch: two invocations stopped before Node
started, first because sudo refused the selected process group, then because
the SSH user could not enter the root-owned fixture directory. The gap is the
hosted witness, owned by this parcel; no lifecycle result or native review cycle
was produced. Root cause: split execution identity across Docker, source,
credentials and browser cache. The smaller route is one existing root invocation
with an absolute script path, matching fixture ownership and no account changes.
The next discriminator is an actual runner receipt, rather than another group
configuration. Lesson: split fixture ownership → choose one execution UID before
launching the witness. The VM source copy remains frozen at its earlier task-note
revision; this regroup changes only this record.

The approved hosted topology uses the VM for the conformance runner as well as
the issuer. Official Node 24.21.0 passed its published SHA-256 check; npm is
11.19.0. Docker CE 29.8.2 and Compose were installed from the vendor's signed
repository after replacing the initial distribution packages. These are
provisioning interventions, not native review cycles. The supporting PostgreSQL
and browser are disposable fixtures local to the VM runner, without a managed
database or production-host qualification claim.

The first actual recipe invocation failed in 34.834 seconds; the wrapper
suppressed the underlying stage. Both direct lifecycle diagnostics subsequently
passed, including one with the runner's scrubbed environment. One bounded manual
retry of the unchanged common runner produced `PASS_HOSTED_OIDC`, with `oidc`
and `hostedRecipes["10I"]` PASS and every other hosted section PENDING.
The claim is "hosted OIDC recipe receipt (single synthetic issuer on a test VM)".
Its receipt is `.context/scratch/hosted-oidc-receipt/hosted-oidc-receipt.json`,
SHA-256 `8157b07562d4d6584232ea30e003527e6387d7681c9f095797f0b9aa3f3d5b56`.
Wall time was 350.246 seconds; retired-key refusal followed 314.417 seconds of
actual cache time. Real login/session/logout, refresh/expiry, audience separation,
live membership denial and ordinary TLS chain/hostname verification all passed.
Exact source/package identities, timestamps and declared limits are in the
receipt; provisioning, failed attempts and operator actions are recorded
separately in the private operator-effort evidence.
That separate VM wall measurement is 2,739.812 seconds across 28 SSH actions
and two file copies, including provisioning, diagnostics and cleanup. There
were two pre-Node launch failures, one failed recipe invocation and one manual
recipe retry; neither diagnostic required source changes or human intervention.

The successful invocation and both diagnostics removed their confirmed realms.
The final administrative census found one residual test realm from the failed
attempt. Dedicated issuer-container removal deleted that tmpfs-only state;
there was no durable issuer volume. Final independent absence readback passed
for issuer/support containers, networks, volumes, listeners on 80/443, source,
browser cache, temporary credentials and ACME/certificate files. Shared verified
Docker/Node tooling and OS dependencies remain. The VM ledger releases the
writer slot and both public ports for the next parcel. No S3/RDS use occurred.
Owner resource teardown remains separate.

Strict five-project typecheck passed with zero unresolved edges or consumer
errors. Lint passed with zero errors and 33 existing warnings. Measured Mac
admission waits were 60 seconds for builds, 300 for focused tests, 841 for
typecheck and 60 for lint. No budget was raised. All changed files are outside
package pack inputs; package manifests, exports, lockfiles and production
implementations are unchanged. The VM proof used a frozen source snapshot;
only this record and cleanup-limit prose changed afterward. Two NEW fresh
FULL reviewers, canonical verification, push and PR submission remain pending.
S1 remains active, so ready/enqueue is prohibited after those later gates.

Maintainer read CD-M14-54 (2026-10-30) accepted the exact DCO source tree
`94ec61a35bf79bccc83d587764f9e57d6f2b173e` from HEAD `6700bcfe`, with
computed binary-diff SHA-256
`714162f76bcadd924aafaffb426b318b10513f23d6a912f22c52d997e1b05a05`.
The matching tree was DCO committed as `64c331ef13f78cc697a94f453d196623d36ab8d8`.
This record cites the accepted computed identities without changing the
accepted runner or control bytes.

Native `prepare` refused carry-over after main moved. The required main merge
is conflict-free, with parents `e733ca06040707c91d6fa33418db14543d8bc63c`
and `4fd84bfead64e11f76e0555117fe072d39807182`. Its automatic merge tree
before this task-record note is `04b94bdf971c7f5e751b2f9877595000390484b0`.
No manual hunk was resolved and no separator or other glue was added. The parcel
patch ID excluding this task record is
`a5aca9c5679f17574581f592cc3fbdd03495ea2f` against both the old base and
new main; main's catalogue additions were combined automatically. The merge
preserves the accepted runner/control bytes and changes no claim. Full native
review and full canonical verification remain required.

After the two full PASS reviews of `90c5a847b8da8c23736090cb0a5497aed3624d1a`,
main moved again and native `prepare` refused carry-over because the new base
changed package and lockfile paths. The second required main merge is automatic
and conflict-free, with parents `90c5a847b8da8c23736090cb0a5497aed3624d1a`
and `591a8ec46d3cd74f7047b2a44ea4a50649158690`. Its automatic merge tree
before this note is `421c6dacb5615fc34e0ffe849e9b6f911ce95ea0`. No manual
hunk was resolved or glue added. The parcel patch ID excluding this record is
`a5aca9c5679f17574581f592cc3fbdd03495ea2f` against both bases. Full new-tree
review and canonical verification remain required; the reviewed runner/control
bytes and the bounded claim did not change.

The new-tree review found one material admission gap at cycle 1: a hostname with
a terminal dot could evade the local-name suffix refusal before connection.
One reviewer passed the remaining candidate and integration checks; the other
recorded `hosted-oidc-public-origin-trailing-dot` as open. The smallest repair
rejects terminal-dot hostnames in the existing declaration condition and adds
focused local, private and public-name refusal cases. This changes the runner's
control boundary, so a new computed-identity maintainer read is required before
DCO. The successful VM receipt belongs to the prior source snapshot; the new
line changes admission only and does not alter the accepted hosted lifecycle
path. The initial canonical attempt failed on another parcel's private WIP ref;
the lead archived and removed that ref, and a subsequent redacted full-ref scan
passed before this repair. No other parcel ref was changed by this supervisor.

On the staged repair, the focused recipe suite passed 12/12 in 3.42 seconds;
strict five-project typecheck had zero unresolved edges or consumer errors;
lint had zero errors and 33 existing warnings. Publication policy/docs-update
answered both obligations, neutrality and structural scans passed, and redacted
working-tree and full-ref Gitleaks scans found no leak. The Mac slot wait for
the typecheck/lint sequence was 2,703 seconds because other verifiers ran.
The private load probe was corrected to count actual verifier processes rather
than waiting shell commands; that avoided a local wait deadlock without changing
the repository gate. No native repair commit, new-tree review, canonical PASS,
push or PR is claimed at this read boundary.

Maintainer read CD-M14-63 (2026-10-30) accepted repair tree
`de00072fe1340fd914888c86a80e5f5987dabdbc` from HEAD `cf912f3d`, with computed
binary-diff SHA-256
`d68ddfec46d7a94ce7b02bbc26936080da90248b4b15f11a94e9e58704936f46`.
The exact matching tree was DCO committed as
`a6848f29a950735179860887bbb89c8061efecd9`.
Native prepare then refused carry-over across main's CI changes. The forced
merge parents are `a6848f29a950735179860887bbb89c8061efecd9` and
`8ae51d2923bcc13bb4a9a12da646bbeb8edeb684`; the automatic merge tree before
this note is `0d80f1bb6fce3cd59d6602d39a1d08e89210fcea`. No manual hunk or
union separator was required. The parcel patch ID excluding this record is
`70d2d82a5876a9245c0ee5d75d9c55db7e284f2a` against both bases. Thus the
accepted control bytes are preserved. Current main uses stock PostgreSQL 17 for
canonical pgTAP; the instruction refresh was read separately from the code base.
The freeze is lifted and this parcel is first in the hosted landing order.

Self-retro: check vendor provenance and a single execution UID before installing
or launching a hosted fixture. Ambiguous provisioning can leave unconfirmed
issuer state → require the existing dedicated-container teardown and absence
readback, rather than adding a second remote cleanup mechanism. The initial
failed recipe's precise stage remains unknown; two diagnostic passes and the
unchanged common-runner PASS establish the bounded working receipt, not an SLO.
