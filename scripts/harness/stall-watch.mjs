#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { env as processEnvironment } from 'node:process';
import { execCommand, isDirectCliInvocation } from './exec.mjs';
import { DEFAULT_INBOX_DIR, inboxStatus } from './inbox.mjs';

export const DEFAULT_REPO = 'openlup/openlup';
export const DEFAULT_ACK_FILE =
  processEnvironment.OPENLUP_STALL_ACK_FILE ||
  path.join(process.cwd(), '.context', 'scratch', 'harness', 'stall-acks.json');

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_REMOTE_RE = /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i;
const ACK_TOKEN_RE = /^([1-9]\d*):([0-9a-f]{7,40})$/i;
const WORKER_TOOL_RE = /\b(codex|claude|vitest|agent-review)\b|npm\s+run\b/i;

const USAGE = `Usage:
  npm run pr:watch -- [--repo owner/name] [--stale-minutes 30] [--queue-stale-minutes 60] \\
    [--ignore-label held-for-release] [--ack-file <path>] [--ack <pr>:<sha>] \\
    [--inbox-dir <path>] [--include-drafts] [--json]

Exit codes:
  0  No alerts
  2  One or more ALERT_* findings
  1  Tool / GitHub API / argument error (fail-closed)
`;

export const OPEN_PRS_GRAPHQL_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        title
        url
        isDraft
        createdAt
        updatedAt
        headRefName
        headRefOid
        baseRefName
        mergeStateStatus
        labels(first: 20) {
          nodes {
            name
          }
        }
        autoMergeRequest {
          enabledAt
          mergeMethod
        }
        mergeQueueEntry {
          state
          enqueuedAt
          position
        }
        reviewThreads(first: 100) {
          nodes {
            isResolved
            isOutdated
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              oid
              committedDate
              statusCheckRollup {
                state
              }
            }
          }
        }
      }
    }
  }
}
`.trim();

export function parseGithubRepoFromRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string') return null;
  const match = GITHUB_REMOTE_RE.exec(remoteUrl.trim());
  if (!match) return null;
  const repo = match[1];
  return REPO_RE.test(repo) ? repo : null;
}

export function detectDefaultRepo({ cwd = process.cwd(), exec = execCommand } = {}) {
  try {
    const res = exec('git', ['-C', cwd, 'remote', 'get-url', 'origin']);
    if (res.status === 0) {
      const parsed = parseGithubRepoFromRemoteUrl(res.stdout);
      if (parsed) return parsed;
    }
  } catch {
    // Fall back to DEFAULT_REPO when git remote lookup is unavailable.
  }
  return DEFAULT_REPO;
}

export function detectAuthorEmail({ cwd = process.cwd(), exec = execCommand } = {}) {
  try {
    const res = exec('git', ['-C', cwd, 'config', 'user.email']);
    if (res.status === 0) {
      const email = (res.stdout ?? '').trim();
      if (email && !/\s/.test(email)) return email;
    }
  } catch {
    // Omit --author-email when git user.email is unavailable.
  }
  return null;
}

export function validateRepo(repo) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    throw new Error(`Invalid repository "${repo}". Expected "owner/name"`);
  }
  const [owner, name] = repo.split('/');
  return { owner, name };
}

export function parseAckToken(token) {
  if (typeof token !== 'string' || !ACK_TOKEN_RE.test(token.trim())) {
    throw new Error(
      `Invalid --ack value "${token}". Expected "<pr-number>:<head-sha>"`,
    );
  }
  const [, prStr, sha] = ACK_TOKEN_RE.exec(token.trim());
  return { pr: Number(prStr), headRefOid: sha.toLowerCase() };
}

export function normalizePullRequestNode(node) {
  const labels = (node?.labels?.nodes ?? [])
    .map((l) => l?.name)
    .filter((n) => typeof n === 'string');

  const threads = node?.reviewThreads?.nodes ?? [];
  const unresolvedThreads = threads.filter((t) => t && t.isResolved === false).length;

  const lastCommit = node?.commits?.nodes?.[0]?.commit ?? null;
  const rollupState = lastCommit?.statusCheckRollup?.state ?? null;

  const timestamps = [
    node?.updatedAt,
    lastCommit?.committedDate,
    node?.mergeQueueEntry?.enqueuedAt,
    node?.createdAt,
  ]
    .map((ts) => (ts ? Date.parse(ts) : NaN))
    .filter((ms) => !Number.isNaN(ms));

  const lastActivityAt =
    timestamps.length > 0
      ? new Date(Math.max(...timestamps)).toISOString()
      : (node?.updatedAt ?? null);

  return {
    number: node.number,
    title: node.title ?? '',
    url: node.url ?? '',
    isDraft: Boolean(node.isDraft),
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null,
    lastActivityAt,
    headRefName: node.headRefName ?? '',
    headRefOid: (node.headRefOid ?? '').toLowerCase(),
    baseRefName: node.baseRefName ?? '',
    mergeStateStatus: node.mergeStateStatus ?? 'UNKNOWN',
    labels,
    autoMergeRequest: node.autoMergeRequest ?? null,
    mergeQueueEntry: node.mergeQueueEntry ?? null,
    unresolvedThreads,
    rollupState,
  };
}

export function fetchOpenPullRequests({ repo = DEFAULT_REPO, exec = execCommand } = {}) {
  const { owner, name } = validateRepo(repo);
  const res = exec('gh', [
    'api',
    'graphql',
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-f',
    `query=${OPEN_PRS_GRAPHQL_QUERY}`,
  ]);

  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || res.error?.message || '').trim();
    throw new Error(`GitHub GraphQL query failed (status ${res.status}): ${detail}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    throw new Error(`Failed to parse GraphQL response JSON: ${err.message}`);
  }

  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    const msgs = parsed.errors.map((e) => e?.message ?? JSON.stringify(e)).join('; ');
    throw new Error(`GitHub GraphQL errors: ${msgs}`);
  }

  const nodes = parsed?.data?.repository?.pullRequests?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error(`Unexpected GraphQL payload: missing repository.pullRequests.nodes for ${repo}`);
  }

  return nodes.map(normalizePullRequestNode);
}

