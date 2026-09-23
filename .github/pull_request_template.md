<!-- GitHub reads this template from `.github/pull_request_template.md` in the
public repository. Edit this file here for future OpenLup pull requests. The
one-time public-root projection is not an ongoing authoring route. -->

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
