<!-- GitHub reads this template from `.github/pull_request_template.md` in the
public repository. Edit this file here for future OpenLup pull requests. The
one-time public-root projection is not an ongoing authoring route. -->

## What changed

-

## Why

-

## Scope

- One concern per pull request. If this carries more than one, say why here.
- Task record (finite outcome, scope and exclusions, authority and delivery boundary, acceptance and sufficient completion evidence, risk and proof plan):
- Tests added or updated for the behaviour this changes:
- Affected documentation owner sections and meaningful updates:

## Risk and rollback

- What breaks if this is wrong:
- How to revert it:

## Checks

- [ ] Hosted required checks pass, or a failure is explained above and compared
      with the base. Locally I ran the tests I wrote, `npm run lint` and the
      ast-grep scan ([Deliver a change](../CONTRIBUTING.md#deliver-a-change));
      the [testing guide](../CONTRIBUTING.md#test-scope-and-diagnostics) covers scope and proof.
- [ ] Contributor-facing behaviour or commands changed here are documented in
      `README.md` and/or `CONTRIBUTING.md`.
- [ ] Generated navigation is current, and documentation this change makes stale
      is updated in this pull request.
- [ ] Every commit carries a `Signed-off-by:` line (`git commit -s`), and this
      description ends with yours, because the merge commit takes it. The
      Developer Certificate of Origin section of `CONTRIBUTING.md` explains what
      that line certifies.
- [ ] This pull request carries no deployment URL, no credential, and no
      personal data, in its text or in any screenshot.

## Notes for reviewers

- Check the accepted outcome, failure boundaries and unnecessary maintenance
  cost. Report concrete mechanisms and effects, not style preferences or a quota.
- Include the `documentation` assessment in each native review report: canonical
  sections, stale claims and related instructions/examples; compare
  documentation-only claims with their source as well.
- AI assistance (agents and what they did, or none):
- Publication authority (actual maintainer task or bounded delivery scope):
- Native review evidence for the exact committed candidate, as required by the
  AI contribution policy; no claim that the maintainer personally read the diff:
- Source receipt submitted for the reviewed head:
