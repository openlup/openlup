# Agent guide for this application

<!-- BEGIN:openlup-agent-rules -->
## OpenLup rules

This application installs OpenLup packages (`@openlup/*`) from npm. If
`packages/core/` is a workspace of this repository, you are in the OpenLup
monorepo instead, and this file does not apply there.

- **Read the installed guides first.** Read `node_modules/@openlup/<package>/AGENTS.md` for each
  `@openlup/*` package you use. They match the installed version, unlike your training data. Read
  the shipped `src/` and `.d.ts` files before guessing at a contract.
- **Never edit an installed package.** Do not change files under `node_modules/@openlup/`, and do
  not patch a package with `patch-package`, `overrides` or a fork. Change behaviour through the
  package's ports, options and your own composition. If a package lacks a seam you need, write it
  down as an upstream issue.
- **Copying package source is ejection.** Your application then owns that copy and its upgrades.
- **Move every `@openlup/*` package together,** to the same version. Read each package's
  `CHANGELOG.md` `Migration:` blocks before you upgrade, and apply any SQL a package ships through
  your own migration chain.
- **Run the readiness check before deploying.** It names every unwired port, unhandled event or
  missing schema object, where a package provides it.
- **OpenLup's contributor process is not yours.** Its worktrees, sign-off, native review and
  release authority apply only inside the OpenLup monorepo.
- **Your brand, copy, catalogue, local policy and provider choices** live in this application,
  never in an installed package.
<!-- END:openlup-agent-rules -->

## This application

Write your application's own rules here, outside the managed block.
