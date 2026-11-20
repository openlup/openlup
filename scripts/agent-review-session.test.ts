import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { admit, candidateFloor, classifyRisk, COMPRESSED_RECEIPT_MARKER, digest, ECONOMY_RECEIPT_MARKER, explainSession, integrationReviewContext, prepareCandidate, receiptBody, RECEIPT_MARKER, receiptSummary, recordReport, requiredReviewers, verdict } from './agent-review-decide.mjs';
import { parseReceipt } from './agent-review-queue.mjs';

const time = 1000;
const observed = { base: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40), changedPaths: ['source.txt'], clean: true };
const intent = { risk: 'routine', criteria: 'Preserve the approved behavior' };
const prepare = (extra = {}) => prepareCandidate(null, { ...observed, intent, authorSessionId: 'author', ...extra }, time);
const report = (extra = {}) => ({ reviewer: 'reviewer-1', cold: true, tree: observed.tree, verdict: 'PASS', findings: [], closes: [], documentation: 'Reviewed canonical guidance and secondary examples; no documentation impact.', ...extra });
const passed = () => recordReport(prepare(), report(), time);

it.each(['intent.criteria', 'authorSessionId'])('reports the length limit for %s and keeps the existing blank error', field => {
  const input = (value: string | undefined) => field === 'intent.criteria' ? { intent: { ...intent, criteria: value } } : { authorSessionId: value };
  expect(() => prepare(input('x'.repeat(4097)))).toThrow(`invalid: ${field} is 4097 characters (limit 4,096); shorten it`);
  expect(() => prepare(input('x'.repeat(4096)))).not.toThrow();
  for (const value of [undefined, '', ' '.repeat(4097)]) {
    expect(() => prepare(input(value))).toThrow('invalid: author and intent.criteria are required');
  }
});

