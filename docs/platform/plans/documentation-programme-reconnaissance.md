# Reconnaissance: documentation programme

Status: draft evidence, 2026-11-12, for the
[intent](documentation-programme-intent.md); the execution plan follows the
owner's reading of this page.
Audience: the maintainer deciding the programme, and agents planning it.

Sources: a full read of the 0.38.0 documentation bundle (commit `19cdf37`, 317
Markdown files), an inventory of this repository's documentation mechanisms at
the tag and on main, and two external surveys (documentation drift and
information architecture; documentation for coding agents). External claims
carry their source; vendor-run results are marked as such.

## 1. What the documentation is today

| Class | Files | Bytes | Reader-facing? |
| --- | ---: | ---: | --- |
| `packages/*/api/*.api.md` declaration snapshots | 89 | 5.7 MB | reference only; platform's are 134k lines, mostly noise as pages |
| `docs/platform/plans/` plans and task records | 118 | 3.5 MB | no: history |
| `docs/platform/*.md` platform pages | 19 | 1.1 MB | partly: roughly 10–35% adopter explanation in the three largest |
| `src/**`, `server/**` domain READMEs | 38 | 0.3 MB | contributor navigation |
| package READMEs, AGENTS.md, engine page, changelogs | 23 | 0.5 MB | mostly yes |
| examples and deploy recipes | 10 | 0.15 MB | partly; written for a release candidate |
| `.github` policies, root README, ROADMAP, CONTRIBUTING | 17 | 0.3 MB | mostly yes, CONTRIBUTING mostly process |

Pages ready to publish as they are: `packages/core/docs/SUBSCRIPTION_ENGINE.md`,
`packages/{core,platform}/AGENTS.md`, package changelogs,
`docs/platform/adopter-kit/README.md` and its `AGENTS.template.md`, the
neutral-store `customization`, `limits` and `destinations` pages, and the
`.github` policies `GOVERNANCE`, `TIER_POLICY`, `SUPPORT`,
`SECURITY_RESPONSE_POSTURE`, `LICENSE_OF_TRADEMARK_AND_LOGO`, plus `SECURITY.md`.

Observed defects in reader-facing pages at 0.38.0:

- **Stale release status.** Pages call code on npm "unpublished candidate":
  - `IDENTITY.md:3`
  - `PLATFORM_PACKAGE_REFERENCE.md:299`
  - `SUBSCRIPTION_REFERENCE.md:3`
  - package release notes that say "Preparation establishes no npm
    publication"
- **Roadmap one release behind.** `ROADMAP.md` at the tag names npm set
  0.37.0.
- **Contradictory snapshot counts.** Selected-plan units read 91, 92, 94, 95,
  96, 103 or 105 across `CANONICAL_CONTRACTS.md` and `DATA_AND_MIGRATIONS.md`.
- **Adopter-specific detail in generic pages.** `petId`, `petName`, a `pets`
  table, live Tpay settlement, "donor adopter", and a Polish e-invoicing key.
- **A maintainer's absolute local path.** `plans/oss-m19-g18.md:120`.
- **Repository-only references.**
  - About 436 links into source and tests from reader-facing pages.
  - About 630 task-ID tokens (M10, G23, R5b).
  - The same invariant repeated across pages.
  - One block pasted twice.
  - Paragraphs of 40–55 lines.
- **No end-to-end path from npm to a running store.**
  - The starter describes a candidate archive.
  - The first operator needs owner SQL.
  - The route-host composition shown uses reference-app factories that npm
    does not ship.
- **Missing reference material.**
  - No glossary for native/managed/portable rail, qualified, donor, readiness
    codes.
  - No consolidated configuration keys page.

## 2. What already exists here

