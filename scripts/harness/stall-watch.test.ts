import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { postMessage } from './inbox.mjs';
import {
  DEFAULT_REPO,
  classifyPullRequest,
  detectActiveLocalWorker,
  detectAuthorEmail,
  detectDefaultRepo,
  evaluateStallWatch,
  parseGithubRepoFromRemoteUrl,
  parseStallWatchArgs,
  saveAck,
} from './stall-watch.mjs';

const NOW = new Date('2026-11-27T12:00:00Z');
const SHA1 = '1111111111111111111111111111111111111111';
const SHA2 = '2222222222222222222222222222222222222222';

const tempDirs: string[] = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlup-stall-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makePr(overrides: Record<string, unknown> = {}) {
  return {
    number: 1291,
    title: 'feat: sample change',
    url: 'https://github.com/openlup/openlup/pull/1291',
    isDraft: false,
    createdAt: '2026-11-27T10:00:00Z',
    updatedAt: '2026-11-27T11:55:00Z',
    lastActivityAt: '2026-11-27T11:55:00Z',
    headRefName: 'feat/sample-1291',
    headRefOid: SHA1,
    baseRefName: 'main',
    mergeStateStatus: 'CLEAN',
    labels: [],
    autoMergeRequest: null,
    mergeQueueEntry: null,
    unresolvedThreads: 0,
    rollupState: 'SUCCESS',
    ...overrides,
  };
}

describe('stall-watch repo and author auto-detection', () => {
  const sshHost = ['git', 'github.com'].join('@');

  it('parses GitHub owner/repo from HTTPS and SSH remote URLs and rejects lookalike hosts', () => {
    expect(parseGithubRepoFromRemoteUrl('https://github.com/acme/widget.git')).toBe('acme/widget');
    expect(parseGithubRepoFromRemoteUrl('https://github.com/acme/widget')).toBe('acme/widget');
    expect(parseGithubRepoFromRemoteUrl(`${sshHost}:openlup/openlup.git`)).toBe('openlup/openlup');
    expect(parseGithubRepoFromRemoteUrl(`ssh://${sshHost}/org-1/repo.name.git`)).toBe('org-1/repo.name');
    expect(parseGithubRepoFromRemoteUrl('https://gitlab.com/acme/widget.git')).toBeNull();
    expect(parseGithubRepoFromRemoteUrl('https://not-github.com/owner/repo.git')).toBeNull();
    expect(parseGithubRepoFromRemoteUrl('https://evil.example/github.com/owner/repo.git')).toBeNull();
  });

  it('falls back to DEFAULT_REPO when git remote lookup fails', () => {
    const detected = detectDefaultRepo({
      exec: () => ({ status: 0, stdout: `${sshHost}:example-org/example-repo.git\n`, stderr: '' }),
    });
    expect(detected).toBe('example-org/example-repo');

    const fallback = detectDefaultRepo({
      exec: () => ({ status: 1, stdout: '', stderr: 'no remote' }),
    });
    expect(fallback).toBe(DEFAULT_REPO);
  });

  it('detects git user.email and returns null when unavailable', () => {
    expect(
      detectAuthorEmail({
        exec: () => ({ status: 0, stdout: 'contributor@example.invalid\n', stderr: '' }),
      }),
    ).toBe('contributor@example.invalid');

    expect(
      detectAuthorEmail({
        exec: () => ({ status: 1, stdout: '', stderr: '' }),
      }),
    ).toBeNull();
  });
});

describe('stall-watch detectActiveLocalWorker', () => {
  it('excludes self PID, self PPID, children of self, and stall-watch commands', () => {
    const pr = makePr({ number: 1291, headRefName: 'feat/sample-1291' });
    const procs = [
      { pid: 500, ppid: 400, command: 'node scripts/harness/stall-watch.mjs --repo openlup/openlup feat/sample-1291' },
      { pid: 400, ppid: 1, command: 'codex run feat/sample-1291' }, // self PPID
      { pid: 501, ppid: 500, command: 'codex ps feat/sample-1291' }, // child of self
      { pid: 600, ppid: 1, command: 'node scripts/harness/stall-watch.mjs feat/sample-1291 #1291' }, // stall-watch cmd
    ];
    expect(detectActiveLocalWorker(pr, procs, 500, 400)).toBeNull();
  });

  it('detects active codex/claude/vitest worker matching branch or #pr', () => {
    const pr = makePr({ number: 1291, headRefName: 'feat/sample-1291' });
    const byBranch = detectActiveLocalWorker(
      pr,
      [{ pid: 901, ppid: 1, command: 'codex exec --branch feat/sample-1291' }],
      500,
      400,
    );
    expect(byBranch?.pid).toBe(901);

    const byPrNum = detectActiveLocalWorker(
      pr,
      [{ pid: 902, ppid: 1, command: 'claude work on #1291 review fixes' }],
      500,
      400,
    );
    expect(byPrNum?.pid).toBe(902);
  });

  it('requires token boundaries for branch matches so substring/prefix collisions do not suppress alerts', () => {
    const authPr = makePr({ number: 2001, headRefName: 'feat/auth' });
    expect(
      detectActiveLocalWorker(
        authPr,
        [
          { pid: 910, ppid: 1, command: 'codex exec --branch feat/auth-v2' },
          { pid: 911, ppid: 1, command: 'codex exec --branch my-feat/auth' },
          { pid: 912, ppid: 1, command: 'codex exec --branch feat/auth/extra' },
        ],
        500,
        400,
      ),
    ).toBeNull();

    expect(
      detectActiveLocalWorker(
        authPr,
        [{ pid: 913, ppid: 1, command: 'codex exec --cwd /repo/.worktrees/feat/auth' }],
        500,
        400,
      )?.pid,
    ).toBe(913);

    expect(
      detectActiveLocalWorker(
        authPr,
        [{ pid: 914, ppid: 1, command: 'claude "finish feat/auth"' }],
        500,
        400,
      )?.pid,
    ).toBe(914);

    const testPr = makePr({ number: 2002, headRefName: 'test' });
    expect(
      detectActiveLocalWorker(
        testPr,
        [{ pid: 915, ppid: 1, command: 'node node_modules/.bin/vitest run' }],
        500,
        400,
      ),
    ).toBeNull();
  });
});

