import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { admit, carryOver, COMPRESSED_RECEIPT_MARKER, DEFER_HARDENING, deferFinding, digest, ECONOMY_RECEIPT_MARKER, integrationReviewContext, prepareCandidate, receiptBody, RECEIPT_DETAILS_HEADER, RECEIPT_MARKER, receiptSummary, recordReport } from './agent-review-decide.mjs';
import { carryOverSourceReview, createGitHubReadApi, diagnoseReceipt, enqueueAfterChecks, EXIT_AWAITING_RECEIPT, isMigrationQueueSerializedPath, parseReceipt, probeToolchainNeeded, readReceipts, reportQueueCliError, waitNativeAdmission } from './agent-review-queue.mjs';
import { captureCommittedReviewCandidate, captureReviewRules, captureCoverageEdge, git as sourceGit } from './agent-review-session.mjs';
import { createLocalQueueReadAdapter, observeQueueAdmission, parseQueueCommand, verifyQueueReview } from './agent-review-queue-planner.mjs';
import { REQUIRED_CONTEXTS } from './packages/release-gate.ts';
import { checkQueueArm } from './merge-queue-check-arm.mjs';

function collectImportClosure(entry: string) {
  const visited = new Set<string>();
  const visit = (path: string) => {
    if (visited.has(path)) return;
    visited.add(path);
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest);
    const checkSpecifier = (specifier: string) => {
      expect(specifier, path).toMatch(/^(?:node:|\.\.?\/)/u);
      if (!specifier.startsWith('node:')) visit(resolve(dirname(path), specifier));
    };
    const walk = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        checkSpecifier(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const firstArg = node.arguments[0];
        expect(Boolean(firstArg && ts.isStringLiteralLike(firstArg)), `${path}: dynamic import must use a string literal specifier`).toBe(true);
        if (firstArg && ts.isStringLiteralLike(firstArg)) checkSpecifier(firstArg.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  visit(entry);
  return visited;
}

it('keeps the native queue static and dynamic import closure free of npm dependencies', () => {
  const closure = collectImportClosure(resolve('scripts/agent-review-queue.mjs'));
  expect(closure.size).toBeGreaterThan(0);
});

it('imports agent-review-queue.mjs and agent-review-session.mjs in bare Node with zero node_modules', () => {
  const repoRoot = resolve('.');
  const closure = collectImportClosure(resolve(repoRoot, 'scripts/agent-review-queue.mjs'));
  const isolated = mkdtempSync(join(tmpdir(), 'openlup-bare-node-'));
  try {
    for (let dir = isolated; ; dir = dirname(dir)) {
      expect(existsSync(join(dir, 'node_modules')), `ancestor ${dir} must not contain node_modules`).toBe(false);
      if (dir === dirname(dir)) break;
    }
    for (const file of closure) {
      const rel = relative(repoRoot, file);
      expect(rel.startsWith('..'), file).toBe(false);
      const target = join(isolated, rel);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(file, target);
    }
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "const q = await import('./scripts/agent-review-queue.mjs'); const s = await import('./scripts/agent-review-session.mjs'); console.log(typeof q.enqueueAfterChecks, typeof q.probeToolchainNeeded, typeof q.reportQueueCliError, typeof q.createGitHubReadApi, q.EXIT_AWAITING_RECEIPT, typeof s.proveReviewIntegration);"],
      { cwd: isolated, env: { PATH: processEnvironment.PATH ?? '' }, encoding: 'utf8', timeout: 30000 },
    );
    expect(output.trim()).toBe('function function function function 78 function');
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});

const time = 1000;
const receipt = { pr: 12, base: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40), risk: 'routine', reviewers: ['reviewer'], verdict: 'PASS', expires: time + 86400000, sessionDigest: 'd'.repeat(64) };
const observed = { ...receipt, baseValid: true, changedPaths: ['source.txt'] };
const body = (value = receipt) => `${RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const comment = (patch = {}) => ({ id: 1, body: body(), author_association: 'OWNER', user: { login: 'review-owner', type: 'User' }, created_at: '2026-10-19T00:00:00Z', ...patch });

function handoffFixture(candidate = receipt) {
  const repository = { id: 1376035358, full_name: 'openlup/openlup', private: false, owner: { login: 'openlup' } };
  const run = { id: 88 + candidate.pr, workflow_id: 42, run_attempt: 1, event: 'pull_request', path: '.github/workflows/published-tree-ci.yml', repository,
    head_repository: structuredClone(repository), head_sha: candidate.head, head_branch: candidate.pr === receipt.pr ? 'task/queue' : `task/queue-${candidate.pr}`, status: 'completed', conclusion: 'success', pull_requests: [] };
  const pr = { number: candidate.pr, state: 'open', draft: false, merged: false, base: { ref: 'main', repo: repository },
    head: { sha: candidate.head, ref: run.head_branch, repo: structuredClone(repository) } };
  const queuePr = { id: `PR_${candidate.pr}`, number: candidate.pr, state: 'OPEN', isDraft: false, merged: false, baseRefName: 'main', headRefOid: candidate.head,
    mergeable: 'MERGEABLE', autoMergeRequest: { enabledAt: '2026-10-24T12:00:00Z', enabledBy: { login: 'merge-owner' } }, mergeQueueEntry: null as null | { id: string },
    timelineItems: { nodes: [] as { createdAt: string }[] } };
  const jobs = [...REQUIRED_CONTEXTS, 'native-review'].map((name, index) => ({ id: index + 1, name, run_id: run.id, run_attempt: 1, head_sha: candidate.head, status: 'completed', conclusion: 'success' }));
  const f = { event: { action: 'completed', repository, workflow_run: structuredClone(run) },
    env: { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_REF: 'refs/heads/main' }, run, pr, queuePr,
    pulls: [pr], listing: { total_count: 1, workflow_runs: [run] }, result: { total_count: jobs.length, jobs }, comments: [comment({ body: body(candidate) })],
    permission: 'write', clock: time, getHook: (_path: string) => {} };
  const api = { get: vi.fn(async (path: string) => {
    f.getHook(path);
    if (path.startsWith('/graphql?')) return { data: { repository: { pullRequest: structuredClone(f.queuePr) } } };
    if (path.includes('/collaborators/')) return { permission: f.permission };
    if (path.includes('/jobs?')) {
      const params = new URL(path, 'https://example.invalid').searchParams;
      const page = Number(params.get('page'));
      const perPage = Number(params.get('per_page') ?? '50');
      return { total_count: f.result.total_count, jobs: structuredClone(f.result.jobs.slice((page - 1) * perPage, page * perPage)) };
    }
    if (path.includes('/actions/workflows/')) return structuredClone(f.listing);
    if (path.includes('/actions/runs/')) return structuredClone(f.run);
    if (path.includes('/pulls?')) return structuredClone(f.pulls);
    if (path.includes('/pulls/')) return structuredClone(f.pr);
    if (path.includes('/issues/')) return structuredClone(f.comments);
    if (path.includes('/git/ref/')) return { object: { sha: candidate.base } };
    throw new Error(`unexpected read ${path}`);
  }) };
  const runGit = vi.fn(async (_cwd: string, ...args: string[]) => {
    if (args[0] === 'rev-parse') return candidate.tree;
    if (args[0] === 'merge-base' && args[1] === '--all') return candidate.base;
    if (args[0] === 'diff') return `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0source.txt\0`;
    return '';
  });
  const enqueue = vi.fn(async () => { f.queuePr.mergeQueueEntry = { id: 'QUEUE_1' }; return { id: 'QUEUE_1' }; });
  const pauseMergeability = vi.fn(async (_ms: number) => {});
  const liveReads = () => api.get.mock.calls.filter(([path]) => path.startsWith('/graphql?')).length;
  return { ...f, api, runGit, enqueue, pauseMergeability, liveReads, state: f,
    execute: () => enqueueAfterChecks({ event: f.event, env: f.env, api, runGit, enqueue, pauseMergeability, now: () => f.clock }) };
}

describe('hosted receipt comments', () => {
  const modernReceipt = (reviewer = 'reviewer-1', card = 'receipt-card') => {
    const rules = { version: 3, base: digest([]), head: digest([]) };
    const candidate = { base: receipt.base, head: receipt.head, tree: receipt.tree, changedPaths: observed.changedPaths, modeChanged: false, clean: true, rules };
    const prepared = prepareCandidate(null, { ...candidate, authorSessionId: 'author', intent: { risk: 'behavior', criteria: 'Verify the receipt' } }, time);
    const report = { cold: true, tree: receipt.tree, verdict: 'PASS', documentation: 'Checked the contributor guide.', findings: [], closes: [] };
    const failed = recordReport(prepared, { ...report, reviewer: 'prior-failure', verdict: 'FAIL', findings: [{ id: card, summary: 'Resolve the card.', material: true }] }, time);
    const first = recordReport(failed, { ...report, reviewer, closes: [card] }, time);
    const second = recordReport(first, { ...report, reviewer: 'reviewer-2' }, time);
    const completed = recordReport(second, { ...report, reviewer: 'delta-only', ordinary: true }, time);
    return receiptSummary(completed, receipt.pr, time);
  };
  const historicalRawReceipt = (summary: ReturnType<typeof modernReceipt>) => receiptBody(summary)
    .replace(COMPRESSED_RECEIPT_MARKER, ECONOMY_RECEIPT_MARKER)
    .replace(/```text\n[^\n]+/u, () => '```json\n' + JSON.stringify(summary));

  const wait = (f: ReturnType<typeof handoffFixture>) => waitNativeAdmission({
    event: { number: receipt.pr, repository: { private: false }, pull_request: { head: { sha: receipt.head } } },
    env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' }, api: f.api, runGit: f.runGit,
    now: () => f.state.clock, sleep: async ms => { f.state.clock += ms; }, deadlineMs: 15000,
  });

  const waitFor = async (...bodies: string[]) => {
    const f = handoffFixture();
    f.state.comments = bodies.map((body, index) => comment({ id: 42 + index, body }));
    const original = f.runGit.getMockImplementation()!;
    f.runGit.mockImplementation(async (cwd, ...args) => args[0] === 'show' ? 'export const REVIEW_RULES_VERSION = 3;\n' : original(cwd, ...args));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      return await wait(f);
    } finally { log.mockRestore(); }
  };

  it('renders and admits the counted reports above one gzip machine block', async () => {
    const summary = modernReceipt();
    const rendered = receiptBody(summary);
    const payload = gzipSync(JSON.stringify(summary)).toString('base64');
    expect(rendered.split('\n')).toEqual([
      COMPRESSED_RECEIPT_MARKER, '',
      'PR #12 · Head bbbbbbb · Tree ccccccc · Verdict PASS · Reviewer floor 2 · Scope full', '',
      '| Reviewer | Verdict | Scope | Cards closed |', '| --- | --- | --- | --- |',
      '| reviewer-1 | PASS | full | receipt-card |', '| reviewer-2 | PASS | full | none |', '',
      'Open cards: none', '', '<details><summary>Machine-readable receipt (verified by admission)</summary>', '',
      '```text', payload, '```', '', '</details>',
    ]);
    expect(parseReceipt(rendered)).toEqual(summary);
    await expect(waitFor(rendered)).resolves.toEqual(summary);
  });

  it('parses and admits a historical framed raw v3 receipt', async () => {
    const summary = modernReceipt();
    const rendered = historicalRawReceipt(summary);
    expect(rendered).toContain(`\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\`\n`);
    expect(parseReceipt(rendered)).toEqual(summary);
    await expect(waitFor(rendered)).resolves.toEqual(summary);
  });

  it.each([false, true])('ignores a changed verdict cell, a deleted row and a fake row with gzip=%s', async gzip => {
    const summary = modernReceipt();
    const rendered = gzip ? receiptBody(summary) : historicalRawReceipt(summary);
    const edited = rendered.replace('| reviewer-1 | PASS |', '| reviewer-1 | FAIL |')
      .replace('| reviewer-2 | PASS | full | none |\n', '')
      .replace('\n\nOpen cards:', '\n| fake-reviewer_2.1 | PASS | delta | made-up-card, second? |\n\nOpen cards:');
    expect(edited).toContain('| reviewer-1 | FAIL |');
    expect(edited).not.toContain('| reviewer-2 |');
    expect(edited).toContain('| fake-reviewer_2.1 |');
    expect(parseReceipt(edited + '\n \t\n')).toEqual(summary);
    expect(parseReceipt(rendered)).toEqual(summary);
    const admitted = await waitFor(rendered);
    expect(admitted).toEqual(summary);
    await expect(waitFor(edited)).resolves.toEqual(admitted);
  });

  describe.each(['raw', 'gzip'])('framed %s refusals', format => {
    const summary = modernReceipt();
    const rendered = format === 'gzip' ? receiptBody(summary) : historicalRawReceipt(summary);
    const section = rendered.slice(rendered.indexOf('\n<details>'));
    const machine = section.split('\n').slice(-5, -2).join('\n');
    const fence = machine.split('\n')[0];
    const withDisplay = (display: string) => rendered.replace('\n\n', `\n\n${display}\n\n`);
    it.each([
      ['a fenced block in the display', withDisplay(`${fence}\nextra\n\`\`\``)],
      ['a dangling opener in the display', withDisplay(fence)],
      ['an HTML comment opener in the display', withDisplay('<!-- hidden')],
      ['a details tag in the display', withDisplay('<details>')],
      ['a closing angle bracket in the display', withDisplay('>')],
      ['a dangling tilde fence in the display', withDisplay('~~~')],
      ['a dangling tagged tilde fence in the display', withDisplay('~~~text')],
      ['a closed tilde fence in the display', withDisplay('~~~\nextra\n~~~')],
      ['a closed tagged tilde fence in the display', withDisplay('~~~text\nextra\n~~~')],
      ...['*', '[', '=', '+', '~', '\\', '&', '\t', '\r'].map(character => [
        `Markdown control ${JSON.stringify(character)} in the display`, withDisplay(character),
      ]),
      ['a duplicated details section', rendered + section],
      ['a missing details close', rendered.replace('</details>', '')],
      ['two machine blocks in the section', rendered.replace('\n\n</details>', `\n\n${machine}\n\n</details>`)],
      ['text after the details section', rendered + '\nextra'],
    ])('refuses %s', (_label, malformed) => {
      expect(parseReceipt(malformed)).toBeNull();
    });
  });

  const notice = (reason: string) =>
    `receipt comment 42: Review receipt machine block could not be parsed: ${reason}. Re-run \`node scripts/agent-review-session.mjs receipt 12\` and post its exact output.`;
  const v2Remedy = ' A v2 receipt needs a session prepared on current main.';

  it.each([false, true])('refuses a duplicate machine block with gzip=%s and names the comment and remedy', async gzip => {
    const summary = modernReceipt();
    const rendered = gzip ? receiptBody(summary) : historicalRawReceipt(summary);
    const machine = rendered.split('\n').slice(-5, -2).join('\n');
    const duplicate = `${rendered}\n\n${machine}`;
    expect(parseReceipt(duplicate)).toBeNull();
    await expect(waitFor(duplicate)).rejects.toThrow(notice('no machine block in the form the receipt command prints'));
    await expect(waitFor(rendered, duplicate)).resolves.toEqual(summary);
  });

  it.each([null, undefined, 42, {}, []].map(body => [body]))('diagnoses a non-string body %j', body => {
    expect(diagnoseReceipt(body)).toBe('comment body is not text');
  });

  describe.each(['bare', 'framed'])('%s receipt diagnostics', placement => {
    const fence = (type: string, payload: string) => `\`\`\`${type}\n${payload}\n\`\`\``;
    const raw = (payload: string) => fence('json', payload);
    const gzip = (payload: string) => fence('text', payload);
    const compress = (payload: string | Buffer) => gzipSync(payload).toString('base64');
    const noBlock = 'no machine block in the form the receipt command prints';
    const version = 'receipt version does not match its marker';
    const badEscape = '{"version":3,"note":"\\^P"}';
    const badEscapeNotice = 'Bad escaped character in JSON at position 22 (line 1 column 23) at offset 22';
    const members = Buffer.concat([gzipSync('{"version":3}'), gzipSync('')]).toString('base64');
    it.each([
      ['size limit', ECONOMY_RECEIPT_MARKER, 'x'.repeat(1024 * 1024), 'receipt body exceeds the size limit'],
      ['block extraction', ECONOMY_RECEIPT_MARKER, 'unfenced JSON', noBlock],
      ['mismatched fence', COMPRESSED_RECEIPT_MARKER, raw('{"version":3}'), noBlock],
      ['noncanonical base64', COMPRESSED_RECEIPT_MARKER, gzip('AAAA='), 'base64 is not canonical'],
      ['gzip header flags', COMPRESSED_RECEIPT_MARKER, gzip('AAAA'), 'gzip header is missing or has unsupported flags'],
      ['zlib failure', COMPRESSED_RECEIPT_MARKER, gzip('AAAAAA=='), 'incorrect header check'],
      ['trailing gzip data', COMPRESSED_RECEIPT_MARKER, gzip(members), 'gzip stream has trailing data'],
      ['strict UTF-8', COMPRESSED_RECEIPT_MARKER, gzip(compress(Buffer.from([0xff]))), 'The encoded data was not valid for encoding utf-8'],
      ['gzip version mismatch', COMPRESSED_RECEIPT_MARKER, gzip(compress('{"version":2}')), version],
      ['raw version mismatch', ECONOMY_RECEIPT_MARKER, raw('{"version":2}'), version],
      ['null v2 receipt', RECEIPT_MARKER, raw('null'), 'receipt JSON is null'],
      ['unexpected end', ECONOMY_RECEIPT_MARKER, raw('{"version":'), 'Unexpected end of JSON input'],
      ['position-bearing JSON error', ECONOMY_RECEIPT_MARKER, raw(badEscape), badEscapeNotice],
      ['gzip JSON error', COMPRESSED_RECEIPT_MARKER, gzip(compress(badEscape)), badEscapeNotice],
      ['position text in an excerpt', ECONOMY_RECEIPT_MARKER, raw('x at position 987'), "Unexpected token 'x'"],
      ['quoted input excerpt', ECONOMY_RECEIPT_MARKER, raw('undefined'), 'input is not valid JSON'],
      ['multiline untrusted excerpt', COMPRESSED_RECEIPT_MARKER, gzip(compress('é\n::字')), "Unexpected token '?'"],
    ])('reports the parser error for %s', async (_label, marker, block, reason) => {
      const rendered = placement === 'bare' ? marker + '\n' + block
        : `${marker}\n\nSummary\n\n${RECEIPT_DETAILS_HEADER}\n\n${block}\n\n</details>`;
      expect(parseReceipt(rendered)).toBeNull();
      expect(diagnoseReceipt(rendered)).toBe(reason);
      await expect(waitFor(rendered)).rejects.toThrow(notice(reason) + (marker === RECEIPT_MARKER ? v2Remedy : ''));
    });
  });

  it('caps the parser message and keeps it on one printable ASCII line', () => {
    const rendered = `${ECONOMY_RECEIPT_MARKER}\n\`\`\`json\n{}\n\`\`\``;
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new SyntaxError('message\né' + 'x'.repeat(160));
    });
    try {
      expect(diagnoseReceipt(rendered)).toBe('message??' + 'x'.repeat(151));
    } finally { parse.mockRestore(); }
  });

  it('tells an author to prepare on current main when a rewritten v2 receipt is refused', async () => {
    const rendered = body({ ...receipt, reviewers: ['old\u0010-reviewer'] }).replaceAll('\\u0010', '\\^P');
    const reason = diagnoseReceipt(rendered);
    expect(reason).toMatch(/^Bad escaped character in JSON at position \d+/u);
    await expect(waitFor(rendered)).rejects.toThrow(notice(reason!) + v2Remedy);
  });

  it.each(['raw v2', 'raw v3', 'gzip v3'])('parses and admits the bare %s format', async format => {
    const summary = format === 'raw v2' ? receipt : modernReceipt();
    const json = JSON.stringify(summary);
    const rendered = format === 'raw v2' ? body() : format === 'raw v3'
      ? `${ECONOMY_RECEIPT_MARKER}\n\`\`\`json\n${json}\n\`\`\``
      : `${COMPRESSED_RECEIPT_MARKER}\n\`\`\`text\n${gzipSync(json).toString('base64')}\n\`\`\``;
    expect(parseReceipt(rendered)).toEqual(summary);
    await expect(waitFor(rendered)).resolves.toEqual(summary);
  });

  it('preserves the source verification failure and appends the malformed comment notice', async () => {
    const f = handoffFixture();
    f.state.comments = [comment(), comment({ id: 42, body: `${RECEIPT_MARKER}\ninvalid` })];
    f.runGit.mockRejectedValueOnce(new Error('unknown base'));
    const reason = 'receipt objects could not be verified: unknown base; post a corrected receipt; ' +
      notice('no machine block in the form the receipt command prints') + v2Remedy;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(wait(f)).rejects.toThrow(reason);
      expect(log).toHaveBeenLastCalledWith(`needs_agent_review: ${reason}`);
    } finally { log.mockRestore(); }
  });

  it('sanitizes and caps reviewer and card cells without changing the admitted machine block', async () => {
    const suffix = '```json|\n<details>' + 'x'.repeat(100);
    const summary = modernReceipt(`reviewer:${suffix}`, `card:${suffix}`);
    const rendered = receiptBody(summary);
    const lines = rendered.split('\n');
    const reviewer = 'reviewer:???json???details?'.padEnd(80, 'x');
    const card = 'card:???json???details?'.padEnd(80, 'x');
    expect(lines).toContain(`| ${reviewer} | PASS | full | ${card} |`);
    expect(lines.filter(line => line.startsWith('```'))).toEqual(['```text', '```']);
    expect(parseReceipt(rendered)).toEqual(summary);
    await expect(waitFor(rendered)).resolves.toEqual(summary);
  });

  it('admits deferrals according to the Git base of each review round', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'openlup-legacy-defer-'));
    const runner = mkdtempSync(join(tmpdir(), 'openlup-defer-runner-'));
    const git = (...args: string[]) => execFileSync('/usr/bin/git', [
      '--no-replace-objects', '-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const put = (path: string, content: string) => {
      const target = join(cwd, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    };
    const commit = (msg: string) => {
      git('add', '-A');
      git('commit', '-qm', msg);
      return git('rev-parse', 'HEAD');
    };
    try {
      git('init', '-q', '-b', 'main');
      put('scripts/agent-review-decide.mjs', 'export const REVIEW_RULES_VERSION = 3;\nexport function deferFinding(session) { return session; }\n');
      put('app.ts', 'export const n = 1;\n');
      const legacyBase = commit('pre-pr4 base');
      git('update-ref', 'refs/remotes/origin/main', legacyBase);

      put('app.ts', 'export const n = 2;\n');
      const legacyHead = commit('pr on pre-pr4 base');
      const legacyCand = await captureCommittedReviewCandidate(cwd, legacyBase, legacyHead);
      const legacyRules = await captureReviewRules(cwd, legacyCand);
      const intent = { risk: 'routine', criteria: 'Preserve legacy defer compatibility' };
      const deferBases = { legacyDeferBases: new Set([legacyBase]) };
      const confirmDefer = (session: ReturnType<typeof prepareCandidate>, options = {}) => {
        const report = { cold: true, tree: session.candidate.tree, documentation: 'Checked.', closes: [] };
        const failed = recordReport(session, {
          ...report, reviewer: 'hard-r1', verdict: 'FAIL', findings: [{ id: 'HARD-1', summary: 'hardened card', material: true }],
        }, time + 6, options);
        const deferred = deferFinding(failed, { findingId: 'HARD-1', target: 'issue-2', decision: 'CM-2', reason: 'confirmed deferral' }, time + 7);
        return recordReport(deferred, {
          ...report, reviewer: 'hard-r2', verdict: 'PASS', findings: [], acceptsDefer: ['HARD-1'],
        }, time + 8, options);
      };
      const preSession = {
        version: 3,
        authorSessionId: 'author',
        intent,
        candidate: { ...legacyCand, rules: legacyRules },
        preparedAt: time + 2,
        history: [
          { type: 'rules', version: 3, at: time },
          { type: 'prepare', intent, candidate: { ...legacyCand, rules: legacyRules }, authorSessionId: 'author', at: time },
          {
            type: 'report', at: time,
            report: { reviewer: 'leg-r1', cold: true, tree: legacyCand.tree, verdict: 'FAIL', documentation: 'Checked.', findings: [{ id: 'LEG-1', summary: 'legacy card', material: true }], closes: [], at: time },
          },
          { type: 'defer', at: time + 1, findingId: 'LEG-1', target: 'later', decision: 'CM-1', reason: 'pre-pr4 deferral' },
          {
            type: 'report', at: time + 2,
            report: { reviewer: 'leg-r2', cold: true, tree: legacyCand.tree, verdict: 'PASS', documentation: 'Checked.', findings: [], closes: [], at: time + 2 },
          },
        ],
      };
      const legacySummary = receiptSummary(preSession, 12, time + 2, { legacyDefer: true });
      const legacyBody = receiptBody(legacySummary, { legacyDefer: true });

      const env = { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' };
      const pullRequestEvent = (head: string) => ({ number: 12, repository: { private: false }, pull_request: { head: { sha: head } } });
      const receiptApi = (mainSha: string, prHead: string, receiptCommentBody: string) => {
        const pr = { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: prHead } };
        return {
          get: vi.fn(async (path: string) => path.includes('/pulls/') ? pr
            : path.includes('/issues/') ? [comment({ body: receiptCommentBody })]
            : path.includes('/collaborators/') ? { permission: 'write' }
            : { object: { sha: mainSha } }),
        };
      };
      const admitReal = async (mainSha: string, prHead: string, receiptCommentBody: string, checkout = cwd) => {
        const api = receiptApi(mainSha, prHead, receiptCommentBody);
        const runGit = (dir: string, ...args: string[]) =>
          dir === cwd && args.includes('fetch') ? Promise.resolve('') : sourceGit(dir, ...args);
        let clock = time + 10;
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          return await waitNativeAdmission({
            cwd: checkout, api, runGit, now: () => clock, sleep: async ms => { clock += ms; }, deadlineMs: 1,
            event: pullRequestEvent(prHead), env,
          });
        } finally { log.mockRestore(); }
      };

      // Case 1: Pre-PR-4 base + pre-PR-4 defer receipt admits cleanly.
      await expect(admitReal(legacyBase, legacyHead, legacyBody)).resolves.toEqual(legacySummary);

      const legacyObserved = { ...legacyCand, rules: legacyRules, intent, authorSessionId: 'author' };
      const forgedLegacySession = confirmDefer(prepareCandidate(undefined, legacyObserved, time + 5));
      const forgedLegacySummary = receiptSummary(forgedLegacySession, 12, time + 8);
      const forgedLegacyBody = receiptBody(forgedLegacySummary);
      await expect(probeToolchainNeeded({
        event: pullRequestEvent(legacyHead), env, api: receiptApi(legacyBase, legacyHead, forgedLegacyBody), now: () => time + 10,
      })).resolves.toBe(true);
      await expect(admitReal(legacyBase, legacyHead, forgedLegacyBody)).rejects.toThrow('invalid historical acceptsDefer');

      const invalidSingleBaseBody = receiptBody({ ...forgedLegacySummary, sessionDigest: digest([]) });
      const invalidApi = receiptApi(legacyBase, legacyHead, invalidSingleBaseBody);
      await expect(readReceipts(invalidApi, '/repos/openlup/openlup', 12, legacyHead, time + 10)).resolves.toEqual([]);
      expect(invalidApi.get.mock.calls).toEqual([['/repos/openlup/openlup/issues/12/comments?per_page=50&page=1']]);

      // Advance main with PR-4 DEFER_HARDENING.
      git('checkout', '-q', '--detach', legacyBase);
      put('scripts/agent-review-decide.mjs', `export const REVIEW_RULES_VERSION = 3;\nexport const DEFER_HARDENING = '${DEFER_HARDENING}';\nexport function deferFinding(session) { return session; }\n`);
      put('main-note.txt', 'post-pr4 main\n');
      const hardenedBase = commit('post-pr4 base');
      git('update-ref', 'refs/remotes/origin/main', hardenedBase);

      // Case 2: Integrated PR carrying forward a pre-PR-4 deferred session onto post-PR-4 main also admits cleanly.
      git('checkout', '-q', '--detach', legacyHead);
      git('merge', '--no-ff', '-qm', 'merge post-pr4 main', hardenedBase);
      const integratedHead = git('rev-parse', 'HEAD');
      const integratedCand = await captureCommittedReviewCandidate(cwd, hardenedBase, integratedHead);
      const integratedObserved = { ...integratedCand, rules: await captureReviewRules(cwd, integratedCand), intent, authorSessionId: 'author' };
      const integration = integrationReviewContext(preSession, integratedObserved, { parents: [legacyHead, hardenedBase], baseAncestor: true, mechanical: true }, time + 3, deferBases);
      const coverage = await captureCoverageEdge(cwd, preSession, integratedObserved, time + 3);
      const integratedSession = prepareCandidate(preSession, { ...integratedObserved, integration, coverage }, time + 3, false, deferBases);
      const integratedSummary = receiptSummary(integratedSession, 12, time + 3, deferBases);
      const integratedBody = receiptBody(integratedSummary, deferBases);
      await expect(admitReal(hardenedBase, integratedHead, integratedBody)).resolves.toEqual(integratedSummary);

      const hardenedSession = prepareCandidate(undefined, integratedObserved, time + 5);
      const hardenedSummary = receiptSummary(confirmDefer(hardenedSession), 12, time + 8);
      const hardenedBody = receiptBody(hardenedSummary);
      const api = { get: vi.fn(async path => path.includes('/collaborators/') ? { permission: 'write' } : [comment({ body: hardenedBody })]) };
      await expect(readReceipts(api, '/repos/openlup/openlup', 12, integratedHead, time + 8)).resolves.toEqual([hardenedSummary]);

      const mixedSummary = receiptSummary(confirmDefer(integratedSession, deferBases), 12, time + 8, deferBases);
      git('merge-base', '--is-ancestor', legacyBase, integratedHead);
      git('-C', runner, 'init', '-q', '-b', 'main');
      git('-C', runner, 'remote', 'add', 'origin', cwd);
      expect(() => git('-C', runner, 'cat-file', '-e', `${legacyBase}^{commit}`)).toThrow();
      await expect(admitReal(hardenedBase, integratedHead, receiptBody(mixedSummary, deferBases), runner)).resolves.toEqual(mixedSummary);
      expect(git('-C', runner, 'rev-parse', '--verify', `${legacyBase}^{commit}`)).toBe(legacyBase);

      // Case 3: A fresh unhardened defer created AFTER PR-4 DEFER_HARDENING landed is strictly refused.
      git('checkout', '-q', '--detach', hardenedBase);
      put('app.ts', 'export const n = 3;\n');
      const forgedHead = commit('pr on post-pr4 base');
      const forgedCand = await captureCommittedReviewCandidate(cwd, hardenedBase, forgedHead);
      const forgedRules = await captureReviewRules(cwd, forgedCand);
      const forgedSession = {
        version: 3,
        authorSessionId: 'author',
        intent,
        candidate: { ...forgedCand, rules: forgedRules },
        preparedAt: time + 5,
        history: [
          { type: 'prepare', intent, candidate: { ...forgedCand, rules: forgedRules }, authorSessionId: 'author', at: time + 4 },
          {
            type: 'report', at: time + 4,
            report: { reviewer: 'forged-r1', cold: true, tree: forgedCand.tree, verdict: 'FAIL', documentation: 'Checked.', findings: [{ id: 'FRG-1', summary: 'post-pr4 card', material: true }], closes: [], at: time + 4 },
          },
          { type: 'defer', at: time + 5, findingId: 'FRG-1', target: 'later', decision: 'CM-2', reason: 'bypass attempt' },
          {
            type: 'report', at: time + 5,
            report: { reviewer: 'forged-r2', cold: true, tree: forgedCand.tree, verdict: 'PASS', documentation: 'Checked.', findings: [], closes: [], at: time + 5 },
          },
        ],
      };
      const forgedSummary = receiptSummary(forgedSession, 12, time + 5, { legacyDefer: true });
      const forgedRawBody = `${ECONOMY_RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(forgedSummary)}\n\`\`\``;
      await expect(admitReal(hardenedBase, forgedHead, forgedRawBody)).rejects.toThrow('receipt wait expired');
    } finally {
      rmSync(runner, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CI completion queue handoff', () => {
  it('admits and enqueues a bare raw v2 receipt with a trailing space after the closing fence', async () => {
    const f = handoffFixture();
    f.state.comments = [comment({ body: body() + ' ' })];
    await expect(f.execute()).resolves.toMatchObject({ status: 'enqueued', pr: receipt.pr, head: receipt.head });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('enqueues one armed reviewed source head, including fork=%s and empty run pull_requests', async fork => {
    const f = handoffFixture();
    if (fork) {
      f.run.head_repository.id = 123; f.run.head_repository.owner.login = 'contributor';
      f.pr.head.repo.id = 123; f.pr.head.repo.owner.login = 'contributor'; f.event.workflow_run = structuredClone(f.run);
    }
    await expect(f.execute()).resolves.toEqual({ status: 'enqueued', pr: 12, head: receipt.head, entry: 'QUEUE_1' });
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith({ pullRequestId: 'PR_12', expectedHeadOid: receipt.head, jump: false });
    expect(f.api.get).toHaveBeenCalledWith(expect.stringContaining(`head=${encodeURIComponent(`${fork ? 'contributor' : 'openlup'}:task/queue`)}`));
    expect(f.runGit).toHaveBeenCalledWith(expect.any(String), 'diff', '--raw', '--no-abbrev', '--no-renames', '-z', receipt.base, receipt.head);
    expect(f.api.get.mock.calls.filter(([path]) => path.includes('/issues/'))).toHaveLength(1);
  });
  it.each([
    ['wrong repository', (f: ReturnType<typeof handoffFixture>) => { f.event.repository.id = 2; }],
    ['private repository', (f: ReturnType<typeof handoffFixture>) => { f.event.repository.private = true; }],
    ['untrusted event', (f: ReturnType<typeof handoffFixture>) => { f.env.GITHUB_EVENT_NAME = 'pull_request'; }],
    ['non-main checkout', (f: ReturnType<typeof handoffFixture>) => { f.env.GITHUB_REF = 'refs/pull/12/merge'; }],
    ['wrong workflow', (f: ReturnType<typeof handoffFixture>) => { f.event.workflow_run.path = '.github/workflows/forged.yml'; }],
    ['merge-group source', (f: ReturnType<typeof handoffFixture>) => { f.event.workflow_run.event = 'merge_group'; }],
    ['cancelled source', (f: ReturnType<typeof handoffFixture>) => { f.event.workflow_run.conclusion = 'cancelled'; }],
    ['rerun', (f: ReturnType<typeof handoffFixture>) => { f.run.run_attempt++; }],
    ['newer source run', (f: ReturnType<typeof handoffFixture>) => { f.listing.workflow_runs.push({ ...f.run, id: 101 }); f.listing.total_count++; }],
    ['truncated listing', (f: ReturnType<typeof handoffFixture>) => { f.listing.total_count++; }],
    ['ambiguous PR', (f: ReturnType<typeof handoffFixture>) => { f.pulls.push({ ...f.pr, number: 13 }); }],
    ['conflict', (f: ReturnType<typeof handoffFixture>) => { f.queuePr.mergeable = 'CONFLICTING'; }],
    ['unknown mergeability', (f: ReturnType<typeof handoffFixture>) => { f.queuePr.mergeable = 'UNKNOWN'; }],
    ['lost merge authority', (f: ReturnType<typeof handoffFixture>) => { f.state.permission = 'read'; }],
    ['missing native receipt', (f: ReturnType<typeof handoffFixture>) => { f.state.comments = []; }],
    ['insufficient review floor', (f: ReturnType<typeof handoffFixture>) => { f.runGit.mockImplementation(async (_cwd, ...args) => args[0] === 'diff' ? `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0config/demo.json\0` : args[0] === 'rev-parse' ? receipt.tree : args[0] === 'merge-base' ? receipt.base : ''); }],
    ['missing check', (f: ReturnType<typeof handoffFixture>) => { f.result.jobs.pop(); f.result.total_count--; }],
    ['skipped check', (f: ReturnType<typeof handoffFixture>) => { f.result.jobs[0]!.conclusion = 'skipped'; }],
    ['failed required check', (f: ReturnType<typeof handoffFixture>) => { f.result.jobs[0]!.conclusion = 'failure'; }],
    ['duplicate check', (f: ReturnType<typeof handoffFixture>) => { f.result.jobs.push({ ...f.result.jobs[0]!, id: 88 }); f.result.total_count++; }],
    ['wrong check SHA', (f: ReturnType<typeof handoffFixture>) => { f.result.jobs[0]!.head_sha = receipt.base; }],
    ['wrong check run', (f: ReturnType<typeof handoffFixture>) => { f.result.jobs[0]!.run_id++; }],
    ['future check attempt', (f: ReturnType<typeof handoffFixture>) => { f.result.jobs[0]!.run_attempt++; }],
    ['truncated jobs', (f: ReturnType<typeof handoffFixture>) => { f.result.total_count++; }],
  ])('refuses %s without enqueueing', async (_name, change) => {
    const f = handoffFixture(); change(f);
    await expect(f.execute()).rejects.toThrow(); expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.api.get.mock.calls.filter(([path]) => path.includes('/issues/')).length).toBeLessThanOrEqual(1);
  });
  it('reports unavailable native review without receipt-rerun advice when missing at Queue Handoff', async () => {
    const f = handoffFixture();
    f.state.comments = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(f.execute()).rejects.toThrow('Current native review is unavailable at CI completion; no enqueue retry');
      expect(f.enqueue).not.toHaveBeenCalled();
      expect(f.api.get.mock.calls.filter(([path]) => path.includes('/issues/'))).toHaveLength(1);
    } finally { log.mockRestore(); }
  });
  it.each(['unarmed', 'already queued', 'head moved', 'draft'])('skips %s without a mutation', async scenario => {
    const f = handoffFixture();
    if (scenario === 'unarmed') Object.assign(f.queuePr, { autoMergeRequest: null });
    if (scenario === 'already queued') f.queuePr.mergeQueueEntry = { id: 'EXISTING' };
    if (scenario === 'head moved') f.pr.head.sha = receipt.base;
    if (scenario === 'draft') f.queuePr.isDraft = true;
    await expect(f.execute()).resolves.toMatchObject({ status: 'skipped' }); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each(['head', 'disarmed', 'queued', 'attempt', 'intent', 'permission'])('revalidates a late %s change before enqueue', async change => {
    const f = handoffFixture(); let reads = 0;
    f.state.getHook = path => {
      if (!path.includes('/actions/runs/100') || path.includes('/jobs?')) return;
      if (++reads !== 2) return;
      if (change === 'head') f.queuePr.headRefOid = receipt.base;
      if (change === 'disarmed') Object.assign(f.queuePr, { autoMergeRequest: null });
      if (change === 'queued') f.queuePr.mergeQueueEntry = { id: 'OTHER' };
      if (change === 'attempt') f.run.run_attempt++;
      if (change === 'intent') f.queuePr.autoMergeRequest.enabledAt = '2026-10-24T12:01:00Z';
      if (change === 'permission') f.state.permission = 'read';
    };
    if (['head', 'disarmed', 'queued'].includes(change)) await expect(f.execute()).resolves.toMatchObject({ status: 'skipped' });
    else await expect(f.execute()).rejects.toThrow();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each([1, 2])('queues once when UNKNOWN clears at mergeability check %i', async check => {
    const f = handoffFixture();
    f.state.getHook = path => {
      if (path.startsWith('/graphql?')) f.queuePr.mergeable = f.liveReads() === check ? 'UNKNOWN' : 'MERGEABLE';
    };
    await expect(f.execute()).resolves.toMatchObject({ status: 'enqueued' });
    expect(f.liveReads()).toBe(4);
    expect(f.pauseMergeability).toHaveBeenCalledExactlyOnceWith(15_000);
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith({ pullRequestId: 'PR_12', expectedHeadOid: receipt.head, jump: false });
  });
  it('refuses persistent UNKNOWN after twelve re-reads', async () => {
    const f = handoffFixture();
    f.queuePr.mergeable = 'UNKNOWN';
    await expect(f.execute()).rejects.toThrow('PR mergeability is still unknown after 13 reads; re-run the Queue Handoff job');
    expect(f.liveReads()).toBe(13);
    expect(f.pauseMergeability.mock.calls).toEqual(Array.from({ length: 12 }, () => [15_000]));
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    ['CONFLICTING', 'PR conflicts with main; merge main into the branch and push; auto-merge stays armed'],
    ['INVALID', 'invalid PR mergeability response'],
  ])('refuses %s mergeability immediately', async (mergeability, message) => {
    const f = handoffFixture();
    f.queuePr.mergeable = mergeability;
    await expect(f.execute()).rejects.toThrow(message);
    expect(f.liveReads()).toBe(1);
    expect(f.pauseMergeability).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each(['head changes', 'PR is disarmed'])('skips when the %s while mergeability is UNKNOWN', async change => {
    const f = handoffFixture();
    f.queuePr.mergeable = 'UNKNOWN';
    f.pauseMergeability.mockImplementationOnce(async () => {
      if (change === 'head changes') f.queuePr.headRefOid = receipt.base;
      else Object.assign(f.queuePr, { autoMergeRequest: null });
    });
    await expect(f.execute()).resolves.toEqual({ status: 'skipped', reason: 'PR changed, is unarmed, or is already queued' });
    expect(f.liveReads()).toBe(2);
    expect(f.pauseMergeability).toHaveBeenCalledExactlyOnceWith(15_000);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('refuses an intent change during the final mergeability check', async () => {
    const f = handoffFixture();
    f.state.getHook = path => {
      if (path.startsWith('/graphql?') && f.liveReads() === 2) f.queuePr.mergeable = 'UNKNOWN';
    };
    f.pauseMergeability.mockImplementationOnce(async () => {
      f.queuePr.autoMergeRequest.enabledAt = '2026-10-24T12:01:00Z';
    });
    await expect(f.execute()).rejects.toThrow('mergeability or auto-merge authority changed before enqueue');
    expect(f.liveReads()).toBe(3);
    expect(f.pauseMergeability).toHaveBeenCalledExactlyOnceWith(15_000);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('skips when the PR is disarmed during the final source run listing', async () => {
    const f = handoffFixture();
    f.state.getHook = path => {
      if (path.startsWith('/graphql?')) f.queuePr.mergeable = f.liveReads() === 2 ? 'UNKNOWN' : 'MERGEABLE';
      if (path.includes('/actions/workflows/published-tree-ci.yml/runs?') && f.pauseMergeability.mock.calls.length > 0) {
        Object.assign(f.queuePr, { autoMergeRequest: null });
      }
    };
    await expect(f.execute()).resolves.toEqual({ status: 'skipped', reason: 'PR changed, is unarmed, or is already queued' });
    expect(f.liveReads()).toBe(3);
    expect(f.pauseMergeability).toHaveBeenCalledExactlyOnceWith(15_000);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    ['a newer same-head run', 'a newer source run or attempt supersedes this completion'],
    ['a new attempt of the current run', 'source run or attempt changed'],
  ])('refuses %s during the final pause before taking another snapshot', async (scenario, refusal) => {
    const f = handoffFixture();
    f.state.getHook = path => {
      if (path.startsWith('/graphql?')) f.queuePr.mergeable = f.liveReads() === 2 ? 'UNKNOWN' : 'MERGEABLE';
    };
    f.pauseMergeability.mockImplementationOnce(async () => {
      if (scenario === 'a newer same-head run') {
        f.listing.workflow_runs.push({ ...f.run, id: 101, conclusion: 'failure' });
        f.listing.total_count++;
      } else {
        f.run.run_attempt++;
      }
    });
    await expect(f.execute()).rejects.toThrow(refusal);
    expect(f.liveReads()).toBe(2);
    expect(f.pauseMergeability).toHaveBeenCalledExactlyOnceWith(15_000);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    { mergeability: 'immediate MERGEABLE', pause: false },
    { mergeability: 'UNKNOWN then MERGEABLE', pause: true },
  ])('takes the final snapshot after the source check with $mergeability', async ({ pause }) => {
    const f = handoffFixture();
    f.state.getHook = path => {
      if (path.startsWith('/graphql?')) f.queuePr.mergeable = pause && f.liveReads() === 2 ? 'UNKNOWN' : 'MERGEABLE';
    };
    await expect(f.execute()).resolves.toMatchObject({ status: 'enqueued' });
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith({ pullRequestId: 'PR_12', expectedHeadOid: receipt.head, jump: false });
    expect(f.pauseMergeability).toHaveBeenCalledTimes(pause ? 1 : 0);
    expect(f.liveReads()).toBe(pause ? 4 : 3);
    const runPath = '/repos/openlup/openlup/actions/runs/100';
    const listingPath = `/repos/openlup/openlup/actions/workflows/published-tree-ci.yml/runs?event=pull_request&head_sha=${receipt.head}&per_page=100`;
    expect(f.api.get.mock.calls.filter(([path]) => path === runPath)).toHaveLength(pause ? 3 : 2);
    expect(f.api.get.mock.calls.filter(([path]) => path === listingPath)).toHaveLength(pause ? 3 : 2);
    const graphQL = expect.stringContaining('/graphql?');
    expect(f.api.get.mock.calls.slice(-5)).toEqual([
      [runPath],
      [listingPath],
      [graphQL],
      ['/repos/openlup/openlup/collaborators/merge-owner/permission'],
      [graphQL],
    ]);
    const reads = f.api.get.mock.invocationCallOrder;
    const [enqueue] = f.enqueue.mock.invocationCallOrder;
    expect(enqueue).toBeGreaterThan(reads.at(-2)!);
    expect(enqueue).toBeLessThan(reads.at(-1)!);
  });
  it('bounds pauses independently across both mergeability checks', async () => {
    const f = handoffFixture();
    f.state.getHook = path => {
      if (path.startsWith('/graphql?')) f.queuePr.mergeable = f.liveReads() === 13 ? 'MERGEABLE' : 'UNKNOWN';
    };
    const pausedAfterReads: number[] = [];
    f.pauseMergeability.mockImplementation(async () => { pausedAfterReads.push(f.liveReads()); });
    await expect(f.execute()).rejects.toThrow('PR mergeability is still unknown after 13 reads; re-run the Queue Handoff job');
    expect(f.liveReads()).toBe(26);
    expect(pausedAfterReads).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    expect(f.pauseMergeability.mock.calls).toEqual(Array.from({ length: 24 }, () => [15_000]));
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('does not retry a GitHub enqueue refusal', async () => {
    const f = handoffFixture(); f.enqueue.mockRejectedValue(new Error('required conversation unresolved'));
    await expect(f.execute()).rejects.toThrow('required conversation unresolved'); expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it('does not claim queue success for a different head observed after its single enqueue', async () => {
    const f = handoffFixture();
    f.enqueue.mockImplementation(async () => { f.queuePr.mergeQueueEntry = { id: 'QUEUE_1' }; f.queuePr.headRefOid = receipt.base; return { id: 'QUEUE_1' }; });
    await expect(f.execute()).rejects.toThrow('exact head'); expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it('allows aggregate failure when only a non-required diagnostic failed and all seven required checks passed', async () => {
    const f = handoffFixture(); f.run.conclusion = 'failure'; f.event.workflow_run.conclusion = 'failure';
    f.result.jobs.push({ ...f.result.jobs[0]!, id: 88, name: 'optional-diagnostic', conclusion: 'failure' }); f.result.total_count++;
    await expect(f.execute()).resolves.toMatchObject({ status: 'enqueued' }); expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it('uses six untouched first-attempt successes and the successful native-only partial rerun', async () => {
    const f = handoffFixture(); f.run.run_attempt = 2; f.event.workflow_run = structuredClone(f.run);
    const native = f.result.jobs.find(job => job.name === 'native-review')!;
    f.result.jobs.push({ ...native, id: 88, run_attempt: 2 }); f.result.total_count++;
    native.conclusion = 'failure';
    await expect(f.execute()).resolves.toMatchObject({ status: 'enqueued' });
    expect(f.api.get).toHaveBeenCalledWith('/repos/openlup/openlup/actions/runs/100/jobs?filter=all&per_page=50&page=1');
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith({ pullRequestId: 'PR_12', expectedHeadOid: receipt.head, jump: false });
  });
  it.each(['failure', 'skipped', 'pending', 'ambiguous latest'])('never recovers an earlier success over a later %s required job', async outcome => {
    const f = handoffFixture(); f.run.run_attempt = 2; f.event.workflow_run = structuredClone(f.run);
    const later = { ...f.result.jobs[0]!, id: 88, run_attempt: 2, conclusion: outcome === 'pending' ? 'success' : outcome === 'ambiguous latest' ? 'success' : outcome,
      status: outcome === 'pending' ? 'in_progress' : 'completed' };
    f.result.jobs.push(later); f.result.total_count++;
    if (outcome === 'ambiguous latest') { f.result.jobs.push({ ...later, id: 89 }); f.result.total_count++; }
    await expect(f.execute()).rejects.toThrow('latest dco'); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each(['complete', 'count changed', 'duplicate across pages', 'missing page'])('requires complete same-run job history pagination: %s', async scenario => {
    const f = handoffFixture();
    const filler = Array.from({ length: 50 }, (_, index) => ({ ...f.result.jobs[0]!, id: 100 + index, name: `diagnostic ${index}` }));
    f.result.jobs.push(...filler); f.result.total_count += filler.length;
    if (scenario === 'duplicate across pages') f.result.jobs[50]!.id = f.result.jobs[0]!.id;
    f.state.getHook = path => {
      if (!path.endsWith('page=2')) return;
      if (scenario === 'count changed') f.result.total_count++;
      if (scenario === 'missing page') f.result.jobs.splice(50);
    };
    if (scenario === 'complete') await expect(f.execute()).resolves.toMatchObject({ status: 'enqueued' });
    else { await expect(f.execute()).rejects.toThrow(); expect(f.enqueue).not.toHaveBeenCalled(); }
    expect(f.api.get).toHaveBeenCalledWith('/repos/openlup/openlup/actions/runs/100/jobs?filter=all&per_page=50&page=2');
  });
  it.each(['before', 'equal', 'after'])('bounds queue attempts to the current merge intent: prior event %s arming', async boundary => {
    const f = handoffFixture();
    f.queuePr.timelineItems.nodes = [{ createdAt: boundary === 'before' ? '2026-10-24T11:59:59Z' : boundary === 'equal' ? f.queuePr.autoMergeRequest.enabledAt : '2026-10-24T12:00:01Z' }];
    await expect(f.execute()).resolves.toMatchObject({ status: boundary === 'before' ? 'enqueued' : 'skipped' });
    expect(f.enqueue).toHaveBeenCalledTimes(boundary === 'before' ? 1 : 0);
  });
  it('does not requeue when another actor queued and removed this intent during admission', async () => {
    const f = handoffFixture();
    f.state.getHook = path => { if (path.includes('/issues/')) f.queuePr.timelineItems.nodes = [{ createdAt: f.queuePr.autoMergeRequest.enabledAt }]; };
    await expect(f.execute()).resolves.toMatchObject({ status: 'skipped' }); expect(f.enqueue).not.toHaveBeenCalled();
  });
});

describe('hosted review decisions', () => {
  it.each([
    ['pass', {}, {}, time, 'reviewed'],
    ['a month after the recorded expiry: reviews do not expire', {}, {}, receipt.expires + 30 * 86400000, 'reviewed'],
    ['wrong PR', { pr: 13 }, {}, time, 'stale'],
    ['wrong head', { head: 'e'.repeat(40) }, {}, time, 'stale'],
    ['wrong tree', { tree: 'e'.repeat(40) }, {}, time, 'stale'],
    ['wrong base', { base: 'e'.repeat(40) }, {}, time, 'stale'],
    ['unlanded pin', {}, { baseValid: false }, time, 'stale'],
    ['failed verdict', { verdict: 'FAIL' }, {}, time, 'invalid'],
    ['duplicate reviewers', { reviewers: ['r', 'r'] }, {}, time, 'invalid'],
    ['empty reviewer', { reviewers: [''] }, {}, time, 'invalid'],
    ['bad digest', { sessionDigest: 'bad' }, {}, time, 'invalid'],
    ['recomputed floor', {}, { changedPaths: ['config/demo.json'] }, time, 'needs_agent_review'],
    ['mode floor', {}, { modeChanged: true }, time, 'needs_agent_review'],
    ['intent raises floor', { risk: 'behavior' }, {}, time, 'needs_agent_review'],
  ])('%s', (_name, patch, actual, now, code) => {
    expect(admit({ receipt: { ...receipt, ...patch }, observed: { ...observed, ...actual }, now }).code).toBe(code);
  });
  it.each([
    ['docs/guide.md', 'prose', 1], ['docs/guide.md', 'unknown', 2], ['AGENTS.md', 'routine', 2],
    ['app.ts', 'unknown', 2], ['app.ts', 'behavior', 2],
    ['.nvmrc', 'routine', 2], ['scripts/documentation-routing.ts', 'routine', 2],
  ])('recomputes v2 admission for %s with %s risk and floor %i', (path, risk, floor) => {
    const candidate = { ...observed, changedPaths: [path] };
    const summary = { ...receipt, risk, reviewers: Array.from({ length: floor }, (_, index) => `reviewer-${index}`) };
    expect(admit({ receipt: summary, observed: candidate, now: time }).ok).toBe(true);
    if (floor) expect(admit({ receipt: { ...summary, reviewers: summary.reviewers.slice(1) }, observed: candidate, now: time }).ok).toBe(false);
  });
  it.each([undefined, false, true, 'true'])('uses the v2 legacy floor only with an explicit trusted legacy flag: %s', legacyRules => {
    const candidate = { ...observed, changedPaths: ['scripts/documentation-routing.ts'], legacyRules };
    expect(admit({ receipt, observed: candidate, now: time }).ok).toBe(legacyRules === true);
  });
  it.each([false, true])('checks the base rules before hosted v2 admission: legacy=%s', async legacy => {
    const f = handoffFixture(); const original = f.runGit.getMockImplementation()!;
    f.runGit.mockImplementation(async (cwd, ...args) => {
      if (args[0] === 'diff') return `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0scripts/documentation-routing.ts\0`;
      if (args[0] === 'show') return legacy ? 'export const REVIEW_RULES_VERSION = 2;\n' : 'export const REVIEW_RULES_VERSION = 3;\n';
      return original(cwd, ...args);
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      if (legacy) {
        await expect(f.execute()).resolves.toMatchObject({ status: 'enqueued' });
        expect(f.enqueue).toHaveBeenCalledTimes(1);
      } else {
        await expect(f.execute()).rejects.toThrow('Current native review is unavailable');
        expect(log).toHaveBeenCalledWith('needs_agent_review: needs_agent_review: 2 independent reviewers required by the diff');
        expect(f.enqueue).not.toHaveBeenCalled();
      }
      expect(f.runGit).toHaveBeenCalledWith(expect.any(String), 'show', `${receipt.base}:scripts/agent-review-decide.mjs`);
    } finally { log.mockRestore(); }
  });
  const facts = { reviewedTree: receipt.tree, groupTree: 'e'.repeat(40), baseAncestor: true, predictedTree: 'e'.repeat(40), changedPaths: ['source.txt'], movedPaths: ['other.ts'] };
  it.each([
    ['equal tree', { groupTree: receipt.tree, predictedTree: null }, true],
    ['disjoint paths', {}, true],
    ['unlanded base, even with equal tree', { baseAncestor: false, groupTree: receipt.tree }, false],
    ['wrong prediction', { predictedTree: 'f'.repeat(40) }, false],
    ['conflict', { predictedTree: null }, false],
    ['clean overlap', { movedPaths: ['source.txt'] }, true],
    ['ordinary check config', { movedPaths: ['vitest.config.ts'] }, true],
  ])('carry-over: %s', (_name, patch, ok) => {
    const decision = carryOver({ ...facts, ...patch }); expect(decision.ok).toBe(ok);
    if (!ok) expect(decision.reason).toContain('merge main');
  });
  // Review binds to the candidate's own change; main's moves carry over whenever the merge is clean.
  it.each([
    '.github/workflows/extra.yml', 'scripts/agent-review-decide.mjs', 'scripts/documentation-git.ts',
    'package.json', 'package-lock.json', 'packages/core/package.json', 'packages/core/package-lock.json',
    'supabase/migrations/0001_extra.sql', 'db/platform/migrations/0001_extra.sql', 'config/platform-migration-manifest.json',
  ])('carries a clean base move of %s', path => {
    expect(carryOver({ ...facts, movedPaths: [path] }).ok).toBe(true);
  });
  it.each(['not JSON', `${RECEIPT_MARKER}\n{}`, `prefix\n${body()}`, `${RECEIPT_MARKER}\n\`\`\`json\n{\n\`\`\``])('ignores malformed receipt %s', value => {
    expect(parseReceipt(value)).toBeNull();
  });
  it.each([
    ['CONTRIBUTOR', { permission: 'admin', role_name: 'admin' }, true],
    ['CONTRIBUTOR', { permission: 'write', role_name: 'write' }, true],
    ['CONTRIBUTOR', { permission: 'write', role_name: 'maintain' }, true],
    ['CONTRIBUTOR', { permission: 'maintain' }, true],
    ['CONTRIBUTOR', { role_name: 'admin' }, true],
    ['CONTRIBUTOR', { role_name: 'maintain' }, true],
    ['CONTRIBUTOR', { role_name: 'write' }, true],
    ['CONTRIBUTOR', { permission: 'write', role_name: 'custom-writer' }, true],
    ['CONTRIBUTOR', { permission: 'read' }, false],
    ['CONTRIBUTOR', { permission: 'none' }, false],
    ['CONTRIBUTOR', { permission: 'read', role_name: 'triage' }, false],
    ['OWNER', { permission: 'read', role_name: 'admin' }, false],
    ['MEMBER', { permission: 'read' }, false],
    ['COLLABORATOR', { permission: 'none' }, false],
    ['NONE', { permission: 'admin' }, true],
    ['OWNER', {}, false],
    ['OWNER', null, false],
  ])('checks repository permission for %s: %j', async (association, access, trusted) => {
    const api = { get: vi.fn(async path => path.includes('/collaborators/') ? access : [comment({ author_association: association })]) };
    const found = await readReceipts(api, '/repos/openlup/openlup', 12, receipt.head, time);
    expect(found).toHaveLength(trusted ? 1 : 0);
    expect(api.get).toHaveBeenCalledWith('/repos/openlup/openlup/collaborators/review-owner/permission');
  });
  it.each(['404', '403', 'network failure'])('refuses a failed permission lookup: %s', async message => {
    const api = { get: vi.fn(async path => {
      if (path.includes('/collaborators/')) throw new Error(message);
      return [comment()];
    }) };
    await expect(readReceipts(api, '/repos/o/r', 12, receipt.head, time)).resolves.toEqual([]);
  });
  it.each([{ login: 'review-bot[bot]', type: 'Bot' }, { login: 'ghost', type: 'Mannequin' }, { type: 'User' }, null])('refuses bots and missing user identity: %j', async user => {
    const api = { get: vi.fn(async () => [comment({ user })]) };
    await expect(readReceipts(api, '/repos/o/r', 12, receipt.head, time)).resolves.toEqual([]);
    expect(api.get).toHaveBeenCalledTimes(1);
  });
  it('paginates and chooses the newest valid matching comment, ignoring malformed and stale receipts', async () => {
    const old = comment({ id: 2 }); const newer = comment({ id: 3, body: body({ ...receipt, reviewers: ['new'] }) });
    const first = Array.from({ length: 100 }, (_, index) => comment({ id: index + 4, body: 'unrelated' }));
    first[0] = comment({ id: 105, body: body({ ...receipt, head: 'e'.repeat(40) }) });
    first[1] = comment({ id: 106, body: body({ ...receipt, verdict: 'FAIL' }) });
    first[2] = comment({ id: 107, body: body({ ...receipt, pr: 13 }) });
    const api = { get: vi.fn(async path => path.includes('/collaborators/') ? { permission: 'admin' } : path.endsWith('page=1') ? first : [old, newer]) };
    expect((await readReceipts(api, '/repos/o/r', 12, receipt.head, time)).map(item => item.reviewers)).toEqual([['new'], ['reviewer']]);
    expect(api.get).toHaveBeenCalledTimes(3);
  });
  it.each(['newer bad base', 'equal-tree group', 'live head changed', 'main moved', 'main moved in group'])('wait checks %s with fake API and Git', async scenario => {
    let clock = time; let mainReads = 0;
    const group = scenario === 'equal-tree group' || scenario === 'main moved in group'; const groupHead = 'f'.repeat(40);
    const event = { number: 12, repository: { private: false }, pull_request: { head: { sha: receipt.head } }, action: 'checks_requested', merge_group: { base_ref: 'refs/heads/main', head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${groupHead}`, base_sha: receipt.base, head_sha: groupHead } };
    const api = { get: vi.fn(async path => {
      if (path.includes('/collaborators/')) return { permission: 'admin' };
      if (path.includes('/issues/')) return scenario === 'newer bad base' ? [comment(), comment({ id: 2, body: body({ ...receipt, base: 'e'.repeat(40) }) })] : [comment()];
      if (path.includes('/pulls/')) return { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: scenario === 'live head changed' ? groupHead : receipt.head } };
      mainReads += 1;
      return { object: { sha: mainReads === 2 && (scenario === 'main moved' || scenario === 'main moved in group') ? groupHead : receipt.base } };
    }) };
    const runGit = vi.fn(async (_cwd, ...args) => {
      if (args.includes('fetch') && args.includes('e'.repeat(40))) throw new Error('unknown base');
      if (args[0] === 'rev-parse') return receipt.tree;
      if (args[0] === 'merge-base' && args[1] === '--all') return receipt.base;
      return '';
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const wait = waitNativeAdmission({ event, env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: group ? 'merge_group' : 'pull_request' }, api, runGit, now: () => clock, sleep: async ms => { clock += ms; }, deadlineMs: 15000 });
      if (scenario === 'live head changed') await expect(wait).rejects.toThrow('PR head changed');
      else if (scenario === 'main moved') await expect(wait).rejects.toThrow('main moved');
      else {
        await expect(wait).resolves.toEqual(receipt); expect(log).toHaveBeenLastCalledWith(expect.stringContaining(group ? 'unchanged tree' : 'reviewed PR head'));
        expect(runGit.mock.calls).toContainEqual([expect.any(String), '-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', receipt.base, receipt.head, ...(group ? [groupHead] : [])]);
        if (scenario === 'main moved in group') expect(mainReads).toBe(1);
      }
    } finally { log.mockRestore(); }
  });
  it.each(['read', 'lookup failure'])('refuses across wait polls, caching only a real permission: %s', async permission => {
    let clock = time;
    const api = { get: vi.fn(async path => {
      if (path.includes('/pulls/')) return { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: receipt.head } };
      if (path.includes('/collaborators/')) {
        if (permission === 'lookup failure') throw new Error('403');
        return { permission };
      }
      return [comment(), comment({ id: 2, user: { login: 'REVIEW-OWNER', type: 'User' } })];
    }) };
    const sleep = vi.fn(async ms => { clock += ms; }); const runGit = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(waitNativeAdmission({ event: { number: 12, repository: { private: false }, pull_request: { head: { sha: receipt.head } } }, env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' }, api, runGit, now: () => clock, sleep, deadlineMs: 30000 })).rejects.toThrow('bounded 3-minute receipt wait expired');
      expect(sleep.mock.calls).toEqual([[15000], [15000]]); expect(runGit).not.toHaveBeenCalled();
      const lookups = api.get.mock.calls.filter(([path]) => path.includes('/collaborators/')).length;
      // A real 'read' answer is cached; a failed lookup is retried on every poll, never trusted.
      if (permission === 'read') expect(lookups).toBe(1); else expect(lookups).toBeGreaterThanOrEqual(3);
    } finally { log.mockRestore(); }
  });
  it.each([
    ['zero comments', []],
    ['discussion comments only', [comment({ id: 1, body: 'Still reviewing this branch.' })]],
    ['stale receipt from an older head', [comment({ id: 2, body: body({ ...receipt, head: 'e'.repeat(40) }) })]],
    ['stale receipt from another PR', [comment({ id: 3, body: body({ ...receipt, pr: 13 }) })]],
    ['discussion and stale receipts', [
      comment({ id: 1, body: 'Waiting for final pass' }),
      comment({ id: 2, body: body({ ...receipt, head: 'e'.repeat(40) }) }),
      comment({ id: 3, body: body({ ...receipt, pr: 13 }) }),
    ]],
  ])('fails fast on pull_request without sleeping when no current-head receipt exists: %s', async (_label, comments) => {
    let clock = time;
    const api = { get: vi.fn(async path => {
      if (path.includes('/pulls/')) return { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: receipt.head } };
      if (path.includes('/issues/')) return comments;
      throw new Error(`unexpected read ${path}`);
    }) };
    const sleep = vi.fn(async ms => { clock += ms; }); const runGit = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(waitNativeAdmission({
        event: { number: 12, repository: { private: false }, pull_request: { head: { sha: receipt.head } } },
        env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' },
        api, runGit, now: () => clock, sleep, deadlineMs: 30000,
      })).rejects.toThrow(`needs_agent_review: no receipt comment yet for head ${receipt.head}; post a current receipt comment from a user with write, maintain or admin permission; when native-review is the only failed job of the completed run, Native Review Receipt Rerun will rerun it automatically`);
      expect(sleep).not.toHaveBeenCalled();
      expect(runGit).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('needs_agent_review: post a current receipt comment from a user with write, maintain or admin permission');
      expect(api.get.mock.calls.filter(([path]) => path.includes('/issues/'))).toHaveLength(1);
    } finally { log.mockRestore(); }
  });
  it('keeps the bounded wait on merge_group when no comments exist', async () => {
    let clock = time;
    const groupHead = 'f'.repeat(40);
    const api = { get: vi.fn(async path => {
      if (path.includes('/pulls/')) return { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: receipt.head } };
      if (path.includes('/issues/')) return [];
      throw new Error(`unexpected read ${path}`);
    }) };
    const sleep = vi.fn(async ms => { clock += ms; }); const runGit = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(waitNativeAdmission({
        event: {
          repository: { private: false }, action: 'checks_requested',
          merge_group: { base_ref: 'refs/heads/main', head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${groupHead}`, base_sha: receipt.base, head_sha: groupHead },
        },
        env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'merge_group' },
        api, runGit, now: () => clock, sleep, deadlineMs: 30000,
      })).rejects.toThrow('bounded 3-minute receipt wait expired');
      expect(sleep.mock.calls).toEqual([[15000], [15000]]);
      expect(runGit).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it.each([
    ['malformed receipt comment', [comment({ id: 42, body: `${RECEIPT_MARKER}\ninvalid` })], 'receipt comment 42'],
    ['current-head receipt failing admission', [comment({ id: 43, body: body({ ...receipt, verdict: 'FAIL' }) })], 'bounded 3-minute receipt wait expired'],
  ])('keeps the bounded wait on pull_request for %s', async (_label, comments, expectedError) => {
    let clock = time;
    const api = { get: vi.fn(async path => {
      if (path.includes('/pulls/')) return { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: receipt.head } };
      if (path.includes('/issues/')) return comments;
      throw new Error(`unexpected read ${path}`);
    }) };
    const sleep = vi.fn(async ms => { clock += ms; }); const runGit = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(waitNativeAdmission({
        event: { number: 12, repository: { private: false }, pull_request: { head: { sha: receipt.head } } },
        env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' },
        api, runGit, now: () => clock, sleep, deadlineMs: 30000,
      })).rejects.toThrow(expectedError);
      expect(sleep.mock.calls).toEqual([[15000], [15000]]);
      expect(runGit).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});

describe('carry-over adapter', () => {
  const candidate = { base: receipt.base, head: receipt.head, tree: receipt.tree, changedPaths: ['source.txt'] };
  const group = { base: 'e'.repeat(40), tree: 'f'.repeat(40) };
  // Carry-over decides from ancestry and the clean merge alone; it reads no moved paths or blobs.
  it.each([['clean merge', 'f'.repeat(40), 'reviewed'], ['different merge', 'a'.repeat(40), 'stale'], ['conflict', null, 'stale']])('%s', async (_name, merged, code) => {
    const runGit = vi.fn(async (_cwd, command) => {
      if (command === 'merge-tree') { if (merged === null) throw Object.assign(new Error('conflict'), { code: 1 }); return merged; }
      return '';
    });
    expect((await carryOverSourceReview('/fixture', candidate, group, runGit)).code).toBe(code);
    expect(runGit.mock.calls.some(([, command]) => command === 'show' || command === 'diff')).toBe(false);
  });
});

describe('migration merge-queue serialization', () => {
  function migrationHandoffFixture({
    candidate = receipt,
    changedPath = 'tests/postgres/current-installation-inventory.json',
    queueNodes = [] as { state: string; pullRequest: { number: number } }[],
    hasNextPage = false,
    queueErrors = undefined as unknown,
    mergeQueueNull = false,
    peerFiles = {} as Record<number, unknown>,
  } = {}) {
    const f = handoffFixture(candidate);
    f.comments.splice(0, f.comments.length, comment({
      body: body({ ...candidate, risk: 'behavior', reviewers: ['reviewer-a', 'reviewer-b'] }),
    }));
    f.runGit.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === 'rev-parse') return receipt.tree;
      if (args[0] === 'merge-base' && args[1] === '--all') return receipt.base;
      if (args[0] === 'diff') return `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0${changedPath}\0`;
      return '';
    });
    const baseGet = f.api.get.getMockImplementation()!;
    f.api.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/graphql?') && decodeURIComponent(path).includes('mergeQueue(')) {
        if (queueErrors) return { errors: queueErrors };
        if (mergeQueueNull) return { data: { repository: { mergeQueue: null } } };
        return { data: { repository: { mergeQueue: { entries: { pageInfo: { hasNextPage }, nodes: structuredClone(queueNodes) } } } } };
      }
      const filesMatch = /^\/repos\/openlup\/openlup\/pulls\/(\d+)\/files\?per_page=100&page=(\d+)$/u.exec(path);
      if (filesMatch) {
        const peer = Number(filesMatch[1]);
        const page = Number(filesMatch[2]);
        const all = peerFiles[peer] ?? [];
        if (!Array.isArray(all)) return structuredClone(all);
        if (all.length === 101 && page === 1 && (all[0] as { __oversized?: boolean })?.__oversized) return structuredClone(all);
        return structuredClone(all.slice((page - 1) * 100, page * 100));
      }
      return baseGet(path);
    });
    return f;
  }

  function simultaneousCompletions({ interleave = false, disjoint = false } = {}) {
    const queueNodes: { state: string; pullRequest: { number: number } }[] = [];
    const firstPaths = 'tests/postgres/current-installation-inventory.json';
    const secondPaths = 'config/platform-migration-manifest.json';
    const secondReceipt = { ...receipt, pr: 13, head: 'e'.repeat(40) };
    const peerFiles = { 12: [{ filename: firstPaths }], 13: [{ filename: secondPaths }] };
    const first = migrationHandoffFixture({ queueNodes, peerFiles, changedPath: firstPaths });
    const second = disjoint
      ? handoffFixture(secondReceipt)
      : migrationHandoffFixture({ queueNodes, peerFiles, changedPath: secondPaths, candidate: secondReceipt });
    let releaseBoth!: () => void;
    const bothReady = new Promise<void>(resolve => { releaseBoth = resolve; });
    let ready = 0;
    for (const candidate of [first, second]) {
      candidate.enqueue.mockImplementation(async () => {
        if (interleave) {
          ready += 1;
          if (ready === 2) releaseBoth();
          await bothReady;
        }
        const number = candidate.pr.number;
        const id = `QUEUE_${number}`;
        queueNodes.push({ state: 'QUEUED', pullRequest: { number } });
        candidate.queuePr.mergeQueueEntry = { id };
        return { id };
      });
    }
    return { first, second, queueNodes };
  }

  it('exposes two enqueue attempts when both completions read an empty queue', async () => {
    const { first, second } = simultaneousCompletions({ interleave: true });
    const results = await Promise.all([first.execute(), second.execute()]);
    expect(results.map(result => result.status)).toEqual(['enqueued', 'enqueued']);
    expect(first.enqueue).toHaveBeenCalledTimes(1);
    expect(second.enqueue).toHaveBeenCalledTimes(1);
  });

  it('defers the second serialized completion and preserves its intent until the lane clears', async () => {
    const { first, second, queueNodes } = simultaneousCompletions();
    await expect(first.execute()).resolves.toMatchObject({ status: 'enqueued', pr: 12 });
    await expect(second.execute()).resolves.toMatchObject({
      status: 'deferred', pr: 13, head: second.pr.head.sha, blockingPrs: [12],
    });
    expect(first.enqueue).toHaveBeenCalledTimes(1);
    expect(second.enqueue).not.toHaveBeenCalled();
    queueNodes.length = 0;
    first.queuePr.mergeQueueEntry = null;
    await expect(second.execute()).resolves.toMatchObject({ status: 'enqueued', pr: 13, head: second.pr.head.sha });
    expect(second.enqueue).toHaveBeenCalledTimes(1);
  });

  it('admits a disjoint non-migration completion while the first migration is active', async () => {
    const { first, second, queueNodes } = simultaneousCompletions({ disjoint: true });
    await expect(first.execute()).resolves.toMatchObject({ status: 'enqueued', pr: 12 });
    await expect(second.execute()).resolves.toMatchObject({ status: 'enqueued', pr: 13 });
    expect(queueNodes.map(entry => entry.pullRequest.number)).toEqual([12, 13]);
  });

  it('classifies migration-serialized paths narrowly', () => {
    for (const serialized of [
      'db/platform/migrations/20990101000000_demo.sql',
      'supabase/migrations/20990101000000_demo.sql',
      'packages/platform/sql/20990101000000_demo.sql',
      'packages/platform/sql/manifest.json',
      'config/platform-migration-manifest.json',
      'config/reviewed-platform-forwards.json',
      'tests/postgres/current-installation-inventory.json',
    ]) expect(isMigrationQueueSerializedPath(serialized), serialized).toBe(true);
    for (const ordinary of [
      'src/app.ts',
      'config/openlup-publication-catalog.json',
      'packages/core/docs/guide/reference/sql.md',
      'scripts/agent-review-queue.mjs',
    ]) expect(isMigrationQueueSerializedPath(ordinary), ordinary).toBe(false);
  });

  it.each(['QUEUED', 'AWAITING_CHECKS', 'MERGEABLE', 'LOCKED'])('defers a migration PR when a peer migration PR is %s in the merge queue', async state => {
    const f = migrationHandoffFixture({
      queueNodes: [{ state, pullRequest: { number: 77 } }],
      peerFiles: { 77: [{ filename: 'db/platform/migrations/20990101000000_other.sql' }] },
    });
    await expect(f.execute()).resolves.toEqual({
      status: 'deferred',
      pr: 12,
      head: receipt.head,
      blockingPrs: [77],
      reason: 'another migration PR is already active in the merge queue',
      remediation: expect.stringMatching(/#77[\s\S]*npm run landing:merge -- --re-slot/u),
    });
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues a migration PR when active queue peers touch only non-migration paths or are UNMERGEABLE', async () => {
    const f = migrationHandoffFixture({
      changedPath: 'config/platform-migration-manifest.json',
      queueNodes: [
        { state: 'AWAITING_CHECKS', pullRequest: { number: 77 } },
        { state: 'UNMERGEABLE', pullRequest: { number: 78 } },
      ],
      peerFiles: {
        77: [{ filename: 'src/lib/example.ts' }],
        78: [{ filename: 'db/platform/migrations/20990101000000_evicted.sql' }],
      },
    });
    await expect(f.execute()).resolves.toMatchObject({ status: 'enqueued', pr: 12 });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.api.get).not.toHaveBeenCalledWith(expect.stringContaining('/pulls/78/files'));
  });

  it('scans paginated peer PR files beyond page 1 before deciding to enqueue', async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) => ({ filename: `src/file-${index}.ts` }));
    const f = migrationHandoffFixture({
      queueNodes: [{ state: 'QUEUED', pullRequest: { number: 88 } }],
      peerFiles: { 88: [...pageOne, { filename: 'config/reviewed-platform-forwards.json' }] },
    });
    await expect(f.execute()).resolves.toMatchObject({ status: 'deferred', blockingPrs: [88] });
    expect(f.api.get).toHaveBeenCalledWith('/repos/openlup/openlup/pulls/88/files?per_page=100&page=2');
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('never inspects the merge queue for non-migration PRs', async () => {
    const f = handoffFixture();
    await expect(f.execute()).resolves.toMatchObject({ status: 'enqueued', pr: 12 });
    expect(f.api.get.mock.calls.some(([path]) => path.startsWith('/graphql?') && decodeURIComponent(path).includes('mergeQueue('))).toBe(false);
  });

  it.each([
    ['GraphQL errors', { queueErrors: [{ message: 'boom' }] }, 'merge queue inspection response is invalid'],
    ['truncated merge queue scan', { hasNextPage: true }, 'bounded serialization scan limit'],
    ['unknown queue entry state', { queueNodes: [{ state: 'MYSTERY', pullRequest: { number: 77 } }] }, 'merge queue entry identity or state is invalid'],
    ['invalid peer PR number', { queueNodes: [{ state: 'QUEUED', pullRequest: { number: 0 } }] }, 'merge queue entry identity or state is invalid'],
  ])('fails closed on %s without calling enqueue', async (_label, options, expectedError) => {
    const f = migrationHandoffFixture(options);
    await expect(f.execute()).rejects.toThrow(expectedError);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('fails closed when peer PR files exceed the bounded pagination limit', async () => {
    const huge = Array.from({ length: 3000 }, (_, index) => ({ filename: `src/f-${index}.ts` }));
    const f = migrationHandoffFixture({
      queueNodes: [{ state: 'QUEUED', pullRequest: { number: 99 } }],
      peerFiles: { 99: huge },
    });
    await expect(f.execute()).rejects.toThrow('bounded pagination limit');
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('defers when a queued peer renames a migration-serialized path to a non-migration filename', async () => {
    const f = migrationHandoffFixture({
      queueNodes: [{ state: 'QUEUED', pullRequest: { number: 77 } }],
      peerFiles: {
        77: [{ status: 'renamed', filename: 'docs/archived-helper.sql', previous_filename: 'packages/platform/sql/old_helper.sql' }],
      },
    });
    await expect(f.execute()).resolves.toEqual({
      status: 'deferred',
      pr: 12,
      head: receipt.head,
      blockingPrs: [77],
      reason: 'another migration PR is already active in the merge queue',
      remediation: expect.stringMatching(/#77[\s\S]*npm run landing:merge -- --re-slot/u),
    });
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('skips self entries and deduplicates repeated active peer PRs without redundant fetches', async () => {
    const f = migrationHandoffFixture({
      queueNodes: [
        { state: 'QUEUED', pullRequest: { number: 12 } },
        { state: 'AWAITING_CHECKS', pullRequest: { number: 77 } },
        { state: 'MERGEABLE', pullRequest: { number: 77 } },
      ],
      peerFiles: { 77: [{ filename: 'src/lib/example.ts' }] },
    });
    await expect(f.execute()).resolves.toMatchObject({ status: 'enqueued', pr: 12 });
    expect(f.api.get.mock.calls.filter(([path]) => path.includes('/pulls/12/files'))).toHaveLength(0);
    expect(f.api.get.mock.calls.filter(([path]) => path.includes('/pulls/77/files'))).toHaveLength(1);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });

  it('fails closed when repository.mergeQueue is null', async () => {
    const f = migrationHandoffFixture({ mergeQueueNull: true });
    await expect(f.execute()).rejects.toThrow('merge queue inspection response is invalid');
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['non-array batch', { message: 'not an array' }],
    ['oversized batch (>100)', Array.from({ length: 101 }, (_, index) => ({ filename: `src/f-${index}.ts`, __oversized: true }))],
    ['missing filename', [{ status: 'modified' }]],
    ['empty filename', [{ filename: '' }]],
    ['empty previous_filename', [{ status: 'renamed', filename: 'docs/a.ts', previous_filename: '' }]],
    ['non-string previous_filename', [{ status: 'renamed', filename: 'docs/a.ts', previous_filename: 42 }]],
    ['renamed entry missing previous_filename', [{ status: 'renamed', filename: 'docs/a.ts' }]],
  ])('fails closed on malformed peer files response: %s', async (_label, payload) => {
    const f = migrationHandoffFixture({
      queueNodes: [{ state: 'QUEUED', pullRequest: { number: 77 } }],
      peerFiles: { 77: payload },
    });
    await expect(f.execute()).rejects.toThrow('queued PR files response is invalid');
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});

describe('read-only exact-head queue planning', () => {
  const observedAt = Date.parse('2099-11-24T14:00:00Z');
  const issuedAt = '2099-11-24T13:00:00.000Z';
  const expiresAt = '2099-11-24T15:00:00.000Z';
  const grantId = '5c01d021-405e-4beb-80fc-e78bc65cfa28';
  const repositoryId = 1376035358;
  const baseRef = 'refs/heads/main';

  function fixture() {
    type Entry = { id: string; pr: number; head: string; state: string; position: number };
    type Timeline = { id: number; type: string; head: string; commentId?: number; at?: string };
    const main = { repositoryId, repository: 'openlup/openlup', ref: baseRef, sha: 'a'.repeat(40), workflowId: 42 };
    const pulls = [3, 2, 1].map(number => ({
      number, head: String(number).repeat(40), nodeId: `PR_${number}`, repositoryId, baseRef, state: 'open',
      sourceRepositoryId: number === 3 ? 202 : repositoryId, sourceBranch: `branch-${number}`,
      armed: false, draft: false, commandHistoryComplete: true,
    }));
    const first = pulls[2]; const second = pulls[1]; const disjoint = pulls[0];
    type Pull = typeof first;
    const commands = new Map(pulls.map(pr => [pr.number, [command(pr, pr.number, 'request', pr.number)]]));
    function command(pr: Pull, number: number, verb: string, minute: number, grant?: string) {
      const createdAt = `2099-11-24T13:${String(minute).padStart(2, '0')}:00Z`;
      return { id: number, body: `/openlup-queue ${verb} ${pr.head}${grant ? ` ${grant}` : ''}`,
        repositoryId, pr: pr.number, association: 'MEMBER', author: { type: 'User', id: pr.number, login: `author-${pr.number}` },
        createdAt, updatedAt: createdAt, edited: false as boolean | undefined, minimized: false };
    }
    const files = new Map(pulls.map(pr => [pr.number, [{
      filename: pr.number === 3 ? 'unrelated.txt' : `db/platform/migrations/2099112610000${pr.number}_example.sql`,
      head: pr.head, status: 'added', previousFilename: undefined as string | undefined,
    }]]));
    const runs = new Map(pulls.map(pr => [pr.number, { id: pr.number, workflow_id: 42, run_attempt: 1,
      event: 'pull_request', path: '.github/workflows/published-tree-ci.yml', repository: { id: repositoryId },
      head_sha: pr.head, head_branch: pr.sourceBranch, head_repository: { id: pr.sourceRepositoryId },
      status: 'completed', conclusion: 'success',
    }]));
    const jobs = new Map(pulls.map(pr => [pr.number, [...REQUIRED_CONTEXTS, 'native-review'].map((name, index) => ({
      id: 100 + index, name, run_id: pr.number, run_attempt: 1, head_sha: pr.head, status: 'completed', conclusion: 'success',
    }))]));
    const entries: Entry[] = [];
    const grants: { grantId: string; appId: number; envelope: string; state: string; occupancy: string }[] = [];
    const finalization = new Map<number, { requiresGrant: boolean; status: string; grantId?: string; orderingDigest?: string; moves?: object[] }>();
    const history = new Map<number, Timeline[]>();
    const proposedMove = {
      sourcePath: 'db/platform/migrations/20991126100001_example.sql', sourceVersion: '20991126100001',
      targetPath: 'db/platform/migrations/20991126100001_example.sql', targetVersion: '20991126100001',
      blobOid: 'e'.repeat(40), mode: '100644',
    };
    const grant = ({ state = 'active', occupancy = 'none', expires = expiresAt } = {}) => ({
      grantId, appId: 7, state, occupancy,
      envelope: JSON.stringify({
        schemaVersion: 1, grantId, prNumber: first.number, prNodeId: first.nodeId, draftHead: 'b'.repeat(40),
        baseRef, repositoryId, observedMain: main.sha, orderingDigest: 'c'.repeat(64),
        issuedAt, expiresAt: expires, moves: [proposedMove],
      }),
    });
    const page = <T>(items: T[]) => ({ items: structuredClone(items), next: null as string | null, count: items.length });
    const adapter = {
      main: vi.fn(() => structuredClone(main)),
      queue: vi.fn((_main: unknown, _cursor: string | null) => page(entries)),
      grants: vi.fn(() => page(grants)),
      pulls: vi.fn(() => page(pulls)),
      comments: vi.fn((pr: Pull) => page(commands.get(pr.number) ?? [])),
      timeline: vi.fn((pr: Pull) => page(history.get(pr.number) ?? [])),
      permission: vi.fn((actor: { id: number }) => ({ userId: actor.id, permission: 'write' })),
      files: vi.fn((pr: Pull) => page((files.get(pr.number) ?? []).map(file => {
        const { previousFilename, ...entry } = file;
        return previousFilename ? { ...entry, previousFilename } : entry;
      }))),
      sourceRuns: vi.fn((pr: Pull) => page([runs.get(pr.number)!])),
      sourceJobs: vi.fn((run: { id: number }) => page(jobs.get(run.id)!)),
      review: vi.fn((pr: Pull, current: typeof main) => ({
        review: { status: 'verified', head: pr.head, main: current.sha, receiptId: `receipt-${pr.number}` },
        integration: { status: 'clean', head: pr.head, main: current.sha, tree: 'd'.repeat(40) },
      })),
      finalization: vi.fn((pr: Pull, current: typeof main) => ({
        head: pr.head, main: current.sha, ...(finalization.get(pr.number) ?? { requiresGrant: false, status: 'not_required' }),
      })),
    };
    const execute = () => observeQueueAdmission({ adapter, observedAt, appId: 7 });
    return { main, first, second, disjoint, commands, command, files, runs, jobs, entries, grants, history, grant, proposedMove, finalization, adapter, execute };
  }

  it.each([
    '/openlup-queue request SHA\n\n', '/openlup-queue  request SHA', 'x\n/openlup-queue request SHA',
    '/openlup-queue request SHA\r\n', '/openlup-queue request SHA ', '/openlup-queue reserve SHA GRANT',
    '/openlup-queue cancel SHA GRANT', '/openlup-queue request SHA 5c01d021-405e-5beb-80fc-e78bc65cfa28',
    '/openlup-queue request SHA 5C01D021-405E-4BEB-80FC-E78BC65CFA28',
  ])('rejects noncanonical command %j', example => {
    expect(parseQueueCommand(example.replace('SHA', receipt.head).replace('GRANT', grantId))).toBeNull();
  });

  it('accepts an exact request, cancel, reserve, and migration grant', () => {
    for (const verb of ['request', 'cancel', 'reserve']) {
      expect(parseQueueCommand(`/openlup-queue ${verb} ${receipt.head}\n`)).toMatchObject({ verb, head: receipt.head });
    }
    expect(parseQueueCommand(`/openlup-queue request ${receipt.head} ${grantId}`)).toMatchObject({ grantId });
  });

  it('replays immediate, duplicate and skipped wakes without write capability and preserves request order', async () => {
    vi.stubEnv('OPENLUP_NATIVE_QUEUE', 'enabled');
    try {
      const f = fixture();
      f.commands.get(1)!.push(f.command(f.first, 10, 'request', 10));
      const observed = await f.execute();
      expect(observed).toMatchObject({ status: 'observed',
        proposed: [{ pr: 1, status: 'proposal', commandId: 1 }, { pr: 3, status: 'proposal' }],
        held: [{ pr: 2, reason: 'migration_reserved', blockingPrs: [1] }],
      });
      expect(await f.execute()).toEqual(observed);
      f.entries.push({ id: 'entry-1', pr: 1, head: f.first.head, state: 'LOCKED', position: 1 });
      expect((await f.execute()).proposed.map(row => row.pr)).toEqual([3]);
      f.entries.length = 0;
      f.commands.delete(1);
      expect((await f.execute()).proposed.map(row => row.pr)).toEqual([2, 3]);
      expect(JSON.stringify(observed)).not.toContain('/openlup-queue');
      expect(f.adapter).not.toHaveProperty('enqueue');
      expect(f.adapter).not.toHaveProperty('token');
    } finally { vi.unstubAllEnvs(); }
  });

  it('keeps a finalized head and grant across disjoint main advancement', async () => {
    const f = fixture();
    const grant = f.grant();
    f.grants.push(grant);
    f.commands.set(1, [f.command(f.first, 1, 'request', 1, grant.grantId)]);
    f.finalization.set(1, { requiresGrant: true, status: 'verified', grantId: grant.grantId, orderingDigest: 'c'.repeat(64), moves: [f.proposedMove] });
    const before = await f.execute();
    f.main.sha = 'b'.repeat(40);
    await expect(f.execute()).resolves.toEqual({ ...before, main: f.main.sha });
    expect(before.proposed[0]).toMatchObject({ pr: 1, head: f.first.head, grantId });
  });

  it('keeps the lane occupied after a grant expires with ambiguous release', async () => {
    const f = fixture();
    f.grants.push(f.grant({ state: 'expired', occupancy: 'unknown', expires: '2099-11-24T13:30:00.000Z' }));
    expect((await f.execute()).proposed.map(row => row.pr)).toEqual([3]);
    expect((await f.execute()).held).toEqual(expect.arrayContaining([expect.objectContaining({ pr: 2, reason: 'migration_reserved', blockingPrs: [1] })]));
    f.grants[0].occupancy = 'released';
    expect((await f.execute()).proposed.map(row => row.pr)).toEqual([1, 3]);
  });

  it('checks the next queue page and both sides of renames, then refuses a missing page', async () => {
    const f = fixture();
    const firstHead = 'e'.repeat(40); const secondHead = 'f'.repeat(40);
    f.entries.push({ id: 'queue-1', pr: 4, head: firstHead, state: 'QUEUED', position: 1 },
      { id: 'queue-2', pr: 5, head: secondHead, state: 'QUEUED', position: 2 });
    f.files.set(4, [{ filename: 'other.txt', status: 'modified', head: firstHead, previousFilename: undefined }]);
    f.files.set(5, [{ filename: 'new.txt', status: 'renamed', head: secondHead, previousFilename: 'unrelated.txt' }]);
    f.adapter.queue.mockImplementation((_main, cursor) => cursor
      ? { items: [f.entries[1]], next: null, count: 2 }
      : { items: [f.entries[0]], next: 'cursor-2', count: 2 });
    expect((await f.execute()).held).toEqual(expect.arrayContaining([expect.objectContaining({ pr: 3, reason: 'overlapping_paths', blockingPrs: [5] })]));
    f.adapter.queue.mockImplementation((_main, cursor) => cursor
      ? { items: [], next: null, count: 2 }
      : { items: [f.entries[0]], next: 'cursor-2', count: 2 });
    await expect(f.execute()).resolves.toMatchObject({ status: 'held', proposed: [], reason: 'evidence_unknown' });
  });

  it('holds failed latest check attempts and accepts an exact fork source', async () => {
    const f = fixture();
    f.runs.get(1)!.run_attempt = 2;
    const old = f.jobs.get(1)![0];
    f.jobs.get(1)!.push({ ...old, id: 999, run_attempt: 2, conclusion: 'failure' });
    expect((await f.execute()).proposed.map(row => row.pr)).toEqual([2, 3]);
    expect((await f.execute()).held).toEqual([
      expect.objectContaining({ pr: 1, reason: 'operator_diagnosis', checks: [old.name] }),
    ]);
    f.runs.get(3)!.head_repository.id = 303;
    expect((await f.execute()).proposed.map(row => row.pr)).toEqual([2]);
  });

  it('checks reserve intent separately and never lets malformed newer evidence recover an older success', async () => {
    const f = fixture();
    f.commands.get(1)!.push(f.command(f.first, 10, 'reserve', 10));
    const latest = { ...f.runs.get(2)!, id: 42, workflow_id: 999 };
    f.adapter.sourceRuns.mockImplementation(pr => ({
      items: [f.runs.get(pr.number)!, ...(pr.number === 2 ? [latest] : [])],
      next: null, count: pr.number === 2 ? 2 : 1,
    }));
    expect((await f.execute()).held).toEqual([
      expect.objectContaining({ pr: 1, reason: 'reserve_requested', commandId: 10 }),
      expect.objectContaining({ pr: 2, reason: 'evidence_unknown' }),
    ]);
  });

  it.each(['permission', 'edited', 'deleted', 'pushed', 'missing-history', 'unrequested'])('holds %s exact-head authority', async action => {
    const f = fixture();
    if (action === 'permission') f.adapter.permission.mockImplementation(actor => ({ userId: actor.id === 1 ? 77 : actor.id, permission: actor.id === 1 ? 'read' : 'write' }));
    if (action === 'edited') f.commands.get(1)!.push({ ...f.command(f.first, 10, 'cancel', 10), edited: undefined });
    if (action === 'deleted') f.history.set(1, [{ id: 10, type: 'command_deleted', commentId: 15, head: f.first.head, at: '2099-11-24T13:10:00Z' }]);
    if (action === 'pushed') f.first.head = 'e'.repeat(40);
    if (action === 'missing-history') f.first.commandHistoryComplete = false;
    if (action === 'unrequested') f.commands.delete(1);
    expect((await f.execute()).proposed.map(row => row.pr)).toEqual([2, 3]);
    expect((await f.execute()).held).toEqual([expect.objectContaining({
      pr: 1, reason: ['pushed', 'unrequested'].includes(action) ? 'request_required' : 'evidence_unknown',
    })]);
  });

  it('holds overlapping native arming and identifies same-head terminal queue history', async () => {
    const f = fixture();
    f.first.armed = true;
    f.history.set(3, [{ id: 77, type: 'queue_manual_removal', head: f.disjoint.head }]);
    expect((await f.execute()).held).toEqual([
      expect.objectContaining({ pr: 1, reason: 'already_armed' }),
      expect.objectContaining({ pr: 2, reason: 'migration_reserved', blockingPrs: [1] }),
      expect.objectContaining({ pr: 3, reason: 'operator_diagnosis', history: ['queue_manual_removal'] }),
    ]);
  });

  it('retries a transient read once and discards changed reconciliation inputs', async () => {
    const f = fixture();
    f.adapter.queue.mockImplementationOnce(() => { throw Object.assign(new Error('temporary'), { transient: true }); });
    expect((await f.execute()).status).toBe('observed');
    expect(f.adapter.queue).toHaveBeenCalledTimes(3);
    f.adapter.main.mockImplementationOnce(() => ({ ...f.main, sha: 'b'.repeat(40) }));
    await expect(f.execute()).resolves.toMatchObject({ status: 'held', proposed: [], reason: 'evidence_unknown' });
  });

  it('holds when main changes after the second sweep has started reading candidates', async () => {
    const f = fixture();
    const review = f.adapter.review.getMockImplementation()!;
    f.adapter.review.mockImplementation((pr, current) => {
      if (f.adapter.main.mock.calls.length === 2) f.main.sha = 'b'.repeat(40);
      return review(pr, current);
    });
    await expect(f.execute()).resolves.toMatchObject({ status: 'held', proposed: [], reason: 'evidence_unknown' });
    expect(f.adapter.main).toHaveBeenCalledTimes(3);
  });

  it('reuses native review and merge preflight without fetching or updating refs', async () => {
    const f = handoffFixture();
    const reviewGit = f.runGit.getMockImplementation()!;
    f.runGit.mockImplementation(async (cwd, ...args) => {
      if (['fetch', 'update-ref'].includes(args[0])) throw new Error('observer cannot update object sources');
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return '';
      if (args[0] === 'merge-tree') return receipt.tree;
      return reviewGit(cwd, ...args);
    });
    await expect(verifyQueueReview({
      api: f.api, cwd: process.cwd(), pr: { number: receipt.pr, head: receipt.head },
      main: { sha: receipt.base }, observedAt: f.clock, runGit: f.runGit, readComments: async () => f.comments,
    })).resolves.toMatchObject({
      review: { status: 'verified', head: receipt.head, receiptId: '1' },
      integration: { status: 'clean', main: receipt.base, tree: receipt.tree },
    });
  });

  it('classifies an ordinary new SQL file from committed objects before it can ask for finalization evidence', async () => {
    const f = fixture();
    const cwd = mkdtempSync(join(tmpdir(), 'openlup-queue-local-read-'));
    const git = (...args: string[]) => execFileSync('git', [
      '-C', cwd, '-c', 'user.name=Queue Fixture', '-c', 'user.email=queue@example.invalid',
      '-c', 'commit.gpgsign=false', ...args,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const put = (path: string, bytes: string) => {
      const destination = join(cwd, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    };
    try {
      git('init', '-q');
      put('config/reviewed-platform-forwards.json', '{}');
      git('add', '.');
      git('commit', '-qm', 'Base');
      const base = git('rev-parse', 'HEAD');
      put('db/platform/migrations/20991126100001_example.sql', 'select 1;\n');
      git('add', '.');
      git('commit', '-qm', 'Add forward');
      const head = git('rev-parse', 'HEAD');
      const grant = { grantId: 'grant-1' };
      const source = { ...f.adapter, finalizationRecord: vi.fn(() => ({ grantId: grant.grantId, head, base })) };
      const adapter = createLocalQueueReadAdapter({ reads: source, cwd });
      await expect(adapter.finalization({ head }, { sha: base }, undefined, observedAt, undefined))
        .resolves.toEqual({ head, main: base, requiresGrant: true });
      expect(source.finalizationRecord).not.toHaveBeenCalled();
      await expect(adapter.finalization({ head }, { sha: base }, grant, observedAt, undefined))
        .resolves.toEqual({ head, main: base, requiresGrant: true });
      expect(source.finalizationRecord).toHaveBeenCalledOnce();
      expect(git('status', '--porcelain')).toBe('');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

function armFixture() {
  const number = 38;
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const group = 'c'.repeat(40);
  const olderHead = 'd'.repeat(40);
  const repository = { id: 1376035358, private: false };
  const pr = { id: 'PR_38', number, state: 'OPEN', isDraft: false, merged: false, baseRefName: 'main',
    headRefOid: head, mergeable: 'MERGEABLE', autoMergeRequest: null, mergeQueueEntry: null,
    title: 'Prepare release notes', body: 'Summary\n\nSigned-off-by: Example Maintainer <maintainer@example.com>' };
  const removal = { __typename: 'RemovedFromMergeQueueEvent', id: 'R_1', createdAt: '2099-11-20T10:00:00Z',
    reason: 'failed_checks', beforeCommit: { oid: group, signature: { isValid: true, wasSignedByGitHub: true } } };
  const f = {
    pr, removals: [] as typeof removal[], historyComplete: true, groupParent: head, groupVerified: true, mergeMethod: 'MERGE',
    run: { id: 1001, run_attempt: 2, event: 'merge_group', path: '.github/workflows/published-tree-ci.yml',
      workflow_id: 361484090, repository, head_sha: group, head_branch: `gh-readonly-queue/main/pr-${number}-${base}`,
      status: 'completed', conclusion: 'success', run_started_at: '2099-11-20T10:10:00Z' },
    jobs: [...REQUIRED_CONTEXTS, 'native-review'].map((name, index) => ({ name, id: index + 1, run_id: 1001,
      run_attempt: 2, head_sha: group, status: 'completed', conclusion: 'success' })),
    main: base, migration: false, peer: false, onLive: (_readCount: number) => {},
  };
  let liveReads = 0;
  const read = vi.fn(async (args: string[]) => {
    const path = args.at(-1) ?? '';
    if (args[0] === 'graphql') {
      let evidence;
      if (path.includes('timelineItems')) {
        evidence = { pullRequest: { number, baseRefName: 'main', timelineItems: {
          totalCount: f.removals.length, nodes: f.removals, pageInfo: { hasPreviousPage: !f.historyComplete },
        } } };
      } else if (path.includes('entries(first:')) {
        evidence = { mergeQueue: { entries: { pageInfo: { hasNextPage: false },
          nodes: f.peer ? [{ state: 'QUEUED', pullRequest: { number: 39 } }] : [] } } };
      } else {
        f.onLive(++liveReads);
        evidence = { isPrivate: false, mergeCommitTitle: 'PR_TITLE', mergeCommitMessage: 'PR_BODY',
          mergeQueue: { configuration: { mergeMethod: f.mergeMethod } }, ref: { target: { oid: f.main } }, pullRequest: f.pr };
      }
      return structuredClone({ data: { repository: { nameWithOwner: 'openlup/openlup', databaseId: repository.id, ...evidence } } });
    }
    if (path.includes('/files?')) return [{ filename: path.includes('/39/') || f.migration
      ? 'db/platform/migrations/new.sql' : 'scripts/ordinary.mjs', status: 'modified' }];
    if (path.includes('/commits/')) return { sha: path.split('/').at(-1), parents: [{ sha: base }, { sha: f.groupParent }],
      commit: { message: `${f.pr.title} (#${number})\n\n${f.pr.body}`, verification: { verified: f.groupVerified } } };
    if (path.includes('/jobs?')) return structuredClone([{ total_count: f.jobs.length, jobs: f.jobs }]);
    if (path.includes('/runs?')) return structuredClone({ total_count: 1, workflow_runs: [f.run] });
    if (path.includes('/attempts/')) return structuredClone(f.run);
    throw new Error('unexpected read');
  });
  return { f, head, removal, olderHead, read, check: (expected = head) => checkQueueArm({ number, head: expected, read }) };
}

describe('manual queue arm preflight', () => {
  it('accepts a first exact-head arm only with a synthetic DCO trailer', async () => {
    const { check, f } = armFixture();
    await expect(check()).resolves.toMatchObject({ status: 'ready', reason: 'preflight_passed' });
    f.pr.body = 'Approval received';
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'missing_synthetic_dco' });
    f.pr.title = 'Signed-off-by: Example Maintainer <maintainer@example.com>';
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'missing_synthetic_dco' });
  });

  it.each(['failed_checks', 'checks_timed_out'])('requires a passing, exact later rerun after %s', async reason => {
    const { check, f, head, removal } = armFixture();
    f.removals = [{ ...removal, reason }];
    f.run.run_attempt = 1;
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'operator_diagnosis' });
    f.run.run_attempt = 2;
    f.run.run_started_at = '2099-11-20T09:50:00Z';
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'operator_diagnosis' });
    f.run.run_started_at = 'unavailable';
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'evidence_unknown' });
    f.run.run_started_at = '2099-11-20T10:10:00Z';
    f.jobs[0].conclusion = 'failure';
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'operator_diagnosis' });
    f.jobs[0].conclusion = 'success';
    f.run.head_sha = head;
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'evidence_unknown' });
    f.run.head_sha = removal.beforeCommit.oid;
    await expect(check()).resolves.toMatchObject({ status: 'ready', retest: { group: removal.beforeCommit.oid, runId: 1001, attempt: 2 } });
  });

  it('holds a second same-head removal before looking for a passing retest', async () => {
    const { check, f, read, removal } = armFixture();
    f.removals = [removal, { ...removal, id: 'R_2', reason: 'roll_back', beforeCommit: { oid: 'e'.repeat(40), signature: removal.beforeCommit.signature } }];
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'repeated_same_head_removal' });
    expect(read.mock.calls.some(([args]) => args.some(path => path.includes('/actions/')))).toBe(false);
  });

  it('skips a conflict removal without a group commit but keeps every other removal check', async () => {
    const { check, f, read, removal } = armFixture();
    const conflict = { ...removal, id: 'R_C', reason: 'MERGE_CONFLICT', beforeCommit: null };
    f.removals = [conflict, { ...conflict, id: 'R_C2', reason: 'merge_conflict' }];
    await expect(check()).resolves.toMatchObject({ status: 'ready', reason: 'preflight_passed' });
    expect(read.mock.calls.some(([args]) => args.some(path => path.includes('/commits/')))).toBe(false);
    f.removals = [{ ...conflict, reason: 'failed_checks' }];
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'evidence_unknown',
      detail: expect.stringContaining('queue removal lacks a synthetic commit or reason') });
    f.removals = [{ ...removal, reason: 'merge_conflict' }];
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'operator_diagnosis',
      removal: 'merge_conflict', group: removal.beforeCommit.oid });
    f.groupVerified = false;
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'evidence_unknown',
      detail: expect.stringContaining('queue removal cannot be linked to an exact source head') });
  });

  it('distinguishes a prior exact source head from the current head', async () => {
    const { check, f, olderHead, removal } = armFixture();
    f.groupParent = olderHead;
    f.removals = [removal];
    await expect(check()).resolves.toMatchObject({ status: 'ready' });
    f.groupVerified = false;
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'evidence_unknown' });
  });

  it('refuses a REST-verified removal commit without a valid GitHub signature', async () => {
    const { check, f, removal } = armFixture();
    removal.beforeCommit.signature.wasSignedByGitHub = false;
    f.removals = [removal];
    expect(f.groupVerified).toBe(true);
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'evidence_unknown',
      detail: expect.stringContaining('queue removal commit lacks a valid GitHub signature') });
  });

  it('holds if a successful required job identity changes between retest reads', async () => {
    const { check, f, removal } = armFixture();
    f.removals = [removal];
    f.onLive = reads => { if (reads === 2) f.jobs[0].id = 9001; };
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'evidence_unknown' });
  });

  it('defers migration overlap but lets ordinary candidates pass', async () => {
    const { check, f } = armFixture();
    f.peer = true;
    await expect(check()).resolves.toMatchObject({ status: 'ready' });
    f.migration = true;
    await expect(check()).resolves.toMatchObject({ status: 'deferred', reason: 'migration_peer_active', blockingPrs: [39] });
    f.peer = false;
    await expect(check()).resolves.toMatchObject({ status: 'ready' });
  });

  it('fails closed on incomplete history, an unexpected queue strategy and a changed head', async () => {
    const { check, f, olderHead } = armFixture();
    f.historyComplete = false;
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'evidence_unknown' });
    f.historyComplete = true;
    f.mergeMethod = 'SQUASH';
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'evidence_unknown' });
    f.mergeMethod = 'MERGE';
    await expect(check(olderHead)).resolves.toMatchObject({ status: 'held', reason: 'evidence_unknown' });
  });

  it('refuses a metadata change during a ready observation even if the head stays current', async () => {
    const { check, f } = armFixture();
    f.onLive = reads => { if (reads === 3) f.pr.body += '\nUpdated copy'; };
    await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'evidence_unknown' });
  });
});

