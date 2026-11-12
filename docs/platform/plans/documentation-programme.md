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
  - A guide for readers, built from the reader sections of existing pages,
    which are moved rather than copied, plus the pages nothing covers today:
    the tutorial, the glossary and the generated reference.
  - Every existing file gets one class (guide, entry point, maintainer,
    evidence) and that class's standard (see "Existing documentation").
    Factual defects are corrected first (W1b).
  - The website consumes the guide at the pinned release commit.
- **Exclusions.**
  - Rewriting evidence: plans, task records, ledgers and generated
    inventories stay frozen and are only labelled.
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

### Existing documentation — one destination and one standard per page

Every existing Markdown file ends in exactly one of four classes. Each class
has its own standard, and no file stays in between. Reader knowledge in an
existing page is **moved** into the guide, not copied: the guide becomes its
only home, and the old page keeps only what belongs to its class, with a link
to the guide.

| Class | Standard | Enforced by |
| --- | --- | --- |
| **Guide** (`packages/core/docs/guide/`) | The full reader standard of S1. | S2 in full. |
| **Entry points**: package READMEs (the npm page), root README, package and root `AGENTS.md` | Short. What it is, install, the first example, the maturity table, links into the guide. No ledgers, no release-preparation notes. | S2 in full; size cap for `AGENTS.md`. |
| **Maintainer pages**: contributor process, architecture rules for changing the platform, release mechanics, domain READMEs, reference-app recipes | True at the current main. One canonical home per rule. Concise. Explains how to change OpenLup, not how to use it, and links to the guide for usage. A status line that names its audience. | S2 compiled fences and the absolute-path rule; review under "Deliver a change". |
| **Evidence**: plans, task records, ledgers, proof logs, generated inventories, API reports, changelog history | Frozen. A dated status line ("historical record, YYYY-MM-DD" or "generated"). Not edited except to correct a privacy or safety defect. | The absolute-path rule; the publication catalogue class. |

**Destination map.** This is drawn from the full reading of the 0.38.0
documentation. Paths are relative to the repository root; "move" names what
goes into the guide.

| File | Class after the programme | Moves into the guide |
| --- | --- | --- |
| `packages/core/docs/SUBSCRIPTION_ENGINE.md` | guide | the whole page (concepts) |
| `docs/platform/adopter-kit/README.md` | guide | the whole page (start / adopt from npm); `AGENTS.template.md` stays a template linked from it |
| `examples/neutral-store/docs/customization.md`, `limits.md`, `destinations.md` | guide | whole pages (how-to: customize the starter; reference: limits, routes) |
| `examples/neutral-store/docs/ownership.md` | guide | the ownership table and page ownership (concepts) |
| `examples/own-stack/README.md` | guide | the whole page (how-to: add OpenLup to an existing app) |
| `examples/neutral-store/README.md` | entry point | the walkthrough into the tutorial |
| `README.md` | entry point | "Use OpenLup", the example and current limits into start and reference |
| `packages/{core,platform,outbox}/README.md` | entry point | usage and composition sections into how-to and reference; release-preparation notes leave for the changelog |
| `packages/{core,platform}/AGENTS.md`, `AGENTS.md` | entry point | nothing; held to the size cap and S2; `docs/platform/AGENT_GUIDE.md` becomes a link to the root `AGENTS.md` |
| `docs/platform/ARCHITECTURE_AND_EXTENSIONS.md` | maintainer | ownership, layering, extension seams, adapter conformance, source ejection, package kinds, compatibility posture, application CLI |
| `docs/platform/DATA_AND_MIGRATIONS.md` | maintainer | data ownership, connection roles, the additive forward path, installing the complete catalogue, delivery-alignment modes, the compatibility lifecycle, operator queries |
| `docs/platform/CANONICAL_CONTRACTS.md` | maintainer | canonical status, idempotency, provider adapters and classes, subscription lifecycle and delivery alignment, neutral marketing sync |
| `docs/platform/RUNTIME_AND_SELF_HOSTING.md` | maintainer | the PostgreSQL connection recipe, runtime model, self-host boundary, shutdown, diagnostic history and retention, preview posture |
| `docs/platform/IDENTITY.md` | maintainer | magic-link policy, email trust, operator invitations, direct login and bootstrap, personal data, guest contact resolution, OIDC tokens |
| `docs/platform/PLATFORM_PACKAGE_REFERENCE.md` | maintainer | each composition recipe (prices, app-file upgrade, marketing, invoicing, OMS stores, account and support, SEO slots, bundles, fulfillment, checkout recovery) |
| `docs/platform/SUBSCRIPTION_WORKFLOWS.md` | maintainer | the installed subscription boundary, retry cadence, delivery protection |
| `docs/platform/DEVELOPMENT_AND_RELEASE.md` | maintainer | "Verify the published npm artifact" (how-to) |
| `.github/VERSIONING_AND_EOL.md`, `.github/AI_CONTRIBUTION_POLICY.md` | maintainer | the public parts (versioning lines 1–114; the four rules) into reference; the policy files keep the rest |
| `.github/GOVERNANCE.md`, `TIER_POLICY.md`, `SUPPORT.md`, `SECURITY_RESPONSE_POSTURE.md`, `LICENSE_OF_TRADEMARK_AND_LOGO.md`, `INSTALL_SUPPORT_POLICY.md`, `SECURITY.md` | stay where GitHub expects them, held to the reader standard | nothing moves; the guide links them |
| `CONTRIBUTING.md`, `docs/platform/DOCUMENTATION.md`, `docs/platform/README.md`, `docs/platform/SUBSCRIPTION_REFERENCE.md`, `docs/platform/IDENTITY_BROWSER_REFERENCE.md`, `deploy/neutral-store/README.md`, `src/**/README.md`, `server/**/README.md` | maintainer | nothing; `docs/platform/README.md` becomes the maintainer index and points readers to the guide |
| `docs/platform/plans/**`, `docs/platform/DISTRIBUTION_EVIDENCE.md`, `docs/platform/OUTCOME_PROJECTION.md`, `docs/platform/SOURCE_MAP.md`, `.github/PUBLICATION_COMPLETENESS.md`, `examples/neutral-store/docs/proof.md`, `packages/*/CHANGELOG-HISTORY.md`, `packages/*/api/**` | evidence | nothing; the guide's reference links the API reports at the release tag |
| `packages/*/CHANGELOG.md` | entry point (release notes) | nothing; linked from the guide's upgrade page |

