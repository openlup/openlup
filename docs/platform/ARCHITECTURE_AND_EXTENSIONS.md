# Architecture And Extension Boundaries

Status: development-preview contract. This defines the intended public
boundary; it is not evidence that every seam is stable, packaged, or activated.

## Platform and adopter ownership

OpenLup is one platform monorepo containing platform code, official modules, a
reference application, conformance material, and release tools. An adopter is a
separate application. It owns its brand, presentation, catalogue, local market
policy, provider composition, and business-specific integrations.

The reference application demonstrates a neutral platform composition. It is
not a default adopter application and does not transfer ownership of adopter
assets or business policy to the platform.

An adopted package owns its engine algorithm and public contract. Consume that
engine through an exact authenticated `@openlup/*` npm artifact. An application
agent must not autonomously patch, fork, vendor, monkey-patch, shadow its imports
or restore a copied implementation as an alternative engine. Use only the
installed package's declared public exports, not internal source or `dist` paths.
Dependency identity alone does not establish which engine actually serves work.

Application handlers, policies, ports, composition, host bindings and compatible
native adapters remain ordinary application code. They need no ownership record
per function or upstream release. Historical OpenLup origin alone does not freeze
unpackaged application source. One engine algorithm owner can serve multiple hosts
under the existing admission, fencing and retirement contract; a second competing
state writer is not an extension seam.

## Runtime boundaries

