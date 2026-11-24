// Local contributor command. The grant is a fixture envelope until hosted admission is enabled.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readlinkSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { inventoryEnvelope, INVENTORY_PATH, migrationRegistryUnion } from './agent-review-derived.mjs';
import { registryUnion } from './agent-review-registry.mjs';
import { runLandingGenerators, SQL_REFERENCE, withPredictedTree } from './agent-review-generators.mjs';
import { evaluatePlatformMigrationManifest, evaluatePlatformMigrationManifestHistory, selectPlatformMigrationManifest } from './platform-migration-manifest.ts';
import { assertNoAuthoredSlotReferences, fillDraftManifest, finalizeLanding, landingGitDirectory, reslotRegistryContents } from './agent-review-landing.mjs';
import { MIGRATION_RAILS, isUtcMigrationSlot, migrationIdentity, planMigrationSlots } from './migration-slots.mjs';
import { assertDocumentationPath, documentationGit } from './documentation-routing.ts';
import { parseStrictJson } from './oss-strict-json.mts';

const MANIFEST = 'config/platform-migration-manifest.json';
const PINS = 'config/reviewed-platform-forwards.json';
const PACKAGE = 'packages/platform/sql/';
const PACKAGE_MANIFEST = PACKAGE + 'manifest.json';
const SHA = /^[a-f0-9]{40}$/u;
const PR_NODE = /^PR_[A-Za-z0-9_-]+$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const REF = 'refs/remotes/origin/main';
const fail = reason => { throw new Error(`migration:finalize: ${reason}`); };
const order = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const same = (first, second) => first?.mode === second?.mode && first?.blobOid === second?.blobOid;
const onRail = path => MIGRATION_RAILS.some(rail => path.startsWith(rail));
const mirror = path => PACKAGE + basename(path);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBytes = (cwd, ...args) => documentationGit(cwd, args);
const gitText = (cwd, ...args) => gitBytes(cwd, ...args).toString('utf8');
const paths = text => text.split('\0').filter(Boolean);
const blob = (cwd, entry) => gitBytes(cwd, 'cat-file', 'blob', entry.blobOid);
const contents = (cwd, entries, path) => {
  const entry = entries.get(path);
  if (!entry) fail(`required Git object missing at ${path}`);
  return blob(cwd, entry).toString('utf8');
};
const json = (cwd, entries, path) => parseStrictJson(contents(cwd, entries, path), path);

function commit(cwd, sha, label) {
  if (!SHA.test(sha) || gitText(cwd, 'rev-parse', '--verify', `${sha}^{commit}`).trim() !== sha) fail(`${label} requires an exact commit SHA`);
}

function tree(cwd, sha) {
  const rows = paths(gitText(cwd, 'ls-tree', '-r', '-z', '--full-tree', sha, '--', ...MIGRATION_RAILS, MANIFEST, PINS, PACKAGE));
  return new Map(rows.map(row => {
    const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]{40})\t([^\0]+)$/u.exec(row);
    if (!match) fail(`invalid Git entry in ${sha}`);
    const [, mode, blobOid, path] = match;
    assertDocumentationPath(path);
    if (mode !== '100644') fail(`requires regular mode 100644 at ${path} in ${sha}`);
    if (onRail(path) && !migrationIdentity(path) && path !== 'db/platform/migrations/README.md') fail(`unknown migration path ${path}`);
    return [path, { path, mode, blobOid }];
  }));
}

function triples(entries, predicate) {
  return [...entries.values()].filter(({ path }) => predicate(path))
    .sort((a, b) => order(a.path, b.path)).map(({ path, mode, blobOid }) => [path, mode, blobOid]);
}

export function migrationOrderingDigest(entries) {
  return hash(JSON.stringify([1,
    triples(entries, onRail), triples(entries, path => path === MANIFEST),
    triples(entries, path => path === PINS), triples(entries, path => path.endsWith('.sql') && path.startsWith(PACKAGE) || path === PACKAGE_MANIFEST),
  ]));
}

function registryPaths(value) {
  if (typeof value === 'string') return migrationIdentity(value) ? [value] : [];
  if (value && typeof value === 'object') return Object.values(value).flatMap(registryPaths);
  return [];
}

function checkManifestOrder(manifest, candidates, before) {
  const plans = [manifest, manifest.qualified, manifest.qualifiedAdmin];
  const issuedPlans = [before, before.qualified, before.qualifiedAdmin];
  const expected = candidates.filter(path => migrationIdentity(path).rail === 'portable').sort(order);
  for (const [index, plan] of plans.entries()) {
    const issued = issuedPlans[index];
    if (!isDeepStrictEqual(plan.baseline, issued.baseline) ||
        !isDeepStrictEqual(plan.forward.slice(0, issued.forward.length), issued.forward)) fail('draft edits or relocates an issued manifest prefix');
    const suffix = plan.forward.slice(issued.forward.length).map(({ file }) => file);
    if (!isDeepStrictEqual(suffix.filter(path => expected.includes(path)), expected.filter(path => suffix.includes(path)))) fail('draft manifest contradicts portable migration order');
    if (suffix.some(path => !candidates.includes(path))) fail(`manifest suffix needs separate preparation at ${suffix.find(path => !candidates.includes(path))}`);
  }
}

