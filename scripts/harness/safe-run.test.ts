import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isDirectCliInvocation, normalizePath } from './exec.mjs';
import {
  detectXcodeLicenseError,
  parseSafeRunArgs,
  runHostProbe,
  runSafeExec,
} from './safe-run.mjs';

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

type ExecResult = {
  status: number;
  stdout: string;
  stderr: string;
  signal?: string | null;
  error?: Error | null;
};

type StubHandler = {
  match: (cmd: string, args: string[], opts: Record<string, unknown>) => boolean;
  result: ExecResult | ((cmd: string, args: string[], opts: Record<string, unknown>) => ExecResult);
};

function makeStubExec(handlers: StubHandler[]) {
  const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
  const exec = (cmd: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
    calls.push({ cmd, args, opts });
    for (const h of handlers) {
      if (h.match(cmd, args, opts)) {
        return typeof h.result === 'function' ? h.result(cmd, args, opts) : h.result;
      }
    }
    throw new Error(`Unexpected exec call: ${cmd} ${args.join(' ')}`);
  };
  exec.calls = calls;
  return exec;
}

function healthyHandlers(extra: StubHandler[] = []): StubHandler[] {
  return [
    ...extra,
    { match: (c, a) => c === 'git' && a[0] === '--version', result: { status: 0, stdout: 'git version 2.47.0\n', stderr: '' } },
    { match: (c, a) => c === 'node' && a[0] === '--version', result: { status: 0, stdout: 'v24.22.2\n', stderr: '' } },
    { match: (c, a) => c === 'gh' && a[0] === '--version', result: { status: 0, stdout: 'gh version 2.60.0\n', stderr: '' } },
    { match: (c, a) => c === 'gh' && a[0] === 'auth' && a[1] === 'status', result: { status: 0, stdout: 'Logged in\n', stderr: '' } },
    { match: (c, a) => c === 'git' && a.includes('--is-inside-work-tree'), result: { status: 0, stdout: 'true\n', stderr: '' } },
  ];
}

describe('exec.normalizePath', () => {
  it('prepends existing Homebrew Node 24 and Homebrew bin on darwin without duplicates', () => {
    const p = normalizePath('/usr/bin:/opt/homebrew/bin:/bin', {
      platform: 'darwin',
      delimiter: ':',
      existsSync: () => true,
    });
    expect(p).toBe('/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin');
  });

  it('does not prepend macOS Homebrew paths on non-darwin platforms or when missing', () => {
    const linuxPath = normalizePath('/usr/bin:/bin:/usr/bin', {
      platform: 'linux',
      delimiter: ':',
      existsSync: () => true,
    });
    expect(linuxPath).toBe('/usr/bin:/bin');

    const darwinMissing = normalizePath('/usr/bin:/bin', {
      platform: 'darwin',
      delimiter: ':',
      existsSync: () => false,
    });
    expect(darwinMissing).toBe('/usr/bin:/bin');
  });
});

describe('safe-run host probe', () => {
  it('passes when git, node >= 22, gh auth, and repoDir are healthy', () => {
    const exec = makeStubExec(healthyHandlers());
    const res = runHostProbe({ repoDir: '/tmp/fake-repo', exec });
    expect(res.ok).toBe(true);
    expect(res.code).toBe('OK');
    expect(res.checks).toHaveLength(5);
  });

  it('detects Xcode license error from git stderr', () => {
    const msg = 'You have not agreed to the Xcode license agreements. Run sudo xcodebuild -license.';
    expect(detectXcodeLicenseError(msg)).toBe(true);

    const exec = makeStubExec([
      { match: (c, a) => c === 'git' && a[0] === '--version', result: { status: 69, stdout: '', stderr: msg } },
      ...healthyHandlers(),
    ]);
    const res = runHostProbe({ exec });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('XCODE_LICENSE_REQUIRED');
  });

  it('fails closed when Node major version < 22', () => {
    const exec = makeStubExec([
      { match: (c, a) => c === 'node' && a[0] === '--version', result: { status: 0, stdout: 'v20.11.0\n', stderr: '' } },
      ...healthyHandlers(),
    ]);
    const res = runHostProbe({ exec });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NODE_VERSION_TOO_OLD');
  });

  it('fails closed when gh auth status fails unless --skip-gh is set', () => {
    const exec = makeStubExec([
      { match: (c, a) => c === 'gh' && a[0] === 'auth', result: { status: 1, stdout: '', stderr: 'not logged in' } },
      ...healthyHandlers(),
    ]);
    const failRes = runHostProbe({ exec });
    expect(failRes.ok).toBe(false);
    expect(failRes.code).toBe('GH_AUTH_REQUIRED');

    const skipRes = runHostProbe({ skipGh: true, exec });
    expect(skipRes.ok).toBe(true);
  });

  it('fails closed when repoDir is not a git work tree', () => {
    const exec = makeStubExec([
      { match: (c, a) => c === 'git' && a.includes('--is-inside-work-tree'), result: { status: 128, stdout: '', stderr: 'not a git repository' } },
      ...healthyHandlers(),
    ]);
    const res = runHostProbe({ repoDir: '/tmp/not-a-repo', exec });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_REPO_DIR');
  });
});

