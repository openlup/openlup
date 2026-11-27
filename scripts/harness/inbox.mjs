#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env as processEnvironment } from 'node:process';
import { isDirectCliInvocation } from './exec.mjs';

export const DEFAULT_INBOX_DIR =
  processEnvironment.OPENLUP_INBOX_DIR ||
  path.join(process.cwd(), '.context', 'scratch', 'harness', 'inbox');

export const LANE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const VALID_KINDS = new Set([
  'decision',
  'needs-decision',
  'handoff',
  'alert',
  'ack',
]);
export const STALE_LOCK_MS = 30_000;

const POSITIVE_INT_RE = /^[1-9]\d*$/;
const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i;
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

const USAGE = `Usage:
  npm run lane:inbox -- post --to <lane> --from <sender> --kind <decision|needs-decision|handoff|alert|ack> \\
    --subject "<text>" [--pr <num>] [--head <sha>] [--body "<text>" | --body-file <path>] [--dir <path>] [--json]
  npm run lane:inbox -- poll --for <lane> [--unread-only] [--kind <kind>] [--dir <path>] [--json]
  npm run lane:inbox -- ack --for <lane> --id <msg-id> [--by <actor>] [--note "<text>"] [--dir <path>] [--json]
  npm run lane:inbox -- status [--stale-minutes 30] [--dir <path>] [--json]
`;

function sleepSync(ms) {
  if (ms > 0) {
    Atomics.wait(SLEEP_BUF, 0, 0, ms);
  }
}

export function validateLaneName(lane, field = 'lane') {
  if (typeof lane !== 'string' || !LANE_NAME_RE.test(lane)) {
    throw new Error(
      `Invalid ${field} name "${lane}". Must match ${LANE_NAME_RE.toString()}`,
    );
  }
  return lane;
}

export function validateKind(kind) {
  if (typeof kind !== 'string' || !VALID_KINDS.has(kind)) {
    throw new Error(
      `Invalid kind "${kind}". Expected one of: ${[...VALID_KINDS].join(', ')}`,
    );
  }
  return kind;
}

export function withLaneLock(dir, lane, fn, options = {}) {
  validateLaneName(lane);
  const {
    now = () => new Date(),
    staleLockMs = STALE_LOCK_MS,
    maxAttempts = 40,
    maxStaleRecoveries = 3,
    retryDelayMs = 25,
  } = options;

  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, `${lane}.lock`);
  let acquired = false;
  let staleRecoveries = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      let wrote = false;
      try {
        const payload = JSON.stringify({
          pid: process.pid,
          ts: now().toISOString(),
        });
        fs.writeSync(fd, `${payload}\n`, null, 'utf8');
        wrote = true;
      } finally {
        fs.closeSync(fd);
        if (!wrote) {
          try {
            fs.unlinkSync(lockPath);
          } catch (unlinkErr) {
            if (unlinkErr?.code !== 'ENOENT') throw unlinkErr;
          }
        }
      }
      acquired = true;
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        throw err;
      }

      // Check for stale lock (> staleLockMs), bounded by maxStaleRecoveries
      try {
        const stat = fs.statSync(lockPath);
        const ageMs = now().getTime() - stat.mtimeMs;
        if (ageMs > staleLockMs && staleRecoveries < maxStaleRecoveries) {
          staleRecoveries += 1;
          try {
            fs.unlinkSync(lockPath);
          } catch (unlinkErr) {
            if (unlinkErr?.code !== 'ENOENT') throw unlinkErr;
          }
          if (attempt === maxAttempts) {
            // Reclaim stale lock on final attempt so we don't exit without trying openSync
            attempt -= 1;
          }
          continue;
        }
      } catch (statErr) {
        if (statErr?.code === 'ENOENT') {
          continue;
        }
        throw statErr;
      }

      if (attempt < maxAttempts) {
        sleepSync(Math.min(retryDelayMs * attempt, 250));
      }
    }
  }

  if (!acquired) {
    throw new Error(
      `Failed to acquire lock for lane "${lane}" at ${lockPath} after ${maxAttempts} attempts`,
    );
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
}