function assertPinReferences(draftPins, moves) {
  const moving = moves.filter(({ sourcePath, targetPath }) => sourcePath !== targetPath).map(move => ({
    ...move, bare: new RegExp(`(?<![0-9])${move.sourceVersion}(?![0-9])`, 'u'),
  }));
  const scan = (value, location) => {
    if (typeof value !== 'string') {
      if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) scan(child, [...location, key]);
      return;
    }
    const moved = moving.find(move => value.includes(basename(move.sourcePath)) || move.bare.test(value));
    if (!moved) return;
    const directRow = location.at(-1) === 'path' &&
      (location.length === 3 || location.length === 4 && location[0] === 'nativeStoreForwardClass' && location[1] === 'slots');
    if (!directRow || value !== moved.sourcePath) fail(`unsupported approval reference ${PINS}:${location.join('.')} (${moved.sourceVersion})`);
  };
  scan(draftPins, []);
}

function checkPackageDraft(fork, main, draft, candidates) {
  for (const [path, entry] of draft) {
    if (!path.startsWith(PACKAGE) || path === PACKAGE_MANIFEST || same(fork.get(path), entry)) continue;
    const source = MIGRATION_RAILS[0] + basename(path);
    if (!candidates.includes(source)) {
      if (same(main.get(path), entry)) continue;
      fail(`package-only authored entry at ${path}`);
    }
    if (!same(draft.get(source), entry)) fail(`packaged SQL differs from its source at ${path}`);
    if (main.has(path) && !same(main.get(source), main.get(path))) fail(`projected name is owned by another file at ${path}`);
  }
  for (const [path] of fork) {
    if (path.startsWith(PACKAGE) && !draft.has(path)) fail(`draft deletes issued package SQL at ${path}`);
  }
}

/** Classifies net-new ordinary SQL using the exact fork, draft and fetched main. */
export function requiresMigrationGrant(cwd, base, head) {
  commit(cwd, base, 'base');
  commit(cwd, head, 'head');
  const forks = gitText(cwd, 'merge-base', '--all', base, head).trim().split('\n');
  if (forks.length !== 1 || !SHA.test(forks[0])) fail('expected one committed fork point');
  const fork = tree(cwd, forks[0]), main = tree(cwd, base), candidate = tree(cwd, head);
  const exactManaged = new Set((json(cwd, candidate, PINS).managedExactForwards ?? []).map(({ path }) => path));
  return [...candidate].some(([path, entry]) => {
    const identity = migrationIdentity(path);
    return identity && !identity.qualifier && identity.version !== '00000000000000' &&
      !fork.has(path) && !same(main.get(path), entry) && !exactManaged.has(path);
  });
}

