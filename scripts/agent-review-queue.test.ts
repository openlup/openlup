import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { admit, carryOver, COMPRESSED_RECEIPT_MARKER, digest, ECONOMY_RECEIPT_MARKER, prepareCandidate, receiptBody, RECEIPT_DETAILS_HEADER, RECEIPT_MARKER, receiptSummary, recordReport } from './agent-review-decide.mjs';
import { carryOverSourceReview, diagnoseReceipt, enqueueAfterChecks, parseReceipt, readReceipts, waitNativeAdmission } from './agent-review-queue.mjs';
import { REQUIRED_CONTEXTS } from './packages/release-gate.ts';

const time = 1000;
const receipt = { pr: 12, base: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40), risk: 'routine', reviewers: ['reviewer'], verdict: 'PASS', expires: time + 86400000, sessionDigest: 'd'.repeat(64) };
const observed = { ...receipt, baseValid: true, changedPaths: ['source.txt'] };
const body = (value = receipt) => `${RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const comment = (patch = {}) => ({ id: 1, body: body(), author_association: 'OWNER', user: { login: 'review-owner', type: 'User' }, created_at: '2026-10-19T00:00:00Z', ...patch });

function handoffFixture() {
  const repository = { id: 1376035358, full_name: 'openlup/openlup', private: false, owner: { login: 'openlup' } };
  const run = { id: 100, workflow_id: 42, run_attempt: 1, event: 'pull_request', path: '.github/workflows/published-tree-ci.yml', repository,
    head_repository: structuredClone(repository), head_sha: receipt.head, head_branch: 'task/queue', status: 'completed', conclusion: 'success', pull_requests: [] };
  const pr = { number: receipt.pr, state: 'open', draft: false, merged: false, base: { ref: 'main', repo: repository },
    head: { sha: receipt.head, ref: run.head_branch, repo: structuredClone(repository) } };
  const queuePr = { id: 'PR_12', number: receipt.pr, state: 'OPEN', isDraft: false, merged: false, baseRefName: 'main', headRefOid: receipt.head,
    mergeable: 'MERGEABLE', autoMergeRequest: { enabledAt: '2026-10-24T12:00:00Z', enabledBy: { login: 'merge-owner' } }, mergeQueueEntry: null as null | { id: string },
    timelineItems: { nodes: [] as { createdAt: string }[] } };
  const jobs = [...REQUIRED_CONTEXTS, 'native-review'].map((name, index) => ({ id: index + 1, name, run_id: run.id, run_attempt: 1, head_sha: receipt.head, status: 'completed', conclusion: 'success' }));
  const f = { event: { action: 'completed', repository, workflow_run: structuredClone(run) },
    env: { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_REF: 'refs/heads/main' }, run, pr, queuePr,
    pulls: [pr], listing: { total_count: 1, workflow_runs: [run] }, result: { total_count: jobs.length, jobs }, comments: [comment()],
    permission: 'write', clock: time, getHook: (_path: string) => {} };
  const api = { get: vi.fn(async (path: string) => {
    f.getHook(path);
    if (path.startsWith('/graphql?')) return { data: { repository: { pullRequest: structuredClone(f.queuePr) } } };
    if (path.includes('/collaborators/')) return { permission: f.permission };
    if (path.includes('/jobs?')) {
      const page = Number(new URL(path, 'https://example.invalid').searchParams.get('page'));
      return { total_count: f.result.total_count, jobs: structuredClone(f.result.jobs.slice((page - 1) * 100, page * 100)) };
    }
    if (path.includes('/actions/workflows/')) return structuredClone(f.listing);
    if (path.includes('/actions/runs/')) return structuredClone(f.run);
    if (path.includes('/pulls?')) return structuredClone(f.pulls);
    if (path.includes('/pulls/')) return structuredClone(f.pr);
    if (path.includes('/issues/')) return structuredClone(f.comments);
    if (path.includes('/git/ref/')) return { object: { sha: receipt.base } };
    throw new Error(`unexpected read ${path}`);
  }) };
  const runGit = vi.fn(async (_cwd: string, ...args: string[]) => {
    if (args[0] === 'rev-parse') return receipt.tree;
    if (args[0] === 'merge-base' && args[1] === '--all') return receipt.base;
    if (args[0] === 'diff') return `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0source.txt\0`;
    return '';
  });
  const enqueue = vi.fn(async () => { f.queuePr.mergeQueueEntry = { id: 'QUEUE_1' }; return { id: 'QUEUE_1' }; });
  return { ...f, api, runGit, enqueue, execute: () => enqueueAfterChecks({ event: f.event, env: f.env, api, runGit, enqueue, now: () => f.clock }), state: f };
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
  ])('refuses %s without a mutation or polling', async (_name, change) => {
    const f = handoffFixture(); change(f);
    await expect(f.execute()).rejects.toThrow(); expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.api.get.mock.calls.filter(([path]) => path.includes('/issues/')).length).toBeLessThanOrEqual(1);
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
    expect(f.api.get).toHaveBeenCalledWith('/repos/openlup/openlup/actions/runs/100/jobs?filter=all&per_page=100&page=1');
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
    const filler = Array.from({ length: 100 }, (_, index) => ({ ...f.result.jobs[0]!, id: 100 + index, name: `diagnostic ${index}` }));
    f.result.jobs.push(...filler); f.result.total_count += filler.length;
    if (scenario === 'duplicate across pages') f.result.jobs[100]!.id = f.result.jobs[0]!.id;
    f.state.getHook = path => {
      if (!path.endsWith('page=2')) return;
      if (scenario === 'count changed') f.result.total_count++;
      if (scenario === 'missing page') f.result.jobs.splice(100);
    };
    if (scenario === 'complete') await expect(f.execute()).resolves.toMatchObject({ status: 'enqueued' });
    else { await expect(f.execute()).rejects.toThrow(); expect(f.enqueue).not.toHaveBeenCalled(); }
    expect(f.api.get).toHaveBeenCalledWith('/repos/openlup/openlup/actions/runs/100/jobs?filter=all&per_page=100&page=2');
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
  it.each(['newer bad base', 'equal-tree group', 'live head changed', 'main moved'])('wait checks %s with fake API and Git', async scenario => {
    let clock = time; let mainReads = 0;
    const group = scenario === 'equal-tree group'; const groupHead = 'f'.repeat(40);
    const event = { number: 12, repository: { private: false }, pull_request: { head: { sha: receipt.head } }, action: 'checks_requested', merge_group: { base_ref: 'refs/heads/main', head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${groupHead}`, base_sha: receipt.base, head_sha: groupHead } };
    const api = { get: vi.fn(async path => {
      if (path.includes('/collaborators/')) return { permission: 'admin' };
      if (path.includes('/issues/')) return scenario === 'newer bad base' ? [comment(), comment({ id: 2, body: body({ ...receipt, base: 'e'.repeat(40) }) })] : [comment()];
      if (path.includes('/pulls/')) return { number: 12, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: scenario === 'live head changed' ? groupHead : receipt.head } };
      mainReads += 1;
      return { object: { sha: mainReads === 2 && scenario === 'main moved' ? groupHead : receipt.base } };
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
      await expect(waitNativeAdmission({ event: { number: 12, repository: { private: false }, pull_request: { head: { sha: receipt.head } } }, env: { GITHUB_REPOSITORY: 'openlup/openlup', GITHUB_EVENT_NAME: 'pull_request' }, api, runGit, now: () => clock, sleep, deadlineMs: 30000 })).rejects.toThrow('bounded 20-minute receipt wait expired');
      expect(sleep.mock.calls).toEqual([[15000], [15000]]); expect(runGit).not.toHaveBeenCalled();
      const lookups = api.get.mock.calls.filter(([path]) => path.includes('/collaborators/')).length;
      // A real 'read' answer is cached; a failed lookup is retried on every poll, never trusted.
      if (permission === 'read') expect(lookups).toBe(1); else expect(lookups).toBeGreaterThanOrEqual(3);
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
