// Local Git and state adapters for native supervisor process evidence.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { env as processEnvironment } from 'node:process';
import { digest, explainSession, protectedCoveragePath, carryOver, cumulativeRepairPrefix, fullReviewReports, demand, integrationReviewContext, prepareCandidate, receiptBody, receiptSummary, recordReport, verdict } from './agent-review-decide.mjs';
import { REGISTRY_PATHS, registryUnion } from './agent-review-registry.mjs';
import { INVENTORY_PATH, MIGRATION_REGISTRIES, inventoryOnlyCurrent, migrationRegistryUnion, rewriteCatalogForRelocation, rewriteMigrationRegistryForRelocation, validateRelocationPlan } from './agent-review-derived.mjs';
import { generatedCarrier, runLandingGenerators, withPredictedTree } from './agent-review-generators.mjs';
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/u;
/** @param {string} cwd @param {...string} args */
export async function git(cwd, ...args) {
  return (await execute('/usr/bin/git', ['--no-replace-objects', '-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'merge.renames=false', '-c', 'merge.directoryRenames=false', '-c', 'merge.conflictStyle=merge', ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: { ...processEnvironment, PATH: '/usr/bin:/bin' } })).stdout;
}
/** @param {string} cwd @param {string} base @param {string} head @param {typeof git} [runGit] */
export async function captureCommittedReviewCandidate(cwd, base, head, runGit = git) {
  demand(SHA.test(base) && SHA.test(head), 'base and head must be full commit digests');
  const tree = (await runGit(cwd, 'rev-parse', '--verify', `${head}^{tree}`)).trim();
  const raw = (await runGit(cwd, 'diff', '--raw', '--no-abbrev', '--no-renames', '-z', base, head)).split('\0').filter(Boolean);
  const changedPaths = []; let modeChanged = false;
  for (let index = 0; index < raw.length; index += 2) {
    const modes = /^:(\d{6}) (\d{6}) /u.exec(raw[index]); demand(modes && raw[index + 1], 'unreadable diff');
    changedPaths.push(raw[index + 1]);
    const [oldMode, newMode] = modes.slice(1);
    modeChanged ||= oldMode === '120000' || newMode === '120000' || (oldMode === '000000' ? newMode !== '100644' : newMode === '000000' ? oldMode !== '100644' : oldMode !== newMode);
  }
  return { base, head, tree, changedPaths, modeChanged, clean: true };
}
export async function captureSessionCandidate(cwd, base, { runGit = git, env = processEnvironment } = {}) {
  const head = (await runGit(cwd, 'rev-parse', '--verify', 'HEAD^{commit}')).trim();
  const forks = (await runGit(cwd, 'merge-base', '--all', head, 'origin/main')).trim().split('\n');
  demand(forks.length === 1 && SHA.test(forks[0]), 'HEAD must have a single fork point with origin/main');
  const pinned = env.OPENLUP_STACK_BASE;
  demand(pinned === undefined || SHA.test(pinned), 'OPENLUP_STACK_BASE must be a full commit digest');
  base ??= pinned ?? forks[0];
  if (pinned) {
    demand(base === pinned, 'stack base changed', 'stale');
    try { await runGit(cwd, 'merge-base', '--is-ancestor', forks[0], base); await runGit(cwd, 'merge-base', '--is-ancestor', base, head); }
    catch { throw new Error('invalid: OPENLUP_STACK_BASE must lie between the fork point and HEAD'); }
  } else demand(base === forks[0], 'fork point changed; prepare again', 'stale');
  const candidate = await captureCommittedReviewCandidate(cwd, base, head, runGit);
  candidate.clean = !(await runGit(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude).context/scratch')).length;
  return candidate;
}
async function ancestor(runGit, cwd, base, head) {
  try { await runGit(cwd, 'merge-base', '--is-ancestor', base, head); return true; } catch { return false; }
}
// Normalize lineage evidence only; the candidate/receipt still binds the actual tip.
async function integrationParents(cwd, head) {
  const [parentLine, tree] = (await git(cwd, 'show', '-s', '--format=%P%n%T', head)).trimEnd().split('\n');
  const parents = parentLine.split(' ').filter(Boolean);
  if (parents.length !== 1) return parents;
  // Pretty-printed %B truncates at NUL; validate the complete raw message instead.
  const commit = await git(cwd, 'cat-file', 'commit', head); const boundary = commit.indexOf('\n\n');
  if (boundary < 0 || commit.includes('\0')) return parents;
  const [subject, ...body] = commit.slice(boundary + 2).trimEnd().split('\n');
  if (!subject?.trim() || body[0] !== '' ||
    !body.some(line => /^OpenLup-Doc-Impact:[ \t]*\S/u.test(line)) ||
    !body.every(line => line === '' || /^(?:OpenLup-Doc-Impact|Signed-off-by):[ \t]*\S[^\r\n]*$/u.test(line))) return parents;
  const [mergeParents, mergeTree] = (await git(cwd, 'show', '-s', '--format=%P%n%T', parents[0])).trim().split('\n');
  const joined = mergeParents.split(' ').filter(Boolean);
  // Do not recurse: two trailer commits, or a trailer on a non-merge, cannot qualify.
  return tree === mergeTree && joined.length === 2 ? joined : parents;
}
// This literal anchors the one-time transition in trusted main's first-parent history.
const PORTABLE_REVIEW = 'openlup-portable-review-20261103';
const DERIVED_REVIEW = 'openlup-derived-review-20261110';
const DERIVED_RELOCATED_REVIEW = 'openlup-derived-relocated-20261123';
const SESSION_PATH = 'scripts/agent-review-session.mjs';

// Review evidence binds to the candidate's own change: a clean merge onto a later base keeps it.
export async function carryOverSourceReview(cwd, candidate, group, runGit = git) {
  const baseAncestor = await ancestor(runGit, cwd, candidate.base, group.base);
  let predictedTree;
  if (baseAncestor && candidate.tree !== group.tree) {
    try { predictedTree = (await runGit(cwd, 'merge-tree', '--write-tree', `--merge-base=${candidate.base}`, group.base, candidate.head)).trim(); } catch { predictedTree = null; }
  }
  return carryOver({ reviewedTree: candidate.tree, groupTree: group.tree, baseAncestor, predictedTree });
}
// Source objects are parsed, never imported as candidate modules.
export async function captureReviewRules(cwd, candidate, runGit = git) {
  let source;
  try { source = await runGit(cwd, 'show', `${candidate.base}:scripts/agent-review-decide.mjs`); } catch { return undefined; }
  if (!/^export const REVIEW_RULES_VERSION = 3;$/mu.test(source)) return undefined;
  const snapshot = async revision => {
    const rows = (await runGit(cwd, 'ls-tree', '-rz', '--full-tree', revision)).split('\0').filter(Boolean);
    return digest(rows.filter(row => {
      const path = row.slice(row.indexOf('\t') + 1);
      return protectedCoveragePath(path) && !REGISTRY_PATHS.includes(path);
    }).sort());
  };
  return { version: 3, base: await snapshot(candidate.base), head: await snapshot(candidate.head) };
}
export async function objectInput(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/git', ['--no-replace-objects', '-C', cwd, '-c', 'core.fsmonitor=false', ...args],
      { env: { ...processEnvironment, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let error = ''; const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 16 * 1024 * 1024) child.kill('SIGTERM'); });
    child.stderr.on('data', bytes => { error += bytes; }); child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(output.trim()); else reject(new Error(`Git object write refused: ${error}`)); });
    child.stdin.end(input);
  });
}
export async function replaceTreeBlobs(cwd, tree, replacements) {
  const rows = (await git(cwd, 'ls-tree', '-z', tree)).split('\0').filter(Boolean);
  const output = [];
  for (const row of rows) {
    const match = /^(\d{6}) (blob|tree) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(row); demand(match, 'unreadable merge tree');
    const [, mode, type, oid, name] = match;
    let next = replacements.get(name) ?? oid;
    const nested = new Map([...replacements].filter(([path]) => path.startsWith(name + '/')).map(([path, value]) => [path.slice(name.length + 1), value]));
    if (nested.size) { demand(type === 'tree', 'registry parent is not a tree'); next = await replaceTreeBlobs(cwd, oid, nested); }
    output.push(`${mode} ${type} ${next}\t${name}\0`);
  }
  demand([...replacements.keys()].every(path => rows.some(row => path === row.slice(row.indexOf('\t') + 1) || path.startsWith(row.slice(row.indexOf('\t') + 1) + '/'))), 'registry absent from merge tree');
  return objectInput(cwd, ['mktree', '-z'], output.join(''));
}
const treeSortKey = (type, name) => Buffer.from(type === 'tree' ? `${name}/` : name, 'utf8');