export async function readFinalizationPlan(cwd, base, head) {
  commit(cwd, base, 'base');
  commit(cwd, head, 'draft');
  const forks = gitText(cwd, 'merge-base', '--all', base, head).trim().split('\n');
  if (forks.length !== 1 || !SHA.test(forks[0])) fail('expected one committed fork point');
  const fork = tree(cwd, forks[0]);
  const main = tree(cwd, base);
  const draft = tree(cwd, head);
  for (const path of [MANIFEST, PINS, PACKAGE_MANIFEST]) {
    if (![fork, main, draft].every(entries => entries.has(path))) fail(`required ordering input is missing at ${path}`);
  }
  for (const [path, entry] of fork) {
    if (onRail(path) && (!same(entry, draft.get(path)) || !same(entry, main.get(path)))) fail(`issued migration changed or was deleted at ${path}`);
  }
  const additions = [...draft.keys()].filter(path => onRail(path) && !fork.has(path));
  const candidates = additions.filter(path => !same(main.get(path), draft.get(path)));
  checkManifestOrder(json(cwd, draft, MANIFEST), additions, json(cwd, fork, MANIFEST));
  checkPackageDraft(fork, main, draft, additions);
  const issued = new Set([fork, main].flatMap(entries => registryPaths(json(cwd, entries, PINS))));
  const draftPins = json(cwd, draft, PINS);
  const fixed = new Set((draftPins.managedExactForwards ?? []).map(({ path }) => path));
  for (const path of candidates) {
    const identity = migrationIdentity(path);
    if (!identity || identity.qualifier || identity.version === '00000000000000' || fixed.has(path)) fail(`fixed or unknown migration requires reviewed preparation at ${path}`);
    if (issued.has(path)) fail(`issued approval or reservation owns ${path}`);
    if (identity.rail === 'managed' && [...issued, ...fixed].some(pin => fixed.has(pin) && path < pin)) fail(`managed prefix digest would change at ${path}`);
  }
  const mainManifest = json(cwd, main, MANIFEST);
  const bounds = [mainManifest, mainManifest.qualified, mainManifest.qualifiedAdmin]
    .flatMap(plan => [plan.baseline, ...plan.forward]).map(({ file }) => migrationIdentity(file)?.version).filter(Boolean);
  const pending = new Map([...issued].map(path => [path.toLowerCase(), path]));
  const namespace = new Map();
  for (const path of new Set([...main.keys(), ...draft.keys()])) {
    const key = path.toLowerCase();
    const spellings = namespace.get(key) ?? [];
    spellings.push(path);
    namespace.set(key, spellings);
  }
  for (const path of candidates) {
    for (const name of [path, ...(migrationIdentity(path).rail === 'portable' ? [mirror(path)] : [])]) {
      const conflict = namespace.get(name.toLowerCase())?.find(path => path !== name);
      if (conflict) fail(`case-folded migration path collision at ${name}: ${conflict}`);
    }
  }
  const unavailable = (target, source) => {
    if (!target) return false;
    if (pending.has(target.toLowerCase())) return true;
    if (source === target) return false;
    return namespace.has(target.toLowerCase()) ||
      (migrationIdentity(target).rail === 'portable' && namespace.has(mirror(target).toLowerCase()));
  };
  const slots = planMigrationSlots(candidates, [...main.keys()], { bounds, unavailable });
  const moves = slots.moves.map(move => ({
    ...move, blobOid: draft.get(move.sourcePath).blobOid, mode: draft.get(move.sourcePath).mode,
  }));
  assertPinReferences(draftPins, moves);
  await assertNoAuthoredSlotReferences(cwd, forks[0], head, moves.filter(({ sourcePath, targetPath }) => sourcePath !== targetPath)
    .map(({ sourcePath, targetPath }) => ({ path: sourcePath, target: targetPath })));
  return { base, draftHead: head, orderingDigest: migrationOrderingDigest(main), moves, next: slots.next };
}

function requireFields(value, names, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      !isDeepStrictEqual(Object.keys(value).sort(), names.split(' ').sort())) fail(`unexpected ${label} fields`);
}

export function parseMigrationGrant(text) {
  const grant = parseStrictJson(text, 'migration grant');
  requireFields(grant, 'schemaVersion repositoryId baseRef prNodeId prNumber grantId draftHead observedMain orderingDigest issuedAt expiresAt moves', 'grant');
  const positive = n => Number.isSafeInteger(n) && n > 0;
  const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
  const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
  if (grant.schemaVersion !== 1 || !positive(grant.repositoryId) || grant.baseRef !== 'refs/heads/main' ||
      !matches(grant.prNodeId, PR_NODE) || !positive(grant.prNumber) || !matches(grant.grantId, UUID) ||
      !matches(grant.draftHead, SHA) || !matches(grant.observedMain, SHA) || !matches(grant.orderingDigest, DIGEST) ||
      !instant(grant.issuedAt) || !instant(grant.expiresAt) || grant.issuedAt >= grant.expiresAt ||
      !Array.isArray(grant.moves) || !grant.moves.length) fail('invalid grant identity, time range or move vector');
  const sources = new Set(), targets = new Set();
  for (const move of grant.moves) {
    requireFields(move, 'sourcePath sourceVersion targetPath targetVersion blobOid mode', 'grant move');
    const source = typeof move.sourcePath === 'string' && migrationIdentity(move.sourcePath);
    const target = typeof move.targetPath === 'string' && migrationIdentity(move.targetPath);
    if (!source || !target || source.qualifier || target.qualifier || source.rail !== target.rail ||
        source.name !== target.name || source.version !== move.sourceVersion || target.version !== move.targetVersion ||
        !isUtcMigrationSlot(move.targetVersion) || !matches(move.blobOid, SHA) || move.mode !== '100644' ||
        sources.has(source.version) || targets.has(target.version)) fail(`invalid or duplicate grant move at ${move.sourcePath}`);
    sources.add(source.version);
    targets.add(target.version);
  }
  return grant;
}

function gitAncestor(cwd, before, after) {
  try { gitBytes(cwd, 'merge-base', '--is-ancestor', before, after); return true; }
  catch (error) { if (error.status !== 1) throw error; return false; }
}

function requireMainAndHead(cwd, base, head, ref) {
  if (gitText(cwd, 'rev-parse', '--verify', REF).trim() !== base) fail('fetched origin/main changed or differs from --base');
  if (gitText(cwd, 'rev-parse', '--verify', 'HEAD').trim() !== head) fail('checkout HEAD changed or differs from --head');
  if (gitText(cwd, 'symbolic-ref', '-q', 'HEAD').trim() !== ref) fail('task branch changed');
}

