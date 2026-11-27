import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ackMessage,
  inboxStatus,
  parseInboxArgs,
  pollInbox,
  postMessage,
  validateLaneName,
  withLaneLock,
} from './inbox.mjs';

const tempDirs: string[] = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlup-inbox-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('inbox lane name validation', () => {
  it('accepts valid lane names and rejects path traversal / invalid chars', () => {
    expect(validateLaneName('lane-a')).toBe('lane-a');
    expect(validateLaneName('w2.review_01')).toBe('w2.review_01');
    expect(() => validateLaneName('../etc')).toThrow(/Invalid lane/);
    expect(() => validateLaneName('LaneA')).toThrow(/Invalid lane/);
    expect(() => validateLaneName('-leading-dash')).toThrow(/Invalid lane/);
    expect(() => validateLaneName('a/b')).toThrow(/Invalid lane/);
    expect(() => validateLaneName('')).toThrow(/Invalid lane/);
  });
});

describe('inbox post / poll / ack / status', () => {
  it('posts messages, polls with filters, and acks idempotently', () => {
    const dir = makeTmpDir();
    const t0 = new Date('2026-11-27T10:00:00Z');
    const t1 = new Date('2026-11-27T10:05:00Z');

    const m1 = postMessage({
      dir,
      to: 'lane-a',
      from: 'coordinator',
      kind: 'needs-decision',
      subject: 'Approve rebase strategy',
      pr: 1206,
      head: 'abcdef1234567',
      body: 'Need go/no-go',
      now: () => t0,
    });
    const m2 = postMessage({
      dir,
      to: 'lane-a',
      from: 'lane-b',
      kind: 'handoff',
      subject: 'Ready for review',
      now: () => t1,
    });

    const all = pollInbox({ dir, lane: 'lane-a' });
    expect(all.total).toBe(2);
    expect(all.unread).toBe(2);

    const onlyHandoff = pollInbox({ dir, lane: 'lane-a', kind: 'handoff' });
    expect(onlyHandoff.messages).toHaveLength(1);
    expect(onlyHandoff.messages[0].id).toBe(m2.id);

    // Ack m1
    const ack1 = ackMessage({
      dir,
      lane: 'lane-a',
      id: m1.id,
      by: 'lane-a-lead',
      note: 'Approved',
      now: () => new Date('2026-11-27T10:10:00Z'),
    });
    expect(ack1.alreadyAcked).toBe(false);

    // Second ack is idempotent
    const ack2 = ackMessage({
      dir,
      lane: 'lane-a',
      id: m1.id,
      by: 'lane-a-lead',
    });
    expect(ack2.alreadyAcked).toBe(true);
    expect(ack2.ack.id).toBe(ack1.ack.id);

    const unreadOnly = pollInbox({ dir, lane: 'lane-a', unreadOnly: true });
    expect(unreadOnly.total).toBe(2);
    expect(unreadOnly.unread).toBe(1);
    expect(unreadOnly.messages).toHaveLength(1);
    expect(unreadOnly.messages[0].id).toBe(m2.id);

    // Ack unknown message fails closed
    expect(() =>
      ackMessage({ dir, lane: 'lane-a', id: 'msg_nonexistent', by: 'lead' }),
    ).toThrow(/not found/);
  });

  it('computes stale unread counts in status', () => {
    const dir = makeTmpDir();
    postMessage({
      dir,
      to: 'lane-a',
      from: 'coord',
      kind: 'alert',
      subject: 'Old unread',
      now: () => new Date('2026-11-27T09:00:00Z'),
    });
    postMessage({
      dir,
      to: 'lane-a',
      from: 'coord',
      kind: 'handoff',
      subject: 'Fresh unread',
      now: () => new Date('2026-11-27T09:50:00Z'),
    });

    const st = inboxStatus({
      dir,
      staleMinutes: 30,
      now: () => new Date('2026-11-27T10:00:00Z'),
    });
    expect(st.totalMessages).toBe(2);
    expect(st.totalUnread).toBe(2);
    expect(st.staleUnread).toHaveLength(1);
    expect(st.staleUnread[0].subject).toBe('Old unread');
    expect(st.staleUnread[0].ageMinutes).toBe(60);
  });

  it('recovers stale lock older than 30s (including on final attempt) and fails closed on fresh active lock', () => {
    const dir = makeTmpDir();
    const lockPath = path.join(dir, 'lane-lock.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: '2026-11-27T09:00:00Z' }));
    const oldTime = new Date('2026-11-27T09:00:00Z');
    fs.utimesSync(lockPath, oldTime, oldTime);

    // Stale lock (> 30s) should be recovered automatically even with maxAttempts: 1
    let ran = false;
    withLaneLock(
      dir,
      'lane-lock',
      () => {
        ran = true;
      },
      { now: () => new Date('2026-11-27T09:01:00Z'), staleLockMs: 30_000, maxAttempts: 1 },
    );
    expect(ran).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);

    // Fresh lock (< 30s) should time out and fail closed
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));
    const freshNow = new Date();
    expect(() =>
      withLaneLock(dir, 'lane-lock', () => {}, {
        now: () => freshNow,
        staleLockMs: 30_000,
        maxAttempts: 2,
        retryDelayMs: 5,
      }),
    ).toThrow(/Failed to acquire lock/);

    // Bounded stale-lock recovery cap prevents unbounded retries
    fs.utimesSync(lockPath, oldTime, oldTime);
    expect(() =>
      withLaneLock(dir, 'lane-lock', () => {}, {
        now: () => new Date('2026-11-27T09:01:00Z'),
        staleLockMs: 30_000,
        maxAttempts: 1,
        maxStaleRecoveries: 0,
        retryDelayMs: 1,
      }),
    ).toThrow(/Failed to acquire lock/);
  });

  it('fails closed on corrupt JSONL lines', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'lane-bad.jsonl'), '{broken json\n', 'utf8');
    expect(() => pollInbox({ dir, lane: 'lane-bad' })).toThrow(/Corrupt JSONL/);
  });
});

describe('inbox CLI parser (fail-closed)', () => {
  it('rejects unknown flags, invalid kinds, and missing required flags', () => {
    expect(() => parseInboxArgs([])).toThrow(/Missing subcommand/);
    expect(() => parseInboxArgs(['drop'])).toThrow(/Unknown subcommand/);
    expect(() => parseInboxArgs(['post', '--to', 'lane-a'])).toThrow(/post requires/);
    expect(() =>
      parseInboxArgs([
        'post',
        '--to', 'lane-a',
        '--from', 'coord',
        '--kind', 'invalid-kind',
        '--subject', 'Hi',
      ]),
    ).toThrow(/Invalid kind/);
    expect(() =>
      parseInboxArgs([
        'post',
        '--to', '../escape',
        '--from', 'coord',
        '--kind', 'alert',
        '--subject', 'Hi',
      ]),
    ).toThrow(/Invalid to/);
    expect(() => parseInboxArgs(['poll', '--for', 'lane-a', '--bogus'])).toThrow(/Unknown flag/);
    expect(() => parseInboxArgs(['ack', '--for', 'lane-a'])).toThrow(/ack requires --id/);
  });
});
