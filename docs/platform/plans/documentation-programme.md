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
  tables generated and its pages free of repository-internal language, so an
  API change that breaks a page fails the build by construction. The
  getting-started path runs in CI.
- **Smallest complete scope.**
  - Five mechanisms, S1, S2, S4, S5 and S6 (below), built on existing scripts.
  - A new guide written for readers. Existing large pages stay where they are
    as maintainer evidence and are not rewritten. Their factual defects are
    corrected once (W1b), and one repository-wide rule (no absolute local
    paths) keeps the only pattern-shaped class from returning.
  - The website consumes the guide at the pinned release commit.
- **Exclusions.**
  - Rewriting or restructuring existing platform pages. W1b corrects only
    what is untrue.
  - Vale, markdownlint, TypeDoc and a hosted docs platform.
  - Per-page version or review-date metadata.
  - A per-release documentation bundle.
  - An agent maintenance run per merge.
  - An agent evaluation suite (deferred behind S4).
  - A documentation-impact obligation in the PR record, and any change to
    review floors. Both were removed or set on 2026-11-06 (`9a94ffe7b`); see
    [Relation to earlier plans](#relation-to-earlier-plans).
  - Any public API change made to suit documentation.
  - Translation.
- **Authority.** This record grants nothing. Each wave needs the owner's
  decisions and an explicit delivery grant. Review floors are the existing
  ones; W1 changes a required package gate and takes the floor that applies to
  its paths.
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
    via the core package's `docs:check` script, in required `install-proof`. It compiles the
    README and AGENTS examples and generates the maturity tables, for core
    only.
  - The neutrality ratchet.
  - The installed agent context: `scripts/agent-context/generate.mjs`, with 12
    hand-curated routes.
- **Markdown-only changes outside rule files need zero reviewers.**
  `deltaFloor` in `scripts/agent-review-decide.mjs:84`, as set on 2026-11-06.
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

### No impact gate (was S3 in the reconnaissance)

A `Docs-impact` line in the PR record is not reintroduced. The owner removed
that obligation on 2026-11-06 because review already covers it. This plan
gets the same protection by construction:

- **Examples and generated regions.** Every guide example compiles and every
  closed list is generated (S2), so an API change that invalidates them fails
  `install-proof` in the same PR.
- **Prose.** Whatever a pattern cannot catch is reviewed where it is cheapest:
  - by the author of the change, under "Deliver a change", step 2;
  - in the per-release pass (S6), against the release's API diff.

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
- **Adopter-specific terms where they impose the first-party store's industry
  on adopters.** This follows the rule of the
  [documentation quality audit](documentation-quality-audit.md): historical
  facts, opaque adopter values and faithful reference descriptions are not
  defects only because they use application vocabulary. Each occurrence of
  `petId`, `petName`, the `pets` table, live Tpay settlement and "donor
  adopter" is judged against that rule. Only those presented as generic
  platform contract are neutralised.
- **Absolute local paths.** `plans/oss-m19-g18.md:120`.
- **Pasted duplicates and stale tool references.** For example the block
  repeated in `ARCHITECTURE_AND_EXTENSIONS.md`, and links to an old release
  tag in the core README.

Only one class gets a repository-wide rule, because only one is
pattern-shaped without false positives: the published-tree check refuses
absolute filesystem paths in any tracked Markdown file.

The other classes need no new rule:

- **Release status.** After W1b the guide states no status per page (S1), and
  the website and `openlup-context` take the version from the release.
- **Counts.** These move into generated regions or pointers.
- **Vocabulary.** This stays a judgement under the audit's rule; the guide's
  own pattern list (S2) covers reader pages.

### S6 — written with the code, checked once per release

- **Same-PR updates under the existing rule.** The agent or contributor
  changing a surface updates the guide in the same PR, as "Deliver a change",
  step 2 already requires. A compiled example or generated region that the
  change breaks makes the omission visible in CI.
- **Review floors unchanged.** Guide pages are Markdown outside the rule
  files, so they keep the floor of zero set on 2026-11-06. CI checks and the
  per-release pass carry the quality. Capability statements in W2 and W3 are
  confirmed by the owner as part of those waves.
- **One documentation pass per release.** Release preparation gains a
  read-only step that lists:
  - the API-report, catalogue and maintainer-page diff since the previous
    release tag;
  - the guide pages that the routing maps to those paths.

  An agent, run by the maintainer as part of release preparation, drafts one
  PR from that list. No new workflow, secret or bot account is added (D5).

## Stages

| Wave | Delivers | Exit |
| --- | --- | --- |
| W0 | This intent, reconnaissance and plan, as a Markdown-only draft PR. | Owner decisions D1–D5 recorded. |
| W1 | S2 checks for all three packages and the (empty) guide directory; the S2 `AGENTS.md` cap. Updates `DOCUMENTATION.md`. | Required `install-proof` and `self-check` green. Each new refusal has a falsifying test. |
| W1b | Corrections in existing pages (section "Existing pages"), as small PRs by file group, plus the absolute-path refusal. No restructuring. | Each listed defect fixed, or kept with its reason under the audit's rule. The absolute-path rule is green with a falsifying test. The 10-query agent-context smoke is still green. |
| W2 | Guide skeleton and index with the writing rules; `start/` tutorial; `glossary.md`; `reference/` generated regions; S4 job (advisory). Authored by agents from code at the current release; every capability statement the owner must confirm is listed in the PR. | S2 green on the guide. S4 job green, or each failing step recorded as an owner finding. Owner confirms the capability statements. |
| W3 | `how-to/` and `concepts/` pages, in the order of D3. Root `README.md`, `docs/platform/README.md` and the package READMEs link to the guide. | S2 green; every page reachable from the guide index; no page duplicates another's explanation. |
| W4 | S5 for npm and agents: `files` entry, `openlup-context init` managed block and guide indexing; root `AGENTS.md` becomes the single agent guide and `docs/platform/AGENT_GUIDE.md` is reduced to a link. | A cold consumer installs the packed candidate, runs `openlup-context init`, and the block and index match the installed guide (extends the existing cold-consumer witness). |
| W5 | Website consumption (openlup-website repository): `/docs/` built from the guide at the pinned commit, per-page Markdown alternates, guide pages in `llms.txt`; the pin-bump PR from a scheduled job merges and deploys to production automatically when CI is green (owner decision, 2026-11-12). S6 release step added to release preparation. | The next release reaches openlup.com without a manual step. |
| W6 | Retire the curated routes table and `AGENT_CONTEXT.md` corpora once `evaluate.mjs` passes on the guide; retire the uninvoked orientation audits. | Smoke matrix green on the guide alone; nothing references the removed files. |

W1 lands first so the guide is written under its checks from the first page.
W1b can run in parallel with W1 and W2, because it touches different files.
W2 and W3 can proceed page by page in small PRs. W4 and W5 are independent of
each other once W2 has landed.

## Relation to earlier plans

- **[Documentation maintenance](documentation-maintenance.md)** (2026-09-27)
  built the routing, generated navigation and documentation bundle this plan
  reuses. Its impact checker was removed on 2026-11-06 (`9a94ffe7b`). This
  plan does not bring it back, for the reason given in "No impact gate".
- **[Documentation quality audit](documentation-quality-audit.md)**
  (2026-10-28/29) was a finite, point-in-time correction of the existing
  pages. Release-status lines went stale again with the next releases. That is
  the gap this plan closes with mechanisms rather than another audit: a guide
  without per-page status, generated regions, compiled examples, and a pass
  per release. W1b applies the audit's vocabulary rule unchanged.

## Risks

| Risk | Mitigation |
| --- | --- |
| The tutorial cannot reach a running store from npm at the current release (candidate archive, owner SQL for the first operator). | S4 records each blocked step as an owner finding. The tutorial states the limit; the product fix is separate work. |
| The pattern list rejects real API names or legitimate text. | Allow-list in the contract, reviewed like any rule. The list stays short; anything not expressible as a pattern stays with review. |
| A prose change slips through without a guide update, since guide pages keep a review floor of zero. | Compiled examples and generated regions fail on API changes; the per-release pass (S6) compares the release's API diff with the guide; S4 catches a broken first path. If misses appear in practice, the owner can raise the floor for the guide path then. |
| Agent-drafted pages state capabilities that are not true at the release. | Every `ts` fence compiles; generated regions come from code; the owner confirms capability statements in W2 and W3; the review floor is one. |
| The guide and the maintainer pages say different things. | The guide links to evidence pages instead of copying them. The per-release pass lists the guide pages routed to every changed path, maintainer pages included. |
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
| D1 | Adopt S1, S2, S4, S5 and S6 with the exclusions above (no impact gate, review floors unchanged). | Yes. |
| D2 | Where the guide lives. | `packages/core/docs/guide/`: ships with npm without a copy step. Alternative: `docs/guide/` plus a checked copy into core, which adds a generator and a freshness check. |
| D3 | Page order after the tutorial. | Glossary and reference first; then how-to pages for composing the platform, subscriptions, payments in the sandbox, outbox, extensions, upgrade and operations; then concepts. |
| D4 | S4 becomes a required context. | After two green runs on main. |
| D5 | Who runs the per-release documentation pass. | The maintainer's agent during release preparation. A CI agent with an API secret can be added later if the manual step is skipped in practice. |

## Documentation impact

- W1b updates only the pages it corrects, plus the neutrality baseline.
- W1 updates:
  - `docs/platform/DOCUMENTATION.md` (the guide as the reader set, its
    contract, generated regions);
  - `docs/platform/README.md` (route readers to the guide).

  `CONTRIBUTING.md` is unchanged: "Deliver a change", step 2 already requires
  same-PR documentation.
- W4 updates `AGENTS.md`, `docs/platform/AGENT_GUIDE.md` and the adopter kit.
- W6 updates `DOCUMENTATION.md` for the retired corpus.