export function parsePsOutput(stdout) {
  const list = [];
  for (const rawLine of String(stdout ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    list.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    });
  }
  return list;
}

export function getLocalProcessList({ exec = execCommand } = {}) {
  const res = exec('ps', ['-eo', 'pid=,ppid=,command=']);
  if (res.status !== 0) {
    const detail = (res.stderr || res.error?.message || '').trim();
    throw new Error(`Failed to list local processes via ps (status ${res.status}): ${detail}`);
  }
  return parsePsOutput(res.stdout);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detects an active local worker working on the given PR.
 * Strictly excludes self PID, self PPID, direct children of self, and any
 * command line referencing stall-watch to prevent self-match bugs.
 */
export function detectActiveLocalWorker(
  pr,
  processList = [],
  selfPid = process.pid,
  selfPpid = process.ppid,
) {
  const prTagRe = new RegExp(`#${pr.number}(?!\\d)`);
  const branch = pr.headRefName ? String(pr.headRefName).trim() : '';
  const branchTokenRe =
    branch.length > 0
      ? new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(branch)}(?![A-Za-z0-9._/-])`)
      : null;

  for (const proc of processList) {
    if (!proc || typeof proc.command !== 'string') continue;
    if (proc.pid === selfPid || proc.pid === selfPpid || proc.ppid === selfPid) {
      continue;
    }
    if (proc.command.includes('stall-watch')) {
      continue;
    }
    if (!WORKER_TOOL_RE.test(proc.command)) {
      continue;
    }

    const matchesBranch = branchTokenRe !== null && branchTokenRe.test(proc.command);
    const matchesPrNum = prTagRe.test(proc.command);
    if (matchesBranch || matchesPrNum) {
      return { pid: proc.pid, ppid: proc.ppid, command: proc.command };
    }
  }

  return null;
}

export function loadAcks(ackFile) {
  if (!ackFile || !fs.existsSync(ackFile)) {
    return new Map();
  }
  const raw = fs.readFileSync(ackFile, 'utf8').trim();
  if (!raw) return new Map();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Corrupt ack file ${ackFile}: ${err.message}`);
  }

  const map = new Map();
  const entries = parsed?.acks ?? parsed;
  if (entries && typeof entries === 'object') {
    for (const [key, val] of Object.entries(entries)) {
      map.set(key.toLowerCase(), val);
    }
  }
  return map;
}

