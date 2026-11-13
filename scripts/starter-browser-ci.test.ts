import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import pg from 'pg';
import { acquireStarterPostgres, browserArguments, capturePrivateValues, parseArguments, resolveBrowserImage, runBrowserGroups, scanPrivateOutput, withCleanup, withConnectionCleanup, writeBrowserFixtures, watchStarterHost } from './starter-browser-ci.mjs';
import { imageReference, readCiImage } from './ci-image-pull.mjs';
import { browserJourneyGroups } from '../examples/neutral-store/browser-groups.mjs';

const args = ['--manifest', '/tmp/packs/packages-manifest.json', '--expected-commit', 'a'.repeat(40)];

describe('installed starter browser CI', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(['postgres_supplements', 'install_coffee', 'seed_supplements', 'runtime', 'host_coffee', 'cancelled'])('stops after an early group fails during %s', async phase => {
    const started: number[] = [], released: number[] = [];
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('infrastructure failed');
    try {
      await expect(runBrowserGroups(async index => withCleanup(async defer => {
        started.push(index);
        defer(() => { released.push(index); });
        throw failure;
      }), () => phase)).rejects.toBe(failure);
      expect(started).toEqual([0]);
      expect(released).toEqual([0]);
      expect(report).toHaveBeenCalledWith(`Starter browser group 1 failed during ${phase}`);
    } finally { report.mockRestore(); }
  });
  it('runs later groups after a Playwright failure and still reports the failed run', async () => {
    const started: number[] = [];
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('test failed');
    try {
      await expect(runBrowserGroups(async index => {
        started.push(index);
        if (index === 0) throw failure;
      }, () => 'journeys')).rejects.toBe(failure);
      expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(report).toHaveBeenCalledWith('Starter browser group 1 failed during journeys');
    } finally { report.mockRestore(); }
  });
  it('accepts only the explicit candidate manifest', () => {
    expect(parseArguments(args)).toEqual({ manifest: args[1], commit: args[3] });
    expect(parseArguments([...args.slice(2), ...args.slice(0, 2)])).toEqual(parseArguments(args));
  });
  it('selects only the requested groups, preserving original selections and group numbers', async () => {
    const options = parseArguments([...args, '--groups', '3,0']);
    expect(options.groups).toEqual([3, 0]);
    const run = vi.fn(async () => {});
    await runBrowserGroups(run, () => 'journeys', options.groups);
    expect(run.mock.calls).toEqual([[3, browserJourneyGroups[3]], [0, browserJourneyGroups[0]]]);
    const released: number[] = [];
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runBrowserGroups(async index => withCleanup(async defer => {
        defer(() => { released.push(index); });
        throw new Error('setup failed');
      }), () => 'seed_coffee', options.groups)).rejects.toThrow('setup failed');
      expect(released).toEqual([3]);
      expect(report).toHaveBeenCalledWith('Starter browser group 4 failed during seed_coffee');
    } finally { report.mockRestore(); }
    const source = readFileSync('scripts/starter-browser-ci.mjs', 'utf8');
    expect(source).toContain("phase, options.groups)");
  });
  it.each(['', '0,0', '-1', '7', '1,7', '1.5', '01', '0,', ',0', '0, 1', '1e0', 'NaN'])('refuses an invalid group subset: %s', groups => {
    expect(() => parseArguments([...args, '--groups', groups])).toThrow('starter_browser_arguments_invalid');
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
    expect(command).toContain('type=bind,src=/tmp/starter/.context/care-browser,dst=/app/.context/care-browser');
    expect(command[command.indexOf('--user') + 1]).toBe(`${process.getuid!()}:${process.getgid!()}`);
    expect(command).toContain('--workers=1');
    expect(command).toContain('--retries=0');
    expect(command).toContain('--output=/tmp/test-results');
    expect(command).not.toContain('install');
    expect(() => browserArguments('/tmp/starter', 'mcr.microsoft.com/playwright:latest', 'proof')).toThrow('starter_browser_mirror_required');
    const config = readFileSync('examples/neutral-store/playwright.database.config.ts', 'utf8');
    for (const setting of ["trace: 'off'", "screenshot: 'off'", "video: 'off'", "'journey.spec.ts'", "'acquisition.spec.ts'"]) expect(config).toContain(setting);
  });
  it('writes both private care fixtures and credential-free UI origins inside cleanup', async () => {
    const app = await mkdtemp(join(tmpdir(), 'starter-care-fixtures-'));
    const entries = ['supplements', 'coffee'].map((id, index) => ({ id, baseURL: `http://127.0.0.1:${4319 + index}`,
      ownerUrl: `postgresql://installer:synthetic@127.0.0.1/${id}`, runtimeUrl: `postgresql://runtime:synthetic@127.0.0.1/${id}`,
      state: `/app/.context/care-browser/${id}` }));
    await expect(withCleanup(async defer => {
      defer(() => rm(app, { recursive: true, force: true }));
      await writeBrowserFixtures(app, entries);
      const fixture = join(app, '.context/care-browser/fixtures.json');
      expect(JSON.parse(await readFile(fixture, 'utf8'))).toEqual(entries);
      expect((await stat(fixture)).mode & 0o777).toBe(0o600);
      expect((await stat(join(app, '.context/care-browser'))).mode & 0o777).toBe(0o700);
      expect(JSON.parse(await readFile(join(app, '.context/database-ui-hosts.json'), 'utf8')))
        .toEqual(entries.map(({ id, baseURL }) => ({ id, baseURL })));
      throw new Error('journey failed');
    })).rejects.toThrow('journey failed');
    await expect(stat(app)).rejects.toMatchObject({ code: 'ENOENT' });
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
  it('keeps every journey under the authenticated required install-proof context', () => {
    const workflow = readFileSync('.github/workflows/published-tree-ci.yml', 'utf8');
    const install = workflow.split('  install-browser:')[1]!.split('  install-proof:')[0]!;
    expect(install).toContain('packages: read');
    expect(install).toContain('timeout-minutes: 8');
    expect(install).toContain('docker login ghcr.io');
    expect(install.indexOf('docker login')).toBeLessThan(install.indexOf('scripts/starter-browser-ci.mjs'));
    expect(install).toContain('scripts/starter-browser-ci.mjs --manifest "$RUNNER_TEMP/package-gates/packages-manifest.json" --expected-commit "$(git rev-parse HEAD)" --groups "$BROWSER_GROUPS"');
    expect(install).toContain('needs: [install-packages]');
    expect(workflow).toContain('needs: [install-packages, install-browser]');
    const groups = install.match(/groups: \[(.*)\]/u)![1]!.replaceAll("'", '').split(', ').flatMap(shard => shard.split(',').map(Number));
    expect(groups.sort((left, right) => left - right)).toEqual(browserJourneyGroups.map((_, index) => index));
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
  it('fails a run whose borrowed pool client disconnects while lent out', async () => {
    const pool = new pg.Pool({ connectionString: 'postgresql://127.0.0.1:1/unused' });
    await expect(withConnectionCleanup(async (defer, guard) => {
      guard(pool);
      defer(() => pool.end());
      const borrowed = new EventEmitter();
      pool.emit('connect', borrowed);
      expect(() => borrowed.emit('error', new Error('connection terminated unexpectedly'))).not.toThrow();
      return 'journeys passed';
    })).rejects.toThrow('starter_browser_database_connection_lost');
  });
  it('fails, after cleanup, a run whose unguarded helper connection errors outside any listener', () => {
    // A child process: inside Vitest the test runner itself would report the uncaught error.
    const script = `import { EventEmitter, once } from 'node:events';
import { withConnectionCleanup } from './scripts/starter-browser-ci.mjs';
const released = [];
try {
  await withConnectionCleanup(async defer => {
    defer(() => { released.push('postgres'); });
    const probe = new EventEmitter();
    await new Promise(resolve => setImmediate(() => { resolve(); probe.emit('error', new Error('Connection terminated unexpectedly')); }));
    await new Promise(resolve => setImmediate(resolve));
    return 'journeys passed';
  });
  console.log('passed');
} catch (error) { console.log(error.message, released.join(',')); }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('starter_browser_database_connection_lost postgres');
  });
  it('returns the work result when every connection held', async () => {
    await expect(withConnectionCleanup(async (_defer, guard) => { guard(new EventEmitter()); return 'ok'; })).resolves.toBe('ok');
  });
  it('guards every PostgreSQL client and pool the runner creates', () => {
    const source = readFileSync('scripts/starter-browser-ci.mjs', 'utf8');
    expect(source.match(/new pg\.(?:Client|Pool)\(/gu)?.length).toBe(source.match(/guard\(new pg\.(?:Client|Pool)\(/gu)?.length);
    expect(source).toContain('await withConnectionCleanup(async (defer, guard, recordLoss) =>');
  });
});

describe('starter host process losses', () => {
  const start = () => spawn(process.execPath, ['-e',
    "process.on('message', () => process.exit(0)); process.send('ready');"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  it('fails after cleanup when a ready host exits on its own, including exit zero', async () => {
    const released: string[] = [];
    await expect(withConnectionCleanup(async (defer, _guard, recordLoss) => {
      defer(() => { released.push('container'); });
      defer(() => { released.push('other host'); });
      const child = start();
      const exited = watchStarterHost(child, 'supplements', defer, recordLoss);
      expect((await once(child, 'message'))[0]).toBe('ready');
      const stopped = once(child, 'exit');
      child.send('exit'); await stopped;
      expect(exited()).toBe(true);
      expect(released).toEqual([]);
      return 'journeys passed';
    })).rejects.toThrow('starter_browser_host_supplements_exited');
    expect(released).toEqual(['other host', 'container']);
  });
  it('accepts an intentional host stop through cleanup', async () => {
    const child = start();
    await expect(withConnectionCleanup(async (defer, _guard, recordLoss) => {
      watchStarterHost(child, 'coffee', defer, recordLoss);
      expect((await once(child, 'message'))[0]).toBe('ready');
      return 'journeys passed';
    })).resolves.toBe('journeys passed');
    expect(child.signalCode).toBe('SIGTERM');
  });
  it('records a real spawn error and fails only after the remaining cleanup', async () => {
    let cleaned = false;
    await expect(withConnectionCleanup(async (defer, _guard, recordLoss) => {
      defer(() => { cleaned = true; });
      const child = spawn(process.execPath + '-nonexistent', [], { stdio: 'ignore' });
      watchStarterHost(child, 'coffee', defer, recordLoss);
      await new Promise(done => child.once('close', done));
      expect(cleaned).toBe(false);
      return 'journeys passed';
    })).rejects.toThrow('starter_browser_host_coffee_exited');
    expect(cleaned).toBe(true);
  });
  it('records an error from a still-live child and then intentionally stops it', async () => {
    const child = start();
    let cleaned = false;
    await expect(withConnectionCleanup(async (defer, _guard, recordLoss) => {
      defer(() => { cleaned = true; });
      watchStarterHost(child, 'supplements', defer, recordLoss);
      await once(child, 'message');
      child.emit('error', new Error('host process error'));
      expect(cleaned).toBe(false);
      return 'journeys passed';
    })).rejects.toThrow('starter_browser_host_supplements_exited');
    expect(child.signalCode).toBe('SIGTERM');
    expect(cleaned).toBe(true);
  });
});
