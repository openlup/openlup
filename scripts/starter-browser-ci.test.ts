import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { acquireStarterPostgres, browserArguments, capturePrivateValues, parseArguments, resolveBrowserImage, scanPrivateOutput, withCleanup, withConnectionCleanup } from './starter-browser-ci.mjs';
import { imageReference, readCiImage } from './ci-image-pull.mjs';

const args = ['--manifest', '/tmp/packs/packages-manifest.json', '--expected-commit', 'a'.repeat(40)];

describe('installed starter browser CI', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('accepts only the explicit candidate manifest', () => {
    expect(parseArguments(args)).toEqual({ manifest: args[1], commit: args[3] });
    expect(parseArguments([...args.slice(2), ...args.slice(0, 2)])).toEqual(parseArguments(args));
  });
  it.each([[], args.slice(0, -1), [...args, '--preview', 'true'], [...args, '--manifest', 'duplicate.json'],
    [...args, '--service-port', '5432'], ['--manifest', '--expected-commit', 'a'.repeat(40)],
    ['--manifest', 'pack.json', '--expected-commit', 'main'],
  ].map(input => [input]))('refuses malformed, missing, duplicate or unknown arguments: %j', input => {
    expect(() => parseArguments(input)).toThrow('starter_browser_arguments_invalid');
  });
  it('removes its disposable PostgreSQL when readiness or a later journey fails', async () => {
    for (const ready of [false, true]) {
      const remove = vi.fn(async () => {});
      const start = vi.fn(async (_spec: { name: string; password: string }) => ({ port: 5432, connectionString: 'postgres://local', connectionStringFor: () => '', remove }));
      await expect(withCleanup(async defer => {
        await acquireStarterPostgres(defer, { start, ready: async () => ready });
        throw new Error('journey failed');
      })).rejects.toThrow(ready ? 'journey failed' : 'starter_browser_postgres_not_ready');
      expect(start.mock.calls[0]![0]).not.toHaveProperty('image');
      expect(remove).toHaveBeenCalledOnce();
    }
  });
  it('removes both isolated PostgreSQL installations when the second setup fails', async () => {
    const removed: number[] = [];
    let number = 0;
    const start = async () => {
      const id = ++number;
      return { port: 5432, connectionString: 'postgres://local', connectionStringFor: () => '', remove: async () => { removed.push(id); } };
    };
    await expect(withCleanup(async defer => {
      await acquireStarterPostgres(defer, { start, ready: async () => true });
      await acquireStarterPostgres(defer, { start, ready: async () => false });
    })).rejects.toThrow('starter_browser_postgres_not_ready');
    expect(removed).toEqual([2, 1]);
  });
  it('refuses an unavailable mirror without any vendor or download fallback', async () => {
    const calls: string[][] = [];
    const io = {
      exec: async (argv: string[]) => {
        calls.push(argv);
        throw new Error(argv[0] === 'image' ? 'No such image' : 'unauthorized: authentication required');
      },
      sleep: async () => {}, now: () => 0,
    };
    await expect(resolveBrowserImage(io)).rejects.toThrow('no source succeeded');
    expect(calls.filter(argv => argv[0] === 'pull')).toEqual([['pull', imageReference(readCiImage('starter-browser'))]]);
    expect(calls.every(argv => argv.join(' ').includes('ghcr.io/openlup/playwright:'))).toBe(true);
  });
  it('refuses the explicit local upstream exception in CI', async () => {
    vi.stubEnv('CI', 'true');
    const local = imageReference(readCiImage('starter-browser'), 'mcr.microsoft.com/playwright');
    expect(() => parseArguments([...args, '--local-image', local])).toThrow('starter_browser_local_image_forbidden');
    await expect(resolveBrowserImage(undefined, local)).rejects.toThrow('starter_browser_local_image_forbidden');
    expect(() => browserArguments('/tmp/starter', local, 'proof', local)).toThrow('starter_browser_mirror_required');
  });
  it('requires the exact local upstream index and never pulls it automatically', async () => {
    vi.stubEnv('CI', '');
    const reference = imageReference(readCiImage('starter-browser'), 'mcr.microsoft.com/playwright');
    const exec = vi.fn(async (_args: string[], _timeout?: number) => JSON.stringify([reference.replace(/:[^/@]+@/u, '@')]));
    const io = { exec, sleep: async () => {}, now: () => 0 };
    expect(await resolveBrowserImage(io, reference)).toBe(reference);
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]).toEqual([['image', 'inspect', reference, '--format', '{{json .RepoDigests}}']]);
    exec.mockResolvedValueOnce(JSON.stringify(['mcr.microsoft.com/playwright@sha256:' + 'a'.repeat(64)]));
    await expect(resolveBrowserImage(io, reference)).rejects.toThrow('starter_browser_local_image_pin_required');
  });
  it('runs a pinned image with one worker, no downloads, read-only inputs and temporary results', () => {
    const reference = imageReference(readCiImage('starter-browser'));
    const command = browserArguments('/tmp/starter', reference, 'proof');
    expect(command).toContain('--pull=never');
    expect(command).toContain('--network=host');
    expect(command).toContain('--read-only');
    expect(command).toContain('type=bind,src=/tmp/starter,dst=/app,readonly');
    expect(command).toContain('--workers=1');
    expect(command).toContain('--output=/tmp/test-results');
    expect(command).not.toContain('install');
    expect(() => browserArguments('/tmp/starter', 'mcr.microsoft.com/playwright:latest', 'proof')).toThrow('starter_browser_mirror_required');
    const config = readFileSync('examples/neutral-store/playwright.database.config.ts', 'utf8');
    for (const setting of ["trace: 'off'", "screenshot: 'off'", "video: 'off'", "'journey.spec.ts'", "'acquisition.spec.ts'"]) expect(config).toContain(setting);
  });
  it('cleans browser, hosts, connections, PostgreSQL and scratch after a journey failure', async () => {
    const released: string[] = [];
    const acquired = ['scratch', 'PostgreSQL container', 'bootstrap', 'migration pool', 'host', 'browser container'];
    const failure = new Error('broken journey');
    await expect(withCleanup(async defer => {
      for (const resource of acquired) defer(async () => { released.push(resource); });
      throw failure;
    })).rejects.toBe(failure);
    expect(released).toEqual([...acquired].reverse());
  });
  it('attempts every cleanup even when one release fails and refuses cleanup failures', async () => {
    const released: number[] = [];
    await expect(withCleanup(async defer => {
      defer(() => { released.push(1); });
      defer(() => { throw new Error('release failed'); });
      defer(() => { released.push(3); });
    })).rejects.toThrow('starter_browser_cleanup_failed');
    expect(released).toEqual([3, 1]);
  });
  it('also cleans on success and returns the result', async () => {
    let closed = false;
    expect(await withCleanup(async defer => { defer(() => { closed = true; }); return 7; })).toBe(7);
    expect(closed).toBe(true);
  });
  it('scans raw challenge tokens and enveloped private recovery captures', () => {
    const token = 'rcv_' + 'x'.repeat(43);
    const values = capturePrivateValues({ version: 1, record: { email: 'capture@example.test',
      completionUrl: 'http://127.0.0.1/completion?token=' + token, orderRef: 'private-order-reference' } });
    expect(values).toContain(token);
    expect(values).toContain('private-order-reference');
    expect(capturePrivateValues({ token: 'challenge-token' })).toEqual(['challenge-token']);
    expect(() => scanPrivateOutput(token, values)).toThrow('starter_browser_private_output_detected');
    expect(() => scanPrivateOutput(token)).toThrow('starter_browser_private_output_detected');
  });
  it.each(['postgresql://runtime@localhost/demo', 'token: "abcdefghijklmnop"', 'x'.repeat(43), 'private@example.test', 'unlisted@example.test'])('refuses captured private output without echoing it: %s', value => {
    expect(() => scanPrivateOutput(value, ['private@example.test'])).toThrow('starter_browser_private_output_detected');
  });
  it('permits counts and safe host diagnostics', () => {
    expect(() => scanPrivateOutput('102 passed (20s)\nNeutral store local candidate: http://127.0.0.1:4319\n' + 'safe_identifier_'.repeat(5))).not.toThrow();
  });
  it('keeps the journeys inside the existing authenticated required job', () => {
    const workflow = readFileSync('.github/workflows/published-tree-ci.yml', 'utf8');
    const install = workflow.split('  install-proof:')[1]!.split('  test-full-shard:')[0]!;
    expect(install).toContain('packages: read');
    expect(install).toContain('timeout-minutes: 20');
    expect(install).toContain('docker login ghcr.io');
    expect(install).toContain('scripts/starter-browser-ci.mjs --manifest "$RUNNER_TEMP/package-gates/packages-manifest.json"');
    expect(workflow).toContain('needs: [dco, typecheck, install-proof, test, self-check, gitleaks]');
  });
});

