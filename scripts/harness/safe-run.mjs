#!/usr/bin/env node
import { execCommand, isDirectCliInvocation } from './exec.mjs';

const XCODE_LICENSE_RE = /xcodebuild\s+-license|Agreeing to the Xcode/i;
const NODE_MAJOR_RE = /^v(\d+)\./;
const HEX_SHA_RE = /^[0-9a-f]{40}$/i;
const POSITIVE_INT_RE = /^[1-9]\d*$/;
const SAFE_BRANCH_RE = /^(?!-)(?!.*\.\.)[^\s~^:?*[\]\\]+$/;

const USAGE = `Usage:
  npm run safe:run -- probe [--repo-dir <dir>] [--skip-gh] [--json]
  npm run safe:run -- exec [--repo-dir <dir>] [--require-clean] \\
    [--verify-remote-branch <branch>] [--verify-pr <num>] [--skip-gh] [--json] -- <cmd...>

Exit codes:
  0  Probe/command and optional readback succeeded
  1  Probe failed, invalid arguments, dirty worktree, or readback mismatch
  N  Exact non-zero exit code propagated from <cmd...>
`;

export function detectXcodeLicenseError(text) {
  return typeof text === 'string' && XCODE_LICENSE_RE.test(text);
}

function combinedOutput(res) {
  return [res?.stderr ?? '', res?.stdout ?? '', res?.error?.message ?? '']
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function runHostProbe(options = {}) {
  const {
    repoDir = null,
    skipGh = false,
    exec = execCommand,
  } = options;

  const checks = [];

  // 1. git --version + Xcode license detection
  const gitRes = exec('git', ['--version']);
  const gitText = combinedOutput(gitRes);
  if (detectXcodeLicenseError(gitText)) {
    checks.push({
      name: 'git',
      ok: false,
      code: 'XCODE_LICENSE_REQUIRED',
      detail: gitText,
    });
  } else if (gitRes.status !== 0) {
    checks.push({
      name: 'git',
      ok: false,
      code: 'GIT_UNAVAILABLE',
      detail: gitText || `git --version exited with status ${gitRes.status}`,
    });
  } else {
    checks.push({
      name: 'git',
      ok: true,
      code: 'OK',
      detail: gitRes.stdout.trim(),
    });
  }

  // 2. node --version >= 22
  const nodeRes = exec('node', ['--version']);
  const nodeOut = (nodeRes.stdout ?? '').trim();
  const nodeMatch = NODE_MAJOR_RE.exec(nodeOut);
  if (nodeRes.status !== 0 || !nodeMatch) {
    checks.push({
      name: 'node',
      ok: false,
      code: 'NODE_UNAVAILABLE',
      detail: combinedOutput(nodeRes) || `node --version exited with status ${nodeRes.status}`,
    });
  } else {
    const major = Number(nodeMatch[1]);
    if (major < 22) {
      checks.push({
        name: 'node',
        ok: false,
        code: 'NODE_VERSION_TOO_OLD',
        detail: `Found ${nodeOut}, require Node.js >= 22`,
      });
    } else {
      checks.push({
        name: 'node',
        ok: true,
        code: 'OK',
        detail: nodeOut,
      });
    }
  }

  // 3. gh --version & gh auth status
  if (!skipGh) {
    const ghVerRes = exec('gh', ['--version']);
    if (ghVerRes.status !== 0) {
      checks.push({
        name: 'gh',
        ok: false,
        code: 'GH_UNAVAILABLE',
        detail: combinedOutput(ghVerRes) || `gh --version exited with status ${ghVerRes.status}`,
      });
    } else {
      checks.push({
        name: 'gh',
        ok: true,
        code: 'OK',
        detail: ghVerRes.stdout.trim().split('\n')[0] ?? '',
      });

      const ghAuthRes = exec('gh', ['auth', 'status']);
      if (ghAuthRes.status !== 0) {
        checks.push({
          name: 'gh-auth',
          ok: false,
          code: 'GH_AUTH_REQUIRED',
          detail: combinedOutput(ghAuthRes) || `gh auth status exited with status ${ghAuthRes.status}`,
        });
      } else {
        checks.push({
          name: 'gh-auth',
          ok: true,
          code: 'OK',
          detail: 'authenticated',
        });
      }
    }
  }

  // 4. Optional repoDir check
  if (repoDir !== null && repoDir !== undefined) {
    const repoRes = exec('git', ['-C', repoDir, 'rev-parse', '--is-inside-work-tree']);
    const repoText = combinedOutput(repoRes);
    if (detectXcodeLicenseError(repoText)) {
      checks.push({
        name: 'repo-dir',
        ok: false,
        code: 'XCODE_LICENSE_REQUIRED',
        detail: repoText,
      });
    } else if (repoRes.status !== 0 || repoRes.stdout.trim() !== 'true') {
      checks.push({
        name: 'repo-dir',
        ok: false,
        code: 'INVALID_REPO_DIR',
        detail: repoText || `${repoDir} is not a valid git work tree`,
      });
    } else {
      checks.push({
        name: 'repo-dir',
        ok: true,
        code: 'OK',
        detail: repoDir,
      });
    }
  }

  const firstFailure = checks.find((c) => !c.ok);
  return {
    ok: !firstFailure,
    code: firstFailure ? firstFailure.code : 'OK',
    checks,
  };
}

export function runSafeExec(options = {}) {
  const {
    repoDir = null,
    requireClean = false,
    verifyRemoteBranch = null,
    verifyPr = null,
    skipGh = false,
    cmd,
    cmdArgs = [],
    exec = execCommand,
    stdio = 'inherit',
  } = options;

  if (typeof cmd !== 'string' || cmd.trim() === '') {
    return {
      ok: false,
      exitCode: 1,
      stage: 'validate',
      code: 'MISSING_COMMAND',
      error: 'No command specified after --',
    };
  }

  if (verifyRemoteBranch !== null && !SAFE_BRANCH_RE.test(verifyRemoteBranch)) {
    return {
      ok: false,
      exitCode: 1,
      stage: 'validate',
      code: 'INVALID_BRANCH_NAME',
      error: `Invalid branch name: ${verifyRemoteBranch}`,
    };
  }

  if (verifyPr !== null && !POSITIVE_INT_RE.test(String(verifyPr))) {
    return {
      ok: false,
      exitCode: 1,
      stage: 'validate',
      code: 'INVALID_PR_NUMBER',
      error: `Invalid PR number: ${verifyPr}`,
    };
  }

  // Need gh if verifying a PR even if skipGh was not requested; fail closed if conflict.
  if (verifyPr !== null && skipGh) {
    return {
      ok: false,
      exitCode: 1,
      stage: 'validate',
      code: 'CONFLICTING_FLAGS',
      error: '--verify-pr cannot be combined with --skip-gh',
    };
  }

  // 1. Pre-flight probe
  const probe = runHostProbe({ repoDir, skipGh, exec });
  if (!probe.ok) {
    const failed = probe.checks.find((c) => !c.ok);
    return {
      ok: false,
      exitCode: 1,
      stage: 'probe',
      code: probe.code,
      probe,
      error: `Host probe failed (${probe.code}): ${failed?.detail ?? 'unknown error'}`,
    };
  }

  const workDir = repoDir ?? process.cwd();

  // 2. Optional clean worktree check
  if (requireClean) {
    const statusRes = exec('git', ['-C', workDir, 'status', '--porcelain']);
    if (statusRes.status !== 0) {
      return {
        ok: false,
        exitCode: 1,
        stage: 'require-clean',
        code: 'GIT_STATUS_FAILED',
        probe,
        error: combinedOutput(statusRes) || 'git status --porcelain failed',
      };
    }
    if (statusRes.stdout.trim() !== '') {
      return {
        ok: false,
        exitCode: 1,
        stage: 'require-clean',
        code: 'DIRTY_WORKTREE',
        probe,
        error: 'Working tree is not clean',
      };
    }
  }

  // 3. Execute command with strict exit code propagation
  const execRes = exec(cmd, cmdArgs, { cwd: workDir, stdio });
  if (execRes.status !== 0 || execRes.signal) {
    const exitCode = typeof execRes.status === 'number' && execRes.status !== 0
      ? execRes.status
      : 1;
    return {
      ok: false,
      exitCode,
      stage: 'exec',
      code: 'COMMAND_FAILED',
      signal: execRes.signal ?? null,
      probe,
      error: execRes.signal
        ? `Command terminated by signal ${execRes.signal}`
        : `Command exited with status ${exitCode}`,
    };
  }

  // 4. Optional remote readback
  const readback = {};
  if (verifyRemoteBranch !== null || verifyPr !== null) {
    const headRes = exec('git', ['-C', workDir, 'rev-parse', 'HEAD']);
    const localHead = (headRes.stdout ?? '').trim();
    if (headRes.status !== 0 || !HEX_SHA_RE.test(localHead)) {
      return {
        ok: false,
        exitCode: 1,
        stage: 'readback',
        code: 'LOCAL_HEAD_UNAVAILABLE',
        probe,
        error: combinedOutput(headRes) || 'Unable to resolve local HEAD commit SHA',
      };
    }
    readback.localHead = localHead;

    if (verifyRemoteBranch !== null) {
      const ref = `refs/heads/${verifyRemoteBranch}`;
      const lsRes = exec('git', ['-C', workDir, 'ls-remote', 'origin', ref]);
      if (lsRes.status !== 0) {
        return {
          ok: false,
          exitCode: 1,
          stage: 'verify-remote-branch',
          code: 'LS_REMOTE_FAILED',
          probe,
          readback,
          error: combinedOutput(lsRes) || `git ls-remote origin ${ref} failed`,
        };
      }
      const line = (lsRes.stdout ?? '')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.endsWith(`\t${ref}`) || l.endsWith(` ${ref}`));
      const remoteSha = line ? line.split(/\s+/)[0] : null;
      readback.remoteBranch = verifyRemoteBranch;
      readback.remoteBranchSha = remoteSha;

      if (!remoteSha || remoteSha.toLowerCase() !== localHead.toLowerCase()) {
        return {
          ok: false,
          exitCode: 1,
          stage: 'verify-remote-branch',
          code: 'REMOTE_BRANCH_MISMATCH',
          probe,
          readback,
          error: `Remote ${ref} (${remoteSha ?? 'missing'}) does not match local HEAD (${localHead})`,
        };
      }
    }

    if (verifyPr !== null) {
      const prRes = exec('gh', ['pr', 'view', String(verifyPr), '--json', 'headRefOid'], {
        cwd: workDir,
      });
      if (prRes.status !== 0) {
        return {
          ok: false,
          exitCode: 1,
          stage: 'verify-pr',
          code: 'GH_PR_VIEW_FAILED',
          probe,
          readback,
          error: combinedOutput(prRes) || `gh pr view ${verifyPr} failed`,
        };
      }
      let parsed;
      try {
        parsed = JSON.parse(prRes.stdout);
      } catch {
        return {
          ok: false,
          exitCode: 1,
          stage: 'verify-pr',
          code: 'GH_PR_VIEW_INVALID_JSON',
          probe,
          readback,
          error: 'Failed to parse JSON from gh pr view',
        };
      }
      const prHead = typeof parsed?.headRefOid === 'string' ? parsed.headRefOid.trim() : null;
      readback.prNumber = Number(verifyPr);
      readback.prHeadSha = prHead;

      if (!prHead || prHead.toLowerCase() !== localHead.toLowerCase()) {
        return {
          ok: false,
          exitCode: 1,
          stage: 'verify-pr',
          code: 'REMOTE_PR_HEAD_MISMATCH',
          probe,
          readback,
          error: `PR #${verifyPr} headRefOid (${prHead ?? 'missing'}) does not match local HEAD (${localHead})`,
        };
      }
    }
  }

  return {
    ok: true,
    exitCode: 0,
    stage: 'done',
    code: 'OK',
    probe,
    readback,
  };
}

