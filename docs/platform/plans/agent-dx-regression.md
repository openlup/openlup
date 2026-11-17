# Record manual agent regression evidence

Status: development-preview guidance.
Audience and purpose: maintainers measuring agent task regressions before a
package-set release, as a manual supplement to M19 A5.
Available profile: local source candidates or an exact published package set;
candidate results establish no public-release acceptance or support commitment.

## Prepare a matched comparison

Use the existing external benchmark folder, its unchanged `briefs/common.md`
and `briefs/t1.md` through `t4.md`, harness and raw logs. Keep the original
`DOSSIER.md`, `SYNTHESIS.md`, `metrics.txt`, briefs and baseline outputs read-only.
Store new preparation records, logs and reports outside the public tree under
that folder's `reruns/<candidate>/`, separating model, task and attempt. Use
synthetic data, no credentials or customer data. This procedure adds no script,
CI job or change to the installed-context lookup evaluation.
Retain the harness bytes; route its working directories and output arguments to
the rerun directory. Do not launch an entrypoint that targets original outputs.

Before starting, record the following in that rerun directory:

- Exact source commits, package versions, lock and artifact hashes, extraction
  mode and preparation commands for both sides. Label unpublished artifacts
  **candidate** throughout. Prepare a paired baseline through the same route
  and isolation as the candidate; use matching extraction modes, dependency
  starting state and fixture setup. An original released run and a new local
  candidate run alone cannot establish a matched improvement.
- Exact model/version, reasoning effort, service tier, settings, harness version
  and invocation, tool permissions, sandbox/network policy and task budget.
  Keep these constant within each model's pair. The original models were
  Sonnet 5.5 through Claude subagents and Codex `gpt-6.1-sol`, high effort,
  standard tier with JSON events. Record unavailable historical settings as
  unknown; do not silently substitute a model or claim equivalence.
- OS, hardware, Node/npm, Docker, database/browser images, dependency/cache state
  and environment configuration. Keep them constant within the pair. Use the
  selected profile's supplied fixtures and no live provider access.
- Counting rules: Sonnet tool calls and Codex commands are different units.
  Retain the raw events and aggregation method. Record wall time in seconds
  (displayed minutes may be rounded), input/output/cache tokens when available,
  and unavailable fields as unknown. Never compare units across models.

Start each task in a fresh context with only its original common/task briefs
and the selected public inputs; keep assessment criteria outside that context.
t1 starts in an empty application directory. t2 and t3 start from independently
extracted applications without dependencies installed. t4 uses a read-only
checkout and writes its report outside it. Keep a fresh baseline/candidate pair
for each attempt; retain failed or interrupted attempts and interventions.

## Run and assess the four tasks

After a change, rerun the affected tasks with Sonnet. Before closing the agent-DX
set, run the full matrix: t1–t4 with both models, eight cells. This is a manual
pre-release regression exercise; execution needs its own task authority.

The descriptions below are neutral summaries. Keep the original briefs unchanged
for comparability; assess supplemental witnesses separately from brief completion.

| Task | Brief outcome | Evidence to assess |
| --- | --- | --- |
| t1: start a store | From an empty folder, run a local store with one monthly subscription product visible and give start instructions. | Show the subscription price in the running storefront and record how the starter was acquired, including extraction identity and any manual manifest/lock construction, packing or candidate preparation. As a separate mixed-store witness, verify prices for both purchase modes and actionable allowlisted price refusals. The brief does not require subscription-only sales. |
| t2: cadence and renewal policy | Offer delivery every two or four weeks and implement three failed-payment retries under the declared seven-day rule, followed by a pause. | Check the 1/3/7-day retry configuration and record actual timestamps and time origin; distinguish delays from the preceding failure from absolute offsets and report any mismatch with the brief. Prove pause only after exhaustion, recovery/recheck prevents an obsolete pause, pause refusal rolls back, and unsupported servicing cadence refuses without writes. A matching completed command replay has one effect, including after cadence configuration changes; conflicting payload replay refuses. Record any files ejected from `managed` to `owned` in `ownership.json`. |
| t3: carrier rate composition | Add a fictional HTTP JSON carrier adapter, configured by the application, with weight-based rates and country refusal; no live access. | Prove the adapter is mounted and its rate contributes to the final quote total. Unsupported destinations refuse with zero provider I/O. Record conformance/refusal evidence and files ejected from `managed` to `owned`; an isolated passing adapter test does not prove mounting. |
| t4: late-delivery diagnosis | Read-only analysis of a report that a parcel arrived late and the next renewal moved earlier: identify computation, enforcement, tests, likely paths and a minimal fix/test plan. | Cite the current function definition, migration order/signature and relevant code/tests rather than an obsolete definition or a textual match alone. State the monotonic invariant correctly: late delivery extends the next cycle without stacking deliveries or moving it earlier. Do not infer that auto-resume moves the cycle earlier. Record stale-link/definition dead ends and unsupported claims. |

