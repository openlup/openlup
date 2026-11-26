import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, vi } from 'vitest';
import { INVENTORY_PATH, MIGRATION_REGISTRIES, inventoryEnvelope } from '../agent-review-derived.mjs';
import { syncSqlReference } from '../agent-review-generators.mjs';
import { carrierLocale, landingMerge } from '../agent-review-landing.mjs';
import { captureCommittedReviewCandidate, proveReviewIntegration } from '../agent-review-session.mjs';
import { fixtureNpmCli, linkFixtureInstallation, localFixtureEnvironment } from './landing-test-environment.ts';
import { checkPlatformMigrationProjection } from '../packages/platform-migration-projection.ts';

export const CATALOGUE = 'config/openlup-publication-catalog.json';
export const SQL_REFERENCE = 'packages/core/docs/guide/reference/sql.md';
export const SQL_HEADING = '# SQL catalogue';
export const MAIN_SQL_HEADING = '# Package SQL catalogue';
export const PORTABILITY = 'packages/platform/src/portability/index.ts';
export const PORTABILITY_REPORT = 'packages/platform/api/portability.api.md';
export const SETTING_DATA = 'packages/platform/src/inventory/settings-data.json';
export const SETTING_CATALOGUE = 'packages/platform/settings-catalog.json';
export const SETTING_REFUSALS = 'packages/platform/settings-refusals.json';
export const SETTING_GUIDE = 'packages/core/docs/guide/how-to/operate/settings-catalogue.md';
export const MATURITY_PAGE = 'packages/core/docs/guide/reference/maturity.md';
export const PROBE_OUTPUTS = [PORTABILITY_REPORT, SETTING_CATALOGUE, SETTING_REFUSALS, SETTING_GUIDE, MATURITY_PAGE];
export const PROBE_KEY = 'inventory.fixtureReservation';
export const installedLock = 'node_modules/.package-lock.json';
export const lockedDependency = 'node_modules/zod';
export const toolchainCheck = ['--input-type=module', '-e', expect.stringContaining('assertCarrierToolchain(process.cwd())')];

export const npmCli = fixtureNpmCli();
export const fixtureEnvironment = { ...localFixtureEnvironment(), ...carrierLocale, npm_execpath: npmCli };

export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

const runLandingMerge = landingMerge as (
  root: string,
  options?: { reSlot?: boolean; runCommand?: (command: string, args: string[]) => unknown },
) => Promise<{ head: string; main: string; inventoryRefreshed: boolean }>;

export interface DerivedFixture {
  root: string;
  base: string;
  reviewed: string;
  main: string;
  merged: string;
  initialLandingCommands: { command: string; args: string[] }[];
  initialLandingResult: { head: string; main: string; inventoryRefreshed: boolean } | undefined;
  git: (...args: string[]) => string;
  read: (path: string) => string;
  write: (path: string, value: string) => void;
  commit: () => string;
  append: (slot: string) => void;
  fixtureCommand: (command: string, args: string[]) => string;
  fixtureNpm: (...args: string[]) => string;
  coldBuild: (...owners: string[]) => void;
  landingCli: () => string;
  land: () => Promise<{ head: string; main: string; inventoryRefreshed: boolean }>;
  checkout: (rev: string) => void;
  setMain: (rev: string) => void;
  status: () => string;
  expectRestoredHead: (head: string) => void;
  startToolchainLanding: (input: 'package-lock.json' | '.npmrc') => { left: string; right: string };
  probeExport: () => void;
  probeSetting: () => void;
  restoreDerivedFixture: () => void;
  proof: (head?: string) => ReturnType<typeof proveReviewIntegration>;
  cleanup: () => void;
}