export function saveAck(ackFile, prNumber, headRefOid, now = () => new Date()) {
  const key = `${prNumber}:${headRefOid.toLowerCase()}`;
  const map = loadAcks(ackFile);
  const record = {
    pr: prNumber,
    headRefOid: headRefOid.toLowerCase(),
    ackedAt: now().toISOString(),
  };
  map.set(key, record);

  const dir = path.dirname(ackFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${ackFile}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify({ acks: Object.fromEntries(map.entries()) }, null, 2);
  fs.writeFileSync(tmpPath, `${payload}\n`, 'utf8');
  fs.renameSync(tmpPath, ackFile);

  return { key, record, ackFile };
}

function ageMinutesSince(isoTs, nowMs) {
  if (!isoTs) return 0;
  const ms = Date.parse(isoTs);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.floor((nowMs - ms) / 60_000));
}

/**
 * Deterministic PR classification.
 */
export function classifyPullRequest(pr, ctx = {}) {
  const {
    now = () => new Date(),
    staleMinutes = 30,
    queueStaleMinutes = 60,
    draftStaleMinutes = 180,
    ignoreLabels = ['held-for-release'],
    includeDrafts = false,
    processList = [],
    selfPid = process.pid,
    selfPpid = process.ppid,
    acks = new Map(),
    authorEmail = null,
  } = ctx;

  const nowMs = now().getTime();
  const ageMinutes = ageMinutesSince(pr.lastActivityAt ?? pr.updatedAt, nowMs);
  const base = {
    pr: pr.number,
    title: pr.title,
    url: pr.url,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    ageMinutes,
  };

  // 1. Ignore labels (default: held-for-release)
  const ignoredLabel = pr.labels.find((l) => ignoreLabels.includes(l));
  if (ignoredLabel) {
    return {
      ...base,
      code: 'SKIP_HELD',
      isAlert: false,
      reason: `Labeled with ignored label "${ignoredLabel}"`,
    };
  }

  // 2. Merge queue entry
  if (pr.mergeQueueEntry != null) {
    const queueAgeMinutes = ageMinutesSince(
      pr.mergeQueueEntry.enqueuedAt ?? pr.lastActivityAt ?? pr.updatedAt,
      nowMs,
    );
    const queueState = pr.mergeQueueEntry.state ?? 'QUEUED';
    if (queueState === 'UNMERGEABLE' || queueAgeMinutes > queueStaleMinutes) {
      return {
        ...base,
        code: 'ALERT_QUEUE_STUCK',
        isAlert: true,
        queueState,
        queueAgeMinutes,
        reason:
          queueState === 'UNMERGEABLE'
            ? 'Merge queue entry is UNMERGEABLE'
            : `Merge queue entry stuck for ${queueAgeMinutes}m (> ${queueStaleMinutes}m, state=${queueState})`,
      };
    }
    return {
      ...base,
      code: 'SKIP_QUEUED',
      isAlert: false,
      queueState,
      queueAgeMinutes,
      reason: `In merge queue (state=${queueState}, ${queueAgeMinutes}m)`,
    };
  }

  // 3. Draft PR
  if (pr.isDraft) {
    if (includeDrafts && ageMinutes > draftStaleMinutes) {
      return {
        ...base,
        code: 'ALERT_DRAFT_STALE',
        isAlert: true,
        reason: `Draft PR inactive for ${ageMinutes}m (> ${draftStaleMinutes}m)`,
      };
    }
    return {
      ...base,
      code: 'SKIP_DRAFT',
      isAlert: false,
      reason: 'Draft PR',
    };
  }

  // 4. Active local worker
  const worker = detectActiveLocalWorker(pr, processList, selfPid, selfPpid);
  if (worker) {
    return {
      ...base,
      code: 'SKIP_ACTIVE_LOCAL',
      isAlert: false,
      worker,
      reason: `Active local worker PID ${worker.pid}`,
    };
  }

  // 5. Ready & unarmed -> immediate alert (no 30m wait)
  if (
    pr.autoMergeRequest === null &&
    pr.baseRefName === 'main' &&
    pr.mergeStateStatus === 'CLEAN' &&
    pr.unresolvedThreads === 0 &&
    pr.rollupState === 'SUCCESS'
  ) {
    const emailArg =
      typeof authorEmail === 'string' && authorEmail.trim() !== ''
        ? ` --author-email ${authorEmail.trim()}`
        : '';
    const suggestedCommand = `gh pr merge ${pr.number} --auto --match-head-commit ${pr.headRefOid}${emailArg}`;
    return {
      ...base,
      code: 'ALERT_READY_UNARMED',
      isAlert: true,
      suggestedCommand,
      reason: 'PR is CLEAN with green checks and 0 unresolved threads, but auto-merge is not armed',
    };
  }

  // 6. Unresolved review threads blocking Queue Handoff
  if (pr.unresolvedThreads > 0 && pr.rollupState === 'SUCCESS') {
    return {
      ...base,
      code: 'ALERT_UNRESOLVED_THREADS',
      isAlert: true,
      unresolvedThreads: pr.unresolvedThreads,
      reason: `${pr.unresolvedThreads} unresolved review thread(s) with green CI`,
    };
  }

  // 7. CI currently running
  if (pr.rollupState === 'PENDING' || pr.rollupState === 'EXPECTED') {
    return {
      ...base,
      code: 'SKIP_CI_RUNNING',
      isAlert: false,
      reason: `CI rollup state is ${pr.rollupState}`,
    };
  }

  // 8. Ack keyed by (pr, headRefOid) — supports full or >=7-char prefix SHA, automatically invalidated on new push
  const fullSha = (pr.headRefOid ?? '').toLowerCase();
  const prPrefix = `${pr.number}:`;
  let matchedAckKey = null;
  if (fullSha.length >= 7) {
    const exactKey = `${prPrefix}${fullSha}`;
    if (acks.has(exactKey)) {
      matchedAckKey = exactKey;
    } else {
      for (const key of acks.keys()) {
        if (!key.startsWith(prPrefix)) continue;
        const ackSha = key.slice(prPrefix.length);
        if (ackSha.length >= 7 && fullSha.startsWith(ackSha)) {
          matchedAckKey = key;
          break;
        }
      }
    }
  }
  if (matchedAckKey) {
    return {
      ...base,
      code: 'SKIP_ACKED',
      isAlert: false,
      ackKey: matchedAckKey,
      reason: `Acknowledged for ${matchedAckKey}`,
    };
  }

  // 9. CI failed & stale
  if (
    (pr.rollupState === 'FAILURE' || pr.rollupState === 'ERROR') &&
    ageMinutes >= staleMinutes
  ) {
    return {
      ...base,
      code: 'ALERT_CI_FAILED_STALE',
      isAlert: true,
      rollupState: pr.rollupState,
      reason: `CI ${pr.rollupState} and inactive for ${ageMinutes}m (>= ${staleMinutes}m)`,
    };
  }

  // 10. Remaining open non-draft PR stale
  if (ageMinutes >= staleMinutes) {
    return {
      ...base,
      code: 'ALERT_STALE_OPEN',
      isAlert: true,
      mergeStateStatus: pr.mergeStateStatus,
      rollupState: pr.rollupState,
      reason: `Open PR inactive for ${ageMinutes}m (>= ${staleMinutes}m)`,
    };
  }

  return {
    ...base,
    code: 'SKIP_FRESH',
    isAlert: false,
    reason: `Recently active (${ageMinutes}m < ${staleMinutes}m)`,
  };
}