describe('safe-run exec', () => {
  it('does NOT execute command when host probe fails (e.g. Xcode license)', () => {
    const exec = makeStubExec([
      { match: (c, a) => c === 'git' && a[0] === '--version', result: { status: 69, stdout: '', stderr: 'Agreeing to the Xcode/iOS license requires admin privileges' } },
      ...healthyHandlers(),
    ]);
    const res = runSafeExec({ cmd: 'echo', cmdArgs: ['should-not-run'], exec });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.stage).toBe('probe');
    expect(res.code).toBe('XCODE_LICENSE_REQUIRED');
    expect(exec.calls.some((c) => c.cmd === 'echo')).toBe(false);
  });

  it('blocks execution when --require-clean detects dirty worktree', () => {
    const exec = makeStubExec([
      { match: (c, a) => c === 'git' && a.includes('--porcelain'), result: { status: 0, stdout: ' M file.ts\n', stderr: '' } },
      ...healthyHandlers(),
    ]);
    const res = runSafeExec({ repoDir: '/tmp/repo', requireClean: true, cmd: 'npm', cmdArgs: ['test'], exec });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('DIRTY_WORKTREE');
    expect(exec.calls.some((c) => c.cmd === 'npm')).toBe(false);
  });

  it('propagates exact non-zero exit code and skips readback', () => {
    const exec = makeStubExec([
      { match: (c) => c === 'my-tool', result: { status: 78, stdout: '', stderr: 'failed' } },
      ...healthyHandlers(),
    ]);
    const res = runSafeExec({
      repoDir: '/tmp/repo',
      verifyRemoteBranch: 'feat/test',
      cmd: 'my-tool',
      cmdArgs: ['--check'],
      exec,
    });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(78);
    expect(res.stage).toBe('exec');
    expect(exec.calls.some((c) => c.args.includes('ls-remote'))).toBe(false);
  });

  it('verifies remote branch and PR headRefOid readback on success', () => {
    const exec = makeStubExec([
      { match: (c, a) => c === 'git' && a.includes('push'), result: { status: 0, stdout: '', stderr: '' } },
      { match: (c, a) => c === 'git' && a.includes('rev-parse') && a.includes('HEAD'), result: { status: 0, stdout: `${SHA_A}\n`, stderr: '' } },
      { match: (c, a) => c === 'git' && a.includes('ls-remote'), result: { status: 0, stdout: `${SHA_A}\trefs/heads/feat/x\n`, stderr: '' } },
      { match: (c, a) => c === 'gh' && a[0] === 'pr' && a[1] === 'view', result: { status: 0, stdout: JSON.stringify({ headRefOid: SHA_A }), stderr: '' } },
      ...healthyHandlers(),
    ]);
    const res = runSafeExec({
      repoDir: '/tmp/repo',
      verifyRemoteBranch: 'feat/x',
      verifyPr: 1299,
      cmd: 'git',
      cmdArgs: ['push', 'origin', 'HEAD'],
      exec,
    });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.readback?.remoteBranchSha).toBe(SHA_A);
    expect(res.readback?.prHeadSha).toBe(SHA_A);
  });

  it('fails closed when remote branch SHA mismatches local HEAD', () => {
    const exec = makeStubExec([
      { match: (c) => c === 'true', result: { status: 0, stdout: '', stderr: '' } },
      { match: (c, a) => c === 'git' && a.includes('rev-parse') && a.includes('HEAD'), result: { status: 0, stdout: `${SHA_A}\n`, stderr: '' } },
      { match: (c, a) => c === 'git' && a.includes('ls-remote'), result: { status: 0, stdout: `${SHA_B}\trefs/heads/feat/x\n`, stderr: '' } },
      ...healthyHandlers(),
    ]);
    const res = runSafeExec({
      repoDir: '/tmp/repo',
      verifyRemoteBranch: 'feat/x',
      cmd: 'true',
      exec,
    });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.code).toBe('REMOTE_BRANCH_MISMATCH');
  });

  it('fails closed when PR headRefOid mismatches local HEAD', () => {
    const exec = makeStubExec([
      { match: (c) => c === 'true', result: { status: 0, stdout: '', stderr: '' } },
      { match: (c, a) => c === 'git' && a.includes('rev-parse') && a.includes('HEAD'), result: { status: 0, stdout: `${SHA_A}\n`, stderr: '' } },
      { match: (c, a) => c === 'gh' && a[0] === 'pr' && a[1] === 'view', result: { status: 0, stdout: JSON.stringify({ headRefOid: SHA_B }), stderr: '' } },
      ...healthyHandlers(),
    ]);
    const res = runSafeExec({
      repoDir: '/tmp/repo',
      verifyPr: 42,
      cmd: 'true',
      exec,
    });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.code).toBe('REMOTE_PR_HEAD_MISMATCH');
  });
});