Use the [subscription policy recipe](../../../packages/core/docs/guide/concepts/subscriptions.md#pause-a-subscription-after-failed-renewal-retries-are-exhausted),
[carrier quote recipe](../../../packages/core/docs/guide/how-to/extend/provider-adapters.md#quote-a-carrier-shipping-rate-by-weight-at-checkout)
and [current SQL definition lookup](../../../packages/core/docs/guide/upgrade/database-migrations.md#find-the-current-function-definition)
to check the assessment against the selected version's actual owners and tests.
Words such as “no seam” or “hold” in a friction report are diagnostic signals;
behavioral evidence determines correctness.

## Report beside the original baselines

The historical 2026-11-15 runs used package set 0.43.0 and checkout `2c6dc58ce`.
The Sonnet counts below agree with `metrics.txt`; the Codex counts, approximate
times and token splits are recorded in `SYNTHESIS.md` and `DOSSIER.md`.
`k` means thousand tokens and `M` means million tokens.

| Task | Sonnet tool calls | Sonnet time / tokens | Codex commands | Codex time / input, output tokens | Original outcome: Sonnet / Codex |
| --- | --- | --- | --- | --- | --- |
| t1 | 44 | 4.1 min / 130k | 104 | ~15 min / 8.1M, 31k | done, both purchase modes available / done, sandbox purchase and subscription verified |
| t2 | 25 | 2.1 min / 116k | 62 | ~18 min / 7.6M, 39k | partial, exhaustion pause left on hold / done with managed source ejections |
| t3 | 33 | 3.3 min / 153k | 33 | ~10 min / 2.8M, 22k | adapter not mounted / done with two managed source ejections |
| t4 | 15 | 1.8 min / 109k | 35 | ~8 min / 2.9M, 15k | partial, one incorrect claim / done, targeted tests could not run read-only |

Sonnet's historical token figures are harness totals without an input/output
split. Codex times were measured from a shared start to each task's last event
and are approximate. Historical totals do not separate implementation from
verification cost; mark that split unknown rather than reconstructing it by guess.

For each task/model/attempt, report its original baseline, newly prepared paired
baseline and candidate side by side: raw tool calls or commands with their unit,
wall time, tokens and outcome (`done`, `partial`, `blocked`), plus each criterion's
observed pass/fail/unknown and evidence location. Record implementation work and
verification work separately, with their calls/commands, time and tokens, plus
the total. State how mixed events are attributed; keep unassignable cost unknown
and include setup, failed attempts and recovery rather than dropping them.

Retain raw invocations, stdout/stderr, harness events, checks with exits,
changed/owned-file lists, agent friction reports and assessor observations.
Explain preparation differences, unavailable telemetry and interventions beside
the numbers. A single matched run per cell reports an observation, not a general
effect; broader improvement claims require repeated matched runs. There is no
percentage improvement gate for this procedure. If correctness regresses or a
pair is not comparable, record the gap and rerun a fresh matched pair after repair.

## Keep the full blind journey separate

After the released-starter inputs and owned shipping/renewal composition work
(agent-DX PR2, PR5 and PR6), arrange the separate full blind M19 A5 journey. A
fresh agent receives only the public release, public docs and a new business
brief prepared outside its context: create the repository, customize identity
and offer, add an extension, run the app, diagnose a seeded failure and upgrade
with customization surviving. Preserve A5's acceptance: no platform file edits
or author hints; record time, interventions, undocumented decisions and changed
files. Time is not an A5 gate.

A local candidate rehearsal does not close public-release A5; that journey
requires a separately available release. The four isolated tasks do not cover
the seeded failure or upgrade survival. P1-SF DEMO retains its own conditions:
an independent first-party demo repository using npm-only neutral composition,
sandbox providers, its own CI at zero cost without a public URL, retained
install/customize/extend receipts and a 0.43→0.44 upgrade PR there. This procedure
neither executes nor changes those acceptance conditions.

Owner and next links: the [development/release measurement owner](../DEVELOPMENT_AND_RELEASE.md#measuring-delivery-improvements)
and existing [distribution boundary](../DISTRIBUTION_EVIDENCE.md#released-starter-inputs);
[Deliver a change](../../../CONTRIBUTING.md#deliver-a-change) governs task authority
and delivery. The original external benchmark evidence is the source of the
dated baseline; this page records the procedure, not a completed rerun.
