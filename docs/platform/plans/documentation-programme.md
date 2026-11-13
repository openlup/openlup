# Documentation programme: one reader guide that stays true

Status: draft plan, version 2 (2026-11-12, after an independent challenge); no
wave is authorised until the owner records the decisions below. The
[intent](documentation-programme-intent.md) states the outcome; the
[reconnaissance](documentation-programme-reconnaissance.md) holds the evidence,
the survey of current practice and the simplification this plan follows (its
section 7). "Changes from version 1" at the end lists what the challenge
changed.
Audience: the maintainer and the agents implementing the programme.

## Task record

- **Outcome.** A reader guide in one directory serves three readers from the
  same bytes:
  - a human evaluating or adopting OpenLup;
  - a coding agent working in an adopter application;
  - openlup.com.

  The documentation contract runs in required CI. It keeps the guide's
  examples compiling, its closed lists generated and its pages free of
  repository-internal language, so an API change that breaks a page fails by
  construction. The getting-started path runs in CI. Every existing file has
  one class and meets that class's standard.
- **Smallest complete scope.**
  - Five mechanisms (S1, S2, S4, S5, S6), each an extension of an existing
    script or job.
  - A guide built from the reader sections of existing pages, moved rather
    than copied, plus what nothing covers today: the tutorial, the glossary
    and the generated reference.
  - Every existing file is classed and brought to its class's standard.
  - The website consumes the guide at the pinned release commit.
- **Exclusions.**
  - Rewriting evidence.
  - Vale, markdownlint, TypeDoc, a hosted docs platform.
  - Per-page version or review-date metadata.
  - A new required CI context or branch-protection change.
  - A new CLI command.
  - An agent maintenance run per merge.
  - An agent evaluation suite beyond the existing smoke matrix.
  - A documentation-impact obligation in the PR record.
  - Any public API change made to suit documentation.
  - Translation.
- **Authority.** This record grants nothing. Each wave needs the owner's
  decisions and an explicit delivery grant. Floors follow
  `scripts/agent-review-decide.mjs`:
  - Any wave touching `config/**`, `package.json`, `packages/*/scripts/**` or
    `scripts/agent-context/**` takes two reviewers. That includes this W0
    branch, which adds catalogue rows.
- **Evidence for completion.** The acceptance criteria and the definition of
  done in the next section.

## Goal, acceptance and execution conditions

### Goal

OpenLup has one documentation set for readers. A human, a coding agent in
an adopter application and openlup.com read it from the same bytes at the
same release. Checks keep it true to the code: a change that would make a
page wrong fails CI instead of landing. Agents write and maintain it under
the existing review rules. The owner decides once and confirms prose claims
in batches, but does not maintain anything by hand.

### Acceptance criteria

The programme is accepted when all of these hold on one release tag. Each
criterion names the check that proves it.

| # | Criterion | Proof |
| --- | --- | --- |
| A1 | **One guide.** `packages/core/docs/guide/` holds the tutorial, how-to, concepts, reference and glossary. Each reader topic is explained in exactly one page. | W3 exit list: every moved section exists once; the destination map has no open row. |
| A2 | **Same bytes everywhere.** The guide in the `@openlup/core` tarball, the file the adopter `AGENTS.md` line points to and openlup.com `/docs/` all come from the same release commit. | `npm pack` listing; the website pin equals the tag; a cold install resolves the template line. |
| A3 | **Drift fails CI.** `docs:check` runs in required CI for all three packages: TypeScript fences compile, generated regions are fresh, links resolve, no repository-internal language. | Required jobs green; each refusal has a falsifying test. |
| A4 | **Facts are generated.** Versions, counts, export lists and capability status appear only in generated regions, never in typed prose. | Contract check over the guide. |
| A5 | **The tutorial works.** It runs from installing the packages to the documented result. | S4 step green on main and against the published npm version; blocking per D4. |
| A6 | **Agents find the right page.** Queries route to the guide without the retired corpora. | `evaluate.mjs` smoke matrix green on the guide alone. |
| A7 | **Existing documentation is aligned.** Every file has one class and meets its standard; evidence is labelled; no stub remains. | Destination map complete; nothing references a removed file. |
| A8 | **openlup.com follows by itself.** A release reaches the site with its claims green and no manual step. | Pin-bump PR green and deployed; `oss:` link check green; a failing bump notifies the owner. |
| A9 | **It stays true.** The release after W5 goes through routine release preparation, with the S6 step run, and needs no documentation repair outside it. | A1–A8 still green on that release. |
| A10 | **Within the boundaries.** No new required CI context, service, secret, linter or scheduled agent. No public API changed for documentation. Review floors as in `scripts/agent-review-decide.mjs` plus D7. | Diff of the programme's PRs; branch protection unchanged. |

