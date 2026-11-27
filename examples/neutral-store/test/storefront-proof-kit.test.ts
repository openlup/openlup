// The starter's storefront proof kit, proven without a browser or a database: the proof file and its shipped values,
// the expected result and the judgement of a verdict, the command matchers over the starter's operations, the outcome
// driver over the sandbox marker, the build identity, the verdict file and the summary text.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { once } from 'node:events';
import { storefrontAnchor } from '@openlup/platform/storefront';
import { serializeStorefrontVerdict, storefrontScenarios, type StorefrontScenario } from '@openlup/platform/storefront/testing';
import { digestStorefrontFiles, parseStorefrontVerdict, type StorefrontVerdict } from '@openlup/platform/lifecycle';
import {
  assertRunnerIsolates, createStarterOutcomeDriver, expectedStorefrontResult, formatStorefrontProofSummary,
  judgeStorefrontVerdict, readStorefrontProof, shippedStorefrontProof, starterSandboxOutcomes, starterStorefrontCommands,
  storefrontBuildIdentity, writeStorefrontVerdict, type StorefrontProof,
} from '../browser/storefront-proof-kit.ts';
import { operations, type Operation } from '../shared/api.ts';
import { actionPath, act } from '../shared/transport.ts';
import { sandboxOutcomeAttribute } from '../shared/storefront-bindings.ts';
import { parseSelectionEntry } from '../shared/selection-entry.ts';
import { validateCart } from '../shared/offer.ts';
import { routes } from '../shared/routes.ts';
import { configurations } from '../owned/store.config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const kitPath = join(root, 'browser/storefront-proof-kit.ts');
const declared = Object.keys(starterSandboxOutcomes);
const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function application(files: Record<string, string | Buffer> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'storefront-proof-kit-'));
  temporary.push(directory);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  return directory;
}

type StarterRefusal = Error & { code: string; observed: string; causeText: string; fix: string; recheck: string };
async function refusalOf(run: () => Promise<unknown> | unknown): Promise<StarterRefusal> {
  try { await run(); } catch (error) { return error as StarterRefusal; }
  assert.fail('expected a refusal');
}
function assertFourParts(error: StarterRefusal, code: string): void {
  assert.equal(error.code, code, error.message);
  for (const part of ['observed', 'causeText', 'fix', 'recheck'] as const) {
    assert.equal(typeof error[part], 'string', part);
    assert.ok(error[part].trim().length > 0, `${code}: ${part} is empty`);
  }
}

// The shipped values as a file. Never the owned file itself: a store edits it, and this managed test must hold for
// every store. A repository-only test pins the shipped file to these values.
const shippedText = async () => JSON.stringify(shippedStorefrontProof, null, 2);
const firstConfiguration = Object.keys(configurations)[0]!;

// ---------------------------------------------------------------------------------------------------------------
// T3: proof-file states (K3)

test('K3 row 1: an absent proof file reads as the shipped values with no file digest', async () => {
  const proof = await readStorefrontProof(await application());
  assert.equal(proof.source, 'shipped');
  assert.equal(proof.digest, null);
  assert.deepEqual(proof.proofFile, shippedStorefrontProof);
  assert.equal(proof.configuration, firstConfiguration);
});

test('K3 row 2: the shipped file reads as a file with the digest of its bytes', async () => {
  const text = await shippedText();
  const proof = await readStorefrontProof(await application({ 'owned/storefront-proof.json': text }));
  assert.equal(proof.source, 'file');
  assert.deepEqual(proof.proofFile, shippedStorefrontProof);
  assert.equal(proof.digest, await digestStorefrontFiles([{ path: 'owned/storefront-proof.json', bytes: new TextEncoder().encode(text) }]));
});

test('K3 row 3: an edited valid file keeps its values', async () => {
  const edited = { ...JSON.parse(await shippedText()), widths: [390], autoProgress: ['continue_payment'] };
  edited.routes.surfaces.cart = '/basket';
  const text = JSON.stringify(edited);
  const proof = await readStorefrontProof(await application({ 'owned/storefront-proof.json': text }));
  assert.equal(proof.source, 'file');
  assert.deepEqual(proof.proofFile.widths, [390]);
  assert.deepEqual(proof.proofFile.autoProgress, ['continue_payment']);
  assert.equal(proof.proofFile.routes?.surfaces?.cart, '/basket');
  assert.equal(proof.digest, await digestStorefrontFiles([{ path: 'owned/storefront-proof.json', bytes: new TextEncoder().encode(text) }]));
});

test('K3 row 4: text that is not a JSON object refuses with the package code at the root', async () => {
  for (const text of ['', 'not json', '[]', '"text"', 'null']) {
    const error = await refusalOf(async () => readStorefrontProof(await application({ 'owned/storefront-proof.json': text })));
    assertFourParts(error, 'storefront_proof_file_invalid');
    assert.equal(error.observed, '(root)', text);
  }
});

test('K3 row 5: a schema refusal is the package refusal naming the path', async () => {
  const shipped = JSON.parse(await shippedText());
  for (const [change, path] of [
    [{ widths: [] }, 'widths'],
    [{ routes: { ...shipped.routes, surfaces: { ...shipped.routes.surfaces, cart: 'https://shop.example.test/cart' } } }, 'routes.surfaces.cart'],
    [{ buyer: { email: 'someone@example.test' } }, 'buyer.email'],
  ] as const) {
    const error = await refusalOf(async () => readStorefrontProof(await application({ 'owned/storefront-proof.json': JSON.stringify({ ...shipped, ...change }) })));
    assertFourParts(error, 'storefront_proof_file_invalid');
    assert.equal(error.observed, path);
  }
});

test('K3 row 6: another format version refuses with the package code', async () => {
  const error = await refusalOf(async () => readStorefrontProof(await application({
    'owned/storefront-proof.json': JSON.stringify({ ...JSON.parse(await shippedText()), formatVersion: 2 }) })));
  assertFourParts(error, 'storefront_proof_file_version_unsupported');
});

test('K3 row 7: more than one configuration refuses; this tier proves one', async () => {
  const ids = [firstConfiguration, `${firstConfiguration}-second`];
  const error = await refusalOf(async () => readStorefrontProof(await application({
    'owned/storefront-proof.json': JSON.stringify({ ...JSON.parse(await shippedText()), configurations: ids }) })));
  assertFourParts(error, 'starter_storefront_proof_configuration_count');
});

