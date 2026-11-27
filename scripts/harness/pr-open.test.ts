import { describe, expect, it } from 'vitest';
import {
  createPullRequest,
  ensureBodyDco,
  hasDcoTrailer,
  parsePrOpenArgs,
  promotePullRequestReady,
} from './pr-open.mjs';

const SHA_LOCAL = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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

function baseHealthyHandlers(overrides: StubHandler[] = []): StubHandler[] {
  return [
    ...overrides,
    { match: (c, a) => c === 'git' && a[0] === '--version', result: { status: 0, stdout: 'git version 2.47.0\n', stderr: '' } },
    { match: (c, a) => c === 'node' && a[0] === '--version', result: { status: 0, stdout: 'v24.22.2\n', stderr: '' } },
    { match: (c, a) => c === 'gh' && a[0] === '--version', result: { status: 0, stdout: 'gh version 2.60.0\n', stderr: '' } },
    { match: (c, a) => c === 'gh' && a[0] === 'auth' && a[1] === 'status', result: { status: 0, stdout: 'ok\n', stderr: '' } },
    { match: (c, a) => c === 'git' && a.includes('--is-inside-work-tree'), result: { status: 0, stdout: 'true\n', stderr: '' } },
    { match: (c, a) => c === 'git' && a.includes('--porcelain'), result: { status: 0, stdout: '', stderr: '' } },
    { match: (c, a) => c === 'git' && a.includes('rev-parse') && a.includes('HEAD'), result: { status: 0, stdout: `${SHA_LOCAL}\n`, stderr: '' } },
    {
      match: (c, a) => c === 'git' && a.includes('log'),
      result: {
        status: 0,
        stdout: `${SHA_LOCAL}\x1ffeat: test\n\nSigned-off-by: Contributor <contributor@example.invalid>\n\x1e`,
        stderr: '',
      },
    },
    { match: (c, a) => c === 'git' && a.includes('config') && a.includes('user.name'), result: { status: 0, stdout: 'OpenLup Contributor\n', stderr: '' } },
    { match: (c, a) => c === 'git' && a.includes('config') && a.includes('user.email'), result: { status: 0, stdout: 'contributor@example.invalid\n', stderr: '' } },
    { match: (c, a) => c === 'git' && a.includes('push'), result: { status: 0, stdout: '', stderr: '' } },
    { match: (c, a) => c === 'npm' && a[0] === 'run' && a[1] === 'preflight', result: { status: 0, stdout: 'ok\n', stderr: '' } },
  ];
}

describe('pr-open DCO helpers', () => {
  it('appends Signed-off-by trailer when missing and preserves when present', () => {
    expect(hasDcoTrailer('hello')).toBe(false);
    const res = ensureBodyDco('Summary line', { name: 'Contributor', email: 'contributor@example.invalid' });
    expect(res.appended).toBe(true);
    expect(hasDcoTrailer(res.body)).toBe(true);

    const kept = ensureBodyDco(res.body, { name: 'Other', email: 'other@example.invalid' });
    expect(kept.appended).toBe(false);
    expect(kept.body).toBe(res.body);
  });
});

