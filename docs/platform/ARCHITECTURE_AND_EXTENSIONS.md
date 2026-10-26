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

Operational reference handlers and browser clients delegate through the isolated
[operations package entries](#operations-and-diagnostics). Environment/bundle
selection, connection ownership and the maintained domain evaluator remain in
reference composition; the neutral persisted-job tick and watchdog delivery
mechanisms have one package owner.


The commerce browser entry contains schemas, pure helpers and port declarations;
its `/contracts` entry remains type-only. The `/commerce/server` entry
is the separate Node-only home for handlers, use cases, stores, adapters and
engine composition. Browser bundle proof checks the complete commerce runtime
graph. The additive `pricing/browser` entry directly exposes the existing quote
primitive factory, acquisition capability/expectation/resolved-terms validators
and shipping-terms validator. Acquisition reuses its pure defining file; shipping
uses an exact linted edge from `pricing/browser/index.ts` to the existing pure
`shipping/thresholdPolicy.ts` owner, preserving validator identity without the
shipping handler/Node HTTP declaration closure. Other internal shipping paths
remain refused. The complete browser graph imports neither Node
built-ins nor the Node-only pricing root. Reference quote context binds optional
shipping/acquisition terms without changing its other fields or strictness. The customer-default consumption guard reads the package implementation
so its unapplied-evidence and forbidden-payload assertions retain their meaning.


OMS host handlers bind generic package factories to the existing responder and
admin authorization. Read governance remains host-owned, with its gate before
reads and audit before masking. The replacement facade delegates to the existing
fulfillment handler through a nominal-conflict bridge that retains the original
request and transaction receiver. Creation records no arrival or subscription
lifecycle transition. The browser-safe `commerce` entry exposes schemas and pure
models and reuses the existing pricing/contracts version export. Node-only
`commerce/server` owns handlers, managed stores/adapters and detail composition
that reuses the shipping runtime. The built browser graph is bundled without
Node externals in its package boundary test; commerce/contracts stays type-only.

Commerce returns and native review handlers/adapters are implemented in the
Node-only platform commerce/server entry. Reference review runtime composition retains
its database resources, authorization, private filesystem store, lease fencing
and reconciliation; only imports are rebound. The raw upload binding and the
transactional promotion callback remain the storage seams. M02 blob storage has
no private read/inspection/temp/promotion operations, so it cannot replace that
store unchanged. Hosted token feedback is separate and requires adopter-provided
managed RPCs; native `db/platform` has no hosted-feedback binding or added route.

The Node-only `@openlup/platform/commerce/server` effect consumers accept the communications owner's existing payload
parser, transactional-email scaffold and outcome mapper through typed host
bindings. The reference binds the existing fulfillment payload parser, transactional scaffold
and outcome mapper; commerce defines no second implementation. The fulfillment
parser is exported unchanged and also serves the frozen subset handlers. Reference-only test fixtures exercise recipient, dedupe and
provider-refusal outcomes. Neither these helpers nor the commerce registry
construct a new worker, emitter or runtime schedule. Locale, presentation and
provider policy remain in the reference composition.

Invoicing service composition stays in the platform `/invoicing` entry. The
reference host selects its existing accounting executor and job lease explicitly;
module readiness runs before claim. Contributions describe existing registrations
and install no scheduler. Native collection, issue and read-side helpers keep
host identity, auth, transport and transaction ownership at the existing seams.

Native accounting duty collection has an explicit independent runtime binding;
fulfillment composition no longer constructs or awaits an accounting binding.
The collector is host-invoked and does not register another executor or scheduler.


The host status-map, normalized-fact and current-parcel facades delegate to
`@openlup/core/fulfillment`, retaining host names and private provider trace
metadata. Browser import inventories declare only the core fulfillment modules;
platform fulfillment remains outside browser runtime graphs.

The native automatic-renewal hook accepts the runner’s optional `occurredAt`.
Its delivery-alignment store decorator preserves the static terms gate and marks
only native admission denials as deferred. The runner and batch return
`deferred` before reservation or preparation, with no terminal refusal write;
the operation stays claimed and the same schedule is offered only after lease
expiry. Static gate refusals remain terminal. Direct hook callers that omit
`occurredAt` use the decorator’s clock. This changes neither the PostgreSQL
renewal adapters nor cycle-insert receipt enforcement. The decorator also accepts
the package renewal-store contract: that overload preserves its typed schedule
and admission state, while existing root callers keep their original result
shape and optional clock behavior. The M10 reference binding selects this same
G23 seam rather than implementing a separate admission policy.

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

The reference invoice panel reads the authenticated host summary route through
`referenceInvoicingClient`. It retains session gating and query/retry behavior,
while displaying closed diagnostic codes without raw provider text or URLs. The
browser does not import the invoicing server entry at runtime; runbooks and
mutation routes remain host-owned.

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

The browser-safe `@openlup/platform/commerce` entry exports only schemas, pure
helpers and ports. Its graph never imports `commerce/server`; a browser bundle
and source-boundary witness enforce the split. The Node-only server entry
reuses the existing paid-fulfillment factory through `fulfillment/index.js`.
Only files under `commerce/server/` admit that value edge in the module graph.
Locale remains a host-supplied type parameter, with no communications server
dependency or optional PostgreSQL types.
Commerce/contracts retains its isolated type-only surface. Outbox rail
composition is an injected `uniqueRegistry` function, bound by the reference
host to `@openlup/outbox`; the platform adds no rail dependency or copied
composition algorithm.

The Node-only commerce server entry also exports `tryCompensate` with an injected
`CheckoutCompensationPort`; the reference compensation file re-exports the same
function. Reservation release, promotion cancellation and conditional
abandoned-order cancellation retain their ordering, keys, reasons and best-effort
warnings. Persistence and payment execution stay host-bound. The cold consumer
exercises installed compensation.

The server entry also owns checkout handlers, runtime and the shared paid-order
saga. Its additional value edges are pricing, shipping and promotions; HTTP and
BFF edges remain type-only. Host schema/response, subject, metadata, starter-policy
and existing payment callables are explicit bindings; host configuration and
application routes retain their owners. Saved-method alias and recurring metadata
use host-defined string type arguments, preserving reference wire values without
publishing provider unions. Offer binding precedes quoting, accepted
shipping/acquisition terms require acceptance, and scoped contention or uncertain
dispatch cannot authorize compensation. Neutral conformance and reference binding
suites cover those seams. The cold consumer also exercises installed continuation.

Generic draft/finalize/intent/resume stores, cancellation and sweep adapters also
live at the server entry; structural clients and host schemas/projections preserve
RPC arguments and table filters. Phone normalization is injected and verified
identity is stamped last. Bounded recovery classifiers inject subject admission
and compare shipping terms, while token state classification grants no route
authority. Recovery services, projection and application routes retain their
owners. The C2 release handoff is to be released; unit recorders do not prove SQL
atomicity or active-subscription preservation.

The physical-table availability projection also lives at commerce/server over a
structural query client and a required host provider predicate. Its pure ladder
is browser-safe commerce; SDK narrowing stays in the reference adapter. The
physical port and any host `functionMissingFallback` are separate capabilities
without the ATP guarantee: they do not subtract due subscription demand or
channel exposure.
The reference reservation allocator imports M06's policy, retaining scoped lock-error
translation and original retry keys locally. The existing M06 normalized read
composition passes its selected port through unchanged; PostgreSQL binds the
native ATP reader when the host supplies `stockSourceKey`. Private preview
transport remains host-owned.

Effective bundle selection reuses pricing's half-open authority through its
public server entry, adding the catalog → pricing value edge. The dependency is
acyclic; pricing owns no runtime catalog edge. The opt-in adapter keeps effective
SQL internal and leaves browser contracts type-only and incumbent SQL unchanged.

Inventory remains a non-adapter entry with no catalog import; its bundle-stock shapes are declared structurally. Admin handlers bind host response writers, and native reads require the provider value and validator. The new-purchase projection takes normalized reads, host defaults, fallback, observation and availability calculation; transports and cycle writers retain their owners.

Reservation policy has an unchanged server counterpart; the reference keeps browser-safe local values and forwards DTO types only. The native renewal reservation factory takes a structural executor and preserves its fenced reserve/release/expiry SQL, defaults, errors and readback. Its inventory-only port does not own subscription cycle, anchor, due or attempt writing.

Catalog now also owns fixed-bundle application/admin factories at its existing
entry. Its data/http/bff inputs remain type-only: the native read
store takes the data entry's executor without constructing a driver or pool.
The physical-table availability projection also lives at commerce/server over a
structural query client and a required host provider predicate. Its pure ladder
is browser-safe commerce; SDK narrowing stays in the reference adapter. The
reference reservation allocator imports M06's policy, retaining scoped lock-error
translation and original retry keys locally. The existing M06 normalized read
composition passes its selected port through unchanged; PostgreSQL binds the
native ATP reader when the host supplies `stockSourceKey`. Private preview
transport remains host-owned.

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
`createCommerceContribution` in `@openlup/platform/composition` declares the
installed `./commerce`, `./commerce/contracts` and `./commerce/server` entries
under the `commerce` capability. Its namespaced ports describe the selected
existing callables; routes and triggers share those same executors. Duplicate
handler, route or schedule identities refuse before map construction. The
[reference binding](../../server/runtime/public-reference/m11CommerceBinding.ts)
adds native recovery through the existing adapter and accepts already-bound
package operations with their host schema requirements. It creates no checkout,
payment, inventory or fulfillment engine. Schema admission and host installation
remain separate from this inert declaration.

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

The fulfillment entry also exports its existing `parseOutboxPayload` helper.
K4 reference email bindings reuse that same parser through the host runtime;
paid handoff retains the identical schema parsing, issue paths and 300-character
reason truncation. Its paid-handoff descriptor is also exported and rebound by
commerce, retaining one event-type/timeout definition. These exports add no
dispatch behavior or worker registration.

Pure fulfillment presentation lives at the existing `@openlup/core/fulfillment`
subpath: the status canon, actual-evidence tracking progress, current-parcel
selection/attribution and parsers narrowed to the canonical status union. Its
[local sources](../../packages/core/src/fulfillment/index.ts) have no I/O or platform
dependency. Generic core fact types retain their names; narrowed aliases use the
`Canonical` prefix. Platform fulfillment lives at three existing-package subpaths:
`@openlup/platform/fulfillment`, `/fulfillment/contracts` and the opt-in
`/fulfillment/omnipack` example. `@openlup/platform/fulfillment` keeps compatibility
re-exports of the core presentation, and `/fulfillment/contracts` re-exports the
shared status and progress types. The type-only contracts entry has no runtime or
server edge; its dependencies are core fact, status, progress, payment-status and
subscription-status types. No topology trigger requires another package or
dependency. Platform owns the server orchestration and selects only injected
capability profiles. Provider,
carrier and service remain independent; empty provider selection refuses, and
potential support never enables a dormant route. Raw commands, credentials and
signed label URLs stay transient at the host/adapter boundary; durable contracts
carry typed facts, safe references and actual-command fingerprints. Reference status-map, normalized-fact and current-parcel facades delegate to
`@openlup/core/fulfillment`; the status facade adds only private provider trace
metadata. Account order UI imports progress values and types directly from core.
Browser graphs declare only core fulfillment modules and exclude platform
fulfillment, the reference preparation binding and the account order screens.
The order-management status ladder/queue pair remains host-owned.

Adopters may supply the optional local, opaque, shadow-only command fingerprint through `runFulfillmentDispatchWorker.shadowCommandFingerprint` (validated as lowercase 64-hex) and read the optional `submissionAttempted` / `responseBodyRead` dispatch facts, while the package's D6 classification remains the default.

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
explicit invocation. Sync exceptions are safe Errors with typed refusal fields;
provider failures retain bounded diagnostics for host failure mapping. Product
reads preserve donor pack evidence and admit nonblank SKUs through encoded paths,
with deduplicated reads and visible per-SKU failures for unrepresentable segments;
see the example contract for exact admission and counter semantics. No route, schedule or default binding is installed. Root
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
second attempt. For an unchanged stage/live fingerprint, contact revision and selection,
replay preserves the stored evidence JSON, including legacy five-field evidence;
new transcript/mapping metadata alone never consumes the native remap allowance.
Unknown/submitting/failed states never automatically POST;
accepted proof repairs a lost local ACK without a provider call. Only a
post-dispatch ACK failure triggers readback and an attempt to finalize accepted
proof as uncertain with its external reference retained when acceptance is not
already committed. Loop-start and concurrent-begin recovery ACK failures reach
the outer catch without that rescue.
Main and repair ACKs use identical host acceptance keys, ignoring adapter-provided
key fields so a committed ACK replays after a lost response. Mapped evidence now
retains item count, SKU/quantity/lot/expiry, delivery kind and pickup-point reference,
the contact revision and provider/carrier/service selection, and worker source,
mode and shadow flag. Durable dispatch transcripts/receipts, observation and provider-status evidence,
reconciliation quarantine evidence, and worker diagnostics share one counted
string sanitizer at their output projections. Provider-derived strings must
match the existing opaque-ID rule `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` or an
explicit adopter codec; refused values become null (required references use
`redacted`; refused tracking numbers drop the entire reference) and increment
`redactedFieldCount` in the existing evidence or
diagnostic envelope. Each field is counted once using its admission codec;
counts survive repeated native projection. Host-owned acceptance/attempt/label
and event keys, fingerprints and identities built from admitted parts pass through
unchanged. Timestamps use RFC3339 validation, preserving identity-bearing bytes,
and never use the token sanitizer. Expiry additionally
requires a real `YYYY-MM-DD` calendar date. Under the strict default, provider
tracking URLs require query-free, credential-free HTTPS and the adopter's approval at each projection
that retains them, including reconciliation tracking
codecs and native observation-store options; omission redacts the URL. Host-built
tracking URLs pass unchanged, including query strings. Forward the
same `approveReference` and `trackingUrl` codecs through ingress/native-store
`observationCodecs`, conformance-subject `observationCodecs`, and reconciliation
`trackingCodecs` when using wider references or approved query data. The optional
`trackingUrl` codec overrides the query/fragment default; HTTPS, no credentials
and host approval still apply. These use the same sink sanitizer and URL policy. Occurrence
identity hashes original provider status/subStatus bytes, so redaction cannot
collapse distinct occurrences. Arbitrary properties, contact fields, raw JSON,
credentials and signed URLs are omitted. The
[exhaustive field sweep](../../packages/platform/test/fulfillment/omnipack/dispatchReconciliationParity.test.ts)
and the [observation ingress sweep](../../packages/platform/test/fulfillment/omnipack/observationIngressParity.test.ts)
feed five sensitive-value shapes through every provider string input and capture
native write arguments, evidence callbacks, transcripts, checkpoints and diagnostics,
including provider exceptions and accepted-ACK recovery. The native mocks check
whole-receipt equality on replay and timestamp types at observation ingestion.
Donor colon keys retain original occurrence bytes, including minute-precision
timezone offsets admitted by the occurrence codec; the sink does not revalidate
or hash these keys.
The command fingerprint still commits to the transient
provider command bytes. Shadow instead builds a local command identity from the
host candidate; it requires neither a provider port nor provider preparation or
credentials. Legacy `0.22.0` native shadow drafts/attempts do not replay under that
new identity; complete or abandon them before upgrading (see the package
[migration note](../../packages/platform/CHANGELOG.md#unreleased)). Host readiness
and selected capability checks still apply.

Dispatch results retain neutral typed error code, HTTP status, retryability and
ambiguity. Local failures retain a machine cause/SQLSTATE under their stage;
unstructured exception prose is omitted. Redirect refusal remains conservative
and names `redirect_refused`; a definitive unreadable 400 remains a rejection.
After acceptance, failed ACK finalization retains `dispatch_acceptance_write_failed`,
a safe ACK cause and the external reference with ambiguity. Recovery ACK metadata
names the persisted external-reference proof and `noProviderPost`. The native
store reads back the original acceptance JSON so a created ACK replays exactly,
including recovery metadata. Native accepted-result JSON persists this evidence;
the existing SQL finish operation discards non-accepted result detail, so durable
rejected/unknown error retention remains a gap at that store boundary. No SQL or
command-ledger authority is changed by these TypeScript projections.
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
with native obligation/acknowledgement persistence supplied by
`createPostgresPaidFulfillmentHandoffStore`. Native stores bind the callable
ports to PostgreSQL; host composition still owns handler integration.

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

Ingress returns a typed `FulfillmentIngressResult` with a receipt ID, replay and
tracking counters, and counted admission diagnostics. `fulfillmentIngressHttpResult`
projects safe HTTP status/message classes for a host to apply: accepted outcomes
map to 200, untrusted to 403, disabled/not-ready or retryable refusals to 503,
and other refused input to 400. It installs no HTTP route. The host may return its
own durable `receiptId` from `recordObservation`; otherwise the durable event key
is the receipt identity. Supplied invalid timestamps (including non-string and
empty values) refuse before lossy mapping or persistence and increment
`counts.invalidTimestamps` with `diagnostics.invalidTimestamp`; absent/null
occurrence remains unknown and is not counted. Rejected correlation fields refuse
the event with `counts.rejectedCorrelationRefs` and a matching diagnostic, without
returning the rejected values. Rejected tracking
numbers and URLs are counted in both the observation admission diagnostics and
ingress result. A superseded conflict persists and returns `supersededCause`, a
safe machine identity supplied by the host classifier or the typed error's reason;
unsafe or absent causes become `fulfillment_state_conflict`.

The example webhook uses the contributed colon event key, retaining original
occurrence bytes rather than normalized timestamp bytes. Fact IDs remain hashes
and fact fulfillment references retain core opaque-ID validation. By default,
correlation, tracking numbers and service references require the prior opaque-ID
shape: 1–128 ASCII letters/digits or `._:-`, starting with a letter/digit.
The optional `observationCodecs.approveReference(value)` is a pure allowlist on
original references. An adopter can explicitly admit incumbent slash/space shapes,
for example by matching a known identifier grammar plus the default opaque grammar
and returning false otherwise. Admitted values are trimmed for correlation and
tracking; the event key preserves original admitted reference bytes. Even with the
allowlist, blank/overlong values, controls, email addresses and URLs are refused.
Rejected tracking-number entries and every supplied service/URL spelling are
counted before extraction or first-wins deduplication, including malformed values
and discarded duplicates. Rejected service references are omitted and counted as
rejected tracking references. Service admission precedes carrier derivation: a
refused service suppresses its derived carrier even if the prefix looks opaque.
The durable sink independently suppresses a carrier paired with a refused service.
The adopter owns the privacy of its widened grammar; allowing arbitrary prose
would permit contact/credential text into durable keys and fields. Correlation
cannot silently place refused text into the event key. Generic ingress composes no vendor
keys: the host must preserve its existing status/tracking/stock/handoff key builders
and durable receipt namespace when switching from the donor. This compatibility
does not cover native 0.22.0 digest receipts/effects or superseded outcomes: retries
can repeat tracking or fail with `fulfillment_observation_outcome_conflict`.
Drain in-flight observation retries before upgrading; see the
[Unreleased migration note](../../packages/platform/CHANGELOG.md#unreleased).

The adapter's optional `observationCodecs.normalizeCarrier({ carrierRef, serviceRef })`
returns the normalized carrier kind stored in `carrierRef` and passed to effects as
`carrierKind`. Its default uses the contributed service-derived lowercase carrier
prefix, or null without a service-derived kind. Donor deduplication drops raw
carrier codes; there is no raw-carrier fallback. A refused service cannot reach this derivation or
the carrier codec. `observationCodecs.trackingUrl(url)` may retain
adopter-required query parameters; HTTPS, no credentials and `approveTrackingUrl`
still apply to its output. Without that codec the default also rejects query and
fragment components. For example, configure approval for an exact tracking origin
and a codec that returns the URL only when every query key is in the adopter's
allowlist, returning null otherwise. The host owns that policy and retention of
any permitted query data. No adopter dictionary is embedded in generic code.

Strict occurrence validation is local to the webhook ingress pre-check, where
invalid supplied timestamps are refused and counted. Compact offsets such as
`+0200`, minute precision and timestamps without a zone retain base acceptance;
original bytes still identify the webhook. The shared timestamp parser remains
unchanged from PR2 for reconciliation, `createdAt` and stock movements.
With Zod 4.6.6, the ingress explicitly admits minute precision as well as the
default seconds/fractions precision. Both branches enforce calendar validity;
compact offsets are expanded only in the validation copy, never in receipt-key
input. The existing replay witness and invalid-calendar cases protect that
compatibility boundary when the validation dependency changes.

O3 deliberately retains a typed fact and an opaque raw-event pointer. The host
must retain the referenced evidence under its own access and retention policy;
the pointer/digest alone does not store the raw event. Invoice callbacks remain
host composition, including any intended fail-soft production wrapper. Ingress
keeps stock → handoff → tracking → invoice awaited and fail-stop, delivered-first
suppression and first-wins tracking deduplication. It calls no replacement delivery
confirmation or subscription alignment operation.

The operator lifecycle handlers preserve the host's mutation schemas and response
receipts. Every mutation callback requires the authorized actor and idempotency
key; the host must bind both into its replay fingerprint and commit all effects
and the response receipt atomically. Provider payloads and signed label URLs in
operator mutation inputs stay transient at this host boundary; they are not safe
durable evidence for the native stores. Replacement creation remains a host-owned
transaction: it checks paid state, current parcel, contact, blocking holds and
stock reservations, releases only fulfillment-exception holds and creates the
successor with its predecessor and sequence. Requesting or replaying a replacement
neither dispatches it nor attests arrival. The port has no confirmation operation.

The customer delay projection accepts current host rows and the subscription's
current next-cycle schedule. A missing map entry means no current customer case.
Only protected cases and aligned cases whose aligned schedule still equals that
schedule are exposed; advanced aligned history and manual-review cases remain
hidden. Manual review never implies protection. The projection changes no control
mode, schedule or delivery fact. The current-parcel helpers select the highest
sequence, then identifier descending, and retain unattributed companion rows.

The [commerce read models](../../packages/platform/src/fulfillment/commerceFulfillmentReadModel.ts)
assemble host-provided lines, address snapshots, operations, reservations, active
tracking references, holds and cycle statuses. Payment status is already projected
by the payments owner and passes through unchanged; eligibility is delegated to
the existing host commerce policy. Missing required list context fails rather
than inventing an order or payment. Snapshot projection retains only the declared
address fields. The [overview handler](../../packages/platform/src/fulfillment/shipmentsOverviewHandler.ts)
checks method, authorization and filter before its host read, then validates the
response with a required host-supplied schema. Bucket rows remain opaque to the
package; the host schema retains private-row validation. The host owns privacy
and date-filter semantics; native shipment counts cannot replace its buckets.

[fulfillmentProgressPresentation](../../packages/platform/src/fulfillment/trackingProgress.ts)
accepts the host's resolved customer step, order status, optional nullable payment
and fulfillment statuses, optional customer step and timeline event types. Only recorded
physical milestones complete, capped at that step; later progress does not imply
earlier milestones or payment. Paid completion requires the existing succeeded
or historical paid account payment spelling. Terminal, draft, expired and off-track
orders have no progress spine. OrdersScreen uses this projection with its existing
labels, step resolution and payment recovery controls.

### Native parity boundaries

| Capability | Native installation boundary | Required host binding |
| --- | --- | --- |
| Replacement creation | Unsupported; no shipment, reservation, hold, receipt or outbox write | Atomic replacement port |
| Operator lifecycle mutations | Unsupported; the native shipment spine port does not carry the operator transaction | Actor-bound mutation callbacks and replay receipts |
| Commerce orders list/detail and shipments overview | No equivalent native commerce read | Host read callbacks for orders list, detail and shipments overview; payment status passes through the existing payments projection using core payment-intent statuses |
| Dispatch preparation writer | Explicit host preparation binding synchronizes revision, provider and withholding under the shipment lock, including authoritative edits | Required host reader/edit closures and transaction lane; disabled, capability-selection/readiness and unsupported-dispatch refusals precede the shared typed refusal for an absent binding, all before any worker |
| Enforcing delivery alignment | The [host admission decorator](../../server/runtime/subscription/deliveryAlignmentRenewalStore.ts) preserves static terms and captured cases, skips off/no-case admission and obtains one-use schedule receipts before new cycles. Native denials return non-terminal `deferred` results, leaving claims retryable at the same schedule after lease expiry; static refusals remain terminal | A host that composes the native automatic-renewal runner must wrap its store port with the decorator; until it does, native delivery-alignment mode stays off or shadow. No runner composer, factory or production entrypoint is supplied |

`createNativeUnsupportedFulfillmentPorts` returns the single typed
`FULFILLMENT_NATIVE_UNSUPPORTED` refusal for replacement, operator mutations and
customer alignment rows, commerce list/detail and shipments overview. It has no
database executor and performs no partial
write or substitute operation. The refusal is accepted by
[`FulfillmentReplacementPort`](../../packages/platform/src/fulfillment/contracts/replacement.ts),
[`FulfillmentOperatorMutationPort`](../../packages/platform/src/fulfillment/contracts/operator.ts),
[`FulfillmentCustomerAlignmentRowsReader`](../../packages/platform/src/fulfillment/contracts/customerAlignment.ts),
and the [commerce and overview read ports](../../packages/platform/src/fulfillment/contracts/read.ts);
[`readFulfillmentDelay`](../../packages/platform/src/fulfillment/delayReadModel.ts)
propagates it. The commerce and overview handlers return this refusal as
UPSTREAM_UNAVAILABLE with its typed details. Dispatch preparation checks activation,
capability selection/readiness and dispatch support before returning the shared
typed refusal for a missing host binding, all before invoking a worker.
Supplying a host fixture proves that seam's
handler behavior; it does not establish native parity or activate any route.

The [verified ingress](../../packages/platform/src/fulfillment/verifiedIngress.ts)
and [reconciliation worker](../../packages/platform/src/fulfillment/providerReconciliationWorker.ts)
use approved G17 inline host persistence. Ingress requires recordObservation to
atomically deduplicate eventKey and retain firstReceivedAt, and markProcessed to
be idempotent. Host lifecycle writes must also be idempotent so retries after
interruption create no second durable effect. Reconciliation reads local status,
then ACKs acceptance, then reads latestStatusOccurredAt through separate local
persistence methods. readHandedOverAt runs only for stale/exception invoice
recovery. The native store retains its combined read for existing callers, but
this worker uses the split reads so an unused handover query cannot fail a row.
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
Unknown readback stays row-local: recognized rows still process. Unmapped evidence
projects eventKey and declared correlation fields before host calls; correlated
off-track rows skip acceptance/quarantine, while other rows require an external
reference before acceptance and unknown-status quarantine. Effects retain
stock → handover → tracking → invoice order. Tracking keeps the first trimmed
nonblank number and provider-carrier precedence; normalization/URL codecs stay
injected.

The separate `runFulfillmentReconciliationPage` operation consumes an explicit
observation-page port. It resumes a validated version-1 `reconciliationPagination`
checkpoint with the same page size; invalid or resized checkpoints start at zero.
A traversed full page advances even when individual items fail, while a
short/empty or exhausted page resets to zero. A failed or thrown page read also
resets to zero; an abort after the read but before traversal completes retains
the current page. Mapping refusals stay row-local and preserve page
cardinality; invalid occurrence timestamps normalize to null before mapping.
Recognized siblings still process around row-level unknowns. `providerCalls`
counts each attempted logical page-port read, including failed/exhausted reads;
transport retries are separate. The return value contains result counters, a
200/502 status projection, succeeded/failed ledger status and checkpoint metadata.
The host owns HTTP, cron, ledger writes and checkpoint persistence; no process is
installed. The opt-in example exposes this port as `adapter.reconciliation`,
decodes only its specific exhausted-page 400 into `page_exhausted`, and retains
other read errors as failures. The exact `readback.read` operation still requires
one unique match from an explicitly complete single page and never infers absence.
Reconciliation evidence and occurrence identity retain primary/subStatus tokens,
so distinct packed aliases remain distinct facts while identical rows replay.
Unknown status rows correlate and ACK before quarantine; off-track unknowns stay
benign. Accounting refusals retain safe accounting identifiers and SQLSTATE while
preserving the permanent/transient distinction. The
[parity witness](../../packages/platform/test/fulfillment/omnipack/dispatchReconciliationParity.test.ts)
uses synthetic probe inputs to exercise these boundaries without a provider.

[Stock sync](../../packages/platform/src/fulfillment/providerStockSyncWorker.ts)
uses approved G15 coverageGapSkus on SyncCursor: absent is empty, and only the
preceding succeeded run can confirm a repeated sellable coverage gap. A completed
run writes the sorted current set on success or [] on operational failure; running
cursors preserve the prior set, as does a malformed run with no valid stock rows.
The failed status prevents that retained set from confirming a gap in the next run.
Approved G16 makes readLocalInventoryStock(requestedAt) return
unaggregated lines with skuRef, quantity balances, fulfillable/location/lot status
and expiry. The worker filters and sums at the same captured clock passed to
active-reservation reads; expiry exactly at requestedAt is unusable. The provider
inventory authority remains unchanged. Host compatibility inputs preserve original
run IDs, sentinel, keys and movement-window time zone.

Stock and movement reads can return a rejected row with its input index and the closed
`invalid_sku_ref` reason. The worker counts every rejection, persists it with a
null SKU and a `kind` of `stock` or `movement`, and continues current/snapshot
writes for valid rows. A mixed valid/rejected batch succeeds: alert evaluation,
SKU evidence resolution and stale recovery proceed for valid SKUs, coverage
confirmation is retained, and `lastStockSyncedAt` advances. Success requires a
valid stock row or a genuinely empty stock response. A nonempty stock response
with no valid stock rows finishes malformed and non-retryable even with valid
movements, preserves prior coverage gaps and cannot resolve stale alerts. An empty
stock response with entirely rejected movement rows also fails as malformed.
Operational failures retain their failure and retry semantics. Rejections remain included in both the `rejected`
and `failures` counters even on a successful mixed run. Unsafe references never
reach the store; the worker skips blank stock SKU references before classification
and persistence, preserving base behavior. Valid movements still contribute to
counts and the latest occurrence.
Hosts consuming `getStock()` or `getStockMovements()` directly must discriminate
`"kind" in row && row.kind === "rejected"` before accessing observation fields.
Item write failures retain an operation-specific reason and, when available, a
SQLSTATE in both the per-item result and failed `SyncCursor.error`; arbitrary
exception prose is discarded. Operational reasons take precedence over rejections
in the failed cursor; retryability follows operational failures independently of
rejection counts.

Provider failures return `ok: false` with neutral `providerError`, when the provider
supplies a typed failure, carrying operation
(`get_stock` or `get_stock_movements`), status, sanitized code and retryability,
and persist that diagnostic in a terminal failed cursor. Stock failure projection
keeps exhausted network reads retryable; stock redirects report `redirect_refused`
and are non-retryable without another GET attempt. Product-sync retains base
client diagnostics and retries, including a non-retryable final network failure.
Disabled, not-ready and bad-identity adapter refusals preserve their typed reason
and retryability in result `refusal` and the failed cursor, without a providerError.
A host may map a failed result to its job's HTTP 502; the
package installs no HTTP wrapper. Terminal cursor-write failure still rejects,
so callers must handle persistence failure rather than assume evidence exists.
Compatibility: cursor reads, running-cursor writes, local stock/class/reservation
reads and stock/evidence writes or SKU evidence resolution now also resolve
`ok: false` instead of rejecting when a terminal failed cursor can be persisted.
Stale-sync recovery resolution runs after the succeeded terminal cursor; its
best-effort cleanup failure leaves that cursor and the successful result intact.

The native stock port retains run identity, counts, item ATP observations
(`activeReserved`, `sellableNow`, `coverageGapQuantity`), alert quantities and
stale gap hours/threshold/detection time in the existing cursor JSON column.
These observations describe warning evidence, not a new ATP admission policy.
Cursor evidence is the latest run and is overwritten by the next run; dedicated
immutable snapshot/alert evidence columns remain a follow-up gap. Current and
snapshot rows keep their existing sync-run columns. Alert fingerprints include
only `requestKey`, `skuRef` and `thresholdKind`. Quantities, severity and run
evidence may change under the same key and return `replayed: true`; a different
SKU or threshold uses a different host key. Reusing a key for a different SKU or
threshold retains the SQL conflict.

The native forward `20261022165000_fulfillment_stock_evidence_replay_reopen.sql`
closes the scheduled alert refresh/reopen gap. A matching identity replay sets
status to `open`, refreshes severity and both quantities (including SQL NULL),
uses `clock_timestamp()` for `last_seen_at` and clears `resolved_at`. It preserves
the row ID, first-seen time, fingerprint and historical `last_sync_run_id`.
The existing resolver can resolve that reopened alert again; an active threshold
remains exempt. The SQL compares the supplied opaque fingerprint and retains
SQLSTATE `23505` for a mismatch. Existing-row replay and resolution serialize on
the row lock; the last lock holder wins, without a chronological freshness promise.
Concurrent first inserts can still conflict, and callers updating multiple rows
must retain consistent lock order. See the [real PostgreSQL replay proof](../../tests/postgres/fulfillmentStockEvidenceReplay.test.ts).
Install the complete canonical catalogue through this forward before stock adoption;
the managed baseline already refreshes/reopens its corresponding evidence.

Migration: alert rows written by 0.22.0's native port carry the earlier whole-input fingerprint; subsequent writes under those keys conflict with SQLSTATE `23505`, and resolve only marks the row resolved while retaining its key and fingerprint, so it does not clear the conflict. Legacy fingerprints are documented only; this change does not rewrite them.

See the [stock parity tests](../../packages/platform/test/fulfillment/stockSync.test.ts)
for native replay, and the [adapter factory tests](../../packages/platform/test/fulfillment/omnipack/factory.test.ts)
for failed cursors, diagnostic safety and mixed admission boundaries.

Product
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
Native database atomicity and arrival alignment have separate PostgreSQL
conformance sources. The runner
requires default-off adapter capabilities, and the workers/handlers are unmounted;
no live provider or installation claim follows from fixture proof.

[Delivery alignment](../../packages/platform/src/fulfillment/contracts/alignment.ts)
preserves the arrival-only rule: late delivery extends the next cycle, never stacks
deliveries or moves it earlier. A replacement may settle alignment as `aligned`
only after reaching the customer. Its superseded predecessor is no longer
outstanding, but an in-flight or undelivered replacement still is. Never call
`subscription_delivery_alignment_confirm_replacement` for a replacement that did
not arrive: it records the customer-facing fact "Parcel delivered" and shifts the
cycle later. The note-only operator attestation has no machine arrival predicate
and no production caller in this surface; the
[agent arrival-only rule](AGENT_GUIDE.md#architecture-rules) remains binding.

The invariant "a late delivery extends the next cycle" is enforced automatically
only when native delivery-alignment control mode is set to `auto_align`.
`public.subscription_delivery_alignment_control.mode` defaults to `off` for
rollout safety. Installation alone does not enforce the invariant. The accepted
modes are `off`, `shadow`, `protect` and `auto_align`, selected through
`public.subscription_delivery_alignment_set_mode`. Cases retain their captured
mode and existing protection after later control changes.

Enforcing modes (`protect`, `auto_align`) require the host's renewal path to call
`subscription_delivery_alignment_admit_renewal` before inserting the cycle.
The [native renewal store](../../server/adapters/postgres/subscription/automaticRenewal.ts)
does not call it; a host that composes the native automatic-renewal runner wraps
that store port with the
[renewal admission decorator](../../server/runtime/subscription/deliveryAlignmentRenewalStore.ts).
Without the decorator, an enforcing mode halts every autonomous renewal with
`subscription_delivery_alignment_admission_required`, so native installs keep
mode `off` or `shadow` until the host wraps the port.

In enforcing modes, a subscription whose paid history has no activation or
renewal link, such as imported data, holds every due renewal for manual review.
Operators should check for such cycles before switching modes.

Automatic arrival alignment uses the latest arrival plus cadence with an outer
`GREATEST` against the existing next-cycle date, once per settled case.
Subscription locks precede case locks; rollback preserves both protection and
the previous schedule.

The native forwards
[`20261022080000_fulfillment_command_ledger.sql`](../../db/platform/migrations/20261022080000_fulfillment_command_ledger.sql)
and [`20261022090000_fulfillment_delivery_alignment.sql`](../../db/platform/migrations/20261022090000_fulfillment_delivery_alignment.sql)
add command fencing and alignment. Donor fulfillment orders map to
`public.fulfillment_shipments`, and `replaces_fulfillment_order_id` maps to
`replaces_shipment_id`. Subscription identity follows order → cycle →
subscription. [The native translation decision](plans/oss-m08-fulfillment-physical-delivery.md#native-admission-and-delivery-alignment) maps donor activation cycle 1 ↔ native activation ordinal 0, and donor
renewal n+1 ↔ native renewal n. The activation ordinal requires a cycle with no
renewal operation whose linked order is the active `subscription_activations`
row's order for the same subscription. Renewal operation numbers remain ≥1.
Admission selects the highest known paid ordinal, so activation protects the
first renewal and each later paid renewal outranks activation. Successor
artifacts have a greater effective ordinal. Other unnumbered cycles remain
unordered: paid ones require manual review at due admission without minting a
receipt; other unordered cycles prevent automatic arrival alignment regardless
of scheduled date. They neither outrank known predecessors nor silently permit
an autonomous renewal. Shadow mode observes this ambiguity without blocking.

Local pre-dispatch cancellation changes only the shipment locally: alignment
creates no hold or shipment-exception event and does not block other shipments
of the order. An undelivered, unsuperseded cancelled parcel still counts as
outstanding at renewal admission in `protect` and `auto_align`. An explicit
provider exception uses the existing fulfillment-exception hold and notification
rules; alignment observes that active hold to open a case only when control is not
`off`, the order belongs to a paid subscription cycle and the subscription is
active. One-time orders do not open alignment cases. Exception cases never
pause subscriptions.

The overdue-delivery guard applies only to NEW cycle
admission/insert. Existing-cycle renewal and dunning retries never pass through
admission and neither mint nor consume its one-use receipts. There is no
`retry_scheduled` state or change to the payments lifecycle.

[createFulfillmentServices](../../packages/platform/src/fulfillment/bindings.ts)
checks explicit activation, capability selection/readiness, dispatch support,
store/provider presence and host readiness, in that order, before invoking
the dispatch worker, including its write-capable stale-submission sweep.
`FulfillmentServicesOptions` carries in-memory ports and closures; credentials
remain captured by host adapters and must never be serialized with options.
[createFulfillmentContribution](../../packages/platform/src/composition/fulfillmentContribution.ts)
declares structural selected ports, handlers, schedules and routes. Core readiness
retains duplicate event, schedule and route ownership checks. The bundle composer
has an explicit fulfillment slot with no default binder.

Native dispatch uses host-supplied contact preparation and candidate data.
The [reference binding](../../server/runtime/public-reference/m08FulfillmentBinding.ts)
uses one transaction lane and selected store/provider/readiness observer.
It acquires the native dispatch advisory lock, then locks the shipment row before
reading authoritative data. Its edit callback requires actor and idempotency
attribution; the host owns authorization and replay receipts. Source edits and
redacted context synchronization share that transaction. All authoritative edits
must use this route. Disabled, capability-selection/readiness and
unsupported-dispatch refusals take precedence over the shared native refusal for
a missing preparation binding. Construction mounts and schedules nothing. The
host synchronizes `fulfillment_dispatch_contexts` during preparation and every
authoritative contact/selection edit under the shipment lock. Claim/begin compare
stored revision with prepared evidence. Submission rechecks paid state, holds,
shipment status, port readiness and selected provider. Direct and command lanes
share a dispatch lock; direct submission supersedes only pristine, never-claimed
queued commands, while effect-bearing history refuses it. ACK records native
`dispatch` evidence, fencing cancellation without asserting an owned label or
physical packing.

The native stores implement G14 mapped-attempt persistence, G15 coverage-gap
cursors, G16 injected timed inventory-line reads with native reservation reads,
and G17 atomic received/processed receipts plus separate status chronology.
Inventory authority is unchanged. All new routines, including helpers and
trigger routines, are invokers with `PUBLIC`, `anon` and `authenticated` access
revoked. There is no `SECURITY DEFINER` routine or new execution role. The initial
executor is the deployment owner; a separate service principal requires explicit
least-privilege grants on routines and underlying objects. Install the complete
canonical catalogue; `FULFILLMENT_MIGRATIONS` contains byte-identical sparse
projections. See [native installation boundaries](DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories).

Inspect the [contract witnesses](../../packages/platform/test/fulfillment/contracts.test.ts),
[status parity](../../packages/core/test/fulfillmentStatusMap.test.ts),
[port fit](../../packages/platform/test/fulfillment/portFit.test.ts) and
[programme record](plans/oss-m08-fulfillment-physical-delivery.md) for provenance,
declared adaptations and boundaries. The
[native store contract](../../packages/platform/test/fulfillment/postgresStore.test.ts),
[native conformance](../../tests/postgres/fulfillmentNativeConformance.test.ts) and
[alignment tests](../../tests/postgres/fulfillmentDeliveryAlignment.test.ts)
cover persistence and refusal behavior. Callable orchestration, native stores
and the durable command protocol mount no provider adapter, executor or route;
reference composition and activation remain host choices.

## Subscription contracts

The hosted failure port now carries applied-transition attribution end to end:
`applyFailedResult` returns optional nullable `paymentAttemptId` and
`openDunningCase` requires nullable `failedPaymentAttemptId`. The shared leaf
passes `applied.paymentAttemptId ?? null` even when application replayed; it
never infers a current/prepared attempt. Preflight, decline, action-required and
replayed action-required parent paths use this leaf. Managed fresh eligible NULL
attribution refuses SQLSTATE 55000. See the package changelog's Migration notes for this release
and [managed replay/host mapping](DATA_AND_MIGRATIONS.md#m10-9-attempt-replay-control-fixtures).
Native `RenewalFailureHandoffPort`/`RenewalStorePort` serve a distinct graph.
The [native retry store](../../packages/platform/src/subscriptions/postgresRetryStore.ts)
receives neither `openDunningCase` input nor `failedPaymentAttemptId`/`paymentAttemptId`;
there is no native attribution receiver to ignore the field. Native stores do not
yet implement duplicate failure-observation replay with attempt attribution.
Parity remains a REGISTERED follow-up with owner M10 and the migration owner's
explicit future acceptance.

Place server orchestration in the existing platform package's exact
`subscriptions` entry and browser-shareable declarations in its type-only
`subscriptions/contracts` entry. No new package, dependency, testing subpath or
star export is needed. The [package entry](../../packages/platform/README.md#subscription-contracts-and-renewal-port)
links to this owner for concrete carriers, the unchanged hosted
cycle/refusal/failure contribution and its characterization. Hosted RPC carriers stay distinct from native claims;
the local prepared-attempt type projection preserves the existing M07 shape
without a cross-module contract edge. Pure cadence/retry arithmetic remains in
`@openlup/core/subscription`; adapters own SQL translation and hosts own channel,
mandate, identity dialect, pricing, stock selection, trusted actor and copy policy.
Initial terminal replay in the native retry binding returns from the immutable
receipt before any settlement, rebinding or case propagation. Prepared retry
readback retains the existing non-terminal `retry_scheduled` disposition while
awaiting evidence. The native runner treats only explicit execution failure or
`requires_action` as synchronous refusal; bare failed status requires readback.
See the [host preconditions](CANONICAL_CONTRACTS.md#subscription-port-boundary)
for cycle correlation and frozen retry authorization.

A native prepare commits cycle/order/items/settlement/reservation and attempt;
a native outcome commits settlement, outcome, schedule/counter and reservation.
Verified recovery must bind the same cycle and commit settlement/receipt/case and
counter together. Managed create/prepare and failure RPCs remain separate units;
no transaction spans external payment execution. Never interpret missing ACK or
nullable money as permission to execute again. Frozen revision, fingerprint,
original timestamp text and nested snapshots survive retries and future edits.

Logical cycle number and native renewal counter are separate evidence-bound
fields; an activation or legacy ambiguity never licenses a blanket offset.
Future terms and receipts require an atomic command store.
Stock recovery is restricted to never-executed stock refusals, with transaction-bound
all-line reacquisition and fencing. A provider-owned or ambiguous attempt cannot
be reset by a wait ledger. The [design](plans/oss-m10-subscriptions-renewal-dunning.md)
keeps serving composition outside this implementation step. The package's native
renewal store consumes an injected executor and a required wire-snapshot codec:
the host supplies exact identity/fingerprint bytes, frozen revision and explicit
logical-cycle correlation. Existing operation snapshots take precedence over
mutable future terms. The retry store calls N1 without implementing M07 payment
execution, and preserves its prepare replay fence. The generic native executor
uses the P1 ports with injected input/identity/classification policy. The initial
binding opens the existing donor-keyed case first, then links N1 bookkeeping in
the M07 terminal transaction. Initial terminal replay reuses its immutable
failure receipt after later case changes or recovery; conflicting terminal
evidence still refuses. Subsequent failures retain their separate case advance. G23, transaction/correlation policy and runtime selection remain host
composition.

The native `createPostgresStockWaitStore` consumes N3 and the native M06 ATP
seam through an injected executor, transaction callback, worker identity and
wire-snapshot codec. Candidate discovery returns `StockWaitFrozenCase`, with a
nullable case for refused operations not yet captured. Frozen graph bindings,
deficits, original schedule and fingerprints remain distinct from mutable terms.
Frozen discovery requires an active subscription on its current schedule; paused
current waits remain open. Deficits report own reserved units separately from free ATP;
missing units subtract both from the requirement. Closed or pending-payment
resume callbacks return null without writes; paid fulfillment-pending orders
can complete realization admission.
Recovery checks schedule, generation and expired lease; N3 refuses any prepared,
acknowledged or settled payment graph. Stock locks and whole-basket rollback
belong to SQL. A resumed wait requires paid cycle/settlement, consumed stock and
a local fulfillment obligation; it records no parcel arrival.

`createPostgresStockAvailability` exposes read-only new-purchase ATP through the
native seam. Its fixed 14-day soft priority and native hard holds are both
protected; callers cannot request a renewal exemption, horizon change or excluded
order. Only the fenced renewal allocator uses that exemption. Native safety and
channel exposure are zero in this seam. This is no advance future-cycle hold or
one-time checkout mutation contract. Existing own commitments can remain admitted
when observed stock drops below them, matching the donor limit. No physical
coverage guarantee follows. The managed SQL surface has its own proof below.

[Native witnesses](../../tests/postgres/subscriptionStockWaitCases.ts) and
[stock-accounting witnesses](../../tests/postgres/subscriptionStockAccountingCases.ts)
cover refusal recovery, whole-basket rollback, fairness, X/Y replay and refund
independence. Capability selection requires passing real PostgreSQL evidence;
source installation and offline adapter tests alone leave stock recovery unavailable.
P8 owns serving composition and G23. No executor or schedule is installed here.

### Managed stock wait and ATP

The managed rail installs the service-role stock-wait SQL functions and shared
provider ATP seam. A managed `NewPurchaseStockReadPort` adapter is available
from the inventory entry through `stockRpc` over the managed forward
`20261025109000_inventory_new_purchase_stock_read.sql` (controlled
by the M11 control group). The TypeScript stock-wait port and `stockRecovery`
remain unavailable for package composition. The exported
`MANAGED_SUBSCRIPTION_STOCK_CAPABILITIES` values are unchanged. SQL behavior is covered
by [managed pgTAP/real-PG probes](../../tests/postgres/subscriptionManagedStock.test.ts);
these do not select a serving executor or prove a hosted installation.

M3 freezes the original unpaid cycle/order/payment binding and snapshots. Its
all-line reacquisition shares a subtransaction; shortage rolls back partial work
before recording waiting. Replenishment reuses that graph, and captured and
uncaptured candidates rotate independently of processing. Provider-owned or
ambiguous money cannot be reopened. Waiting retains the original schedule and
active subscription; late settlement/delivery supplies the later-only shift.
Stock secured is not payment, realization is not parcel arrival, and no payment
I/O runs inside these SQL transactions. M4 retains M2 recovery eligibility and
excludes waits before the normal LIMIT. M5 maps started/resumed transactional
notices and immediately admits positive customer cancellations to the existing
120-day, cancellation-episode-deduplicated winback scan.

Managed ATP subtracts live provider hard holds, fulfillable-location safety and
remaining active subscription demand within 14 days. Only the concrete
order/cycle allocator may use the renewal exemption; a one-time order cannot
obtain it through metadata or hold kind. Refund of cycle 1 or a renewal preserves
future-cycle hard holds and soft demand. The exposure hook is zero; current
donor global/channel admission remains deferred. Existing own commitments can
survive a lower fresh stock observation, as in the donor. The managed SQL does
not establish an advance reservation lifecycle or a package purchase-write port.
See [managed installation and refund boundaries](DATA_AND_MIGRATIONS.md#managed-stock-wait-atp-and-refund-parity).

### Renewal port recipe

The experimental `@openlup/platform/subscriptions` entry exposes the hosted
cycle, refusal and failure mechanisms with injected policy, identity forwarding
and an honest native capability descriptor. The browser-safe
`subscriptions/contracts` entry emits no runtime values. Its concrete carriers
cover frozen obligations, claims and leases, nullable verified payment evidence,
dunning repair, command receipts, stock waits and lifecycle message descriptors.
These declarations and mechanisms do not install a store or activate a runner.
Hosted compatibility snapshots stay host-owned; native frozen snapshots remain
concrete. The hosted blocked result remains `skipped`, separate from native
`deferred`. The [naming map](plans/oss-m10-subscriptions-renewal-dunning.md#unchanged-hosted-contribution-and-naming-map)
records the unchanged contribution and type-only M07 projection.
[Characterization](../../packages/platform/test/subscriptions/renewalCycleMechanism.test.ts) preserves
order, replay, receivers, raw errors and stored-null retry behavior.

Preserve original schedule text and all host-generated key bytes. A due listing
is not a lease. Logical cycle numbers require evidence-bound correlation with
activation and the native counter; legacy ambiguity stays explicit. Native
prepare/outcome/recovery transaction units differ from the managed RPC sequence;
external payment execution never belongs inside a database transaction. Reuse
`@openlup/core/subscription` for pure retry and cadence arithmetic.

Nothing in automatic renewal pauses an active subscription. Late delivery extends
the next cycle using the maximum of its existing date and latest actual arrival
plus cadence; it never moves earlier or stacks cycles. Never invoke
`subscription_delivery_alignment_confirm_replacement` for an undelivered
replacement: that operation records the customer-facing fact “Parcel delivered”.
After rollback to `off`, shadow cases are admitted. Captured protected cases
still go through admission and defer until actual arrival: `protect` releases
the case; `auto_align` settles as `aligned` using the latest arrival plus cadence
with the outer maximum, never earlier or stacked. `manual_review` cases, including
protected cases whose arrival meets open dunning or a successor cycle, keep
deferring until resolved. A deferred result preserves the schedule and may carry a
durable case.

Native N2 supports generic bundle commands and command-bound receipts through
`createPostgresSubscriptionCommandStore` and the P1-shaped
`createPostgresSubscriptionCommands` adapter. The host supplies one transaction
connection, trusted actor/client authorization and future-term SKU/composition
translation with address validation; address mutation remains unsupported. Preview
persists a quote separately; apply commits future terms, events and the receipt
together. Equal bundle fields, add-on quantities, plan length, native resize
lines/cadence, package templates and same-UTC-day slides return a terminal `noop`
preview before repricing, without a quote. For an unquoted direct apply, the native store probes
preview in a savepoint and keeps only a noop receipt; other probes roll back
before ordinary apply, preserving quote-required refusals without extra writes.
`originalState` is the subscription state stored by the original
execution, preserved on replay. Native refusals return `outcome: "refused"` and
a closed machine-code `reason`. Unrecognized PostgreSQL diagnostics and host
refusal text map to `subscription_command_invalid_input`; provider and customer
text never pass through. Under the actor/key lock, preview and apply compare
the original host request before calling `futureTerms`: a stored terminal receipt
returns immediately, and a matching stored preview supplies its already-bound
translation to apply. Later host address/catalogue changes cannot preempt replay;
changed requests still refuse as idempotency conflicts. The adapter refuses pause without writing. Existing native lifecycle
callers remain unchanged. Native multi-cycle prepaid and the M07 prepared-attempt
store retain named unsupported declarations. The unbound native descriptor keeps stock recovery unavailable;
the explicitly selected M10 reference binding declares it selected, with the
composed PostgreSQL witness. N1 retry recovery is selected after its store proofs. The
[Subscription port witnesses](../../packages/platform/test/subscriptions/portFit.test.ts) test
each port amendment, and the [native baseline](../../tests/postgres/subscriptionContinuityBaseline.test.ts)
exercises the complete current prefix without subscription SQL additions.

### Composed subscription module

`createSubscriptionServices` exposes one explicitly enabled host executor and
checks readiness before invoking it. `createSubscriptionContribution` in
`@openlup/platform/composition` describes one `subscriptions-renewal` schedule
bound to that same callable. Neither factory installs a timer or selects a
population. Disabled composition supplies no job; a selected module still needs
its run port and complete catalogue schema observation.

The [native reference binding](../../server/runtime/public-reference/m10SubscriptionBinding.ts)
composes the existing renewal runner, mandatory G23, N1 dunning and N3 stock wait
inside one host-owned durable population lease. Both normal-due and stock-recovery
rows use the existing `runRenewalBatchRows` isolation: a thrown row yields an
`error` result with `renewal_processing_failed` and later rows still execute.
Static admission precedes G23;
existing cycles, prepared attempts and retries bypass new-cycle G23. Off without
a captured case performs no G23 call; captured protected cases retain authority
after rollback. Denial defers without terminal refusal. Protect-mode arrival
releases the original schedule, whose expired lease resumes its stored snapshot.
The [composed real-PostgreSQL table](../../tests/postgres/subscriptionComposition.test.ts)
exercises off, protect, arrival, rollback, dunning, stock, prepared and static
admission, shared execution, frozen mandate refusal and committed replay.

Retry selection filters already paid/settled obligations before limiting the
batch. Ordinary retries require the frozen mandate and evidence-bound logical
cycle. Replacement-method authorization and consumption remain installed N1
store duties. A committed
prepare never authorizes another execution: the host must read that exact retry
attempt through M07, rather than reuse the aggregate's original payment handle.
`failureProgress` compares an immutable failure receipt with the durable case;
propagation completes an interrupted rung, while committed case progression
ends replay without rewriting cases, notices or events. These are invoker reads
under the existing host privilege model, with no new database object. Prepared
attempts remain reconciliation duties even when provider execution throws.

Stock-only recovery keeps the original frozen identity and claim generation.
`realizationAdmitted` delegates to N3 only after actual paid realization; stock
arrival alone cannot emit a resumed notice. No automatic renewal operation
pauses, suspends or interrupts an active subscription. Managed stock descriptors
continue to declare SQL surfaces and unavailable TypeScript recovery; the served
managed runner and account aggregation are unchanged.

`subscriptionLifecycleTemplate` maps existing lifecycle events plus M5 stock-wait
started/resumed events to M04 templates. Payment failures use the installed
numbered templates: attempt 1 selects `-1`, attempt 2 selects `-2`, and all other
values (including absent or zero attempts) select `-3`. The public
`SubscriptionLifecycleFact` type is also exported from `./subscriptions`.
`createSubscriptionLifecycleMessages`
forwards truthful typed facts and their original idempotency key to M04, without
inventing pause or parcel-delivery facts. The [reference facade](../../server/runtime/public-reference/subscriptionFacades.ts)
binds opaque recipient/template references to M04 transactional delivery, whose
receipt owns sending and replay. Rendering, consent and recovery-link authority
remain M04/host responsibilities. `createSubscriptionCommandExamples` supplies
neutral customer skip and operator slide examples through the existing command
port, preserving actor, time and key. Authentication and client authorization
precede this facade. M12 retains account aggregation. The installed consumer
covers enabled execution and readiness, actor and lifecycle-identity refusals.

## Invoicing contracts

`createInvoiceServices` and `createInvoiceContribution` are exported through
`@openlup/platform/invoicing`. Explicit provider selection and host readiness
precede factory construction or claim. Factories bind the existing issue,
correction, delivery, document/settlement sync, duty collection and history
services; there is no module cron or second executor. Contributions describe the
host's existing handlers, schedules and routes without registering them. The
reference binding is inert by default. The accounting runtime retains its job
lease and authentication. Only explicitly selected module execution checks
readiness and enablement before constructing a gateway or claiming a lease;
unselected accounting jobs retain their in-lease skip and failure recording.
Injected service factories have no invocation order scope, so the host refuses
targeted module runs before leasing rather than executing an unscoped job.

Migration: the pinned seller forwards add eligibility sidecars and first-claim
wrappers. Claims retain the SQL-returned seller, revision and mode separately
from installed buyer/line facts. New eligible obligations reuse the first
claimed seller, including independently eligible corrections. Native correction providers receive
the correction claim's seller, revision and mode in their `before` facts; legacy obligations
keep execution-time fallback. Unknown or unsupported seller selection refuses
before claim. Native reversals use the request wrapper's correction branch.
Managed order-scoped correction claims refuse because the pinned correction
wrapper is unscoped. Issued documents are never rewritten. Managed order-status reversals call the
seller request wrapper with their order identity, reason and original payload;
the wrapper preserves the incumbent result and marks only new obligations.
Managed paid and handoff contention surfaces as a typed
`AccountingInvoicePersistenceError` with cause `55P03` and no database effect.
The adapter emits a structured refusal diagnostic before throwing, so automatic
and operator fail-soft handoffs remain visible to operators while dispatch
continues. The diagnostic identifies the source kind and ID and records
`retryable: true` and `effectMayHaveSucceeded: false`. There is no automatic
retry; operators can recover the missing request. Other error handling,
including identity conflicts, is unchanged.

Place invoicing contracts and descriptor interpretation in the existing platform
package's exact `invoicing` and type-only `invoicing/contracts` entries. The module
has no graph edges, provider dependencies or environment discovery. The host owns
fiscal/identifier/rounding policy, frozen facts, seller, M07 reads, storage, registry,
M04 delivery and authorized M12 history. Missing parity returns typed unsupported
before writes. A structural-executor native store is supplied; the host owns the driver and independent transaction lane. Seller reads select the current
host configuration before the next claim, scoped by order or null for unscoped
claims, never by duty. The seller wrapper freezes the first-ever claim, using revisionRef as
the claim wrapper revision. Compatibility stores bind the selected provider at
construction. The structural native store accepts it per claim and persists the
first provider on the duty.
Delivery settlement
retains provider identity, retry delay and uncertain receipt hints. Native takes
`p_evidence.retrySeconds`: a whole number of seconds clamped to 60..86400,
otherwise 900; `retryable:false` parks at infinity. Local document requests
retain provider selection, invoice reference, status and replay. The
[invoicing reference](PLATFORM_PACKAGE_REFERENCE.md#invoicing-contracts) describes
delivery retry evidence, correction, payout item and account-lineage seams and
their source witnesses.

The [invoicing design](plans/oss-m09-invoicing.md) separates the available issue helpers and
native persistence and explicit service composition from activation. The native refusal factory has no
executor and never inspects inputs. The conformance helper consumes offline
adapter fixtures and returns filtered case evidence; it installs no provider or
runtime route. Its [contract tests](../../packages/platform/test/invoicing/adapterConformance.test.ts)
cover parent recovery, exact absence and distinct payout item receipts.

The issue helpers preserve donor sequencing: claim, local preflight, snapshot,
fresh money read, final preflight, provider create/recover, fenced finalize.
Compatibility callbacks bind existing host claims and payloads without replacing
`InvoiceStorePort` or inventing provider proof. Canonical lines and allocation
verify saved amounts; legacy delivery residuals remain a compatibility path.
Hosts supply seller, dates, tax defaults, labels, channel resolution, descriptors
and exact key bytes. Handoff helpers preserve fail-soft dispatch and the explicit
standalone strict option; they register no executor and change no native gate.

Correction and reversal helpers use the same compatibility callback boundary.
`runInvoiceCorrectionJob` validates the persisted outbox identity before projection,
requires recovery on retries and carries the claimed generation to both outcomes.
`createInvoiceReversalHandlers` preserves host event adapters and keys and passes
through the RPC action (`voided`, `correction_requested`, `corrected`, `no_invoice`);
it adds no money or fulfillment dependency. The reference
host selects only an explicit `correctionRecovery` bridge. The legacy provider
method alone is unsupported before claim; a conforming bridge owns exact lookup,
parent validation and positive BEFORE/zero AFTER translation. Unknown outcomes
remain failed/owed recovery work, never evidence of absence or success.


`createPostgresInvoiceStore` binds the reviewed native duty/fact/claim/reversal
RPCs through an injected executor. Each call commits independently; never bind a
client in a transaction spanning fiscal/provider I/O. Missing or unsafe host
facts return typed unsupported without installing facts or consuming the owed
duty. Clearance and observation host projections remain unsupported in this store.
Delivery is supported only with the host's explicit M04 envelope projection;
SQL primitives alone do not establish that envelope.
The incumbent local-only constructor is preserved for the reference Postgres
adapter. Its zero-tax order positions do not establish fiscal parity.
`INVOICING_MIGRATIONS` separates native child-document corrections and explicit
host fiscal facts from managed base-row corrections and managed projections.
The approved durable-duty re-pin voids a stored reversal after a proven
before-send create failure or authoritative absence; retryable readback stays
unknown. Readback selects the latest capture fault per source kind and ID,
including terminal faults and resolved receipts. Cutover source seeding precedes
FK-bearing invoicing tables, so its scan does not hold order/accounting FK locks.
The six-case native conformance witness covers these boundaries within its
existing whole-file budget.
Native paid fulfillment constructs only the shipment spine: accounting disabled, unavailable or locked cannot delay a renewal parcel.
Managed wrappers retain their existing behavior.

`collectInvoiceDuties` consumes sweep/prepare/finish ports; the independent binding
reports an unavailable sweep without exposing raw database errors. Each call
commits separately. Missing facts remain owed, stale claims cannot finalize, and
an interrupted preparation remains recoverable through the persisted lease.
The [native host binding](../../server/runtime/accounting/invoicingDutyBinding.ts)
uses one autocommit query per phase and is invoked explicitly through accounting
runtime collection. No scheduler or provider activation is installed. The
[continuity proof](../../tests/postgres/invoicingContinuity.test.ts) exercises
locked accounting, capture errors, lost capture markers and late issue/replay.
The pinned 192000 replacement isolates duty capture from captured settlement
and dunning recovery; paid/handoff facts remain the sweep's recovery source.

`runNativeInvoiceIssueJob` binds native claims to local and fresh M07 evidence
and explicit provider ports. Only create claims dispatch; their attempt count
is the native generation. Non-observed local evidence remains unavailable and
continues to the fresh read; a local observed mismatch/blocked result settles blocked before that read. A fresh mismatch/blocked result is durably blocked;
unavailable is retryable before send. Readback claims only read the provider and
finish found or record absent/unknown. A stale preflight or finish is a claim
fence: no failure write and zero updates. The host invokes this helper explicitly;
P7 still owns seller freezing, policy admission and service composition.

Registered M07 limit: `payment_truth_readback` still joins accounting documents.
Operator ACCESS EXCLUSIVE schema DDL or a denied readback ACL can block/refuse
the overall call. This pre-existing limit is not repaired by M09; the continuity
witness covers ordinary accounting locks and isolated capture/marker failures.

The native store's bounded `discoverDuties(limit, afterDutyId?)` read returns duty/order IDs
that have no installed fact revision. It neither leases nor changes rows and
excludes stored reversals. Hosts can read their facts and call `installFacts`
before the split preparation sweep; discovery therefore needs no fiscal snapshot.
Pass the last returned duty ID as the next cursor, even when its facts are
unavailable. UUID ordering reaches later targets without changing owed rows;
restart without a cursor after exhaustion to include concurrent captures.

The read side exposes delivery, PDF validation/filename, accepted-document sync,
payout item sync, document history and `createInvoiceReadModel`. Host facades keep
SDK/HTTP imports, original keys, legacy columns, storage and M04 presentation.
Callback mode requires an explicit `terminalFailure` binding before claim.
With CTL-M09-3's 191000 pin, a native host binds `failedBeforeSend` by settling
`failed_before_send` with evidence `{phase:'before_send', retrySeconds}` for bounded
backoff, and `terminalFailure` with `{phase:'before_send', retryable:false}` for
terminal no-reclaim. The optional `createPostgresInvoiceStore` delivery projection
supplies the host envelope; `runInvoiceDeliveryJob` store mode supplies fenced
finalizers. Missing projection refuses before leasing. Per-row projection or
document-read exceptions settle retryable `failed_before_send` with generation-based
backoff; envelope mismatches settle non-retryable and park. Other valid leased rows
continue, with no uncertain receipt for these unsent failures. Uncertain transport
or lost local acknowledgement cannot become another send.

The account-history host projection verifies owner/order before its query and
keeps correction parent, signed total, currency and download availability. Missing
native parity is typed unsupported with `host_binding_required`. Operator auth
precedes query and customer ticket ownership precedes PDF fetch/validation. The
reference browser client consumes the host route without importing the server
entry and filters diagnostics to closed codes. Runbooks, correction intent and
all mutation writers stay host-owned. Inspect the [read-model witness](../../packages/platform/test/invoicing/readModel.test.ts)
and [delivery/seam witness](../../packages/platform/test/invoicing/delivery.test.ts).

The managed payout facade preserves legacy batch/payment calls and aggregate
counts. The package reports reused receipts across item scopes as identity
conflicts and continues without an extra write. Item-level recorded evidence
requires the host's item-capable settlement port; legacy aggregate counts do not
prove that granularity. The [native delivery contract](../../tests/postgres/invoicingDelivery.test.ts)
exercises the package adapter/job against pinned 191000, checking returned results
and delivery, receipt and attempt rows for claim, send, uncertainty, retry/default
delays, terminal parking and stale fences. The host must still supply authorized
envelope facts and conforming M04 transport; no default activation is installed.

## Account and support contracts

The experimental account/support module occupies the existing platform package's
`account-support` and type-only `account-support/contracts` entries. Its isolated
module-graph row has no value or type edges: the R1 implementation uses only its
own structural injected ports. No provider SDK, environment reader, host source
or owner implementation enters the module. This subpath placement needs no new
package, dependency or release lifecycle.

`createAccountReadFacade` delegates account and order reads without changing
arguments, callback receivers, result identity, nulls or thrown failures. The
account-read diagnostic slice retains its original wrapping, failure details and
bounded logging. Authorization, owner DTO projection and private enrichment stay
in the host; the reference binding selects no driver by default.

The five browser-safe envelopes transcribe owner vocabulary locally, as required
by contracts isolation. Executed TypeScript equality and real-driver assignability
checks detect drift; they do not create a second command or invoice engine.
Invoice access retains M09's order-scoped history/download authorization shape.
Self-service, Customer 360 and operator envelopes declare future composition,
not landed executors. See the [R1 plan](plans/oss-m12-account-support.md) and
[consumer reference](PLATFORM_PACKAGE_REFERENCE.md#account-and-support-contracts)
for available behavior and exclusions.

R5a's `createAccountSupportBindings` captures the host's one graph and injected
operation inventory. `createAccountSupportServices` wraps each distinct callable
once and preserves its concrete parameters/results. The contribution factory in
`/composition` publishes the two existing account-support entries and selected
owner dependencies, namespaced ports and route descriptors. Null selected slots
remain required but unbound. Dependencies must name entries actually provided by
the selected identity, communications, fulfillment, invoicing, subscriptions or
inventory contribution; payments stays injected because it has no such module
contribution. No owner engine or fallback dispatch is introduced.

The reference composition is inert and default-off, like the M10 recipe. It
re-observes the host's complete catalogue and selected schema requirements before
each guarded entrance, using the same callable for service/port/route aliases.
M04 owns notice delivery and deduplication, and R4 owns issue-recovery notices;
M12 installs no second handler or scheduler. Browser route elements and paths
are injected, preserving the host's distinct customer/operator authentication.
The static and subscription serving entries remain unchanged. The optional
`commerceOwner` selection accepts the host-built `createM11CommerceReferenceBinding`
result through a local structural type and forwards its contribution, ports,
routes and triggers. R5b does not construct M11 or import its adapters. Its already guarded
services never enter a second M11 binding or M12 callable guard. Host-bound
checkout/recovery and ATP callables stay behind their owner boundaries; the
existing outbox registry supplies inert effect descriptors during host construction
and is supplied separately as `commerceRegistry`, retaining handler
identity. No second dispatcher, installer or stock policy is introduced.

## Operations and diagnostics

The experimental `@openlup/platform/operations` module separates browser-safe
validation, alert projections and injected BFF clients from the Node
`operations/server` mechanisms. `operations/contracts` contains only DTOs and
ports. Separate settings, pipeline, alerts and control-plane methods preserve
request/result types; there is no operation-name dispatcher or second domain
command engine. Existing callers keep compatibility imports.

The [control-plane handler](../../packages/platform/src/operations/server/controlPlaneHandler.ts)
checks injected admin authorization before a typed read or mutation, validates
requests and results, maps replay conflicts to `CONFLICT`, and keeps raw SQL
errors out of responses. The host binds the existing request-reference callback.
The [SQL executor adapter](../../packages/platform/src/operations/server/controlPlaneStore.ts)
uses the existing fixed invoker-rights routines, hashes the complete command and
retains receipt identity on replay. Its capability-local operator allowlist is
independent of identity membership; neither is substituted for the other.

The [watchdog kernel](../../packages/platform/src/operations/server/platformWatchdogService.ts)
accepts typed evidence and a typed evaluator. Host channel keys are opaque and
remain correlated through decisions, sink receipts and ledger writes. The kernel
retains the existing `webhook` key for skipped-attempt audit rows; the reference
keeps its existing channel enum and persisted values. The maintained public
[reference binding](../../server/domains/platform/platformWatchdogService.ts)
supplies the existing domain evaluator. The package retains keyed queue ordering,
bounded concurrency, draining on failure, serialized alert delivery, persistent
backoff, escalation and snooze semantics. `checkOnly` evaluates without ledger or
notification writes. The smaller
[control-plane tick](../../packages/platform/src/operations/server/controlPlaneWatchdog.ts)
evaluates enabled persisted job failures and records the existing heartbeat key.
Alert overview uses a stale or absent heartbeat to report unknown health even
when the alert list is empty.

Settings and pipeline handlers preserve the existing read/result projections;
the host owns their stores. Membership invitation/role/removal remains identity
work, and shipment refresh remains tracking work. The SQL projection has no tester,
email-template or provider tables. These entries add no managed provider parity
or activation evidence. The [module record](plans/oss-m14-operations-portability.md)
retains the remaining M14 evaluator/default portability, role, lifecycle and
transfer obligations; this bounded slice does not complete that programme.

The [operations witnesses](../../packages/platform/test/operations/) preserve the
existing behavior assertions. The existing
[installed consumer](../../scripts/packages/platform-cold-consumer.ts) exercises
typed calls, authorization/input/output refusals and the real native invoker role,
including durable replay/conflict, checkOnly and a second-process restart.
Its executed result, rather than this source description, establishes proof.
