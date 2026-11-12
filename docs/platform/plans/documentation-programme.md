# Documentation programme: one reader guide that stays true

Status: draft plan, 2026-11-12; no wave is authorised until the owner records
the decisions below. The [intent](documentation-programme-intent.md) states the
outcome; the [reconnaissance](documentation-programme-reconnaissance.md)
holds the evidence, the survey of current practice and the simplification this
plan follows (its section 7).
Audience: the maintainer and the agents implementing the programme.

## Task record

- **Outcome.** A reader guide of about twenty pages lives in one directory and
  serves three readers from the same bytes:
  - a human evaluating or adopting OpenLup;
  - a coding agent working in an adopter application;
  - openlup.com.

  Checks that already run in required CI keep its examples compiling, its
  tables generated and its pages free of repository-internal language. A
  public-surface change cannot land without naming its documentation impact.
  The getting-started path runs in CI.
- **Smallest complete scope.**
  - Six mechanisms, S1–S6 (below), built on existing scripts.
  - A new guide written for readers. Existing large pages stay where they are
    as maintainer evidence and are not rewritten. Their factual defects are
    corrected once (W1b), and two repository-wide rules keep them from
    returning.
  - The website consumes the guide at the pinned release commit.
- **Exclusions.**
  - Rewriting or restructuring existing platform pages. W1b corrects only
    what is untrue.
  - Vale, markdownlint, TypeDoc and a hosted docs platform.
  - Per-page version or review-date metadata.
  - A per-release documentation bundle.
  - An agent maintenance run per merge.
  - An agent evaluation suite (deferred behind S4).
  - Any public API change made to suit documentation.
  - Translation.
- **Authority.** This record grants nothing. Each wave needs the owner's
  decisions and an explicit delivery grant. W1 changes review machinery and a
  required check, so it takes two independent fresh reviews.
- **Evidence for completion.**
  - Every wave's exit below.
  - A release cut after W5 whose guide, npm package and openlup.com pages come
    from one commit with every S2 check green.
  - The tutorial job (S4) green on that commit.

## Current state (2026-11-12, tag `openlup-core-v0.38.0`, main `821cfae16`)

- **Reader-facing material is a minority of the documentation.** It covers
  317 Markdown files, and reader explanation is roughly 10–35% of the large
  platform pages.
- **There is no end-to-end path from npm to a running store.** Reconnaissance
  §1 lists the defects found.
- **Existing checks verify structure, not truth.**
  - Routing owners and link/anchor resolution: `config/doc-routing.json`,
    `scripts/documentation-routing.ts`, in required `self-check`.
  - API reports with the Migration block: `packages/*/api`, `api:check` in
    required `install-proof`.
  - Core's documentation contract: `packages/core/scripts/documentation-contract.ts`
    via `npm run docs:check`, in required `install-proof`. It compiles the
    README and AGENTS examples and generates the maturity tables, for core
    only.
  - The neutrality ratchet.
  - The installed agent context: `scripts/agent-context/generate.mjs`, with 12
    hand-curated routes.
- **Markdown-only changes outside rule files need zero reviewers.**
  `deltaFloor` in `scripts/agent-review-decide.mjs:84`.
- **`@openlup/platform` and `@openlup/outbox` depend on `@openlup/core`**, so
  core is installed in every adopter application.

## Target design

### S1 — one reader directory

The guide lives in `packages/core/docs/guide/`. Core is always installed, so
the guide ships with npm without a copy step, and openlup.com reads the same
path at the pinned commit. The location is the marker: nothing else is
reader-facing.

```text
packages/core/docs/guide/
  README.md            index: reader paths and page list
  start/               tutorial: from npm to a running store
  how-to/              one task per page
  concepts/            architecture, ownership, invariants
  reference/           generated tables and closed lists
  glossary.md
```

Pages carry no version, date or status metadata:

- The release is the version.
- The development-preview status is one sentence in the guide index and one
  banner on the website.
- A page that depends on maintainer evidence links to it: an existing
  `docs/platform/*` page or a source file at the release tag.