function verifyLocalPath(cwd, path, expected) {
  const file = resolve(cwd, path);
  for (let part = dirname(file); part !== cwd; part = dirname(part)) {
    if (!lstatSync(part, { throwIfNoEntry: false })?.isDirectory()) fail(`non-directory or symlink parent at ${part}`);
  }
  const names = readdirSync(dirname(file));
  const caseCollision = names.find(name => name !== basename(path) && name.toLowerCase() === basename(path).toLowerCase());
  if (caseCollision) fail(`case-folded checkout collision at ${path}: ${caseCollision}`);
  const actual = lstatSync(file, { throwIfNoEntry: false });
  if (actual && (!expected || !actual.isFile() || (actual.mode & 0o111) !== 0)) fail(`unsafe or untracked location at ${path}`);
  if (expected && !actual) fail(`expected tracked checkout file at ${path}`);
  if (actual && gitText(cwd, 'hash-object', '--no-filters', '--', path).trim() !== expected.blobOid) fail(`worktree bytes differ at ${path}`);
  if (!expected) {
    try { gitBytes(cwd, 'check-ignore', '--no-index', '--', path); }
    catch (error) { if (error.status === 1) return; throw error; }
    fail(`ignored destination at ${path}`);
  }
}

function verifyMovePaths(cwd, draft, main, moves) {
  for (const { sourcePath, targetPath } of moves) {
    const portable = migrationIdentity(sourcePath).rail === 'portable';
    const sources = [sourcePath, ...(portable ? [mirror(sourcePath)] : [])];
    for (const source of sources) verifyLocalPath(cwd, source, draft.get(source));
    if (sourcePath === targetPath) continue;
    for (const target of [targetPath, ...(portable ? [mirror(targetPath)] : [])]) {
      if (draft.has(target) || main.has(target)) fail(`tracked destination already exists at ${target}`);
      verifyLocalPath(cwd, target, undefined);
    }
  }
}

function indexEntries(cwd) {
  return new Map(paths(gitText(cwd, 'ls-files', '--stage', '-z')).flatMap(row => {
    const match = /^(\d{6}) ([a-f0-9]{40}) 0\t([^\0]+)$/u.exec(row);
    if (!match) return [];
    const [, mode, blobOid, path] = match;
    return [[path, { mode, blobOid, path }]];
  }));
}

function verifySql(actual, draft, main, moves) {
  const expected = new Map([...draft, ...main]);
  for (const move of moves) {
    const { sourcePath, targetPath } = move;
    if (sourcePath !== targetPath && !main.has(sourcePath)) expected.delete(sourcePath);
    expected.set(targetPath, move);
    if (migrationIdentity(sourcePath).rail !== 'portable') continue;
    if (sourcePath !== targetPath && !main.has(mirror(sourcePath))) expected.delete(mirror(sourcePath));
    expected.set(mirror(targetPath), move);
  }
  for (const path of new Set([...actual.keys(), ...expected.keys()])) {
    if ((onRail(path) || path.startsWith(PACKAGE)) && path !== PACKAGE_MANIFEST && !same(expected.get(path), actual.get(path))) {
      fail(`staged SQL differs from approved move or issued history at ${path}`);
    }
  }
}