export function readLaneJournal(dir, lane) {
  validateLaneName(lane);
  const filePath = path.join(dir, `${lane}.jsonl`);
  if (!fs.existsSync(filePath)) {
    return { messages: [], acks: [] };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const rawMessages = [];
  const acks = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `Corrupt JSONL in ${filePath} at line ${idx + 1}: ${err.message}`,
      );
    }
    if (parsed?.type === 'message') {
      rawMessages.push(parsed);
    } else if (parsed?.type === 'ack') {
      acks.push(parsed);
    } else {
      throw new Error(
        `Unknown journal entry type "${parsed?.type}" in ${filePath} at line ${idx + 1}`,
      );
    }
  }

  const acksByRef = new Map();
  for (const ack of acks) {
    const list = acksByRef.get(ack.refId) ?? [];
    list.push(ack);
    acksByRef.set(ack.refId, list);
  }

  const messages = rawMessages.map((msg) => {
    const msgAcks = acksByRef.get(msg.id) ?? [];
    return {
      ...msg,
      acked: msgAcks.length > 0,
      acks: msgAcks,
    };
  });

  return { messages, acks };
}

export function postMessage(options = {}) {
  const {
    dir = DEFAULT_INBOX_DIR,
    to,
    from,
    kind,
    subject,
    pr = null,
    head = null,
    body = '',
    now = () => new Date(),
    lockOptions = {},
  } = options;

  validateLaneName(to, 'to');
  if (typeof from !== 'string' || from.trim() === '' || /[\r\n]/.test(from)) {
    throw new Error('Invalid "from": must be a non-empty single-line string');
  }
  validateKind(kind);
  if (typeof subject !== 'string' || subject.trim() === '') {
    throw new Error('Invalid "subject": must be a non-empty string');
  }

  let prNum = null;
  if (pr !== null && pr !== undefined) {
    if (!POSITIVE_INT_RE.test(String(pr))) {
      throw new Error(`Invalid PR number: ${pr}`);
    }
    prNum = Number(pr);
  }

  let headSha = null;
  if (head !== null && head !== undefined) {
    if (typeof head !== 'string' || !HEX_SHA_RE.test(head.trim())) {
      throw new Error(`Invalid head SHA: ${head}`);
    }
    headSha = head.trim();
  }

  const timestamp = now();
  const entry = {
    type: 'message',
    id: `msg_${timestamp.getTime()}_${crypto.randomBytes(4).toString('hex')}`,
    ts: timestamp.toISOString(),
    to,
    from: from.trim(),
    kind,
    subject: subject.trim(),
    pr: prNum,
    head: headSha,
    body: typeof body === 'string' ? body : String(body ?? ''),
  };

  withLaneLock(
    dir,
    to,
    () => {
      const filePath = path.join(dir, `${to}.jsonl`);
      fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    },
    { now, ...lockOptions },
  );

  return entry;
}

export function pollInbox(options = {}) {
  const {
    dir = DEFAULT_INBOX_DIR,
    lane,
    unreadOnly = false,
    kind = null,
  } = options;

  validateLaneName(lane, 'for');
  if (kind !== null && kind !== undefined) {
    validateKind(kind);
  }

  const { messages } = readLaneJournal(dir, lane);
  const unreadCount = messages.filter((m) => !m.acked).length;

  let filtered = messages;
  if (unreadOnly) {
    filtered = filtered.filter((m) => !m.acked);
  }
  if (kind !== null && kind !== undefined) {
    filtered = filtered.filter((m) => m.kind === kind);
  }

  return {
    lane,
    dir,
    total: messages.length,
    unread: unreadCount,
    messages: filtered,
  };
}

export function ackMessage(options = {}) {
  const {
    dir = DEFAULT_INBOX_DIR,
    lane,
    id,
    by = 'unknown',
    note = '',
    now = () => new Date(),
    lockOptions = {},
  } = options;

  validateLaneName(lane, 'for');
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('Invalid message id: must be a non-empty string');
  }
  if (typeof by !== 'string' || by.trim() === '') {
    throw new Error('Invalid "by" actor: must be a non-empty string');
  }

  return withLaneLock(
    dir,
    lane,
    () => {
      const { messages } = readLaneJournal(dir, lane);
      const target = messages.find((m) => m.id === id);
      if (!target) {
        throw new Error(`Message "${id}" not found in lane "${lane}"`);
      }

      if (target.acked) {
        return {
          alreadyAcked: true,
          lane,
          refId: id,
          ack: target.acks[0],
        };
      }

      const timestamp = now();
      const ackEntry = {
        type: 'ack',
        id: `ack_${timestamp.getTime()}_${crypto.randomBytes(4).toString('hex')}`,
        ts: timestamp.toISOString(),
        refId: id,
        by: by.trim(),
        note: typeof note === 'string' ? note : String(note ?? ''),
      };

      const filePath = path.join(dir, `${lane}.jsonl`);
      fs.appendFileSync(filePath, `${JSON.stringify(ackEntry)}\n`, 'utf8');

      return {
        alreadyAcked: false,
        lane,
        refId: id,
        ack: ackEntry,
      };
    },
    { now, ...lockOptions },
  );
}

