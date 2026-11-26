import childProcess, { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INVENTORY_PATH } from './agent-review-derived.mjs';
import { landingMerge, parseLandingCliOptions } from './agent-review-landing.mjs';
import { PG_SUITE_CLOSURES_PATH } from './agent-review-registry.mjs';
import { worktreeGateSuffix } from './resource-gate.mjs';
import { localFixtureEnvironment } from './fixtures/landing-test-environment.ts';
import {
  CATALOGUE,
  MATURITY_PAGE,
  PORTABILITY_REPORT,
  SETTING_CATALOGUE,
  SETTING_GUIDE,
  SETTING_REFUSALS,
  createDerivedFixture,
  fixtureEnvironment,
  installedLock,
  json,
  lockedDependency,
  npmCli,
  toolchainCheck,
  type DerivedFixture,
} from './fixtures/agent-review-derived-fixture.ts';

let f: DerivedFixture;

beforeAll(async () => {
  f = await createDerivedFixture({ runInitialLanding: false });
}, 180000);

afterAll(() => {
  f?.cleanup();
});

it('lands cold owner bytes after an added Core export and version bump on a warm incremental cache', () => {
  try {
    f.checkout(f.base);
    // Seed the previous package graph and exercise the cache-dependent emission originally used by landing.
    for (const owner of ['core', 'outbox', 'platform']) for (const leaf of ['dist', '.tsbuildinfo-build']) {
      rmSync(join(f.root, 'packages', owner, leaf), { force: true, recursive: true });
    }
    f.fixtureCommand(process.execPath, ['scripts/build-packages-incremental.mjs']);
    const declaration = 'packages/platform/dist/fulfillment/providerDispatchWorker.d.ts';
    const cleanDeclaration = f.read(declaration);
    const entry = 'packages/core/src/subscription/index.ts';
    f.write(entry, f.read(entry) + '\nexport const fixtureApi = 1;\n');
    f.write('packages/core/changes/fixture-cache.md', '- Add a fixture declaration.\n');
    f.fixtureCommand(process.execPath, ['scripts/build-packages-incremental.mjs']);
    const manifestPath = 'packages/core/package.json';
    const manifest = JSON.parse(f.read(manifestPath));
    manifest.version += '-fixture';
    f.write(manifestPath, json(manifest));
    const left = f.commit();
    f.checkout(f.base); const right = f.commit(); f.setMain(right); f.checkout(left);
    f.fixtureCommand(process.execPath, ['scripts/build-packages-incremental.mjs']);
    const warmDeclaration = f.read(declaration);
    expect(warmDeclaration).not.toBe(cleanDeclaration);

    f.landingCli();
    expect(f.git('show', '-s', '--format=%P')).toBe(`${left} ${right}`);
    expect(f.git('show', 'HEAD:packages/core/api/subscription.api.md')).toContain('declare const fixtureApi = 1');
    const landedDeclaration = f.read(declaration);
    expect(landedDeclaration).not.toBe(warmDeclaration);
    f.coldBuild('core', 'outbox', 'platform');
    expect(f.read(declaration)).toBe(landedDeclaration);
    for (const owner of ['core', 'outbox', 'platform']) f.fixtureNpm('run', 'api:check', `--workspace=@openlup/${owner}`);
    expect(f.git('status', '--porcelain')).toBe('');
  } finally { f.restoreDerivedFixture(); }
}, 240000);

describe('registered output conflicts', () => {
  beforeAll(() => {
    f.checkout(f.base);
    f.coldBuild('core', 'platform');
  }, 60000);

  it.each([
    { owner: 'API', paths: [PORTABILITY_REPORT] },
    { owner: 'settings', paths: [SETTING_CATALOGUE, SETTING_REFUSALS, SETTING_GUIDE] },
  ])('replaces the exact registered $owner output conflicts', async ({ paths }) => {
    try {
      const originals = paths.map(path => [path, f.git('show', `${f.base}:${path}`) + '\n'] as const);
      const parent = (label: string) => {
        f.checkout(f.base);
        for (const [path, original] of originals) f.write(path, label + '\n' + original);
        return f.commit();
      };
      const left = parent('First-parent edit'), right = parent('Main edit');
      f.setMain(right); f.checkout(left);
      // Only the output differs from the sources built in this group. Keep the real merge and owners.
      for (const revision of [left, right]) expect(f.git('diff', '--name-only', f.base, revision).split('\n')).toEqual([...paths].sort());
      await landingMerge(f.root, {
        runCommand: (command, args) => {
          if (args[0] === npmCli && args[1] === 'run' && args[2] === 'build') return;
          f.fixtureCommand(command, args);
        },
      });
      for (const [path, original] of originals) expect(f.read(path)).toBe(original);
      expect(f.git('status', '--porcelain')).toBe('');
    } finally { f.restoreDerivedFixture(); }
  }, 60000);
});

