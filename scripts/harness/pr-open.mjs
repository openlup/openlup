#!/usr/bin/env node
import fs from 'node:fs';
import { execCommand, isDirectCliInvocation } from './exec.mjs';
import { runHostProbe } from './safe-run.mjs';

const DCO_LINE_RE = /^Signed-off-by:\s+.+\s+<[^<>\s]+>$/m;
const HEX_SHA_RE = /^[0-9a-f]{40}$/i;
const POSITIVE_INT_RE = /^[1-9]\d*$/;
const PR_URL_NUM_RE = /\/pull\/([1-9]\d*)\b/;
const SAFE_BASE_RE = /^(?!-)(?!.*\.\.)[^\s~^:?*[\]\\]+$/;

const USAGE = `Usage:
  npm run pr:open -- create --title "<title>" (--body "<text>" | --body-file <path>) \\
    [--base main] [--ready] [--repo-dir <dir>] [--json]
  npm run pr:open -- ready <pr-number> [--repo-dir <dir>] [--skip-preflight --reason "<why>"] [--json]
`;

function combinedOutput(res) {
  return [res?.stderr ?? '', res?.stdout ?? '', res?.error?.message ?? '']
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function hasDcoTrailer(text) {
  return typeof text === 'string' && DCO_LINE_RE.test(text);
}

export function ensureBodyDco(body, { name, email }) {
  const normalized = typeof body === 'string' ? body : '';
  if (hasDcoTrailer(normalized)) {
    return { body: normalized, appended: false };
  }
  if (!name || !email) {
    throw new Error('Cannot append Signed-off-by trailer: missing git user.name or user.email');
  }
  const trimmedEnd = normalized.replace(/\s+$/, '');
  const trailer = `Signed-off-by: ${name} <${email}>`;
  const nextBody = trimmedEnd ? `${trimmedEnd}\n\n${trailer}\n` : `${trailer}\n`;
  return { body: nextBody, appended: true };
}

export function checkCleanWorktree(repoDir, exec = execCommand) {
  const res = exec('git', ['-C', repoDir, 'status', '--porcelain']);
  if (res.status !== 0) {
    return {
      ok: false,
      code: 'GIT_STATUS_FAILED',
      error: combinedOutput(res) || 'git status --porcelain failed',
    };
  }
  if ((res.stdout ?? '').trim() !== '') {
    return {
      ok: false,
      code: 'DIRTY_WORKTREE',
      error: 'Working tree has uncommitted changes; commit or stash before opening/promoting PR',
    };
  }
  return { ok: true };
}

export function checkCommitsDco(repoDir, base, exec = execCommand) {
  const range = `origin/${base}..HEAD`;
  const res = exec('git', ['-C', repoDir, 'log', '--format=%H%x1f%B%x1e', range]);
  if (res.status !== 0) {
    return {
      ok: false,
      code: 'GIT_LOG_FAILED',
      error: combinedOutput(res) || `git log ${range} failed`,
    };
  }

  const records = (res.stdout ?? '')
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean);

  if (records.length === 0) {
    return {
      ok: false,
      code: 'NO_COMMITS_AHEAD',
      error: `No commits found in ${range}`,
    };
  }

  const missing = [];
  for (const record of records) {
    const sep = record.indexOf('\x1f');
    const sha = sep >= 0 ? record.slice(0, sep).trim() : 'unknown';
    const message = sep >= 0 ? record.slice(sep + 1) : '';
    if (!hasDcoTrailer(message)) {
      missing.push(sha);
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      code: 'DCO_MISSING',
      missingCommits: missing,
      error: `Commits missing Signed-off-by trailer: ${missing.join(', ')}`,
    };
  }

  return { ok: true, commitCount: records.length };
}