Style is written once in `guide/README.md` ("Writing this guide") and enforced
where it can be a pattern (S2):

- one task or concept per page;
- the reader's goal first;
- commands that run;
- invariants and refusals stated plainly;
- no task IDs, plan names, CI vocabulary or adopter-specific detail.

### S2 — one documentation contract for every package and the guide

Extend `packages/core/scripts/documentation-contract.ts` and run it for
`core`, `platform` and `outbox` under the existing `docs:check` scripts in
required `install-proof`. It gains:

1. **Compiled fences.** Every `ts` fence in the guide and in each package's
   README and AGENTS.md is extracted to a temporary file and type-checked
   against the built packages, the way `smoke/readmeExample.ts` is today. A
   fence that must not compile is marked `ts nocheck` and needs a reason line.
2. **Generated regions.** A table or list that the code owns is written
   between `<!-- generated:<name> -->` markers by the contract's `--write`
   mode, and `--check` refuses any difference. The first regions:
   - package maturity, extending today's core table to all three packages;
   - published subpaths;
   - refusal and readiness codes;
   - configuration keys, if the code exposes a closed list.

   Prose never states a count or version that a generated region or the
   release already states.
3. **Reader-language patterns.** A short pattern list applies to the guide
   only:
   - task and milestone IDs (`\b[MGRSPNO]\d+[a-z]?\b`-style, with an
     allow-list for real API names);
   - absolute paths (`/Users/`, `/home/`, `C:\`);
   - store-specific terms (seeded from the neutrality baseline plus `pet`,
     `donor`);
   - links into `tests/`, `docs/platform/plans/` or `.context/`.

   Hits fail the check, and the message names the rule and the fix.
4. **Instruction-file size.** Each `AGENTS.md` in a package or the root stays
   under a fixed line cap; the root `AGENTS.md` becomes the single agent guide
   (W4).

### S3 — documentation impact on surface changes

A change to any of these surfaces must carry a `Docs-impact:` line in the PR
task record:

- `packages/*/api/*.api.md`
- `packages/*/package.json` `exports` or `bin`
- the SQL install catalogue
- the guide's generated sources

The line names either the guide or package page changed in the same PR, or
`none — <reason>`. The check lives in the existing routing step of the
published-tree policy, which already reads the PR record for the Migration
block. It refuses a missing line and a named page that the diff does not
touch. Whether `none` is right is the reviewer's call: the native review's
`documentation` assessment already asks for it.

### S4 — the tutorial runs in CI

`guide/start/` marks its runnable steps as `sh tutorial` fences. A new job:

1. extracts them in order;
2. runs them in a clean directory against a service PostgreSQL;
3. installs `@openlup/*` from the packed candidate tarballs on PRs and from
   npm on release;
4. asserts the final step's documented observable result.

The job is advisory first. It becomes a required context after two green runs
on main, if the owner agrees (D4). A step that today needs a source checkout
or owner SQL is a product finding for the owner, recorded in the tutorial as
a stated limit, not hidden by documentation.

### S5 — one corpus, three outputs

- **npm.** `packages/core/package.json` `files` adds `docs/guide/**`.
- **Agents in adopter apps.** `openlup-context init` writes or refreshes a
  managed block between
  `<!-- BEGIN:openlup -->`/`<!-- END:openlup -->` in the application's
  `AGENTS.md`. The block holds:
  - the installed version;
  - one line telling the agent to read the installed guide before relying on
    memory;
  - a compact index of guide pages by task, generated from the guide's
    headings.

  `openlup-context search` and the MCP tools index the guide alongside the
  existing corpus.
- **openlup.com.** The website reads `packages/core/docs/guide/` at the
  commit its release pin names, through its existing Git reader. The commit
  hash is the provenance; no bundle is exported.
- **Retirement.** Once the guide covers the 12 curated routes and the existing
  10-query smoke matrix (`scripts/agent-context/evaluate.mjs`) passes on the
  guide alone, the routes table and `AGENT_CONTEXT.md` corpora are removed in
  a separate wave (W6).

### Existing pages — corrected once, protected after

The existing `docs/platform/*` pages, package READMEs, examples and policies
stay as maintainer evidence and as the targets the guide links to. They are
not restructured, but agents and readers already read them: through GitHub
and through the installed `AGENT_CONTEXT.md` excerpts until W6. Wave W1b
therefore corrects every defect the reconnaissance found:

- **Release status.** Status lines and release notes that call published code
  a candidate or unpublished, for example:
  - `IDENTITY.md`
  - `PLATFORM_PACKAGE_REFERENCE.md`
  - `SUBSCRIPTION_REFERENCE.md`
  - the `docs/platform/README.md` plan list
  - the package READMEs' "Preparation establishes no npm publication"
- **Hand-typed counts and versions that disagree.** Selected-plan unit counts
  in `CANONICAL_CONTRACTS.md` and `DATA_AND_MIGRATIONS.md`, and similar.
  Each is replaced by a pointer to its owning manifest or removed.
- **Adopter-specific terms in generic pages.** `petId`, `petName`, the `pets`
  table, live Tpay settlement and "donor adopter" are replaced by neutral
  terms.
- **Absolute local paths.** `plans/oss-m19-g18.md:120`.
- **Pasted duplicates and stale tool references.** For example the block
  repeated in `ARCHITECTURE_AND_EXTENSIONS.md`, and links to an old release
  tag in the core README.

Two rules keep these classes from returning everywhere, not only in the guide.
Both reuse existing mechanisms:

- the published-tree check refuses absolute filesystem paths in any tracked
  Markdown file;
- the neutrality ratchet adds `pet`, `donor` and the remaining store terms to
  its counted vocabulary, so existing hits may only shrink.

The release-status class needs no rule after W1b: the guide states no status
per page (S1), and the website and `openlup-context` take the version from the
release.

### S6 — written with the code, checked once per release

- **The same-PR rule becomes enforceable.** The agent or contributor changing
  a surface updates the guide in the same PR, and S3 makes that visible.
- **Guide changes get a reviewer.** `deltaFloor` gives Markdown-only changes
  under `packages/core/docs/guide/` a floor of one instead of zero.
- **One documentation pass per release.** Release preparation gains a
  read-only step that lists:
  - the API-report and catalogue diff since the previous release tag;
  - the guide pages that the routing maps to those paths.

  An agent, run by the maintainer as part of release preparation, drafts one
  PR from that list. No new workflow, secret or bot account is added (D5).

## Stages

| Wave | Delivers | Exit |
| --- | --- | --- |
| W0 | This intent, reconnaissance and plan, as a Markdown-only draft PR. | Owner decisions D1–D5 recorded. |
| W1 | S2 checks for all three packages and the (empty) guide directory; S3 `Docs-impact` check; S6 review floor for the guide; S2 `AGENTS.md` cap. Updates `CONTRIBUTING.md` ("Deliver a change", step 3) and `DOCUMENTATION.md`. | Required `install-proof` and `self-check` green. Each new refusal has a falsifying test. Two fresh reviews (review machinery). |
| W1b | Corrections in existing pages (section "Existing pages"), as small PRs by file group; the absolute-path refusal and the extended neutrality vocabulary. No restructuring. | Each listed defect fixed or recorded as intentional history with its date; both rules green with falsifying tests; the 10-query agent-context smoke still green. |
| W2 | Guide skeleton and index with the writing rules; `start/` tutorial; `glossary.md`; `reference/` generated regions; S4 job (advisory). Authored by agents from code at the current release; every capability statement the owner must confirm is listed in the PR. | S2 green on the guide. S4 job green, or each failing step recorded as an owner finding. Owner confirms the capability statements. |
| W3 | `how-to/` and `concepts/` pages, in the order of D3. Root `README.md`, `docs/platform/README.md` and the package READMEs link to the guide. | S2 green; every page reachable from the guide index; no page duplicates another's explanation. |
| W4 | S5 for npm and agents: `files` entry, `openlup-context init` managed block and guide indexing; root `AGENTS.md` becomes the single agent guide and `docs/platform/AGENT_GUIDE.md` is reduced to a link. | A cold consumer installs the packed candidate, runs `openlup-context init`, and the block and index match the installed guide (extends the existing cold-consumer witness). |
| W5 | Website consumption (openlup-website repository): `/docs/` built from the guide at the pinned commit, per-page Markdown alternates, guide pages in `llms.txt`; the pin-bump PR from a scheduled job merges and deploys to production automatically when CI is green (owner decision, 2026-11-12). S6 release step added to release preparation. | The next release reaches openlup.com without a manual step. |
| W6 | Retire the curated routes table and `AGENT_CONTEXT.md` corpora once `evaluate.mjs` passes on the guide; retire the uninvoked orientation audits. | Smoke matrix green on the guide alone; nothing references the removed files. |

W1 lands first so the guide is written under its checks from the first page.
W1b can run in parallel with W1 and W2, because it touches different files.
W2 and W3 can proceed page by page in small PRs. W4 and W5 are independent of
each other once W2 has landed.

## Risks

| Risk | Mitigation |
| --- | --- |
| The tutorial cannot reach a running store from npm at the current release (candidate archive, owner SQL for the first operator). | S4 records each blocked step as an owner finding. The tutorial states the limit; the product fix is separate work. |
| The pattern list rejects real API names or legitimate text. | Allow-list in the contract, reviewed like any rule. The list stays short; anything not expressible as a pattern stays with review. |
| `Docs-impact: none` becomes a reflex. | The reviewer's `documentation` assessment covers it. The per-release pass (S6) catches what slipped, and S4 catches a broken first path. |
| Agent-drafted pages state capabilities that are not true at the release. | Every `ts` fence compiles; generated regions come from code; the owner confirms capability statements in W2 and W3; the review floor is one. |
| The guide and the maintainer pages say different things. | The guide links to evidence pages instead of copying them. When a maintainer page changes meaning, the routing maps it to its guide page through S3. |
| The core package grows. | About twenty Markdown pages, small next to `dist/**` and `src/**`, which core already ships. |

## Cost and budget

- **Agent time.** W1 and W4 are each a few agent-hours plus review. W2 and W3
  are the bulk: page drafting is fast, and the limiting factor is the owner
  confirming what each capability does at the release. W5 is about one wave of
  the website's size. W6 is small.
- **Running cost.**
  - CI: one PostgreSQL-backed job for S4. The S2 additions run inside existing
    jobs.
  - No new service, secret, bot account, linter or scheduled agent in this
    repository.
  - The website adds one scheduled check for a new release.

## Owner decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Adopt S1–S6 with the exclusions above. | Yes. |
| D2 | Where the guide lives. | `packages/core/docs/guide/`: ships with npm without a copy step. Alternative: `docs/guide/` plus a checked copy into core, which adds a generator and a freshness check. |
| D3 | Page order after the tutorial. | Glossary and reference first; then how-to pages for composing the platform, subscriptions, payments in the sandbox, outbox, extensions, upgrade and operations; then concepts. |
| D4 | S4 becomes a required context. | After two green runs on main. |
| D5 | Who runs the per-release documentation pass. | The maintainer's agent during release preparation. A CI agent with an API secret can be added later if the manual step is skipped in practice. |

## Documentation impact

- W1b updates only the pages it corrects, plus the neutrality baseline.
- W1 updates:
  - `CONTRIBUTING.md` ("Deliver a change": the `Docs-impact` line; review
    floors);
  - `docs/platform/DOCUMENTATION.md` (the guide as the reader set, its
    contract, generated regions);
  - `docs/platform/README.md` (route readers to the guide).
- W4 updates `AGENTS.md`, `docs/platform/AGENT_GUIDE.md` and the adopter kit.
- W6 updates `DOCUMENTATION.md` for the retired corpus.