describe('database connection errors', () => {
  it('fails a run whose work succeeded after an idle disconnect, and still releases every resource', async () => {
    const released: string[] = [];
    await expect(withConnectionCleanup(async (defer, guard) => {
      const pool = guard(new EventEmitter());
      defer(() => { released.push('postgres'); });
      expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
      return 'journeys passed';
    })).rejects.toThrow('starter_browser_database_connection_lost');
    expect(released).toEqual(['postgres']);
  });
  it('fails a run whose connection is lost during cleanup', async () => {
    await expect(withConnectionCleanup(async (defer, guard) => {
      const client = guard(new EventEmitter());
      defer(() => { client.emit('error', new Error('connection terminated unexpectedly')); });
      return 'journeys passed';
    })).rejects.toThrow('starter_browser_database_connection_lost');
  });
  it('returns the work result when every connection held', async () => {
    await expect(withConnectionCleanup(async (_defer, guard) => { guard(new EventEmitter()); return 'ok'; })).resolves.toBe('ok');
  });
  it('guards every PostgreSQL client and pool the runner creates', () => {
    const source = readFileSync('scripts/starter-browser-ci.mjs', 'utf8');
    expect(source.match(/new pg\.(?:Client|Pool)\(/gu)?.length).toBe(source.match(/guard\(new pg\.(?:Client|Pool)\(/gu)?.length);
    expect(source).toContain('await withConnectionCleanup(async (defer, guard) =>');
  });
});
