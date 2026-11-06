import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareCandidate, receiptSummary, recordReport, RECEIPT_MARKER } from './agent-review-decide.mjs';
import { assertMergePreflight, captureSessionCandidate, git as reviewGit, sessionMain, verifyCandidateCommand } from './agent-review-session.mjs';
import { carryOverSourceReview, parseReceipt, waitNativeAdmission } from './agent-review-queue.mjs';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cwd of directories.splice(0)) await rm(cwd, { recursive: true, force: true }); });
const intent = { risk: 'routine', criteria: 'Preserve the reviewed source' };
const trailerMessage = 'docs: explain unchanged guidance\n\nOpenLup-Doc-Impact: {"unit":"tooling","digest":"sha256-' + 'a'.repeat(64) + '","reason":"The current guidance still applies."}\nSigned-off-by: Fixture <fixture@example.invalid>';
async function fixture(prefix = 'native-review-v2-') {
  const cwd = await mkdtemp(join(tmpdir(), prefix)); directories.push(cwd);
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' }).trim();
  const commit = () => { git('add', 'source.txt'); git('commit', '-qm', 'fixture'); };
  git('init', '-q', '-b', 'main'); await writeFile(join(cwd, 'source.txt'), 'before\n'); commit();
  const base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(cwd, 'source.txt'), 'reviewed\n'); commit(); const head = git('rev-parse', 'HEAD');
  const scratch = join(cwd, '.context', 'scratch'); await mkdir(scratch, { recursive: true });
  const statePath = join(scratch, 'agent-review', 'session.json');
  const env = { CODEX_THREAD_ID: 'author' };
  const cli = (...args: string[]) => sessionMain(args, { cwd, env });
  async function review() {
    const request = join(scratch, 'intent.json'); await writeFile(request, JSON.stringify({ intent })); await cli('prepare', request);
    const session = JSON.parse(await readFile(statePath, 'utf8'));
    const path = join(scratch, 'report.json');
    await writeFile(path, JSON.stringify({ reviewer: 'cold-reviewer', cold: true, verdict: 'PASS', tree: session.candidate.tree, findings: [], closes: [], documentation: 'Fixture assessment: reviewed canonical guidance and secondary examples; no impact.' }));
    await cli('record', path); return JSON.parse(await readFile(statePath, 'utf8'));
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return { cwd, git, base, head, commit, scratch, statePath, cli, review };
}

