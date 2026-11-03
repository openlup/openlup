import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REGISTRY_PATHS, readRegistry, registryUnion, strictRegistryJson } from './agent-review-registry.mjs';
import { digest, coverageState, receiptSummary, verdict, ECONOMY_RECEIPT_MARKER } from './agent-review-decide.mjs';
import { captureReviewRules, captureSessionCandidate, captureRenewalProof, sessionMain, validateEconomySession, git as sourceGit } from './agent-review-session.mjs';
import { parseReceipt, waitNativeAdmission } from './agent-review-queue.mjs';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const DAY = 86400000;
const RECORD = 'docs/platform/plans/demo.md';
async function fixture(enabled = true, controls: string[] = [], initialFiles: Record<string, string> = {}) {
  await mkdir('.context/scratch', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), '.context/scratch/review-economy-')); roots.push(cwd);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['--no-replace-objects', '-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const write = async (path: string, value: string) => { await mkdir(dirname(join(cwd, path)), { recursive: true }); await writeFile(join(cwd, path), value); };
  git('init', '-q', '-b', 'main'); await write('.gitignore', '.context/\n');
  if (enabled) await write('scripts/agent-review-decide.mjs', 'export const REVIEW_RULES_VERSION = 3;\n');
  for (const path of REGISTRY_PATHS) await write(path, await readFile(join(process.cwd(), path), 'utf8'));
  for (const path of controls) await write(path, await readFile(join(process.cwd(), path), 'utf8'));
  for (const [path, source] of Object.entries(initialFiles)) await write(path, source);
  await write('app.ts', 'export const before = 1;\n');
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const base = commit(); git('update-ref', 'refs/remotes/origin/main', base);
  await write('app.ts', 'export const before = 2;\n');
  const head = commit();
  const scratch = join(cwd, '.context/scratch'); await mkdir(scratch, { recursive: true });
  const intent = { risk: 'behavior', criteria: 'Preserve the bounded fixture outcome' };
  const request = join(scratch, 'intent.json'); await writeFile(request, JSON.stringify({ authorSessionId: 'author', intent }));
  const cli = (...args: string[]) => sessionMain(args, { cwd, env: {} });
  const state = async () => JSON.parse(await readFile(join(scratch, 'agent-review/session.json'), 'utf8'));
  let reviewer = 0;
  const report = async (patch = {}) => {
    const session = await state(); const path = join(scratch, 'report.json');
    await writeFile(path, JSON.stringify({ reviewer: `cold-${reviewer++}`, tree: session.candidate.tree, cold: true, verdict: 'PASS', findings: [], closes: [], documentation: 'Checked contributor and documentation owners; fixture claims match source.', ...patch }));
    return cli('record', path);
  };
  const review = async () => { await cli('prepare', request); await report(); await report(); return state(); };
  const mainMove = async (change: () => Promise<void>, from = base) => {
    const previous = git('rev-parse', 'HEAD'); git('checkout', '-q', '--detach', from); await change(); const main = commit();
    git('update-ref', 'refs/remotes/origin/main', main); git('checkout', '-q', '--detach', previous); return main;
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return { cwd, git, write, base, head, commit, request, cli, state, report, review, mainMove, scratch };
}
function addRegistry(path: string, source: string, entry: string) {
  if (path === REGISTRY_PATHS[0]) {
    const data = JSON.parse(source); data.publicPaths.push({ path: entry, class: 'public-output' });
    data.publicPaths.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); return JSON.stringify(data, null, 2) + '\n';
  }
  const registry = readRegistry(path, source); const [start, end] = registry.ranges[0];
  const list = [...registry.lists[0], entry]; const replacement = path === REGISTRY_PATHS[1] ? JSON.stringify(list) : `[\n${list.map(value => `  ${JSON.stringify(value)},`).join('\n')}\n]`;
  return source.slice(0, start) + replacement + source.slice(end);
}

