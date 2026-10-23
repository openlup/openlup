# Server Execution Adapters

Status: source-of-truth

`server/adapters` contains execution adapters that implement provider-neutral
domain ports. Adapters translate domain intent into a provider operation or
simulator/noop operation while keeping domain services provider-agnostic.

Provider names in this directory are current implementation choices. New docs
and interfaces should describe the reusable capability first, then name the
current adapter only as an implementation detail. The neutral surface map lives
in [Architecture and extension boundaries](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md).

## Owns
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
