## Problem

What package-boundary problem does this change solve?

## Change

What changed, and why does it belong in a framework-independent kernel rather
than product or adapter code?

## Package Surface And Evidence

- Affected subpath(s):
- Surface maturity: stable / experimental / testing
- Package smoke evidence:
- Conformance evidence, if a port or adapter seam is declared:
- First-party consumer impact:
- Consumer evidence: first-party / independent (describe actual evidence)
- Declaration snapshot updated: yes / no / not applicable

Stable exports follow SemVer under the
[stability reference](../docs/guide/reference/stability.md#public-api).
Experimental and testing surfaces are outside that commitment. Explain declaration
changes against the affected classification; first-party evidence does not establish
independent adoption. Do not refresh snapshots only to make CI pass.

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
- [ ] Declaration snapshot changes are reviewed against the affected stability classification.
- [ ] I ran `npm run ci`, or explained exactly which checks could not run.
- [ ] I did not weaken the `preview` publication settings, the directory-publish refusal, or package controls.
- [ ] I did not include secrets, personal data, or private service evidence.
- [ ] Documentation and changelog impact is addressed.