export async function createDerivedFixture(options: { runInitialLanding?: boolean } = {}): Promise<DerivedFixture> {
  const source = process.cwd();
  const runInitialLanding = options.runInitialLanding ?? true;
  const state: DerivedFixture = {
    root: '',
    base: '',
    reviewed: '',
    main: '',
    merged: '',
    initialLandingCommands: [],
    initialLandingResult: undefined,
    git: (...args: string[]) => execFileSync('/usr/bin/git', [
      '--no-replace-objects', '-C', state.root, '-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgSign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args,
    ], { env: fixtureEnvironment, encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024 * 1024 }).trim(),
    read: (path: string) => readFileSync(join(state.root, path), 'utf8'),
    write: (path: string, value: string) => {
      mkdirSync(dirname(join(state.root, path)), { recursive: true });
      writeFileSync(join(state.root, path), value);
    },
    commit: () => {
      state.git('add', '-A');
      state.git('commit', '--allow-empty', '-qm', 'Synthetic forward', '-s');
      return state.git('rev-parse', 'HEAD');
    },
    append: (slot: string) => {
      const file = `db/platform/migrations/${slot}_landing_fixture.sql`;
      const sql = '-- Synthetic no-op forward\nSELECT 1;\n';
      state.write(file, sql);
      const sha256 = createHash('sha256').update(sql).digest('hex');
      const manifest = JSON.parse(state.read(MIGRATION_REGISTRIES[0]));
      for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) plan.forward.push({ file, sha256 });
      state.write(MIGRATION_REGISTRIES[0], json(manifest));
      const registry = JSON.parse(state.read(MIGRATION_REGISTRIES[1]));
      registry.nativeStoreForwardClass.slots.push({ row: `fixture-${slot}`, path: file, replacedFunctions: [], createdFunctions: [] });
      registry.nativeStoreForwards.push({ path: file, sha256, functions: [] });
      state.write(MIGRATION_REGISTRIES[1], json(registry));
      expect(checkPlatformMigrationProjection(state.root, true)).toEqual([]);
      state.write(SQL_REFERENCE, syncSqlReference(state.root));
    },
    fixtureCommand: (command: string, args: string[]) => execFileSync(command, args, {
      cwd: state.root, env: fixtureEnvironment, encoding: 'utf8', timeout: 180000,
      maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }),
    fixtureNpm: (...args: string[]) => state.fixtureCommand(process.execPath, [npmCli, ...args]),
    coldBuild: (...owners: string[]) => {
      for (const owner of owners) state.fixtureNpm('run', 'build', `--workspace=@openlup/${owner}`);
    },
    landingCli: () => state.fixtureNpm('run', 'landing:merge'),
    land: () => runLandingMerge(state.root, { runCommand: state.fixtureCommand }),
    checkout: (rev: string) => {
      state.git('reset', '--hard');
      state.git('checkout', '-q', '--detach', rev);
    },
    setMain: (rev: string) => {
      state.git('branch', '-f', 'main', rev);
      state.git('update-ref', 'refs/remotes/origin/main', rev);
    },
    status: () => state.git('status', '--porcelain=v1', '--untracked-files=all'),
    expectRestoredHead: (head: string) => {
      expect(state.git('rev-parse', 'HEAD')).toBe(head);
      expect(existsSync(join(state.root, '.git/MERGE_HEAD'))).toBe(false);
      expect(state.status()).toBe('');
    },
    startToolchainLanding: (input: 'package-lock.json' | '.npmrc') => {
      state.checkout(state.base);
      state.write('README.md', state.read('README.md') + '\nFixture branch change.\n');
      const left = state.commit();
      state.checkout(state.base);
      if (input === 'package-lock.json') {
        const lock = JSON.parse(state.read(input));
        lock.packages[lockedDependency].version = '0.0.0-fixture';
        state.write(input, json(lock));
      } else {
        state.write(input, state.read(input).replace('legacy-peer-deps=true', 'legacy-peer-deps=false'));
      }
      const right = state.commit();
      state.setMain(right);
      state.checkout(left);
      return { left, right };
    },
    probeExport: () => {
      state.write(PORTABILITY, state.read(PORTABILITY) + '\n/**\n * @experimental A fixture declaration.\n * @deprecated Fixture only.\n */\nexport const fixturePortability = 1;\n');
      state.write('packages/platform/changes/fixture-portability.md', '- Add an experimental portability fixture and describe reservation policy.\n');
    },
    probeSetting: () => {
      const data = JSON.parse(state.read(SETTING_DATA));
      data.push({ ...data.find((entry: { kind: string }) => entry.kind === 'invariant'), key: PROBE_KEY, goal: 'Describe fixture reservation replay.' });
      state.write(SETTING_DATA, json(data));
    },
    restoreDerivedFixture: () => {
      if (existsSync(join(state.root, '.git/MERGE_HEAD'))) state.git('merge', '--abort');
      state.checkout(state.merged);
      state.setMain(state.main);
    },
    proof: async (head = state.merged) => proveReviewIntegration(
      state.root,
      await captureCommittedReviewCandidate(state.root, state.base, state.reviewed),
      await captureCommittedReviewCandidate(state.root, state.main, head),
    ),
    cleanup: () => {
      vi.unstubAllEnvs();
      if (state.root) rmSync(state.root, { recursive: true, force: true });
    },
  };

  try {
    vi.stubEnv('npm_execpath', npmCli);
    state.root = realpathSync(mkdtempSync(join(tmpdir(), 'openlup-derived-live-')));
    execFileSync('/usr/bin/git', ['clone', '--shared', '--no-hardlinks', '-q', source, state.root], { env: fixtureEnvironment, timeout: 30000 });
    state.git('checkout', '-q', '--detach');
    // The clone already has HEAD. Overlay only differences during local development.
    const sourcePaths = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: source, env: fixtureEnvironment, encoding: 'utf8' }).split('\0').filter(Boolean);
    const overlays = new Set([
      ...sourcePaths('diff', '--name-only', '--no-renames', '-z', 'HEAD'),
      ...sourcePaths('ls-files', '-z', '--others', '--exclude-standard'),
    ]);
    for (const path of overlays) {
      if (!existsSync(join(source, path))) {
        rmSync(join(state.root, path), { force: true });
        continue;
      }
      mkdirSync(dirname(join(state.root, path)), { recursive: true });
      cpSync(join(source, path), join(state.root, path));
    }
    linkFixtureInstallation(source, state.root);
    state.git('config', 'user.name', 'Fixture');
    state.git('config', 'user.email', 'fixture@example.invalid');
    state.base = state.commit();
    state.git('remote', 'set-url', 'origin', '.');

    if (!runInitialLanding) {
      state.reviewed = state.base;
      state.main = state.base;
      state.merged = state.base;
      state.setMain(state.main);
      state.git('checkout', '-q', '--detach', state.base);
      return state;
    }

    // Main adds a package command after the reviewed head forked; main's own owner
    // writes its catalogue in a new process, as a contributor's generator run would.
    const addPackageCommand = () => {
      const policy = 'scripts/oss-publication-policy.ts';
      const close = '\n];\nexport const PUBLIC_PACKAGE_EXECUTION_SURFACES';
      expect(state.read(policy)).toContain(close);
      state.write(policy, state.read(policy).replace(close, `\n  publicCommand("fixture:landing", "node -e 0"),${close}`));
      const owner = pathToFileURL(join(state.root, policy)).href;
      execFileSync(process.execPath, ['--input-type=module', '-e', `import { readFileSync, writeFileSync } from 'node:fs';
      const { createPublicPublicationCatalog } = await import(${JSON.stringify(owner)});
      const catalog = JSON.parse(readFileSync(${JSON.stringify(CATALOGUE)}, 'utf8'));
      writeFileSync(${JSON.stringify(CATALOGUE)}, createPublicPublicationCatalog(catalog.publicPaths, catalog.guardViability).contents);`], { cwd: state.root, env: fixtureEnvironment, timeout: 30000 });
    };

    state.append('20990101020000');
    state.reviewed = state.commit();
    state.git('checkout', '-q', '--detach', state.base);
    state.append('20990101010000');
    addPackageCommand();
    state.write(SQL_REFERENCE, state.read(SQL_REFERENCE).replace(SQL_HEADING, MAIN_SQL_HEADING));
    state.main = state.commit();
    state.setMain(state.main);
    state.git('checkout', '-q', '--detach', state.reviewed);

    state.initialLandingCommands = [];
    const inventoryScript = join(state.root, 'scripts/installation-inventory-refresh.ts');
    const landingResult = await runLandingMerge(state.root, {
      runCommand: (command, args) => {
        state.initialLandingCommands.push({ command, args });
        if (args.includes(inventoryScript)) {
          // Real Docker PostgreSQL measurement is witnessed in scripts/agent-review-derived-inventory.test.ts;
          // keep this unlisted scanner suite Docker-free while preserving exact current-only envelope semantics.
          const env = inventoryEnvelope(state.read(INVENTORY_PATH));
          const nextCurrent = structuredClone(env.value.current) as { profiles: Record<string, { objectInventorySha256: string }> };
          for (const [profile, entry] of Object.entries(nextCurrent.profiles)) {
            entry.objectInventorySha256 = createHash('sha256')
              .update(`derived-fixture:${profile}:${state.read(MIGRATION_REGISTRIES[0])}`)
              .digest('hex');
          }
          state.write(INVENTORY_PATH, env.before + JSON.stringify(nextCurrent, null, 2).replaceAll('\n', '\n  ') + env.after);
          return;
        }
        execFileSync(command, args, { cwd: state.root, env: fixtureEnvironment, stdio: 'inherit', timeout: 900000 });
      },
    });
    state.initialLandingResult = landingResult;
    state.merged = landingResult.head;
    return state;
  } catch (error) {
    state.cleanup();
    throw error;
  }
}