describe('six real Git witnesses', () => {
  it('keeps broker lane keywords independent of worktree names and keys scoped to each worktree', async () => {
    const f = await fixture('coverage-pgtap-build-e2e-'); const session = await f.review();
    const broker = join(f.scratch, 'ai-resource-gate'); await writeFile(broker, 'stub'); await chmod(broker, 0o700);
    const run = vi.fn(async (command: string, args: string[]) => { expect(command).toBe(broker); expect(args[0]).toBe('run'); return 0; }); const keys: string[] = [];
    for (const resource of ['openlup:build', 'openlup:typecheck', 'openlup:coverage', 'openlup:pgtap', 'openlup:build']) {
      await verifyCandidateCommand({ cwd: f.cwd, session, command: 'stub', resource, env: { PATH: f.scratch }, run,
        snapshot: (cwd, base) => captureSessionCandidate(cwd, base, { env: {} }) });
      const key = run.mock.calls.at(-1)![1][2];
      expect(key.startsWith(`${resource}:wt`)).toBe(true);
      expect(key.slice(resource.length)).toMatch(/^:wt[0-9]+$/u); keys.push(key);
    }
    expect(keys[0]).toBe(keys[4]);
    const other = await fixture('coverage-pgtap-build-e2e-'); const otherSession = await other.review();
    await verifyCandidateCommand({ cwd: other.cwd, session: otherSession, command: 'stub', resource: 'openlup:build',
      env: { PATH: f.scratch }, run, snapshot: (cwd, base) => captureSessionCandidate(cwd, base, { env: {} }) });
    expect(run.mock.calls.at(-1)![1][2]).not.toBe(keys[0]);
  });
  it('uses system Git and a fixed search path despite an injected git executable', async () => {
    const f = await fixture();
    const fakeGit = join(f.scratch, 'git'); await writeFile(fakeGit, '#!/bin/sh\necho substituted-git\n'); await chmod(fakeGit, 0o700);
    vi.stubEnv('PATH', f.scratch);
    expect(await reviewGit(f.cwd, '--version')).toMatch(/^git version /);
    const searchPath = await reviewGit(f.cwd, '-c', 'alias.review-path=!printf "%s" "$PATH"', 'review-path');
    expect(searchPath.endsWith('/usr/bin:/bin')).toBe(true);
    expect(searchPath).not.toContain(f.scratch);
  });
  it.each(['older landed ancestor', 'unlanded predecessor', 'landed predecessor'])('hosted base validation: %s', async scenario => {
    const f = await fixture();
    await writeFile(join(f.cwd, 'source.txt'), 'upper change\n'); f.commit();
    const candidate = await captureSessionCandidate(f.cwd, undefined, { env: { OPENLUP_STACK_BASE: f.head } });
    const base = scenario === 'older landed ancestor' ? f.base : candidate.base;
    const main = scenario === 'unlanded predecessor' ? f.base : f.head;
    let clock = 1000;
    let session = prepareCandidate(null, { ...candidate, base, intent, authorSessionId: 'author' }, clock);
    session = recordReport(session, { reviewer: 'reviewer', cold: true, tree: candidate.tree, verdict: 'PASS', findings: [], closes: [], documentation: 'Fixture assessment: reviewed canonical guidance and secondary examples; no impact.' }, clock);
    const receipt = receiptSummary(session, 12, clock);
    const pr = { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: candidate.head } };
    const api = { get: vi.fn(async path => path.includes('/pulls/') ? pr : path.includes('/issues/') ? [{ id: 1, user: { login: 'review-owner', type: 'User' }, author_association: 'CONTRIBUTOR', body: `${RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\`` }] : path.includes('/collaborators/') ? { permission: 'admin' } : { object: { sha: main } }) };
    const runGit = vi.fn(async (cwd, ...args) => args.includes('fetch') ? '' : reviewGit(cwd, ...args));
    const wait = waitNativeAdmission({ cwd: f.cwd, event: { number: 12, repository: { private: false }, pull_request: { head: { sha: candidate.head } } }, env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' }, api, runGit, now: () => clock, sleep: async ms => { clock += ms; }, deadlineMs: 1 });
    if (scenario === 'landed predecessor') await expect(wait).resolves.toEqual(receipt);
    else await expect(wait).rejects.toThrow('review base must be the exact fork point on main');
  });
  it('prepare / record / verify and receipt PASS, with scratch ignored', async () => {
    const f = await fixture(); const session = await f.review();
    await expect(f.cli('verify')).resolves.toBe(0);
    await expect(f.cli('receipt', '12')).resolves.toBe(0);
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining(RECEIPT_MARKER));
    expect(session.version).toBe(2);
  });
  it('refuses a commit after review', async () => {
    const f = await fixture(); await f.review();
    await writeFile(join(f.cwd, 'source.txt'), 'unreviewed\n'); f.commit();
    await expect(f.cli('verify')).rejects.toThrow('candidate changed');
  });
  it('still passes when origin/main moves beyond the fork point', async () => {
    const f = await fixture(); await f.review();
    const tree = f.git('rev-parse', `${f.base}^{tree}`);
    const main = f.git('commit-tree', tree, '-p', f.base, '-m', 'unrelated main move');
    f.git('update-ref', 'refs/remotes/origin/main', main);
    await expect(f.cli('verify')).resolves.toBe(0);
  });
  it.each([false, true])('merge group carries over a clean base move, overlapping path = %s', async overlap => {
    const f = await fixture(); const candidate = await captureSessionCandidate(f.cwd, undefined, { env: {} });
    f.git('checkout', '-q', '--detach', f.base);
    if (overlap) f.git('update-index', '--chmod=+x', 'source.txt');
    else { await writeFile(join(f.cwd, 'other.txt'), 'disjoint\n'); f.git('add', 'other.txt'); }
    f.git('commit', '-qm', 'base move'); const base = f.git('rev-parse', 'HEAD');
    const tree = f.git('merge-tree', '--write-tree', base, f.head);
    const head = f.git('commit-tree', tree, '-p', base, '-p', f.head, '-m', 'queue group');
    const decision = await carryOverSourceReview(f.cwd, candidate, { base, head, tree });
    // Review binds to the candidate's own change: a clean merge keeps it even on a shared path.
    expect(decision).toMatchObject({ ok: true, reason: 'clean merge of the reviewed change' });
    if (!overlap) {
      await mkdir(join(f.scratch, 'agent-review'));
      await writeFile(join(f.scratch, 'intent.json'), JSON.stringify({ intent }));
      await writeFile(f.statePath, JSON.stringify({ version: 1 }));
      await expect(f.cli('verify')).rejects.toThrow('prepare a version-2 session before review');
      await expect(f.cli('prepare', '--new', join(f.scratch, 'intent.json'))).rejects.toThrow('session version must be 2; a version-1 session');
      await rm(f.statePath);
      await f.cli('prepare', '--new', join(f.scratch, 'intent.json'));
      const initial = JSON.parse(await readFile(f.statePath, 'utf8'));
      await f.cli('prepare', '--new', join(f.scratch, 'intent.json'));
      const next = JSON.parse(await readFile(f.statePath, 'utf8'));
      expect(next.history.slice(0, -1)).toEqual(initial.history);

      expect(next).not.toHaveProperty('previousSessionDigest');
      expect((await readdir(join(f.scratch, 'agent-review'))).some(name => /^session-.*\.json$/.test(name))).toBe(false);
    }
  });
  it.each(['text conflict', 'clean overlap', 'admission machinery', 'disjoint'])('preflight refuses only a known conflict before review or costly verification: %s', async scenario => {
    const f = await fixture(); const session = await f.review();
    f.git('checkout', '-q', '--detach', f.base);
    if (scenario === 'text conflict') await writeFile(join(f.cwd, 'source.txt'), 'main conflicts\n');
    else if (scenario === 'clean overlap') await chmod(join(f.cwd, 'source.txt'), 0o755);
    else {
      const path = scenario === 'admission machinery' ? 'scripts/agent-review-admission.mjs' : 'other.txt';
      await mkdir(join(f.cwd, 'scripts'), { recursive: true });
      await writeFile(join(f.cwd, path), 'main addition\n'); f.git('add', path);
    }
    f.git('add', 'source.txt');
    f.git('commit', '-qm', 'main move');
    f.git('update-ref', 'refs/remotes/origin/main', f.git('rev-parse', 'HEAD'));
    f.git('checkout', '-q', '--detach', f.head);
    const run = vi.fn(async () => 0);
    const prepared = await readFile(f.statePath, 'utf8');
    const request = join(f.scratch, 'intent.json');
    if (scenario !== 'text conflict') {
      await expect(f.cli('prepare', request)).resolves.toBe(0);
      await expect(verifyCandidateCommand({ cwd: f.cwd, session, command: 'costly-check', run, env: {} })).resolves.toBe(0);
      await expect(f.cli('receipt', '12')).resolves.toBe(0);
      expect(run).toHaveBeenCalledTimes(1);
    } else {
      await expect(f.cli('prepare', request)).rejects.toThrow('merge_preflight');
      expect(await readFile(f.statePath, 'utf8')).toBe(prepared);
      await expect(verifyCandidateCommand({ cwd: f.cwd, session, command: 'costly-check', run, env: {} })).rejects.toThrow('merge_preflight');
      await expect(f.cli('receipt', '12')).rejects.toThrow('merge_preflight');
      expect(run).not.toHaveBeenCalled();
    }
  });
  it.each(['mechanical', 'extra merge edits', 'manual resolution', 'later repair', 'trailer-only', 'trailer after extra merge edits'])('preserves integration coverage and charges actual repairs: %s', async scenario => {
    const f = await fixture(); const prior = await f.review();
    f.git('checkout', '-q', '--detach', f.base);
    await mkdir(join(f.cwd, 'scripts'), { recursive: true });
    await writeFile(join(f.cwd, 'scripts/agent-review-extra.mjs'), 'main admission change\n');
    if (scenario === 'manual resolution') await writeFile(join(f.cwd, 'source.txt'), 'main conflicts\n');
    f.git('add', 'scripts/agent-review-extra.mjs', 'source.txt'); f.git('commit', '-qm', 'main machinery change');
    const main = f.git('rev-parse', 'HEAD'); f.git('update-ref', 'refs/remotes/origin/main', main);
    f.git('checkout', '-q', '--detach', f.head);
    const merge = () => f.git('merge', '--no-ff', '--no-commit', main);
    if (scenario === 'manual resolution') expect(merge).toThrow();
    else merge();
    if (['extra merge edits', 'manual resolution', 'trailer after extra merge edits'].includes(scenario)) await writeFile(join(f.cwd, 'source.txt'), 'new implementation\n');
    f.git('add', 'source.txt'); f.git('commit', '-qm', 'integrate main');
    const mergeHead = f.git('rev-parse', 'HEAD');
    if (scenario.startsWith('trailer')) f.git('commit', '--allow-empty', '-qm', trailerMessage);
    if (scenario === 'later repair') { await writeFile(join(f.cwd, 'source.txt'), 'later implementation\n'); f.commit(); }
    await f.cli('prepare', join(f.scratch, 'intent.json'));
    const next = JSON.parse(await readFile(f.statePath, 'utf8'));
    const mechanical = ['mechanical', 'trailer-only'].includes(scenario);

    expect(next.candidate.base).toBe(main);
    expect(next.candidate.head).toBe(f.git('rev-parse', 'HEAD'));
    expect(next.history.slice(0, -1)).toEqual(prior.history);
    if (scenario === 'later repair') expect(next.candidate).not.toHaveProperty('integration');
    else {
      expect(next.candidate.integration).toEqual({ base: f.base, head: f.head, tree: prior.candidate.tree, expires: prior.history.at(-1).at + 86400000, mechanical });
      await f.cli('prepare', join(f.scratch, 'intent.json'));
      expect(JSON.parse(await readFile(f.statePath, 'utf8'))).toEqual(next);
      const path = join(f.scratch, 'integration-report.json');
      await writeFile(path, JSON.stringify({ reviewer: 'fresh-integration-1', cold: true, verdict: 'PASS', tree: next.candidate.tree, findings: [], closes: [], documentation: 'Fixture assessment: reviewed canonical guidance and secondary examples; no impact.' }));
      await f.cli('record', path);
      await expect(f.cli('verify')).rejects.toThrow('2 independent PASS reports required');
      await writeFile(path, JSON.stringify({ reviewer: 'fresh-integration-2', cold: true, verdict: 'PASS', tree: next.candidate.tree, findings: [], closes: [], documentation: 'Fixture assessment: reviewed canonical guidance and secondary examples; no impact.' }));
      await f.cli('record', path);
      await expect(f.cli('verify')).resolves.toBe(0);
      if (scenario === 'trailer-only') {
        expect(next.candidate.head).not.toBe(mergeHead);
        expect(next.candidate.tree).toBe(f.git('rev-parse', `${mergeHead}^{tree}`));
        const reviewed = JSON.parse(await readFile(f.statePath, 'utf8'));
        const run = vi.fn(async () => 0);
        await expect(verifyCandidateCommand({ cwd: f.cwd, session: reviewed, command: 'focused-check', run, env: {} })).resolves.toBe(0);
        expect(run).toHaveBeenCalledOnce();
        await f.cli('receipt', '12');
        const body = vi.mocked(console.log).mock.calls.at(-1)![0];
        const receipt = parseReceipt(body);
        expect(receipt).toMatchObject({ head: next.candidate.head, tree: next.candidate.tree, risk: 'behavior', expires: next.candidate.integration.expires });
        const pr = { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: next.candidate.head } };
        const api = { get: vi.fn(async path => path.includes('/pulls/') ? pr : path.includes('/issues/') ? [{ id: 1, user: { login: 'review-owner', type: 'User' }, body }] : path.includes('/collaborators/') ? { permission: 'write' } : { object: { sha: main } }) };
        const runGit = vi.fn(async (cwd, ...args) => args.includes('fetch') ? '' : reviewGit(cwd, ...args));
        const groupHead = f.git('commit-tree', next.candidate.tree, '-p', main, '-p', next.candidate.head, '-m', 'queue group');
        for (const group of [false, true]) {
          const event = group ? { repository: { private: false }, action: 'checks_requested', merge_group: { head_ref: 'refs/heads/gh-readonly-queue/main/pr-12-abcdef', base_ref: 'refs/heads/main', head_sha: groupHead, base_sha: main } }
            : { repository: { private: false }, number: 12, pull_request: { head: pr.head } };
          await expect(waitNativeAdmission({ cwd: f.cwd, event, env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: group ? 'merge_group' : 'pull_request' }, api, runGit })).resolves.toEqual(receipt);
        }
        // Equal trees never let the reviewed merge stand in for the actual tip.
        f.git('checkout', '-q', '--detach', mergeHead);
        await expect(f.cli('verify')).rejects.toThrow('candidate changed');
        await expect(f.cli('receipt', '12')).rejects.toThrow('candidate changed');
        await expect(waitNativeAdmission({ cwd: f.cwd, event: { repository: { private: false }, number: 12, pull_request: { head: pr.head } }, env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' }, api: { get: async path => path.includes('/pulls/') ? { ...pr, head: { sha: mergeHead } } : api.get(path) }, runGit })).rejects.toThrow('PR head changed');
      }
    }
  });
  it.each(['non-empty tip', 'two tips', 'other trailer', 'body text', 'NUL-hidden body', 'missing doc trailer', 'non-merge parent', 'reversed merge parents', 'wrong reviewed parent', 'wrong main parent', 'merge-on-top', 'changed intent', 'changed author'])('refuses trailer integration with %s', async scenario => {
    const f = await fixture(); const prior = await f.review();
    f.git('checkout', '-q', '--detach', f.base);
    await writeFile(join(f.cwd, 'main.txt'), 'main addition\n');
    f.git('add', 'main.txt'); f.git('commit', '-qm', 'main move');
    const main = f.git('rev-parse', 'HEAD'); f.git('update-ref', 'refs/remotes/origin/main', main);
    const tree = f.git('merge-tree', '--write-tree', f.head, main);
    const alternate = f.git('commit-tree', prior.candidate.tree, '-p', f.head, '-m', 'extra predecessor');
    const alternateMain = f.git('commit-tree', tree, '-p', main, '-m', 'extra main descendant');
    const parents = scenario === 'non-merge parent' ? [f.head]
      : scenario === 'reversed merge parents' ? [main, f.head]
        : scenario === 'wrong reviewed parent' ? [alternate, main]
          : scenario === 'wrong main parent' ? [f.head, alternateMain] : [f.head, main];
    const merge = f.git('commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', 'integrate main');
    f.git('checkout', '-q', '--detach', merge);
    let message = trailerMessage;
    if (scenario === 'other trailer') message += '\nReviewed-by: Someone';
    if (scenario === 'body text') message = message.replace('\n\n', '\n\nUnreviewed explanation\n\n');
    if (scenario === 'missing doc trailer') message = 'empty repair\n\nSigned-off-by: Fixture <fixture@example.invalid>';
    if (scenario === 'non-empty tip') await writeFile(join(f.cwd, 'source.txt'), 'changed tree\n');
    if (scenario === 'merge-on-top') {
      const head = f.git('commit-tree', tree, '-p', merge, '-p', alternate, '-m', message);
      f.git('checkout', '-q', '--detach', head);
    } else {
      f.git('add', 'source.txt'); f.git('commit', '--allow-empty', '-qm', message);
      if (scenario === 'two tips') f.git('commit', '--allow-empty', '-qm', message);
      if (scenario === 'NUL-hidden body') {
        // A literal Git object preserves bytes that pretty-printed %B can truncate.
        const raw = f.git('cat-file', 'commit', 'HEAD');
        const head = execFileSync('git', ['-C', f.cwd, 'hash-object', '--literally', '-t', 'commit', '-w', '--stdin'], { input: `${raw}\0\nUnreviewed hidden body\n`, encoding: 'utf8' }).trim();
        f.git('checkout', '-q', '--detach', head);
        expect(f.git('cat-file', 'commit', head)).toContain('\0\nUnreviewed hidden body');
      }
    }
    const request = join(f.scratch, 'intent.json');
    if (scenario === 'changed intent' || scenario === 'changed author') {
      await writeFile(request, JSON.stringify({ authorSessionId: scenario === 'changed author' ? 'different-author' : 'author', intent: scenario === 'changed intent' ? { ...intent, criteria: 'Different task' } : intent }));
      await expect(f.cli('prepare', request)).rejects.toThrow('author or intent changed');
      expect(JSON.parse(await readFile(f.statePath, 'utf8'))).toEqual(prior);
    } else {
      await f.cli('prepare', request);
      const next = JSON.parse(await readFile(f.statePath, 'utf8'));
      expect(next.candidate).not.toHaveProperty('integration');
      await expect(f.cli('verify')).rejects.toThrow('independent PASS');
    }
  });
  // Headers are outside the message allowlist; the synthetic signature is not verified here.
  // EOF whitespace is trimmed, while an interior CR is outside the LF trailer-line grammar.
  it.each([
    ['gpgsig header', 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n synthetic-signature\n -----END PGP SIGNATURE-----', trailerMessage, 'utf8', true],
    ['non-UTF-8 encoding header', 'encoding ISO-8859-1', trailerMessage.replace('current guidance', 'current café guidance'), 'latin1', true],
    ['extra header', 'x-extra fixture', trailerMessage, 'utf8', true],
    ['header continuation lines', 'x-extra first\n continued value\n \n last value', trailerMessage, 'utf8', true],
    ['trailer trailing whitespace', '', trailerMessage.replace('\nSigned-off-by:', ' \t\nSigned-off-by:'), 'utf8', true],
    ['interior CRLF trailer line', '', trailerMessage.replace('\nSigned-off-by:', '\r\nSigned-off-by:'), 'utf8', false],
    ['CRLF message lines', '', trailerMessage.replaceAll('\n', '\r\n'), 'utf8', false],
    ['final sign-off CRLF', '', `${trailerMessage}\r\n`, 'utf8', true],
  ] as const)('classifies a raw trailer tip with %s', async (_name, extraHeaders, message, encoding, accepted) => {
    const f = await fixture(); const prior = await f.review();
    f.git('checkout', '-q', '--detach', f.base);
    await writeFile(join(f.cwd, 'main.txt'), 'main addition\n');
    f.git('add', 'main.txt'); f.git('commit', '-qm', 'main move');
    const main = f.git('rev-parse', 'HEAD'); f.git('update-ref', 'refs/remotes/origin/main', main);
    const tree = f.git('merge-tree', '--write-tree', f.head, main);
    const merge = f.git('commit-tree', tree, '-p', f.head, '-p', main, '-m', 'integrate main');
    const headers = [`tree ${tree}`, `parent ${merge}`, 'author Fixture <fixture@example.invalid> 1000000000 +0000', 'committer Fixture <fixture@example.invalid> 1000000000 +0000', extraHeaders].filter(Boolean).join('\n');
    const raw = Buffer.concat([Buffer.from(`${headers}\n\n`), Buffer.from(`${message}\n`, encoding)]);
    const head = execFileSync('git', ['-C', f.cwd, 'hash-object', '--literally', '-t', 'commit', '-w', '--stdin'], { input: raw, encoding: 'utf8' }).trim();
    f.git('checkout', '-q', '--detach', head);
    await f.cli('prepare', join(f.scratch, 'intent.json'));
    const next = JSON.parse(await readFile(f.statePath, 'utf8'));
    expect(next.candidate.head).toBe(head);
    expect(next.candidate.tree).toBe(tree);
    expect(next.history.slice(0, -1)).toEqual(prior.history);
    expect(Boolean(next.candidate.integration)).toBe(accepted);
    if (accepted) expect(next.candidate.integration).toMatchObject({ head: f.head, mechanical: true, expires: prior.history.at(-1).at + 86400000 });
    await expect(f.cli('verify')).rejects.toThrow('independent PASS');
  });
  it('requires full local review for an exact merge of an unlanded stacked predecessor', async () => {
    const f = await fixture(); await f.review();
    f.git('checkout', '-q', '--detach', f.base);
    await writeFile(join(f.cwd, 'predecessor.txt'), 'unlanded predecessor\n');
    f.git('add', 'predecessor.txt'); f.git('commit', '-qm', 'predecessor');
    const predecessor = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-q', '--detach', f.head); f.git('merge', '--no-ff', '-qm', 'integrate predecessor', predecessor);
    const env = { CODEX_THREAD_ID: 'author', OPENLUP_STACK_BASE: predecessor };
    await sessionMain(['prepare', join(f.scratch, 'intent.json')], { cwd: f.cwd, env });
    const session = JSON.parse(await readFile(f.statePath, 'utf8'));
    expect(session.candidate.base).toBe(predecessor);
    expect(session.candidate).not.toHaveProperty('integration');
    await expect(sessionMain(['verify'], { cwd: f.cwd, env })).rejects.toThrow('independent PASS');
    const path = join(f.scratch, 'full-stack-report.json');
    await writeFile(path, JSON.stringify({ reviewer: 'full-stack-reviewer', cold: true, verdict: 'PASS', tree: session.candidate.tree, findings: [], closes: [], documentation: 'Fixture assessment: reviewed canonical guidance and secondary examples; no impact.' }));
    await sessionMain(['record', path], { cwd: f.cwd, env });
    await expect(sessionMain(['verify'], { cwd: f.cwd, env })).resolves.toBe(0);
  });
  it('keeps local stack review available before its pinned predecessor lands', async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, 'source.txt'), 'upper change\n'); f.commit();
    const head = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-q', '--detach', f.base);
    await writeFile(join(f.cwd, 'source.txt'), 'conflicting main\n'); f.commit();
    f.git('update-ref', 'refs/remotes/origin/main', f.git('rev-parse', 'HEAD'));
    f.git('checkout', '-q', '--detach', head);
    const env = { OPENLUP_STACK_BASE: f.head };
    const candidate = await captureSessionCandidate(f.cwd, undefined, { env });
    await expect(assertMergePreflight(f.cwd, candidate, { env })).resolves.toBeUndefined();
    await expect(assertMergePreflight(f.cwd, candidate, { env: {} })).rejects.toThrow('merge_preflight');
    const request = join(f.scratch, 'stack-intent.json');
    await writeFile(request, JSON.stringify({ authorSessionId: 'author', intent }));
    await expect(sessionMain(['prepare', request], { cwd: f.cwd, env })).resolves.toBe(0);
    let session = JSON.parse(await readFile(f.statePath, 'utf8'));
    session = recordReport(session, { reviewer: 'stack-reviewer', cold: true, verdict: 'PASS', tree: session.candidate.tree, findings: [], closes: [], documentation: 'Fixture assessment: reviewed canonical guidance and secondary examples; no impact.' }, Date.now());
    const run = vi.fn(async () => 0);
    await expect(verifyCandidateCommand({ cwd: f.cwd, session, env, command: 'stack-check', run })).resolves.toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('carries over a clean merge of export additions to the same package manifest with real Git', async () => {
    const f = await fixture(); const path = 'packages/p/package.json';
    await mkdir(join(f.cwd, 'packages/p'), { recursive: true });
    const manifest = { name: '@openlup/p', exports: { '.': './index.js', './middle': './middle.js', './last': './last.js' } };
    const writeManifest = value => writeFile(join(f.cwd, path), `${JSON.stringify(value, null, 2)}\n`);
    await writeManifest(manifest); f.git('add', path); f.git('commit', '-qm', 'base manifest');
    const base = f.git('rev-parse', 'HEAD');
    await writeManifest({ ...manifest, exports: { ...manifest.exports, './b': './b.js' } });
    f.git('add', path); f.git('commit', '-qm', 'PR export addition');
    const head = f.git('rev-parse', 'HEAD'); const tree = f.git('rev-parse', 'HEAD^{tree}');
    f.git('checkout', '-q', '--detach', base);
    await writeManifest({ ...manifest, exports: { './a': './a.js', ...manifest.exports } });
    f.git('add', path); f.git('commit', '-qm', 'main export addition');
    const queueBase = f.git('rev-parse', 'HEAD');
    const groupTree = f.git('merge-tree', '--write-tree', queueBase, head);
    const decision = await carryOverSourceReview(f.cwd, { base, head, tree, changedPaths: [path] }, { base: queueBase, tree: groupTree });
    expect(decision).toEqual({ ok: true, code: 'reviewed', reason: 'clean merge of the reviewed change' });
  });
  it('hosted wait admits in one fake API poll and verify-command runs only its stub command', async () => {
    const f = await fixture(); const candidate = await captureSessionCandidate(f.cwd, undefined, { env: {} });
    const now = Date.now(); let session = prepareCandidate(null, { ...candidate, intent, authorSessionId: 'author' }, now);
    session = recordReport(session, { reviewer: 'reviewer', cold: true, tree: candidate.tree, verdict: 'PASS', findings: [], closes: [], documentation: 'Fixture assessment: reviewed canonical guidance and secondary examples; no impact.' }, now);
    const receipt = receiptSummary(session, 12, now);
    const pr = { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: f.head } };
    const api = { get: vi.fn(async path => path.includes('/pulls/') ? pr : path.includes('/collaborators/') ? { permission: 'admin' } : path.includes('/issues/') ? [{ id: 1, user: { login: 'review-owner', type: 'User' }, author_association: 'CONTRIBUTOR', body: `${RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\`` }] : { object: { sha: f.base } }) };
    const runGit = vi.fn(async (cwd, ...args) => {
      if (args.includes('fetch')) { expect(args).toEqual(['-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', f.base, f.head]); return ''; }
      return reviewGit(cwd, ...args);
    });
    const sleep = vi.fn();
    await waitNativeAdmission({ cwd: f.cwd, event: { number: 12, repository: { private: false }, pull_request: { head: { sha: f.head } } }, env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' }, api, runGit, sleep });
    expect(sleep).not.toHaveBeenCalled(); expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('reviewed PR head'));
    const run = vi.fn(async () => 0);
    const snapshot = (cwd, base) => captureSessionCandidate(cwd, base, { env: {} });
    await expect(verifyCandidateCommand({ cwd: f.cwd, session, command: 'stub-check', args: ['arg'], env: {}, run, snapshot })).resolves.toBe(0);
    expect(run).toHaveBeenCalledWith('stub-check', ['arg'], f.cwd, expect.objectContaining({ OPENLUP_HEAVY_ACTIVE: f.cwd }));
    await expect(verifyCandidateCommand({ cwd: f.cwd, session, command: 'stub', env: { AI_RESOURCE_GATE_ACTIVE: '1' }, run })).rejects.toThrow('nested');
    const frozen = async () => candidate;
    const broker = join(f.scratch, 'ai-resource-gate'); await writeFile(broker, 'stub'); await chmod(broker, 0o700);
    await expect(verifyCandidateCommand({ cwd: f.cwd, session, command: 'stub', resource: 'openlup:coverage', env: { PATH: f.scratch }, run, snapshot: frozen })).resolves.toBe(0);
    expect(run).toHaveBeenLastCalledWith(broker, ['run', '--wait', expect.stringMatching(/^openlup:coverage:wt[0-9]+$/u), '--', 'stub'], f.cwd, expect.any(Object));
    const untouched = vi.fn();
    await expect(verifyCandidateCommand({ cwd: f.cwd, session, command: 'stub', env: {}, run: untouched, snapshot: async () => ({ ...candidate, clean: false }) })).rejects.toThrow('dirty');
    expect(untouched).not.toHaveBeenCalled();
    let samples = 0;
    await expect(verifyCandidateCommand({ cwd: f.cwd, session, command: 'stub', env: {}, run, snapshot: async () => ++samples === 1 ? candidate : { ...candidate, tree: 'e'.repeat(40) } })).rejects.toThrow('stale');
    const pin = 'e'.repeat(40);
    const pinGit = vi.fn(async (_cwd, ...args) => args[0] === 'merge-base' && args[1] === '--all' ? f.base : args[0] === 'rev-parse' ? (args.at(-1).includes('tree') ? candidate.tree : f.head) : '');
    await expect(captureSessionCandidate(f.cwd, pin, { env: { OPENLUP_STACK_BASE: pin }, runGit: pinGit })).resolves.toMatchObject({ base: pin });
    expect(pinGit.mock.calls).toContainEqual([f.cwd, 'merge-base', '--is-ancestor', f.base, pin]);
    expect(pinGit.mock.calls).toContainEqual([f.cwd, 'merge-base', '--is-ancestor', pin, f.head]);
    await expect(captureSessionCandidate(f.cwd, pin, { env: {}, runGit: pinGit })).rejects.toThrow('fork point changed');
    await expect(captureSessionCandidate(f.cwd, undefined, { env: { OPENLUP_STACK_BASE: 'bad' }, runGit: pinGit })).rejects.toThrow('full commit digest');
  });
});