describe('closed registry grammar', () => {
  it('rejects duplicate JSON keys and unsupported syntax', () => {
    expect(() => strictRegistryJson('{"a":1,"a":2}')).toThrow('duplicate');
    expect(() => strictRegistryJson('{"a":1,}')).toThrow();
    expect(() => readRegistry(REGISTRY_PATHS[2], 'export const ADAPTER_ENTRIES = [...other] as const;')).toThrow();
  });
  it.each(['class', 'removal', 'reorder', 'duplicate', 'overlap', 'outside'])('refuses %s rather than silently normalize', async kind => {
    const path = REGISTRY_PATHS[0]; const source = await readFile(path, 'utf8');
    const a = JSON.parse(addRegistry(path, source, 'zz-a')); const b = addRegistry(path, source, 'zz-b');
    if (kind === 'class') a.publicPaths[0].class = 'entrypoint';
    if (kind === 'removal') a.publicPaths.shift();
    if (kind === 'reorder') a.publicPaths.reverse();
    if (kind === 'duplicate') a.publicPaths.push(a.publicPaths[0]);
    if (kind === 'outside') a.schemaVersion = 4;
    expect(() => registryUnion(path, source, JSON.stringify(a, null, 2) + '\n', kind === 'overlap' ? JSON.stringify(a, null, 2) + '\n' : b)).toThrow();
  });
});