export function evaluateStallWatch(options = {}) {
  const {
    repo = null,
    staleMinutes = 30,
    queueStaleMinutes = 60,
    draftStaleMinutes = 180,
    ignoreLabels = ['held-for-release'],
    ackFile = DEFAULT_ACK_FILE,
    inboxDir = null,
    checkDefaultInbox = true,
    includeDrafts = false,
    exec = execCommand,
    now = () => new Date(),
    selfPid = process.pid,
    selfPpid = process.ppid,
    pullRequests = null,
    processList = null,
    authorEmail = undefined,
  } = options;

  const resolvedRepo = repo ?? detectDefaultRepo({ exec });
  const resolvedAuthorEmail =
    authorEmail === undefined ? detectAuthorEmail({ exec }) : authorEmail;

  const prs = pullRequests ?? fetchOpenPullRequests({ repo: resolvedRepo, exec });
  const procs = processList ?? getLocalProcessList({ exec });
  const acks = loadAcks(ackFile);

  const results = prs.map((pr) =>
    classifyPullRequest(pr, {
      now,
      staleMinutes,
      queueStaleMinutes,
      draftStaleMinutes,
      ignoreLabels,
      includeDrafts,
      processList: procs,
      selfPid,
      selfPpid,
      acks,
      authorEmail: resolvedAuthorEmail,
    }),
  );

  const alerts = results.filter((r) => r.isAlert);
  const skipped = results.filter((r) => !r.isAlert);

  // Optional unread inbox integration
  const resolvedInboxDir =
    inboxDir ?? (checkDefaultInbox && fs.existsSync(DEFAULT_INBOX_DIR) ? DEFAULT_INBOX_DIR : null);

  const inboxAlerts = [];
  if (resolvedInboxDir) {
    const status = inboxStatus({ dir: resolvedInboxDir, staleMinutes, now });
    for (const item of status.staleUnread) {
      const alert = {
        code: 'ALERT_INBOX_UNREAD',
        isAlert: true,
        lane: item.lane,
        id: item.id,
        from: item.from,
        kind: item.kind,
        subject: item.subject,
        pr: item.pr,
        head: item.head,
        ageMinutes: item.ageMinutes,
        ts: item.ts,
        reason: `Unread ${item.kind} in lane "${item.lane}" from "${item.from}" (${item.ageMinutes}m >= ${staleMinutes}m): ${item.subject}`,
      };
      inboxAlerts.push(alert);
      alerts.push(alert);
    }
  }

  return {
    repo: resolvedRepo,
    checkedAt: now().toISOString(),
    openPullRequests: prs.length,
    alerts,
    skipped,
    inboxAlerts,
    exitCode: alerts.length > 0 ? 2 : 0,
  };
}