| Mechanism | Guarantees | Runs in | Cannot catch |
| --- | --- | --- | --- |
| Routing and navigation (`config/doc-routing.json`, `documentation-routing.ts`, `SOURCE_MAP.md`) | every path has one owner doc and anchor; local links and anchors resolve; map is fresh | required `self-check`, `typecheck` | owner doc unchanged when its paths change; remote links |
| Published-tree checks | links and inline repository paths exist; agent files only at roots | required `self-check` | absolute paths; two-string private-coordinate detector |
| Documentation bundle export | manifest, Markdown, search, `llms` indexes with hashes and provenance | manual only | meaning; never produced per release |
| Publication catalogue | every file has a class | required `self-check` | content |
| API reports and Migration block | stale report fails; a changed or removed declaration needs `Migration:` | required `install-proof`, `self-check` | additive API change needs no docs; prose never required to change; no `ui` report |
| Core `docs:check` | README and AGENTS examples compile; maturity tables match exports; forbidden terms at package root | required `install-proof` | `outbox`, `platform`, `ui`; `docs/platform/**` |
| Agent context (`generate.mjs`, `openlup-context` CLI/MCP, 10-query smoke) | installed corpus is a byte-fresh copy of 12 owner sections | required `typecheck`, `self-check`; smoke manual | correctness of the owner; coverage of new exports |
| Native review | reviewer report must carry a `documentation` field | `native-review` when enabled | field accepts any string; Markdown-only PRs need zero reviewers |
| Neutrality ratchet | brand, locale and vendor counts may only shrink | required `self-check` | existing hits grandfathered; `pet*`, "donor" not listed |
| Orientation audits (`Verified against <sha>`, size caps) | — | not invoked; `config/orientation-truths.json` absent | — |

No style or prose tooling exists: no markdownlint, Vale, cspell, lychee,
TypeDoc or API Extractor.

## 3. Current practice elsewhere

Structure:

- **Diátaxis** (tutorial, how-to, reference, explanation) is the common
  structure for reader documentation. It is adopted across Canonical's product
  docs, and Python's devguide aims for it.
- **Records stay separate from reader docs.** Mature projects keep RFCs,
  ADRs and plans apart: Rust RFCs and Python PEPs are records, not reader
  pages.

Drift prevention ranked by guarantee per cost for a TypeScript monorepo:

1. **Committed API reports that fail CI when stale.** OpenLup has this.
2. **A docs-impact gate.** A public-surface change needs a reader-doc change
   or an explicit "docs impact: none". Changesets keep the changelog side.
3. **Every TypeScript code fence type-checked** against the built packages.
   Examples are twoslash or an extractor with `tsc --noEmit`.
4. **Long examples transcluded from tested files.** Tools: embedme or
   markdown-magic, with a verify step.
5. **Generated reference with undocumented-export errors.** Tools: TypeDoc
   `notDocumented` and `eslint-plugin-tsdoc`.
6. **The quickstart run end to end in CI** against a fresh PostgreSQL.
   Layotto and Dagger do this.
7. **Link and anchor checks.** lychee on PRs, external links weekly.
8. **Owner and `verified_against` metadata with a staleness job.** GitLab
   generates CODEOWNERS from page metadata; Microsoft flags pages untouched
   for 90 days.
9. **Agent-authored docs PRs triggered by surface changes.** Examples are
   Mintlify Autopilot, the Claude Code GitHub Action and the Copilot coding
   agent. They are safe only because items 1–8 gate them.
10. **Vale with a project vocabulary at error severity, plus markdownlint.**
    GitLab runs both.

Documentation for coding agents:

- **Short instruction files.** The only peer-reviewed study (ETH Zurich,
  arXiv:2602.11988, ICLR 2026) found:
  - Developer-written context files improved task success by about 4% and
    cost more than 20% more.
  - LLM-generated context files slightly hurt.
  - Repository overviews did not help.

  Anthropic's guidance agrees: under about 200 lines, commands and non-obvious
  rules only, absolute rules in hooks or checks rather than prose.
- **Pointers to version-matched docs.** Vercel's evals (vendor-run) on APIs
  absent from training data:
  - an 8 KB compressed docs index in `AGENTS.md` reached 100%;
  - a docs skill reached 53–79% and was not invoked in 56% of runs.

  The two results agree. Overviews cost tokens for nothing; a pointer to
  version-correct material the model cannot know helps a great deal.
- **Ship docs inside the package, with a managed pointer.** Next.js ships
  version-matched docs inside the package (`node_modules/next/dist/docs/`)
  and writes a managed block into the consumer's `AGENTS.md`. OpenLup ships
  `AGENT_CONTEXT.md` and `openlup-context`, but writes nothing into the
  adopter's `AGENTS.md`.
- **Evaluate the docs with agents.** Next.js publishes open agent evals
  (next-evals-oss):
  - real tasks scored on build, lint and tests;
  - run across Claude Code, Codex, Cursor and Gemini CLI;
  - pass@4;
  - with and without the instruction file.

  This is the only measure of whether documentation helps agents.
