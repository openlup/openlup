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

### Modules and distributions

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

Separate an integration artifact only on evidence: incompatible peer ranges in
supported cold installs; a genuinely different browser/edge/Node runtime;
measured installation cost; a different maintenance or release lifecycle; or
an actual independent consumer. First assess an existing port, isolated
subpath, optional peer or application adapter. A trigger calls for an owner
decision with compatibility and maintenance ownership, not automatic permission
to create or publish a package. Generic supported orchestration remains the
platform's responsibility.

### Contributions, seams and readiness

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
to `http`. The host supplies egress, renderer, observation and shared control
policy. No reference alias or provider SDK is imported by this capability.
The contribution describes explicit host selections and never mounts a second
executor. Browser preview values remain reference-owned. See the
[M04 scope](plans/oss-m04-communications-triggers.md).