export function inboxStatus(options = {}) {
  const {
    dir = DEFAULT_INBOX_DIR,
    staleMinutes = 30,
    now = () => new Date(),
  } = options;

  if (typeof staleMinutes !== 'number' || Number.isNaN(staleMinutes) || staleMinutes < 0) {
    throw new Error(`Invalid staleMinutes: ${staleMinutes}`);
  }

  if (!fs.existsSync(dir)) {
    return {
      dir,
      exists: false,
      staleMinutes,
      lanes: [],
      totalMessages: 0,
      totalUnread: 0,
      staleUnread: [],
    };
  }

  const nowMs = now().getTime();
  const staleMs = staleMinutes * 60_000;
  const entries = fs.readdirSync(dir).sort();
  const lanes = [];
  const staleUnread = [];
  let totalMessages = 0;
  let totalUnread = 0;

  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const lane = name.slice(0, -'.jsonl'.length);
    if (!LANE_NAME_RE.test(lane)) continue;

    const { messages } = readLaneJournal(dir, lane);
    const unreadMsgs = messages.filter((m) => !m.acked);
    totalMessages += messages.length;
    totalUnread += unreadMsgs.length;

    let laneStaleCount = 0;
    for (const msg of unreadMsgs) {
      const msgMs = Date.parse(msg.ts);
      const ageMs = Number.isNaN(msgMs) ? Infinity : Math.max(0, nowMs - msgMs);
      if (ageMs >= staleMs) {
        laneStaleCount += 1;
        staleUnread.push({
          lane,
          id: msg.id,
          ts: msg.ts,
          from: msg.from,
          kind: msg.kind,
          subject: msg.subject,
          pr: msg.pr ?? null,
          head: msg.head ?? null,
          ageMinutes: Math.floor(ageMs / 60_000),
        });
      }
    }

    lanes.push({
      lane,
      total: messages.length,
      unread: unreadMsgs.length,
      staleUnread: laneStaleCount,
    });
  }

  return {
    dir,
    exists: true,
    staleMinutes,
    lanes,
    totalMessages,
    totalUnread,
    staleUnread,
  };
}

function requireVal(argv, i, flag) {
  if (i + 1 >= argv.length) {
    throw new Error(`Missing value for flag ${flag}`);
  }
  return argv[i + 1];
}

export function parseInboxArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('Missing subcommand. Expected: post | poll | ack | status');
  }

  const subcommand = argv[0];
  if (subcommand === '--help' || subcommand === '-h') {
    return { subcommand: 'help' };
  }

  if (!['post', 'poll', 'ack', 'status'].includes(subcommand)) {
    throw new Error(
      `Unknown subcommand "${subcommand}". Expected: post | poll | ack | status`,
    );
  }

  const opts = {
    subcommand,
    dir: DEFAULT_INBOX_DIR,
    json: false,
  };

  if (subcommand === 'post') {
    opts.to = null;
    opts.from = null;
    opts.kind = null;
    opts.subject = null;
    opts.pr = null;
    opts.head = null;
    opts.body = null;
    opts.bodyFile = null;
  } else if (subcommand === 'poll') {
    opts.lane = null;
    opts.unreadOnly = false;
    opts.kind = null;
  } else if (subcommand === 'ack') {
    opts.lane = null;
    opts.id = null;
    opts.by = 'unknown';
    opts.note = '';
  } else if (subcommand === 'status') {
    opts.staleMinutes = 30;
  }

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      return { subcommand: 'help' };
    }
    if (arg === '--dir') {
      opts.dir = requireVal(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }

    if (subcommand === 'post') {
      if (arg === '--to') {
        opts.to = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--from') {
        opts.from = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--kind') {
        opts.kind = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--subject') {
        opts.subject = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--pr') {
        const val = requireVal(argv, i, arg);
        if (!POSITIVE_INT_RE.test(val)) {
          throw new Error(`Invalid PR number for --pr: ${val}`);
        }
        opts.pr = Number(val);
        i += 1;
      } else if (arg === '--head') {
        opts.head = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--body') {
        opts.body = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--body-file') {
        opts.bodyFile = requireVal(argv, i, arg);
        i += 1;
      } else {
        throw new Error(`Unknown flag for post: ${arg}`);
      }
    } else if (subcommand === 'poll') {
      if (arg === '--for') {
        opts.lane = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--unread-only') {
        opts.unreadOnly = true;
      } else if (arg === '--kind') {
        opts.kind = requireVal(argv, i, arg);
        i += 1;
      } else {
        throw new Error(`Unknown flag for poll: ${arg}`);
      }
    } else if (subcommand === 'ack') {
      if (arg === '--for') {
        opts.lane = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--id') {
        opts.id = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--by') {
        opts.by = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--note') {
        opts.note = requireVal(argv, i, arg);
        i += 1;
      } else {
        throw new Error(`Unknown flag for ack: ${arg}`);
      }
    } else if (subcommand === 'status') {
      if (arg === '--stale-minutes') {
        const val = requireVal(argv, i, arg);
        if (!/^\d+$/.test(val)) {
          throw new Error(`Invalid integer for --stale-minutes: ${val}`);
        }
        opts.staleMinutes = Number(val);
        i += 1;
      } else {
        throw new Error(`Unknown flag for status: ${arg}`);
      }
    }
  }

  // Validate required fields per subcommand
  if (subcommand === 'post') {
    if (!opts.to) throw new Error('post requires --to <lane>');
    if (!opts.from) throw new Error('post requires --from <sender>');
    if (!opts.kind) throw new Error('post requires --kind <kind>');
    if (!opts.subject) throw new Error('post requires --subject "<text>"');
    if (opts.body !== null && opts.bodyFile !== null) {
      throw new Error('Cannot specify both --body and --body-file');
    }
    validateLaneName(opts.to, 'to');
    validateKind(opts.kind);
  } else if (subcommand === 'poll') {
    if (!opts.lane) throw new Error('poll requires --for <lane>');
    validateLaneName(opts.lane, 'for');
    if (opts.kind !== null) validateKind(opts.kind);
  } else if (subcommand === 'ack') {
    if (!opts.lane) throw new Error('ack requires --for <lane>');
    if (!opts.id) throw new Error('ack requires --id <msg-id>');
    validateLaneName(opts.lane, 'for');
  }

  return opts;
}