describe('the maturity reference page', () => {
  beforeAll(() => {
    f.checkout(f.base);
    f.coldBuild('core', 'platform');
  }, 60000);

  const conflict = async (edit: (label: string, page: string) => string) => {
    const original = f.read(MATURITY_PAGE);
    const parent = (label: string) => { f.checkout(f.base); f.write(MATURITY_PAGE, edit(label, original)); return f.commit(); };
    const left = parent('first-parent'), right = parent('main');
    f.setMain(right); f.checkout(left);
    const noBuild = { runCommand: (command: string, args: string[]) => { if (args[0] === npmCli && args[1] === 'run' && args[2] === 'build') return; f.fixtureCommand(command, args); } };
    return { original, land: () => landingMerge(f.root, noBuild) };
  };

  it('regenerates a conflict that sits inside a generated region and keeps the page prose', async () => {
    try {
      const header = '| Export | Symbol | Maturity | Deprecated |';
      const { original, land } = await conflict((label, page) => page.replace(header, `${header} ${label}`));
      expect(original).toContain(header);
      await land();
      expect(f.read(MATURITY_PAGE)).toBe(original);
      expect(f.git('status', '--porcelain')).toBe('');
    } finally { f.restoreDerivedFixture(); }
  }, 60000);

  it('refuses a conflict in the prose around the regions', async () => {
    try {
      const { land } = await conflict((label, page) => page.replace('# Maturity', `# Maturity ${label}`));
      await expect(land()).rejects.toThrow(`landing: authored conflicts remain: ${MATURITY_PAGE}`);
    } finally { f.restoreDerivedFixture(); }
  }, 60000);
});

it('stages a renamed report and validates its exact selector against the generated file', async () => {
  try {
    const newReport = 'packages/platform/api/portability-fixture.api.md';
    f.checkout(f.base); f.probeExport();
    const catalogue: { publicPaths: { path: string; class: string }[] } = JSON.parse(f.read(CATALOGUE));
    const registration = catalogue.publicPaths.find(({ path }) => path === PORTABILITY_REPORT);
    if (registration?.class !== 'public-output') throw new Error(`Fixture report is not registered: ${PORTABILITY_REPORT}`);
    registration.path = newReport;
    catalogue.publicPaths.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    f.write(CATALOGUE, json(catalogue));
    const routing = 'config/doc-routing.json';
    expect(f.read(routing)).toContain(`"${PORTABILITY_REPORT}"`);
    f.write(routing, f.read(routing).replace(`"${PORTABILITY_REPORT}"`, `"${newReport}"`));
    rmSync(join(f.root, PORTABILITY_REPORT));
    const gatesPath = 'packages/platform/release-gates.json';
    const gates = JSON.parse(f.read(gatesPath));
    gates.packageSurface['./portability'].snapshot = 'api/portability-fixture.api.md';
    f.write(gatesPath, json(gates)); const left = f.commit();
    f.checkout(f.base); const right = f.commit(); f.setMain(right); f.checkout(left);
    expect(f.git('ls-files', '--', newReport)).toBe('');
    await f.land();
    expect(f.git('show', `HEAD:${newReport}`)).toContain('declare const fixturePortability = 1');
    expect(f.git('ls-files', '--', PORTABILITY_REPORT)).toBe('');
    expect(f.read('docs/platform/SOURCE_MAP.md')).toContain(`\`${newReport}\``);
    expect(f.read('docs/platform/SOURCE_MAP.md')).not.toContain(`\`${PORTABILITY_REPORT}\``);
    f.fixtureCommand(process.execPath, ['packages/platform/scripts/api-contract.ts', '--update']);
    expect(f.git('status', '--porcelain')).toBe('');
  } finally { f.restoreDerivedFixture(); }
}, 180000);

it.each(['unregistered', 'executable', 'symlink'])('keeps a %s report conflict unresolved', async mode => {
  try {
    const path = mode === 'unregistered' ? 'packages/platform/api/unregistered-fixture.api.md' : PORTABILITY_REPORT;
    f.checkout(f.base);
    if (mode === 'symlink') {
      rmSync(join(f.root, path)); symlinkSync('../release-gates.json', join(f.root, path));
    } else f.write(path, 'First-parent edit\n');
    const left = f.commit();
    f.checkout(f.base);
    if (mode === 'symlink') {
      rmSync(join(f.root, path)); symlinkSync('../package.json', join(f.root, path));
    } else {
      f.write(path, 'Main edit\n');
      if (mode === 'executable') chmodSync(join(f.root, path), 0o755);
    }
    const right = f.commit(); f.setMain(right); f.checkout(left);
    await expect(f.land()).rejects.toThrow(`landing: authored conflicts remain: ${path}`);
    expect(f.git('diff', '--name-only', '--diff-filter=U')).toBe(path);
  } finally { f.restoreDerivedFixture(); }
}, 60000);

it.each([
  ['package-lock.json', '1', true],
  ['package-lock.json', undefined, true],
  ['package-lock.json', undefined, false],
  ['.npmrc', '1', true],
] as const)('lands a changed main lock through the selected install route (%s, marker %s, broker %s)', async (input, marker, hasBroker) => {
  const previousEnv = localFixtureEnvironment();
  const lockBytes = f.read(installedLock);
  const brokerDir = mkdtempSync(join(tmpdir(), 'openlup-landing-broker-'));
  const broker = join(brokerDir, 'ai-resource-gate');
  if (hasBroker) {
    writeFileSync(broker, '#!/bin/sh\nexit 0\n');
    chmodSync(broker, 0o700);
  }
  try {
    vi.stubEnv('AI_RESOURCE_GATE_ACTIVE', marker);
    vi.stubEnv('CI', undefined);
    vi.stubEnv('OPENLUP_DISABLE_RESOURCE_GATE', undefined);
    vi.stubEnv('PATH', hasBroker ? `${brokerDir}${delimiter}${previousEnv.PATH ?? ''}` : brokerDir);
    const { left, right } = f.startToolchainLanding(input);
    const mergeHead = () => existsSync(join(f.root, '.git/MERGE_HEAD')) ? f.git('rev-parse', 'MERGE_HEAD') : undefined;
    const calls: [string, string[], string | undefined][] = [];
    const landed = await landingMerge(f.root, {
      runCommand: (command, args) => {
        calls.push([command, args, mergeHead()]);
        if (!args.includes('ci')) return f.fixtureCommand(command, args);
        expect(f.git('diff', '--name-only', left, '--', input)).toBe(input);
        const installed = JSON.parse(lockBytes);
        installed.packages[lockedDependency] = JSON.parse(f.read('package-lock.json')).packages[lockedDependency];
        f.write(installedLock, json(installed));
      },
    });
    const install = marker === undefined && hasBroker
      ? [broker, ['run', '--wait', '--queue-timeout', '300', '--execution-timeout', '900', `openlup:landing-build:wt${worktreeGateSuffix(f.root)}`, '--', process.execPath, npmCli, 'ci'], right]
      : [process.execPath, [npmCli, 'ci'], right];
    expect(calls).toEqual([[process.execPath, toolchainCheck, undefined], install, [process.execPath, toolchainCheck, right]]);
    expect(f.git('show', '-s', '--format=%P%n%B', landed.head)).toBe(`${left} ${right}\nMerge origin/main and refresh derived carriers\n\nSigned-off-by: Fixture <fixture@example.invalid>`);
    expect(f.status()).toBe('');
  } finally {
    vi.stubEnv('AI_RESOURCE_GATE_ACTIVE', previousEnv.AI_RESOURCE_GATE_ACTIVE);
    vi.stubEnv('CI', previousEnv.CI);
    vi.stubEnv('OPENLUP_DISABLE_RESOURCE_GATE', previousEnv.OPENLUP_DISABLE_RESOURCE_GATE);
    vi.stubEnv('PATH', previousEnv.PATH);
    rmSync(brokerDir, { recursive: true, force: true });
    f.write(installedLock, lockBytes);
    f.restoreDerivedFixture();
  }
}, 60000);

it('aborts landing after a carrier failure', async () => {
  const injected = new TypeError('fixture carrier failed after writing');
  const keys = Reflect.ownKeys(injected).filter(key => key !== 'stack');
  const leftover = 'packages/platform/sql/landing-rollback-fixture.sql';
  const ignored = 'landing-fixture-local.log';
  try {
    f.checkout(f.base); f.probeExport(); const left = f.commit();
    const inventory = f.read(INVENTORY_PATH), report = f.read(PORTABILITY_REPORT);
    f.checkout(f.base); f.write(PORTABILITY_REPORT, report + '\nMain-only report edit.\n');
    f.write('.gitignore', f.read('.gitignore') + `\n!/${ignored}\n`);
    const right = f.commit(); f.setMain(right); f.checkout(left);
    f.write(ignored, 'Existing ignored output.\n');
    const runCommand = vi.fn((command: string, args: string[]) => {
      if (args[0] !== npmCli) return f.fixtureCommand(command, args);
      f.write(INVENTORY_PATH, 'Partial unchanged-by-merge carrier.\n');
      f.write(PORTABILITY_REPORT, 'Partial changed-by-merge carrier.\n');
      f.write(leftover, 'Partial untracked output.\n');
      throw injected;
    });
    const failure = await landingMerge(f.root, { runCommand }).catch(error => error);
    expect(failure).toBe(injected);
    expect(failure.message).toBe('fixture carrier failed after writing');
    expect(Object.getPrototypeOf(failure)).toBe(TypeError.prototype);
    expect(Reflect.ownKeys(failure).filter(key => key !== 'stack')).toEqual(keys);
    f.expectRestoredHead(left);
    expect(f.read(INVENTORY_PATH)).toBe(inventory);
    expect(f.read(PORTABILITY_REPORT)).toBe(report);
    expect(existsSync(join(f.root, leftover))).toBe(false);
    expect(f.read(ignored)).toBe('Existing ignored output.\n');
  } finally {
    rmSync(join(f.root, leftover), { force: true });
    rmSync(join(f.root, ignored), { force: true });
    f.restoreDerivedFixture();
  }
}, 60000);

it('preserves unrelated work saved during the brokered install', async () => {
  const injected = new Error('fixture brokered npm ci failed');
  const previousEnv = localFixtureEnvironment();
  const brokerDir = mkdtempSync(join(tmpdir(), 'openlup-landing-broker-'));
  const broker = join(brokerDir, 'ai-resource-gate');
  writeFileSync(broker, '#!/bin/sh\nexit 0\n');
  chmodSync(broker, 0o700);
  const untracked = 'landing-concurrent-note.txt';
  try {
    vi.stubEnv('AI_RESOURCE_GATE_ACTIVE', undefined);
    vi.stubEnv('CI', undefined);
    vi.stubEnv('OPENLUP_DISABLE_RESOURCE_GATE', undefined);
    vi.stubEnv('PATH', `${brokerDir}${delimiter}${previousEnv.PATH ?? ''}`);
    const { left } = f.startToolchainLanding('package-lock.json');
    const readme = f.read('README.md') + '\nConcurrent tracked edit.\n';
    const note = 'Concurrent untracked note.\n';
    const runCommand = (command: string, args: string[]) => {
      if (command !== broker) return f.fixtureCommand(command, args);
      f.write('README.md', readme);
      f.write(untracked, note);
      throw injected;
    };
    const failure = await landingMerge(f.root, { runCommand }).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors[0]).toBe(injected);
    expect(failure.message).toContain('OPENLUP_E_LANDING_ABORT_FAILED');
    expect(failure.message).toContain('README.md');
    expect(failure.message).toContain(untracked);
    expect(failure.message).not.toContain('the checkout is back at HEAD');
    expect(f.git('rev-parse', 'HEAD')).toBe(left);
    expect(existsSync(join(f.root, '.git/MERGE_HEAD'))).toBe(false);
    expect(readFileSync(join(f.root, 'README.md'))).toEqual(Buffer.from(readme));
    expect(readFileSync(join(f.root, untracked))).toEqual(Buffer.from(note));
  } finally {
    rmSync(join(f.root, untracked), { force: true });
    rmSync(brokerDir, { recursive: true, force: true });
    vi.stubEnv('AI_RESOURCE_GATE_ACTIVE', previousEnv.AI_RESOURCE_GATE_ACTIVE);
    vi.stubEnv('CI', previousEnv.CI);
    vi.stubEnv('OPENLUP_DISABLE_RESOURCE_GATE', previousEnv.OPENLUP_DISABLE_RESOURCE_GATE);
    vi.stubEnv('PATH', previousEnv.PATH);
    f.restoreDerivedFixture();
  }
}, 60000);

it('refuses to take ownership of an existing merge with an empty porcelain status', async () => {
  try {
    f.checkout(f.base); const right = f.commit(); f.setMain(right); f.checkout(f.base);
    f.git('commit', '--allow-empty', '-qm', 'First-parent fixture');
    const head = f.git('rev-parse', 'HEAD');
    f.git('merge', '--no-ff', '--no-commit', right);
    expect(f.status()).toBe('');
    const runCommand = vi.fn();
    await expect(landingMerge(f.root, { runCommand })).rejects.toThrow('landing: a merge is already in progress');
    expect(runCommand).not.toHaveBeenCalled();
    expect(f.git('rev-parse', 'MERGE_HEAD')).toBe(right);
    expect(f.git('rev-parse', 'HEAD')).toBe(head);
    expect(f.status()).toBe('');
  } finally { f.restoreDerivedFixture(); }
}, 60000);

it.each(['merged check', 'npm ci'])('aborts when the merged toolchain still fails after npm ci (%s failure)', async step => {
  const installError = new Error('fixture npm ci failed');
  const diagnostic = `carrier build: installed npm tree does not match package-lock.json (${lockedDependency}); run npm ci in this checkout`;
  const previousMarker = localFixtureEnvironment().AI_RESOURCE_GATE_ACTIVE;
  const npmShim = 'node_modules/.fixture-npm.cjs';
  const direct = vi.spyOn(childProcess, 'execFileSync');
  syncBuiltinESMExports();
  try {
    vi.stubEnv('AI_RESOURCE_GATE_ACTIVE', '1');
    const { left } = f.startToolchainLanding('package-lock.json');
    const runCommand = vi.fn((command: string, args: string[]) => {
      if (args[0] !== npmCli || args[1] !== 'ci') return f.fixtureCommand(command, args);
      if (step === 'npm ci') throw installError;
      // Simulate a successful install that leaves the local install record mismatched.
    });
    direct.mockClear();
    const failure = await landingMerge(f.root, { runCommand }).catch(error => error);
    const expectedCalls = [[process.execPath, toolchainCheck], [process.execPath, [npmCli, 'ci']]];
    if (step === 'merged check') expectedCalls.push([process.execPath, toolchainCheck]);
    expect(runCommand.mock.calls.map(([command, args]) => [command, args])).toEqual(expectedCalls);
    f.expectRestoredHead(left);
    if (step === 'npm ci') {
      // The HEAD check is the only inline Node subprocess. The generator and projection bypass runCommand.
      const inlineNode = direct.mock.calls.flatMap(([command, args]) =>
        command === process.execPath && Array.isArray(args) && args[0] === '--input-type=module' ? [args] : []);
      expect(inlineNode).toEqual([toolchainCheck]);
      expect(failure).toBe(installError);
      return;
    }
    expect(failure.stderr).toContain(diagnostic);

    f.write(npmShim, `const { argv, exit } = require('node:process');
      const command = argv[2];
      if (command === '--version') console.log(${JSON.stringify(f.fixtureNpm('--version').trim())});
      else if (command !== 'ci') exit(1);\n`);
    const cli = spawnSync(process.execPath, ['scripts/agent-review-landing.mjs'], {
      cwd: f.root, env: { ...fixtureEnvironment, AI_RESOURCE_GATE_ACTIVE: '1', npm_execpath: join(f.root, npmShim) }, encoding: 'utf8', timeout: 180000,
    });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain(`OPENLUP_E_LANDING_TOOLCHAIN: ${diagnostic}\nafter npm ci from the merged lock`);
    expect(cli.stderr).toContain('OPENLUP_E_LANDING_ABORTED: merge aborted; the checkout is back at HEAD');
    f.expectRestoredHead(left);
  } finally {
    vi.stubEnv('AI_RESOURCE_GATE_ACTIVE', previousMarker);
    direct.mockRestore();
    syncBuiltinESMExports();
    rmSync(join(f.root, npmShim), { force: true });
    f.restoreDerivedFixture();
  }
}, 60000);

it('retains the original failure when merge abort fails', async () => {
  const injected = new Error('fixture carrier failure before abort');
  const indexLock = '.git/index.lock';
  try {
    f.checkout(f.base); f.probeExport(); const left = f.commit();
    f.checkout(f.base); const right = f.commit(); f.setMain(right); f.checkout(left);
    const failure = await landingMerge(f.root, {
      runCommand: (command, args) => {
        if (args[0] !== npmCli) return f.fixtureCommand(command, args);
        f.write(indexLock, 'Fixture abort obstruction.\n');
        throw injected;
      },
    }).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.cause).toBe(injected);
    expect(failure.errors[0]).toBe(injected);
    expect(failure.errors[1].stderr).toContain('index.lock');
    expect(failure.message).toContain(injected.message);
    expect(failure.message).toContain('OPENLUP_E_LANDING_ABORT_FAILED');
    expect(failure.message).toContain('MERGE_HEAD present');
    expect(failure.message).not.toContain('the checkout is back at HEAD');
    expect(f.git('rev-parse', 'MERGE_HEAD')).toBe(right);
  } finally {
    rmSync(join(f.root, indexLock), { force: true });
    f.restoreDerivedFixture();
  }
}, 60000);

it('refuses an inventory-only landing with a mismatched installed dependency before writing', () => {
  const lockBytes = f.read(installedLock);
  const indexBytes = () => readFileSync(join(f.root, '.git/index'));
  const trackedDigest = () => {
    const hash = createHash('sha256');
    for (const path of f.git('ls-files', '-z').split('\0').filter(Boolean)) {
      hash.update(path).update('\0').update(createHash('sha256').update(readFileSync(join(f.root, path))).digest());
    }
    return hash.digest('hex');
  };
  try {
    f.checkout(f.base);
    const manifest = 'scripts/platform-migration-manifest.ts';
    f.write(manifest, f.read(manifest) + '\n// Fixture inventory input.\n');
    const left = f.commit();
    expect(f.git('diff', '--name-only', f.base, left)).toBe(manifest);
    f.checkout(f.base);
    f.write('README.md', f.read('README.md') + '\nFixture main change.\n');
    const right = f.commit(); f.setMain(right); f.checkout(left);
    const lock = JSON.parse(lockBytes);
    lock.packages['node_modules/zod'].version = '0.0.0-fixture';
    f.write(installedLock, json(lock));
    const bytes = trackedDigest(), index = indexBytes();

    expect(f.landingCli).toThrow('carrier build: installed npm tree does not match package-lock.json (node_modules/zod); run npm ci in this checkout');
    expect(trackedDigest()).toBe(bytes);
    expect(indexBytes()).toEqual(index);
    expect(f.git('rev-parse', 'HEAD')).toBe(left);
    expect(existsSync(join(f.root, '.git/MERGE_HEAD'))).toBe(false);
  } finally {
    f.write(installedLock, lockBytes);
    f.restoreDerivedFixture();
  }
}, 30000);