The reference application's renewal execution, readback registry, recovery
guidance, setup routes, channel list and activation bind through the experimental
[reference-support exports](../../packages/platform/README.md#reference-support-surface).
SDK and HTTP client construction, environment and mode flags, and the simulator
remain host-owned. The prepared-attempt binding imports and re-exports the
package's `ProviderAttemptPreDispatchError`, preserving one class identity for
nominal no-charge retry and release checks.

The shared root [webhook HTTP helper](../../server/_lib/payment/webhookSignature.ts)
retains raw-body reading, HMAC verification, timing-safe equality and body-size
limits for existing callers. Its unused provider-specific signature verifier
has retired; provider verification remains inside the opt-in package adapters.
The six generic helper cases remain in the root witness.


Payments uses the existing bundle composer’s optional named binder. The host
injects a scoped truth port and cleanup through `createPaymentServices`; schema
or capability absence refuses selection. There is one executor per runtime unit,
no package environment/driver discovery and no additional scheduler. The reference
verified ingress remains explicit and default-off. Its adapter fingerprint is
stored on first receipt; replay application and hooks reuse the first durable
instant, including when the provider timestamp moves later (D11).

The reference payment status and verify routes serve the checkout's original
order/intent/client identity; a verify response requests readback and cannot
mark payment paid. The opt-in reference store mounts the repair view; exact
guardrail exemptions keep operator clients out of customer pages. The status
BFF keeps its continuation credential and private response schema while the
package checks stored owner/attempt and a second canonical read. Hosts supply
rail handoff capabilities; the reference binding preserves its existing mapping.
Method collection is a port-only seam: native setup is visibly unsupported
without a host implementation, and collection alone never charges or redeems an
obligation. Provider callbacks, token handling and customer/subscription ownership
stay in the host. Payments imports the shared HTTP and BFF entries as types only;
its host-supplied responder preserves the existing envelope and request context.
No default profile or route is activated.

The opt-in reference catalog routes consume explicit per-locale snapshots with
resolved media, detail facts and links. Their browser graph uses contracts
entries and local validators; promotion clients and dialogs no longer enter the
promotions server barrel. The subscription entry formats minor money with the
currency exponent in normal and fallback paths and refuses an unknown exponent.
No implicit catalog route is added to the shipped static or subscription profile.

The reference selected-basket builder maps the neutral acquisition quote's
top-level terms into a separate persisted expectation. It reuses the existing
SSR-safe draft codec and pricing-policy admission predicate, keeping amount,
currency, signed token, policy and second-delivery promise bound independently.
Reloaded totals alone cannot authorize navigation: the selected fresh signed
quote and explicit matching terms consent are required. An accepted basket edit
clears both expectation and terms while retaining customer facts. The reference
transport/storage scope leaves incumbent endpoints, caches and draft keys intact.
Read-only lifecycle observations do not grant publication or withdrawal authority.

The shipping server entry owns address lookup and authenticated address-book
handlers and row helpers. Reference bindings retain geographic, source and tax
validation, conflict identity and the canonical country default; hosts supply
these explicitly. Address persistence remains behind the existing ports.
The same entry owns flat-rate administration with required host schemas,
authorization resolver and responder; its reference binding preserves amount
validation and error mapping. Selection, manual address entry and text pickup
search remain reference UI, without npm exports or a vendor map loader.
Bundle stock renders the catalog availability answer without deriving inventory.

Neutral marketing sync lives in the existing communications contracts subtree
and is re-exported as types by both communications entries. It adds no runtime
factory, provider SDK, environment reader, host callback, configuration registry
or package subpath. The private subject mapper, durable admission/journal,
account leases and provider payload translation belong inside the selected
adapter's construction and infrastructure boundary. P2 owns that construction.
The four public families expose profile sync, consent readback, erasure and
local-authority consent push; discovery,
profile reads, history, events and membership remain outside the public surface.
Consent push is additive: existing providers remain valid. Its grants carry one
local purpose/audience evidence reference; account-wide scope is withdrawal-only.
The push capability declares audience or account-wide grant effects, with no-trigger
admission covering that entire effect. Withdrawals dispatch immediately, grants
refuse during pending withdrawals, and only the host reconciles unsettled-grant
races after a fresh post-settlement consent read. No push result proves effect. The
[canonical lifecycle](CANONICAL_CONTRACTS.md#neutral-marketing-sync) owns replay,
negative-only feedback and evidence-bound completion. No default composition
changes and no existing M04 implementation gains new obligations.

C-compose keeps communications admission in the reference host and uses Core's
existing readiness checker. The selected callable identities become the
communications contribution's route/schedule bindings; stale artifact,
configuration, environment, database or schema identity prevents entry. Other
selected implementations need their own real contributions in that same report;
an independently admitted identity or outbox candidate grants no communications
authority. Schema inventories are presence metadata, not ACL or SQL-body proof.

The admin email page mounts a distinct native evidence panel alongside its
managed historical list. Native accepted/unobserved, observed state, abandonment,
membership work and installation-scoped consent snapshots retain their separate
meanings. The disposable communications browser entry reuses that panel through a
closed import inventory; it adds no npm export or reusable UI package surface.
Default static/deployment profiles do not acquire the operator surface.

The reference payment webhook module delegates its generic capped body reader,
hex-HMAC verifier and constant-time comparison to `@openlup/platform/http`.
Its `readRawBody` binding retains the declared `VercelRequest` parameter and the
same package function object; the other four generic names are re-exports.
The payment provider verification and its 300-second replay tolerance remain local. This
shared primitive does not replace the Auth Standard Webhooks or the maintained HTTP mail provider signature
protocols. The [communications owner](../../src/domains/communications/README.md#packaged-server-algorithms)
describes the distinct verification boundaries.

Opt-in direct OIDC composition authenticates a signed external issuer/subject
into a deterministic UUID, then reuses the existing reconcile, actor-scoped
profile and live membership ports. A token supplies no operator role. Keep one
verifier binding per host to retain bounded discovery/JWKS refresh and register
its observations on identity startup admission. Reference routes retain observed
mutation policy. The RP owns local session/refresh credentials; stateless token
expiry and live membership are separate authorities. Managed composition retains
native sessions and refuses raw external-token access. See the [OIDC contract](IDENTITY.md#opt-in-oidc-access-tokens).

Reference identity startup composes the existing module-aware core readiness
contract with email-trust assessment. The host selects one bundle's schema
inventory and constructs mounted functions from typed adapter bindings under the
installed platform version. Admission preserves all observed packages and refuses
additional packages without composed contributions. The policy-wrapped candidate
table is dispatched as admitted, without substituting generated privacy handlers;
admin preflight uses the admitted operator authorizer. Candidate, host and ambient
environments must agree before listening. Missing bindings/schema refuse; unavailable settings or migration
history remain unknown and prevent listening. Direct reconciliation uses the
existing actor-scoped profile reader; direct invite/remove use the existing
owner-authority lifecycle stores. The public deployment-policy alias remains
in front of route effects. See [identity composition](IDENTITY.md#responsibility-and-composition).



The disposable identity reference has a separate browser entry and finite route
surface. Its server shell awaits the supplied composition's admission before
listening. A profile-local `#deployment-route-policy` alias grants only declared
identity routes within an ownership-checked async request scope; the ordinary
public policy remains the fallback outside that scope. Host, same-origin JSON
and method checks precede body adaptation. The local mailbox uses the existing
captured-delivery port and private files, with no network delivery service.


The subscription reference uses one `CustomerAuthProvider` across login,
callback and account routes, and mounts the same query client that the provider
clears on logout or a principal change. Browser binding loads only the selected
adapter. Managed callbacks remain SDK-owned, and direct challenges retain their
opaque token format; pages consume closed outcomes and a linked profile.
[Reference browser identity](IDENTITY_BROWSER_REFERENCE.md) owns these routes,
persistence keys and conformance boundaries.


Identity privacy uses an explicitly composed contributor registry. The identity
package owns profile pseudonymization, cleanup and receipts; the reference owns
the subscriptions veto on the shared transaction executor. Every assessment
precedes every mutation, with locks held through commit. Managed composition
supports export and refuses erasure before effects. Both direct and managed
privacy mounts use the observed admin mutation deployment policy. Direct mounts
apply it before authentication or privacy binding construction and take precedence
over supplied routes; direct adopters must admit them through their deployment
policy too. Direct mounts run admin preflight after policy admission and retain
the handler's human-admin recheck.
No provider SDK enters the
contracts subtree. The reference Settings panel imports only browser contracts
and its BFF client, and keeps personal readback in memory under a subject/session
key. See [identity privacy](IDENTITY.md#identity-personal-data) for coverage and
retained domain responsibilities.


Direct human operator authentication uses a capability-local PostgreSQL store
and the existing invitation activation in one redemption transaction. ES256
operator-audience tokens identify the human; every authorization reads live
membership and applies the fail-closed role allowlist. Exact machine credentials
retain a separate authorizer. The reference BFF dispatcher mounts the direct
operator routes only for the selected direct bundle, wrapping both defaults and
caller-composed handlers with the existing deployment policy boundary. All three
operator routes, including `me`, use the admin mutation risk classification and
require an adopter policy; dispatcher composition passes an injected
session-binding factory through to the mounted handlers. The browser hook uses
the auth port's guarded session notifications so an older redemption cannot sign
out or cancel a newer session. Browser auth uses a neutral
session subset and tab storage; managed client initialization is lazy and stays
inside its adapter. The [operator contract](IDENTITY.md#direct-human-login) owns
challenge limits, callback behavior and recovery; customer linking is separate.

Identity email association has an injected asynchronous trust policy. The
managed adapter reads bounded public Auth settings; the domain use case assesses
it after existing principal lookup and before email lookup or writes, including
the conflict retry. Reference host bindings parse the server-only provider
allowlist and share a policy cache for the configured origin/key/declarations.
The direct bundle's own composition selects an explicit verifier-result-only
binding with no settings request. The mounted customer reconcile route selects
actor-scoped linked-profile readback for `node-postgres`, without managed clients,
settings reads or email-based association. Only its managed bundle branches bind
the managed settings policy.
The managed soft-account link store also binds this settings policy independently
of bundle selection. Its linker checks trust before create-first provisioning or
existing-identity lookup by email and returns a non-fatal refusal without creating
an identity or link when trust cannot be established. Matching existing links
retain their replay path. Provider SDK construction remains in host adapters.


Identity invitation DTOs stay in the browser contracts subtree. The server entry
owns direct pending/accepted transitions through an injected invitation store; the host
parses its TTL environment value before effects and supplies the parsed number.
Managed adapters insert active native membership immediately, without Auth metadata
or first-entry activation. The browser validates active managed results as well
as complete direct pending results;
shared authentication and the public admin `me` source accept only the verified
principal before membership authorization. Direct commands use the existing trusted
PostgreSQL transaction lane; the machine token never accepts human invitations.
See [the identity lifecycle](IDENTITY.md#operator-invitation-lifecycle) for expiry,
cancellation, retained identity and managed concurrency limits.


<!-- openlup-doc-impact {"unit":"browser","digest":"sha256-72979d3e343910cc061caf7f7335b82a8a1d4f0afbcec47f45b86e80632e9095","reason":"Deletion delta. The personalization route key, the homepage personalization flag and its hidden paths, and a personalizer comment are removed from browser code; no browser boundary described here changes."} -->

Browser-facing modules own portable types, validation, clients, and pure logic.
Server modules own HTTP composition, use cases, authorization decisions, and
persistence ports. Infrastructure modules translate provider protocols and
payloads. Adapters implement ports for a selected provider or runtime.

Dependencies point inward: domain policy depends on ports and contracts, never
on a provider SDK or provider environment shape. Provider-specific payloads and
raw status values end at the adapter boundary. Durable state belongs to the data
contract, not to a browser client or provider response.

`npm run lint` enforces the import side of this in
[eslint.config.js](../../eslint.config.js). A package under `packages/` imports
nothing outside its own directory, except `@openlup/outbox` and
`@openlup/platform` may import the exact public exports of their declared
`@openlup/core` dependency. Workspace
imports, including imports inside packages, use only subpaths their target's
`package.json` `exports` declares, never through a
relative path into `packages/` or an undeclared subpath such as `src` or
`dist`. Domain code under `src/domains` and `server/domains` imports none of
the provider SDKs the config names and no adapter, infrastructure, runtime or
route code; its tests may compose a domain with an adapter. The same provider
SDK restriction applies to non-test production source in `packages/core/src`
and `packages/ui/src` as well as `packages/outbox/src`; their tests retain
package isolation and exact-export checks. `packages/platform` is not portable
in that sense: its PostgreSQL adapters load the optional `pg` peer (with optional
`@types/pg` declarations), its S3 adapter loads optional `@aws-sdk/client-s3`, and
it receives the `@vercel/blob` module and the Supabase client factory from the
application instead of importing those SDKs. The checks cover
literal import and re-export specifiers, plain-template dynamic imports,
type imports, and literal/plain-template `require` and `module.require`
loads. A specifier held in a variable or reached through an alias still needs
review. Provider UI, such as the card payment form, lives with the adapters, while the
words and outcomes it exchanges with its host stay in the domain's contracts.

Portable package contract names also stay industry-neutral. The structural
industry rule rejects explicit pet/dog/cat name components and literal types
in those two production source trees. Ordinary runtime values and opaque
extension-data forwarding remain available to adopters. The rule has no claim
of semantic or dataflow analysis; see the precise scope and exceptions in
[contribution checks](../../CONTRIBUTING.md#development-preview-checks).


<!-- openlup-doc-impact {"unit":"server","digest":"sha256-9cfdf7128ab62cd3a5e27dbf32460c1b005f8617537f7483950832afc55587a7","reason":"The admin-domain kit drops an uncalled managed-only preflight copy and its unused imports; the dispatcher keeps using the runtime auth binding's preflight. The customer kit, the runtime auth binding and the customer session binding drop unused imports and re-exports. A characterization test pins the reference customer binding's existing process-wide managed read settings independently of the passed bundle-selection environment. No runtime boundary described here changes."} -->

The runnable server substrate lives in the development-preview `@openlup/platform`
package: the Node HTTP runtime and its fixed request order, BFF dispatch,
scheduling with job leases, blob and data adapters, the node-postgres migration
runner and bundle composition. Every deployment value reaches it as an option or
injected function, including the environment, route table, header policy,
entrypoints, job configuration and migration catalogue. The reference
application keeps its former module paths as thin bindings that pass its own
values. The BFF envelope, observed request context, health route and managed
job-run ledger are package code too; the application binds its request-reference
policy, health payload and contract, and ledger messages, and keeps its route
observability and browser contracts as its own source.

Identity's server logic now lives in the [identity module](IDENTITY.md), with
flat internal files and a separate browser contracts subtree. Reference routes
supply admission flags, redirect policy, schemas, provider clients, mail and copy.
The module uses the foundation responder with an injected observed request-ID
reader. Managed preflight also imports the characterized machine-write fence;
its application-owned allowlist does not extend the direct operator-token lane.

The reference outbox worker delegates to `@openlup/outbox`; application handlers and the explicit known event vocabulary remain in composition. Shared envelope, execution-context, descriptor and readiness contracts live in `@openlup/core`. The rail provides one bare worker for immediate work and lease-bound schedules for dispatched work. Its PostgreSQL executor commits each claim or settlement before resolving, with no encompassing transaction across effects.

## Extension seams

Extensions belong at explicit seams:

- provider adapters implement a platform-owned port and capability contract;
- configuration selects an adopter-owned composition without changing domain
  semantics;
- event subscribers react to documented facts without taking hidden ownership of
  the originating transaction;
- themes, copy, catalogue data, and local policy remain adopter-owned inputs;
- an adopter's own domains sit beside the platform's under `src/domains` or
  `server/domains` and are registered as application domains through the
  `#application-domains` import (`src/lib/coreDomains.ts` names the platform's
  core domains; the public binding registers none);
- a new generic capability is proposed upstream with a compatibility owner and
  conformance evidence.

Do not turn a local adapter or a one-business rule into a required platform
dependency. Likewise, do not remove a platform capability merely because one
adopter customizes it: the platform remains responsible for a complete useful
module at its own boundary.

## Source ejection

An adopter can copy a component or page into its own source. This is source
ejection, not an extension point. From that point the adopter owns the copied
surface, including security fixes, tests, compatibility, and manual upgrades.
The platform will not modify or promise compatibility for an ejected copy.

Use a documented extension seam when updates must continue to flow. A source
ejection should be a deliberate, reviewable ownership transfer.

This component/page route does not authorize ejection of an adopted package
engine. For a missing engine seam or defect, use a supported wrapper or native
adapter only if it preserves the installed contract. Otherwise retain compatible
serving behavior, record a local reproducer, and hold the dependent change for
authorized upstream work or an available compatible rollback. Rollback must fit
the current durable state; it never means rewriting published SQL or discarding
pending work. Unrelated application development continues. The
[adopter recipe](adopter-kit/README.md#adopt-or-upgrade-a-package) owns the comparison
and extension-disposition steps.

## Package architecture

OpenLup ships its platform as `@openlup/*` npm packages. This section is the
contract every package follows as it is extracted. The installed manifests,
exports and guides identify the selected version's available capabilities.
Rules that need a contract the kernel does not export yet say so.
Development-preview rules may still change (see
[Compatibility posture](#compatibility-posture)).

<a id="modules-and-distributions"></a>

### Package placement decision (canonical)

A module is a capability or infrastructure responsibility with an owner, public
entry, ports, data obligations and conformance evidence. A package is an npm
distribution artifact. Several controlled modules may share a package; one
module does not require one package, and a capability is not split into a
package per process. Grouping changes neither ownership nor transactional,
idempotency, recovery or schema boundaries.

The intended distribution roles are:

| Distribution | Role and adoption boundary |
| --- | --- |
| `@openlup/core` | Existing I/O-free kernel; retain its published coordinates and exports. |
| `@openlup/outbox` | Existing outbox rail; retain its published coordinates and algorithm owner. |
| `@openlup/platform` | Planned backend distribution, beginning with the runnable foundation, then identity at `@openlup/platform/identity`. |
| UI | Target distribution role; this does not reserve an npm name or establish a published library. The foundation shell remains reference-application source. |

These are target roles, not an inventory of published artifacts. The
[package catalogue](../../config/openlup-packages.json), installed manifests
and export maps establish the selected set. Identity's planned physical home is
`packages/platform/src/identity/`; its browser-safe contracts need an isolated
entry, preferably `@openlup/platform/identity/contracts`, with no server imports.
Only genuinely shared contracts belong in core; importing platform as a whole
is not a browser-safety guarantee.

Place a new module at declared subpaths of `@openlup/platform` by default.
Use core and outbox only for their defined roles above. UI remains a future
artifact role, with no current name reservation or bootstrap obligation. Record
placement and the topology-trigger check in the module/API packet before
implementation.

A separate package needs evidence: incompatible peer ranges in supported cold
installs; a genuinely different browser/edge/Node runtime; measured
installation or native-build cost; a different maintenance or release lifecycle;
or an actual independent consumer poorly served by subpaths. First
assess whether an isolated subpath suffices; for adapters also consider an
existing port, optional peer or application adapter. A provider name alone is
not a trigger. Record the evidence and compatibility and maintenance ownership
in the same packet. A trigger requires an explicit maintainer decision under
the applicable authority; it grants no authority to create, bootstrap or
publish a package. A
new npm name also needs the maintainer's manual bootstrap before its first
release, not before its contribution PR; follow
[package release setup](../../.github/VERSIONING_AND_EOL.md#package-releases).

Size growth is not a topology trigger. When measured growth exceeds a cap,
raise that cap in a reviewed change with the applicable maintainer read of the
proposed budget; follow [Package artifact limits](../../.github/VERSIONING_AND_EOL.md#package-artifact-limits).

The opt-in Node `payments/stripe` example follows the same placement decision:
it shares the platform package's release and maintenance owner and composes M07
payment ports. The host injects a structural client, secrets and mode; no SDK
import, dependency, environment policy, default binding or new npm lifecycle is
added. Refund creation and authorization/capture separation are unsupported;
exact absence is omitted because the donor search cannot prove completeness.
Cancellation is offered only when injected. Account readiness stays pending
owner TEST evidence. See [the payment adapter contract](CANONICAL_CONTRACTS.md#opt-in-payment-example)
and [A2 ledger](plans/oss-a2-payment-adapters.md).

The vendor subpaths also expose the eleven bounded experimental
[reference-support helpers](../../packages/platform/README.md#reference-support-surface).
The root execution/readback bindings consume those contributed implementations
instead of retaining duplicate algorithms. Reference flags, SDK construction,
payer fallback, repair handoffs and localized return presentation stay with the
host. Capability projections reuse package facts without adding a neutral seam;
the shared no-charge error retains genuine class identity across the boundary.
This adds no package, dependency, migration or neutral payment export.

The opt-in Node `payments/tpay` example shares that package lifecycle and M07
boundary. The host supplies HTTP and certificate I/O, credentials, callback URLs,
mode and Model O policy. Bank/code attempts and Model O alias charges are
supported when the host supplies transient payer and method selection through
the canonical M07 P3 attempt input. Missing required context refuses before
dispatch; only neutral facts cross the return boundary. It also provides verified
observations and transaction-ID readback. There is no SDK, environment reader,
default activation, complete absence search or recurring-card offer. Certificate
validity and signed notification freshness are verified; account readiness
remains `verification_pending` until owner TEST readback. See the [A2 ledger](plans/oss-a2-payment-adapters.md#o-p2-boundary-and-named-deltas).

The A1 email adapter follows this placement decision at the opt-in Node subpath
`communications/resend`, within the existing platform release
and maintenance lifecycle. It adapts the existing guarded email transport,
observation port and delivery reconciliation runner. Internal POST/GET helpers
are not public exports; host policy and persistence stay outside the adapter.
Injectable fetch requires no SDK peer or new dependency. No independent lifecycle,
incompatible peer or runtime split has been demonstrated. The neutral root and
browser contracts entries and the incumbent reference adapter remain unchanged.
See [the protocol contract](CANONICAL_CONTRACTS.md#opt-in-node-protocol-adapter)
and [A1 ledger](plans/oss-a1-communications-adapters.md); importing this subpath
installs no route, schedule or sender binding.

The opt-in Node `communications/klaviyo` subpath uses the same platform
release and maintenance owner. Its single factory implements the existing
neutral marketing-sync and consent-push contracts without an SDK, new package
or dependency. Provider payloads, revision, credentials and remote mappings
stay inside that subpath; root and browser entries retain type-only neutral
contracts. A host supplies current local authority and atomic account storage;
no lifecycle callback registry, default binding or background executor is added.
An unresolved journal or cooldown requires host reconciliation. Account-specific
capabilities remain pending until TEST evidence establishes safe effects;
[the canonical adapter boundary](CANONICAL_CONTRACTS.md#opt-in-singleton-marketing-adapter)
and [A1 evidence](plans/oss-a1-communications-adapters.md#p2-opt-in-singleton-marketing-adapter)
describe the remaining limits.

### Package kinds and dependency direction

Today each package declares one `kind` in `release-gates.json` and the readiness
manifest. The same responsibility rules must hold between logical modules
inside a distribution:

| Kind | Holds | May depend on |
| --- | --- | --- |
| `kernel` | I/O-free contracts and logic shared by modules or read by application composition; its only runtime dependency is `zod` | nothing else in `@openlup/*` |
| `rail` | runtime infrastructure capabilities emit into or record through | the kernel |
| `capability` | a complete capability, including its processes, schema and local contracts | the kernel and rails |
| `implementation` | one port bound to one provider or runtime | the kernel, rails and the responsibility it implements |

The runnable foundation in `@openlup/platform` declares `rail`: its HTTP,
scheduling, storage and data facilities supply runtime infrastructure over core
ports. Its publishable catalogue entry joins the same preview release set as
outbox; it does not establish that a registry release has occurred.

- **No I/O in the kernel.** It imports no database driver, provider SDK or
  `node:` module, and is no HTTP or scheduled-job entrypoint.
- **No capability depends on another capability's implementation or use cases.**
  Cross-capability flows use declared ports, contracts, rails and maintained
  orchestration in the appropriate layer. An allowed public index alone does
  not legalize a forbidden dependency.
- **The kernel grows only for shared contracts.** A contract used by one module
  stays there unless application composition genuinely needs the shared seam.
- **Default stores need no driver.** They use a structural SQL executor;
  provider-specific stores stay behind explicit adapter boundaries.
- **New kernel validation contracts use `StandardSchemaV1`.** Existing kernel
  exports are `zod` schemas today.
- **Host composition stays in the application.** Environment selection, routing,
  bindings, handler manifests, readiness wiring and host entrypoints belong to
  the application. A package may supply a generic composer over public ports
  and factories; the host chooses its concrete runtime and provider bindings.

Module grouping must not rewrite historical kind metadata or bypass current
validators. Separating artifact identity from module responsibility requires
its own reviewed compatibility change before a second capability is admitted.

### Internal boundaries and adapter isolation

Effective bundle selection reuses pricing's half-open authority through its
public server entry, adding the catalog → pricing value edge. The dependency is
acyclic; pricing owns no runtime catalog edge. The opt-in adapter keeps effective
SQL internal and leaves browser contracts type-only and incumbent SQL unchanged.

Inventory remains a non-adapter entry with no catalog import; its bundle-stock shapes are declared structurally. Admin handlers bind host response writers, and native reads require the provider value and validator. The new-purchase projection takes normalized reads, host defaults, fallback, observation and availability calculation; transports and cycle writers retain their owners.

Reservation policy has an unchanged server counterpart; the reference keeps browser-safe local values and forwards DTO types only. The native renewal reservation factory takes a structural executor and preserves its fenced reserve/release/expiry SQL, defaults, errors and readback. Its inventory-only port does not own subscription cycle, anchor, due or attempt writing.

Catalog now also owns fixed-bundle application/admin factories at its existing
entry. Its data/http/bff inputs remain type-only: the native read
store takes the data entry's executor without constructing a driver or pool.
Effective bundle selection alone adds the pricing value edge described above;
there is no promotions edge. Reference wrappers bind
existing schemas, operation spec and shared admin kit, stock/lifecycle helpers,
versions and the RPC error constructor. Browser-reached schemas retain their
reference owner and never re-export the server entry; catalog contracts expose
plain bundle DTO types. Catalog server is now an adapter because its declarations
reach optional pg types; runtime import and executor reads still work without
peers. Contracts remains a non-adapter. The native writer, pooled transaction
binding and transport remain reference-owned; sparse SQL projections add no
installation chain or migration.

The experimental promotions module has value edges to pricing through
`pricing/index.js`, for acquisition selection/binding and protocol constants, and
to `shipping/index.js` for the opt-in pure threshold policy. Pricing has only a
type edge to shipping for promise DTOs; it injects the orchestration callback
and has no promotions runtime edge. The existing subpaths suffice: no package,
peer, adapter classification or release-budget change is needed. See
[parity seam contracts](CANONICAL_CONTRACTS.md#m05-parity-seams). Type-only
edges to data, http and bff describe the injected executor and shared admin-kit
interface. The native store does not construct a client, so it needs no data
value edge. Its declarations reach optional pg types through data; cold consumer
classification therefore treats the server entry as an adapter. Contracts remain
dependency-free and non-adapter. Reference wrappers retain financial floors,
customer semantics, eligibility interpretation, request projection, telemetry,
currency validation and the existing shared admin kit/error constructor by
identity. Neither the kit nor managed adapters move into promotions. Core remains
the sole evaluator; claim writing and mounted acceptance retain their owners.

The foundation boundary work starts from its existing directories and entries:
`http`, `bff`, `scheduler`, `blob`, `data`, `migrations`, `job-ledger`, `kernel`
and `composition`. Retain the corresponding public subpaths. Helper directories
do not automatically constitute separate capabilities; inventory their existing
characterized dependencies, including type dependencies, before enforcing the
allowed graph. No foundation wrapper directory or extra runtime registry is
required.

Within a module, imports may use its internals. Between modules, production
imports must use the target's declared entry and the allowed dependency graph.
This includes type imports and supported literal dynamic imports or `require`.
An alias or re-export must not conceal a deep import or a forbidden capability
implementation dependency. Not every internal module needs an npm export.

The later foundation implementation must enforce these boundaries through
existing ESLint and import-map tests, using ast-grep only for a gap those cannot
express. Prove allowed own-internal and permitted neighbour-entry imports,
refused neighbour deep imports (runtime and type), and refused directions or
capability implementation imports even through a public entry. Cover alias and
absolute-path escapes within the mechanism's supported syntax. Control changes
need their applicable owner authority; this contract does not install new rules.

Installing a distribution does not activate all its modules. A nonadapter
import must not read provider environment, initialize a client or execute SQL.
An unselected adapter must not require its SDK. A selected adapter must refuse
explicitly when its required SDK or configuration is missing. Subpaths do not
split installation of ordinary dependencies or guarantee tree shaking. The
[packed-consumer proof](../../CONTRIBUTING.md#required-and-raw-checks) must
establish physical SDK absence and declaration usability, not just source scans.

For a separate integration artifact, follow the canonical
[package placement decision](#package-placement-decision-canonical).
Generic supported orchestration remains the platform's responsibility.

### Contributions, seams and readiness
The M05 contribution is a structural declaration over supplied bound callables,
not another domain or activation registry. Its three contributions retain the
`catalog`, `pricing` and `promotions` identities. Ports and bundle routes retain
actual function identity for the existing readiness checker. The reference binding
selects native stores and delegates operator verification through the existing
identity binding; no default dispatcher or authorization control changes. The
package contribution imports readiness types only, so no new cross-module edge
is needed. Missing selected callables or stock refuse, and incomplete/unknown
schema observations cannot admit the candidate.


The local outbox contribution implements these rules through the experimental
`@openlup/core/readiness`, `./outbox` and `./standard-schema` subpaths.
The publication catalogue admits the complete outbox rail to the release set.
Catalogue admission is distinct from npm publication; reviewed release preparation
and the protected release workflow still govern its first published minor set.

The current [checker](../../packages/core/src/readiness/index.ts) supports
selected modules within one artifact while preserving its package name, version
and kind. A loader declares the selected module inventory; each module has one
contribution and explicit entry dependencies. Routes, ports and schedules use
the package/module namespace and actual function identity. Legacy whole-package
contributions remain valid without module selection.

[Reference identity admission](../../server/runtime/auth/referenceIdentity.ts)
selects identity with `bff`, `data`, `kernel` and `http`, supplies the bundle's
complete required-schema inventory, and combines that report with asynchronous
email-trust readiness. Unknown or unsatisfied candidates cannot start listening.
It does not aggregate the outbox helper's legacy whole-platform placeholder.
UI admission still needs its own artifact role and consumer proof.

- **The factory.** A rail or capability exposes a factory taking ports and options. It returns
  a contribution, `{ handlers, schedules, routes, manifest }`; a field that does not apply is
  empty.
- **Ports.** Business ports are required in the factory's type. Infrastructure ports (clock,
  logger) have defaults.
- **The manifest** declares:
  - the events the package handles and emits;
  - its schedules, routes and required ports;
  - its `requiredSchema`;
  - the environment variables it reads.
- **Schedules.** A schedule's `run` takes the job lease. A disabled job ends as `disabled`.
  `run` returns `{ outcome, detail }`, and mapping that result to HTTP is the application's job.
- **The readiness check** runs before a new version takes traffic and reports every failure at
  once, with a stable `OPENLUP_E_*` code, the package, the subject and a fix. It covers:
  - unwired ports;
  - unhandled event types;
  - unbound schedules;
  - a schema behind the package;
  - a mixed package set;
  - missing environment variables.

  A failing check never stops a version that is already serving.

### Versions and schema

- **One set below 1.0.** Below `@openlup/core` 1.0, every `@openlup/*` package carries the same
  version `0.N.P` and is released from one commit. Each package has its own tag,
  `openlup-<package>-v<version>`. A patch set carries fixes only; any API, behaviour or schema
  change is a minor set.
- **Pins.** Each package pins the others exactly. An application moves every `@openlup/*`
  package together, after reading each changelog's `Migration:` blocks.
- **Schema in the tarball.** A package that owns schema ships its SQL in its tarball from its
  first release, for the application's own migration chain to apply. It never applies SQL itself.
  Shipped SQL follows expand, compatible deploy, backfill, contract. The
  [migration owner](DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories)
  distinguishes source history, tarball projection and an existing store.
- **Readiness adaptation release.** A public readiness API or behaviour change
  needs the next minor set, chosen against the actual registry. Merging the readiness adaptation does
  not require an immediate separate release: prefer one compatible set with
  completed identity, proving intermediate work with built workspace candidates
  and real tarballs in disposable consumers. A separate earlier set needs a
  real npm consumer and its own release authorization and protected approval.

### Agent guidance for applications

- **This repository's guides are for contributors.** The root `AGENTS.md` and
  [the agent guide](AGENT_GUIDE.md) govern work on this monorepo only.
- **Each package carries its own `AGENTS.md`.** It states the package's kind, the maturity of each
  subpath, one wiring example and the rules for using it from an application.
  It describes that installed version's contract, not host policy, tool permissions
  or authority for an external write. Installing it activates no application control.
- **Applications start from the [adopter kit](adopter-kit/README.md).** It holds an agent-guide
  template, a dependency-update template that moves every `@openlup/*` package together, and an
  agent-tool permission template that refuses file-edit tools under `node_modules/`. The template files use
  names no agent tool loads, so they never govern work in this repository.

## Compatibility posture

Development-preview seams may change. The stable-framework requirements are the later gate for stable
extension contracts, a versioned release/BOM, a thin adopter app, conformance
coverage, and upgrade tooling. Until that gate is complete, this document is a
boundary contract for preview work rather than a support promise.

## Communications capability import

M04 P1 adds `communications` within the platform rail, with isolated type-only
`communications/contracts`. Its actual value edges are `data` (receipt lane)
and `identity` (Auth verification URL); the Node handler shapes use a type edge
to `http`. The host supplies renderer, protocol observation and shared control policy. Concrete mail
transport, credentials, callback mapping and polling reads stay in reference
adapters. Neutral observation/polling engines are reached through the existing
domain entry points, using injected lookup, atomic apply and telemetry ports.
They own sequencing and counters, while the database convergence RPC owns durable
replay, chronology and suppression; no second writer or subscription mutation is
introduced. No reference alias or provider SDK is imported by this capability.
The contribution describes explicit host selections and never mounts a second
executor. Browser preview values remain reference-owned. See the
[M04 scope](plans/oss-m04-communications-triggers.md).

## Fulfillment contracts

Fulfillment lives at three existing-package subpaths:
`@openlup/platform/fulfillment`, `/fulfillment/contracts` and the opt-in
`/fulfillment/omnipack` example; no topology trigger
requires another package or dependency. The type-only contracts entry has no runtime,
server or cross-module edge; its only dependency is a type import of the core
normalized fulfillment fact. The runtime entry binds core evidence parsers to the
contributed status canon and selects only injected capability profiles. Provider,
carrier and service remain independent; empty provider selection refuses, and
potential support never enables a dormant route. Raw commands, credentials and
signed label URLs stay transient at the host/adapter boundary; durable contracts
carry typed facts, safe references and actual-command fingerprints. Existing reference facades
and the order-management status ladder/queue pair remain host-owned until explicit later adoption.

The deeply frozen, readonly default-off descriptor remains unselected and unready
after host construction. Numeric HTTP settings refuse invalid values at construction.
Every fetch refuses redirects so a 307/308 cannot repeat a POST body.
The opt-in `@openlup/platform/fulfillment/omnipack` example composes the contributed
transport/codecs with the frozen ports. Its host supplies HTTP, per-call secrets,
product metadata and explicit selection/readiness. Preparation computes canonical
bytes and closed fingerprint/contact/selection evidence without retaining state.
Equal-valued request/evidence copies work without JavaScript object identity.
Dispatch validates evidence and request values before host callbacks; malformed
or inconsistent evidence refuses before credentials or HTTP. The single
per-instance submission record is keyed by command fingerprint and bound to the
submitted evidence key and canonical SHA-256 command digest. Matching evidence
and command values join or replay its result without callbacks or I/O; either
mismatch refuses `not_dispatchable / dispatch / retryable:false`. Only the hash
of command-bearing request values is retained; codec-omitted descriptions remain
irrelevant. For a new fingerprint, dispatch reserves the entry, resolves host
metadata again and rebuilds through the same path as prepare. Drift releases the
reservation and refuses before credentials or provider I/O; matching evidence
permits POST without prior local preparation. Host callbacks must return the same
values for the same request across preparation and dispatch.
The positive integer `maxRetainedSubmissions` (default 10,000) bounds completed
submission retention with oldest-first eviction by admission order, without
evicting in-flight entries or refusing new fingerprints for capacity. In-flight
overflow is trimmed on each completion; retained replay does not refresh age.
Eviction is equivalent to restart for that fingerprint: dispatch rebuilds and
may POST again when evidence still matches. M08's durable claim/begin/attempt/
finalize ledger remains the double-dispatch guard. Provider idempotency is not
established by the donor evidence. See the [example contract](CANONICAL_CONTRACTS.md#opt-in-fulfillment-example)
for resolution consistency and refusal phases.
Proven pre-submission failures and definitive HTTP rejections are
non-submissions even if the rejection body is unreadable; successful statuses
without a readable acknowledgement and ambiguous POSTs stay unknown without retry. Accepted provider
proof keys are opaque and deterministic; host keys remain worker-owned. Configured
product paths cannot change the HTTPS origin or carry credentials. Observations
authenticate before parsing and reject malformed explicit event kinds. Nullable
occurrence is preserved; readback needs explicit complete single-page totals before
a unique positive match, and incomplete or empty collections remain unknown.
Label create/void and cancellation are unsupported; label reads remain host-owned.
The frozen label port returns unsupported refusals without I/O for all its methods.
Sync projects collection identity and closed data, with product writes only on
explicit invocation. No route, schedule or default binding is installed. Root
reference implementations remain unchanged. See the [example contract](CANONICAL_CONTRACTS.md#opt-in-fulfillment-example)
and [A3 ledger](plans/oss-a3-fulfillment-adapter.md). The example passes M08's
offline runner with injected HTTP, synthetic sensitive-value plants and explicit
unsupported refusals. Its [conformance witness](../../packages/platform/test/fulfillment/omnipack/conformance.test.ts)
also runs the real dispatch worker against a begun/recorded host ledger after
adapter restart and completed-record eviction, requiring zero provider calls.
These fixtures establish neither provider-account readiness nor durable store
atomicity; account readbacks remain owner acts.

The [dispatch port](../../packages/platform/src/fulfillment/contracts/dispatch.ts)
prepares the actual provider command without submitting it, returns its fingerprint
and sanitized evidence, and keeps command bytes transient inside the adapter.
Feed that evidence to store claim and its fingerprint to begin before dispatch;
dispatch sends exactly the prepared command identified by the same evidence.
A contact_stale remap rebuilds the request and requires a new prepare, claim and
begin. Selection failures retain their exact reasons; a non-dispatchable request
refuses as not_dispatchable. Absent/mismatched command preparation refuses with
reason not_dispatchable, phase dispatch, retryable false, before I/O.
FulfillmentStorePort.prepare checks contact readiness/withholding;
FulfillmentDispatchPort.prepare builds the transient command and its evidence.
Unknown external outcomes require readback rather
than blind submission; accepted evidence can repair a lost local acknowledgement.

runFulfillmentDispatchWorker keeps one contact remap across claim and begin.
A correctable draft re-claim atomically refreshes fingerprint and evidence, then
reads the authoritative row. Approved amendment G14 records the mapped provider
attempt at that point, before shadow exit, unsafe-state refusal or begin. Its
host-supplied opaque key preserves initial/remap identities; only allowlisted
prepared evidence, mode/status and references persist. Same-key replay writes no
second attempt. Unknown/submitting/failed states never automatically POST;
accepted proof repairs a lost local ACK without a provider call. Only a
post-dispatch ACK failure triggers readback and an attempt to finalize accepted
proof as uncertain with its external reference retained when acceptance is not
already committed. Loop-start and concurrent-begin recovery ACK failures reach
the outer catch without that rescue.
Main and repair ACKs use identical host acceptance keys, ignoring adapter-provided
key fields so a committed ACK replays after a lost response.
The separate createFulfillmentCommandLedger protocol delegates atomic fenced
operations to a durable store; it does not keep lease/retry state locally. The
host supplies keys, actual-command fingerprints, candidate selection, paid truth
and inventory authority. After payload validation, unless an enabled risk gate
returns early, the paid outbox handler awaits its injected fulfillment call before returning an
outcome. Risk `review`/`block` returns `processed` without calling fulfillment;
fulfillment `completed`, `skipped` and `manual_review` also return `processed`
and settle the event. Settlement therefore does not always mean fulfillment
completed. Recovery classifies missing/stale/uncertain
work for local requeue, waiting or operator review, without dispatching it.
The donor OrderPaidFulfillmentPort in paidHandoffPorts.ts retains the handler's
outcome ladder; later host composition bridges it to FulfillmentPaidHandoffPort,
with the concrete durable bridge owned by later native store work.
Durable store conformance and native SQL/atomicity proofs remain later work.

[Labels](../../packages/platform/src/fulfillment/contracts/label.ts) separate durable
object pointers from transient signed downloads. Missing PDF is not missing parcel;
proceedable cleanup is not confirmed deletion. Observations authenticate untouched
bytes before parsing and separate event identity/first receipt from core fact
fingerprints/nullable occurrence. Token authentication alone proves no signed
freshness. Readback distinguishes found, exact scoped absence with proof, unknown
and unsupported; empty pages and missing local records prove no external absence.
Sync retains collection identity, nullable source revisions, sanitized continuation,
movements, lots, expiry, replay and conflicts. Inventory reservations/availability
and catalog facts retain their existing owners. Host storage label reads remain
independent of provider support; capability selection performs no I/O.

The [verified ingress](../../packages/platform/src/fulfillment/verifiedIngress.ts)
and [reconciliation worker](../../packages/platform/src/fulfillment/providerReconciliationWorker.ts)
use approved G17 inline host persistence. Ingress requires recordObservation to
atomically deduplicate eventKey and retain firstReceivedAt, and markProcessed to
be idempotent. Host lifecycle writes must also be idempotent so retries after
interruption create no second durable effect. Reconciliation reads local status,
latestStatusOccurredAt and handedOverAt through readLocalFulfillmentState.
Non-stale found observations for locally cancelled/exception rows write status
evidence only. Older known occurrences skip status/effects; an on-track row with
handedOverAt can still retry its accounting invoice. Invalid or absent timestamps
remain null; valid timestamps require an explicit zone and calendar/time checks.
Host event keys must distinguish kind/outcome and known occurrence; identical
observations without time carry no invented ordering. Private authentication/parsing, mapping
and key bytes stay with the adapter/host. For correlated ingress, a trimmed
observation or dispatch external reference is required before acceptance, status
evidence, effects or the processed mark; failure leaves the persisted receipt
unprocessed. Stock-contention annotation is a best-effort host write before the
original stock failure is rethrown; recovered-picked receipts remain typed
diagnostics. A classified superseding conflict returns superseded but marks only
processed status; G17 has no dedicated persisted superseded-reason field.
Unknown readback fails reconciliation before row processing. Unmapped evidence
projects eventKey and declared correlation fields before host calls; correlated
off-track rows skip acceptance/quarantine, while other rows require an external
reference before acceptance and unknown-status quarantine. Effects retain
stock → handover → tracking → invoice order. Tracking keeps the first trimmed
nonblank number and provider-carrier precedence; normalization/URL codecs stay
injected.

[Stock sync](../../packages/platform/src/fulfillment/providerStockSyncWorker.ts)
uses approved G15 coverageGapSkus on SyncCursor: absent is empty, and only the
preceding succeeded run can confirm a repeated sellable coverage gap. A completed
run writes the sorted current set on success or [] on failure; running cursors
also clear it. Approved G16 makes readLocalInventoryStock(requestedAt) return
unaggregated lines with skuRef, quantity balances, fulfillable/location/lot status
and expiry. The worker filters and sums at the same captured clock passed to
active-reservation reads; expiry exactly at requestedAt is unusable. The provider
stock-sync shape and inventory authority are unchanged. Host compatibility inputs
preserve original run IDs, sentinel, keys and movement-window time zone. Product
sync retains additive pack push, missing-metadata skip and sync markers; pull
delegates local ownership and unknown-SKU decisions to host upsert and records
conflicts. Evidence handlers retain GET/authorization/validation/read order with
injected parsers/responders and safe product authorization/read refusal details;
they expose no resolving mutation.

The [conformance runner](../../packages/platform/src/fulfillment/adapterConformance.ts)
accepts readonly FulfillmentAdapterConformanceSubject[] and returns sanitized
FulfillmentAdapterConformanceEvidence containing subject/provider references and
passed operation records; a violated check throws. Adapter-owned offline fixtures
exercise prepared-evidence and fingerprint consistency against the fixture's
expectations (command bytes are not inspected), before-I/O mismatch refusal, requested replay,
unsupported operations, exact absence scope/proof, local-missing unknown, selection
and redaction. An optional host store fixture checks mapped-attempt replay/remap
and draft re-claim evidence; a worker exercise caps contact remapping at one.
Native database atomicity and arrival continuity remain later work. The runner
requires default-off adapter capabilities, and the workers/handlers are unmounted;
no live provider or installation claim follows from fixture proof.

[Delivery alignment](../../packages/platform/src/fulfillment/contracts/alignment.ts)
preserves the arrival-only rule: late delivery extends the next cycle, never stacks
deliveries or moves it earlier. A replacement may settle alignment as `aligned`
only after reaching the customer. Its superseded predecessor is no longer
outstanding, but an in-flight or undelivered replacement still is. Never call
`subscription_delivery_alignment_confirm_replacement` for a replacement that did
not arrive: it records the customer-facing fact "Parcel delivered" and shifts the
cycle later. The note-only operator attestation remains unchanged; this surface adds
no caller. Native alignment implementation and continuity proof remain later work.

Inspect the [contract witnesses](../../packages/platform/test/fulfillment/contracts.test.ts),
[status parity](../../packages/platform/test/fulfillment/statusMap.test.ts),
[port fit](../../packages/platform/test/fulfillment/portFit.test.ts) and
[programme record](plans/oss-m08-fulfillment-physical-delivery.md) for provenance,
declared adaptations and later obligations. Callable orchestration and a durable-store protocol are provided without a concrete
adapter, persistent store, mounted executor, route or activation; reference
composition stays unchanged.
