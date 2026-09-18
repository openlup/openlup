<!-- Authoring source for the public tree's `.github/pull_request_template.md`.
The public-tree projection copies these bytes verbatim to that path. Change this
file to change the public template; do not edit the generated target in a
materialized tree. -->

## What changed

-

## Why

-

## Scope

- One concern per pull request. If this carries more than one, say why here.
- Tests added or updated for the behaviour this changes:
- Documentation updated, or not needed because:

## Risk and rollback

- What breaks if this is wrong:
- How to revert it:

## Checks

- [ ] `npm ci`, `npm test`, and `npm run build` pass in a clean clone.
- [ ] `npm run oss:published-tree -- --policy`, `--inventory`, and `--typecheck`
      pass, or every failure is explained above.
- [ ] Contributor-facing behaviour or commands changed here are documented in
      `README.md` and/or `CONTRIBUTING.md`.
- [ ] Every commit carries a `Signed-off-by:` line (`git commit -s`). The
      Developer Certificate of Origin section of `CONTRIBUTING.md` explains what
      that line certifies.
- [ ] This pull request carries no deployment URL, no credential, and no
      personal data, in its text or in any screenshot.

## Notes for reviewers

-
