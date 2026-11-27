# Adopter Kit

Application adoption guidance moved to [Adopt OpenLup from npm](../../../packages/core/docs/guide/start/adopt-from-npm.md). The optional templates remain in this directory:

- [AGENTS.template.md](AGENTS.template.md) — application agent guide template with the `openlup-agent-rules` managed block (syncable via `openlup-context agents-sync` / `openlup agents sync`).
- [CLAUDE.template.md](CLAUDE.template.md) — imports `AGENTS.md`.
- [claude-settings.template.json](claude-settings.template.json) — denies direct edits under `node_modules/`.
- [dependabot.template.yml](dependabot.template.yml) — groups `@openlup/*` updates together for 1.x and excludes them from cooldown.
- [openlup-post-merge-optin-issue.template.yml](openlup-post-merge-optin-issue.template.yml) — zero-RCE post-merge workflow (`contents: read`, `issues: write`) that upserts a deduplicated Opt-in Backlog Issue from reviewed merged lockfile upgrades.
- [openlup-release-watcher-issue.template.yml](openlup-release-watcher-issue.template.yml) — zero-RCE scheduled watcher (`issues: write` only, zero `npm install`) that reads static npm registry metadata and tagged `release-index.json`.