describe('pr-open createPullRequest', () => {
  it('creates draft PR by default, appends Signed-off-by, and verifies remote readback', () => {
    const exec = makeStubExec(
      baseHealthyHandlers([
        {
          match: (c, a) => c === 'gh' && a[0] === 'pr' && a[1] === 'create',
          result: { status: 0, stdout: 'https://github.com/openlup/openlup/pull/1350\n', stderr: '' },
        },
        {
          match: (c, a) => c === 'gh' && a[0] === 'pr' && a[1] === 'view',
          result: {
            status: 0,
            stdout: JSON.stringify({
              number: 1350,
              url: 'https://github.com/openlup/openlup/pull/1350',
              isDraft: true,
              headRefOid: SHA_LOCAL,
            }),
            stderr: '',
          },
        },
      ]),
    );

    const res = createPullRequest({
      title: 'feat: add thing',
      body: 'Description without trailer',
      repoDir: '/tmp/repo',
      exec,
    });

    expect(res.ok).toBe(true);
    expect(res.isDraft).toBe(true);
    expect(res.appendedDco).toBe(true);
    expect(res.preflightRan).toBe(false);

    const createCall = exec.calls.find((c) => c.cmd === 'gh' && c.args[1] === 'create');
    expect(createCall?.args.includes('--draft')).toBe(true);
    const bodyIdx = createCall!.args.indexOf('--body');
    expect(createCall!.args[bodyIdx + 1]).toMatch(
      /Signed-off-by: OpenLup Contributor <contributor@example\.invalid>/,
    );
  });

  it('refuses --ready when preflight fails and does NOT push or open PR', () => {
    const exec = makeStubExec(
      baseHealthyHandlers([
        {
          match: (c, a) => c === 'npm' && a[0] === 'run' && a[1] === 'preflight',
          result: { status: 1, stdout: '', stderr: 'preflight failed' },
        },
      ]),
    );

    const res = createPullRequest({
      title: 'feat: ready pr',
      body: 'Body\n\nSigned-off-by: Contributor <contributor@example.invalid>',
      ready: true,
      repoDir: '/tmp/repo',
      exec,
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe('PREFLIGHT_FAILED');
    expect(exec.calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(false);
    expect(exec.calls.some((c) => c.cmd === 'gh' && c.args[1] === 'create')).toBe(false);
  });

  it('fails closed when a commit lacks DCO Signed-off-by', () => {
    const exec = makeStubExec(
      baseHealthyHandlers([
        {
          match: (c, a) => c === 'git' && a.includes('log'),
          result: { status: 0, stdout: `${SHA_LOCAL}\x1ffeat: unsigned commit\n\x1e`, stderr: '' },
        },
      ]),
    );

    const res = createPullRequest({
      title: 'feat: unsigned',
      body: 'Body',
      repoDir: '/tmp/repo',
      exec,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('DCO_MISSING');
  });

  it('fails closed on remote readback headRefOid mismatch', () => {
    const exec = makeStubExec(
      baseHealthyHandlers([
        {
          match: (c, a) => c === 'gh' && a[0] === 'pr' && a[1] === 'create',
          result: { status: 0, stdout: 'https://github.com/openlup/openlup/pull/1351\n', stderr: '' },
        },
        {
          match: (c, a) => c === 'gh' && a[0] === 'pr' && a[1] === 'view',
          result: {
            status: 0,
            stdout: JSON.stringify({
              number: 1351,
              url: 'https://github.com/openlup/openlup/pull/1351',
              isDraft: true,
              headRefOid: SHA_OTHER,
            }),
            stderr: '',
          },
        },
      ]),
    );

    const res = createPullRequest({
      title: 'feat: mismatch',
      body: 'Body',
      repoDir: '/tmp/repo',
      exec,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('READBACK_MISMATCH');
  });
});

describe('pr-open promotePullRequestReady', () => {
  it('promotes PR after verifying HEAD, PR body DCO, commit DCO, preflight, and readback', () => {
    let viewCount = 0;
    const exec = makeStubExec(
      baseHealthyHandlers([
        {
          match: (c, a) => c === 'gh' && a[0] === 'pr' && a[1] === 'view',
          result: () => {
            viewCount += 1;
            if (viewCount === 1) {
              return {
                status: 0,
                stdout: JSON.stringify({
                  number: 1350,
                  url: 'https://github.com/openlup/openlup/pull/1350',
                  headRefOid: SHA_LOCAL,
                  isDraft: true,
                  body: 'Details\n\nSigned-off-by: Contributor <contributor@example.invalid>',
                  baseRefName: 'main',
                }),
                stderr: '',
              };
            }
            return {
              status: 0,
              stdout: JSON.stringify({
                number: 1350,
                url: 'https://github.com/openlup/openlup/pull/1350',
                headRefOid: SHA_LOCAL,
                isDraft: false,
              }),
              stderr: '',
            };
          },
        },
        {
          match: (c, a) => c === 'gh' && a[0] === 'pr' && a[1] === 'ready',
          result: { status: 0, stdout: '', stderr: '' },
        },
      ]),
    );

    const res = promotePullRequestReady({ prNumber: 1350, repoDir: '/tmp/repo', exec });
    expect(res.ok).toBe(true);
    expect(res.isDraft).toBe(false);
    expect(res.preflightRan).toBe(true);
  });

  it('fails closed when remote PR headRefOid does not match local HEAD', () => {
    const exec = makeStubExec(
      baseHealthyHandlers([
        {
          match: (c, a) => c === 'gh' && a[0] === 'pr' && a[1] === 'view',
          result: {
            status: 0,
            stdout: JSON.stringify({
              number: 1350,
              url: 'https://github.com/openlup/openlup/pull/1350',
              headRefOid: SHA_OTHER,
              isDraft: true,
              body: 'Signed-off-by: Contributor <contributor@example.invalid>',
              baseRefName: 'main',
            }),
            stderr: '',
          },
        },
      ]),
    );

    const res = promotePullRequestReady({ prNumber: 1350, repoDir: '/tmp/repo', exec });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('REMOTE_HEAD_MISMATCH');
  });

  it('fails closed when PR body lacks Signed-off-by trailer', () => {
    const exec = makeStubExec(
      baseHealthyHandlers([
        {
          match: (c, a) => c === 'gh' && a[0] === 'pr' && a[1] === 'view',
          result: {
            status: 0,
            stdout: JSON.stringify({
              number: 1350,
              url: 'https://github.com/openlup/openlup/pull/1350',
              headRefOid: SHA_LOCAL,
              isDraft: true,
              body: 'Missing trailer',
              baseRefName: 'main',
            }),
            stderr: '',
          },
        },
      ]),
    );

    const res = promotePullRequestReady({ prNumber: 1350, repoDir: '/tmp/repo', exec });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('PR_BODY_DCO_MISSING');
  });

  it('requires --reason when --skip-preflight is passed', () => {
    expect(() => parsePrOpenArgs(['ready', '1350', '--skip-preflight'])).toThrow(/requires --reason/);
    expect(() => parsePrOpenArgs(['ready', '1350', '--reason', 'docs only'])).toThrow(/only valid with --skip-preflight/);
    expect(() => parsePrOpenArgs(['create', '--title', 't'])).toThrow(/requires --body/);
    expect(() => parsePrOpenArgs(['create', '--unknown'])).toThrow(/Unknown or invalid/);
  });
});
