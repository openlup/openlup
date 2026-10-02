# Adopter Kit

Status: development-preview. These templates start an application that installs
`@openlup/*` from npm. They are not used by this repository: their names keep
agent tools from loading them here.

## What is in the kit

| File | Copy it to | Purpose |
| --- | --- | --- |
| `AGENTS.template.md` | `AGENTS.md` | The agent guide for your application, with a managed block of OpenLup rules |
| `CLAUDE.template.md` | `CLAUDE.md` | Makes Claude Code read `AGENTS.md` |
| `claude-settings.template.json` | `.claude/settings.json` | Refuses Claude Code's file-edit tools under `node_modules/` |
| `dependabot.template.yml` | `.github/dependabot.yml` | Moves every `@openlup/*` package in one pull request |

## Start your application

From a checkout of this repository at the release you install, in your
application's root:

```sh
cp <openlup>/docs/platform/adopter-kit/AGENTS.template.md AGENTS.md
cp <openlup>/docs/platform/adopter-kit/CLAUDE.template.md CLAUDE.md
mkdir -p .claude .github
cp <openlup>/docs/platform/adopter-kit/claude-settings.template.json .claude/settings.json
cp <openlup>/docs/platform/adopter-kit/dependabot.template.yml .github/dependabot.yml
```

Merge rather than overwrite a file you already have. Write your own rules
outside the managed block in `AGENTS.md`. A later kit release may replace
everything between `<!-- BEGIN:openlup-agent-rules -->` and
`<!-- END:openlup-agent-rules -->`.

## Keep the packages together

Every `@openlup/*` package below 1.0 shares one version. Upgrade them
together, and read each package's `CHANGELOG.md` `Migration:` blocks before
you merge. The Dependabot template groups them all, with no update-type
filter, because a 0.x minor release may break. With Renovate, use the
equivalent package rule:

```json
{
  "packageRules": [
    { "matchPackageNames": ["@openlup/**"], "groupName": "openlup" }
  ]
}
```