/** Mutate a Git tree by replacing, inserting (100644 blob), or deleting (`null`) blob paths. */
export async function mutateTreeBlobs(cwd, tree, mutations) {
  const rows = (await git(cwd, 'ls-tree', '-z', tree)).split('\0').filter(Boolean);
  const entries = new Map();
  for (const row of rows) {
    const match = /^(\d{6}) (blob|tree) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(row);
    demand(match, 'unreadable merge tree');
    const [, mode, type, oid, name] = match;
    entries.set(name, { mode, type, oid, name });
  }
  const childMutations = new Map();
  for (const [path, value] of mutations) {
    const slash = path.indexOf('/');
    if (slash < 0) {
      if (value === null) {
        entries.delete(path);
      } else {
        const existing = entries.get(path);
        entries.set(path, { mode: existing?.type === 'blob' ? existing.mode : '100644', type: 'blob', oid: value, name: path });
      }
    } else {
      const dir = path.slice(0, slash);
      const rest = path.slice(slash + 1);
      let nested = childMutations.get(dir);
      if (!nested) { nested = new Map(); childMutations.set(dir, nested); }
      nested.set(rest, value);
    }
  }
  for (const [dir, nested] of childMutations) {
    const parent = entries.get(dir);
    demand(parent && parent.type === 'tree', 'mutation parent is not a tree');
    parent.oid = await mutateTreeBlobs(cwd, parent.oid, nested);
  }
  const sorted = [...entries.values()].sort((a, b) => Buffer.compare(treeSortKey(a.type, a.name), treeSortKey(b.type, b.name)));
  return objectInput(cwd, ['mktree', '-z'], sorted.map(({ mode, type, oid, name }) => `${mode} ${type} ${oid}\t${name}\0`).join(''));
}

const RELOCATION_SQL_DIRS = ['db/platform/migrations', 'supabase/migrations', 'packages/platform/sql'];
const RELOCATION_CARRIER_EXCLUSIONS = new Set([
  ...MIGRATION_REGISTRIES,
  INVENTORY_PATH,
  ...REGISTRY_PATHS,
  'packages/platform/src/migrations/catalog.ts',
]);

