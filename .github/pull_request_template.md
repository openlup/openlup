<!-- GitHub reads this template from `.github/pull_request_template.md` in the
public repository. Edit this file here for future OpenLup pull requests. The
one-time public-root projection is not an ongoing authoring route. -->

## What changed

-

## Why

-

## Scope

- One concern per pull request. If this carries more than one, say why here.
- Task record (outcome, scope, authority, acceptance, risk and proof plan):
- Tests added or updated for the behaviour this changes:
- Affected documentation owner sections and meaningful updates:
- Scoped no-impact explanations, if any, and why the existing text remains correct:
- Simpler alternative considered where meaningful; added complexity justified:

## Risk and rollback

- What breaks if this is wrong:
- How to revert it:

## Checks

- [ ] `npm ci`, `npm test`, and `npm run build` pass in a clean clone.
- [ ] `npm run oss:published-tree -- --policy`, `--inventory`, and `--typecheck`
      pass, or every failure is explained above.
- [ ] Contributor-facing behaviour or commands changed here are documented in
      `README.md` and/or `CONTRIBUTING.md`.
- [ ] Generated navigation is current; affected owner explanations or fresh
      scoped no-impact records were reviewed for meaning, not only fingerprints.
- [ ] Every commit carries a `Signed-off-by:` line (`git commit -s`). The
      Developer Certificate of Origin section of `CONTRIBUTING.md` explains what
      that line certifies.
- [ ] This pull request carries no deployment URL, no credential, and no
      personal data, in its text or in any screenshot.

## Notes for reviewers

- Check the accepted outcome, failure boundaries and unnecessary maintenance
  cost. Report concrete mechanisms and effects, not style preferences or a quota.
- AI assistance (agents and what they did, or none):
- Publication authority (actual maintainer task or bounded delivery scope):
- Native review evidence for the exact committed candidate, as required by the
  AI contribution policy; no claim that the maintainer personally read the diff:
