import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserArguments, parseArguments, resolveBrowserImage, scanPrivateOutput, withCleanup } from './starter-browser-ci.mjs';
import { imageReference, readCiImage } from './ci-image-pull.mjs';

const args = ['--manifest', '/tmp/packs/packages-manifest.json', '--expected-commit', 'a'.repeat(40), '--service-port', '5432'];

describe('installed starter browser CI', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('accepts only the explicit candidate manifest and service port', () => {
    expect(parseArguments(args)).toEqual({ manifest: args[1], commit: args[3], port: '5432' });
    expect(parseArguments([...args.slice(4), ...args.slice(0, 4)])).toEqual(parseArguments(args));
  });
  it.each([[], args.slice(0, -1), [...args, '--preview', 'true'], [...args, '--service-port', '5433'],
    [...args.slice(0, 4), '--service-port', '0'], [...args.slice(0, 4), '--service-port', '65536'],
    ['--manifest', '--expected-commit', 'a'.repeat(40), '--service-port', '5432'],
    ['--manifest', 'pack.json', '--expected-commit', 'main', '--service-port', '5432'],
  ].map(input => [input]))('refuses malformed, missing, duplicate or unknown arguments: %j', input => {
    expect(() => parseArguments(input)).toThrow('starter_browser_arguments_invalid');
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
  it('cleans container, hosts, pools, databases, roles and scratch after a journey failure', async () => {
    const released: string[] = [];
    const acquired = ['scratch', 'bootstrap', 'role', 'database', 'migration pool', 'host', 'browser container'];
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
  it.each(['postgresql://runtime@localhost/demo', 'token: "abcdefghijklmnop"', 'x'.repeat(43), 'private@example.test'])('refuses captured private output without echoing it: %s', value => {
    expect(() => scanPrivateOutput(value, ['private@example.test'])).toThrow('starter_browser_private_output_detected');
  });
  it('permits counts and safe host diagnostics', () => {
    expect(() => scanPrivateOutput('102 passed (20s)\nNeutral store local candidate: http://127.0.0.1:4319')).not.toThrow();
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