async function diffSqlSides(cwd, fromRev, toRev, ignoreIdenticalTo) {
  const raw = (await git(cwd, 'diff', '--name-status', '--no-renames', '-z', fromRev, toRev, '--', ...RELOCATION_SQL_DIRS)).split('\0').filter(Boolean);
  const differing = ignoreIdenticalTo
    ? new Set((await git(cwd, 'diff', '--name-only', '--no-renames', '-z', ignoreIdenticalTo, toRev, '--', ...RELOCATION_SQL_DIRS)).split('\0').filter(Boolean))
    : null;
  const added = [];
  const modifiedOrDeleted = [];
  for (let index = 0; index < raw.length; index += 2) {
    const status = raw[index];
    const path = raw[index + 1];
    if (path === 'packages/platform/sql/manifest.json') continue;
    if (differing && !differing.has(path)) continue;
    if (status === 'A') added.push(path);
    else modifiedOrDeleted.push(path);
  }
  return { added, modifiedOrDeleted };
}

/** Collect Git inputs and run shared fail-closed Barriers 1, 3, and 4 for slot relocation. */
export async function collectRelocationPlan(cwd, base, head, main) {
  const prSql = await diffSqlSides(cwd, base, head, main);
  if (prSql.added.length === 0 && prSql.modifiedOrDeleted.length === 0) return [];
  const mainSql = await diffSqlSides(cwd, base, main, null);
  const lsTreePaths = async (rev, dirs) => (await git(cwd, 'ls-tree', '-r', '--name-only', '-z', rev, '--', ...dirs)).split('\0').filter(Boolean);
  const mainAllMigrationPaths = await lsTreePaths(main, ['db/platform/migrations', 'supabase/migrations']);
  const allExistingPaths = [
    ...await lsTreePaths(base, RELOCATION_SQL_DIRS),
    ...await lsTreePaths(head, RELOCATION_SQL_DIRS),
    ...await lsTreePaths(main, RELOCATION_SQL_DIRS),
  ];
  const readRegularBlob = async (rev, path) => {
    const meta = (await git(cwd, 'ls-tree', rev, '--', path)).trim();
    demand(meta.startsWith('100644 blob '), `relocation requires regular blob for ${path}`);
    return git(cwd, 'show', `${rev}:${path}`);
  };
  const [baseForwardsSource, headForwardsSource, mainForwardsSource] = await Promise.all(
    [base, head, main].map(rev => readRegularBlob(rev, MIGRATION_REGISTRIES[1])),
  );
  const prSqlBlobsByPath = new Map();
  const prMirrorBlobsByPath = new Map();
  for (const path of prSql.added) {
    if (path.startsWith('packages/platform/sql/')) prMirrorBlobsByPath.set(path, await readRegularBlob(head, path));
    else prSqlBlobsByPath.set(path, await readRegularBlob(head, path));
  }
  const mainSqlBlobsByPath = new Map();
  for (const path of mainSql.added) {
    mainSqlBlobsByPath.set(path, await readRegularBlob(main, path));
  }
  // Barrier 3: inspect every non-carrier file added or modified by the PR for stale filename/timestamp references.
  const prRaw = (await git(cwd, 'diff', '--name-status', '--no-renames', '-z', base, head)).split('\0').filter(Boolean);
  const prSqlSet = new Set(prSql.added);
  const prNonCarrierFilesByPath = new Map();
  for (let index = 0; index < prRaw.length; index += 2) {
    const status = prRaw[index];
    const path = prRaw[index + 1];
    if (status === 'D' || prSqlSet.has(path) || RELOCATION_CARRIER_EXCLUSIONS.has(path) || (generatedCarrier(path) && path !== 'packages/core/docs/guide/reference/sql.md')) continue;
    const text = await readRegularBlob(head, path);
    demand(!text.includes('\0'), `relocation refused: binary file ${path} cannot be checked for stale references`);
    // The SQL reference has preserved author prose around generated inventory blocks.
    // Scan that prose; the generated blocks are refreshed after relocation.
    const authoredText = path === 'packages/core/docs/guide/reference/sql.md'
      ? text.replace(/<!-- generated:(sql:[a-z]+) -->\n[\s\S]*?<!-- \/generated:\1 -->/gu, '')
      : text;
    prNonCarrierFilesByPath.set(path, authoredText);
  }
  return validateRelocationPlan({
    baseForwardsSource,
    headForwardsSource,
    mainForwardsSource,
    prSqlAdded: prSql.added,
    prSqlModifiedOrDeleted: prSql.modifiedOrDeleted,
    mainSqlAdded: mainSql.added,
    mainSqlModifiedOrDeleted: mainSql.modifiedOrDeleted,
    mainAllMigrationPaths,
    allExistingPaths,
    prSqlBlobsByPath,
    prMirrorBlobsByPath,
    mainSqlBlobsByPath,
    prNonCarrierFilesByPath,
  });
}