### Execution conditions

**Before any wave:**
- The owner has recorded D1–D7.
- W0 has merged.
- The owner has given an explicit delivery grant for that wave.

**Every PR:**
- DCO sign-off, required jobs green, and a native review receipt at the floor
  for the paths it touches.
- The policy and catalogue check passes.
- Documentation moves with the change.
- The smoke matrix has been run and its result is in the PR body.
- A PR that moves a page also leaves a stub, retargets the agent-context
  generator and the routing, and updates the destination map.

**Order:**
- W1 lands before W2 and W3.
- W1b runs alongside them.
- W4's website part lands before the first release that contains W3 moves.
- W5 starts only after the smoke matrix is green on the guide alone.

**Stop and report to the owner, never work around**, if a wave would need
any of:
- a public API change;
- a new required context;
- a loosened check;
- a change under `infra/` or in AWS for the website.

The same applies to a tutorial step that the product cannot yet pass. That
becomes an owner finding.

**Owner involvement:**
- D1–D7, once.
- One batch confirmation of prose claims per W2 and W3 batch.
- Notifications on a failing pin bump.

### Definition of done

The programme is done when A1–A10 hold on a release cut after W5, and on
the routine release that follows it (A9). This plan then becomes a record.
From that point maintenance is the S6 step in release preparation and the
contract in CI, with no programme work left.

## Current state (2026-11-12, tag `openlup-core-v0.38.0`, main `821cfae16`)

- **Reader material is a minority.** Reader explanation is roughly 10–35% of
  the large platform pages across 317 Markdown files, and there is no
  end-to-end path from npm to a running store (reconnaissance §1).
- **Checks verify structure, not truth.**
  - Routing owners and links: `config/doc-routing.json`, 126 anchored owners.
  - API reports with the Migration block.
  - Core's documentation contract
    (`packages/core/scripts/documentation-contract.ts`):
    - runs in required `install-proof` through core's `ci:required`;
    - compiles the README and AGENTS examples against smoke files;
    - generates the maturity tables;
    - refuses links that escape the package;
    - requires six `AGENTS.md` sections.
  - `platform` and `outbox` have no `docs:check`; their `ci:required` is only
    `test:consumer`.
  - The neutrality ratchet (shrink-only counts per file).
  - The installed agent context: `scripts/agent-context/generate.mjs` pulls 12
    routes by exact heading from owner pages and throws when a heading is
    missing.
- **Every new or renamed path needs its own row** in
  `config/openlup-publication-catalog.json` (no globs). The one exception is
  the `packages/*/changes/*.md` fragment pattern
  (`CONTRIBUTING.md` "Deliver a change" catalogue paragraph).
- **Review floors.** Markdown outside rule files has a floor of zero; config,
  manifests and package scripts have two. These were set on 2026-11-06.
- **`install-proof` already has PostgreSQL**, the packed-tarball manifest and
  starter journeys.
- **A closed list of configuration keys exists:** `config/environment-variables.json`.
- **openlup.com depends on OSS files by path and line.** About 100 claims in
  its registry cite `oss:<path>:<lines>`, including the README, the
  architecture page, the AI policy, the engine page and subscription
  workflows. Its content links to `SUBSCRIPTION_ENGINE.md`,
  `docs/platform/README.md` and `AGENT_GUIDE.md`. Its fact generator reads the
  root README's `## Status:` heading. Pin-bump PRs merge and deploy
  automatically once green.

