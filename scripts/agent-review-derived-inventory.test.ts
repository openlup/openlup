import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { INVENTORY_PATH, MIGRATION_REGISTRIES, inventoryOnlyCurrent } from './agent-review-derived.mjs';
import { syncSqlReference } from './agent-review-generators.mjs';
import { carrierLocale, landingMerge } from './agent-review-landing.mjs';
import { captureCommittedReviewCandidate, proveReviewIntegration } from './agent-review-session.mjs';
import { fixtureNpmCli, linkFixtureInstallation, localFixtureEnvironment } from './fixtures/landing-test-environment.ts';
import { checkPlatformMigrationProjection } from './packages/platform-migration-projection.ts';
import { dockerAvailable } from '../tests/helpers/postgresContainer.js';

const source = process.cwd();
const npmCli = fixtureNpmCli();
const fixtureEnvironment = { ...localFixtureEnvironment(), ...carrierLocale, npm_execpath: npmCli };
const SQL_REFERENCE = 'packages/core/docs/guide/reference/sql.md';
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe('landing:merge real Docker inventory refresh witness', () => {
  let root = '';

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('runs real installation-inventory-refresh.ts against Docker PostgreSQL and lands derived integration proof', async () => {
    if (!await dockerAvailable()) {
      throw new Error('landing:merge inventory witness requires Docker PostgreSQL');
    }
    root = realpathSync(mkdtempSync(join(tmpdir(), 'openlup-derived-inventory-')));
    execFileSync('/usr/bin/git', ['clone', '--shared', '--no-hardlinks', '-q', source, root], { env: fixtureEnvironment, timeout: 30000 });
    const sourcePaths = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: source, env: fixtureEnvironment, encoding: 'utf8' }).split('\0').filter(Boolean);
    const overlays = new Set([
      ...sourcePaths('diff', '--name-only', '--no-renames', '-z', 'HEAD'),
      ...sourcePaths('ls-files', '-z', '--others', '--exclude-standard'),
    ]);
    for (const path of overlays) {
      if (!existsSync(join(source, path))) { rmSync(join(root, path), { force: true }); continue; }
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(source, path), join(root, path));
    }
    linkFixtureInstallation(source, root);
    const git = (...args: string[]) => execFileSync('/usr/bin/git', [
      '--no-replace-objects', '-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
      '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args,
    ], { env: fixtureEnvironment, encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024 * 1024 }).trim();
    const read = (path: string) => readFileSync(join(root, path), 'utf8');
    const write = (path: string, value: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
    const commit = () => { git('add', '-A'); git('commit', '--allow-empty', '-qm', 'Synthetic forward', '-s'); return git('rev-parse', 'HEAD'); };
    const append = (slot: string) => {
      const file = `db/platform/migrations/${slot}_inventory_witness.sql`;
      const sql = '-- Synthetic no-op forward for Docker inventory witness\nSELECT 1;\n';
      write(file, sql);
      const sha256 = createHash('sha256').update(sql).digest('hex');
      const manifest = JSON.parse(read(MIGRATION_REGISTRIES[0]));
      for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) plan.forward.push({ file, sha256 });
      write(MIGRATION_REGISTRIES[0], json(manifest));
      const registry = JSON.parse(read(MIGRATION_REGISTRIES[1]));
      registry.nativeStoreForwardClass.slots.push({ row: `witness-${slot}`, path: file, replacedFunctions: [], createdFunctions: [] });
      registry.nativeStoreForwards.push({ path: file, sha256, functions: [] });
      write(MIGRATION_REGISTRIES[1], json(registry));
      expect(checkPlatformMigrationProjection(root, true)).toEqual([]);
      write(SQL_REFERENCE, syncSqlReference(root));
    };

    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    const base = commit();
    append('20990102020000');
    const reviewed = commit();
    git('checkout', '-q', '--detach', base);
    append('20990102010000');
    const main = commit();
    git('remote', 'set-url', 'origin', '.');
    git('branch', '-f', 'main', main);
    git('update-ref', 'refs/remotes/origin/main', main);
    git('checkout', '-q', '--detach', reviewed);

    const invoked: { command: string; args: string[] }[] = [];
    const landed = await landingMerge(root, {
      runCommand: (command, args) => {
        invoked.push({ command, args });
        execFileSync(command, args, { cwd: root, env: fixtureEnvironment, stdio: 'inherit', timeout: 900000 });
      },
    });
    expect(landed.inventoryRefreshed).toBe(true);
    expect(invoked.map(({ args }) => args)).toEqual([
      ['--input-type=module', '-e', expect.stringContaining('assertCarrierToolchain(process.cwd())')],
      [join(root, 'scripts/build-packages-incremental.mjs')],
      ['--import', 'tsx', join(root, 'scripts/installation-inventory-refresh.ts')],
    ]);
    const [baseInv, reviewedInv, mainInv, landedInv] = [base, reviewed, main, landed.head]
      .map((rev) => git('show', `${rev}:${INVENTORY_PATH}`));
    expect(inventoryOnlyCurrent(baseInv, reviewedInv, mainInv, landedInv)).toBe(true);

    const integration = await proveReviewIntegration(
      root,
      await captureCommittedReviewCandidate(root, base, reviewed),
      await captureCommittedReviewCandidate(root, main, landed.head),
    );
    expect(integration).toMatchObject({ kind: 'derived', derived: true });
  }, 600000);
});
