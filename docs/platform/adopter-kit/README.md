# Adopter Kit

Application adoption guidance moved to [Adopt OpenLup from npm](../../../packages/core/docs/guide/start/adopt-from-npm.md). The optional templates remain in this directory; [AGENTS.template.md](AGENTS.template.md) is the application agent template.

## Start with npm

Moved to [Adopt OpenLup from npm](../../../packages/core/docs/guide/start/adopt-from-npm.md#select-the-packages).

No OpenLup clone is needed. In a new disposable application, use Node 24 and
npm 11.19.0:

```sh
mkdir example-app
cd example-app
npm init -y
npm install --save-exact @openlup/core@<version>
```

`<version>` is the current set version (`npm view @openlup/core version`);
install every `@openlup/*` package you use at that same version.

In an existing application, run only the install command from its root, within
that application's task authority. Read
`node_modules/@openlup/core/AGENTS.md`, especially **Wiring example**, then its
`README.md` and `CHANGELOG.md`.
The guide's TypeScript example composes `@openlup/core/platform-runtime` through
application-owned descriptors; it performs no I/O. Use the installed `src/` and
`dist/*.d.ts` files to inspect the exact port or option you need. Keep providers,
persistence and policy in your application. If the package lacks a seam, record
the need locally and seek authority for an upstream proposal; do not edit the
installed package.

## Customize or contribute

Moved to [Adopt OpenLup from npm](../../../packages/core/docs/guide/start/adopt-from-npm.md#keep-application-ownership).

Use the installed package's public exports, ports and options. Application-owned
handlers, policies, composition and compatible native adapters need no nomination
or upstream release. For example, outbox's public `withPayloadSchema`,
`composeHandlers` and `uniqueRegistry` compose application handlers; its
`./postgres` and `./testing` subpaths describe the default store and fence proof.
Read the installed outbox guide for their actual contract before using them.
These are existing seams, not a new complete extension or absorption example.
To write an adapter for another vendor, start from the shipped example in its
class; [adapter classes and example templates](../CANONICAL_CONTRACTS.md#adapter-classes-and-example-templates)
lists the ports, the examples and the rules.

Keep the adopted engine in its authentic npm package. Do not autonomously patch,
fork, vendor, monkey-patch, alias/shadow resolution or restore a copied engine.
Compatible wrappers preserve the contract; otherwise hold the dependent change
while retaining compatible serving work or a rollback compatible with durable
state. Historical origin does not freeze unpackaged application code. A missing
seam requires a local reproducer and actual upstream submission authority.
Dependency guidance grants no application edit, issue, PR, deployment or permission
rights; the application's own instructions and accountable human govern.

## Adopt or upgrade a package

Moved to [Adopt OpenLup from npm](../../../packages/core/docs/guide/start/adopt-from-npm.md#compare-at-first-adoption-and-upgrade).

1. Select the actual npm artifact and exact whole-set pins. Verify lockfile
   integrity and npm provenance against the release tag, source commit and publishing
   workflow. Read each selected version's exports, installed guides and `Migration:`
   blocks. Locally packed candidates must be labelled with their actual diff/artifact
   identity; they are not published versions.
2. For first adoption, compare current consumer behavior and actual bindings with
   that artifact, including producer payloads, schema, policy and host changes outside
   the extracted engine. An extraction baseline does not freeze later application
   development. For an upgrade, check the same relevant boundaries against the serving
   version and candidate, including disabled native branches.
3. Reconcile affected open nominations from both the consumer base and candidate,
   including moved/deleted locations and a newly adopted destination. An unreadable
   base or missing installed contract is unknown, not an empty successful comparison.
   Settle overlap using the dispositions below in existing adoption/PR evidence.
4. Preserve active subscriptions, pending work, producer transaction boundaries,
   claim/ack/fencing, recovery and durable idempotency. Apply shipped SQL through the
   application's migration chain without rewriting published bytes. Compatible native
   schema additions remain available. Check the actual selected adapter and runtime
   binding; an authentic dependency or a type-compatible adapter alone proves neither.
5. Run relevant behavior and effect witnesses through the application's existing
   tests and review. Distinct same-event effects remain valid; retries and replacement
   must not repeat a prior durable success or lose unfinished work. Refresh required
   artifact, configuration, runtime and schema identities and readiness at every
   adoption. An unaffected disposition can be referenced after checking native binding,
   new capability, behavior/SQL, shared-kernel and dependency impact; API equality or a
   set bump alone is insufficient. Hold an unresolved candidate without taking over
   compatible serving behavior. Deployment retains the application's own authority.

### Source-local nominations and dispositions

Moved to [Adopt OpenLup from npm](../../../packages/core/docs/guide/start/adopt-from-npm.md#track-selected-extension-proposals).

Nominate selected generalizable extensions only. Keep one open case at its
surviving source binding with a stable repository-unique ID and a real behavioral
witness. This comment convention installs no marker validator or history detector:

```text
OPENLUP_CANDIDATE(@openlup/core): kind=nomination; id=event-payload-validation; witness=test/eventPayloadValidation.test.ts; destination=@openlup/outbox; reason=shared event validation proposed upstream
```

Replace the illustrative witness path with your actual test/evidence reference.
The anchor must be a real directly adopted dependency. The intended destination
can be absent; it creates no dependency or installation requirement and defaults
to the anchor if omitted. Required fields are `kind=nomination`, `id` (stable
lowercase kebab identifier), `witness` and final free-text `reason`. Fields use one
line and semicolon delimiters; the final reason may contain semicolons. Add optional
`upstream` only for an actual contribution reference. Legacy free-text workaround
notes may remain; stable move correlation needs an explicit ID. For a never-adopted
domain, use the existing contribution brief until a real dependency anchor exists.

Each disposition records case ID, before behavior/witness, actual contribution
reference if any, selected artifact identity, public capability, final native
binding/effect and reason in existing adoption evidence.

| Disposition | Example and required consequence |
| --- | --- |
| `full` | The selected package supplies all nominated generic payload validation. Remove only the proven duplicate and close its marker after preservation/effect proof. |
| `partial` | The package supplies generic validation; local routing policy remains. Remove the duplicate, test the native remainder and retain the same ID only for a still nominated residual. |
| `retained` | A local audit effect shares the event but serves a distinct obligation. Keep it with a reason and witness; retain an open nomination only if still proposed upstream. Ordinary native policy needs no marker. |
| `hold` | Compatibility or overlap lacks a sufficient witness. The candidate does not take over; preserve compatible serving work and resolve the dependent gap. |

A merge, matching name or migration note establishes neither publication nor
absorption. On ordinary changes, review moved/deleted marker hunks even without
pin changes; move the same-ID marker to its surviving binding or settle the
case in that change's evidence. A later report cannot recover a silently erased
case. Applications own any implemented controls and their verification; there
is no automatic semantic clone or all-history detector.

## Optional templates

Moved to [Adopt OpenLup from npm](../../../packages/core/docs/guide/start/adopt-from-npm.md#merge-optional-templates).

The table's files are optional source guidance, separate from the npm tarball.
Read or download them from a deliberately selected public source revision
containing the kit, for example
[53aab619](https://github.com/openlup/openlup/tree/53aab619185878667e3bcac7ab8d83992797d6e2/docs/platform/adopter-kit),
without cloning the repository. Package release tags can predate the kit; review
templates against your installed guides. Template changes do not alter an
already published package.

| File | Copy it to | Purpose |
| --- | --- | --- |
| [AGENTS.template.md](AGENTS.template.md) | `AGENTS.md` | Application guide with a small managed block of OpenLup rules |
| [CLAUDE.template.md](CLAUDE.template.md) | `CLAUDE.md` | Imports `AGENTS.md` in Claude Code |
| [claude-settings.template.json](claude-settings.template.json) | `.claude/settings.json` | Refuses Claude Code's file-edit tools under `node_modules/` |
| [dependabot.template.yml](dependabot.template.yml) | `.github/dependabot.yml` | Groups ordinary `@openlup/*` updates in one pull request |

## Merge templates into your application

Moved to [Adopt OpenLup from npm](../../../packages/core/docs/guide/start/adopt-from-npm.md#merge-optional-templates).

Within your application's authority, merge rather than overwrite existing files.
Keep local rules outside the managed block in `AGENTS.md`, retain the
`@AGENTS.md` import in `CLAUDE.md`, and preserve your existing permission rules
when adding the Claude deny entries. Those entries cover Claude's named edit
tools, not every client or every way to change a file. Installing a package does
not copy templates or edit your repository. A later kit release may replace
everything between `<!-- BEGIN:openlup-agent-rules -->` and
`<!-- END:openlup-agent-rules -->`.

## Keep the packages together

Moved to [Adopt OpenLup from npm](../../../packages/core/docs/guide/start/adopt-from-npm.md#group-dependency-updates).

Every `@openlup/*` package below 1.0 shares one version. Upgrade them
together, and read each package's `CHANGELOG.md` `Migration:` blocks before
you merge. The Dependabot template groups them all, with no update-type
filter, because a 0.x minor release may break. Security-update pin changes also
need whole-set normalization, regardless of their bot grouping. With Renovate, use the
equivalent package rule:

```json
{
  "packageRules": [
    { "matchPackageNames": ["@openlup/**"], "groupName": "openlup" }
  ]
}
```
