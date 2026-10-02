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

## Runtime boundaries

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
nothing outside its own directory. Code outside `packages/` reaches a package
only through a subpath its `package.json` `exports` declares, never through a
relative path into `packages/` or an undeclared subpath such as `src` or
`dist`. Domain code under `src/domains` and `server/domains` imports none of
the provider SDKs the config names and no adapter, infrastructure, runtime or
route code; its tests may compose a domain with an adapter. The same provider
SDK restriction applies to non-test production source in `packages/core/src`
and `packages/ui/src`; their tests retain package isolation. The checks cover
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

<!-- openlup-doc-impact {"unit":"browser","digest":"sha256-4b16cf8cf114d11e1380f7e1128734db6fb710e8dfb657d541200affe97064ca","reason":"Test-only changes select current schema definitions and explicit ACL statements instead of absent historical forwards, retain current import and UI boundary scans, use neutral presentation fixtures, and withdraw unmounted legacy-view scenarios. No production import, browser contract or runtime composition changes; active subscription modal behavior and callable server/data guarantees remain separate obligations."} -->

<!-- openlup-doc-impact {"unit":"server","digest":"sha256-677c8943f9ff430a5c5c104f7b6414a5f70c9cb0f35013a78e4b4b423776d8f1","reason":"Server-library comment delta. The admin-domain kit, feature flag, observability and service comments name downstream files by role or by their path in this tree, the rate limiter test title names its callers generically, and the payment adapter registry comment names an adapter folder generically. No server boundary described here changes."} -->

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

## Package architecture

OpenLup ships its platform as `@openlup/*` npm packages. This section is the
contract every package follows as it is extracted. Today only the kernel,
`@openlup/core`, is published. Rules that need a contract the kernel does not
export yet say so. Development-preview rules may still change (see
[Compatibility posture](#compatibility-posture)).

### Package kinds

Each package declares one `kind` in its `release-gates.json`:

| Kind | Holds | May depend on |
| --- | --- | --- |
| `kernel` | I/O-free contracts and logic that two or more packages, or an application's composition, read; its only runtime dependency is `zod` | nothing else in `@openlup/*` |
| `rail` | runtime infrastructure every capability emits into or records through, such as the outbox and the job-run ledger | the kernel |
| `capability` | one capability end to end: its processes, the schema it needs and the contracts only it reads | the kernel and rails |
| `implementation` | one port bound to one provider or market | the kernel, rails and the one package it implements |

The placement rules:

- **No I/O in the kernel.** A kernel file imports no database driver, provider SDK or `node:`
  module, and is no HTTP or scheduled-job entrypoint.
- **One capability, one package.** A capability boundary is where an adopter would replace or
  leave out the capability as a whole. One capability is never split into a package per process.
- **No capability depends on another capability.** Cross-capability flows go through kernel
  contracts and rails, and the application's composition connects them.
- **The kernel grows only for shared contracts.** It gains a contract only when a second package
  reads it. A contract that one package reads stays in that package.
- **Default stores need no driver** (from the first rail or capability package). A default store is
  a subpath over a structural SQL executor, which the kernel adds with that package. A
  provider-specific store is an implementation package or application code.
- **New kernel validation contracts are typed as `StandardSchemaV1`,** not as types of one schema
  library. The kernel's existing exports are `zod` schemas today.
- **Composition stays in the application.** Runtime assembly, handler manifests, readiness
  wiring, scheduled-job files and HTTP entries belong to the application, never to a package.
  The reference application ships its own.

Names follow `@openlup/core`, `@openlup/<rail>`, `@openlup/<capability>`,
`@openlup/<capability>-<provider>` and `@openlup/market-<cc>`. They never name
a brand or an industry.

### Contributions, seams and readiness

These rules take effect with the first rail or capability package. The kernel
does not yet export the readiness check.

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
  Shipped SQL follows expand, compatible deploy, backfill, contract.

### Agent guidance for applications

- **This repository's guides are for contributors.** The root `AGENTS.md` and
  [the agent guide](AGENT_GUIDE.md) govern work on this monorepo only.
- **Each package carries its own `AGENTS.md`.** It states the package's kind, the maturity of each
  subpath, one wiring example and the rules for using it from an application.
- **Applications start from the [adopter kit](adopter-kit/README.md).** It holds an agent-guide
  template, a dependency-update template that moves every `@openlup/*` package together, and an
  agent-tool permission template that refuses file-edit tools under `node_modules/`. The template files use
  names no agent tool loads, so they never govern work in this repository.

## Compatibility posture

Development-preview seams may change. `P1-SF` is the later gate for stable
extension contracts, a versioned release/BOM, a thin adopter app, conformance
coverage, and upgrade tooling. Until that gate is complete, this document is a
boundary contract for preview work rather than a support promise.