function requireFlagValue(argv, index, flag) {
  if (index + 1 >= argv.length) {
    throw new Error(`Missing value for flag ${flag}`);
  }
  const value = argv[index + 1];
  if (value === '--') {
    throw new Error(`Missing value for flag ${flag}`);
  }
  return value;
}

export function parseSafeRunArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('Missing subcommand. Expected: probe | exec');
  }

  const subcommand = argv[0];
  if (subcommand === '--help' || subcommand === '-h') {
    return { subcommand: 'help' };
  }

  if (subcommand !== 'probe' && subcommand !== 'exec') {
    throw new Error(`Unknown subcommand "${subcommand}". Expected: probe | exec`);
  }

  const opts = {
    subcommand,
    repoDir: null,
    skipGh: false,
    json: false,
    requireClean: false,
    verifyRemoteBranch: null,
    verifyPr: null,
    cmd: null,
    cmdArgs: [],
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      if (subcommand !== 'exec') {
        throw new Error('Unexpected "--" in probe subcommand');
      }
      const rest = argv.slice(i + 1);
      if (rest.length === 0) {
        throw new Error('Missing command after "--"');
      }
      opts.cmd = rest[0];
      opts.cmdArgs = rest.slice(1);
      break;
    }

    if (arg === '--repo-dir') {
      opts.repoDir = requireFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--skip-gh') {
      opts.skipGh = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--require-clean' && subcommand === 'exec') {
      opts.requireClean = true;
    } else if (arg === '--verify-remote-branch' && subcommand === 'exec') {
      const val = requireFlagValue(argv, i, arg);
      if (!SAFE_BRANCH_RE.test(val)) {
        throw new Error(`Invalid branch name for --verify-remote-branch: ${val}`);
      }
      opts.verifyRemoteBranch = val;
      i += 1;
    } else if (arg === '--verify-pr' && subcommand === 'exec') {
      const val = requireFlagValue(argv, i, arg);
      if (!POSITIVE_INT_RE.test(val)) {
        throw new Error(`Invalid PR number for --verify-pr: ${val}`);
      }
      opts.verifyPr = Number(val);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      return { subcommand: 'help' };
    } else {
      throw new Error(`Unknown or invalid argument: ${arg}`);
    }
  }

  if (subcommand === 'exec' && !opts.cmd) {
    throw new Error('exec requires "-- <cmd...>"');
  }

  return opts;
}

function printProbeHuman(result) {
  for (const check of result.checks) {
    const marker = check.ok ? 'OK' : `FAIL(${check.code})`;
    process.stdout.write(`[${marker}] ${check.name}: ${check.detail}\n`);
  }
}

function main() {
  let opts;
  try {
    opts = parseSafeRunArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`safe-run: ${err.message}\n\n${USAGE}`);
    process.exit(1);
  }

  if (opts.subcommand === 'help') {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (opts.subcommand === 'probe') {
    const result = runHostProbe({
      repoDir: opts.repoDir,
      skipGh: opts.skipGh,
    });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printProbeHuman(result);
    }
    process.exit(result.ok ? 0 : 1);
  }

  const result = runSafeExec({
    repoDir: opts.repoDir,
    requireClean: opts.requireClean,
    verifyRemoteBranch: opts.verifyRemoteBranch,
    verifyPr: opts.verifyPr,
    skipGh: opts.skipGh,
    cmd: opts.cmd,
    cmdArgs: opts.cmdArgs,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!result.ok) {
    process.stderr.write(`safe-run: [${result.code}] ${result.error}\n`);
  }

  process.exit(result.exitCode);
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  main();
}