- **Small `llms.txt`, per-page Markdown.** Keep `llms.txt` and each page under
  about 50k characters. Prefer per-page `.md` alternates and
  `Accept: text/markdown` with `Vary: Accept` over one large
  `llms-full.txt`; the 0.38.0 bundle's is 11.6 MB. Evidence that `llms.txt`
  itself is read is weak. Coding agents fetching docs on demand are the real
  consumers.

## 4. Feasibility

The outcome in the intent is achievable, and most of the base exists:

- ownership routing;
- API reports;
- compiled examples for core;
- the bundle with provenance;
- version-matched agent context;
- native review.

What is missing is mostly linkage, not new systems:

- ownership routing does not yet require the owner to change;
- the bundle is not yet published per release;
- compiled examples cover only core;
- the orientation audits are written but not switched on.

Three limits stay true whatever is built:

- **Checks prove structure and agreement with code, not truth of prose.** The
  last line of defence for meaning is review against source, and a
  task-completion evaluation.
- **Agent-written docs need checks they cannot fake.** LLM-generated
  instruction content measurably hurts agents, and agents hallucinate rarely
  used APIs. Generated facts, compiled examples, API-report comparison and
  owner review must gate every agent docs PR.
- **The rewrite of existing pages is real authoring work.** It needs a
  maintainer's decisions on structure and on what each capability actually
  supports at the release; agents can draft it, not decide it.

## 5. Mechanisms needed, and where

| # | Mechanism | Where | Builds on |
| --- | --- | --- | --- |
| M1 | Reader-facing marker per page, with `status`, `audience`, `applies-to` and owner front matter | publication catalogue class or front matter; bundle manifest | catalogue, bundle |
| M2 | Docs-impact gate: a change under a route's paths or an API report requires its owner page to change, or `Docs-impact: none` with a reason in the PR record | `self-check` (required) | doc routing, API reports |
| M3 | Release-fact generation: versions, npm set, counts, export and maturity tables, configuration keys rendered from manifests into marked regions; a check fails on hand-edited regions | `self-check`; release preparation | release gates, migration manifest, `exports` |
| M4 | Compiled examples for every package and every reader page: TypeScript fences extracted and type-checked against the built packages | `install-proof` (required) | core `docs:check`, `typecheck:smoke` |
| M5 | Prose lint for reader pages: markdownlint plus Vale with a project vocabulary, banned internal IDs, store-specific terms and absolute paths at error severity | `self-check` (required) | neutrality ratchet, coordinate detector |
| M6 | Staleness: switch on the orientation audits; `verified_against` per reader page; a scheduled job lists pages whose watched paths changed since | scheduled workflow; release preparation | orientation audits |
| M7 | Bundle per release: export, validate and attach the reader bundle to each release; openlup.com consumes it by digest | `publish-packages` workflow | bundle export, consumer integrity |
| M8 | Agent maintenance pass: on a merged surface change, and before each release, an agent drafts the owner-page update as a pull request, gated by M2–M5 and native review; Markdown-only reader-page PRs get one reviewer instead of zero | scheduled or `push` workflow; review floors | native review |
| M9 | Agent task evaluation: 20–40 real adopter tasks run by Claude Code and Codex against only the installed packages and published docs; pass rate per release, with and without `AGENTS.md` | scheduled workflow; release gate as advice first | agent-context smoke matrix |
| M10 | Adopter `AGENTS.md` managed block written by `openlup-context` and a compact version-matched docs index in it | `packages/core` CLI | `openlup-context`, adopter kit |
| M11 | Instruction-file discipline: `AGENTS.md` files short (commands, invariants, non-obvious rules), checked for size and for alignment with `AGENT_GUIDE.md` | `self-check` | placement check |

## 6. Decisions the plan will ask for

1. **Information architecture.** Diátaxis sections and the reader paths they
   serve (evaluate, build a store, extend, operate, upgrade, contribute).
2. **Where the reader marker lives.** Catalogue class (recommended: one place
   already required for every file) or front matter.
3. **Which gates are required from day one.** Recommended: M2, M4 and M5 as
   required; M6 and M9 as advice until stable.