it('resolves a clean pg-suite-closures union during landingMerge while refusing divergent additions', async () => {
  try {
    f.checkout(f.base);
    const original = JSON.parse(f.read(PG_SUITE_CLOSURES_PATH)) as { schemaVersion: number; suites: Record<string, string[]> };
    const firstKey = Object.keys(original.suites)[0]!;
    const branchKey = firstKey.replace(/\.test\.ts$/u, 'ZzzBranch.test.ts');
    const mainKey = firstKey.replace(/\.test\.ts$/u, 'ZzzMain.test.ts');
    const sorted = (suites: Record<string, string[]>) =>
      Object.fromEntries(Object.entries(suites).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const render = (suites: Record<string, string[]>) =>
      `${JSON.stringify({ schemaVersion: original.schemaVersion, suites: sorted(suites) }, null, 2)}\n`;

    f.write(PG_SUITE_CLOSURES_PATH, render({ ...original.suites, [branchKey]: ['@api'] }));
    const left = f.commit();
    f.checkout(f.base);
    f.write(PG_SUITE_CLOSURES_PATH, render({ ...original.suites, [mainKey]: ['@starter'] }));
    const right = f.commit();
    f.setMain(right);
    f.checkout(left);
    const landed = await landingMerge(f.root, {
      runCommand: (command, args) => {
        if (args[0] === npmCli && args[1] === 'run' && args[2] === 'build') return;
        f.fixtureCommand(command, args);
      },
    });
    expect(landed.main).toBe(right);
    expect(f.read(PG_SUITE_CLOSURES_PATH)).toBe(render({ ...original.suites, [branchKey]: ['@api'], [mainKey]: ['@starter'] }));
    expect(f.status()).toBe('');
  } finally { f.restoreDerivedFixture(); }
}, 60000);

it('runs post-commit build and typecheck after the merge commit when verify is enabled', async () => {
  try {
    f.checkout(f.base);
    f.write('README.md', f.read('README.md') + '\nFixture branch verify pass.\n');
    const left = f.commit();
    f.checkout(f.base);
    const right = f.commit();
    f.setMain(right);
    f.checkout(left);
    const buildScript = join(f.root, 'scripts/build-packages-incremental.mjs');
    const typecheckScript = join(f.root, 'scripts/oss-published-tree-check.ts');
    const calls: { command: string; args: string[]; head: string; merging: boolean }[] = [];
    const landed = await landingMerge(f.root, {
      verify: true,
      runCommand: (command, args) => {
        calls.push({ command, args, head: f.git('rev-parse', 'HEAD'), merging: existsSync(join(f.root, '.git/MERGE_HEAD')) });
        if (args[0] === buildScript || args.includes(typecheckScript)) return '';
        return f.fixtureCommand(command, args);
      },
    });
    expect(landed.verified).toBe(true);
    expect(f.git('show', '-s', '--format=%P', landed.head)).toBe(`${left} ${right}`);
    expect(calls).toEqual([
      { command: process.execPath, args: toolchainCheck, head: left, merging: false },
      { command: process.execPath, args: [buildScript], head: landed.head, merging: false },
      { command: process.execPath, args: ['--experimental-strip-types', typecheckScript, '--typecheck'], head: landed.head, merging: false },
    ]);
    expect(f.status()).toBe('');
  } finally {
    f.restoreDerivedFixture();
  }
}, 60000);

it('preserves the merge commit without rolling back when post-commit verify fails', async () => {
  try {
    f.checkout(f.base);
    f.write('README.md', f.read('README.md') + '\nFixture branch verify fail.\n');
    const left = f.commit();
    f.checkout(f.base);
    const right = f.commit();
    f.setMain(right);
    f.checkout(left);
    const buildScript = join(f.root, 'scripts/build-packages-incremental.mjs');
    const typecheckScript = join(f.root, 'scripts/oss-published-tree-check.ts');
    let committedHead: string | undefined;
    const failure = await landingMerge(f.root, {
      verify: true,
      runCommand: (command, args) => {
        if (args[0] === buildScript) {
          committedHead = f.git('rev-parse', 'HEAD');
          return '';
        }
        if (args.includes(typecheckScript)) {
          throw new Error('synthetic post-merge typecheck drift');
        }
        return f.fixtureCommand(command, args);
      },
    }).catch(error => error);
    expect(committedHead).toBeTruthy();
    expect(committedHead).not.toBe(left);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain(`OPENLUP_E_LANDING_VERIFY_FAILED: merge commit ${committedHead} was preserved (not rolled back)`);
    expect(failure.message).toContain('synthetic post-merge typecheck drift');
    expect(f.git('rev-parse', 'HEAD')).toBe(committedHead);
    expect(f.git('show', '-s', '--format=%P', committedHead!)).toBe(`${left} ${right}`);
    expect(existsSync(join(f.root, '.git/MERGE_HEAD'))).toBe(false);
    expect(f.status()).toBe('');
  } finally {
    f.restoreDerivedFixture();
  }
}, 60000);

it('parses landing CLI flags with verify enabled by default and --no-verify opt-out', () => {
  expect(parseLandingCliOptions([])).toEqual({ reSlot: false, verify: true });
  expect(parseLandingCliOptions(['--no-verify'])).toEqual({ reSlot: false, verify: false });
  expect(parseLandingCliOptions(['--re-slot'])).toEqual({ reSlot: true, verify: true });
  expect(parseLandingCliOptions(['--re-slot', '--no-verify'])).toEqual({ reSlot: true, verify: false });
});