function main() {
  let opts;
  try {
    opts = parseInboxArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`lane:inbox: ${err.message}\n\n${USAGE}`);
    process.exit(1);
  }

  if (opts.subcommand === 'help') {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  try {
    if (opts.subcommand === 'post') {
      const body = opts.bodyFile !== null
        ? fs.readFileSync(opts.bodyFile, 'utf8')
        : (opts.body ?? '');
      const entry = postMessage({
        dir: opts.dir,
        to: opts.to,
        from: opts.from,
        kind: opts.kind,
        subject: opts.subject,
        pr: opts.pr,
        head: opts.head,
        body,
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
      } else {
        process.stdout.write(`Posted ${entry.id} -> ${entry.to} [${entry.kind}]: ${entry.subject}\n`);
      }
      process.exit(0);
    }

    if (opts.subcommand === 'poll') {
      const res = pollInbox({
        dir: opts.dir,
        lane: opts.lane,
        unreadOnly: opts.unreadOnly,
        kind: opts.kind,
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      } else {
        process.stdout.write(`Lane ${res.lane}: ${res.unread} unread / ${res.total} total\n`);
        for (const msg of res.messages) {
          const state = msg.acked ? 'ACKED' : 'UNREAD';
          const prSuffix = msg.pr ? ` (PR #${msg.pr})` : '';
          process.stdout.write(`- [${state}] ${msg.id} ${msg.ts} [${msg.kind}] from ${msg.from}${prSuffix}: ${msg.subject}\n`);
          if (msg.body) {
            process.stdout.write(`    ${msg.body.replace(/\n/g, '\n    ')}\n`);
          }
        }
      }
      process.exit(0);
    }

    if (opts.subcommand === 'ack') {
      const res = ackMessage({
        dir: opts.dir,
        lane: opts.lane,
        id: opts.id,
        by: opts.by,
        note: opts.note,
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      } else if (res.alreadyAcked) {
        process.stdout.write(`Already acked ${res.refId} in lane ${res.lane} (ack ${res.ack.id})\n`);
      } else {
        process.stdout.write(`Acked ${res.refId} in lane ${res.lane} (${res.ack.id} by ${res.ack.by})\n`);
      }
      process.exit(0);
    }

    if (opts.subcommand === 'status') {
      const res = inboxStatus({
        dir: opts.dir,
        staleMinutes: opts.staleMinutes,
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      } else {
        process.stdout.write(
          `Inbox ${res.dir}: ${res.lanes.length} lane(s), ${res.totalUnread} unread (${res.staleUnread.length} stale >= ${res.staleMinutes}m)\n`,
        );
        for (const lane of res.lanes) {
          process.stdout.write(
            `- ${lane.lane}: ${lane.unread} unread / ${lane.total} total (${lane.staleUnread} stale)\n`,
          );
        }
      }
      process.exit(0);
    }
  } catch (err) {
    process.stderr.write(`lane:inbox: ${err.message}\n`);
    process.exit(1);
  }
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  main();
}