function getLocalHead(repoDir, exec = execCommand) {
  const res = exec('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
  const sha = (res.stdout ?? '').trim();
  if (res.status !== 0 || !HEX_SHA_RE.test(sha)) {
    return {
      ok: false,
      code: 'LOCAL_HEAD_UNAVAILABLE',
      error: combinedOutput(res) || 'Unable to resolve local HEAD commit SHA',
    };
  }
  return { ok: true, sha: sha.toLowerCase() };
}

function runPreflight(repoDir, exec = execCommand, stdio = 'inherit') {
  const res = exec('npm', ['run', 'preflight', '--', '--affected'], {
    cwd: repoDir,
    stdio,
  });
  if (res.status !== 0 || res.signal) {
    return {
      ok: false,
      code: 'PREFLIGHT_FAILED',
      status: res.status,
      error: combinedOutput(res) || `npm run preflight -- --affected failed (status ${res.status})`,
    };
  }
  return { ok: true };
}

function viewPr(prNumber, fields, repoDir, exec = execCommand) {
  const res = exec('gh', ['pr', 'view', String(prNumber), '--json', fields.join(',')], {
    cwd: repoDir,
  });
  if (res.status !== 0) {
    return {
      ok: false,
      code: 'GH_PR_VIEW_FAILED',
      error: combinedOutput(res) || `gh pr view ${prNumber} failed`,
    };
  }
  try {
    return { ok: true, data: JSON.parse(res.stdout) };
  } catch (err) {
    return {
      ok: false,
      code: 'GH_PR_VIEW_INVALID_JSON',
      error: `Failed to parse gh pr view output: ${err.message}`,
    };
  }
}

export function createPullRequest(options = {}) {
  const {
    title,
    body,
    base = 'main',
    ready = false,
    repoDir = process.cwd(),
    exec = execCommand,
    preflightStdio = 'inherit',
  } = options;

  if (typeof title !== 'string' || title.trim() === '') {
    return { ok: false, exitCode: 1, code: 'INVALID_TITLE', error: 'Title must be non-empty' };
  }
  if (typeof body !== 'string' || body.trim() === '') {
    return { ok: false, exitCode: 1, code: 'INVALID_BODY', error: 'Body must be non-empty' };
  }
  if (typeof base !== 'string' || !SAFE_BASE_RE.test(base)) {
    return { ok: false, exitCode: 1, code: 'INVALID_BASE', error: `Invalid base branch: ${base}` };
  }

  // 1. Host probe
  const probe = runHostProbe({ repoDir, skipGh: false, exec });
  if (!probe.ok) {
    const failed = probe.checks.find((c) => !c.ok);
    return {
      ok: false,
      exitCode: 1,
      code: probe.code,
      probe,
      error: `Host probe failed (${probe.code}): ${failed?.detail ?? 'unknown error'}`,
    };
  }

  // 2. Clean worktree & DCO on origin/<base>..HEAD
  const clean = checkCleanWorktree(repoDir, exec);
  if (!clean.ok) {
    return { ok: false, exitCode: 1, code: clean.code, error: clean.error };
  }

  const head = getLocalHead(repoDir, exec);
  if (!head.ok) {
    return { ok: false, exitCode: 1, code: head.code, error: head.error };
  }

  const dco = checkCommitsDco(repoDir, base, exec);
  if (!dco.ok) {
    return {
      ok: false,
      exitCode: 1,
      code: dco.code,
      missingCommits: dco.missingCommits,
      error: dco.error,
    };
  }

  // 3. Draft-by-default; --ready gated on preflight
  if (ready) {
    const preflight = runPreflight(repoDir, exec, preflightStdio);
    if (!preflight.ok) {
      return {
        ok: false,
        exitCode: 1,
        code: preflight.code,
        error: preflight.error,
      };
    }
  }

  // 4. Ensure Signed-off-by trailer in PR body
  let finalBody = body;
  let appendedDco = false;
  if (!hasDcoTrailer(body)) {
    const nameRes = exec('git', ['-C', repoDir, 'config', 'user.name']);
    const emailRes = exec('git', ['-C', repoDir, 'config', 'user.email']);
    const name = (nameRes.stdout ?? '').trim();
    const email = (emailRes.stdout ?? '').trim();
    if (nameRes.status !== 0 || emailRes.status !== 0 || !name || !email) {
      return {
        ok: false,
        exitCode: 1,
        code: 'GIT_IDENTITY_MISSING',
        error: 'PR body lacks Signed-off-by and git user.name / user.email is not configured',
      };
    }
    const ensured = ensureBodyDco(body, { name, email });
    finalBody = ensured.body;
    appendedDco = ensured.appended;
  }

  // 5. Push branch
  const pushRes = exec('git', ['-C', repoDir, 'push', '-u', 'origin', 'HEAD']);
  if (pushRes.status !== 0) {
    return {
      ok: false,
      exitCode: 1,
      code: 'GIT_PUSH_FAILED',
      error: combinedOutput(pushRes) || 'git push -u origin HEAD failed',
    };
  }

  // 6. gh pr create (draft by default unless ready === true)
  const createArgs = [
    'pr',
    'create',
    '--base',
    base,
    '--title',
    title.trim(),
    '--body',
    finalBody,
  ];
  if (!ready) {
    createArgs.push('--draft');
  }

  const createRes = exec('gh', createArgs, { cwd: repoDir });
  if (createRes.status !== 0) {
    return {
      ok: false,
      exitCode: 1,
      code: 'GH_PR_CREATE_FAILED',
      error: combinedOutput(createRes) || 'gh pr create failed',
    };
  }

  const prMatch = PR_URL_NUM_RE.exec(createRes.stdout ?? '');
  if (!prMatch) {
    return {
      ok: false,
      exitCode: 1,
      code: 'PR_NUMBER_PARSE_FAILED',
      error: `Could not parse PR number from gh pr create output: ${(createRes.stdout ?? '').trim()}`,
    };
  }
  const prNumber = Number(prMatch[1]);

  // 7. Remote readback
  const readback = viewPr(prNumber, ['number', 'url', 'isDraft', 'headRefOid'], repoDir, exec);
  if (!readback.ok) {
    return { ok: false, exitCode: 1, code: readback.code, error: readback.error };
  }

  const remoteHead = String(readback.data?.headRefOid ?? '').toLowerCase();
  const remoteDraft = Boolean(readback.data?.isDraft);
  const expectedDraft = !ready;

  if (remoteHead !== head.sha || remoteDraft !== expectedDraft) {
    return {
      ok: false,
      exitCode: 1,
      code: 'READBACK_MISMATCH',
      readback: readback.data,
      expected: { headRefOid: head.sha, isDraft: expectedDraft },
      error: `Remote PR #${prNumber} readback mismatch (expected head=${head.sha}, isDraft=${expectedDraft}; got head=${remoteHead}, isDraft=${remoteDraft})`,
    };
  }

  return {
    ok: true,
    exitCode: 0,
    code: 'OK',
    number: readback.data.number,
    url: readback.data.url,
    isDraft: remoteDraft,
    headRefOid: remoteHead,
    appendedDco,
    preflightRan: ready,
  };
}

export function promotePullRequestReady(options = {}) {
  const {
    prNumber,
    repoDir = process.cwd(),
    skipPreflight = false,
    reason = null,
    exec = execCommand,
    preflightStdio = 'inherit',
  } = options;

  if (!POSITIVE_INT_RE.test(String(prNumber))) {
    return {
      ok: false,
      exitCode: 1,
      code: 'INVALID_PR_NUMBER',
      error: `Invalid PR number: ${prNumber}`,
    };
  }

  if (skipPreflight && (typeof reason !== 'string' || reason.trim() === '')) {
    return {
      ok: false,
      exitCode: 1,
      code: 'SKIP_PREFLIGHT_REASON_REQUIRED',
      error: '--skip-preflight requires a non-empty --reason "<why>"',
    };
  }

  // 1. Host probe + clean worktree
  const probe = runHostProbe({ repoDir, skipGh: false, exec });
  if (!probe.ok) {
    const failed = probe.checks.find((c) => !c.ok);
    return {
      ok: false,
      exitCode: 1,
      code: probe.code,
      probe,
      error: `Host probe failed (${probe.code}): ${failed?.detail ?? 'unknown error'}`,
    };
  }

  const clean = checkCleanWorktree(repoDir, exec);
  if (!clean.ok) {
    return { ok: false, exitCode: 1, code: clean.code, error: clean.error };
  }

  const head = getLocalHead(repoDir, exec);
  if (!head.ok) {
    return { ok: false, exitCode: 1, code: head.code, error: head.error };
  }

  // 2. Inspect remote PR: HEAD consistency + PR body Signed-off-by + baseRefName for commit DCO
  const before = viewPr(
    prNumber,
    ['number', 'url', 'headRefOid', 'isDraft', 'body', 'baseRefName'],
    repoDir,
    exec,
  );
  if (!before.ok) {
    return { ok: false, exitCode: 1, code: before.code, error: before.error };
  }

  const remoteHead = String(before.data?.headRefOid ?? '').toLowerCase();
  if (remoteHead !== head.sha) {
    return {
      ok: false,
      exitCode: 1,
      code: 'REMOTE_HEAD_MISMATCH',
      error: `PR #${prNumber} remote headRefOid (${remoteHead || 'missing'}) does not match local HEAD (${head.sha}); push commits first`,
    };
  }

  if (!hasDcoTrailer(before.data?.body ?? '')) {
    return {
      ok: false,
      exitCode: 1,
      code: 'PR_BODY_DCO_MISSING',
      error: `PR #${prNumber} body does not contain a Signed-off-by trailer`,
    };
  }

  const baseRef = before.data?.baseRefName || 'main';
  const dco = checkCommitsDco(repoDir, baseRef, exec);
  if (!dco.ok) {
    return {
      ok: false,
      exitCode: 1,
      code: dco.code,
      missingCommits: dco.missingCommits,
      error: dco.error,
    };
  }

  // 3. Preflight gate (unless explicitly skipped with --reason)
  if (!skipPreflight) {
    const preflight = runPreflight(repoDir, exec, preflightStdio);
    if (!preflight.ok) {
      return {
        ok: false,
        exitCode: 1,
        code: preflight.code,
        error: preflight.error,
      };
    }
  }

  // 4. Promote PR via gh pr ready
  const readyRes = exec('gh', ['pr', 'ready', String(prNumber)], { cwd: repoDir });
  if (readyRes.status !== 0) {
    return {
      ok: false,
      exitCode: 1,
      code: 'GH_PR_READY_FAILED',
      error: combinedOutput(readyRes) || `gh pr ready ${prNumber} failed`,
    };
  }

  // 5. Remote readback verifying isDraft === false and headRefOid === localHead
  const after = viewPr(prNumber, ['number', 'url', 'isDraft', 'headRefOid'], repoDir, exec);
  if (!after.ok) {
    return { ok: false, exitCode: 1, code: after.code, error: after.error };
  }

  const afterHead = String(after.data?.headRefOid ?? '').toLowerCase();
  const afterDraft = Boolean(after.data?.isDraft);
  if (afterDraft !== false || afterHead !== head.sha) {
    return {
      ok: false,
      exitCode: 1,
      code: 'READBACK_MISMATCH',
      readback: after.data,
      error: `PR #${prNumber} readback mismatch after ready (expected isDraft=false, head=${head.sha}; got isDraft=${afterDraft}, head=${afterHead})`,
    };
  }

  return {
    ok: true,
    exitCode: 0,
    code: 'OK',
    number: after.data.number,
    url: after.data.url,
    isDraft: false,
    headRefOid: afterHead,
    preflightRan: !skipPreflight,
    skipReason: skipPreflight ? reason.trim() : null,
  };
}

function requireVal(argv, i, flag) {
  if (i + 1 >= argv.length) {
    throw new Error(`Missing value for flag ${flag}`);
  }
  return argv[i + 1];
}

export function parsePrOpenArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('Missing subcommand. Expected: create | ready');
  }

  const subcommand = argv[0];
  if (subcommand === '--help' || subcommand === '-h') {
    return { subcommand: 'help' };
  }

  if (subcommand !== 'create' && subcommand !== 'ready') {
    throw new Error(`Unknown subcommand "${subcommand}". Expected: create | ready`);
  }

  if (subcommand === 'create') {
    const opts = {
      subcommand: 'create',
      title: null,
      body: null,
      bodyFile: null,
      base: 'main',
      ready: false,
      repoDir: process.cwd(),
      json: false,
    };

    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === '--help' || arg === '-h') return { subcommand: 'help' };
      if (arg === '--title') {
        opts.title = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--body') {
        opts.body = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--body-file') {
        opts.bodyFile = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--base') {
        opts.base = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--ready') {
        opts.ready = true;
      } else if (arg === '--repo-dir') {
        opts.repoDir = requireVal(argv, i, arg);
        i += 1;
      } else if (arg === '--json') {
        opts.json = true;
      } else {
        throw new Error(`Unknown or invalid argument for create: ${arg}`);
      }
    }

    if (!opts.title) throw new Error('create requires --title "<title>"');
    if (opts.body === null && opts.bodyFile === null) {
      throw new Error('create requires --body "<text>" or --body-file <path>');
    }
    if (opts.body !== null && opts.bodyFile !== null) {
      throw new Error('Cannot specify both --body and --body-file');
    }
    if (!SAFE_BASE_RE.test(opts.base)) {
      throw new Error(`Invalid base branch: ${opts.base}`);
    }

    if (opts.bodyFile !== null) {
      opts.body = fs.readFileSync(opts.bodyFile, 'utf8');
    }

    return opts;
  }

  // subcommand === 'ready'
  const opts = {
    subcommand: 'ready',
    prNumber: null,
    repoDir: process.cwd(),
    skipPreflight: false,
    reason: null,
    json: false,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { subcommand: 'help' };
    if (arg === '--repo-dir') {
      opts.repoDir = requireVal(argv, i, arg);
      i += 1;
    } else if (arg === '--skip-preflight') {
      opts.skipPreflight = true;
    } else if (arg === '--reason') {
      opts.reason = requireVal(argv, i, arg);
      i += 1;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (!arg.startsWith('-') && opts.prNumber === null) {
      if (!POSITIVE_INT_RE.test(arg)) {
        throw new Error(`Invalid PR number: ${arg}`);
      }
      opts.prNumber = Number(arg);
    } else {
      throw new Error(`Unknown or invalid argument for ready: ${arg}`);
    }
  }

  if (opts.prNumber === null) {
    throw new Error('ready requires <pr-number>');
  }
  if (opts.skipPreflight && (!opts.reason || opts.reason.trim() === '')) {
    throw new Error('--skip-preflight requires --reason "<why>"');
  }
  if (!opts.skipPreflight && opts.reason !== null) {
    throw new Error('--reason is only valid with --skip-preflight');
  }

  return opts;
}

function main() {
  let opts;
  try {
    opts = parsePrOpenArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`pr:open: ${err.message}\n\n${USAGE}`);
    process.exit(1);
  }

  if (opts.subcommand === 'help') {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const result =
    opts.subcommand === 'create'
      ? createPullRequest({
          title: opts.title,
          body: opts.body,
          base: opts.base,
          ready: opts.ready,
          repoDir: opts.repoDir,
        })
      : promotePullRequestReady({
          prNumber: opts.prNumber,
          repoDir: opts.repoDir,
          skipPreflight: opts.skipPreflight,
          reason: opts.reason,
        });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    const mode = result.isDraft ? 'draft' : 'ready';
    process.stdout.write(
      `PR #${result.number} (${mode}) verified at ${result.headRefOid}: ${result.url}\n`,
    );
  } else {
    process.stderr.write(`pr:open: [${result.code}] ${result.error}\n`);
  }

  process.exit(result.exitCode);
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  main();
}
