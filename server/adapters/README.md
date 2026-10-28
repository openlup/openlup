# Server Execution Adapters

The accounting managed adapter uses the pinned seller-policy request and claim
wrappers. Host code supplies a seller revision before leasing; unknown or absent
selection refuses without an RPC. Claims retain the wrapper-returned seller and
revision. The unscoped correction wrapper cannot serve order-scoped execution.
Managed order-status reversals use the seller request wrapper with the original
order identity, reason and payload. Its incumbent result is returned unchanged;
new correction eligibility is recorded under the same SQL operation. Replay
identity conflicts surface as the existing typed control conflict.

Status: source-of-truth

`server/adapters` contains execution adapters that implement provider-neutral
domain ports. Adapters translate domain intent into a provider operation or
simulator/noop operation while keeping domain services provider-agnostic.

Provider names in this directory are current implementation choices. New docs
and interfaces should describe the reusable capability first, then name the
current adapter only as an implementation detail. The neutral surface map lives
in [Architecture and extension boundaries](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md).

## Native retained-store transfer preparation

The experimental [source capture](postgres/connectedStoreCapture.ts) and
[target restore](postgres/connectedStoreRestore.ts) compose one finite native
profile prepared for the selected 91-unit qualified-v2 installation with restore
binding. The finite native 91-unit witness passed with two owned installations
and actual restricted runtime media access, using the superuser migration owner
for administrative restore;
the earlier 90-unit attempt stopped during source runtime media confirmation.
The fixed 73-table graph preserves PostgreSQL JSON text, including bigint and
timestamp precision. Capture observes one actual read-only repeatable-read
transaction and checks all non-system user schemas. Unknown nonempty business
tables, including acquisition-private business data, refuse rather than being
omitted. Migration history and the private installation key have separate
target-owned dispositions; neither is copied. The key payload is never read,
hashed or logged by transfer.

