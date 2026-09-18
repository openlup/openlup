# Security response posture

How to report a suspected vulnerability is in `SECURITY.md`. This file states
what a reporter gets in return, so that expectation is set before the report and
not after it.

## There is no bug bounty

**OpenLup does not run a bug bounty and does not pay for vulnerability
reports.** No payment, no bounty platform, no swag, no tiered reward. There is no
private disclosure programme that pays, and there is no plan to start one.

This is a deliberate position rather than a budget constraint. Paid programmes in
small projects have become a channel for volume rather than for findings: curl,
which ran one of the better-known programmes in open source, ended its bounty in
2026 after the cost of triaging machine-generated reports outgrew the value of
the real ones it surfaced. A project this size cannot absorb that, so it does not
open the door.

Genuine reports are still wanted, and credit is offered to reporters who want it.
Credit is the whole reward.

## The right to go quiet

**The project reserves the right to stop responding.** Concretely, and without
further explanation at the time:

- a report may be closed without a detailed rationale;
- a reporter may be blocked from the repository;
- a thread may simply end.

This right is exercised for: reports that are machine-generated and unverified;
reports resubmitted after being closed; demands for a CVE, a severity rating, a
timeline, or a bounty; pressure tactics, including threats to disclose publicly
in order to accelerate a response; and abuse of any kind toward a maintainer.

Going quiet is not an admission that a report was correct.

## No timelines are guaranteed

The project aims to acknowledge a reproducible vulnerability report within
**3 business days** and provide a remediation-status update within **10 business
days**. **They are targets, not commitments.** Neither this file nor
`SECURITY.md` is a service-level agreement, and nothing in either creates one.
See `.github/SUPPORT.md`.

## What a good report looks like

A specific, reproducible weakness, with the exact version or commit, the steps
that trigger it, and the concrete impact. A scanner's output pasted without
verification is not a report. A description of a theoretical class of problem
without an instance in this codebase is not a report.

If an AI tool helped you find or write it, say so and verify it yourself first -
the same rules as `.github/AI_CONTRIBUTION_POLICY.md`, for the same reason.

## Supported versions

Security maintenance is the intersection of the module ownership in
`.github/SUPPORT.md` and the release window in
`.github/VERSIONING_AND_EOL.md`:

- during development preview, OpenLup-owned core and official-experimental code
  on the default branch or an exact immutable source preview may receive
  best-effort fixes, without support or backport commitment;
- community and private modules remain contributor/adopter-owned even when used
  with an OpenLup preview or stable release;
- after stable release, committed maintenance applies only to core and
  official-stable modules present in the exact supported BOM and version window;
- official-experimental modules remain best-effort preview surfaces beside a
  stable release, and stable versions outside the window receive no fixes.

This file is the sole owner of that security-response eligibility. `SECURITY.md`
owns only how to report and delegates maintenance here.
