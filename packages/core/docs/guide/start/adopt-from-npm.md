# Adopt OpenLup from npm

Add the OpenLup packages you need to your own application, then bind their public
ports to your host, persistence and policy. Follow the [tutorial](tutorial.md)
for a first runnable example, or [add OpenLup to an existing application](../how-to/build/own-stack.md).

## Select the packages

Use Node.js 24 and npm 11.19.0. From your application's root, set
`OPENLUP_VERSION` to the exact release you selected and install only the packages
you use. For the core package alone:

```sh
npm install --save-exact "@openlup/core@$OPENLUP_VERSION"
```

Keep every installed `@openlup/*` package at that same exact version. Read the
installed `node_modules/@openlup/core/docs/guide/README.md`, then each relevant
package's `AGENTS.md`, `README.md` and `CHANGELOG.md`. Use its public exports,
declarations and shipped source when checking an option or port. The [upgrade procedure](../upgrade/README.md)
owns package, database and application-file upgrades.

Installing packages requires no OpenLup clone. The separate
[starter application](../how-to/build/customize-the-starter.md#prepare-the-application)
is extracted source with its own local package-archive inputs; npm installation
does not create it.

## Keep application ownership

Your application owns providers, persistence, local policy, authorization and
composition. Dependency guidance describes contracts; your application's own
instructions and human authorization govern edits, external submissions,
deployment and permissions.

Use the [extension seams](../how-to/extend/choose-an-extension-seam.md) for ordinary
application handlers, policies and compatible adapters. They need no upstream
nomination or release. For a service adapter, follow
[provider adapters](../how-to/extend/provider-adapters.md).
The source [market composition example](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/server/adapters/market-packs/marketRecipe.ts)
keeps language, settlement, company rules and optional directory inputs explicit;
importing it mounts no runtime or UI. Your host supplies provider configuration
and missing-input policy; keep manual address entry useful without lookup.

Keep the adopted engine in its npm package. Do not edit installed files, patch,
fork, vendor, shadow package resolution or restore a copied engine. Application
code remains yours regardless of its historical origin. If no seam fits, keep a
local reproducer and obtain authority for an upstream proposal. A compatible
wrapper or adapter must preserve the contract. Hold the dependent change while
retaining compatible serving behavior or a rollback compatible with durable
state; do not replace the engine.

## Compare at first adoption and upgrade

1. Select the actual artifact and exact package pins. Verify lockfile integrity
   and package provenance against its release tag, source commit and publishing
   workflow. Read the selected exports, installed guidance and `Migration:`
   blocks. Identify locally packed candidates by their actual bytes and changes;
   they are not published versions.
2. Compare current application behavior and actual bindings with that artifact.
   Include producer payloads, schema, policy, host changes and disabled branches.
   An old extraction baseline does not freeze later application development.
   For upgrades, compare the serving version with the candidate too.
3. Reconcile affected open extension proposals from both the application base
   and candidate, including moved or deleted bindings and a newly adopted
   destination. An unreadable base or missing installed contract is unknown.
   Record a [disposition](#track-selected-extension-proposals) for each affected case.
4. Preserve active subscriptions, pending work, producer transactions,
   claim/acknowledgement fencing, recovery and durable idempotency. Apply shipped
   SQL through your application's [migration chain](../upgrade/database-migrations.md)
   without rewriting published bytes. Check the actual adapter and runtime
   binding; dependency identity and type compatibility alone do not prove behavior.
5. Exercise the relevant behavior and effects with your application's checks.
   Preserve distinct effects for the same event. Retries and replacement must
   neither repeat a durable success nor lose unfinished work. Refresh artifact,
   configuration, runtime and schema identities and [readiness](../upgrade/README.md#check-readiness).
   Reuse an unaffected disposition only after checking native bindings, new
   capabilities, behavior, SQL, shared kernels and dependencies. API equality or
   a package version change alone is insufficient. Hold unresolved candidates
   while retaining compatible serving behavior; deployment needs your application's authority.

## Track selected extension proposals

Track a selected generalizable extension, rather than every local policy.
Keep one open case at its surviving source binding with a stable repository-unique
ID and a real behavioral check. The following is an optional comment convention;
OpenLup installs no marker validator or history detector:

```text
OPENLUP_CANDIDATE(@openlup/core): kind=nomination; id=event-payload-validation; witness=eventPayloadValidation.check.ts; destination=@openlup/outbox; reason=shared event validation proposed upstream
```

Replace the illustrative check path with your actual evidence. The anchor must
be a directly adopted dependency. The destination may be absent and creates no
installation requirement; if omitted, it defaults to the anchor. Required fields
are `kind=nomination`, a stable lowercase kebab `id`, `witness` and a final
free-text `reason`. Use one line and semicolon delimiters; the final reason may
contain semicolons. Add `upstream` only for an actual contribution reference.
Legacy notes can remain, but correlation across moves needs an explicit ID.
For a domain you have never adopted, use your contribution brief until there is
a real dependency anchor.

Record the case ID, previous behavior and check, actual upstream reference if
any, selected artifact, public capability, final application binding and effect,
and reason with the adoption decision:

| Disposition | Consequence |
| --- | --- |
| `full` | Remove only the proven duplicate after checking preservation and effects, then close the marker. |
| `partial` | Remove the generic duplicate, check the local remainder and retain the same ID only for a still-proposed residual. |
| `retained` | Keep a distinct local obligation with its reason and check. Keep a nomination only if it is still proposed upstream. |
| `hold` | Do not let the candidate take over until compatibility or overlap has sufficient evidence. Preserve compatible serving work. |

A contribution being accepted, a matching name or a migration note establishes
neither publication nor adoption nor permission to delete application behavior.
When code moves or disappears, move its same-ID marker to the surviving binding
or settle its disposition in that change, even when package pins stay unchanged.
Review deleted and renamed bindings too. These are application review duties;
there is no automatic semantic duplicate or all-history detector. Package
examples and local packing do not establish deployed effects or completed
adoption in another application.

## Merge optional templates

Templates are optional source files, separate from the npm tarball. Select a
public source revision containing them and compare it with your installed
guidance. A template change does not change an already published package.

| Source file | Application destination | Purpose |
| --- | --- | --- |
| [Agent rules](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/docs/platform/adopter-kit/AGENTS.template.md) | `AGENTS.md` | Application instructions with an OpenLup managed block |
| [Agent import](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/docs/platform/adopter-kit/CLAUDE.template.md) | `CLAUDE.md` | Imports `AGENTS.md` |
| [Editor permissions](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/docs/platform/adopter-kit/claude-settings.template.json) | `.claude/settings.json` | Denies the named `Edit` tool under `node_modules/` |
| [Dependency updates](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/docs/platform/adopter-kit/dependabot.template.yml) | `.github/dependabot.yml` | Groups ordinary package updates |

Merge with existing files. Keep local rules outside the managed block, preserve
the `@AGENTS.md` import and retain existing permission rules when adding deny
entries. A deny entry covers its named tool, not every way to change a file.
Package installation copies no templates and edits no application instructions.
A later template update may replace the block between
`<!-- BEGIN:openlup-agent-rules -->` and `<!-- END:openlup-agent-rules -->`.

## Group dependency updates

Keep all `@openlup/*` updates together, including security-driven pin changes.
A minor release before 1.0 can break compatibility; do not filter the update group
to patch releases alone. The supplied template groups all ordinary updates with
no update-type filter. For another dependency-update service, use an equivalent
package rule:

```json
{
  "packageRules": [
    { "matchPackageNames": ["@openlup/**"], "groupName": "openlup" }
  ]
}
```