The host supplies the actual migration owner connection, a freshly installed
inactive target and its pristine capture, and excludes every source and target
writer. The current profile observes cluster identity through
`pg_control_system` as the existing superuser migration login. It does not
qualify a restricted installer or a managed host. Pristine-row equality is a
precondition inside the target transaction, not independent freshness evidence.
The target rechecks the selected canonical catalogue and ledger. The complete
ledger path, checksum and position sequence follows the selected manifest rather
than a fixed unit count or tail pin. It locks tables,
uses the existing retained client/cycle routines and compatible-row admission,
and restores exactly seven factory settings tables. It preserves deferred
constraints and source alignment policy last. A named historical hold-trigger
correction removes only the fully checked notification inserted in that
transaction when its deterministic source notification was already pruned.
The [explicit connected-native trigger decision](../../docs/platform/plans/oss-m14-existing-store-transfer.md#connected-native-candidate-explicit-trigger-boundary-2026-10-28)
bounds these seven existing triggers separately from the generic transport,
which still refuses every enabled user INSERT trigger. Complete qualified
definitions, functions and roles are checked after table locks and before import;
a known name alone never establishes safe behavior. A retained source event or
pre-existing target obligation is ineligible for compensation.
Every other row delta rolls back. Restore login privileges, trigger definitions,
grants and migration history remain unchanged.

The [filesystem census](filesystem/orderReviewMediaTransferInventory.ts) and
[reader](filesystem/orderReviewMediaTransferReader.ts) include both the actual
`objects/<key>` tree and reconstructible `tmp/<writer-hash>-part` files. They
retain partial uploads, cleanup files and unreferenced bytes for reconciliation;
they do not turn those states into absence or successful delivery. The reader
checks actual owner UID, private modes, single links and file continuity while
hashing bounded bytes. Its `posix-owner-mode` label describes these observed
checks, not additional filesystem ACLs, domain grants or HTTP authorization.

[Filesystem restore](filesystem/orderReviewMediaTransferRestore.ts) prepares
and verifies the complete private tree in a sibling directory, syncs files and
directories, then renames it once into the absent runtime path. An exact
existing tree permits replay; a divergent tree refuses without overwrite. A
killed preparation can leave a private sibling artifact for the host to clean;
it does not publish partial runtime files. Source and target must stay under
the actual host's writer exclusion. Database and filesystem publication are
separate operations: the target remains inactive until both are verified.
Copying does not reset leases, complete cleanup or manufacture domain facts.

The colocated filesystem tests exercise the actual runtime layout and refusal/
replay boundaries. The prepared [connected PostgreSQL witness](../../tests/postgres/connectedStoreTransfer.test.ts)
adds two canonical installations, actual restricted-role media access and an
independent whole-row census; its presence is not a passing installation result.
The [transfer architecture](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery),
[data owner](../../docs/platform/DATA_AND_MIGRATIONS.md#compatible-data-transfer)
and [M14 programme](../../docs/platform/plans/oss-m14-operations-portability.md)
retain the separate managed identity/history, effective access, all-writer
retirement and external-effect recovery obligations. These adapters neither
establish that global fence nor activate a target executor.

## S3 object source preparation

The server-only [S3 source adapter](s3/transferObjectSource.ts) accepts an
explicitly selected SDK client; it constructs no client, credential chain or
environment binding. Imports and construction make no requests. Selected reads
use only ListObjectsV2 and GetObject. A bounded census follows continuation
tokens to an observed terminal page, reads every listed object's bounded bytes,
then repeats the listing. Duplicate keys, repeated/missing cursors, unexpected
common prefixes, byte disagreement and changed listing facts refuse. The host
must still prove full-namespace read authority and hold actual writer exclusion;
two matching principal-visible listings do not establish either fact.

Logical versions hash content and captured returned metadata. They are not ETag,
native version IDs or proof of conditional GET support. The adapter retains
returned user metadata, content type/encoding/disposition/language, cache
control, expiry representations and website redirect without supplying defaults.
Declared missing metadata and observed nonzero tags refuse. Native version
history, ACLs, tags and provider-private metadata remain outside this export;
the selected profile cannot qualify them by omission. The fixed
`authenticated-source-read` classification means only that authenticated GET
succeeded. Bucket policy, public access, RLS and domain access require their
independent owner facts and probes before any complete-store claim.

Only a recognized NoSuchKey means absence. NoSuchBucket and ambiguous 404/NotFound
responses remain unavailable; authentication denial, cancellation, truncated
bytes and version/integrity conflicts retain separate existing error codes.
The prepared [protocol tests](s3/transferObjectSource.test.ts) include actual SDK
deserialization/signing with explicit synthetic credentials and an injected HTTP
handler in a plain Node child so the optional SDK uses its actual Node export
conditions. This exact test carrier is registered in the existing
[public execution inventory](../../scripts/oss-publication-contract.ts);
registration adds no command, job or provider capability. That source is not a passing local-storage or managed-provider
qualification; no live source or credential operation is implied.

## Owns

The reference [migration binding](postgres/migrationRunner.ts) delegates ledger
validation and row reads to `@openlup/platform/migrations`. Its mock witness
models the ledger read separately from each migration transaction. Legacy
bootstrap ownership remains accepted; qualified selection retains its stricter
session-owner and role-graph admission. Qualified inventory shares the
validated ledger observation. The
[migration owner](../../docs/platform/DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories)
defines the shared behavior.

The [native fulfillment observation lifecycle](postgres/fulfillmentObservationLifecycle.ts)
binds the existing G17 lookup/ACK pair to native dispatch SQL. It consumes an
already-verified observation with exact shipment correlation and selected
provider, rechecks current state and preserves retained acceptance on replay.
Caller-owned verification and transaction/login authority remain prerequisites;
this adapter opens no connection, issues no provider request and adds no SQL or
grant. Its [architecture owner](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)
and [restricted-login proof](../../docs/platform/DATA_AND_MIGRATIONS.md#compatibility-lifecycle)
define the scope.

Acquisition case and research evidence PostgreSQL adapters delegate through
thin re-exports to `@openlup/platform/marketing/server/postgres`. Runtime bindings retain
lazy adapter imports after bundle and connection guards, host environment
selection and pool-close ownership. Handler imports from the separate
`@openlup/platform/marketing/server` entry do not load the optional `pg` peer.
Schemas/DTOs use the browser marketing entries; server-only structural command
types preserve the historical adapter's submit/transition signatures. Retired
admission schemas and terminal route factories stay application-owned. SQL text,
argument order, result parsing, role selection, replay and pool handling are
unchanged. Package tests own the adapter assertions; the real PostgreSQL witness
connects through a login granted only `platform_acquisition_runtime` membership.

Commerce returns and native review lifecycle/media adapters delegate to
`@openlup/platform/commerce/server`; the former paths retain factory identity. Returns
forward the principal, owner-bound replay key and unchanged request arguments;
request/approve/reject record intent without receive/restock/refund execution.
Review adapters retain native receipt validation and transactional promotion.
Hosted feedback submit/token-check facades use a separate managed RPC lifecycle:
adopters must supply those RPCs, which native `db/platform` does not provide.
The private filesystem review-media store stays here; M02 blob storage lacks its
private read, inspection, temporary write and promotion operations. Package tests
own the moved adapter assertions; colocated facade tests pin export identity.
The unused root payment webhook normalizer and its 26-case witness have
retired after production-importer checks. The opt-in package implementation and
witness remain. Root payment execution, reconciliation and failure algorithms
also retire in O-P3b-2: existing host factories now use the eleven experimental
vendor-subpath helpers. The factories retain flags, repair capability projection,
payer fallback and localized return translation; SDK construction and simulator
behavior remain host-owned. Existing root diagnostic/producer cases now consume
package factories, mappings and explicit persisted evidence fixtures. The [payment retirement ledger](../../docs/platform/plans/oss-a2-payment-adapters.md#o-p3b-1-unused-root-retirement-2026-10-22)
records the separate root and adopter legs.

The native SKU envelope reader, its mapper and the isolated draft store now
have their package implementation under `packages/platform/src/catalog/`.
The old store paths preserve factory identity through named package exports;
no pool, SQL body, authority error or draft refusal changes. The old native
mapper path was removed because nothing imported it; its implementation now
lives only in the package. The managed envelope keeps its own mapper. No public
helper export or package deep import is introduced. Rich catalog interpretation
and native price-authority
composition stay reference-owned. Sparse catalog units 1/8/58/59/61 are package
projections of existing canonical SQL, not another migration history.


The native bundle read store and query statements are implemented by
`@openlup/platform/catalog`. The former PostgreSQL paths retain named exports;
runtime callers still supply the executor, with no pool or role-switch change.
The native write store, pooled transaction/RPC binding and managed adapters remain
here. Catalog's SQL descriptor projects canonical units 16/19 unchanged; it is not
an installation chain. Real PostgreSQL tests characterize incumbent reads,
write-routine rollback/replay and grants, without mounted or actor-kind parity.

- Provider-specific execution decisions for a named local port.
- Simulator/noop implementations used by hidden preview and local tests.
- Mapping from provider responses back to domain-neutral result objects.

The reference promotion admin adapter supplies the legacy first-subscription
percentage from the existing quote-discount composition to both semantic row
mapping and the pre-update technical-row check. Neither classifier chooses a
default. Reusing the same named reference value preserves the adapter's
system-managed read-only refusal, mirror ownership checks and currency mapping;
no database predicate, query or audit behavior changes.

The reference payment-control store takes verified ingress identity from the
normalized `openlupEvidence.fingerprint` on the first insert. Receipt time and
adapter audit payload do not redefine that identity. On replay it reads the
winning row's `source_evidence.observedAt`; missing durable clock evidence
refuses processing. The selected package ingress applies and post-processes at
that first receipt instant (D11). Existing routes are not automatically moved
to the opt-in ingress. Direct missing-audit tests cover failure diagnosis, alias
activation, saved-method consent and profile alias presentation; the profile's
existing presentation fallback grants no recurring execution authority.

The OMS managed binding delegates RPC translation and neutral query hydration
to `@openlup/platform/commerce/server`. It supplies the existing structural query
capability, column names, identity and provider projections; client construction
and provider evidence remain reference-owned. The mutation client itself is
RPC-only, so order operations need no table capability. Existing control-plane
projection and exact replay/refusal results keep their prior behavior.

Commerce order-draft, runtime-finalize, intent-persistence, resume, cancellation
and reservation-sweep implementations now come from
`@openlup/platform/commerce/server`. These reference paths bind structural clients
to the incumbent frozen schemas, ordered finalize arguments, command response
projection and phone normalizer. Verified subject stamping remains last in the
package store. Table filters, RPC names, argument order, retry bounds and nominal
error identity are preserved. Catalog-admission refusals now remain conflicts
without superseding; stale acquisition terms reach the existing safe compensation
and reprice path. Reservation allocation, provider execution and runtime composition
retain their owners; no second executor is installed.

The physical commerce availability calculation is now supplied once by
`commerce/server`; this adapter retains only the SDK boundary and the provider
predicate. Table read order, local/provider branches and terminal-hold exclusions
are unchanged. Managed reservation allocation remains here, using M06's exported
reservation policy. Its response binding scopes inventory lock failures to
retryable details; lock contention never enters schema fallback or changes the
retry key. Cancellation still delegates to the injected K2b adapter.

## Does Not Own

- Provider HTTP clients, env parsing, signatures, and low-level payload
  verifiers: `server/infra/*`.
- Domain state machines or persistence decisions: `server/domains/*`.
- Route auth/rate-limit/session composition: `server/bff/*` and `api/cron/*`.

## Rules

- Adapters must be injectable and testable without live provider credentials.
- Provider errors must be sanitized before leaving the adapter boundary.
- Live mutations require an adopter-owned explicit gate and release evidence.
  This source directory does not select a provider or activate a capability;
  [Architecture and extension boundaries](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
  owns the public seam.
- The transactional send port and the admin role notification adapter
  read the selected `#email-presentation` import from the root `package.json`.
  The public map selects the neutral example; an adopter can select its own
  presentation in its application manifest without changing these adapters.

The managed client-auth link binding supplies the identity package with the
settings-reading email-trust policy, independently of bundle selection. Before
creating or linking by email, soft provisioning requires automatic confirmation
off and declared email-verifying providers. Unsafe or unavailable settings return
a stable soft-account refusal without a new identity or contact link. Matching
existing links remain replayable. See the [identity migration](../../docs/platform/IDENTITY.md#responsibility-and-composition)
for explicit adopter policy injection and the trust boundary.

M04 B2 delegates invoice and role content/rendering to the
[reference binding](../../src/domains/communications/email/referenceContentBinding.ts).
Invoice accepts optional construction locale (Polish default); EN uses the localized
account route. Default invoice and all role bytes stay identical, including pending
invitation wording. Send guards, processing evidence before invoice send, PDF/key,
uncertainty mapping, notification controls and ledger ordering remain adapter-owned
and unchanged. The private-label inquiry presenter is untouched; generic inquiry
has only a pure presentation binding and no activated sender.

## Capability Map

| Capability | Current adapters | Owns | First docs |
| --- | --- | --- | --- |
| Payment execution and reconciliation | `stripe/`, `tpay/`, `noop_payment/` | Provider execution, webhook normalization, sandbox/noop behavior, and payment-provider evidence mapped back to payment-control contracts. | `../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md`, `../../src/domains/payment/README.md` |
| Fulfillment execution | `dhl/`, `omnipack/`, `noop_shipping/` | Carrier/3PL execution, simulator behavior, and fulfillment-provider evidence mapped back to fulfillment contracts. | `../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md`, `../../src/domains/fulfillment/README.md` |
| Accounting document execution | `fakturownia/`, `accounting/` | Provider invoice/PDF/email/KSeF execution or preview test-provider behavior after accounting policy approval. | `../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md`, `../../docs/platform/DATA_AND_MIGRATIONS.md` |
| Company identity lookup | `mfVat/`, `gusCeidg/`, `ceidg/` | Country/provider-specific lookup enrichment behind the company-identity contract. | `../../docs/platform/RUNTIME_AND_SELF_HOSTING.md`, `../../src/domains/company-identity/README.md` |
| Communications delivery and sync | `resend/`, `noop_newsletter/` | Email/newsletter provider execution, ledgers, delivery timeline, and provider-neutral sync evidence. | `../../docs/platform/CANONICAL_CONTRACTS.md`, `../../src/domains/communications/README.md` |
| Storage/blob | `@openlup/platform/blob`, bound by `server/adapters/supabase/blobStorage.ts` and `server/adapters/vercel/blobStorage.ts` | Blob storage port implementations for hosted and self-host profiles; the reference bindings pass the environment and keep their former import paths. | `../../docs/platform/RUNTIME_AND_SELF_HOSTING.md`, `../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md` |
| Data gateway and migrations | `@openlup/platform/data` and `/migrations`, bound by `supabase/` and `postgres/` | DataGatewayPort and migration-runner implementations for managed backend and direct-Postgres bundles. The bindings supply the Supabase client factory, the process environment, this application's migration catalogue and lock name, and the named role-free lanes. | `../../docs/platform/DATA_AND_MIGRATIONS.md`, `../../docs/platform/RUNTIME_AND_SELF_HOSTING.md` |
| Catalog reads | `supabase/`, `postgres/` | Row-assembled catalog read ports. Both select `primary_sku_id` and the two SKU sellability columns in every projection and leave variant order and primary SKU resolution to the catalog assembler, so no read depends on the order rows arrive in. | `../../src/domains/catalog/README.md` |
| Scheduler/runtime | `@openlup/platform/http`, `/scheduler` and `/job-ledger`, bound by `server/adapters/node/httpRequestAdapter.ts`, `server/adapters/scheduler/jobRegistry.ts`, `server/adapters/postgres/platformJobRunLedger.ts` and `server/adapters/supabase/platformJobRunLedger.ts` | Scheduled job registration/execution and platform runtime seams. The job registry binding names `config/platform-runtime.json` as its default source. | `../../docs/platform/RUNTIME_AND_SELF_HOSTING.md`, `../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md` |
| Auth and identity | `supabase/`, `postgres/operatorInvitations.ts`, `email/adminRoleNotificationPort.ts` | Admin/customer verification and account linking. Direct operator invitations retain the package transaction lane and pending lifecycle. Managed invitations insert active membership immediately, recover duplicate inserts, retain identities on failure and refuse revoked-member reinvitation. Managed verification and removal use actor clients without lifecycle metadata or compensation. Managed mail describes active membership without pending/deadline copy and uses `admin-membership:<principalId>:<role>` for delivery and timeline identity; direct mail retains the invitation-attempt key and deadline. Reference invite/remove runners pass their message catalogue to the package, and the invite runner selects the role-mail locale through the existing input. Notification delivery remains application-owned. | `../../docs/platform/RUNTIME_AND_SELF_HOSTING.md`, `../../docs/platform/CANONICAL_CONTRACTS.md` |
| Simulators/noops | `noop_payment/`, `noop_shipping/`, `noop_newsletter/`, `accounting/` test provider | Deterministic local/preview behavior that proves domain contracts without live provider side effects. | Owning domain README and [Architecture and extension boundaries](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md); adopter configuration is separate deployment evidence. |

## Public navigation and availability

The direct [migration binding](postgres/migrationRunner.ts) delegates to the
package executor and keeps legacy as its default. Explicit qualified selection
adds the reference catalogue, restricted runtime/optional restore principal
bindings, startup transport and [read-only session admission](postgres/qualifiedInstall.ts).
Its 89-unit source plan is not installed or hosted qualification; the
[migration owner](../../docs/platform/DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories)
records its binding shapes and outstanding production proof.

Use [Architecture and extension boundaries](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.

The managed observability event reader projects only `subscription_id` and
`event_type`, filtered on `occurred_at` within the preceding 24 hours and capped
at 2,000 rows. It needs SELECT on those three columns, not event payload access
or direct INSERT. The unbound winback adapter does not establish a runtime
writer requirement. Tests retain the window's old-versus-recent reminder signal.

<!-- openlup-doc-impact {"unit":"adapters","digest":"sha256-a4a68c2cbfabb4d516254adf6c146187a8173fd64f3b4a158ca7a595856918f8","reason":"The reference admin-platform adapter now treats only stored admin and distributor roles as operator roles: null or unknown roles read as non-admin and are not eligible for the admin magic link. Its provider translation, capability boundaries and the rules in this file are unchanged; the role policy is documented in docs/platform/IDENTITY.md."} -->

Identity verification, account linking, admin directory gateways, profile reads and direct session/challenge adapters now delegate to the [identity module](../../docs/platform/IDENTITY.md). The reference bindings retain SDK loading, mail delivery, sender and origin policy. The package accepts structural clients and an explicit JWT loader; the application remains responsible for selecting them.

## Communications package delegation

The communications receipt, capture, newsletter webhook, preference-token and sync
adapters delegate to `@openlup/platform/communications`. Structural clients and
RPC names are unchanged. The managed receipt binding keeps environment parsing,
service-scope construction and fixture cleanup here; only its RPC/store algorithm
moves. The direct receipt binding supplies its existing role-free transaction
lane. Host senders, ACL composition, invitation copy/dedupe/expiry and the shared
communications control-plane adapter stay at their current owners. No provider
SDK or platform-to-outbox package dependency is added. The mail-provider
reference adapters, timeline and send-ledger helpers retain their original
implementation and imports; no vendor adapter is published in the package.

B1 routes every supported injected mail sender through package admission before
its effect. The four reference mail-port changes are guard insertions only;
default selection and the concrete client stay unchanged. The invoice witness
admits its synthetic fixture explicitly and adds raw-injection refusal, preserving
all prior timeline, key, PDF and uncertainty assertions. Neutral intake and admin
ports enforce the same boundary. The Auth API uses the package envelope bridge
to retain maintained transport admission; signature/render/control/send/evidence
order is unchanged. See the [transport contract](../infra/email/README.md#contract)
for alternate-sender composition and the trust boundary.


Native communications adapters re-export the four factories through
[`postgres/communicationsLifecycle.ts`](postgres/communicationsLifecycle.ts).
Each capability uses the existing role-free transaction lane under explicit host
owner authority and refuses unsafe effective browser/PUBLIC/column/inherited ACLs.
Directory requests additionally need a verified active human communications
operator checked in the transaction. Protocol reads and membership effects remain
host-injected; no managed/vendor path is replaced. The
[callable native composition](../runtime/communications/communicationsLifecycleBinding.ts)
adds no process or route activation. [Real-PG proof](../../tests/postgres/communicationsNative.test.ts)
covers durable effects, concurrency, token/ACL refusals and rollback; the
[package guide](../../docs/platform/PLATFORM_PACKAGE_REFERENCE.md#native-communications-operations-development-preview)
defines the bounded consent guarantee and schema prerequisite.

The C-compose [native preference adapter](postgres/communicationPreferences.ts)
uses the packaged native sync store's bounded `registerPreference` operation.
It commits only denied/suppressed state and default-purpose membership work;
there is no provider call or independent executor. A failed work insert rolls
back permission persistence. Signed-token routes select this adapter explicitly;
missing database/binding/provider identity refuses without managed fallback.
Native legacy tester lookup is unavailable, while the managed adapter retains it.

The native promotion read/sweep implementation now belongs to
`@openlup/platform/promotions`; `postgres/promotionClaims.ts` retains its two
named compatibility exports. The host still injects the same query executor.
The package does not add a reservation or claim writer; managed promotion
adapters remain here with their existing read-only/mirror fences. Native query
characterization moves with the store, while real PostgreSQL evidence lives in
`tests/postgres/promotionsNative.test.ts` and uses the complete canonical chain.

## Managed correction recovery

The accounting invoice adapter calls the versioned correction claim and passes
its claimed attempt to both finalizers; a returned refusal is a persistence
error, including a stale or inactive lease. Legacy attempted rows without a
persisted create identity remain visibly unresolved for provider reconciliation.
The test provider's explicit recovery bridge derives correction IDs and numbers
from correctionRef; repeated recovery returns the same receipt and independent
corrections of one order remain distinct. The unchanged legacy vendor method is
not a supported recovery binding. Vendor wire/parent/absence proof belongs to the
separately owned conforming bridge. No live provider is used by these tests.

Managed correction RPC arguments bind by parameter name; the adapter retains the donor object key order.

See the [M09 forward owner](../../docs/platform/DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval) for the registered managed-correction limit, follow-up and finalization semantics.

The native paid-order document facade delegates its unchanged local constructor
SQL to `createPostgresInvoiceStore`, retaining explicit provider metadata,
request key bytes and document reference/status/replay. The zero-tax positions
belong only to this local path. Fiscal invoicing requires frozen host facts;
missing facts never authorize a guessed invoice or consume an owed duty.

The invoice read adapters retain legacy database columns and HTTP/SDK queries.
Their compatibility shim calls the package lineage resolver. The optional native
customer-history projection checks owner/order before its host query and returns
only safe P1 history fields, preserving correction parents, signed totals and
currency. An unavailable native projection returns typed `host_binding_required`;
no raw metadata, signed URL, storage receipt or fiscal parity is inferred.

The operator invoice summary maps persisted failures to the closed invoice
allowlist and omits free-text provider messages, including URLs and credentials.
Unknown historical codes become `unknown`; attempts, retryability and recovery
guidance remain visible.


Managed subscription failure adapters preserve applied-transition attribution.
The cycle adapter extracts the apply result's attempt and sends it unchanged;
the runtime request carries a required nullable field and selects the attributed
RPC arity explicitly. Webhooks read failed/expired business transitions by stored
event and intent, refusing unavailable or conflicting attribution before the
opener. Simulator settlement retains the canonical transition time and attempt.
Current/prepared attempt hints cannot supply this authority. The
[managed replay contract](../../docs/platform/DATA_AND_MIGRATIONS.md#m10-9-attempt-replay-control-fixtures)
owns fresh NULL refusal and the existing-donor host mapping.

The platform control-plane compatibility adapter forwards to
`@openlup/platform/operations/server`. It still accepts the existing structural
SQL executor and operator ID, uses the same fixed routines and preserves
command hashing, row decoding and conflict/error mapping. Native pool/transaction
ownership and managed RPC translation stay with the reference bindings; the
package creates neither a connection nor a provider client on import.