test('K3 row 8: an unknown configuration refuses naming it and the known ids', async () => {
  const error = await refusalOf(async () => readStorefrontProof(await application({
    'owned/storefront-proof.json': JSON.stringify({ ...JSON.parse(await shippedText()), configurations: ['x'] }) })));
  assertFourParts(error, 'starter_storefront_proof_configuration_unknown');
  assert.match(error.observed, /"x"/);
  for (const id of Object.keys(configurations)) assert.ok(`${error.observed} ${error.fix}`.includes(id), id);
});

test('K3 row 9: an adapter module refuses at this tier and is never imported', async () => {
  const directory = await application();
  const marker = join(directory, 'imported.txt');
  await writeFile(join(directory, 'adapter.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'imported');\nthrow new Error('adapter module imported');\n`);
  await mkdir(join(directory, 'owned'));
  await writeFile(join(directory, 'owned/storefront-proof.json'), JSON.stringify({ ...JSON.parse(await shippedText()), adapterModule: 'adapter.mjs' }));
  const error = await refusalOf(() => readStorefrontProof(directory));
  assertFourParts(error, 'starter_storefront_adapter_unsupported');
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('K3 row 10: a directory, a dangling link or an unreadable file at the path refuses', async () => {
  const directory = await application();
  await mkdir(join(directory, 'owned/storefront-proof.json'), { recursive: true });
  assertFourParts(await refusalOf(() => readStorefrontProof(directory)), 'starter_storefront_proof_file_unreadable');
  const dangling = await application();
  await mkdir(join(dangling, 'owned'));
  await symlink(join(dangling, 'owned/missing.json'), join(dangling, 'owned/storefront-proof.json'));
  assertFourParts(await refusalOf(() => readStorefrontProof(dangling)), 'starter_storefront_proof_file_unreadable');
  if (process.getuid?.() !== 0) {
    const locked = await application({ 'owned/storefront-proof.json': await shippedText() });
    await chmod(join(locked, 'owned/storefront-proof.json'), 0o000);
    assertFourParts(await refusalOf(() => readStorefrontProof(locked)), 'starter_storefront_proof_file_unreadable');
  }
});

test('K3 rows 11-13: a missing selection entry, another policy and host fields still load', async () => {
  const shipped = JSON.parse(await shippedText());
  const { one_time: _oneTime, ...selectionEntry } = shipped.routes.selectionEntry;
  for (const change of [
    { routes: { ...shipped.routes, selectionEntry } },
    { changedPayloadPolicy: 'update_in_place' },
    { host: { note: 'kept, never read' } },
  ]) {
    const text = JSON.stringify({ ...shipped, ...change });
    const proof = await readStorefrontProof(await application({ 'owned/storefront-proof.json': text }));
    assert.equal(proof.source, 'file');
    for (const [key, value] of Object.entries(change)) assert.deepEqual((proof.proofFile as Record<string, unknown>)[key], value);
    assert.match(proof.digest!, /^sha256:[0-9a-f]{64}$/);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// T1 and T1b: expected result and judgement (K1, K2, K4)

const runId = 'run-0001-abcd';
const width = 1280;
const proofDigest = 'sha256:' + 'a'.repeat(64);
const clientDigest = 'sha256:' + 'b'.repeat(64);
const proof: StorefrontProof = { source: 'file', proofFile: shippedStorefrontProof, digest: proofDigest, configuration: firstConfiguration };
const identity = {
  build: {
    source: 'claimed' as const,
    packages: [
      { name: '@openlup/core', version: '9.9.9', integrity: 'sha512-' + 'c'.repeat(86) + '==' },
      { name: '@openlup/outbox', version: '9.9.9' },
      { name: '@openlup/platform', version: '9.9.9' },
    ],
    clients: [{ name: 'managed', digest: clientDigest }],
    proofFile: proofDigest as string | null,
  },
  harness: { runnerVersion: '9.9.9' },
};

function scenario(id: string, outcomes: string[], control: StorefrontScenario['control']['kind']): StorefrontScenario {
  return {
    id, title: id, purchaseMode: 'one_time', requires: { outcomes }, budget: { creates: 2 },
    text: { stimulus: 's', safety: 's', progress: 'p', control: 'c' },
    steps: [{ kind: 'arrange' }, { kind: 'act', action: 'place_order' }],
    safety: {}, control: { kind: control, negates: control === 'none' ? null : 'awaiting_payment' },
  };
}

type Finding = StorefrontVerdict['findings'][number];
const finding = (code: string, run: Finding['run'] = 'clean', step: number | null = 1): Finding =>
  ({ code, run, step, observed: 'Observed text.', cause: 'Cause text.', fix: 'Fix text.', recheck: 'Recheck text.' });

function verdictFor(target: StorefrontScenario, result: string, findings: Finding[] = [], change: (verdict: StorefrontVerdict) => void = () => {}): StorefrontVerdict {
  const notRun = result === 'not_run';
  const verdict: StorefrontVerdict = {
    formatVersion: 1, runId, completedAt: '2026-11-27T10:00:00.000Z', scenario: target.id, tier: 'postgres_sandbox',
    profile: firstConfiguration, channel: 'browser_ui', width, result,
    control: { kind: target.control.kind, negates: target.control.negates, applied: !notRun },
    stimulus: notRun ? {} : { create: 1 },
    steps: notRun ? [] : [{ index: 0, run: 'clean', phase: 'arrange', action: null, expectedAnchor: null, observedAnchors: [], path: '/cart',
      elapsedMs: 5, commands: [], ledger: { orders: 0, payableOrders: 0, holds: 0, attempts: 0, captures: 0 } }],
    findings,
    build: structuredClone(identity.build),
    harness: { runnerVersion: '9.9.9', catalogueVersion: 1, adapter: { kind: 'default', fields: [], digest: null },
      autoProgress: [], observer: 'package', declaredOutcomes: [...declared].sort() },
    durations: { totalMs: 10, byPhase: {} },
  };
  change(verdict);
  return verdict;
}
const runOf = (target: StorefrontScenario) => ({ runId, scenario: target.id, width, proof, identity });
const judge = (target: StorefrontScenario, verdict: unknown) =>
  judgeStorefrontVerdict(expectedStorefrontResult(target, declared), verdict as StorefrontVerdict, runOf(target));
const notAdmittedFindings = () => [finding('tier_unreachable', null, null)];

test('K1: expected result follows admission and the control', () => {
  assert.equal(expectedStorefrontResult(scenario('a', ['declined'], 'block_read'), declared).result, 'passed');
  assert.equal(expectedStorefrontResult(scenario('b', [], 'none'), declared).result, 'safety_only');
  const unreached = expectedStorefrontResult(scenario('c', ['pending', 'settled'], 'block_read'), declared);
  assert.equal(unreached.result, 'not_run');
  assert.deepEqual(unreached.missing, ['pending']);
  // A declared kind the runner does not know is still missing.
  assert.deepEqual(expectedStorefrontResult(scenario('d', ['later_kind'], 'none'), [...declared, 'later_kind']).missing, ['later_kind']);
});

const results = ['passed', 'safety_only', 'failed', 'vacuous', 'not_run:tier_unreachable', 'not_run:other', 'not_run:client_state_unisolated', 'later_result'];
function verdictOfKind(target: StorefrontScenario, kind: string): StorefrontVerdict {
  if (kind === 'not_run:tier_unreachable') return verdictFor(target, 'not_run', notAdmittedFindings());
  if (kind.startsWith('not_run:')) {
    const code = kind.slice('not_run:'.length);
    return verdictFor(target, 'not_run', [finding(code === 'other' ? 'page_failed' : code)]);
  }
  return verdictFor(target, kind, kind === 'failed' ? [finding('duplicate_order')] : kind === 'vacuous' ? [finding('vacuous_progress', 'control')] : []);
}
// Rows 1-30 of T1: admitted x control none x verdict kind; green only where the table says so.
for (const admitted of [true, false]) for (const none of [false, true]) for (const kind of results) {
  const target = scenario(`s_${admitted ? 'admitted' : 'unreached'}_${none ? 'none' : 'control'}`, admitted ? ['declined'] : ['pending'], none ? 'none' : 'block_read');
  const green = admitted ? (none ? kind === 'safety_only' : kind === 'passed') : kind === 'not_run:tier_unreachable';
  test(`K1 T1: admitted ${admitted}, control none ${none}, verdict ${kind}: ${green ? 'green' : 'red'}`, () => {
    const judgement = judge(target, verdictOfKind(target, kind));
    assert.equal(judgement.ok, green, JSON.stringify(judgement));
  });
}

test('K1 rows 19 and 20: a not-admitted verdict is green only with every row-19 field', () => {
  const target = scenario('unreached', ['pending'], 'block_read');
  assert.deepEqual(judge(target, verdictFor(target, 'not_run', notAdmittedFindings())), { ok: true });
  const variants: Array<[string, (verdict: StorefrontVerdict) => void]> = [
    ['two findings', v => { v.findings.push(finding('tier_unreachable', null, null)); }],
    ['another code', v => { v.findings[0]!.code = 'page_failed'; }],
    ['a run', v => { v.findings[0]!.run = 'clean'; }],
    ['a step', v => { v.findings[0]!.step = 0; }],
    ['steps', v => { v.steps.push({ index: 0, run: 'clean', phase: 'arrange', action: null, expectedAnchor: null, observedAnchors: [], path: null, elapsedMs: 0, commands: [], ledger: null }); }],
    ['stimulus', v => { v.stimulus = { create: 0 }; }],
    ['control applied', v => { v.control.applied = true; }],
    ['declared outcomes', v => { v.harness.declaredOutcomes = ['declined']; }],
  ];
  for (const [name, change] of variants) {
    const judgement = judge(target, verdictFor(target, 'not_run', notAdmittedFindings(), change));
    assert.equal(judgement.ok, false, name);
  }
});

test('K2 T1b: each identity check alone is red with its reason', () => {
  const target = scenario('admitted', ['declined'], 'block_read');
  assert.deepEqual(judge(target, verdictFor(target, 'passed')), { ok: true });
  const missing = judge(target, undefined);
  assert.equal(!missing.ok && missing.reason, 'verdict_missing');
  const invalid = judge(target, verdictFor(target, 'passed', [], v => { (v as { completedAt: string }).completedAt = 'yesterday'; }));
  assert.equal(!invalid.ok && invalid.reason, 'verdict_invalid');
  assert.ok(!invalid.ok && invalid.refusal && ['code', 'observed', 'cause', 'fix', 'recheck'].every(part => (invalid.refusal as Record<string, string>)[part]!.length > 0));
  const rows: Array<[string, (verdict: StorefrontVerdict) => void]> = [
    ['run_id_mismatch', v => { v.runId = 'run-0002-abcd'; }],
    ['scenario_mismatch', v => { v.scenario = 'another_scenario'; }],
    ['tier_mismatch', v => { v.tier = 'fixture_preview'; }],
    ['profile_mismatch', v => { v.profile = 'x'; }],
    ['channel_mismatch', v => { v.channel = 'other_channel'; }],
    ['width_mismatch', v => { v.width = 390; }],
    ['proof_file_mismatch', v => { v.build.proofFile = null; }],
    ['clients_mismatch', v => { v.build.clients = [{ name: 'managed', digest: 'sha256:' + 'd'.repeat(64) }]; }],
    ['clients_mismatch', v => { v.build.clients.push({ name: 'owned', digest: clientDigest }); }],
    ['packages_mismatch', v => { delete v.build.packages[0]!.integrity; }],
    ['packages_mismatch', v => { v.build.packages[2]!.version = '9.9.8'; }],
    ['adapter_mismatch', v => { v.harness.adapter = { kind: 'custom', fields: ['actions'], digest: null }; }],
    ['observer_mismatch', v => { v.harness.observer = 'fixture'; }],
    ['declared_outcomes_mismatch', v => { v.harness.declaredOutcomes = ['declined', 'pending', 'settled']; }],
    ['runner_version_mismatch', v => { v.harness.runnerVersion = '9.9.8'; }],
    ['auto_progress_mismatch', v => { v.harness.autoProgress = ['continue_payment']; }],
    ['catalogue_version_mismatch', v => { v.harness.catalogueVersion = 2; }],
  ];
  for (const [reason, change] of rows) {
    const judgement = judge(target, verdictFor(target, 'passed', [], change));
    assert.equal(!judgement.ok && judgement.reason, reason, reason);
  }
  // A shipped proof expects no file digest.
  const shipped: StorefrontProof = { ...proof, source: 'shipped', digest: null };
  const run = { ...runOf(target), proof: shipped, identity: { ...identity, build: { ...identity.build, proofFile: null } } };
  const expected = expectedStorefrontResult(target, declared);
  assert.deepEqual(judgeStorefrontVerdict(expected, verdictFor(target, 'passed', [], v => { v.build.proofFile = null; }), run), { ok: true });
  const stale = judgeStorefrontVerdict(expected, verdictFor(target, 'passed'), run);
  assert.equal(!stale.ok && stale.reason, 'proof_file_mismatch');
  // The verdict text is judged the same as its object.
  assert.deepEqual(judge(target, serializeStorefrontVerdict(verdictFor(target, 'passed'))), { ok: true });
});

// T4: every not_run cause is red, except tier_unreachable where the scenario is not admitted.
const notRunCauses = ['tier_unreachable', 'page_failed', 'observer_failed', 'observer_failed', 'arrange_failed', 'outcome_failed',
  'outcome_failed', 'outcome_failed', 'observer_subject_unseen', 'stimulus_not_create', 'stimulus_not_applied',
  'auto_progress_not_performed', 'request_budget_exceeded', 'adapter_matcher_unmatched', 'adapter_anchor_missing',
  'adapter_anchor_missing', 'adapter_anchor_missing', 'anchor_hidden', 'control_not_applied', 'auto_progress_undeclared',
  'client_state_unisolated'];
test('K4 T4: a not_run verdict with each of the 21 causes is red, except tier_unreachable on an expected row', () => {
  assert.equal(notRunCauses.length, 21);
  const admitted = scenario('admitted', ['declined'], 'block_read'), unreached = scenario('unreached', ['pending'], 'block_read');
  for (const [row, code] of notRunCauses.entries()) {
    const scoped = code === 'tier_unreachable' ? [finding(code, null, null)] : [finding(code)];
    assert.equal(judge(admitted, verdictFor(admitted, 'not_run', scoped)).ok, false, `row ${row + 1} admitted ${code}`);
    assert.equal(judge(unreached, verdictFor(unreached, 'not_run', scoped)).ok, code === 'tier_unreachable', `row ${row + 1} unreached ${code}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// T5 formatting (K5)

test('K5 T5: the summary line, finding lines, subject redaction, unexpected results and no verdicts', () => {
  const context = { configuration: firstConfiguration, clientDigest };
  const empty = formatStorefrontProofSummary([], context);
  assert.deepEqual(empty.split('\n'), [`storefront proof: tier postgres_sandbox; configuration ${firstConfiguration}; client root dist; client digest ${clientDigest}; verdicts .context/storefront-verdicts; 0 passed, 0 safety_only, 0 not_run (declared), 0 other`]);
  const admitted = scenario('admitted_one', ['declined'], 'block_read'), safety = scenario('safety_one', [], 'none'), unreached = scenario('unreached_one', ['pending'], 'block_read');
  const subjectFinding = (run: 'clean' | 'control') => ({ ...finding('stimulus_not_applied', run, 3),
    observed: `The page sent no create for storefront-${runId}-${run}@example.test.`, cause: `Subject storefront-${runId}-clean@example.test and storefront-${runId}-control@example.test.` });
  const entries = [
    verdictFor(admitted, 'passed'),
    verdictFor(safety, 'safety_only'),
    verdictFor(unreached, 'not_run', notAdmittedFindings()),
    verdictFor(admitted, 'not_run', [subjectFinding('clean'), subjectFinding('control')]),
  ].map(verdict => ({ verdict, judgement: judgeStorefrontVerdict(expectedStorefrontResult(
    [admitted, safety, unreached].find(item => item.id === verdict.scenario)!, declared), verdict,
  { ...runOf(admitted), scenario: verdict.scenario }) }));
  const lines = formatStorefrontProofSummary(entries, context).split('\n');
  assert.equal(lines[0], `storefront proof: tier postgres_sandbox; configuration ${firstConfiguration}; client root dist; client digest ${clientDigest}; verdicts .context/storefront-verdicts; 1 passed, 1 safety_only, 1 not_run (declared), 1 other`);
  assert.ok(lines.includes(`  unreached_one at ${width}: tier_unreachable (whole scenario): observed Observed text. cause Cause text. fix Fix text. recheck Recheck text.`), lines.join('\n'));
  const unexpected = lines.findIndex(line => line.startsWith(`  admitted_one at ${width}: UNEXPECTED not_run`));
  assert.ok(unexpected > 0, lines.join('\n'));
  assert.ok(lines[unexpected + 1]!.startsWith(`  admitted_one at ${width}: stimulus_not_applied (clean step 3): observed The page sent no create for <subject>.`), lines[unexpected + 1]);
  assert.ok(lines[unexpected + 2]!.includes('(control step 3)'));
  const text = lines.join('\n');
  assert.doesNotMatch(text, /@example\.test/);
  assert.match(text, /cause Subject <subject> and <subject>\./);
});

// ---------------------------------------------------------------------------------------------------------------
// T6 outcome driver (K6)

type Target = { attribute: 'action' | 'state' | 'field' | 'value'; value: string } | { locator: string };
function recordingPage(buttons: Array<{ value: string; enabled: boolean }>) {
  const calls: string[] = [];
  const matches = (target: Target) => 'locator' in target ? buttons.filter(item => target.locator === `[${sandboxOutcomeAttribute}="${item.value}"]`) : [];
  const page = {
    async find(target: Target, options: { timeoutMs: number }) {
      calls.push(`find ${JSON.stringify(target)} ${options.timeoutMs}`);
      return matches(target).length ? { width: 10, height: 10, insideScrollArea: false, hidden: false, transparent: false, coveredAtCentre: false } : null;
    },
    async perform(target: Target, options: { timeoutMs: number }) {
      calls.push(`perform ${JSON.stringify(target)} ${options.timeoutMs}`);
      const first = matches(target)[0];
      return first !== undefined && first.enabled;
    },
  };
  const counter = { locator(selector: string) {
    calls.push(`count ${selector}`);
    return { count: async () => buttons.filter(item => selector === `[${sandboxOutcomeAttribute}="${item.value}"]`).length };
  } };
  return { page, counter, calls };
}
const driverOf = (buttons: Array<{ value: string; enabled: boolean }>) => {
  const recorded = recordingPage(buttons);
  return { ...recorded, driver: createStarterOutcomeDriver(recorded.page as never, { timeoutMs: 250, counter: recorded.counter }) };
};

test('K6 T6 rows 1 and 4: one enabled marker button per declared outcome is clicked', async () => {
  for (const [outcome, value] of [['declined', 'refused'], ['settled', 'captured']] as const) {
    const { driver, calls } = driverOf([{ value: 'captured', enabled: true }, { value: 'refused', enabled: true }, { value: 'expired', enabled: true }]);
    assert.deepEqual(driver.capabilities, ['declined', 'settled']);
    await driver.produce(outcome, { subject: 'storefront-run-0001-abcd-clean@example.test' });
    const selector = `[${sandboxOutcomeAttribute}="${value}"]`;
    assert.deepEqual(calls, [`find ${JSON.stringify({ locator: selector })} 250`, `count ${selector}`, `perform ${JSON.stringify({ locator: selector })} 250`]);
  }
});

test('K6 T6 rows 2, 3, 5 and 6: no button or a disabled one rejects naming the outcome and the marker value', async () => {
  for (const [outcome, value] of [['declined', 'refused'], ['settled', 'captured']] as const) {
    for (const buttons of [[], [{ value, enabled: false }]]) {
      const { driver } = driverOf(buttons);
      const error = await refusalOf(() => driver.produce(outcome, { subject: 'x' }));
      assertFourParts(error, 'starter_storefront_outcome_control_missing');
      assert.ok(error.observed.includes(outcome) && error.observed.includes(value), error.observed);
    }
  }
});

test('K6 T6 row 7: more than one matching button rejects naming the count, and nothing is clicked', async () => {
  for (const [outcome, value] of [['declined', 'refused'], ['settled', 'captured']] as const) {
    const { driver, calls } = driverOf([{ value, enabled: true }, { value, enabled: true }]);
    const error = await refusalOf(() => driver.produce(outcome, { subject: 'x' }));
    assertFourParts(error, 'starter_storefront_outcome_control_ambiguous');
    assert.match(error.observed, /\b2\b/);
    assert.equal(calls.filter(call => call.startsWith('perform')).length, 0);
  }
});

test('K6 T6 rows 8-11: an undeclared outcome rejects before any page call', async () => {
  for (const outcome of ['pending', 'settled_after_pending', 'activation_pending', 'a_later_kind', 'constructor', '__proto__']) {
    const { driver, calls } = driverOf([{ value: 'captured', enabled: true }]);
    assertFourParts(await refusalOf(() => driver.produce(outcome, { subject: 'x' })), 'starter_storefront_outcome_undeclared');
    assert.deepEqual(calls, []);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Declaration pin (K7)

test('K7: the kit declares exactly declined and settled, and admission follows from it', () => {
  assert.deepEqual(Object.keys(starterSandboxOutcomes), ['declined', 'settled']);
  assert.deepEqual({ ...starterSandboxOutcomes }, { declined: 'refused', settled: 'captured' });
  assert.ok(Object.isFrozen(starterSandboxOutcomes));
  const admitted = storefrontScenarios.filter(item => expectedStorefrontResult(item, declared).result !== 'not_run').map(item => item.id).sort();
  assert.deepEqual(admitted, ['decline_retry', 'duplicate_submit', 'lost_response_edited_payload', 'lost_response_reload']);
  for (const id of ['reload_pending_attempt', 'paid_pending_activation']) {
    assert.equal(expectedStorefrontResult(storefrontScenarios.find(item => item.id === id)!, declared).result, 'not_run', id);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// T8 matchers (K8, K8b)

const readOperations: Operation[] = ['checkout.read', 'checkout.continuation', 'checkout.recovery', 'checkout.payment'];
test('K8 T8 rows 1-10: create and read match only their POST paths', () => {
  const create = starterStorefrontCommands.create, read = starterStorefrontCommands.read;
  assert.equal(starterStorefrontCommands.keyHeader, 'idempotency-key');
  assert.equal(create({ method: 'POST', path: actionPath('checkout.create') }), true);
  assert.equal(read({ method: 'POST', path: actionPath('checkout.create') }), false);
  for (const operation of readOperations) {
    assert.equal(read({ method: 'POST', path: actionPath(operation) }), true, operation);
    assert.equal(create({ method: 'POST', path: actionPath(operation) }), false, operation);
  }
  for (const operation of ['checkout.paymentSimulate', 'checkout.recoverySimulate', 'payment.simulate', 'checkout.tokenPay', 'checkout.inlineRetry'] as Operation[]) {
    assert.equal(read({ method: 'POST', path: actionPath(operation) }), false, operation);
    assert.equal(create({ method: 'POST', path: actionPath(operation) }), false, operation);
  }
  for (const operation of ['checkout.create', ...readOperations, 'checkout.paymentSimulate'] as Operation[]) {
    assert.equal(read({ method: 'GET', path: actionPath(operation) }), false, operation);
    assert.equal(create({ method: 'GET', path: actionPath(operation) }), false, operation);
  }
  // Exactly the four status reads match among every starter operation.
  assert.deepEqual(operations.filter(operation => read({ method: 'POST', path: actionPath(operation) })).sort(), [...readOperations].sort());
  assert.deepEqual(operations.filter(operation => create({ method: 'POST', path: actionPath(operation) })), ['checkout.create']);
});

/** Each request the managed pages send: the operation and the source text of its call, up to the next request. */
async function managedRequests(): Promise<Array<{ file: string; operation: string; call: string }>> {
  const files = [...(await readdir(join(root, 'client/pages'))).map(name => join(root, 'client/pages', name)), join(root, 'client/purchase.ts'),
    join(root, 'shared/storefront-bindings.ts')];
  const found: Array<{ file: string; operation: string; call: string }> = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const matches = [...source.matchAll(/(?:\bact\(\s*|operation:\s*)'([a-z]+\.[A-Za-z]+)'/g)];
    for (const [index, match] of matches.entries()) {
      const start = match.index!, next = matches[index + 1]?.index ?? source.length;
      found.push({ file: relative(root, file).split(sep).join('/'), operation: match[1]!, call: source.slice(start, Math.min(next, start + 400)) });
    }
  }
  return found;
}
test('K8b T8 row 11: every status read of the managed pages is a read operation, and no read carries a simulate', async () => {
  const requests = await managedRequests();
  const reads = requests.filter(item => /action:\s*'inspect'/.test(item.call) || ['checkout.read', 'checkout.continuation'].includes(item.operation));
  assert.ok(reads.length >= 4, JSON.stringify(reads));
  for (const item of reads) assert.ok(readOperations.includes(item.operation as Operation), `${item.file}: ${item.call}`);
  for (const item of requests.filter(entry => readOperations.includes(entry.operation as Operation))) {
    assert.doesNotMatch(item.call, /action:\s*'simulate'/, `${item.file}: ${item.call}`);
  }
  for (const file of ['client/pages/checkout.ts', 'client/purchase.ts', 'shared/storefront-bindings.ts']) {
    assert.doesNotMatch(await readFile(join(root, file), 'utf8'), /'simulate'/, file);
  }
  // No browser witness waits for, or routes, a simulate the managed pages no longer send.
  for (const name of (await readdir(join(root, 'browser'))).filter(item => /\.(?:spec|proof)\.ts$|fixture\.ts$/.test(item))) {
    assert.doesNotMatch(await readFile(join(root, 'browser', name), 'utf8'), /postDataJSON\(\)\??\.action\s*[!=]==?\s*'simulate'/, name);
  }
  // Only the checkout and payment-status pages show a storefront state; the account and repair pages, which send the
  // unmatched account.orders and payment.recover, show none, so those answers never report a scenario's outcome.
  const clientFiles = (await readdir(join(root, 'client'), { recursive: true })).filter(name => name.endsWith('.ts'));
  const stateRenderers: string[] = [];
  for (const name of clientFiles) if ((await readFile(join(root, 'client', name), 'utf8')).includes('storefrontAnchor.state')) stateRenderers.push(name);
  assert.deepEqual(stateRenderers, ['pages/checkout.ts']);
  for (const name of clientFiles) {
    const source = await readFile(join(root, 'client', name), 'utf8');
    if (/'(?:account\.orders|payment\.recover)'/.test(source)) assert.ok(!stateRenderers.includes(name.split(sep).join('/')), name);
  }
  // The sandbox outcome groups post the sandbox operations.
  const posted = requests.filter(item => item.file === 'client/pages/checkout.ts').map(item => item.operation);
  for (const operation of ['checkout.paymentSimulate', 'checkout.recoverySimulate', 'payment.simulate']) assert.ok(posted.includes(operation), operation);
});

// ---------------------------------------------------------------------------------------------------------------
// K9: the kit (and the runner spec, when present) holds nothing store-specific

function stringLiterals(source: string): string[] {
  const tokens = source.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g) ?? [];
  return tokens.filter(token => !token.startsWith('//') && !token.startsWith('/*')).map(token => token.slice(1, -1));
}
function storeSpecificFindings(source: string): string[] {
  const findings: string[] = [];
  const literals = stringLiterals(source);
  const routeValues = Object.values(routes).flatMap(value => Object.values(value) as string[]);
  for (const literal of literals) {
    if (literal.startsWith('/')) findings.push(`a string starting with /: ${literal}`);
    if (Object.keys(configurations).includes(literal)) findings.push(`a configuration id: ${literal}`);
    if (routeValues.includes(literal)) findings.push(`a route value: ${literal}`);
  }
  if (/\bgetBy[A-Z]/.test(source)) findings.push('a getBy locator');
  if (/\$\(/.test(source.replaceAll('${', ''))) findings.push('a $( locator');
  const selectors = literals.filter(literal => /\[[^\]]*\]/.test(literal));
  const builder = '[${sandboxOutcomeAttribute}="${value}"]';
  if (selectors.length !== 1 || selectors[0] !== builder) findings.push(`selector literals other than the one marker builder: ${JSON.stringify(selectors)}`);
  if (literals.some(literal => literal.includes(sandboxOutcomeAttribute))) findings.push('a literal marker attribute');
  const locatorCalls = source.match(/\blocator\(/g)?.length ?? 0;
  if (locatorCalls !== 1 || !/\bcounter\.locator\(/.test(source)) findings.push(`locator( calls other than the one counter call: ${locatorCalls}`);
  return findings;
}
test('K9: the kit holds no configuration id, route, path literal or locator beyond the one marker builder', async () => {
  const kit = await readFile(kitPath, 'utf8');
  assert.deepEqual(storeSpecificFindings(kit), []);
  const specSource = await readFile(join(root, 'browser/storefront-runner.spec.ts'), 'utf8').catch(() => null);
  if (specSource !== null) {
    assert.deepEqual(storeSpecificFindings(specSource).filter(item => !item.startsWith('selector literals') && !item.startsWith('locator(')), []);
  }
  // Negative witnesses: each planted pattern is found.
  for (const planted of [`'${routes.cart.en}'`, `'${firstConfiguration}'`, 'page.locator(selector)', `'[${sandboxOutcomeAttribute}="refused"]'`,
    '(value: string) => `[${sandboxOutcomeAttribute}="${value}"]`', 'page.getByRole(name)']) {
    assert.notDeepEqual(storeSpecificFindings(`${kit}\nconst planted = ${planted};\n`), [], planted);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// K10: the anchors every admitted scenario needs are rendered from storefrontAnchor by the managed pages

test('K10: every action and state of an admitted scenario is referenced from storefrontAnchor in client/pages', async () => {
  const sources = (await Promise.all((await readdir(join(root, 'client/pages'))).map(name => readFile(join(root, 'client/pages', name), 'utf8')))).join('\n');
  const admitted = storefrontScenarios.filter(item => expectedStorefrontResult(item, declared).result !== 'not_run');
  const actions = new Set<string>(), states = new Set<string>();
  for (const item of admitted) for (const step of item.steps) {
    if (step.kind === 'act') actions.add(step.action);
    if (step.kind === 'expect') {
      states.add(step.state);
      for (const offer of step.offers) actions.add(offer);
      for (const progress of Object.values(step.byPolicy ?? {})) { states.add(progress.state); for (const offer of progress.offers) actions.add(offer); }
    }
  }
  assert.ok(actions.size > 0 && states.size > 0);
  for (const name of actions) {
    assert.ok(Object.hasOwn(storefrontAnchor.action, name), name);
    assert.ok(sources.includes(`storefrontAnchor.action.${name}`), `action ${name}`);
  }
  for (const name of states) {
    assert.ok(Object.hasOwn(storefrontAnchor.state, name), name);
    assert.ok(sources.includes(`storefrontAnchor.state.${name}`), `state ${name}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// K11: the shipped selection entries open a valid cart in their own mode

test('K11: each shipped selection entry parses into a cart the proof configuration accepts, in its mode', () => {
  const config = configurations[shippedStorefrontProof.configurations[0]!]!;
  const entries = shippedStorefrontProof.routes?.selectionEntry ?? {};
  assert.deepEqual(Object.keys(entries).sort(), ['one_time', 'subscription']);
  for (const [mode, path] of Object.entries(entries)) {
    const url = new URL(path, 'http://127.0.0.1');
    assert.equal(url.pathname, routes.cart[config.market.defaultLocale]);
    const parsed = parseSelectionEntry(config, url.searchParams);
    assert.equal(parsed.kind, 'read', path);
    if (parsed.kind !== 'read') continue;
    assert.equal(parsed.candidate.mode, mode);
    const valid = validateCart(config, parsed.candidate);
    assert.equal(valid.ok, true, `${mode}: ${JSON.stringify(valid)}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// K12 and K12b: the sandbox outcome marker

class FakeNode {
  readonly attributes = new Map<string, string>();
  readonly children: FakeNode[] = [];
  className = '';
  disabled = false;
  readonly tag: string;
  readonly text: string;
  constructor(tag: string, text = '') { this.tag = tag; this.text = text; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  appendChild(child: FakeNode) { this.children.push(child); return child; }
  addEventListener() {}
  replaceChildren(...nodes: FakeNode[]) { this.children.splice(0, this.children.length, ...nodes); }
  all(): FakeNode[] { return [this, ...this.children.flatMap(child => child.all())]; }
}
test('K12: actionForm sets the marker on the submit button only when sandboxOutcome is given', async t => {
  const globals: Array<[string, unknown]> = [
    ['document', { createElement: (tag: string) => new FakeNode(tag), createTextNode: (text: string) => new FakeNode('#text', text) }],
    ['Node', FakeNode],
  ];
  for (const [name, value] of globals) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  const { actionForm } = await import('../client/forms.ts');
  const context = { t: (key: string) => key, locale: 'en' } as never;
  const nodes = (form: unknown) => (form as FakeNode).all();
  const submitOf = (form: unknown) => nodes(form).find(node => node.tag === 'button' && node.getAttribute('type') === 'submit')!;
  for (const outcome of ['captured', 'refused', 'expired', 'indeterminate'] as const) {
    const marked = actionForm(context, { operation: 'checkout.paymentSimulate', submit: 'simulatePaid', sandboxOutcome: outcome });
    assert.equal(submitOf(marked).getAttribute(sandboxOutcomeAttribute), outcome);
    assert.equal(nodes(marked).filter(node => node.hasAttribute(sandboxOutcomeAttribute)).length, 1);
  }
  const plain = actionForm(context, { operation: 'checkout.tokenPay', submit: 'recoveryPay' });
  assert.equal(nodes(plain).some(node => node.hasAttribute(sandboxOutcomeAttribute)), false);
  assert.equal(sandboxOutcomeAttribute, 'data-starter-sandbox-outcome');
});

test('K12b: the payment-status page renders its three simulate groups into one state section, one group at a time', async () => {
  const source = await readFile(join(root, 'client/pages/checkout.ts'), 'utf8');
  const start = source.indexOf('export function completionPage'), end = source.indexOf('\nexport function', start + 1);
  const page = source.slice(start, end);
  // Only the payment-status page renders simulate groups, each with its marker.
  assert.equal(source.split('sandboxOutcome:').length - 1, 3);
  assert.equal(page.split('sandboxOutcome: outcome').length - 1, 3);
  // The table of the three groups and the branch that renders each.
  const groups = [
    { operation: 'checkout.recoverySimulate', branch: 'const showStarted' },
    { operation: 'checkout.paymentSimulate', branch: "['dispatched','indeterminate'].includes(String(value.state))" },
    { operation: 'payment.simulate', branch: 'showState(storefrontAnchor.state.awaiting_payment' },
  ];
  for (const group of groups) {
    const at = page.indexOf(`operation: '${group.operation}'`);
    assert.ok(at > 0, group.operation);
    const branch = page.lastIndexOf(group.branch, at);
    assert.ok(branch >= 0 && at - branch < 1200, `${group.operation} renders inside ${group.branch}`);
    assert.ok(page.slice(at, at + 400).includes('sandboxOutcome: outcome'), `${group.operation} carries the marker`);
  }
  // Every group is rendered through showState, which replaces the whole state section: the section is written
  // nowhere else, so a later render removes an earlier group and at most one group is present at a time.
  assert.match(page, /const showState = \(anchor: StateAnchor \| null, \.\.\.nodes: Array<Node \| string>\) => \{\s*line\.set\(anchor\);\s*state\.replaceChildren\(\.\.\.nodes\);\s*\};/);
  assert.equal(page.match(/\bstate\.(?:replaceChildren|append|appendChild|prepend|insertBefore|innerHTML)\b/g)?.length, 1);
  // Each group maps the four distinct outcomes to its buttons, so a marker value matches one button of a group.
  const spaced = page.split("(['captured', 'refused', 'expired', 'indeterminate'] as const).map(outcome =>").length - 1;
  const compact = page.split("(['captured','refused','expired','indeterminate'] as const).map(outcome =>").length - 1;
  assert.equal(spaced + compact, 3);
});

// ---------------------------------------------------------------------------------------------------------------
// K13: one action-path builder

test('K13: act requests actionPath(operation), the host routes it, and no other production module builds one', async () => {
  assert.equal(actionPath('checkout.create'), '/api/actions/checkout.create');
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => { seen.push(String(url)); return new Response(JSON.stringify({ ok: true, value: null })); }) as typeof fetch;
  try { await act('checkout.read', {}, 'k13-command-identity-0001'); } finally { globalThis.fetch = original; }
  assert.deepEqual(seen, [actionPath('checkout.read')]);
  const { createApplication } = await import('../host/server.ts');
  const { pendingBindings } = await import('../host/bindings.ts');
  const server = createApplication(pendingBindings()).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port: address.port, path: actionPath('application.status'), method: 'POST',
        headers: { Host: '127.0.0.1:4319', Origin: 'http://127.0.0.1:4319', 'X-Starter-Request': '1', 'Content-Type': 'application/json', 'Idempotency-Key': 'k13-command-identity-0002' } },
      response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
      outgoing.on('error', reject);
      outgoing.end('{}');
    });
    assert.equal(status, 200);
  } finally { server.close(); }
  // Production modules: everything the application runs, outside tests, browser specs and documentation.
  const production: string[] = [];
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        // Tests, specs, documentation, owned files and tool output (dependencies, builds, reports, hidden directories).
        if (!entry.name.startsWith('.') && !['node_modules', 'dist', 'test', 'browser', 'docs', 'artifacts', 'public', 'release-inputs', 'owned',
          'coverage', 'playwright-report', 'test-results', 'blob-report'].includes(entry.name)) await collect(path);
      } else if (/\.(?:ts|mts|mjs|js|cjs)$/.test(entry.name)) production.push(path);
    }
  }
  await collect(root);
  const builders: string[] = [];
  for (const path of production) if ((await readFile(path, 'utf8')).includes('/api/actions/')) builders.push(relative(root, path).split(sep).join('/'));
  // shared/action-path.ts builds the path; host/server.ts reads it from the request (proven above to accept actionPath).
  assert.deepEqual(builders.sort(), ['host/server.ts', 'shared/action-path.ts']);
});

// ---------------------------------------------------------------------------------------------------------------
// K14: build identity

test('K14: the build identity names the installed packages, the managed client digest and the proof file', async () => {
  const integrity = 'sha512-' + 'e'.repeat(86) + '==';
  const lock = { packages: { 'node_modules/@openlup/core': { version: '7.0.0', integrity },
    'node_modules/@openlup/outbox': { version: '7.0.0' }, 'node_modules/@openlup/platform': { version: '7.0.1' } } };
  const directory = await application({
    'dist/index.html': '<!doctype html>', 'dist/assets/app.js': 'console.log(1)', 'dist/assets/nested/deep.css': 'body{}',
    'node_modules/@openlup/core/package.json': JSON.stringify({ name: '@openlup/core', version: '7.0.0' }),
    'node_modules/@openlup/outbox/package.json': JSON.stringify({ name: '@openlup/outbox', version: '7.0.0' }),
    'node_modules/@openlup/platform/package.json': JSON.stringify({ name: '@openlup/platform', version: '7.0.1' }),
    'package-lock.json': JSON.stringify(lock),
  });
  async function listed(directoryPath: string): Promise<Array<{ path: string; bytes: Uint8Array }>> {
    const files: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const entry of await readdir(directoryPath, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const full = join(entry.parentPath, entry.name);
      files.push({ path: relative(directoryPath, full).split(sep).join('/'), bytes: await readFile(full) });
    }
    return files;
  }
  const shipped: StorefrontProof = { source: 'shipped', proofFile: shippedStorefrontProof, digest: null, configuration: firstConfiguration };
  const first = await storefrontBuildIdentity(directory, shipped);
  assert.deepEqual(first.build.packages, [
    { name: '@openlup/core', version: '7.0.0', integrity },
    { name: '@openlup/outbox', version: '7.0.0' },
    { name: '@openlup/platform', version: '7.0.1' },
  ]);
  assert.equal(first.build.source, 'claimed');
  assert.equal(first.build.proofFile, null);
  assert.deepEqual(first.harness, { runnerVersion: '7.0.1' });
  assert.deepEqual(first.build.clients, [{ name: 'managed', digest: await digestStorefrontFiles(await listed(join(directory, 'dist'))) }]);
  await writeFile(join(directory, 'dist/assets/added.js'), '1');
  const second = await storefrontBuildIdentity(directory, { ...shipped, source: 'file', digest: proofDigest });
  assert.notEqual(second.build.clients[0]!.digest, first.build.clients[0]!.digest);
  assert.equal(second.build.proofFile, proofDigest);
  assertFourParts(await refusalOf(async () => storefrontBuildIdentity(await application(), shipped)), 'starter_storefront_build_identity_unavailable');
});

// ---------------------------------------------------------------------------------------------------------------
// K15: verdict file

test('K15: one verdict file per run, owner-only, parsing as a verdict, with nothing the kit adds', async () => {
  const directory = await application();
  const target = scenario('admitted', ['declined'], 'block_read');
  const key = 'secret-command-key-0001';
  const verdict = verdictFor(target, 'passed', [], v => { v.steps[0]!.commands = [{ operation: 'create', ordinal: 0, key: { present: true, sameAs: null } }]; });
  const path = await writeStorefrontVerdict(directory, verdict);
  assert.equal(path, join(directory, '.context/storefront-verdicts', `admitted.${width}.${runId}.json`));
  const text = await readFile(path, 'utf8');
  assert.equal(text, serializeStorefrontVerdict(verdict));
  assert.equal(parseStorefrontVerdict(text).ok, true);
  assert.ok(!text.includes(key));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, '.context/storefront-verdicts'))).mode & 0o777, 0o700);
  // A run writes its file once.
  await assert.rejects(writeStorefrontVerdict(directory, verdict));
});

// ---------------------------------------------------------------------------------------------------------------
// K16: runner isolation check

test('K16: a page handle without clearClientState refuses naming the installed version', async () => {
  const error = await refusalOf(() => assertRunnerIsolates({} as never, '1.4.0'));
  assertFourParts(error, 'starter_storefront_runner_unisolated');
  assert.match(error.observed, /1\.4\.0/);
  assert.match(error.fix, /clearClientState/);
  assertFourParts(await refusalOf(() => assertRunnerIsolates({ clearClientState: true } as never, '1.4.0')), 'starter_storefront_runner_unisolated');
  assert.doesNotThrow(() => assertRunnerIsolates({ clearClientState: async () => {} } as never, '9.0.0'));
});
