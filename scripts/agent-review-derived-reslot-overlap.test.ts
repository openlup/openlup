import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { MIGRATION_REGISTRIES } from './agent-review-derived.mjs';
import { syncSqlReference } from './agent-review-generators.mjs';
import { landingMerge } from './agent-review-landing.mjs';
import { admit, coverageRequirement, integrationReviewContext, prepareCandidate, receiptSummary, recordReport, verdict } from './agent-review-decide.mjs';
import { captureCommittedReviewCandidate, captureCoverageEdge, captureReviewRules, validateEconomySession } from './agent-review-session.mjs';
import { checkPlatformMigrationProjection } from './packages/platform-migration-projection.ts';
import {
  SQL_REFERENCE,
  createDerivedFixture,
  json,
  npmCli,
  type DerivedFixture,
} from './fixtures/agent-review-derived-fixture.ts';

let f: DerivedFixture;

beforeAll(async () => {
  vi.stubEnv('npm_execpath', npmCli);
  f = await createDerivedFixture({ runInitialLanding: false, stubNpmEnv: false });
}, 180000);

afterAll(() => {
  vi.unstubAllEnvs();
  f?.cleanup();
});

function writeMigration(slot: string, slug: string, sql: string) {
  const file = `db/platform/migrations/${slot}_${slug}.sql`;
  f.write(file, sql);
  const sha256 = createHash('sha256').update(sql).digest('hex');
  const manifest = JSON.parse(f.read(MIGRATION_REGISTRIES[0]));
  for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) plan.forward.push({ file, sha256 });
  f.write(MIGRATION_REGISTRIES[0], json(manifest));
  const registry = JSON.parse(f.read(MIGRATION_REGISTRIES[1]));
  registry.nativeStoreForwardClass.slots.push({ row: `fixture-${slot}-${slug}`, path: file, replacedFunctions: [], createdFunctions: [] });
  registry.nativeStoreForwards.push({ path: file, sha256, functions: [] });
  f.write(MIGRATION_REGISTRIES[1], json(registry));
  expect(checkPlatformMigrationProjection(f.root, true), `projection for ${file} (slot ${slot}) in ${f.root}`).toEqual([]);
  f.write(SQL_REFERENCE, syncSqlReference(f.root));
  return file;
}

