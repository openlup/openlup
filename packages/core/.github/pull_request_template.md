## Problem

What package-boundary problem does this change solve?

## Change

What changed, and why does it belong in a framework-independent kernel rather
than product or adapter code?

## Package Surface And Evidence

- Affected subpath(s):
- Surface maturity: candidate / experimental / testing
- Package smoke evidence:
- Conformance evidence, if a port or adapter seam is declared:
- Private-current-seam dogfood impact:
- External-consumer evidence: not evaluated / phase-5 follow-up
- Declaration snapshot updated: yes / no / not applicable

Every export is an internal package surface before phase 5. Explain declaration
drift without treating a packed first-party consumer as external adoption or a
public stability promise. Do not refresh snapshots only to make CI pass.

## Verification

- Commands run:
- Node 24 ESM evidence:
- TypeScript NodeNext/bundler evidence:
- Vite evidence:
- Tests added or changed:

## Security And Privacy

- Security impact:
- Data handled by the change:
- Secret or provider-credential impact:

Do not disclose a suspected vulnerability in this pull request. Follow
`SECURITY.md` and use the approved private reporting route.

## Documentation And Release Notes

- README or maintainer docs updated:
- CHANGELOG entry:
- Follow-up work:

## Checklist

- [ ] I used package subpaths and did not add direct `src/` or `dist/` imports.
- [ ] Runtime code remains framework-, provider-, environment-, and test-runner-neutral.
- [ ] Behavior changes have focused tests.
- [ ] Declaration snapshot drift is intentionally reviewed as an internal candidate change.
- [ ] I ran `npm run ci`, or explained exactly which checks could not run.
- [ ] I did not weaken the `preview` publication settings, the directory-publish refusal, or package controls.
- [ ] I did not include secrets, personal data, or private service evidence.
- [ ] Documentation and changelog impact is addressed.