## Target design

### S1 — one reader directory

The guide lives in `packages/core/docs/guide/`. Core is installed with every
`@openlup/*` package, so the guide ships with npm without a copy step, and
openlup.com reads the same path at the pinned commit. The location is the
marker.

```text
packages/core/docs/guide/
  README.md            index: reader paths and page list (also the agent index)
  start/               tutorial: from npm to a running store
  how-to/              one task per page
  concepts/            architecture, ownership, invariants
  reference/           generated tables and closed lists
  glossary.md
```

- **No per-page metadata.** Pages carry no version, date or status. The
  release is the version, and the development-preview status is one sentence
  in the index and one banner on the website.
- **Links.** Links inside the guide are relative. Every link leaving the guide
  is an absolute GitHub URL at the package's release tag
  (`…/blob/openlup-core-v<version>/<path>`). The contract's `--write` mode
  rewrites the version on a version bump, the way the agent-context generator
  already resolves owner links from the package manifest. So the links work
  the same on GitHub, in `node_modules` and on openlup.com, and nobody edits
  them by hand.
- **Style.** The style is written once in the index ("Writing this guide"):
  - one task or concept per page;
  - the reader's goal first;
  - commands that run;
  - invariants and refusals stated plainly;
  - no task IDs, plan names, CI vocabulary or adopter-specific detail.
- **Capability facts.** Maturity and support level appear only in generated
  regions, never in prose. The owner therefore confirms only free-standing
  prose claims, in a batch per PR.

### S2 — one documentation contract for every package and the guide

W1 extends `packages/core/scripts/documentation-contract.ts` and gives
`platform` and `outbox` the same `docs:check` in their `ci:required`, inside
the existing required `install-proof` job. W1 also gives
`packages/core/docs/guide/**/*.md` an implicit catalogue class, mirroring the
changes-fragment rule, so a new guide page needs no catalogue row. Guide pages
get a review floor of one. The contract gains:

1. **Compiled fences.** Every `ts` fence in the guide and in each package's
   README and `AGENTS.md` is extracted and type-checked against the built
   packages. A fence that must not compile is marked `ts nocheck` with a
   reason line.
2. **Generated regions** between `<!-- generated:<name> -->` markers, written
   by `--write` and refused on any difference by `--check`:
   - package maturity for all three packages;
   - published subpaths;
   - configuration keys from `config/environment-variables.json`;
   - refusal and readiness codes;
   - the release tag in outbound links.

   Prose states no count or version.
3. **Reader-language patterns** for the guide:
   - task and milestone IDs, with an allow-list seeded before W1 lands
     (`S3`, `P0`, real API names);
   - absolute filesystem paths;
   - links into `tests/`, `docs/platform/plans/` or `.context/`.

   Store terms are left to the existing neutrality ratchet. A new file starts
   at zero, so the guide stays neutral with no second list; W1 adds `pet` and
   `donor` to the ratchet's counted vocabulary.