function readLocalGrant(cwd) {
  const path = resolve(landingGitDirectory(cwd), 'openlup-migration-grant.json');
  const invalid = 'place an owned, regular grant fixture at git rev-parse --git-path openlup-migration-grant.json (128 KiB maximum)';
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (!['ENOENT', 'ELOOP', 'EACCES'].includes(error.code)) throw error;
    fail(invalid);
  }
  try {
    const limit = 128 * 1024;
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o022) !== 0 ||
        (process.getuid && file.uid !== process.getuid()) || file.size > limit) fail(invalid);
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > limit) fail(invalid);
    return parseMigrationGrant(bytes.subarray(0, size).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

export async function applyMigrationFinalization(cwd, { base, head, pr, repositoryId, prNodeId, now = Date.now, runCommand }) {
  cwd = realpathSync(cwd);
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1 || typeof prNodeId !== 'string' || !PR_NODE.test(prNodeId)) {
    fail('apply requires a fixture repository ID and immutable PR node ID');
  }
  const grant = readLocalGrant(cwd);
  const verifyGrant = () => {
    const time = now();
    if (time < Date.parse(grant.issuedAt)) fail('grant issue time is in the future');
    if (time >= Date.parse(grant.expiresAt)) fail('grant expired');
    if (grant.prNumber !== pr || grant.repositoryId !== repositoryId ||
        grant.prNodeId !== prNodeId || grant.draftHead !== head) fail('grant PR, repository or draft differs from the request');
  };
  verifyGrant();
  const plan = await readFinalizationPlan(cwd, base, head);
  if (grant.orderingDigest !== plan.orderingDigest || !isDeepStrictEqual(grant.moves, plan.moves)) fail('grant ordering digest or complete move vector differs from the draft plan');
  commit(cwd, grant.observedMain, 'grant observed main');
  if (!gitAncestor(cwd, grant.observedMain, base)) fail('grant observed main is no longer an ancestor of fetched main');
  const observed = grant.observedMain === base ? plan : await readFinalizationPlan(cwd, grant.observedMain, head);
  if (observed.orderingDigest !== plan.orderingDigest || !isDeepStrictEqual(observed.moves, plan.moves)) fail('grant was issued for different ordering inputs');
  let ref;
  try { ref = gitText(cwd, 'symbolic-ref', '-q', 'HEAD').trim(); }
  catch (error) { if (error.status !== 1) throw error; fail('apply requires a local task branch'); }
  if (!ref.startsWith('refs/heads/') || ref === 'refs/heads/main') fail('apply requires a local task branch');
  const lock = resolve(cwd, gitText(cwd, 'rev-parse', '--git-path', 'openlup-migration-finalize.lock').trim());
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; fail('another finalization is running in this checkout'); }
  try {
    const checkpoint = () => {
      verifyGrant();
      requireMainAndHead(cwd, base, head, ref);
      const indexLock = resolve(cwd, gitText(cwd, 'rev-parse', '--git-path', 'index.lock').trim());
      if (lstatSync(indexLock, { throwIfNoEntry: false })) fail('concurrent Git index operation');
    };
    checkpoint();
    if (gitText(cwd, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all')) fail('apply requires a clean, committed checkout');
    const main = tree(cwd, base), draft = tree(cwd, head);
    verifyMovePaths(cwd, draft, main, plan.moves);
    const fork = gitText(cwd, 'merge-base', base, head).trim();
    const approved = entriesAt(cwd, head), upstream = entriesAt(cwd, base), forkEntries = entriesAt(cwd, fork);
    const mechanical = fork === base ? { sha: head, conflicts: [] } : predictMerge(cwd, head, base, true);
    const bystanders = new Map();
    const predicted = entriesAt(cwd, mechanical.sha);
    const owned = scopedSqlPaths(plan.moves);
    const guarded = new Set([...owned, ...PROOF_CARRIERS]);
    const ownState = () => {
      const stages = new Map([...guarded].map(path => [path, []]));
      const rows = gitText(cwd, '--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...guarded);
      for (const row of paths(rows)) {
        const tab = row.indexOf('\t');
        stages.get(row.slice(tab + 1)).push(row.slice(0, tab));
      }
      return new Map([...guarded].map(path => {
        const target = resolve(cwd, path);
        const file = lstatSync(target, { throwIfNoEntry: false });
        return [path, { stages: stages.get(path), mode: file?.mode,
          bytes: file?.isFile() ? readFileSync(target) : undefined,
          link: file?.isSymbolicLink() ? readlinkSync(target) : undefined }];
      }));
    };
    let expectedOwned;
    const checkOwned = ({ files = [], index = [] } = {}) => {
      const current = ownState();
      const unexpected = [];
      for (const [path, after] of current) {
        const before = expectedOwned?.get(path);
        if (!before) continue;
        const { stages, ...worktree } = after;
        const { stages: oldStages, ...oldWorktree } = before;
        const indexChanged = !isDeepStrictEqual(stages, oldStages);
        if ((!indexChanged || index.includes(path)) &&
            (files.includes(path) || isDeepStrictEqual(worktree, oldWorktree))) continue;
        const stageZero = stages.find(stage => stage.endsWith(' 0'));
        const [mode, blobOid] = stageZero?.split(' ') ?? [];
        const entry = indexChanged && !index.includes(path) ? stageZero && { mode, blobOid } : approved.get(path);
        bystanders.set(path, { ...worktree, entry, owned: true });
        unexpected.push(path);
      }
      if (unexpected.length) fail(`concurrent edit to owned migration path: ${unexpected.join(', ')}`);
      expectedOwned = current;
    };
    const guard = async (changes, action) => {
      checkOwned();
      try { return await action(); }
      finally { checkOwned(changes); }
    };
    const trackOwned = paths => {
      for (const path of paths) guarded.add(path);
      checkOwned();
    };
    const mergePaths = [...guarded].filter(path =>
      mechanical.conflicts.includes(path) || !same(predicted.get(path), approved.get(path)));
    const captureBystanders = active => {
      const expected = active ? predicted : approved;
      const entries = indexEntries(cwd);
      const unstaged = new Set(paths(gitText(cwd, 'diff', '--name-only', '--no-renames', '-z')));
      const candidates = new Set([...entries.keys(), ...expected.keys(), ...unstaged]);
      for (const path of candidates) {
        if (guarded.has(path) || mechanical.conflicts.includes(path)) continue;
        const entry = entries.get(path);
        if (same(entry, expected.get(path)) && !unstaged.has(path)) continue;
        assertDocumentationPath(path);
        const target = resolve(cwd, path);
        const file = lstatSync(target, { throwIfNoEntry: false });
        bystanders.set(path, { entry, bytes: file?.isFile() ? readFileSync(target) : undefined,
          link: file?.isSymbolicLink() ? readlinkSync(target) : undefined, mode: file?.mode });
      }
    };
    checkOwned();
    let measuredInventorySha256;
    const result = await finalizeLanding(cwd, {
      head, main: base, base: fork, ref, moves: plan.moves, checkpoint, guard, trackOwned,
      mergePaths, bystanders, captureBystanders,
      sourceBytes: move => blob(cwd, move),
      verifyIndex: measuredInventory => {
        const staged = gitText(cwd, 'write-tree').trim();
        const actual = entriesAt(cwd, staged);
        measuredInventorySha256 = hash(measuredInventory);
        verifyMeasuredInventory(cwd, actual, measuredInventorySha256);
        verifyFinalizationContent(cwd, staged, forkEntries, approved, upstream, actual, plan.moves, mechanical, predicted);
        return staged;
      }, runCommand,
    });
    return { grantId: grant.grantId, draftHead: head, head: result.head, base, moves: plan.moves, measuredInventorySha256 };
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

const PUBLICATION = 'config/openlup-publication-catalog.json';
const GENERATED_CARRIERS = [SQL_REFERENCE, PACKAGE_MANIFEST, 'packages/platform/src/migrations/catalog.ts', PUBLICATION, 'docs/platform/SOURCE_MAP.md'];
const PROOF_CARRIERS = new Set([MANIFEST, PINS, INVENTORY_PATH, ...GENERATED_CARRIERS]);
const REGIONS = /(<!-- generated:(sql:[a-z]+) -->\n)[\s\S]*?(<!-- \/generated:\2 -->)/gu;
const entriesAt = (cwd, sha) => new Map(paths(gitText(cwd, 'ls-tree', '-r', '-z', '--full-tree', sha)).map(row => {
  const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]{40})\t([^\0]+)$/u.exec(row);
  if (!match) fail(`invalid finalization proof tree entry at ${sha}`);
  const [, mode, blobOid, path] = match;
  return [path, { mode, blobOid, path }];
}));
function predictMerge(cwd, main, head, allowConflicts) {
  const args = ['-c', 'merge.renames=false', '-c', 'merge.directoryRenames=false', '-c', 'merge.conflictStyle=merge',
    'merge-tree', '--write-tree', '--no-messages', main, head];
  let output;
  try { output = gitText(cwd, ...args); }
  catch (error) {
    if (error.status !== 1 || !allowConflicts) fail('finalized head must integrate without authored conflicts');
    output = error.stdout.toString('utf8');
  }
  const [sha, ...rows] = output.trim().split('\n');
  if (!SHA.test(sha)) fail('could not predict a mechanical finalization tree');
  const conflicts = rows.map(row => row.slice(row.indexOf('\t') + 1));
  return { sha, conflicts };
}

function verifyCarrierData(cwd, fork, draft, main, actual, moves) {
  const manifest = json(cwd, actual, MANIFEST);
  const portable = moves.filter(move => migrationIdentity(move.targetPath).rail === 'portable');
  const expected = portable.map(move => move.targetPath);
  const previous = json(cwd, main, MANIFEST);
  const errors = evaluatePlatformMigrationManifestHistory(previous, manifest, expected);
  const migrations = [...actual.values()].filter(({ path }) => migrationIdentity(path)?.rail === 'portable')
    .map(entry => ({ file: entry.path, content: blob(cwd, entry).toString('utf8') }));
  errors.push(...evaluatePlatformMigrationManifest({ manifest, migrations }));
  for (const [before, after] of [[previous, manifest], [previous.qualified, manifest.qualified], [previous.qualifiedAdmin, manifest.qualifiedAdmin]]) {
    if (!isDeepStrictEqual(after.forward.slice(before.forward.length).map(({ file }) => file), expected)) {
      errors.push('portable manifest suffix differs from the approved order');
    }
  }
  const packaged = json(cwd, actual, PACKAGE_MANIFEST);
  if (!isDeepStrictEqual(packaged.catalog, manifest)) errors.push('packaged manifest differs from the approved catalogue');
  const rows = new Map([manifest, manifest.qualified, manifest.qualifiedAdmin].flatMap(plan => [plan.baseline, ...plan.forward])
    .map(({ file, sha256 }) => [file, { file: basename(file), source: file, sha256 }]));
  const projection = [...rows.values()].sort((a, b) => order(a.source, b.source));
  if (packaged.schemaVersion !== 1 || !isDeepStrictEqual(packaged.migrations, projection)) errors.push('packaged SQL manifest projection differs');
  for (const row of projection) {
    if (!same(actual.get(row.source), actual.get(mirror(row.source)))) errors.push(`packaged SQL bytes differ at ${row.source}`);
  }
  const envelope = (entries) => inventoryEnvelope(blob(cwd, entries.get(INVENTORY_PATH)).toString('utf8'));
  const original = envelope(fork), newer = envelope(actual);
  if (![envelope(draft), envelope(main), newer].every(value => original.before === value.before && original.after === value.after)) {
    errors.push('historical inventory bytes changed');
  }
  const profiles = newer.value.current.profiles;
  const select = (generation, binding) => selectPlatformMigrationManifest(manifest, generation, binding);
  const selections = {
    legacy: select('legacy'),
    bootstrap: select('qualified-v2', { migrationIsBootstrap: true, hasRestore: true }),
    separate: select('qualified-v2', { migrationIsBootstrap: false, hasRestore: true }),
    'admin-managed': select('qualified-admin', { roleMode: 'installer-managed' }),
    'admin-operator': select('qualified-admin', { roleMode: 'operator-provisioned' }),
  };
  for (const [name, plan] of Object.entries(selections)) {
    const profile = profiles[name], tail = [plan.baseline, ...plan.forward].reverse();
    const exactTailCount = tail.findIndex(({ file }) => file === 'db/platform/migrations/20261109150000_subscription_auto_resume_paid_history.sql');
    if (profile.count !== tail.length || profile.exactTailCount !== exactTailCount || JSON.stringify(profile.tail) !== JSON.stringify(tail)) {
      errors.push(`inventory ledger differs for ${name}`);
    }
  }
  const changes = moves.filter(({ sourcePath, targetPath }) => sourcePath !== targetPath)
    .map(({ sourcePath, targetPath }) => ({ path: sourcePath, target: targetPath }));
  for (const path of [MANIFEST, PINS]) {
    const left = path === MANIFEST ? fillDraftManifest(contents(cwd, draft, path), moves, move => blob(cwd, move)) : contents(cwd, draft, path);
    const remapped = reslotRegistryContents(cwd, path, left, changes, true, false);
    const expectedBytes = migrationRegistryUnion(path, contents(cwd, fork, path), remapped, contents(cwd, main, path), contents(cwd, actual, INVENTORY_PATH));
    if (contents(cwd, actual, path) !== expectedBytes) errors.push(`finalized carrier differs from approved replay at ${path}`);
  }
  if (errors.length) fail(errors.join('; '));
}

function verifyGeneratedCarriers(cwd, head, fork, draft, main, actual, moves, predicted) {
  const changes = moves.filter(({ sourcePath, targetPath }) => sourcePath !== targetPath)
    .map(({ sourcePath, targetPath }) => ({ path: sourcePath, target: targetPath }));
  const left = contents(cwd, draft, PUBLICATION);
  const reslotsCatalogue = changes.some(({ path }) => path.startsWith('supabase/migrations/'));
  const catalogue = reslotsCatalogue || predicted.conflicts.includes(PUBLICATION)
    ? registryUnion(PUBLICATION, contents(cwd, fork, PUBLICATION), reslotsCatalogue ? reslotRegistryContents(cwd, PUBLICATION, left, changes, true, false) : left, contents(cwd, main, PUBLICATION))
    : contents(cwd, entriesAt(cwd, predicted.sha), PUBLICATION);
  withPredictedTree(cwd, head, (root, paths) => {
    writeFileSync(resolve(root, PUBLICATION), catalogue);
    runLandingGenerators(root, paths);
    for (const path of GENERATED_CARRIERS) {
      if (!readFileSync(resolve(root, path)).equals(blob(cwd, actual.get(path)))) fail(`trusted generator differs at ${path}`);
    }
  });
}

function scopedSqlPaths(moves) {
  return new Set(moves.flatMap(({ sourcePath, targetPath }) => [
    sourcePath, targetPath, ...(migrationIdentity(sourcePath).rail === 'portable' ? [mirror(sourcePath), mirror(targetPath)] : []),
  ]));
}

function verifyFinalizationContent(cwd, target, fork, approved, main, actual, moves, mechanical, predicted) {
  const sqlChanges = scopedSqlPaths(moves);
  for (const path of mechanical.conflicts) {
    if (!sqlChanges.has(path) && !PROOF_CARRIERS.has(path)) fail(`authored merge conflict at ${path}`);
  }
  for (const path of new Set([...actual.keys(), ...predicted.keys()])) {
    if (same(actual.get(path), predicted.get(path)) || sqlChanges.has(path)) continue;
    if (!PROOF_CARRIERS.has(path) || actual.get(path)?.mode !== '100644') fail(`unapproved finalization change at ${path}`);
  }
  const source = predicted.get(SQL_REFERENCE);
  const final = actual.get(SQL_REFERENCE);
  if (source && final && blob(cwd, source).toString('utf8').replace(REGIONS, '$1$3') !== blob(cwd, final).toString('utf8').replace(REGIONS, '$1$3')) {
    fail(`authored finalization change at ${SQL_REFERENCE}`);
  }
  verifySql(actual, approved, main, moves);
  verifyCarrierData(cwd, fork, approved, main, actual, moves);
  verifyGeneratedCarriers(cwd, target, fork, approved, main, actual, moves, mechanical);
}

function verifyMeasuredInventory(cwd, actual, measuredInventorySha256) {
  const entry = actual.get(INVENTORY_PATH);
  if (!entry || entry.mode !== '100644' || hash(blob(cwd, entry)) !== measuredInventorySha256) {
    fail('finalized inventory differs from the independently measured bytes');
  }
}

/** Reads finalized commits as data using an independent measurement and an independently checked grant. */
export async function verifyFinalizedMigrationHead(cwd, { grant, base, head, liveMain = base, measuredInventorySha256, now = Date.now }) {
  if (typeof measuredInventorySha256 !== 'string' || !DIGEST.test(measuredInventorySha256)) {
    fail('verification requires an independently measured inventory SHA-256');
  }
  const time = now();
  if (time < Date.parse(grant.issuedAt)) fail('grant issue time is in the future');
  if (time >= Date.parse(grant.expiresAt)) fail('grant expired');
  commit(cwd, base, 'recorded main');
  commit(cwd, head, 'finalized head');
  commit(cwd, liveMain, 'live main');
  if (!gitAncestor(cwd, grant.observedMain, base) || !gitAncestor(cwd, base, liveMain)) fail('recorded grant and apply bases must be ancestors of live main');
  const draft = grant.draftHead;
  const plan = await readFinalizationPlan(cwd, base, draft);
  if (plan.orderingDigest !== grant.orderingDigest || !isDeepStrictEqual(plan.moves, grant.moves)) fail('finalization proof differs from the approved draft plan');
  const draftContainsBase = gitAncestor(cwd, base, draft);
  if (head !== draft) {
    const parents = gitText(cwd, 'show', '-s', '--format=%P', head).trim().split(' ');
    if (!isDeepStrictEqual(parents, draftContainsBase ? [draft] : [draft, base])) fail('unexpected finalization parent history');
    const [committer, ...message] = gitText(cwd, 'show', '-s', '--format=%cn <%ce>%n%B', head).split('\n');
    if (!message.includes(`Signed-off-by: ${committer}`)) fail('finalization requires a matching DCO sign-off');
  } else if (!draftContainsBase) fail('finalized head must carry the validated main parent');
  const actual = entriesAt(cwd, head);
  verifyMeasuredInventory(cwd, actual, measuredInventorySha256);
  const approved = entriesAt(cwd, draft);
  const main = entriesAt(cwd, base);
  const mechanical = draftContainsBase ? { sha: draft, conflicts: [] } : predictMerge(cwd, draft, base, true);
  const fork = entriesAt(cwd, gitText(cwd, 'merge-base', base, draft).trim());
  verifyFinalizationContent(cwd, head, fork, approved, main, actual, grant.moves, mechanical, entriesAt(cwd, mechanical.sha));
  for (const revision of new Set([grant.observedMain, liveMain])) {
    if (revision !== base && migrationOrderingDigest(tree(cwd, revision)) !== plan.orderingDigest) fail('main migration ordering inputs changed');
  }
  if (liveMain !== base) predictMerge(cwd, liveMain, head, false);
  return { base, head, draftHead: draft, grantId: grant.grantId, moves: plan.moves, orderingDigest: plan.orderingDigest, measuredInventorySha256 };
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true, options: { base: { type: 'string' }, head: { type: 'string' },
      next: { type: 'string' }, pr: { type: 'string' },
      'repository-id': { type: 'string' }, 'pr-node-id': { type: 'string' } },
  });
  const [command] = positionals;
  const { base, head, next, pr, 'repository-id': repositoryId, 'pr-node-id': prNodeId } = values;
  if (positionals.length !== 1 || !base || !head) fail('use plan or apply with --base and --head');
  const cwd = process.cwd();
  if (command === 'plan' && !pr && repositoryId === undefined && prNodeId === undefined) {
    if (next !== undefined && !['portable', 'managed'].includes(next)) fail('--next requires portable or managed');
    const { next: nextSlot, ...plan } = await readFinalizationPlan(cwd, base, head);
    console.log(JSON.stringify(next ? { base, draftHead: head, rail: next, version: nextSlot() } : plan));
    return;
  }
  if (command === 'apply' && next === undefined && /^[1-9][0-9]*$/u.test(pr) && /^[1-9][0-9]*$/u.test(repositoryId) && prNodeId) {
    const result = await applyMigrationFinalization(cwd, { base, head, pr: Number(pr), repositoryId: Number(repositoryId), prNodeId });
    console.log(JSON.stringify(result));
    return;
  }
  fail('use plan [--next portable|managed] or apply --pr NUMBER --repository-id ID --pr-node-id ID');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
