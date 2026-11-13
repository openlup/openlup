# Intent: documentation that stays true, for readers and coding agents

Status: accepted intent, 2026-11-12; the owner accepted it on 2026-11-13. The
[reconnaissance](documentation-programme-reconnaissance.md) holds the evidence;
the [execution plan](documentation-programme.md) holds the design, stages and
decisions.
Audience: the maintainer deciding the documentation programme, and agents
implementing it.

## Outcome

1. **One reader-facing documentation set.** A reader who installs
   `@openlup/*` from npm, a human evaluating OpenLup, and a coding agent such
   as Claude Code or Codex working in an adopter application can each find,
   in task-oriented pages, how to install, compose, extend, operate and
   upgrade the platform at the release they installed. Each page uses one
   canonical explanation per concept and reads without repository-internal
   context: no task IDs, no plan names, no CI jargon and no adopter-specific
   detail.
2. **Separated layers.** Reader documentation lives in one directory;
   contributor process and evidence (plans, task records, ledgers, generated
   inventories) stay where they are. The directory is the marker, so the npm
   package, the agent instructions in an adopter application and openlup.com
   publish exactly that set from the same bytes at the same commit.
   Every existing file is brought to the standard of its class: reader
   knowledge moves into the guide, entry points become short, maintainer pages
   keep only how to change OpenLup, and evidence is frozen and labelled.
3. **No silent drift.** A change to a public surface (exports, API reports,
   SQL catalogue, configuration keys, CLI, refusal codes, status of a
   capability) cannot land without the affected reader pages being updated or
   explicitly declared unaffected. Examples in reader pages compile or run
   against the code of the same revision. Facts that code can produce
   (versions, counts, export lists, maturity) are generated, not typed.
4. **Kept current by agents under the existing review rules.** Agents write
   and update documentation in the same pull request as the code, and one
   agent pass per release finds what slipped through and opens a reviewed
   pull request. What can be a pattern is enforced by checks, not by memory,
   so the quality holds whichever agent writes.
5. **Proven where it matters most.** The getting-started tutorial runs in CI,
   from installing the packages to the documented result.

## Why

The 0.38.0 bundle holds 317 Markdown files. A review on 2026-11-12 found that
reader-relevant explanation is a minority of the platform pages (roughly
10–35% of the three largest) and that the rest is maintainer evidence:

- status lines that say "unpublished candidate" for code already on npm;
- contradictory snapshot counts across pages;
- adopter-specific terms in generic platform pages;
- a maintainer's local filesystem path in a plan;
- hundreds of task IDs, and about 890 links into source and tests.

There is no end-to-end path from npm to a running store. Agents read the same
files and inherit the same confusion. The website (openlup.com) can publish
only what upstream marks as reader-facing, because a consumer must not
maintain a divergent copy (`DOCUMENTATION.md`, "Consumer integrity").

## Boundaries

- Meaning is authored upstream, at the owning page, in this repository. The
  website and other consumers render the guide at a pinned commit; they do not edit it.
- Existing review floors, DCO, the merge queue and the publication catalogue
  apply unchanged. Documentation agents get no merge or release authority.
- Evidence is not deleted. Plans, task records and ledgers stay in the
  repository and stay linkable; they leave the reader-facing set.
- No stable-framework, support or hosting claim is introduced. The
  development-preview status remains visible on every reader page.
- Generated facts come from the code and catalogues that already own them.
  A new generator replaces a hand-maintained number, never adds a second
  source.
- Simplicity first: existing scripts are extended before a tool is added, and
  no page carries metadata a person must keep updated by hand.

## Non-goals

Rewriting the architecture, changing any public API to suit the documentation,
adopting a hosted documentation platform, translating the documentation, and
designing openlup.com's documentation pages (the website repository owns its
rendering).

## Decisions requested

The plan's [owner decisions](documentation-programme.md#owner-decisions) list
D1–D7 with recommendations: adopting the five mechanisms, where the guide
lives, page order, when the tutorial job becomes required, and who runs the
per-release documentation pass, the destination map with its class standards,
and the guide's review floor.