describe('stall-watch classifyPullRequest deterministic order', () => {
  it('1. skips held-for-release PRs', () => {
    const res = classifyPullRequest(
      makePr({ labels: ['held-for-release'] }),
      { now: () => NOW },
    );
    expect(res.code).toBe('SKIP_HELD');
    expect(res.isAlert).toBe(false);
  });

  it('2. skips healthy mergeQueueEntry and alerts when stuck > queueStaleMinutes or UNMERGEABLE', () => {
    const queuedFresh = classifyPullRequest(
      makePr({
        mergeQueueEntry: { state: 'AWAITING_CHECKS', enqueuedAt: '2026-11-27T11:30:00Z', position: 1 },
      }),
      { now: () => NOW, queueStaleMinutes: 60 },
    );
    expect(queuedFresh.code).toBe('SKIP_QUEUED');

    const queuedStuck = classifyPullRequest(
      makePr({
        mergeQueueEntry: { state: 'AWAITING_CHECKS', enqueuedAt: '2026-11-27T10:30:00Z', position: 1 },
      }),
      { now: () => NOW, queueStaleMinutes: 60 },
    );
    expect(queuedStuck.code).toBe('ALERT_QUEUE_STUCK');
    expect(queuedStuck.isAlert).toBe(true);

    const unmergeable = classifyPullRequest(
      makePr({
        mergeQueueEntry: { state: 'UNMERGEABLE', enqueuedAt: '2026-11-27T11:58:00Z', position: 1 },
      }),
      { now: () => NOW, queueStaleMinutes: 60 },
    );
    expect(unmergeable.code).toBe('ALERT_QUEUE_STUCK');
  });

  it('3. skips drafts by default, alerts ALERT_DRAFT_STALE when --include-drafts and > 180m', () => {
    const oldDraft = makePr({ isDraft: true, lastActivityAt: '2026-11-27T08:00:00Z' });
    expect(classifyPullRequest(oldDraft, { now: () => NOW }).code).toBe('SKIP_DRAFT');
    expect(
      classifyPullRequest(oldDraft, { now: () => NOW, includeDrafts: true }).code,
    ).toBe('ALERT_DRAFT_STALE');
  });

  it('4. skips PR with active local worker', () => {
    const res = classifyPullRequest(makePr(), {
      now: () => NOW,
      processList: [{ pid: 777, ppid: 1, command: 'vitest run feat/sample-1291' }],
      selfPid: 500,
      selfPpid: 400,
    });
    expect(res.code).toBe('SKIP_ACTIVE_LOCAL');
    expect(res.worker?.pid).toBe(777);
  });

  it('5. emits immediate ALERT_READY_UNARMED (0m age) with optional detected author email', () => {
    const withEmail = classifyPullRequest(
      makePr({ lastActivityAt: '2026-11-27T11:59:30Z' }),
      { now: () => NOW, staleMinutes: 30, authorEmail: 'contributor@example.invalid' },
    );
    expect(withEmail.code).toBe('ALERT_READY_UNARMED');
    expect(withEmail.isAlert).toBe(true);
    expect(withEmail.suggestedCommand).toBe(
      `gh pr merge 1291 --auto --match-head-commit ${SHA1} --author-email contributor@example.invalid`,
    );

    const withoutEmail = classifyPullRequest(
      makePr({ lastActivityAt: '2026-11-27T11:59:30Z' }),
      { now: () => NOW, staleMinutes: 30, authorEmail: null },
    );
    expect(withoutEmail.suggestedCommand).toBe(
      `gh pr merge 1291 --auto --match-head-commit ${SHA1}`,
    );
  });

  it('6. emits ALERT_UNRESOLVED_THREADS when CI is green but threads remain unresolved', () => {
    const res = classifyPullRequest(
      makePr({ unresolvedThreads: 2, mergeStateStatus: 'BLOCKED' }),
      { now: () => NOW },
    );
    expect(res.code).toBe('ALERT_UNRESOLVED_THREADS');
    expect(res.isAlert).toBe(true);
  });

  it('7. skips when CI rollup is PENDING or EXPECTED', () => {
    expect(
      classifyPullRequest(makePr({ rollupState: 'PENDING', mergeStateStatus: 'BLOCKED' }), { now: () => NOW }).code,
    ).toBe('SKIP_CI_RUNNING');
    expect(
      classifyPullRequest(makePr({ rollupState: 'EXPECTED', mergeStateStatus: 'BLOCKED' }), { now: () => NOW }).code,
    ).toBe('SKIP_CI_RUNNING');
  });

  it('8-10. honors ack per (pr, headRefOid) including short-SHA prefix and invalidates ack on new SHA', () => {
    const dir = makeTmpDir();
    const ackFile = path.join(dir, 'acks.json');
    saveAck(ackFile, 1291, SHA1, () => NOW);

    // Same SHA -> SKIP_ACKED
    const reportAcked = evaluateStallWatch({
      repo: 'openlup/openlup',
      authorEmail: null,
      ackFile,
      checkDefaultInbox: false,
      now: () => NOW,
      pullRequests: [
        makePr({
          headRefOid: SHA1,
          rollupState: 'FAILURE',
          mergeStateStatus: 'BLOCKED',
          lastActivityAt: '2026-11-27T11:00:00Z',
        }),
      ],
      processList: [],
    });
    expect(reportAcked.exitCode).toBe(0);
    expect(reportAcked.skipped[0].code).toBe('SKIP_ACKED');

    // New push (SHA2) -> ack invalidated -> ALERT_CI_FAILED_STALE
    const reportNewPush = evaluateStallWatch({
      repo: 'openlup/openlup',
      authorEmail: null,
      ackFile,
      checkDefaultInbox: false,
      now: () => NOW,
      pullRequests: [
        makePr({
          headRefOid: SHA2,
          rollupState: 'FAILURE',
          mergeStateStatus: 'BLOCKED',
          lastActivityAt: '2026-11-27T11:00:00Z',
        }),
      ],
      processList: [],
    });
    expect(reportNewPush.exitCode).toBe(2);
    expect(reportNewPush.alerts[0].code).toBe('ALERT_CI_FAILED_STALE');

    // Short-SHA prefix ack (12 chars) matches full 40-char headRefOid
    saveAck(ackFile, 1291, SHA2.slice(0, 12), () => NOW);
    const reportShortAck = evaluateStallWatch({
      repo: 'openlup/openlup',
      authorEmail: null,
      ackFile,
      checkDefaultInbox: false,
      now: () => NOW,
      pullRequests: [
        makePr({
          headRefOid: SHA2,
          rollupState: 'FAILURE',
          mergeStateStatus: 'BLOCKED',
          lastActivityAt: '2026-11-27T11:00:00Z',
        }),
      ],
      processList: [],
    });
    expect(reportShortAck.exitCode).toBe(0);
    expect(reportShortAck.skipped[0].code).toBe('SKIP_ACKED');
  });

  it('integrates stale unread inbox messages as ALERT_INBOX_UNREAD', () => {
    const dir = makeTmpDir();
    const inboxDir = path.join(dir, 'inbox');
    postMessage({
      dir: inboxDir,
      to: 'lane-a',
      from: 'coordinator',
      kind: 'needs-decision',
      subject: 'Blocked on schema choice',
      now: () => new Date('2026-11-27T11:00:00Z'),
    });

    const report = evaluateStallWatch({
      repo: 'openlup/openlup',
      authorEmail: null,
      ackFile: path.join(dir, 'acks.json'),
      inboxDir,
      staleMinutes: 30,
      now: () => NOW,
      pullRequests: [],
      processList: [],
    });
    expect(report.exitCode).toBe(2);
    expect(report.inboxAlerts).toHaveLength(1);
    expect(report.alerts[0].code).toBe('ALERT_INBOX_UNREAD');
    expect(report.alerts[0].lane).toBe('lane-a');
  });
});

describe('stall-watch CLI parser (fail-closed)', () => {
  it('rejects invalid repo, bad --ack format, bad numbers, and unknown flags', () => {
    expect(() => parseStallWatchArgs(['--repo', 'not-a-repo'])).toThrow(/Invalid repository/);
    expect(() => parseStallWatchArgs(['--ack', '123'])).toThrow(/Invalid --ack/);
    expect(() => parseStallWatchArgs(['--stale-minutes', 'abc'])).toThrow(/Invalid integer/);
    expect(() => parseStallWatchArgs(['--unknown-flag'])).toThrow(/Unknown or invalid/);
  });
});