describe('native receipt transport', () => {
  const rawBody = (marker: string, summary: unknown) => `${marker}\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``;
  const textBody = (payload: string) => `${COMPRESSED_RECEIPT_MARKER}\n\`\`\`text\n${payload}\n\`\`\``;
  const compress = (summary: unknown) => gzipSync(JSON.stringify(summary)).toString('base64');
  const v3 = recordReport(prepare({ rules: { version: 3 } }), report(), time);
  const padded = (padding: string) => receiptSummary({ ...v3, padding }, 12, time);

  it('preserves control characters and literal escape text through a sanitising reader', () => {
    const text = 'Before\u0010\u001b\u0000\t\n\r after \\u0010';
    const session = recordReport(prepare({ rules: { version: 3 } }), report({
      reviewer: 'reviewer-' + text, documentation: text,
      findings: [{ id: 'advice', summary: text, material: false }],
    }), time);
    const summary = receiptSummary(session, 12, time);
    const body = receiptBody(summary);
    // Match the last backslash of a run and preserve the preceding parity in the API JSON.
    const rewrite = (json: string) => json.replace(/(\\+)u00([01][\da-f])/giu, (_match, run: string, hex: string) => {
      const caret = String.fromCharCode(0x40 + Number.parseInt(hex, 16));
      return '\\'.repeat(run.length - (run.length % 2)) + '^' + (caret === '\\' ? '\\\\' : caret);
    });
    expect(JSON.parse(rewrite(JSON.stringify('\u0010 \\u0010')))).toBe('^P \\^P');
    const transported = JSON.parse(rewrite(JSON.stringify(body)));
    expect.soft(body.split('\n')[0]).toBe(COMPRESSED_RECEIPT_MARKER);
    expect.soft(transported).toBe(body);
    const receipt = parseReceipt(transported);
    expect.soft(receipt).toEqual(summary);
    expect(admit({ receipt, observed: { ...observed, pr: 12, baseValid: true }, now: time })).toEqual({ ok: true, code: 'reviewed', reason: 'reviewed' });
  });

  it('keeps v2 receipts byte-identical at any size', () => {
    const summary = receiptSummary(passed(), 12, time);
    expect(receiptBody(summary)).toBe(rawBody(RECEIPT_MARKER, summary));
    const large = { ...summary, reviewers: Array.from({ length: 20 }, (_, index) => `${index}${'x'.repeat(4_000)}`) };
    expect(receiptBody(large)).toBe(rawBody(RECEIPT_MARKER, large));
  });

  const bareCases: [string, { prefix?: string; markerEnd?: string; open?: string; before?: string; close?: string; after?: string }, boolean, boolean][] = [
    // Expected raw and gzip acceptance observed by running the parser at d4c3786f5.
    ['exact', {}, true, true],
    ['opening space', { open: ' ' }, true, false],
    ['opening tab', { open: '\t' }, true, false],
    ['closing space', { close: ' ' }, true, false],
    ['closing tab', { close: '\t' }, true, false],
    ['marker CRLF', { markerEnd: '\r\n' }, false, false],
    ['whitespace line before payload', { before: ' \t\n' }, true, false],
    ['NBSP line before payload', { before: '\u00a0\n' }, true, false],
    ['trailing newline', { after: '\n' }, true, true],
    ['trailing blank lines', { after: '\n\n' }, true, false],
    ['trailing whitespace lines', { after: '\n \t\n\n' }, true, false],
    ['leading whitespace', { prefix: ' \t' }, false, false],
  ];
  it.each(bareCases)('preserves #843 bare parsing with %s', (_label, parts, raw, gzip) => {
    const { prefix = '', markerEnd = '\n', open = '', before = '', close = '', after = '' } = parts;
    const v2 = { pr: 12 };
    const v3 = { version: 3, pr: 12 };
    const formats = [
      { marker: RECEIPT_MARKER, type: 'json', payload: JSON.stringify(v2), expected: raw ? v2 : null },
      { marker: ECONOMY_RECEIPT_MARKER, type: 'json', payload: JSON.stringify(v3), expected: raw ? v3 : null },
      { marker: COMPRESSED_RECEIPT_MARKER, type: 'text', payload: compress(v3), expected: gzip ? v3 : null },
    ];
    for (const { marker, type, payload, expected } of formats) {
      const body = `${prefix}${marker}${markerEnd}\`\`\`${type}${open}\n${before}${payload}\n\`\`\`${close}${after}`;
      expect(parseReceipt(body), marker).toEqual(expected);
    }
  });

  it('refuses an oversized compressed body with its measured size and recovery steps', () => {
    const summary = padded(Array.from({ length: 5_000 }, (_, index) => digest(index)).join(''));
    const small = padded('');
    const size = receiptBody(small).length - compress(small).length + compress(summary).length;
    expect(size).toBeGreaterThan(200_000);
    expect(() => receiptBody(summary)).toThrow(`compressed receipt is ${size} characters (limit 200000). The session history is too long for one comment. Split the change or start a new native session with new counted reviews.`);
  });

  it('requires one text fence, canonical base64, valid gzip and v3 JSON', () => {
    const summary = { version: 3, pr: 12 };
    const payload = compress(summary);
    expect(payload).toMatch(/=$/u);
    expect(parseReceipt(textBody(payload))).toEqual(summary);
    expect(parseReceipt(textBody(payload) + '\n')).toEqual(summary);
    for (const body of [
      textBody(payload) + '\n```text\nextra\n```',
      textBody(payload.replace(/^./u, '$& ')),
      textBody(payload.slice(0, -1)),
      textBody(Buffer.from('not gzip').toString('base64')),
      textBody(gzipSync('not JSON').toString('base64')),
      textBody(compress(receiptSummary(passed(), 12, time))),
    ]) expect(parseReceipt(body)).toBeNull();
  });

  it('requires exact framed marker and fence lines and keeps the 1 MiB body limit', () => {
    const summary = padded('');
    const framed = receiptBody(summary);
    expect(parseReceipt(framed.padEnd(1024 * 1024, ' '))).toEqual(summary);
    for (const body of [
      framed.replace(`${COMPRESSED_RECEIPT_MARKER}\n`, `${COMPRESSED_RECEIPT_MARKER} \n`),
      framed.replace('```text\n', '```text \n'),
      framed.replace('```text\n', '```json\n'),
      framed.replace('```text\n', '```text\n \n'),
      framed.replace('\n```\n', '\n  ```\n'),
      framed.replace('\n```\n', '\n``` \n'),
      framed.padEnd(1024 * 1024 + 1, ' '),
    ]) expect(parseReceipt(body)).toBeNull();
  });

  it('refuses invalid UTF-8 inside compressed JSON', () => {
    const json = Buffer.concat([Buffer.from('{"version":3,"note":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    expect(parseReceipt(textBody(gzipSync(json).toString('base64')))).toBeNull();
  });

  it('refuses a UTF-8 BOM before compressed JSON', () => {
    const json = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"version":3}')]);
    expect(parseReceipt(textBody(gzipSync(json).toString('base64')))).toBeNull();
  });

  it('refuses a valid gzip receipt with an optional filename', () => {
    const session = recordReport(prepare({ rules: { version: 3 } }), report(), time);
    const summary = receiptSummary(session, 12, time);
    const payload = gzipSync(JSON.stringify(summary));
    const header = Buffer.from(payload.subarray(0, 10));
    header[3] = 0x08; // FNAME
    // The filename and its NUL also form a non-final stored deflate block.
    // With the flag check removed, the fixed-offset inflate would consume the entire input.
    const blockHeader = Buffer.from([0x08, 0x01, 0x01, 0xfe, 0xfe]); // Length 257 and its complement.
    const filename = Buffer.concat([blockHeader, Buffer.alloc(256, 0x61), Buffer.from([0])]);
    const named = Buffer.concat([header, filename, payload.subarray(10)]);
    expect(gunzipSync(named)).toEqual(Buffer.from(JSON.stringify(summary)));
    expect(parseReceipt(textBody(named.toString('base64')))).toBeNull();
  });

  it('refuses bytes after the gzip member', () => {
    const payload = Buffer.concat([gzipSync('{"version":3}'), Buffer.from([0, 1, 2, 3])]);
    expect(parseReceipt(textBody(payload.toString('base64')))).toBeNull();
  });

  it.each([
    ['split JSON', '{"version":', '3}'],
    ['empty first member', '', '{"version":3}'],
    ['empty second member', '{"version":3}', ''],
  ])('refuses concatenated gzip members with %s', (_label, first, second) => {
    const payload = Buffer.concat([gzipSync(first), gzipSync(second)]);
    expect(parseReceipt(textBody(payload.toString('base64')))).toBeNull();
  });

  it('refuses a gzip payload that expands beyond 1 MiB', () => {
    const summary = { version: 3, session: { history: 'x'.repeat(1024 * 1024) } };
    expect(parseReceipt(textBody(compress(summary)))).toBeNull();
  });

  it('keeps the v3 admission refusals for a tampered head or history after decoding', () => {
    const session = recordReport(prepare({ rules: { version: 3 } }), report(), time);
    const summary = receiptSummary(session, 12, time);
    const history = structuredClone(summary);
    history.session.history.find(event => event.type === 'report').report.documentation += ' Modified.';
    for (const [tampered, reason] of [
      [{ ...summary, head: 'd'.repeat(40) }, 'invalid: v3 summary differs'],
      [history, 'invalid: v3 history digest differs'],
    ] as const) {
      const receipt = parseReceipt(textBody(compress(tampered)));
      expect(receipt).toEqual(tampered);
      expect(admit({ receipt, observed: { ...receipt, baseValid: true }, now: time })).toEqual({ ok: false, code: 'invalid', reason });
    }
  });
});

describe('native review decisions', () => {
  it.each([
    ['prose', 1], ['routine', 1], ['behavior', 2], ['unknown', 1],
  ])('requires the v3 %s reviewer floor', (risk, count) => {
    expect(requiredReviewers(classifyRisk(observed, risk))).toBe(count);
    const session = recordReport(prepare({ intent: { ...intent, risk }, rules: { version: 3 } }), report(), time);
    expect(verdict(session, observed, time).ok).toBe(count === 1);
  });
  it.each([
    'package.json', 'config/settings.json', 'db/example.sql',
    'scripts/agent-review-session.mjs', 'scripts/source-preview-release.ts', 'packages/core/src/index.ts',
    'server/bff/orders.ts', 'src/domains/payment/card.ts', 'src/domains/subscription/renewal.ts',
    'src/pages/account/login/useOtpCodeFallback.ts', 'src/domains/customers/customerMagicLinkClient.ts',
    'src/domains/shipping/contracts.ts', 'server/domains/accounting/accountingInvoiceDeliveryJob.ts',
  ])('raises the floor for %s', path => {
    expect(requiredReviewers(classifyRisk({ changedPaths: [path] }, 'routine'))).toBe(2);
  });
  it.each([true, false])('classifies mode changes: %s', modeChanged => {
    expect(requiredReviewers(classifyRisk({ ...observed, modeChanged }))).toBe(modeChanged ? 2 : 1);
  });
  it.each([
    ['no reports', () => prepare(), observed, time, 'needs_agent_review'],
    ['clean pass', passed, observed, time, 'reviewed'],
    ['dirty', passed, { ...observed, clean: false }, time, 'dirty'],
    ['head changed', passed, { ...observed, head: 'd'.repeat(40) }, time, 'stale'],
    ['tree changed', passed, { ...observed, tree: 'd'.repeat(40) }, time, 'stale'],
    ['base changed', passed, { ...observed, base: 'd'.repeat(40) }, time, 'stale'],
    ['a month later: reviews do not expire', passed, observed, time + 30 * 86400000, 'reviewed'],
    ['future report', passed, observed, time - 1, 'invalid'],
    ['invalid clock', passed, observed, NaN, 'invalid'],
    ['old version', () => ({ version: 1 }), observed, time, 'invalid'],
  ])('%s', (_name, state, actual, now, code) => {
    expect(verdict(state(), actual, now).code).toBe(code);
  });
  it('preserves v2 timestamp checks for PASS reports after the floor is met', () => {
    const reviewed = recordReport(passed(), report({ reviewer: 'reviewer-2', verdict: 'FAIL' }), time);
    reviewed.history.at(-1).report.at = time + 1;
    expect(verdict(reviewed, observed, time).code).toBe('reviewed');
    expect(explainSession(reviewed, observed, time).status).toBe('verify_required');

    const incomplete = recordReport(prepare({ intent: { ...intent, risk: 'behavior' } }), report(), time);
    incomplete.history.at(-1).report.at = time + 1;
    expect(verdict(incomplete, observed, time).code).toBe('needs_agent_review');
    expect(explainSession(incomplete, observed, time).status).toBe('needs_agent_review');
    const complete = recordReport(incomplete, report({ reviewer: 'reviewer-2' }), time);
    expect(verdict(complete, observed, time).code).toBe('invalid');
    expect(explainSession(complete, observed, time).status).toBe('invalid');
  });
  it('distinguishes unreadable legacy findings from an empty list', () => {
    const session = passed();
    session.history.at(-1).report.findings = null;
    expect(verdict(session, observed, time).code).toBe('invalid');
    expect(explainSession(session, observed, time)).toMatchObject({
      status: 'invalid', verified: false, openFindings: null,
    });
  });
  it.each([
    { reviewer: 'author' }, { reviewer: '' }, { cold: false }, { verdict: 'pass' },
    { documentation: undefined }, { documentation: '   ' }, { documentation: 42 }, { documentation: 'x'.repeat(4097) },
    { tree: 'd'.repeat(40) }, { findings: null }, { closes: null },
    { findings: [{ id: 'F1', summary: '', material: true }] },
    { findings: [{ id: 'F1', summary: 'broken' }] }, { closes: ['unknown'] },
  ])('refuses invalid report %j', patch => {
    expect(() => recordReport(prepare(), report(patch), time)).toThrow('invalid:');
  });
  it('requires fresh unique reviewers across current and earlier candidates', () => {
    const session = passed();
    expect(() => recordReport(session, report(), time)).toThrow('already used');
    const next = prepareCandidate(session, { ...observed, head: 'd'.repeat(40), tree: 'e'.repeat(40), intent, authorSessionId: 'author' }, time);
    expect(() => recordReport(next, report({ tree: next.candidate.tree }), time)).toThrow('already used');
    expect(verdict(next, next.candidate, time).code).toBe('needs_agent_review');
  });
  it('keeps prior reports without documentation valid without changing review evidence', () => {
    const session = recordReport(prepare(), report({ findings: [{ id: 'A1', summary: 'retained prior advice', material: false }] }), time);
    const stored = structuredClone(session);
    delete stored.history.at(-1).report.documentation;
    expect(verdict(stored, observed, time)).toMatchObject({ ok: true, code: 'reviewed' });
    const prepared = prepareCandidate(stored, { ...observed, intent, authorSessionId: 'author' }, time);
    expect(prepared.history).toEqual(stored.history);
    expect(stored.history.at(-1).report).not.toHaveProperty('documentation');
    expect(stored.history.at(-1).report.findings).toEqual(session.history.at(-1).report.findings);
    expect(receiptSummary(prepared, 12, time).expires).toBe(receiptSummary(session, 12, time).expires);
    expect(prepared.history.at(-1).at).toBe(session.history.at(-1).at);
  });
  it('retains the exact documentation assessment in new reports', () => {
    const documentation = 'Canonical guide is current; secondary example needs no change.';
    const session = recordReport(prepare(), report({ documentation }), time);
    expect(session.history.at(-1).report.documentation).toBe(documentation);
  });
  it.each([{ reviewer: 'author' }, { cold: false }])('rechecks persisted reviewer independence: %j', patch => {
    const session = passed(); Object.assign(session.history.at(-1).report, patch);
    expect(verdict(session, observed, time).code).toBe('invalid');
  });
  it('keeps evidence valid without expiry while the receipt keeps its recorded identity field', () => {
    let session = recordReport(prepare({ intent: { ...intent, risk: 'behavior' } }), report(), time);
    session = recordReport(session, report({ reviewer: 'reviewer-2' }), time + 60000);
    expect(verdict(session, observed, time + 86400000).code).toBe('reviewed');
    expect(receiptSummary(session, 12, time + 60000).expires).toBe(time + 86400000);
  });
  it('keeps material findings until a later report explicitly closes their ids', () => {
    let session = recordReport(prepare(), report({ verdict: 'FAIL', findings: [{ id: 'F1', summary: 'broken clamp', material: true }] }), time);
    session = recordReport(session, report({ reviewer: 'reviewer-2' }), time);
    expect(verdict(session, observed, time).reason).toContain('material finding');
    const next = { ...observed, tree: 'd'.repeat(40), head: 'e'.repeat(40), intent, authorSessionId: 'author' };
    session = prepareCandidate(session, next, time + 1);
    session = recordReport(session, report({ reviewer: 'reviewer-3', tree: next.tree, closes: ['F1'] }), time + 1);
    expect(verdict(session, next, time + 1).ok).toBe(true);
  });
  it('advice never blocks', () => {
    const session = recordReport(prepare(), report({ findings: [{ id: 'A1', summary: 'optional polish', material: false }] }), time);
    expect(verdict(session, observed, time).ok).toBe(true);
  });
  it('refuses changing the meaning of a stable finding id', () => {
    const session = recordReport(prepare(), report({ findings: [{ id: 'F1', summary: 'broken clamp', material: true }] }), time);
    expect(() => recordReport(session, report({ reviewer: 'reviewer-2', findings: [{ id: 'F1', summary: 'something else', material: true }] }), time)).toThrow('changed meaning');
  });
  it('records repeated repairs without cycle counters or an owner gate', () => {
    let session = prepare();
    expect(session).not.toHaveProperty('cycle'); expect(session).not.toHaveProperty('allowedCycles');
    for (let index = 1; index <= 7; index++) {
      const next = { ...observed, head: index.toString().repeat(40), tree: index.toString().repeat(40), intent, authorSessionId: 'author' };
      session = prepareCandidate(session, next, time + index);
      expect(session.history.at(-1)).not.toHaveProperty('cycle');
      session = recordReport(session, report({ reviewer: `reviewer-${index}`, tree: next.tree }), time + index);
      expect(verdict(session, next, time + index).ok).toBe(true);
    }
  });
  it.each(['GEMINI.md', '.cursor/rules/x.md', 'nested/GEMINI.md', 'nested/.cursor/rules/x.md', 'AGENTS.md', 'nested/AGENT_GUIDE.local.rst', '.github/guide.md', '.claude/rules.md', '.agents/rules.md', '.codex/rules.md', 'nested/SKILL.md'])('keeps a review for rule file %s', path => {
    expect(candidateFloor({ changedPaths: [path] }, 'unknown')).toBe(path.endsWith('.rst') ? 2 : 1);
  });
  it.each(['packages/core/docs/guide/README.md', 'packages/core/docs/guide/how-to/build/compose.md'])('keeps one review for reader-guide page %s', path => {
    expect(candidateFloor({ changedPaths: [path] }, 'unknown')).toBe(1);
    expect(candidateFloor({ changedPaths: ['docs/platform/README.md', path] }, 'prose')).toBe(1);
  });
  it.each(['docs/platform/README.md', 'packages/core/docs/SUBSCRIPTION_ENGINE.md', 'packages/core/docs/guide.md', 'docs/guide/README.md'])('keeps the zero floor for other Markdown %s', path => {
    expect(candidateFloor({ changedPaths: [path] }, 'prose')).toBe(0);
  });
  it.each(['.nvmrc', 'scripts/documentation-routing.ts'])('replays a routine v2 session and receipt with one PASS for %s', path => {
    const candidate = { ...observed, changedPaths: [path] };
    // Persisted shape emitted by main, including its historical cycle fields.
    const session = { version: 2, authorSessionId: 'author', intent, cycle: 0, allowedCycles: 3,
      candidate, preparedAt: time, history: [
        { type: 'prepare', intent, candidate, authorSessionId: 'author', at: time, cycle: 0 },
        { type: 'report', at: time, report: { ...report(), at: time } },
      ] };
    expect(session.version).toBe(2);
    expect(session.history.filter(event => event.type === 'report')).toHaveLength(1);
    expect(verdict(session, candidate, time)).toMatchObject({ ok: true, code: 'reviewed' });
    // Literal legacy summary: admission replays receipts emitted on a legacy base.
    const receipt = { pr: 12, base: candidate.base, head: candidate.head, tree: candidate.tree,
      risk: 'routine', reviewers: ['reviewer-1'], verdict: 'PASS', expires: time + 86400000, sessionDigest: digest(session) };
    expect(receiptSummary(session, 12, time)).toEqual(receipt);
    expect(admit({ receipt, observed: { ...candidate, pr: 12, baseValid: true, legacyRules: true }, now: time })).toMatchObject({ ok: true, code: 'reviewed' });
    const v3 = recordReport(prepare({ changedPaths: [path], rules: { version: 3 } }), report(), time);
    expect(verdict(v3, candidate, time)).toMatchObject({ ok: false, code: 'needs_agent_review' });
  });
  it.each(['prose', 'routine', 'behavior', 'unknown'])('preserves the v2 risk floor for %s in verification and admission', risk => {
    const session = recordReport(prepare({ intent: { ...intent, risk } }), report(), time);
    const receipt = { pr: 12, base: observed.base, head: observed.head, tree: observed.tree,
      risk, reviewers: ['reviewer-1'], verdict: 'PASS', expires: time + 86400000, sessionDigest: digest(session) };
    const ok = ['prose', 'routine'].includes(risk);
    expect(verdict(session, observed, time).ok).toBe(ok);
    expect(admit({ receipt, observed: { ...observed, pr: 12, baseValid: true }, now: time }).ok).toBe(ok);
  });
  it.each([false, true])('--new keeps F1 open until explicitly closed (changed tree: %s)', changed => {
    let session = recordReport(prepare(), report({ verdict: 'FAIL', findings: [{ id: 'F1', summary: 'broken clamp', material: true }] }), time);
    const next = { ...observed, head: 'd'.repeat(40), tree: changed ? 'e'.repeat(40) : observed.tree,
      intent: { risk: 'behavior', criteria: 'Approved changed intent' }, authorSessionId: 'next-author' };
    session = prepareCandidate(session, next, time + 1, true);
    for (const reviewer of ['reviewer-2', 'reviewer-3']) session = recordReport(session, report({ reviewer, tree: next.tree }), time + 1);
    expect(verdict(session, next, time + 1)).toMatchObject({ code: 'needs_agent_review', reason: 'close every material finding' });
    session = recordReport(session, report({ reviewer: 'reviewer-4', tree: next.tree, closes: ['F1'] }), time + 1);
    expect(verdict(session, next, time + 1).ok).toBe(true);
    expect(receiptSummary(session, 12, time + 1).risk).toBe('behavior');
  });
  it.each(['reviewer-1', 'author', 'next-author'])('--new refuses historical reviewer or author %s', reviewer => {
    let session = prepareCandidate(passed(), { ...observed, intent, authorSessionId: 'next-author' }, time + 1, true);
    session = prepareCandidate(session, { ...observed, intent, authorSessionId: 'third-author' }, time + 2, true);
    expect(() => recordReport(session, report({ reviewer }), time + 2)).toThrow(reviewer === 'reviewer-1' ? 'already used' : 'independent');
    session = recordReport(session, report({ reviewer: 'fresh-reviewer' }), time + 2);
    session.history.at(-1).report.reviewer = reviewer;
    expect(verdict(session, observed, time + 2).code).toBe('invalid');
  });
  it.each([false, true])('first prepare accepts --new = %s and hashes intent history', fresh => {
    const session = prepareCandidate(null, { ...observed, intent, authorSessionId: 'author' }, time, fresh);
    expect(session).toEqual(prepare());
    const next = prepareCandidate(session, { ...observed, intent: { ...intent, criteria: 'Changed goal' }, authorSessionId: 'author' }, time, true);
    const alteredHistory = structuredClone(next); alteredHistory.history[0].intent.criteria = 'Different original goal';
    expect(digest(alteredHistory)).not.toBe(digest(next));
    expect(next.history[0].intent).toEqual(intent);
  });
  it.each([false, true])('--new retains version and timestamp validation (bad version: %s)', badVersion => {
    const session = prepare(); if (badVersion) session.version = 1;
    expect(() => prepareCandidate(session, { ...observed, intent, authorSessionId: 'author' }, time - 1, true)).toThrow(badVersion ? 'version' : 'time');
  });
  it.each([
    ['dirty source', { clean: false }], ['missing author', { authorSessionId: '' }],
    ['missing criteria', { intent: {} }],
    ['bad risk', { intent: { ...intent, risk: 'safe' } }],
  ])('refuses preparation: %s', (_name, patch) => expect(() => prepare(patch)).toThrow());
  it('unchanged prepare preserves history and expiry; changed intent requires --new', () => {
    const session = passed(); const bytes = JSON.stringify(session);
    expect(prepareCandidate(session, { ...observed, intent, authorSessionId: 'author' }, time + 1)).toEqual(session);
    expect(() => prepareCandidate(session, { ...observed, intent: { ...intent, criteria: 'new goal' }, authorSessionId: 'author' }, time)).toThrow('prepare --new');
    expect(JSON.stringify(session)).toBe(bytes);
  });
  it('refuses invalid report timestamps', () => {
    expect(() => recordReport(prepare(), report(), time - 1)).toThrow('time');
  });
  it('focuses an exact base integration without copying reports', () => {
    const source = passed();
    const actual = { ...observed, base: 'd'.repeat(40), head: 'e'.repeat(40), tree: 'f'.repeat(40), intent, authorSessionId: 'author' };
    const integration = integrationReviewContext(source, actual, { parents: [observed.head, actual.base], baseAncestor: true }, time + 1);
    expect(integration).toMatchObject({ base: observed.base, head: observed.head, tree: observed.tree, expires: time + 86400000, mechanical: false });
    let next = prepareCandidate(source, { ...actual, integration }, time + 1);
    expect(next.history.slice(0, -1)).toEqual(source.history);
    expect(verdict(next, actual, time + 1).code).toBe('needs_agent_review');
    next = recordReport(next, report({ reviewer: 'fresh-a', tree: actual.tree }), time + 60000);
    expect(verdict(next, actual, time + 60000).code).toBe('needs_agent_review');
    next = recordReport(next, report({ reviewer: 'fresh-b', tree: actual.tree }), time + 60000);
    expect(verdict(next, actual, time + 60000).ok).toBe(true);
    expect(receiptSummary(next, 12, time + 60000).expires).toBe(time + 86400000);
    const legacy = structuredClone(next); delete legacy.candidate.integration.mechanical;
    expect(verdict(legacy, actual, time + 60000).ok).toBe(true);
    expect(prepareCandidate(legacy, actual, time + 60001)).toEqual(legacy);
    expect(verdict(next, actual, time + 86400000).code).toBe('reviewed');
    expect(prepareCandidate(next, actual, time + 60001)).toEqual(next);
    const renewed = prepareCandidate(next, actual, time + 86400000, true);
    expect(renewed.candidate.integration).toBeUndefined();
    expect(() => prepareCandidate(source, { ...actual, integration: { ...integration, expires: integration.expires + 1 } }, time + 1)).toThrow('integration coverage');
    expect(() => prepareCandidate(source, { ...actual, integration: { ...integration, mechanical: 'yes' } }, time + 1)).toThrow('integration coverage');
    expect(() => prepareCandidate(source, { ...actual, integration }, time + 1, true)).toThrow('integration coverage');
  });
  it.each(['missing', 'open finding', 'wrong parent', 'extra parent', 'base not ancestor', 'changed intent', 'changed author'])('does not focus integration with %s coverage', reason => {
    let source = reason === 'missing' ? prepare() : passed();
    if (reason === 'open finding') source = recordReport(source, report({ reviewer: 'defect', verdict: 'FAIL', findings: [{ id: 'F1', summary: 'unresolved', material: true }] }), time);
    const actual = { ...observed, base: 'd'.repeat(40), head: 'e'.repeat(40), tree: 'f'.repeat(40), intent: reason === 'changed intent' ? { ...intent, criteria: 'Other goal' } : intent, authorSessionId: reason === 'changed author' ? 'other' : 'author' };
    const parents = reason === 'wrong parent' ? [actual.base, observed.head] : reason === 'extra parent' ? [observed.head, actual.base, observed.base] : [observed.head, actual.base];
    expect(integrationReviewContext(source, actual, { parents, baseAncestor: reason !== 'base not ancestor', mechanical: true }, time + 1)).toBeUndefined();
  });
  it('retains the two-reviewer floor for a v2 integration', () => {
    const source = passed();
    const actual = { ...observed, base: 'd'.repeat(40), head: 'e'.repeat(40), tree: 'f'.repeat(40), intent, authorSessionId: 'author' };
    const integration = integrationReviewContext(source, actual, { parents: [observed.head, actual.base], baseAncestor: true }, time + 1);
    let next = recordReport(prepareCandidate(source, { ...actual, integration }, time + 1), report({ reviewer: 'fresh', tree: actual.tree }), time + 1);
    expect(verdict(next, actual, time + 1).code).toBe('needs_agent_review');
    next = recordReport(next, report({ reviewer: 'fresh-2', tree: actual.tree }), time + 1);
    expect(verdict(next, actual, time + 1).ok).toBe(true);
    const receipt = receiptSummary(next, 12, time + 1);
    expect(receipt.risk).toBe('behavior');
    expect(admit({ receipt: { ...receipt, reviewers: ['fresh'] }, observed: { ...actual, pr: 12, baseValid: true }, now: time + 1 }).code).toBe('needs_agent_review');
  });
  it('emits only a bounded summary and validates the PR number', () => {
    const summary = receiptSummary(passed(), 12, time);
    expect(summary).toMatchObject({ pr: 12, base: observed.base, head: observed.head, tree: observed.tree, reviewers: ['reviewer-1'], verdict: 'PASS' });
    expect(summary.sessionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(summary).not.toHaveProperty('history');
    expect(() => receiptSummary(passed(), 0, time)).toThrow('PR number');
  });
  it.each([
    ['v3 floor 0 Markdown', { changedPaths: ['docs/platform/README.md'], intent: { ...intent, risk: 'prose' }, rules: { version: 3 } }, 0, []],
    ['v3 floor 1 routine code', { changedPaths: ['source.txt'], rules: { version: 3 } }, 1, []],
    ['v3 floor 2 protected path', { changedPaths: ['config/settings.json'], rules: { version: 3 } }, 2, ['config/settings.json']],
    ['v2 floor 1 routine code', { changedPaths: ['source.txt'] }, 1, []],
    ['v2 floor 2 sensitive path', { changedPaths: ['config/settings.json'] }, 2, ['config/settings.json']],
  ])('explains %s requirements without claiming verify completion', (_label, extra, floor, twoReviewerPaths) => {
    const session = prepare(extra);
    const explained = explainSession(session, session.candidate, time);
    expect(explained.verified).toBe(false);
    expect(explained.status).toBe(floor === 0 ? 'verify_required' : 'needs_agent_review');
    expect(explained.candidate).toMatchObject({ status: 'clean', matchesSession: true, clean: true, stale: false });
    expect(explained.requirements).toMatchObject({ floor, acceptedReports: 0, missingReports: floor, reviewers: [], twoReviewerPaths });
    expect(explained.verifyChecksPending.length).toBeGreaterThan(0);
    if (floor === 0) expect(explained.nextAction).toContain('verify');
    else expect(explained.nextAction).toContain(`Record ${floor} independent cold PASS report(s)`);
  });
  it('explains dirty, stale and unreadable candidate states and open material findings', () => {
    let session = recordReport(prepare({ rules: { version: 3 } }), report({
      verdict: 'FAIL',
      findings: [
        { id: 'F1', summary: 'broken clamp', material: true },
        { id: 'A1', summary: 'minor naming', material: false },
      ],
    }), time);
    expect(explainSession(session, { ...observed, clean: false }, time)).toMatchObject({
      status: 'dirty', verified: false,
      candidate: { status: 'dirty', matchesSession: false, clean: false, stale: false },
      openFindings: [{ id: 'F1', summary: 'broken clamp', material: true }],
    });
    expect(explainSession(session, { ...observed, head: 'd'.repeat(40) }, time)).toMatchObject({
      status: 'stale', verified: false,
      candidate: { status: 'stale', matchesSession: false, clean: true, stale: true },
    });
    expect(explainSession(session, { error: 'OPENLUP_STACK_BASE must be a full commit digest' }, time)).toMatchObject({
      status: 'invalid', verified: false,
      candidate: { status: 'unreadable', matchesSession: false, error: 'OPENLUP_STACK_BASE must be a full commit digest' },
    });
    expect(explainSession(session, observed, time)).toMatchObject({
      status: 'needs_agent_review',
      requirements: { floor: 1, acceptedReports: 0, missingReports: 1 },
      openFindings: [{ id: 'F1', summary: 'broken clamp', material: true }],
    });
    session = recordReport(session, report({ reviewer: 'reviewer-2', closes: ['F1'] }), time + 1);
    expect(explainSession(session, observed, time + 1)).toMatchObject({
      status: 'verify_required', verified: false,
      requirements: { floor: 1, acceptedReports: 1, missingReports: 0, reviewers: ['reviewer-2'] },
      openFindings: [],
    });
  });
  it('explains repair delta scope and switches to full candidate floor when a full report is recorded', () => {
    const rules = { version: 3, base: '1'.repeat(64), head: '2'.repeat(64) };
    let prior = prepare({ changedPaths: ['config/settings.json', 'source.txt'], rules });
    prior = recordReport(prior, report({ reviewer: 'r1' }), time);
    prior = recordReport(prior, report({ reviewer: 'r2' }), time);
    const deltaDigest = '3'.repeat(64);
    const repairCandidate = {
      ...observed, head: 'd'.repeat(40), tree: 'e'.repeat(40),
      changedPaths: ['config/settings.json', 'source.txt'], rules,
      coverage: {
        kind: 'repair', previous: digest(prior.history),
        from: { base: prior.candidate.base, head: prior.candidate.head, tree: prior.candidate.tree },
        delta: deltaDigest, proof: { paths: ['source.txt'], modeChanged: false },
      },
    };
    const repaired = prepareCandidate(prior, { ...repairCandidate, intent, authorSessionId: 'author' }, time + 1);
    const beforeReport = explainSession(repaired, repaired.candidate, time + 1);
    expect(beforeReport).toMatchObject({
      status: 'needs_agent_review', verified: false,
      requirements: { scope: 'repair-delta', floor: 1, acceptedReports: 0, missingReports: 1, twoReviewerPaths: [] },
      coverage: { kind: 'repair', scope: 'repair-delta', delta: deltaDigest, paths: ['source.txt'], ordinaryAllowed: true },
    });
    expect(beforeReport.nextAction).toContain(`ordinary: true, delta: ${deltaDigest}`);
    // Recording a full report (ordinary !== true) switches the requirement from deltaFloor (1) to candidateFloor (2).
    const withFullReport = recordReport(repaired, report({ reviewer: 'r3', tree: repairCandidate.tree }), time + 2);
    const afterFullReport = explainSession(withFullReport, withFullReport.candidate, time + 2);
    expect(afterFullReport).toMatchObject({
      status: 'needs_agent_review', verified: false,
      requirements: { scope: 'full', floor: 2, acceptedReports: 1, missingReports: 1, reviewers: ['r3'], twoReviewerPaths: ['config/settings.json'] },
      coverage: { kind: 'repair', scope: 'full', delta: deltaDigest, paths: ['source.txt'], ordinaryAllowed: false },
    });
    expect(verdict(withFullReport, withFullReport.candidate, time + 2).code).toBe('needs_agent_review');
    // Recording an ordinary delta report instead satisfies the 1-reviewer delta floor.
    const withDeltaReport = recordReport(repaired, report({ reviewer: 'r3', tree: repairCandidate.tree, ordinary: true, delta: deltaDigest }), time + 2);
    expect(explainSession(withDeltaReport, withDeltaReport.candidate, time + 2)).toMatchObject({
      status: 'verify_required', verified: false,
      requirements: { scope: 'repair-delta', floor: 1, acceptedReports: 1, missingReports: 0, reviewers: ['r3'] },
    });
    expect(verdict(withDeltaReport, withDeltaReport.candidate, time + 2).ok).toBe(true);
    const body = receiptBody(receiptSummary(withDeltaReport, 12, time + 2));
    expect(body).toContain('Reviewer floor 1 · Scope repair-delta');
    expect(body.match(/^\| .* \| PASS \| .*$/gmu)).toEqual(['| r3 | PASS | delta | none |']);
  });
  it.each(['git', 'registry-union', 'derived', 'resolution'])('explains v3 %s integration requirements', kind => {
    const rules = { version: 3, base: '1'.repeat(64), head: '2'.repeat(64) };
    const prior = recordReport(prepare({ rules }), report({ reviewer: 'r1' }), time);
    const nextCandidate = { ...observed, base: 'd'.repeat(40), head: 'e'.repeat(40), tree: 'f'.repeat(40), rules };
    const integration = integrationReviewContext(prior, { ...nextCandidate, intent, authorSessionId: 'author' }, { parents: [prior.candidate.head, nextCandidate.base], baseAncestor: true, mechanical: kind === 'git' }, time + 1);
    const deltaDigest = '4'.repeat(64);
    const session = prepareCandidate(prior, {
      ...nextCandidate, intent, authorSessionId: 'author', integration,
      coverage: {
        kind: 'integration', previous: digest(prior.history),
        from: { base: prior.candidate.base, head: prior.candidate.head, tree: prior.candidate.tree },
        delta: deltaDigest,
        proof: { kind, tree: nextCandidate.tree, ...(kind === 'resolution' ? { resolution: ['source.txt'], modeChanged: false } : {}) },
      },
    }, time + 1);
    const explained = explainSession(session, session.candidate, time + 1);
    expect(explained.verified).toBe(false);
    if (kind === 'resolution') {
      expect(explained).toMatchObject({
        status: 'needs_agent_review',
        requirements: { scope: 'resolution-delta', floor: 1, acceptedReports: 0, missingReports: 1 },
        coverage: { kind: 'integration', proofKind: 'resolution', scope: 'resolution-delta', delta: deltaDigest, paths: ['source.txt'], ordinaryAllowed: true },
      });
      const reviewed = recordReport(session, report({ reviewer: 'r2', tree: nextCandidate.tree, ordinary: true, delta: deltaDigest }), time + 2);
      expect(receiptBody(receiptSummary(reviewed, 12, time + 2))).toContain('Reviewer floor 1 · Scope resolution-delta');
    } else {
      expect(explained).toMatchObject({
        status: 'verify_required',
        requirements: { scope: kind, floor: 0, acceptedReports: 0, missingReports: 0 },
        coverage: { kind: 'integration', proofKind: kind, scope: kind, delta: deltaDigest, paths: [], ordinaryAllowed: false },
      });
      expect(receiptBody(receiptSummary(session, 12, time + 1))).toContain(`Reviewer floor 0 · Scope ${kind}`);
    }
  });
});