function requireVal(argv, i, flag) {
  if (i + 1 >= argv.length) {
    throw new Error(`Missing value for flag ${flag}`);
  }
  return argv[i + 1];
}

export function parseStallWatchArgs(argv) {
  const opts = {
    help: false,
    repo: null,
    staleMinutes: 30,
    queueStaleMinutes: 60,
    ignoreLabels: ['held-for-release'],
    customIgnoreLabels: false,
    ackFile: DEFAULT_ACK_FILE,
    ack: null,
    inboxDir: null,
    includeDrafts: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      return { ...opts, help: true };
    }
    if (arg === '--repo') {
      opts.repo = requireVal(argv, i, arg);
      validateRepo(opts.repo);
      i += 1;
    } else if (arg === '--stale-minutes') {
      const val = requireVal(argv, i, arg);
      if (!/^\d+$/.test(val)) {
        throw new Error(`Invalid integer for --stale-minutes: ${val}`);
      }
      opts.staleMinutes = Number(val);
      i += 1;
    } else if (arg === '--queue-stale-minutes') {
      const val = requireVal(argv, i, arg);
      if (!/^\d+$/.test(val)) {
        throw new Error(`Invalid integer for --queue-stale-minutes: ${val}`);
      }
      opts.queueStaleMinutes = Number(val);
      i += 1;
    } else if (arg === '--ignore-label') {
      const val = requireVal(argv, i, arg).trim();
      if (!val) throw new Error('Empty value for --ignore-label');
      if (!opts.customIgnoreLabels) {
        opts.ignoreLabels = [];
        opts.customIgnoreLabels = true;
      }
      for (const part of val.split(',').map((s) => s.trim()).filter(Boolean)) {
        opts.ignoreLabels.push(part);
      }
      i += 1;
    } else if (arg === '--ack-file') {
      opts.ackFile = requireVal(argv, i, arg);
      i += 1;
    } else if (arg === '--ack') {
      opts.ack = parseAckToken(requireVal(argv, i, arg));
      i += 1;
    } else if (arg === '--inbox-dir') {
      opts.inboxDir = requireVal(argv, i, arg);
      i += 1;
    } else if (arg === '--include-drafts') {
      opts.includeDrafts = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else {
      throw new Error(`Unknown or invalid argument: ${arg}`);
    }
  }

  return opts;
}