describe('safe-run CLI parser (fail-closed)', () => {
  it('rejects unknown subcommand, unknown flags, missing flag values, and missing command', () => {
    expect(() => parseSafeRunArgs([])).toThrow(/Missing subcommand/);
    expect(() => parseSafeRunArgs(['bogus'])).toThrow(/Unknown subcommand/);
    expect(() => parseSafeRunArgs(['probe', '--unknown'])).toThrow(/Unknown or invalid/);
    expect(() => parseSafeRunArgs(['probe', '--repo-dir'])).toThrow(/Missing value/);
    expect(() => parseSafeRunArgs(['exec', '--require-clean'])).toThrow(/exec requires/);
    expect(() => parseSafeRunArgs(['exec', '--'])).toThrow(/Missing command/);
    expect(() => parseSafeRunArgs(['exec', '--verify-pr', 'abc', '--', 'true'])).toThrow(/Invalid PR number/);
  });

  it('parses valid exec command with flags and passthrough args', () => {
    const opts = parseSafeRunArgs([
      'exec',
      '--repo-dir', '/tmp/r',
      '--require-clean',
      '--verify-remote-branch', 'feat/ok',
      '--verify-pr', '123',
      '--',
      'git', 'push', '-u', 'origin', 'HEAD',
    ]);
    expect(opts.subcommand).toBe('exec');
    expect(opts.repoDir).toBe('/tmp/r');
    expect(opts.requireClean).toBe(true);
    expect(opts.verifyRemoteBranch).toBe('feat/ok');
    expect(opts.verifyPr).toBe(123);
    expect(opts.cmd).toBe('git');
    expect(opts.cmdArgs).toEqual(['push', '-u', 'origin', 'HEAD']);
  });

  it('executes main() when invoked through a symlink (does not silently exit 0)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlup-safe-run-symlink-'));
    try {
      const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'safe-run.mjs');
      const linkPath = path.join(tmpDir, 'openlup-safe-run');
      fs.symlinkSync(target, linkPath);

      expect(isDirectCliInvocation(`file://${target}`, linkPath)).toBe(true);
      expect(isDirectCliInvocation(`file://${target}`, path.join(tmpDir, 'other.mjs'))).toBe(false);

      const helpRun = spawnSync(process.execPath, [linkPath, '--help'], { encoding: 'utf8' });
      expect(helpRun.status).toBe(0);
      expect(helpRun.stdout).toContain('Usage:');

      const bogusRun = spawnSync(process.execPath, [linkPath, 'bogus'], { encoding: 'utf8' });
      expect(bogusRun.status).toBe(1);
      expect(bogusRun.stderr).toContain('Unknown subcommand');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
