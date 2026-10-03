# Adopter Kit

Status: development-preview. These templates start an application that installs
`@openlup/*` from npm. They are not used by this repository: their names keep
agent tools from loading them here.

## Start with npm

No OpenLup clone is needed. In a new disposable application, use Node 24 and
npm 11.19.0:

```sh
mkdir example-app
cd example-app
npm init -y
npm install --save-exact @openlup/core@0.12.0
```

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

These dependency guides describe contracts. They do not grant authority to edit
your application, publish an issue or pull request, deploy, or change permissions.
Your application's own instructions and accountable human retain those decisions.

## Optional templates

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

Within your application's authority, merge rather than overwrite existing files.
Keep local rules outside the managed block in `AGENTS.md`, retain the
`@AGENTS.md` import in `CLAUDE.md`, and preserve your existing permission rules
when adding the Claude deny entries. Those entries cover Claude's named edit
tools, not every client or every way to change a file. Installing a package does
not copy templates or edit your repository. A later kit release may replace
everything between `<!-- BEGIN:openlup-agent-rules -->` and
`<!-- END:openlup-agent-rules -->`.

## Keep the packages together

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