function printHuman(report) {
  process.stdout.write(
    `pr:watch (${report.repo}) @ ${report.checkedAt}: ${report.openPullRequests} open PR(s), ${report.alerts.length} alert(s), ${report.skipped.length} skipped\n`,
  );

  if (report.alerts.length > 0) {
    process.stdout.write('\nALERTS:\n');
    for (const a of report.alerts) {
      if (a.code === 'ALERT_INBOX_UNREAD') {
        process.stdout.write(`- [${a.code}] lane=${a.lane} id=${a.id}: ${a.reason}\n`);
      } else {
        process.stdout.write(`- [${a.code}] PR #${a.pr} (${a.headRefName}): ${a.reason}\n`);
        if (a.suggestedCommand) {
          process.stdout.write(`    run: ${a.suggestedCommand}\n`);
        }
      }
    }
  }

  if (report.skipped.length > 0) {
    process.stdout.write('\nSKIPPED:\n');
    for (const s of report.skipped) {
      process.stdout.write(`- [${s.code}] PR #${s.pr} (${s.headRefName}): ${s.reason}\n`);
    }
  }
}

function main() {
  let opts;
  try {
    opts = parseStallWatchArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`pr:watch: ${err.message}\n\n${USAGE}`);
    process.exit(1);
  }

  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  try {
    if (opts.ack) {
      const saved = saveAck(opts.ackFile, opts.ack.pr, opts.ack.headRefOid);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(saved, null, 2)}\n`);
      } else {
        process.stdout.write(`Recorded ack ${saved.key} in ${saved.ackFile}\n`);
      }
      process.exit(0);
    }

    const report = evaluateStallWatch({
      repo: opts.repo,
      staleMinutes: opts.staleMinutes,
      queueStaleMinutes: opts.queueStaleMinutes,
      ignoreLabels: opts.ignoreLabels,
      ackFile: opts.ackFile,
      inboxDir: opts.inboxDir,
      includeDrafts: opts.includeDrafts,
    });

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printHuman(report);
    }

    process.exit(report.exitCode);
  } catch (err) {
    process.stderr.write(`pr:watch: ${err.message}\n`);
    process.exit(1);
  }
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  main();
}