describe('real Git coverage histories', () => {
  it('inherits a clean disjoint merge with no new reports and retains the original expiry', async () => {
    const f = await fixture(); const prior = await f.review(); const expiry = coverageState(prior).expires;
    const main = await f.mainMove(() => f.write('other.ts', 'independent\n'));
    f.git('merge', '--no-ff', '-qm', 'integrate main', main); await f.cli('prepare', f.request);
    const next = await f.state(); expect(next.candidate.coverage.kind).toBe('integration'); expect(next.cycle).toBe(prior.cycle);
    await expect(f.cli('verify')).resolves.toBe(0); expect(coverageState(next).expires).toBe(expiry);
    expect(next.history.filter(event => event.type === 'report')).toHaveLength(2);
    await validateEconomySession(f.cwd, next);
  });
  it('proves a registry-only conflicting merge by the exact union of current carriers', async () => {
    const f = await fixture();
    for (const path of REGISTRY_PATHS) await f.write(path, addRegistry(path, f.git('show', `${f.base}:${path}`) + '\n', 'zz-row-a'));
    const reviewed = f.commit(); const prior = await f.review();
    const main = await f.mainMove(async () => {
      for (const path of REGISTRY_PATHS) await f.write(path, addRegistry(path, f.git('show', `${f.base}:${path}`) + '\n', 'zz-row-b'));
    });
    expect(() => f.git('merge', '--no-ff', '--no-commit', main)).toThrow();
    for (const path of REGISTRY_PATHS) await f.write(path, registryUnion(path, f.git('show', `${f.base}:${path}`) + '\n', f.git('show', `${reviewed}:${path}`) + '\n', f.git('show', `${main}:${path}`) + '\n'));
    f.commit(); await f.cli('prepare', f.request); const next = await f.state();
    expect(next.candidate.coverage.proof.kind).toBe('registry-union'); expect(next.cycle).toBe(prior.cycle);
    await expect(f.cli('verify')).resolves.toBe(0);
  });
  it.each(['hidden hand edit', 'candidate path', 'machinery path'])('refuses inherited coverage for %s', async kind => {
    const f = await fixture(); await f.review();
    const main = await f.mainMove(() => f.write(kind === 'candidate path' ? 'app.ts' : kind === 'machinery path' ? 'scripts/ci-extra.mjs' : 'other.ts', 'main delta\n'));
    try { f.git('merge', '--no-ff', '--no-commit', main); } catch { await f.write('app.ts', 'manual resolution\n'); }
    if (kind === 'hidden hand edit') await f.write('extra.ts', 'hidden edit\n');
    f.commit(); await f.cli('prepare', f.request); expect((await f.state()).candidate.coverage).toBeUndefined();
    await expect(f.cli('verify')).rejects.toThrow('independent PASS');
  });
  it.each([
    'scripts/check-client-secret-boundary.ts', 'scripts/ast-grep/check-filewide-ignore.mjs',
    'scripts/dco-signoff-check.ts', '.gitleaksignore', 'config/gitleaks.toml',
    'scripts/agent-context/generate.mjs', 'scripts/public-ci-neutrality.mjs',
    'scripts/pgtap-parity.mjs', 'scripts/assert-coverage-no-zero.mjs', 'scripts/site-routes.mjs',
    'packages/outbox/scripts/consumer-proof.ts', 'packages/ui/smoke/neutrality.ts',
    'packages/platform/test/packageBoundary.test.ts', 'packages/outbox/api/index.api.md',
    'docs/platform/communications-conformance.mjs', 'packages/core/scripts/neutrality-tree-counts.ts',
  ])('refuses a required registry union with changed execution guard %s', async path => {
    const f = await fixture(true, [path]); const catalog = REGISTRY_PATHS[0];
    const source = await readFile(path, 'utf8');
    const changed = path === 'scripts/check-client-secret-boundary.ts' ? source.replace('variable.secret === true', 'variable.secret === false')
      : path === 'scripts/ast-grep/check-filewide-ignore.mjs' ? source.replace('return !failed;', 'return true;')
      : path === 'scripts/dco-signoff-check.ts' ? source.replace('missing: commits.filter((commit) => !SIGN_OFF.test(commit.message))', 'missing: []')
      : source + '\n';
    expect(changed).not.toBe(source);
    await f.write(catalog, addRegistry(catalog, f.git('show', `${f.base}:${catalog}`) + '\n', 'zz-row-a'));
    const reviewed = f.commit(); const prior = await f.review();
    const main = await f.mainMove(async () => {
      await f.write(catalog, addRegistry(catalog, f.git('show', `${f.base}:${catalog}`) + '\n', 'zz-row-b'));
      await f.write(path, changed);
    });
    expect(() => f.git('merge', '--no-ff', '--no-commit', main)).toThrow();
    await f.write(catalog, registryUnion(catalog, f.git('show', `${f.base}:${catalog}`) + '\n', f.git('show', `${reviewed}:${catalog}`) + '\n', f.git('show', `${main}:${catalog}`) + '\n'));
    f.commit(); await f.cli('prepare', f.request); const next = await f.state();
    if (!REGISTRY_PATHS.includes(path)) expect(next.candidate.rules.head).not.toBe(prior.candidate.rules.head);
    expect(next.candidate.coverage).toBeUndefined();
    await f.report(); await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
  });
  it('refuses registry-union inheritance when the verification plan replaces gitleaks with a no-op', async () => {
    const path = 'scripts/verification-plan.mjs'; const catalog = REGISTRY_PATHS[0];
    // The command-owning stanza from the verification catalogue; this fixture never executes it.
    const source = `export const definitions = {
  gitleaks: {
    command: () => ['gitleaks', 'git', '.', '--config', 'config/gitleaks.toml', '--redact', '--no-banner'], resource: null, requires: [],
    owner: 'config/gitleaks.toml', context: 'gitleaks',
    reason: 'Secret scanning of Git history with the pinned scanner.',
  },
};
`;
    const changed = source.replace("['gitleaks', 'git', '.', '--config', 'config/gitleaks.toml', '--redact', '--no-banner']", "['node', '-e', '']");
    expect(changed).not.toBe(source);
    const f = await fixture(true, [], { [path]: source });
    await f.write(catalog, addRegistry(catalog, f.git('show', `${f.base}:${catalog}`) + '\n', 'zz-row-a'));
    const reviewed = f.commit(); const prior = await f.review();
    const main = await f.mainMove(async () => {
      await f.write(catalog, addRegistry(catalog, f.git('show', `${f.base}:${catalog}`) + '\n', 'zz-row-b'));
      await f.write(path, changed);
    });
    expect(() => f.git('merge', '--no-ff', '--no-commit', main)).toThrow();
    expect(f.git('diff', '--name-only', '--diff-filter=U')).toBe(catalog);
    await f.write(catalog, registryUnion(catalog, f.git('show', `${f.base}:${catalog}`) + '\n', f.git('show', `${reviewed}:${catalog}`) + '\n', f.git('show', `${main}:${catalog}`) + '\n'));
    f.commit(); await f.cli('prepare', f.request); const next = await f.state();
    expect(next.candidate.rules.head).not.toBe(prior.candidate.rules.head);
    expect(next.candidate.coverage).toBeUndefined();
    await f.report(); await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
  });
  it('needs one fresh ordinary-delta report for a test repair, preserving initial full coverage', async () => {
    const f = await fixture(); const prior = await f.review();
    await f.write('tests/demo.test.ts', 'test fixture\n'); f.commit(); await f.cli('prepare', f.request);
    const next = await f.state(); expect(next.candidate.coverage.kind).toBe('repair');
    await expect(f.cli('verify')).rejects.toThrow('PASS');
    await f.report({ ordinary: true, delta: next.candidate.coverage.delta }); await expect(f.cli('verify')).resolves.toBe(0);
    expect(coverageState(await f.state()).expires).toBe(coverageState(prior).expires);
  });
  it('a mixed repair with one product path cannot use the one-review route', async () => {
    const f = await fixture(); await f.review(); await f.write('tests/demo.test.ts', 'test\n'); await f.write('app.ts', 'product change\n'); f.commit();
    await f.cli('prepare', f.request); expect((await f.state()).candidate.coverage).toBeUndefined(); await f.report({ ordinary: true });
    await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
  });
  it('does not inherit expired coverage or an open material card', async () => {
    const f = await fixture(); const prior = await f.review();
    await f.report({ verdict: 'FAIL', findings: [{ id: 'F1', summary: 'unclosed mechanism', material: true }] });
    await expect(f.cli('renew')).rejects.toThrow();
    await f.write(RECORD, 'ordinary prose\n'); f.commit(); await f.cli('prepare', f.request);
    expect((await f.state()).candidate.coverage).toBeUndefined();
    expect(verdict(prior, prior.candidate, coverageState(prior).expires).code).toBe('expired');
  });
  it('renews explicitly within the original 72 hours and refuses at the cap', async () => {
    const f = await fixture(); const prior = await f.review(); const origin = coverageState(prior).earliest;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(origin + DAY); await f.cli('renew'); let next = await f.state();
    expect(coverageState(next).expires).toBe(origin + 2 * DAY); expect(next.cycle).toBe(prior.cycle);
    clock.mockReturnValue(origin + 71 * 3600000); await f.cli('renew'); next = await f.state();
    expect(coverageState(next).expires).toBe(origin + 3 * DAY);
    clock.mockReturnValue(origin + 3 * DAY); await expect(f.cli('renew')).rejects.toThrow('72-hour');
  });
  it.each(['tree', 'policy', 'base', 'touch and revert'])('refuses renewal after %s changes', async kind => {
    const f = await fixture(); const prior = await f.review();
    if (kind === 'tree' || kind === 'policy') { await f.write(kind === 'tree' ? 'app.ts' : 'scripts/documentation-extra.ts', 'changed\n'); f.commit(); }
    if (kind === 'base') f.git('update-ref', 'refs/remotes/origin/main', f.head);
    if (kind === 'touch and revert') {
      const main = await f.mainMove(() => f.write('app.ts', 'touch\n'));
      await f.mainMove(() => f.write('app.ts', 'export const before = 1;\n'), main);
    }
    await expect(f.cli('renew')).rejects.toThrow();
    expect(digest((await f.state()).history)).toBe(digest(prior.history));
  });
  it('an enabling topic with an old base stays v2 and cannot renew itself', async () => {
    const f = await fixture(false); await f.write('scripts/agent-review-decide.mjs', 'export const REVIEW_RULES_VERSION = 3;\n'); f.commit();
    const session = await f.review(); expect(session.version).toBe(2); expect(session.candidate.rules).toBeUndefined();
    const candidate = await captureSessionCandidate(f.cwd, undefined, { env: {} }); expect(await captureReviewRules(f.cwd, candidate)).toBeUndefined();
    await expect(f.cli('renew')).rejects.toThrow();
    const reader = await import('./agent-review-queue.mjs');
    const summary = receiptSummary(session, 12, Date.now()); expect(summary).not.toHaveProperty('version');
    expect(reader.parseReceipt(`${ECONOMY_RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``)).toBeNull();
  });
  it('replays a v2 prefix after enabling v3 with two fresh full reviews and preserves absent rules', async () => {
    const f = await fixture(false); const prior = await f.review();
    expect(prior.version).toBe(2); expect(prior.candidate).not.toHaveProperty('rules');
    const main = await f.mainMove(() => f.write('scripts/agent-review-decide.mjs', 'export const REVIEW_RULES_VERSION = 3;\n'));
    f.git('merge', '--no-ff', '-qm', 'integrate enabled rules', main);
    await f.cli('prepare', f.request); const next = await f.state();
    expect(next.version).toBe(3); expect(next.candidate.rules.version).toBe(3);
    expect(next.history.slice(0, prior.history.length)).toEqual(prior.history);
    expect(next.history[prior.history.length]).toMatchObject({ type: 'rules', version: 3 });
    expect(next.cycle).toBe(prior.cycle); expect(next.allowedCycles).toBe(prior.allowedCycles);
    expect(next.candidate.coverage).toBeUndefined();
    await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
    await f.report(); await expect(f.cli('verify')).rejects.toThrow('2 independent PASS');
    await f.report(); await expect(f.cli('verify')).resolves.toBe(0);
    await expect(f.cli('receipt', '12')).resolves.toBe(0);
    const reviewed = await f.state();
    await expect(validateEconomySession(f.cwd, reviewed)).resolves.toBeUndefined();
    expect(verdict(reviewed, reviewed.candidate, Date.now()).ok).toBe(true);
    const summary = receiptSummary(reviewed, 12, Date.now());
    expect(parseReceipt(`${ECONOMY_RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``)).toEqual(summary);
    const fabricatedLegacyRules = structuredClone(reviewed);
    fabricatedLegacyRules.history.find(event => event.type === 'prepare').candidate.rules = reviewed.candidate.rules;
    await expect(validateEconomySession(f.cwd, fabricatedLegacyRules)).rejects.toThrow('recorded policy or base rules differ');
    const missingEnabledRules = structuredClone(reviewed);
    delete missingEnabledRules.history.findLast(event => event.type === 'prepare').candidate.rules;
    await expect(validateEconomySession(f.cwd, missingEnabledRules)).rejects.toThrow('recorded policy or base rules differ');
  });
  it('binds v3 summaries to complete history and the actual head', async () => {
    const f = await fixture(); const session = await f.review(); const summary = receiptSummary(session, 12, Date.now());
    const body = `${ECONOMY_RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``;
    expect(parseReceipt(body)).toEqual(summary); expect(summary.sessionDigest).toBe(digest(session));
    expect(await captureRenewalProof(f.cwd, session)).toMatchObject({ main: f.base, untouched: true });
  });
});

describe('coverage preconditions in real histories', () => {
  it.each(['incomplete', 'expired'])('does not inherit %s first coverage across a main merge', async reason => {
    const f = await fixture(); await f.cli('prepare', f.request); await f.report();
    if (reason === 'expired') await f.report(); const original = await f.state();
    const main = await f.mainMove(() => f.write('other.ts', 'main\n')); f.git('merge', '--no-ff', '-qm', 'integrate', main);
    if (reason === 'expired') vi.spyOn(Date, 'now').mockReturnValue(coverageState(original).expires);
    await f.cli('prepare', f.request); expect((await f.state()).candidate.coverage).toBeUndefined();
    await expect(f.cli('verify')).rejects.toThrow('PASS');
  });
  it('a control test filename does not make a protected catalog proof an ordinary repair', async () => {
    const f = await fixture(); await f.review(); await f.write('tests/postgres/nativeStoreForwardCatalog.test.ts', 'changed proof\n'); f.commit();
    await f.cli('prepare', f.request); expect((await f.state()).candidate.coverage).toBeUndefined();
  });
  it('renewal permits disjoint main motion and refuses main policy motion', async () => {
    const f = await fixture(); const session = await f.review(); const main = await f.mainMove(() => f.write('other.ts', 'main\n'));
    expect(await captureRenewalProof(f.cwd, session)).toMatchObject({ main, untouched: true });
    await f.mainMove(() => f.write('scripts/documentation-extra.ts', 'policy\n'), main);
    await expect(f.cli('renew')).rejects.toThrow('main touched');
  });
  it('rejects incomplete or altered receipt histories rather than trust inherited reviewer arrays', async () => {
    const f = await fixture(); const session = await f.review();
    const root = structuredClone(session); root.history.find(event => event.type === 'report').report.tree = 'a'.repeat(40);
    expect(verdict(root, root.candidate, Date.now()).ok).toBe(false);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(coverageState(session).earliest + DAY); await f.cli('renew');
    const renewed = await f.state(); renewed.history.at(-1).expires += 1;
    expect(verdict(renewed, renewed.candidate, clock()).ok).toBe(false);
  });
});

describe('ordinary repair ownership', () => {
  it('refuses a fixture imported by product code even when its filename is eligible', async () => {
    const f = await fixture(); await f.write('tests/fixtures/demo.ts', 'export const value = 1;\n');
    await f.write('src/demo.ts', "import { value } from '../tests/fixtures/demo.js'; export { value };\n"); f.commit(); await f.review();
    await f.write('tests/fixtures/demo.ts', 'export const value = 2;\n'); f.commit(); await f.cli('prepare', f.request);
    expect((await f.state()).candidate.coverage).toBeUndefined();
  });
  it('main touch-and-revert before an inherited integration still blocks renewal', async () => {
    const f = await fixture(); await f.review(); const first = await f.mainMove(() => f.write('app.ts', 'transient\n'));
    const main = await f.mainMove(() => f.write('app.ts', 'export const before = 1;\n'), first);
    f.git('merge', '--no-ff', '-qm', 'integrate reverted main', main); await f.cli('prepare', f.request);
    expect((await f.state()).candidate.coverage.kind).toBe('integration');
    await expect(f.cli('renew')).rejects.toThrow('main touched');
  });
});

describe('fixture dependency evidence', () => {
  it.each([false, true])('traces test-only fixture parents (product consumer: %s)', async product => {
    const f = await fixture(); await f.write('tests/fixtures/value.ts', 'export const value = 1;\n');
    await f.write('tests/helpers/parent.ts', "export { value } from '../fixtures/value.js';\n");
    await f.write(product ? 'src/consumer.ts' : 'tests/consumer.test.ts', "import { value } from '../tests/helpers/parent.js';\n"); f.commit(); await f.review();
    await f.write('tests/fixtures/value.ts', 'export const value = 2;\n'); f.commit(); await f.cli('prepare', f.request);
    expect((await f.state()).candidate.coverage?.kind).toBe(product ? undefined : 'repair');
  });
});


describe('v3 source admission from real Git objects', () => {
  it('admits inherited integration coverage through the full queue reader', async () => {
    const f = await fixture(); await f.review(); const main = await f.mainMove(() => f.write('other.ts', 'main\n'));
    f.git('merge', '--no-ff', '-qm', 'integrate', main); await f.cli('prepare', f.request); const session = await f.state();
    const summary = receiptSummary(session, 12, Date.now());
    const body = `${ECONOMY_RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``;
    const pr = { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: session.candidate.head } };
    const api = { get: async (path: string) => path.includes('/pulls/') ? pr : path.includes('/issues/')
      ? [{ id: 1, body, user: { login: 'supervisor', type: 'User' } }]
      : path.includes('/collaborators/') ? { permission: 'write' } : { object: { sha: main } } };
    const runGit = async (cwd: string, ...args: string[]) => args.includes('fetch') ? '' : sourceGit(cwd, ...args);
    await expect(waitNativeAdmission({ cwd: f.cwd, api, runGit,
      event: { number: 12, repository: { private: false }, pull_request: { head: pr.head } },
      env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' },
    })).resolves.toEqual(summary);
  });
});
