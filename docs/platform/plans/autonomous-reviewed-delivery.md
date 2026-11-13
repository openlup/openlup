# Plan: autonomous reviewed delivery

Status: historical record, 2026-11-06.

Recorded status: historical design record; current delivery and review rules are in [Deliver a change](../../../CONTRIBUTING.md#deliver-a-change).

## Historical implementation boundary

This work introduced subscription-backed independent review, exact-candidate
session records and PR receipts admitted by trusted-main tooling. Earlier signed
receipt controllers and hosted observers were retired; source integrity uses Git
hashing. Fixture results describe only the mechanisms they exercised, and do not
prove current activation or another installation.

## Provider-neutral execution

The historical implementation allowed native subagents and qualified local CLI
contexts without assigning authority by provider. Current qualification is owned
by [Deliver a change](../../../CONTRIBUTING.md#native-review-and-accountability).

## Native session interface

The interface and command examples now live in
[Deliver a change](../../../CONTRIBUTING.md#native-review-and-accountability).
The implementation contract remains `scripts/agent-review-session.mjs`.

## Approved native queue follow-up wave

The follow-up added PR receipt transport and queue admission. It did not grant
merge, release or settings authority. Current mechanics are in
[Merge queue](../../../CONTRIBUTING.md#merge-queue); dated activation evidence is in
[Development and release](../DEVELOPMENT_AND_RELEASE.md#reading-results-and-recovering).

## Sources and attribution

[Anthropic best practices](https://code.claude.com/docs/en/best-practices),
[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents),
[Codex best practices](https://learn.chatgpt.com/guides/best-practices) and
[execution plans](https://developers.openai.com/cookbook/articles/codex_exec_plans)
informed the design. The protocol was an OpenLup decision, not vendor certification.