export async function proveReviewIntegration(cwd, previous, current, portable = false, { legacy = false, allowRelocated = false } = {}) {
  const parents = await integrationParents(cwd, current.head);
  demand(parents.length === 2 && parents[0] === previous.head && parents[1] === current.base, 'integration parents differ');
  demand(await ancestor(git, cwd, previous.base, current.base), 'integration base ancestry differs');
  const own = (await captureCommittedReviewCandidate(cwd, previous.base, previous.head)).changedPaths;
  const moved = (await captureCommittedReviewCandidate(cwd, previous.base, current.base)).changedPaths;
  let prediction; let conflicts = [];
  try { prediction = (await git(cwd, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', previous.head, current.base)).split('\0')[0]; }
  catch (error) {
    if (error.code !== 1) throw error;
    const parts = error.stdout.split('\0'); prediction = parts.shift(); conflicts = parts.filter(Boolean);
    demand(conflicts.length > 0, 'integration conflict list missing');
  }
  demand(SHA.test(prediction), 'merge prediction missing'); const replacements = new Map();
  const registryConflicts = conflicts.filter(path => REGISTRY_PATHS.includes(path));
  const registryBaseMatches = registryConflicts.length > 0 && (await git(cwd, 'merge-base', '--all', ...parents)).trim() === previous.base;
  // Git's clean merge stands for every carrier it merged. A conflicting carrier
  // can take the deterministic union of its named arrays from the reviewed
  // merge base. Other carrier resolutions retain their review.
  for (const path of registryBaseMatches ? registryConflicts : []) {
    const blobs = [];
    for (const revision of [previous.base, previous.head, current.base]) {
      if ((await git(cwd, 'ls-tree', revision, '--', path)).trim().startsWith('100644 blob ')) blobs.push(await git(cwd, 'show', `${revision}:${path}`));
    }
    let union; try { union = blobs.length === 3 ? registryUnion(path, ...blobs) : undefined; } catch { union = undefined; }
    if (union !== undefined) replacements.set(path, await objectInput(cwd, ['hash-object', '-w', '--stdin'], union));
  }
  // A union counts only when it is what was committed; any other carrier bytes are reviewed.
  for (const [path, blob] of replacements) {
    if ((await git(cwd, 'ls-tree', current.tree, '--', path)).trim() !== `100644 blob ${blob}\t${path}`) replacements.delete(path);
  }
  if (replacements.size) prediction = await replaceTreeBlobs(cwd, prediction, replacements);
  const oldPrediction = prediction;
  const exactParents = (await git(cwd, 'show', '-s', '--format=%P', current.head)).trim().split(' ');
  const onMain = await ancestor(git, cwd, current.base, 'origin/main');
  let derived = false;
  let relocated = false;
  const provenDerived = new Set();
  // Preserve historical receipt identities; derived proof is selected only by
  // trusted main after this machinery lands. Errors retain the old resolution.
  if (!legacy && exactParents.length === 2 && exactParents[0] === previous.head && exactParents[1] === current.base && onMain) {
    try {
      const read = async (revision, path) => {
        demand((await git(cwd, 'ls-tree', revision, '--', path)).trim().startsWith('100644 blob '), 'derived carrier mode differs');
        return git(cwd, 'show', `${revision}:${path}`);
      };
      const inventories = await Promise.all([previous.base, previous.head, current.base, current.tree].map(revision => read(revision, INVENTORY_PATH)));
      const currentOnly = inventoryOnlyCurrent(...inventories);
      const inventorySame = inventories.every(source => source === inventories[0]);
      demand(currentOnly || inventorySame, 'historical inventory or envelope differs');
      const derivedBlobs = new Map();
      if (currentOnly) derivedBlobs.set(INVENTORY_PATH, await objectInput(cwd, ['hash-object', '-w', '--stdin'], inventories[3]));
      for (const path of MIGRATION_REGISTRIES) {
        const inputs = await Promise.all([previous.base, previous.head, current.base].map(revision => read(revision, path)));
        const union = migrationRegistryUnion(path, ...inputs, inventories[3]);
        demand(union === await read(current.tree, path), 'registry union differs');
        derivedBlobs.set(path, await objectInput(cwd, ['hash-object', '-w', '--stdin'], union));
      }
      // Authored catalogue rows still come only from the existing closed union.
      // Its generated command inventory may then be reproduced by the owner.
      const catalogue = REGISTRY_PATHS[0];
      if (conflicts.includes(catalogue) && !replacements.has(catalogue)) {
        demand(registryBaseMatches, 'registry union requires the reviewed merge base');
        const inputs = await Promise.all([previous.base, previous.head, current.base].map(revision => read(revision, catalogue)));
        derivedBlobs.set(catalogue, await objectInput(cwd, ['hash-object', '-w', '--stdin'], registryUnion(catalogue, ...inputs)));
      }
      let predicted = await replaceTreeBlobs(cwd, prediction, derivedBlobs);
      const delta = await captureCommittedReviewCandidate(cwd, predicted, current.tree);
      // SQL and modes always retain their mechanical result, including mirrors.
      // A committed conflict-marker blob has no delta from merge-tree. It still
      // needs its own generator proof; another derived carrier proves nothing
      // about that blob. SQL conflicts, including mirrors, never take this lane.
      const carrierPaths = [...new Set([...delta.changedPaths, ...conflicts].filter(path => generatedCarrier(path) && !path.endsWith('.sql')).concat(derivedBlobs.has(REGISTRY_PATHS[0]) ? [REGISTRY_PATHS[0]] : []))];
      if (carrierPaths.length) {
        const outputs = withPredictedTree(cwd, predicted, (root, paths) => {
          runLandingGenerators(root, paths);
          return carrierPaths.map(path => [path, readFileSync(joinPath(root, path), 'utf8')]);
        });
        for (const [path, output] of outputs) {
          demand(output === await read(current.tree, path), 'generated bytes differ');
          derivedBlobs.set(path, await objectInput(cwd, ['hash-object', '-w', '--stdin'], output));
        }
        predicted = await replaceTreeBlobs(cwd, prediction, derivedBlobs);
      }
      derived = predicted !== prediction; prediction = predicted;
      // Publish exemptions only after the complete derivation succeeds. Each
      // replacement above was checked against the committed regular-file blob.
      for (const path of derivedBlobs.keys()) if (!path.endsWith('.sql')) provenDerived.add(path);
    } catch { prediction = oldPrediction; }

    // Opt-in fail-closed derived-relocated lane: proves byte-exact slot relocation of
    // disjoint nativeStoreForwardClass migrations when standard derived did not apply.
    if (!derived && allowRelocated) {
      try {
        const relocations = await collectRelocationPlan(cwd, previous.base, previous.head, current.base);
        demand(relocations.length > 0, 'no eligible migration relocations');
        const read = async (revision, path) => {
          demand((await git(cwd, 'ls-tree', revision, '--', path)).trim().startsWith('100644 blob '), 'derived-relocated carrier mode differs');
          return git(cwd, 'show', `${revision}:${path}`);
        };
        const blobOid = async (revision, path) => {
          const line = (await git(cwd, 'ls-tree', revision, '--', path)).trim();
          const match = /^100644 blob ([a-f0-9]{40})\t/u.exec(line);
          return match ? match[1] : null;
        };
        // Barrier 2: byte-exact SQL & mirror preservation, 100644 mode, old paths removed, new paths absent before merge.
        const mutations = new Map();
        for (const item of relocations) {
          const oldOid = await blobOid(previous.head, item.oldPath);
          const newSqlOid = await blobOid(current.tree, item.newPath);
          const newMirrorOid = await blobOid(current.tree, item.newMirror);
          demand(oldOid && newSqlOid === oldOid && newMirrorOid === oldOid, 'relocated SQL or mirror blob differs');
          demand((await git(cwd, 'ls-tree', current.tree, '--', item.oldPath, item.oldMirror)).trim() === '', 'old relocated SQL or mirror remains');
          for (const rev of [previous.base, previous.head, current.base]) {
            demand((await git(cwd, 'ls-tree', rev, '--', item.newPath, item.newMirror)).trim() === '', 'relocation target existed prior to merge');
          }
          mutations.set(item.oldPath, null);
          mutations.set(item.oldMirror, null);
          mutations.set(item.newPath, oldOid);
          mutations.set(item.newMirror, oldOid);
        }
        const inventories = await Promise.all([previous.base, previous.head, current.base, current.tree].map(revision => read(revision, INVENTORY_PATH)));
        const currentOnly = inventoryOnlyCurrent(...inventories);
        const inventorySame = inventories.every(source => source === inventories[0]);
        demand(currentOnly || inventorySame, 'historical inventory or envelope differs');
        if (currentOnly) mutations.set(INVENTORY_PATH, await objectInput(cwd, ['hash-object', '-w', '--stdin'], inventories[3]));
        for (const path of MIGRATION_REGISTRIES) {
          const [baseSrc, headSrc, mainSrc] = await Promise.all([previous.base, previous.head, current.base].map(revision => read(revision, path)));
          const rewrittenHead = rewriteMigrationRegistryForRelocation(path, headSrc, relocations);
          const union = migrationRegistryUnion(path, baseSrc, rewrittenHead, mainSrc, inventories[3]);
          demand(union === await read(current.tree, path), 'relocated registry union differs');
          mutations.set(path, await objectInput(cwd, ['hash-object', '-w', '--stdin'], union));
        }
        const catalogue = REGISTRY_PATHS[0];
        const [baseCat, headCat, mainCat] = await Promise.all([previous.base, previous.head, current.base].map(revision => read(revision, catalogue)));
        const rewrittenHeadCat = rewriteCatalogForRelocation(headCat, relocations);
        if (rewrittenHeadCat !== headCat || conflicts.includes(catalogue)) {
          const catUnion = registryUnion(catalogue, baseCat, rewrittenHeadCat, mainCat);
          mutations.set(catalogue, await objectInput(cwd, ['hash-object', '-w', '--stdin'], catUnion));
        }
        let predicted = await mutateTreeBlobs(cwd, oldPrediction, mutations);
        const delta = await captureCommittedReviewCandidate(cwd, predicted, current.tree);
        const carrierPaths = [...new Set([...delta.changedPaths, ...conflicts].filter(path => generatedCarrier(path) && !path.endsWith('.sql')).concat(mutations.has(catalogue) ? [catalogue] : []))];
        if (carrierPaths.length) {
          const outputs = withPredictedTree(cwd, predicted, (root, paths) => {
            runLandingGenerators(root, paths);
            return carrierPaths.map(path => [path, readFileSync(joinPath(root, path), 'utf8')]);
          });
          for (const [path, output] of outputs) {
            demand(output === await read(current.tree, path), 'relocated generated bytes differ');
            mutations.set(path, await objectInput(cwd, ['hash-object', '-w', '--stdin'], output));
          }
          predicted = await mutateTreeBlobs(cwd, oldPrediction, mutations);
        }
        const finalDelta = await captureCommittedReviewCandidate(cwd, predicted, current.tree);
        demand(finalDelta.changedPaths.length === 0 && !finalDelta.modeChanged, 'unexplained residual changes after relocation');
        prediction = predicted;
        derived = true;
        relocated = true;
        for (const path of mutations.keys()) provenDerived.add(path);
      } catch { prediction = oldPrediction; }
    }
  }
  const delta = await captureCommittedReviewCandidate(cwd, prediction, current.tree);
  demand(conflicts.every(path => replacements.has(path) || delta.changedPaths.includes(path) || provenDerived.has(path)), 'integration commits a conflict without resolving it');
  const resolution = delta.changedPaths; const modeChanged = delta.modeChanged;
  const kind = resolution.length ? 'resolution' : relocated ? 'derived-relocated' : derived ? 'derived' : conflicts.length ? 'registry-union' : 'git';
  return { kind: portable ? 'portable-' + kind : kind, tree: current.tree, own, moved, ...(derived ? { derived: true } : {}), ...(relocated ? { relocated: true } : {}), ...(resolution.length ? { resolution, prediction, modeChanged } : {}) };
}

export async function captureCoverageEdge(cwd, session, observed, now, historicalKind, { abbreviatedIndex = false, allowDerived = historicalKind === undefined, allowRelocated = historicalKind === undefined } = {}) {
  if (!session || !observed.rules ||
    digest(observed.intent) !== digest(session.history.findLast(event => event.type === 'prepare').intent) ||
    observed.authorSessionId !== session.history.findLast(event => event.type === 'prepare').authorSessionId) return undefined;
  const decision = verdict(session, session.candidate, now);
  const sameBase = session.candidate.base === observed.base;
  const priorFull = !decision.ok && sameBase && fullReviewReports(session);
  const cumulative = !priorFull && sameBase && decision.code === 'needs_agent_review'
    ? cumulativeRepairPrefix(session) : undefined;
  if (!decision.ok && !priorFull && !cumulative) return undefined;
  let proof; let kind; let from = session.candidate.head; let to = observed.head;
  if (!sameBase) {
    // An integration base must be on main; a repair keeps its existing (possibly stacked) base.
    if (!await ancestor(git, cwd, observed.base, 'origin/main')) return undefined;
    kind = 'integration';
    try {
      const entry = await git(cwd, 'ls-tree', observed.base, '--', SESSION_PATH);
      const source = entry ? await git(cwd, 'show', `${observed.base}:${SESSION_PATH}`) : '';
      const portable = source.includes(`const PORTABLE_REVIEW = '${PORTABLE_REVIEW}';`);
      // The landed base selects the proof. A receipt cannot opt into the old
      // selector after the rollout, even when historical fingerprints match.
      // A session from before the version-3 rules can inherit only through the portable proof.
      if ((historicalKind && historicalKind.startsWith('portable-') !== portable) || (!portable && session.candidate.rules?.version !== 3)) return undefined;
      const derivedEnabled = source.includes(`const DERIVED_REVIEW = '${DERIVED_REVIEW}';`);
      const relocatedEnabled = source.includes(`const DERIVED_RELOCATED_REVIEW = '${DERIVED_RELOCATED_REVIEW}';`);
      const historicalLegacy = !allowDerived && historicalKind && !['derived', 'portable-derived', 'derived-relocated', 'portable-derived-relocated'].includes(historicalKind);
      const historicalNoRelocate = !allowRelocated && historicalKind && !['derived-relocated', 'portable-derived-relocated'].includes(historicalKind);
      proof = await proveReviewIntegration(cwd, session.candidate, observed, portable, {
        legacy: !derivedEnabled || historicalLegacy,
        allowRelocated: relocatedEnabled && !historicalNoRelocate,
      });
      if (proof.prediction) { from = proof.prediction; to = observed.tree; }
    } catch { return undefined; }
  }
  try {
    if (sameBase) {
      if (session.candidate.rules?.version !== 3) return undefined;
      from = cumulative?.candidate.head ?? from;
      const delta = await captureCommittedReviewCandidate(cwd, from, observed.head);
      const commits = (await git(cwd, 'rev-list', '--merges', `${from}..${observed.head}`)).trim();
      if (!await ancestor(git, cwd, session.candidate.head, observed.head) || commits || !delta.changedPaths.length) return undefined;
      if (cumulative && !await ancestor(git, cwd, from, session.candidate.head)) return undefined;
      proof = { paths: delta.changedPaths, modeChanged: delta.modeChanged, ...(cumulative ? { cumulativeFrom: from } : {}) }; kind = 'repair';
    }
    // Full object names keep the digest identical in every clone; abbreviated ones
    // lengthen with the number of objects in the repository that runs git.
    const index = abbreviatedIndex ? [] : ['--full-index'];
    return { kind, previous: digest(session.history), from: { base: session.candidate.base, head: session.candidate.head, tree: session.candidate.tree },
      delta: digest(await git(cwd, 'diff', '--binary', ...index, '--no-renames', from, to)), proof };
  } catch (error) {
    if (cumulative) return undefined;
    throw error;
  }
}
// Trusted admission and local verify rederive every recorded exceptional edge.
export async function validateEconomySession(cwd, session, runGit = git) {
  if (session.version !== 3) return;
  for (let index = 0; index < session.history.length; index++) {
    const event = session.history[index];
    if (event.type === 'prepare') {
      const actual = await captureCommittedReviewCandidate(cwd, event.candidate.base, event.candidate.head, runGit);
      for (const key of ['base', 'head', 'tree', 'changedPaths', 'modeChanged']) demand(digest(actual[key]) === digest(event.candidate[key]), 'recorded candidate diff differs');
      const rules = await captureReviewRules(cwd, actual, runGit);
      demand(rules === undefined ? event.candidate.rules === undefined :
        event.candidate.rules !== undefined && digest(rules) === digest(event.candidate.rules), 'recorded policy or base rules differ');
      if (event.candidate.coverage) {
        const prefix = session.history.slice(0, session.history[index - 1]?.type === 'rules' ? index - 1 : index); const prior = prefix.findLast(item => item.type === 'prepare');
        const version = prefix.some(item => item.type === 'rules' || item.candidate?.rules?.version === 3) ? 3 : 2;
        const before = { ...session, version, candidate: prior.candidate, history: prefix, preparedAt: prior.at };
        const observed = { ...actual, rules, intent: event.intent, authorSessionId: event.authorSessionId };
        const recorded = digest(event.candidate.coverage); const kind = event.candidate.coverage.proof?.kind;
        const replayOptions = {
          allowDerived: event.candidate.coverage.proof?.derived === true,
          allowRelocated: event.candidate.coverage.proof?.relocated === true,
        };
        const edge = await captureCoverageEdge(cwd, before, observed, event.at, kind, replayOptions);
        // An edge recorded before full-index digests replays through the abbreviated diff it was recorded with.
        const legacy = edge && !edge.proof.cumulativeFrom && digest(edge) !== recorded ? await captureCoverageEdge(cwd, before, observed, event.at, kind, { abbreviatedIndex: true, ...replayOptions }) : undefined;
        demand(edge && (digest(edge) === recorded || (legacy && digest(legacy) === recorded)), 'recorded coverage proof differs');
      }
    }
  }
}
export async function assertMergePreflight(cwd, candidate, { runGit = git, env = processEnvironment } = {}) {
  const main = (await runGit(cwd, 'rev-parse', '--verify', 'origin/main^{commit}')).trim();
  demand(SHA.test(main), 'origin/main commit identity is invalid');
  // A stacked candidate may be reviewed before its prerequisite lands. Hosted
  // admission still requires its exact pin on main before it can enter the queue.
  if (env.OPENLUP_STACK_BASE === candidate.base && !await ancestor(runGit, cwd, candidate.base, main)) return;
  let tree;
  try { tree = (await runGit(cwd, 'merge-tree', '--write-tree', main, candidate.head)).trim(); }
  catch (error) {
    if (error.code === 1) throw new Error('merge_preflight: candidate conflicts with origin/main; merge main and resolve before review or verification');
    throw new Error(`merge_preflight: cannot compute merge with origin/main: ${error.message}`);
  }
  demand(SHA.test(tree), 'merge preflight did not produce a tree', 'merge_preflight');
  const decision = await carryOverSourceReview(cwd, candidate, { base: main, tree, trustedMain: main }, runGit);
  demand(decision.ok, `clean merge cannot carry over source review: ${decision.reason}`, 'merge_preflight');
}
async function boundedJson(path, limit = 1024 * 1024) {
  const handle = await open(path, 'r');
  try {
    demand((await handle.stat()).size <= limit, 'JSON input exceeds size bound');
    const bytes = Buffer.alloc(limit + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    demand(bytesRead <= limit, 'JSON input exceeds size bound'); return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}
async function saveState(path, state) {
  const bytes = `${JSON.stringify(state, null, 2)}\n`; demand(Buffer.byteLength(bytes) <= 8 * 1024 * 1024, 'session exceeds 8 MiB; previous state preserved');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export function runReviewCommand(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT'); const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { cleanup(); resolve(code ?? 1); });
  });
}
export async function verifyCandidateCommand({ cwd, session, command, args = [], resource, env = processEnvironment, snapshot = captureSessionCandidate, run = runReviewCommand }) {
  demand(env.AI_RESOURCE_GATE_ACTIVE !== '1' && !env.OPENLUP_HEAVY_ACTIVE, 'nested verification inside the resource broker is refused');
  const before = await snapshot(cwd, session.candidate.base, { env }); const decision = verdict(session, before, Date.now()); demand(decision.ok, decision.reason, decision.code);
  await validateEconomySession(cwd, session);
  await assertMergePreflight(cwd, before, { env });
  if (resource) {
    demand(/^[a-z][a-z0-9:-]{0,127}$/u.test(resource), 'resource profile is invalid');
    const broker = (env.PATH ?? '').split(delimiter).map(path => join(path, 'ai-resource-gate')).find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
    demand(broker, 'ai-resource-gate is unavailable');
    // The broker matches lane keywords in the full key: a worktree name must
    // not introduce another keyword (even hexadecimal hashes can contain e2e).
    const worktree = createHash('sha256').update(resolve(cwd)).digest().readBigUInt64BE().toString(10);
    args = ['run', '--wait', `${resource}:wt${worktree}`, '--', command, ...args]; command = broker;
  }
  const code = await run(command, args, cwd, { ...env, OPENLUP_HEAVY_ACTIVE: cwd });
  await validateEconomySession(cwd, session);
  const after = await snapshot(cwd, before.base, { env }); const final = verdict(session, after, Date.now()); demand(final.ok, final.reason, final.code);
  return code;
}
const SESSION_HELP = `Usage:
  node scripts/agent-review-session.mjs --help
  node scripts/agent-review-session.mjs prepare [--new] [intent.json]
  node scripts/agent-review-session.mjs status [--explain]
  node scripts/agent-review-session.mjs record <report.json>
  node scripts/agent-review-session.mjs verify
  node scripts/agent-review-session.mjs receipt <PR>
  node scripts/agent-review-session.mjs verify-command [--resource PROFILE] -- <command> [args...]

status prints the raw recorded session JSON.
status --explain compares the recorded session with the local checkout without writing Git objects, running generators or claiming verify completion.`;

export async function sessionMain(argv = process.argv.slice(2), { cwd = process.cwd(), env = processEnvironment } = {}) {
  const [verb, ...args] = argv;
  if (verb === '--help' || verb === '-h' || verb === 'help') {
    demand(args.length === 0, 'use --help without extra arguments');
    console.log(SESSION_HELP); return 0;
  }
  demand(['prepare', 'record', 'verify', 'status', 'receipt', 'verify-command'].includes(verb), 'use prepare [--new] <intent.json>, record <report.json>, verify, status [--explain], receipt <PR>, verify-command or --help');
  const directory = join(cwd, '.context', 'scratch', 'agent-review'); const path = join(directory, 'session.json');
  let lock;
  if (['prepare', 'record'].includes(verb)) {
    await mkdir(directory, { recursive: true });
    try { lock = await open(join(directory, '.session.lock'), 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('invalid: session is busy; retry after the active transaction finishes'); throw error; }
  }
  try {
    let session; try { session = await boundedJson(path, 8 * 1024 * 1024); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (verb === 'prepare') {
      const fresh = args[0] === '--new'; if (fresh) args.shift();
      const spec = await boundedJson(args[0] ?? join(directory, 'intent.json'));
      const observed = { ...await captureSessionCandidate(cwd, undefined, { env }), intent: spec.intent, authorSessionId: spec.authorSessionId ?? env.CODEX_THREAD_ID };
      if (!fresh && session?.candidate && session.candidate.head !== observed.head) {
        try { await git(cwd, 'merge-base', '--is-ancestor', session.candidate.head, observed.head); }
        catch { throw new Error('invalid: rebased history; use prepare --new'); }
      }
      await assertMergePreflight(cwd, observed, { env });
      const now = Date.now();
      const rules = await captureReviewRules(cwd, observed);
      if (rules) observed.rules = rules;
      if (!fresh && session?.candidate && session.candidate.head !== observed.head) {
        const parents = await integrationParents(cwd, observed.head);
        const baseAncestor = await ancestor(git, cwd, session.candidate.base, observed.base) &&
          await ancestor(git, cwd, observed.base, 'origin/main');
        const integration = integrationReviewContext(session, observed, { parents, baseAncestor }, now);
        if (integration) {
          try {
            integration.mechanical = (await git(cwd, 'merge-tree', '--write-tree', session.candidate.head, observed.base)).trim() === observed.tree;
          } catch (error) {
            if (error.code !== 1) throw new Error(`invalid: cannot verify mechanical integration: ${error.message}`);
          }
          observed.integration = integration;
        }
      }
      if (!fresh && session?.candidate.head !== observed.head) {
        const coverage = await captureCoverageEdge(cwd, session, observed, now); if (coverage) observed.coverage = coverage;
      }
      const next = prepareCandidate(session, observed, now, fresh);
      await saveState(path, next);
      console.log(JSON.stringify(next, null, 2)); return 0;
    }
    demand([2, 3].includes(session?.version), 'prepare a version-2 session before review');
    if (verb === 'status') {
      demand(args.length === 0 || (args.length === 1 && args[0] === '--explain'), 'use status [--explain]');
      if (!args.length) { console.log(JSON.stringify(session, null, 2)); return 0; }
      let observed;
      try {
        observed = await captureSessionCandidate(cwd, undefined, {
          env, runGit: (root, ...gitArgs) => git(root, '--no-optional-locks', ...gitArgs),
        });
      } catch (error) { observed = { error: error.message }; }
      console.log(JSON.stringify(explainSession(session, observed, Date.now()), null, 2));
      return 0;
    }
    if (verb === 'verify-command') {
      const resource = args[0] === '--resource' ? args.splice(0, 2)[1] : undefined;
      demand(args.shift() === '--' && args[0], 'verify-command [--resource PROFILE] -- CMD ARGS...');
      return verifyCandidateCommand({ cwd, session, command: args[0], args: args.slice(1), resource, env });
    }
    const observed = await captureSessionCandidate(cwd, session.candidate.base, { env });
    demand(observed.clean, 'commit source changes before review', 'dirty');
    demand(['base', 'head', 'tree'].every(key => observed[key] === session.candidate[key]), 'candidate changed; prepare again', 'stale');
    if (verb === 'record') { session = recordReport(session, await boundedJson(args[0]), Date.now()); await saveState(path, session); return 0; }
    await validateEconomySession(cwd, session);
    const decision = verdict(session, observed, Date.now()); demand(decision.ok, decision.reason, decision.code);
    if (verb === 'receipt') await assertMergePreflight(cwd, observed, { env });
    if (verb === 'receipt') console.log(receiptBody(receiptSummary(session, Number(args[0]), Date.now())));
    else console.log('reviewed');
    return 0;
  } finally { if (lock) { await lock.close(); await rm(join(directory, '.session.lock')); } }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) sessionMain().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