4. **Rewrite order.** Recommended: the npm-to-store tutorial, glossary and
   configuration reference first; then the platform pages split into how-to
   and reference; then contributor pages.
5. **Agent pass cadence and authority.** Recommended: per merged surface
   change plus pre-release, pull requests only, no merge authority.
6. **Evaluation budget.** Tasks, agents, runs and cost per release.
7. **Fate of existing large pages.** Keep them as maintainer evidence under a
   labelled path, with reader pages linking to them, or split them in place.

## 7. Simplified recommendation (supersedes sections 5 and 6)

Rule applied: prefer a structure that makes a defect impossible over a check
that finds it, a check over a process, and an existing script over a new tool.
Keep nothing that needs a human to update metadata by hand.

### Keep, in this simpler form

| # | Mechanism | Replaces | Why simpler and at least as strong |
| --- | --- | --- | --- |
| S1 | **One reader directory.** A small, new reader set (about 20 pages: start, guides, concepts, reference, glossary) in one directory. The location is the marker. No per-page version or status: the release is the version, and the preview status is one site-wide banner. | M1, decision 2, decision 7 | No front matter to maintain. Existing large pages are not rewritten; they stay where they are as maintainer evidence and reader pages link to them. |
| S2 | **One docs contract for every package and the reader directory.** Extend the existing core `docs:check` (already in required `install-proof`) to: <br>• type-check every TypeScript fence; <br>• keep maturity tables generated; <br>• refuse a regex list in reader pages: task IDs, absolute paths, store terms, links into `tests/` or `plans/`, digits next to counted nouns; <br>• cap the `AGENTS.md` size. | M3, M4, M5, M11 | One existing script instead of Vale, markdownlint and new generators. A rule that cannot be written as a pattern belongs in review, not in a linter with false positives. |
| S3 | **Docs-impact line on surface changes.** When an API report, the SQL catalogue, the CLI or `exports` change, the PR record must name the reader page changed or say `Docs-impact: none` with a reason. Implemented in the existing routing check. | M2 | Reuses the routing that already knows owners. One line, judged by the reviewer. |
| S4 | **Executable tutorial.** The npm-to-store tutorial's commands run in CI against a fresh PostgreSQL: advisory at first, required once green twice. | M9 (agent eval suite) as the first measure | Deterministic and cheap. It proves the path every human and every agent takes first. An agent eval is added only if this proves insufficient. |
| S5 | **One corpus, three outputs from the same files.** <br>• openlup.com reads the reader directory at the pinned commit through Git: the commit hash is the provenance. <br>• The npm packages ship the same directory. <br>• `openlup-context init` writes a managed block with a compact index of it into the adopter's `AGENTS.md`. | M7, M10, the hand-curated `AGENT_CONTEXT.md` routes over time | Removes the per-release bundle step and, later, the excerpt corpus with its route table. The pattern measured best for agents is a compact pointer to version-matched docs in `AGENTS.md`. |
| S6 | **Docs are written in the same PR as the code, plus one agent pass per release.** <br>• The authoring agent updates the reader page with the code, as S3 asks. <br>• Before each release, one agent compares the API-report diff since the last release with the reader set and opens one PR. <br>• Reader-page PRs take one reviewer instead of zero. | M8 | One scheduled run per release instead of a run per merge. All agent output passes S2–S4, which it cannot fake. |

### Drop or defer

- **Vale and markdownlint (M5).** Covered by the S2 pattern list and by review.
  Revisit only if style drift shows up in practice.
- **`verified_against` headers and the staleness job (M6).** Date bumps
  without review are the known failure mode. S3 ties freshness to the actual
  change instead. The dormant orientation audits can be retired.
- **Per-release documentation bundle (M7).** Git at a pinned commit already
  gives integrity and provenance.
- **Agent maintenance pass per merge (M8).** Replaced by same-PR updates plus
  the per-release pass.
- **Agent task-evaluation suite (M9).** Deferred behind S4.
- **TypeDoc.** API reports and generated maturity tables already serve as the
  reference.
- **Duplicate `AGENT_GUIDE.md`.** Keep one file (the root `AGENTS.md`) and
  link to it, instead of checking that two copies stay aligned.

### Decisions left for the owner

1. Approve S1–S6 as the programme, with the drops above.
2. Reader set and order: tutorial, glossary and configuration reference first.
3. Whether S4 becomes required once it has passed twice.
