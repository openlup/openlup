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

<!-- openlup-doc-impact {"unit": "browser", "digest": "sha256-b68539ca9e5cdab8feab5ac48dfc0db2126a646411197ed5c12121700b42b506", "reason": "The changed source is a static renewal SQL boundary test. It now requires both existing SKIP LOCKED clauses and accepts CREATE OR REPLACE. No browser imports, application composition, extension seam or production boundary changes in this source delta."} -->

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
nothing outside its own directory, except `@openlup/outbox` and the unreleased
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
in that sense: its PostgreSQL adapters load `pg`, its only optional peer, and
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


<!-- openlup-doc-impact {"unit":"server","digest":"sha256-677c8943f9ff430a5c5c104f7b6414a5f70c9cb0f35013a78e4b4b423776d8f1","reason":"Server-library comment delta. The admin-domain kit, feature flag, observability and service comments name downstream files by role or by their path in this tree, the rate limiter test title names its callers generically, and the payment adapter registry comment names an adapter folder generically. No server boundary described here changes."} -->

The runnable server substrate lives in the unreleased `@openlup/platform`
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
| `@openlup/platform` | Planned backend distribution, beginning with runnable foundation (M02), then identity (M03) at `@openlup/platform/identity`. |
| UI | Target distribution role in M19; this does not reserve an npm name or establish a published library. The foundation shell remains reference-application source. |

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

The current [checker](../../packages/core/src/readiness/index.ts) requires
exactly one contribution for every observed non-kernel package. Its
[manifest](../../packages/core/src/readiness/contracts.ts) binds one package
name, kind and optional `requiredSchema`. Multiple unchanged contributions with
the same package name do not satisfy that contract.

**Planned prerequisite (M03/B0):** before adding identity as the second
capability in platform, the public identity author must deliver a separately
reviewed readiness adaptation under the architecture coordinator. It precedes
the first identity-code import and requires its own scope, owner decision and
applicable control/merge authority; this documentation grants none of them.
First test whether lossless aggregation through the existing contribution seam
is sufficient. Otherwise introduce the smallest explicit module representation,
without a general loader or plugin framework. Preserve compatibility for core
and outbox, the exact package set and artifact bindings, complete host inventory,
module identity, required module/contract dependencies and every schema requirement,
missing-module and duplicate/missing port, handler, route and schedule refusals,
and actionable
package/module diagnostics. Prove default and supported narrower compositions;
`unknown` or `unsatisfied` must leave the serving candidate in place. Until
that prerequisite is implemented and verified, multi-capability readiness is a
target, not an available API. UI admission must separately establish its
artifact role and consumer proof without inventing server workers or schema.

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
  needs the next minor set, chosen against the actual registry. Merging B0 does
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

Development-preview seams may change. `P1-SF` is the later gate for stable
extension contracts, a versioned release/BOM, a thin adopter app, conformance
coverage, and upgrade tooling. Until that gate is complete, this document is a
boundary contract for preview work rather than a support promise.
