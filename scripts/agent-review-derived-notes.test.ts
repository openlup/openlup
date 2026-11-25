import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { captureCommittedReviewCandidate, proveReviewIntegration } from './agent-review-session.mjs';
import {
  createDerivedFixture,
  fixtureEnvironment,
  npmCli,
  type DerivedFixture,
} from './fixtures/agent-review-derived-fixture.ts';

let f: DerivedFixture;

beforeAll(async () => {
  f = await createDerivedFixture({ runInitialLanding: false });
}, 180000);

afterAll(() => {
  f?.cleanup();
});

it.each([
  ['outbox', 'first parent'],
  ['outbox', 'missing'],
  ['outbox', 'removed'],
  ['outbox', 'main only'],
  ['core', 'first parent'],
  ['core', 'missing'],
])('checks the %s change note through landing (%s)', async (owner, note) => {
  const directory = `packages/${owner}`;
  const entry = `${directory}/src/${owner === 'core' ? 'subscription/index.ts' : 'index.ts'}`;
  const notePath = `${directory}/changes/fixture-api.md`;
  const report = `${directory}/api/${owner === 'core' ? 'subscription' : 'index'}.api.md`;
  try {
    f.checkout(f.base);
    if (note === 'removed') { f.write(notePath, '- Describe the fixture contract.\n'); f.commit(); }
    const fork = f.git('rev-parse', 'HEAD');
    f.write(entry, f.read(entry) + '\nexport const fixtureApi = 1;\n');
    if (note === 'first parent') f.write(notePath, '- Add a fixture API export.\n');
    if (note === 'removed') rmSync(join(f.root, notePath));
    const left = f.commit();
    f.checkout(fork);
    if (note === 'main only') f.write(notePath, '- Document a main-side change.\n');
    const right = f.commit(); f.setMain(right); f.checkout(left);
    if (note === 'first parent') {
      f.landingCli();
      const landed = f.git('rev-parse', 'HEAD');
      expect(f.git('show', '-s', '--format=%P', 'HEAD')).toBe(`${left} ${right}`);
      expect(f.git('show', `HEAD:${report}`)).toContain('declare const fixtureApi = 1');
      expect(f.git('status', '--porcelain')).toBe('');
      const integration = await proveReviewIntegration(f.root,
        await captureCommittedReviewCandidate(f.root, fork, left),
        await captureCommittedReviewCandidate(f.root, right, landed));
      expect(integration).toMatchObject({ kind: 'derived', derived: true });
    } else {
      const cli = spawnSync(process.execPath, [npmCli, 'run', 'landing:merge'], { cwd: f.root, env: fixtureEnvironment, encoding: 'utf8', timeout: 180000 });
      expect(cli.status).toBe(1);
      expect(cli.stderr).toContain(`landing: @openlup/${owner} API snapshots changed; add or modify ${directory}/changes/*.md or ${directory}/CHANGELOG.md on the first parent and retain it in the merge`);
      expect(cli.stderr).toContain('OPENLUP_E_LANDING_ABORTED: merge aborted; the checkout is back at HEAD');
      f.expectRestoredHead(left);
      expect(f.read(report)).not.toContain('fixtureApi');
      expect(f.git('diff', '--cached', '--name-only', '--', 'packages/core/api', 'packages/outbox/api', 'packages/platform/api')).toBe('');
    }
  } finally { f.restoreDerivedFixture(); }
}, 180000);