it.each([
  {
    name: 'disjoint SQL definitions stay derived (floor 0)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.main_only_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2; $$;\n',
    prSql: 'CREATE OR REPLACE FUNCTION public.pr_only_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;\n',
    expectedOverlap: false,
  },
  {
    name: 'overlapping CREATE OR REPLACE FUNCTION forces reslotOverlap (floor 1)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.shared_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2; $$;\n',
    prSql: 'CREATE OR REPLACE FUNCTION shared_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;\n',
    expectedOverlap: true,
  },
  {
    name: 'table mutation vs policy target forces reslotOverlap (floor 1)',
    mainSql: 'CREATE TABLE public.reslot_orders (id uuid PRIMARY KEY);\n',
    prSql: 'CREATE POLICY reslot_orders_read ON reslot_orders FOR SELECT USING (true);\n',
    expectedOverlap: true,
  },
  {
    name: 'opaque DO block in re-slotted migration forces reslotOverlap (floor 1)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.unrelated_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2; $$;\n',
    prSql: 'DO $$ BEGIN EXECUTE v_dynamic_sql; END $$;\n',
    expectedOverlap: true,
  },
  {
    name: 'DO EXECUTE GRANT on main-replaced function forces reslotOverlap (floor 1)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.shared_fn(x int) RETURNS int LANGUAGE sql AS $$ SELECT x + 1; $$;\n',
    prSql: "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.shared_fn(int) TO service_role;'; END IF; END; $$;\n",
    expectedOverlap: true,
  },
  {
    name: 'GRANT on main-created view forces reslotOverlap (floor 1)',
    mainSql: 'CREATE VIEW public.summary_v AS SELECT 1 AS n;\n',
    prSql: 'GRANT SELECT ON public.summary_v TO authenticated;\n',
    expectedOverlap: true,
  },
  {
    name: 'REFERENCES on main-altered table forces reslotOverlap (floor 1)',
    mainSql: 'ALTER TABLE private.users ADD COLUMN active boolean DEFAULT true;\n',
    prSql: 'CREATE TABLE public.orders (id int PRIMARY KEY, user_id int REFERENCES private.users(id));\n',
    expectedOverlap: true,
  },
  {
    name: 'E-string hex escape in DO EXECUTE fails closed to reslotOverlap (floor 1)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.unrelated_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2; $$;\n',
    prSql: "DO $$ BEGIN EXECUTE E'\\x43REATE OR REPLACE FUNCTION public.other() RETURNS int LANGUAGE sql AS $b$ SELECT 1; $b$;'; END $$;\n",
    expectedOverlap: true,
  },
  {
    name: 'top-level SET search_path fails closed to reslotOverlap (floor 1)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.unrelated_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2; $$;\n',
    prSql: 'SET search_path TO private, public; CREATE OR REPLACE FUNCTION calc() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;\n',
    expectedOverlap: true,
  },
  {
    name: 'inline CREATE SCHEMA elements fail closed to reslotOverlap (floor 1)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.unrelated_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2; $$;\n',
    prSql: 'CREATE SCHEMA analytics CREATE TABLE analytics.events (id int);\n',
    expectedOverlap: true,
  },
  {
    name: 'ALTER FUNCTION RENAME TO fails closed to reslotOverlap (floor 1)',
    mainSql: 'CREATE OR REPLACE FUNCTION public.unrelated_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2; $$;\n',
    prSql: 'ALTER FUNCTION public.other_fn(int) RENAME TO moved_fn;\n',
    expectedOverlap: true,
  },
])('guards byte-identical SQL re-slots against semantic clobber: $name', async ({ name, mainSql, prSql, expectedOverlap }) => {
  const ctx = `reslot overlap (${name}) in ${f.root}`;
  try {
    f.checkout(f.base);
    const prFile = writeMigration('20990101010000', 'pr_item', prSql);
    const pr = f.commit();
    f.checkout(f.base);
    writeMigration('20990101020000', 'main_item', mainSql);
    const upstream = f.commit();
    f.setMain(upstream);
    f.checkout(pr);

    const landed = await landingMerge(f.root, { reSlot: true, runCommand: () => '' });
    const reslottedFile = 'db/platform/migrations/20990101020001_pr_item.sql';
    const reslottedMirror = 'packages/platform/sql/20990101020001_pr_item.sql';
    expect(f.git('ls-files', prFile), ctx).toBe('');
    expect(f.git('ls-files', reslottedFile), ctx).toBe(reslottedFile);

    const previous = await captureCommittedReviewCandidate(f.root, f.base, pr);
    const intent = { risk: 'behavior', criteria: 'Guard overlapping re-slotted SQL migrations' };
    let session = prepareCandidate(null, { ...previous, rules: await captureReviewRules(f.root, previous), intent, authorSessionId: 'fixture-author' }, 1000);
    for (const reviewer of ['r-init-1', 'r-init-2']) {
      session = recordReport(session, {
        reviewer, cold: true, verdict: 'PASS', tree: previous.tree, findings: [], closes: [],
        documentation: 'Checked SQL forward and guidance.',
      }, 1000);
    }
    const current = await captureCommittedReviewCandidate(f.root, upstream, landed.head);
    const observed = { ...current, rules: await captureReviewRules(f.root, current), intent, authorSessionId: 'fixture-author' };
    const integration = integrationReviewContext(session, observed, { parents: [pr, upstream], baseAncestor: true }, 1001);
    const coverage = await captureCoverageEdge(f.root, session, observed, 1001);
    expect(coverage, ctx).toBeDefined();
    session = prepareCandidate(session, { ...observed, integration, coverage }, 1001);

    if (!expectedOverlap) {
      expect(coverage!.proof, ctx).toMatchObject({ kind: 'portable-derived', derived: true });
      expect(coverage!.proof.reslotOverlap, ctx).toBeUndefined();
      expect(coverageRequirement(session).floor, ctx).toBe(0);
      expect(verdict(session, current, 1001), ctx).toEqual({ ok: true, code: 'reviewed', reason: 'reviewed' });
    } else {
      expect(coverage!.proof, ctx).toMatchObject({
        kind: 'portable-resolution',
        derived: true,
        reslotOverlap: true,
        modeChanged: false,
      });
      expect(coverage!.proof.resolution, ctx).toEqual([reslottedFile, reslottedMirror].sort());
      expect(coverageRequirement(session).floor, ctx).toBe(1);
      expect(verdict(session, current, 1001), ctx).toMatchObject({ ok: false, code: 'needs_agent_review', reason: 'needs_agent_review: 1 independent PASS reports required' });

      session = recordReport(session, {
        reviewer: 'r-overlap-check', cold: true, verdict: 'PASS', tree: current.tree,
        ordinary: true, delta: coverage!.delta, findings: [], closes: [],
        documentation: 'Verified re-slotted SQL does not clobber upstream migration.',
      }, 1002);
      expect(verdict(session, current, 1002), ctx).toEqual({ ok: true, code: 'reviewed', reason: 'reviewed' });
      await expect(validateEconomySession(f.root, session), ctx).resolves.toBeUndefined();
      const summary = receiptSummary(session, 12, 1002);
      expect(admit({ receipt: summary, observed: { ...current, pr: 12, baseValid: true }, now: 1002 }), ctx).toEqual({
        ok: true, code: 'reviewed', reason: 'reviewed',
      });
    }
  } finally {
    f.git('reset', '--hard', f.base);
    f.git('clean', '-fd', '--', 'db/platform/migrations', 'packages/platform/sql');
    f.git('checkout', '-q', '--detach', f.base);
    f.setMain(f.base);
  }
}, 90_000);