A maintainer page shrinks as its reader sections leave. What remains still
has to meet the maintainer standard. Repeated paragraphs, superseded ledgers
and snapshot counts are removed rather than moved. A long ledger that is only
history moves into a dated evidence file under `plans/`.

**Immediate corrections (W1b).** Agents and readers read the existing pages
now, through GitHub and through the installed `AGENT_CONTEXT.md` excerpts until
W6. Defects in pages that will not be reworked soon are therefore corrected
first, without restructuring:

- **Release status.** Status lines and release notes that call published code
  a candidate or unpublished.
- **Hand-typed counts and versions that disagree.** Selected-plan unit counts,
  replaced by a pointer to the owning manifest or removed.
- **Adopter-specific terms presented as generic platform contract.** The
  [documentation quality audit](documentation-quality-audit.md)'s rule
  applies unchanged: historical facts, opaque adopter values and faithful
  reference descriptions are not defects only because they use application
  vocabulary.
- **The absolute local path** in `plans/oss-m19-g18.md:120`.
- **Pasted duplicates and stale tool references.**

Only one class gets a new repository-wide rule, because only one is
pattern-shaped without false positives: the published-tree check refuses
absolute filesystem paths in any tracked Markdown file. Release status stops
recurring because the guide states none per page. Counts move into generated
regions or pointers. Vocabulary stays a judgement under the audit's rule.

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
| W0 | This intent, reconnaissance and plan, as a Markdown-only draft PR. | Owner decisions D1–D6 recorded. |
| W1 | S2 checks for all three packages and the (empty) guide directory; the S2 `AGENTS.md` cap. Updates `DOCUMENTATION.md`. | Required `install-proof` and `self-check` green. Each new refusal has a falsifying test. |
| W1b | Corrections in existing pages ("Immediate corrections" under "Existing documentation"), as small PRs by file group, plus the absolute-path refusal. No restructuring. | Each listed defect fixed, or kept with its reason under the audit's rule. The absolute-path rule is green with a falsifying test. The 10-query agent-context smoke is still green. |
| W2 | Guide skeleton and index with the writing rules; `start/` tutorial; `glossary.md`; `reference/` generated regions; S4 job (advisory). Authored by agents from code at the current release; every capability statement the owner must confirm is listed in the PR. | S2 green on the guide. S4 job green, or each failing step recorded as an owner finding. Owner confirms the capability statements. |
| W3 | Move reader sections into `how-to/` and `concepts/` per the destination map, in the order of D3, one source page per PR. Each source page keeps only its class's content and links to the guide. | S2 green; every moved section exists in exactly one place; every guide page reachable from the index. |
| W3b | Entry points and maintainer pages brought to their standard: slimmed package and root READMEs (the npm pages), `docs/platform/README.md` as the maintainer index, repeated paragraphs and snapshot counts removed from the shrunken maintainer pages, long history ledgers moved to dated evidence files, dated status lines on evidence. | Every file in the map has its class's status line; S2 green on entry points; no maintainer page restates a guide page. |
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

- **Agent time.** W1 and W4 are each a few agent-hours plus review. W2, W3 and
  W3b are the bulk: about 20 source pages to split, moving sections is fast,
  and the limiting factor is the owner confirming what each capability does at
  the release. W5 is about one wave of
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
| D6 | The destination map and the four class standards. | Adopt as drafted; changes to a row are made in the W3 PR that moves that page. |

## Documentation impact

- W1b updates only the pages it corrects, plus the neutrality baseline.
- W1 updates:
  - `docs/platform/DOCUMENTATION.md` (the guide as the reader set, its
    contract, generated regions);
  - `docs/platform/README.md` (route readers to the guide).

  `CONTRIBUTING.md` is unchanged: "Deliver a change", step 2 already requires
  same-PR documentation.
- W3 and W3b update every page in the destination map, the publication
  catalogue for moved or new evidence files, and `config/doc-routing.json` so
  each route's owner is its guide page where one exists.
- W4 updates `AGENTS.md`, `docs/platform/AGENT_GUIDE.md` and the adopter kit.
- W6 updates `DOCUMENTATION.md` for the retired corpus.