4. **Instruction-file size.** A line cap for every `AGENTS.md`, set above the
   six sections core already requires (core's file is 177 lines today).
5. **Pack size.** W1 measures core's pack against `maxFiles` (420) in
   `release-gates.json` before the guide grows.

### No impact gate

No `Docs-impact` line in the PR record; the owner removed that obligation on
2026-11-06 (`9a94ffe7b`). The same protection comes by construction:

- **Code-owned content cannot go stale silently.** Compiled fences and
  generated regions fail when the API changes.
- **Prose is reviewed** by the change's author ("Deliver a change", step 2),
  by the guide's review floor of one, and by the per-release pass (S6).

### S4 — the tutorial runs inside `install-proof`

`guide/start/` marks runnable steps as `sh tutorial` fences. A step in the
existing `install-proof` job runs them in order against its PostgreSQL. It
installs from the packed tarballs, then asserts the documented observable
result.

- **Non-blocking first.** It is `continue-on-error` at first, then blocking
  (D4). No new context or branch-protection change is needed.
- **Time budget.** It stays inside the job's 20-minute timeout.
- **From npm too.** `publish-packages.yml` runs the same steps against the
  registry after its existing registry verification. A failure fails that
  run, which GitHub reports to the maintainer. No issue or bot is added.
- **Gaps are findings.** A step that needs a source checkout or owner SQL is
  an owner finding, stated in the tutorial as a limit.

### S5 — one corpus, three outputs

- **npm.** `packages/core/package.json` `files` adds `docs/guide/**`.
- **Agents in adopter apps.** The adopter kit's `AGENTS.template.md` gains one
  static line: read `node_modules/@openlup/core/docs/guide/README.md` before
  relying on memory. The index is the always-current pointer, because it ships
  with the installed version. `openlup-context search` and its MCP tools index
  the guide beside the existing corpus.
- **openlup.com** reads the guide at the pinned commit through its Git reader.
  The commit hash is the provenance. Outbound links are already absolute, so
  the website rewrites nothing.
- **The bundle exporter** (`--docs-export`), which nothing consumes, is
  retired in W5 together with its documentation section.

### S6 — written with the code, checked once per release

- **Same-PR updates.** The author updates the guide in the same PR as the
  code ("Deliver a change", step 2). A compiled fence or generated region the
  change breaks makes an omission visible in CI.
- **One read-only step in release preparation**, listing:
  - the API-report, catalogue and maintainer-page diff since the previous
    tag;
  - the guide pages routed to those paths;
  - the openlup.com claims and links that cite changed files.

  The maintainer's agent drafts one PR from it. No new workflow, secret or bot
  account.
- **Measure.** `scripts/agent-context/evaluate.mjs` runs against the guide at
  every wave and in this step.

### Existing documentation — one destination and one standard per page

Every existing Markdown file ends in exactly one class, meets that class's
standard, and nothing stays in between. Reader knowledge is moved into the
guide, not copied.

| Class | Standard | Enforced by |
| --- | --- | --- |
| **Guide** (`packages/core/docs/guide/`) | The full reader standard of S1. | S2 in full; review floor of one (W1). |
| **Entry points**: package READMEs (the npm page), root README, package and root `AGENTS.md` | Short. What it is, install, the first example, the maturity table, links into the guide. No ledgers, no release-preparation notes. | S2 in full; size cap for `AGENTS.md`. |
| **Maintainer pages**: contributor process, architecture rules for changing the platform, release mechanics, domain READMEs, reference-app recipes | True at the current main. One canonical home per rule. Concise. Explains how to change OpenLup, not how to use it, and links to the guide for usage. A status line that names its audience. | S2 compiled fences and the absolute-path rule; review under "Deliver a change". |
| **Evidence**: plans, task records, ledgers, proof logs, generated inventories, API reports, changelog history | Frozen. A dated status line ("historical record, YYYY-MM-DD" or "generated"). Not edited except to correct a privacy or safety defect. | The absolute-path rule; the publication catalogue class. |

**Destination map.** This is drawn from the full reading of the 0.38.0
documentation. Paths are relative to the repository root; "move" names what
goes into the guide.

| File | Class after the programme | Moves into the guide |
| --- | --- | --- |
| `packages/core/docs/SUBSCRIPTION_ENGINE.md` | guide | the whole page (concepts); the old path keeps a one-line stub until W6 because `files` and the agent-context routes name it |
| `docs/platform/adopter-kit/README.md` | guide | the whole page (start / adopt from npm); `AGENTS.template.md` stays a template linked from it |
| `examples/neutral-store/docs/customization.md`, `limits.md`, `destinations.md` | guide | whole pages (how-to: customize the starter; reference: limits, routes) |
| `examples/neutral-store/docs/ownership.md` | guide | the ownership table and page ownership (concepts) |
| `examples/own-stack/README.md` | guide | the whole page (how-to: add OpenLup to an existing app) |
| `examples/neutral-store/README.md` | entry point | the walkthrough into the tutorial |
| `README.md` | entry point | "Use OpenLup", the example and current limits into start and reference |
| `packages/{core,platform,outbox}/README.md` | entry point | usage and composition sections into how-to and reference; release-preparation notes leave for the changelog |
| `packages/{core,platform,outbox}/AGENTS.md`, `AGENTS.md` | entry point | nothing; held to the size cap and S2; `docs/platform/AGENT_GUIDE.md` becomes a link to the root `AGENTS.md` |
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

**Moving a page safely.** A move PR does four things together:

1. It moves the sections.
2. It slims the source page to its class standard.
3. It leaves a one-line stub ("Moved to <guide page>") at every moved heading,
   until W5. Inbound anchors, the agent-context routes and `files` keep
   resolving.
4. It retargets `scripts/agent-context/generate.mjs` and `config/doc-routing.json`
   to the guide page.

The root README's `## Status:` heading is a contract: openlup.com reads it.

Moves are batched by source group, not by page, so each two-reviewer review
(routing and generator changes) covers several pages.

**Immediate corrections (W1b)** are limited to pages outside the move set and
to evidence:

- stale release status;
- hand-typed counts that disagree;
- adopter-specific terms presented as generic contract, under the
  [documentation quality audit](documentation-quality-audit.md)'s rule;
- the absolute local path in `plans/oss-m19-g18.md:120`;
- pasted duplicates.

The published-tree check gains one repository-wide rule: no absolute
filesystem paths in tracked Markdown.

## Stages

| Wave | Delivers | Exit |
| --- | --- | --- |
| W0 | Intent, reconnaissance and plan (draft PR; two reviewers because of the catalogue rows). | Owner decisions D1–D7 recorded. |
| W1 | S2 for all three packages; the guide's implicit catalogue class and review floor of one; `pet`/`donor` in the ratchet; the absolute-path rule; the pack-size measurement; the allow-list seed; the empty guide index with the writing rules. Updates `DOCUMENTATION.md` and the catalogue paragraph in `CONTRIBUTING.md`. | Required jobs green; each new refusal has a falsifying test; two reviewers. |
| W1b | Immediate corrections outside the move set. | Each defect fixed, or kept with its reason under the audit's rule; smoke matrix green. |
| W2 | Tutorial, glossary, generated reference, the S4 step (non-blocking). | Contract green; S4 green or each blocked step recorded as an owner finding; owner confirms the prose claims in one batch. |
| W3 | Moves per the destination map, in source-group batches, each with slimming, stubs and retargeted routes; entry points slimmed; evidence labelled. | Every moved section exists once; every map row at its class standard; smoke matrix green on the guide; routes and generator fresh. |
| W4 | S5 for npm and agents: `files`, the template line, `openlup-context` indexing; the root `AGENTS.md` becomes the single agent guide. **In openlup.com, same window:** `/docs/` from the guide; claims and links re-sourced to the guide; a check that every `oss:` link exists at the pin; a failing pin-bump PR notifies the owner; rollback is reverting the pin PR. S6 step added to release preparation. | A cold consumer installs the packed candidate and finds the guide and index; the next release reaches openlup.com with its claims green and no manual step. |
| W5 | Retire stubs, the curated routes table and `AGENT_CONTEXT.md` corpora (once the smoke matrix passes on the guide alone), the bundle exporter and the uninvoked orientation audits. | Nothing references removed files; smoke matrix green. |

**Parallelism.** W1b runs beside W1 and W2. W4's website part starts once W2
has landed, and must land before the first release that contains W3 moves.
Otherwise that release's pin bump turns red on the website's claims.

## Relation to earlier plans

- **[Documentation maintenance](documentation-maintenance.md)** built the
  routing, navigation and bundle this plan reuses or retires. Its impact
  checker was removed on 2026-11-06 and is not brought back.
- **[Documentation quality audit](documentation-quality-audit.md)** was a
  point-in-time correction. Its status lines went stale again with later
  releases, which is the gap these mechanisms close. Its vocabulary rule
  applies unchanged.

## Risks

| Risk | Mitigation |
| --- | --- |
| The tutorial cannot reach a running store from npm (candidate archive, owner SQL). | Stated limits plus owner findings; product fixes are separate work. |
| A move breaks openlup.com's claims or links. | W4's website part lands before the first release with moves; the S6 step lists affected claims; the website checks `oss:` links; reverting the pin PR is the rollback. |
| A move breaks inbound anchors or the agent-context generator. | Stubs until W5; generator and routing retargeted in the move PR. |
| The pattern list rejects legitimate text. | Seeded allow-list; anything not a clean pattern stays with review. |
| Agent-drafted prose states untrue capability. | Capability facts only in generated regions; review floor of one on the guide; owner batch confirmation in W2/W3. |
| Core's pack exceeds its file budget. | Measured in W1 before the guide grows. |

## Cost and budget

- **Agent time.** W1 and W4 are each a few agent-hours plus two-reviewer
  review. W2 and W3 are the bulk. W3 is batched by source group, so about five
  to six two-reviewer PRs instead of twenty. The limiting factor is the
  owner's batch confirmation of prose claims.
- **Running cost.** One step inside an existing job; no new service, secret,
  bot, linter, required context or scheduled agent in this repository.

## Owner decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Adopt S1, S2, S4, S5, S6 as designed above. | Yes. |
| D2 | Guide location. | `packages/core/docs/guide/`. |
| D3 | Order after the tutorial. | Glossary and reference, then how-to, then concepts. |
| D4 | When the S4 step becomes blocking. | After two green runs on main. |
| D5 | Who runs the per-release pass. | The maintainer's agent during release preparation. |
| D6 | Destination map and class standards. | Adopt; a row may change in the PR that moves it. |
| D7 | Review floor of one for guide pages (an exception to the 2026-11-06 floor of zero for Markdown). | Yes: the guide is the only Markdown that ships to npm and deploys to the website automatically. Agent reviewers keep the cost low. |

## Documentation impact

- **W1** updates:
  - `docs/platform/DOCUMENTATION.md`;
  - the catalogue paragraph of `CONTRIBUTING.md`;
  - `scripts/agent-review-decide.mjs` (the guide floor);
  - the publication policy (the implicit class).
- **W3** updates every page in the destination map, `config/doc-routing.json`
  and the agent-context routes.
- **W4** updates:
  - `AGENTS.md`, `docs/platform/AGENT_GUIDE.md` and the adopter kit;
  - the release-preparation documentation;
  - in openlup.com, its claims, links and runbook.
- **W5** removes the retired sections from `DOCUMENTATION.md`.

## Changes from version 1

An independent challenge found the following.

**Repository facts the first version got wrong, and how each is resolved:**

- **Per-path catalogue rows and two-reviewer config paths.**
  - Resolved by the guide's implicit catalogue class.
  - Moves are batched.
- **Core's contract rejects links that leave the package.**
  - Resolved by absolute links at the release tag, rewritten by the
    contract.
- **No `docs:check` in `platform` or `outbox`.**
  - Added in W1.
- **`openlup-context init` does not exist.**
  - Replaced by one static template line.

**Missing safeguards, now added:**

- **Cross-repository breakage on openlup.com** (line-cited claims, links,
  the README status heading).
  - W4's website part is ordered before moves are released.
  - The `oss:` link check.
  - Owner notification on a failing pin bump.
  - Rollback by reverting the pin PR.
- **Moved headings that the agent-context generator and routing read.**
  - Stubs.
  - Retargeting in the same PR.

**Simplifications and corrections:**

- **The tutorial.** It is now a step in `install-proof`, not a new required
  job.
- **Store terms.** The neutrality ratchet covers them instead of a second
  list.
- **Waves.** W3 and W3b are merged.
- **Retirement.** The unused bundle exporter is retired rather than left.
- **The review floor.** The contradiction between a floor of zero and the
  risk table is resolved as D7.
- **Configuration keys** come from the existing `config/environment-variables.json`.
- **Measurement.** The smoke matrix runs at every wave.

**Added after the challenge:** the goal, the acceptance criteria A1–A10
with their proofs, the execution conditions and the definition of done.