it('preserves pre-PR-4 derived re-slot replay when RESLOT_OVERLAP_GUARD is absent on main', async () => {
  const ctx = `reslot overlap (pre-PR-4 derived replay) in ${f.root}`;
  try {
    f.checkout(f.base);
    const sessionSource = f.read('scripts/agent-review-session.mjs')
      .replace("const RESLOT_OVERLAP_GUARD = 'openlup-reslot-overlap-20261126';", '// pre-PR-4 session without reslot overlap guard');
    f.write('scripts/agent-review-session.mjs', sessionSource);
    const preGuardBase = f.commit();

    writeMigration('20990101010000', 'pr_grant', "DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.reslot_tbl TO anon;'; END $$;\n");
    const pr = f.commit();
    f.checkout(preGuardBase);
    writeMigration('20990101020000', 'main_tbl', 'CREATE TABLE public.reslot_tbl (id int);\n');
    const upstream = f.commit();
    f.setMain(upstream);
    f.checkout(pr);

    const landed = await landingMerge(f.root, { reSlot: true, runCommand: () => '' });

    const previous = await captureCommittedReviewCandidate(f.root, preGuardBase, pr);
    const intent = { risk: 'behavior', criteria: 'Replay pre-PR-4 derived re-slot without reslotOverlap' };
    let session = prepareCandidate(null, { ...previous, rules: await captureReviewRules(f.root, previous), intent, authorSessionId: 'fixture-author' }, 1000);
    for (const reviewer of ['pre-r1', 'pre-r2']) {
      session = recordReport(session, {
        reviewer, cold: true, verdict: 'PASS', tree: previous.tree, findings: [], closes: [],
        documentation: 'Checked pre-PR-4 migration.',
      }, 1000);
    }
    const current = await captureCommittedReviewCandidate(f.root, upstream, landed.head);
    const observed = { ...current, rules: await captureReviewRules(f.root, current), intent, authorSessionId: 'fixture-author' };
    const integration = integrationReviewContext(session, observed, { parents: [pr, upstream], baseAncestor: true }, 1001);
    const coverage = await captureCoverageEdge(f.root, session, observed, 1001);
    expect(coverage?.proof, ctx).toMatchObject({ kind: 'portable-derived', derived: true });
    expect(coverage?.proof.reslotOverlap, ctx).toBeUndefined();
    session = prepareCandidate(session, { ...observed, integration, coverage }, 1001);
    expect(coverageRequirement(session).floor, ctx).toBe(0);
    await expect(validateEconomySession(f.root, session), ctx).resolves.toBeUndefined();
  } finally {
    f.git('reset', '--hard', f.base);
    f.git('clean', '-fd', '--', 'db/platform/migrations', 'packages/platform/sql');
    f.git('checkout', '-q', '--detach', f.base);
    f.setMain(f.base);
  }
}, 90_000);