it('holds when main moves during an otherwise unchanged arm preflight', async () => {
  const { check, f } = armFixture();
  f.onLive = reads => { if (reads === 2) f.main = 'e'.repeat(40); };
  await expect(check()).resolves.toMatchObject({ status: 'held', reason: 'evidence_unknown' });
});

describe('queue hygiene helpers (toolchain probe, CLI error reporting, 5xx retry, comment pagination)', () => {
  it('paginates PR receipt comments with per_page=50', async () => {
    const page1 = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, body: 'ordinary comment', user: { login: 'u', type: 'User' }, created_at: '2026-10-19T00:00:00Z' }));
    const page2 = [comment({ id: 51 })];
    const api = {
      get: vi.fn(async (path: string) => {
        if (path === '/repos/openlup/openlup/issues/12/comments?per_page=50&page=1') return page1;
        if (path === '/repos/openlup/openlup/issues/12/comments?per_page=50&page=2') return page2;
        if (path.includes('/collaborators/')) return { permission: 'write' };
        throw new Error(`unexpected read ${path}`);
      }),
    };
    const receipts = await readReceipts(api, '/repos/openlup/openlup', 12, receipt.head, time);
    expect(receipts).toEqual([receipt]);
    expect(api.get).toHaveBeenCalledWith('/repos/openlup/openlup/issues/12/comments?per_page=50&page=1');
    expect(api.get).toHaveBeenCalledWith('/repos/openlup/openlup/issues/12/comments?per_page=50&page=2');
  });

  it('retries transient HTTP 5xx reads with exponential backoff and never retries 4xx', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('gh failed'), { stderr: 'gh: Service Unavailable (HTTP 503)' });
      return { stdout: '{"ok":true}' };
    });
    const api = createGitHubReadApi({ exec, sleep: async ms => { sleeps.push(ms); }, maxAttempts: 3, baseDelayMs: 250 });
    await expect(api.get('/repos/openlup/openlup/pulls/12')).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([250, 500]);

    const sleeps4xx: number[] = [];
    const exec4xx = vi.fn(async () => {
      throw Object.assign(new Error('gh failed'), { stderr: 'gh: Not Found (HTTP 404)' });
    });
    const api4xx = createGitHubReadApi({ exec: exec4xx, sleep: async ms => { sleeps4xx.push(ms); }, maxAttempts: 3, baseDelayMs: 250 });
    await expect(api4xx.get('/repos/openlup/openlup/pulls/999')).rejects.toThrow('gh failed');
    expect(exec4xx).toHaveBeenCalledTimes(1);
    expect(sleeps4xx).toEqual([]);
  });

  it('probes whether native-review needs npm ci and writes GITHUB_OUTPUT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openlup-probe-toolchain-'));
    try {
      const outputPath = join(dir, 'github-output.txt');
      const v3Receipt = (proof?: { kind: string; derived?: boolean }) => {
        const rules = { version: 3, base: digest([]), head: digest([]) };
        const base1 = '1'.repeat(40);
        const head1 = '2'.repeat(40);
        const tree1 = '3'.repeat(40);
        const intent = { risk: 'routine', criteria: 'Probe test' };
        const firstCandidate = {
          base: proof ? base1 : receipt.base,
          head: proof ? head1 : receipt.head,
          tree: proof ? tree1 : receipt.tree,
          changedPaths: observed.changedPaths,
          modeChanged: false,
          clean: true,
          rules,
        };
        const prepared = prepareCandidate(null, { ...firstCandidate, authorSessionId: 'author', intent }, time);
        const completed = recordReport(prepared, { cold: true, tree: firstCandidate.tree, verdict: 'PASS', documentation: 'Checked.', findings: [], closes: [], reviewer: 'reviewer-1' }, time);
        if (!proof) return receiptBody(receiptSummary(completed, receipt.pr, time));
        const integrated = prepareCandidate(completed, {
          base: receipt.base,
          head: receipt.head,
          tree: receipt.tree,
          changedPaths: observed.changedPaths,
          modeChanged: false,
          clean: true,
          rules,
          authorSessionId: 'author',
          intent,
          integration: { base: base1, head: head1, tree: tree1, expires: time + 86400000, mechanical: false },
          coverage: {
            kind: 'integration',
            previous: digest(completed.history),
            from: { base: base1, head: head1, tree: tree1 },
            proof: { ...proof, tree: receipt.tree },
          },
        }, time);
        return receiptBody(receiptSummary(integrated, receipt.pr, time));
      };
      const makeApi = (comments: unknown[], { fail = false, failPermission = false, permission = 'write' } = {}) => ({
        get: vi.fn(async (path: string) => {
          if (fail) throw new Error('network error');
          if (path.includes('/pulls/')) return { number: 12, head: { sha: receipt.head } };
          if (path.includes('/issues/')) return comments;
          if (path.includes('/collaborators/')) {
            if (failPermission) throw new Error('permission lookup HTTP 503');
            return { permission };
          }
          throw new Error(`unexpected ${path}`);
        }),
      });
      const prEvent = { number: 12, repository: { private: false } };
      const prEnv = { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request', GITHUB_OUTPUT: outputPath };
      const prEnvNoOut = { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' };
      const mgEvent = { repository: { private: false }, merge_group: { head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${receipt.head}` } };
      const mgEnv = { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'merge_group' };

      // Truly unreceipted pull_request fast-fails without polling -> false
      await expect(probeToolchainNeeded({ event: prEvent, env: prEnv, api: makeApi([]), now: () => time })).resolves.toBe(false);
      // Clean non-derived v3 receipt -> false
      await expect(probeToolchainNeeded({ event: prEvent, env: prEnvNoOut, api: makeApi([comment({ body: v3Receipt() })]), now: () => time })).resolves.toBe(false);
      // Derived flag or derived/portable-derived proof kinds -> true
      await expect(probeToolchainNeeded({ event: prEvent, env: prEnv, api: makeApi([comment({ body: v3Receipt({ kind: 'resolution', derived: true }) })]), now: () => time })).resolves.toBe(true);
      await expect(probeToolchainNeeded({ event: prEvent, env: prEnvNoOut, api: makeApi([comment({ body: v3Receipt({ kind: 'derived' }) })]), now: () => time })).resolves.toBe(true);
      await expect(probeToolchainNeeded({ event: prEvent, env: prEnvNoOut, api: makeApi([comment({ body: v3Receipt({ kind: 'portable-derived' }) })]), now: () => time })).resolves.toBe(true);
      // merge_group with no receipts polls -> true
      await expect(probeToolchainNeeded({ event: mgEvent, env: mgEnv, api: makeApi([]), now: () => time })).resolves.toBe(true);
      // invalidComments (malformed receipt marker) polls -> true
      await expect(probeToolchainNeeded({ event: prEvent, env: prEnvNoOut, api: makeApi([comment({ body: `${ECONOMY_RECEIPT_MARKER}\nnot-a-fence` })]), now: () => time })).resolves.toBe(true);
      // currentHeadComments without an admitted receipt (FAIL verdict or non-write author) polls -> true
      await expect(probeToolchainNeeded({ event: prEvent, env: prEnvNoOut, api: makeApi([comment({ body: body({ ...receipt, verdict: 'FAIL' }) })]), now: () => time })).resolves.toBe(true);
      await expect(probeToolchainNeeded({ event: prEvent, env: prEnvNoOut, api: makeApi([comment({ body: v3Receipt() })], { permission: 'read' }), now: () => time })).resolves.toBe(true);
      // Permission lookup error fails safe -> true
      await expect(probeToolchainNeeded({ event: prEvent, env: prEnvNoOut, api: makeApi([comment({ body: v3Receipt() })], { failPermission: true }), now: () => time })).resolves.toBe(true);
      // Unexpected API error fails safe -> true
      await expect(probeToolchainNeeded({ event: prEvent, env: prEnvNoOut, api: makeApi([], { fail: true }), now: () => time })).resolves.toBe(true);
      expect(readFileSync(outputPath, 'utf8')).toBe('needs_install=false\nneeds_install=true\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports awaiting_receipt errors with exit code 78, notice, and step summary, and other errors with exit code 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openlup-cli-error-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const summaryPath = join(dir, 'summary.md');
      const awaiting = Object.assign(new Error('needs_agent_review: no receipt comment yet'), { code: 'awaiting_receipt', pr: 12, head: receipt.head });
      await expect(reportQueueCliError(awaiting, { GITHUB_STEP_SUMMARY: summaryPath })).resolves.toBe(EXIT_AWAITING_RECEIPT);
      expect(EXIT_AWAITING_RECEIPT).toBe(78);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('::notice title=Awaiting review receipt::'));
      expect(err).toHaveBeenCalledWith('needs_agent_review: no receipt comment yet');
      expect(readFileSync(summaryPath, 'utf8')).toContain(`PR #12 (\`${receipt.head}\`)`);

      log.mockClear();
      err.mockClear();
      await expect(reportQueueCliError(new Error('unexpected failure'), { GITHUB_STEP_SUMMARY: summaryPath })).resolves.toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledWith('unexpected failure');
    } finally {
      log.mockRestore();
      err.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
