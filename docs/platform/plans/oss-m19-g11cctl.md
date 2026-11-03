# Retained renewal purchase terms reader approval

Status: maintainer read accepted on 2026-11-03 for tree f25158da1bf0371e8c04b90f069f02f33fcb598e; native review and canonical verification are pending.
Code base and freshly fetched policy revision:
`2a59da4be321f6413ae384f49e66ae3145f881d4`.

## Outcome and boundary

Append exactly one created-function entry to the unbound account-consent slot
in `config/reviewed-platform-forwards.json`:
`public.subscription_renewal_purchase_terms(uuid)` with
`searchPath: pg_catalog, pg_temp`, after its three existing created functions.
The account-consent slot will later create a narrow, owner-only reader of
retained renewal purchase terms. Renewals can then price their second delivery,
graduation and free-shipping threshold from retained terms without direct table
access. This change approves the signature only; it implements no reader or
runtime behavior.

Preserve the slot's other created functions, purpose check and three absorption
statements, every other slot, sealing state and feature binding. No rename,
SQL, checker code, package file, export, manifest, lockfile or workflow change
is in scope. Package input delta is 0 B. No changed path is reachable from the
reference adopter's production composition: the registry and test are repository
tooling, and the catalog and task record are publication metadata/documentation.

The assigned worker was authorized to edit, check and stage this bounded candidate
and prepare the private maintainer-read packet, then stopped before committing.
The maintainer read is now accepted for DCO sign-off and this commit only. Two
independent fresh full native control reviews, canonical verification and external
delivery remain pending under later authority. No merge, release, publishing,
settings, credentials, resource or adopter endpoint action is authorized in this run.

## Acceptance, risk and proof

The complete resulting slot must equal the supplied trace's exact slot. The
complete registry must equal the base plus only that appended entry. Confirm the
name is absent everywhere on the fetched main; use main's actual registry and
admission readers on the staged candidate, and verify created-function identity
uniqueness and disjointness from the slot's other lists. The class stays unsealed
and the slot unbound. Update only the existing exact production created-function
expectation, preserving every refusal and immutable-prefix witness.

Run registry-reader suites, ast-grep, public typecheck and lint through the
focused resource gate. Add this record's catalog row, regenerate navigation with
`npm run oss:published-tree -- --policy --docs-update`, assess reported owner
impact and scan the staged diff for private names. Record exact would-be tree,
staged diff hash, full diff and check outcomes in the private read packet.
Focused proof establishes control-data compatibility, not executed feature SQL,
native review, hosted admission, installation or release qualification.

Risk is an incorrect approval identity or an unintended registry change. The
smallest adequate solution is one closed-list entry and the existing exact
production expectation; no new grammar, exception, abstraction or harness is
needed. Future feature work retains its own SQL, security, pricing, replay and
real-database behavior proof.

## Run evidence

Node 24.21.0 and npm 11.19.0. All 13 existing registry-reader suites passed:
2,035 cases, zero failures and zero skips. Each file ran through the supplied
focused resource gate with the existing root Vitest wrapper. Ast-grep, package
build prerequisites, all five public typecheck projects and lint passed; lint
reported zero errors and 33 warnings in unchanged files. No retry was needed.

Trusted main's actual registry and co-located approval readers accept the staged
candidate. The helper proves exact complete trace-slot equality, complete registry
equality apart from the one ordered append, name absence across main's tracked
text and all 91 numeric pre-class forwards, unique/disjoint function lists,
unsealed/unbound state and 0 B package-input delta. The test source differs only
by the requested production expectation. This is reader compatibility, not an
actual hosted admission or feature execution claim.

Policy/docs-update passes both scoped no-impact answers and produces no tracked
navigation delta. The added public text and staged patch pass private-name and
Gitleaks scans. The private read packet carries the final tree, exact staged-diff
hash command, complete diff, helper source and command/result ledger.
No counted native review, repair cycle, receipt, expiry or canonical verification
stamp exists. Commit, native review, full verification and external delivery
remain outside this stop.

Self-retro: the unchanged release-history suite took 395.60 seconds; the largest
focused admission wait was 121.89 seconds. A direct data append reused the existing
production equality and class-refusal witnesses without a new checker or harness.
No further process change is justified.

## Documentation impact

The [closed native store forward owner](../DATA_AND_MIGRATIONS.md#closed-native-store-forwards)
still describes separate inventory approval, pinned search paths, immutable
issued bindings and later feature SQL. It does not enumerate this slot's created
functions. The approval adds no implemented API, installation or support claim.
The compatibility posture and contributor check instructions remain accurate.

<!-- openlup-task-doc-impact {"unit":"configuration","doc":"docs/platform/CANONICAL_CONTRACTS.md","anchor":"#compatibility-posture","digest":"sha256-05c5c897444e94116ce3a36a8bed6fd297af757ae325442b840e5302bed707e5","reason":"Only one created-function signature with its pinned search path is appended to the unbound account-consent slot. No SQL, issued binding, package export, runtime capability or compatibility promise changes. The compatibility posture still distinguishes approval data from implemented and installed behavior; the data owner's generic closed-list and separate feature-approval rules remain accurate."} -->
<!-- openlup-task-doc-impact {"unit":"tooling","doc":"CONTRIBUTING.md","anchor":"#development-preview-checks","digest":"sha256-c96b74b83a6bfed1634aea5e499eb49799fbb472bed7e7a896615c6c05b0a535","reason":"Only the existing exact production created-function expectation for the account-consent slot gains the one approved reader and pinned search path. Every synthetic fixture, refusal, preimage, absence, purpose-check and absorption-statement assertion remains intact. No reader grammar, test selection, command or verification requirement changes, so the development-preview check instructions remain correct."} -->
