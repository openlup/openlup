// Local landing helper: merge main, stop on authored conflicts, never push.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { git } from './agent-review-session.mjs';
import { REGISTRY_PATHS, registryUnion } from './agent-review-registry.mjs';
import { INVENTORY_PATH, MIGRATION_REGISTRIES, inventoryEnvelope, migrationRegistryUnion } from './agent-review-derived.mjs';
import * as carrierGenerators from './agent-review-generators.mjs';
import { DEFAULT_INCREMENTAL_PACKAGES, TSBUILDINFO_FILENAME } from './build-packages-incremental.mjs';
import { isGuidePage } from './oss-publication-policy.ts';

const { generatedCarrier, ownerOutputCarrier, SQL_REFERENCE } = carrierGenerators;
const PUBLICATION_CATALOGUE = REGISTRY_PATHS[0];
const SETTINGS_GUIDE = 'packages/core/docs/guide/how-to/operate/settings-catalogue.md';
const SETTINGS_OUTPUTS = ['packages/platform/settings-catalog.json', 'packages/platform/settings-refusals.json', SETTINGS_GUIDE];
const BUILD_SCRIPT = 'scripts/build-packages-incremental.mjs';
export const carrierLocale = { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
const readJson = (root, path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const pathsFrom = output => output.split('\0').filter(Boolean);

export function carrierNpmCli(script = 'landing:merge') {
  const cli = processEnvironment.npm_execpath;
  if (!cli || !isAbsolute(cli)) throw new Error(`carrier build requires npm's CLI path; run through npm run ${script}`);
  return cli;
}

export function assertLockedInstall(root, locked) {
  const refuse = path => new Error(`carrier build: installed npm tree does not match package-lock.json (${path}); run npm ci in this checkout`);
  const record = 'node_modules/.package-lock.json';
  let installed;
  try { installed = readJson(root, record).packages; }
  catch { throw refuse(record); }
  if (!installed || !Object.keys(installed).length) throw refuse(record);
  for (const [path, entry] of Object.entries(installed)) {
    if (!isDeepStrictEqual(entry, locked[path])) throw refuse(path);
  }
  // npm's installed record omits the project root and may omit optional packages.
  for (const [path, entry] of Object.entries(locked)) {
    if (path && !entry.optional && !Object.hasOwn(installed, path)) throw refuse(path);
  }
}

export function describeCarrierToolchain(npm) {
  return `carrier toolchain: Node ${process.versions.node}, npm ${npm}, ICU ${process.versions.icu}`;
}

export function assertCarrierToolchain(root, script) {
  const cli = carrierNpmCli(script);
  const node = readFileSync(resolve(root, '.nvmrc'), 'utf8').trim();
  const npm = readJson(root, 'package.json').packageManager;
  if (process.versions.node.split('.')[0] !== /^v?(\d+)\./u.exec(node)?.[1]) {
    throw new Error(`carrier build requires the Node major pinned by .nvmrc (${node}); found Node ${process.versions.node}. Run nvm install && nvm use.`);
  }
  if (new Intl.Collator().resolvedOptions().locale !== 'en-US') {
    throw new Error('carrier build requires the en-US ICU profile');
  }
  const installedNpm = execFileSync(process.execPath, [cli, '--version'], { cwd: root, encoding: 'utf8' }).trim();
  if (installedNpm.split('.')[0] !== /^npm@(\d+)\./u.exec(npm)?.[1]) {
    throw new Error(`carrier build requires the npm major pinned by packageManager (${npm}); found npm@${installedNpm}. Run npm install --global ${npm}.`);
  }
  const workspace = readJson(root, 'config/openlup-packages.json');
  const lock = readJson(root, 'package-lock.json');
  assertLockedInstall(root, lock.packages);
  const compiler = realpathSync(resolve(root, 'node_modules/typescript/package.json'));
  if (readJson(root, 'node_modules/typescript/package.json').version !== lock.packages['node_modules/typescript'].version) {
    throw new Error('carrier build requires the locked TypeScript version; run npm ci in this checkout');
  }
  for (const from of ['scripts', ...workspace.packages.map(({ directory }) => directory)]) {
    const require = createRequire(resolve(root, from, 'package.json'));
    if (require.resolve('typescript/package.json') !== compiler || workspace.packages.some(({ name, directory }) =>
      require.resolve(`${name}/package.json`) !== realpathSync(resolve(root, directory, 'package.json')))) {
      throw new Error(`carrier build requires workspace links in this checkout (${from}); run npm ci here`);
    }
  }
  return describeCarrierToolchain(installedNpm);
}


class LandingConflict extends Error {}

function refuseAuthoredConflicts(paths) {
  if (paths.length) throw new LandingConflict(`landing: authored conflicts remain: ${paths.join(', ')}`);
}

const commandDiagnostic = error => error?.stderr?.toString().trim() || error?.message || String(error);
const checkoutStatus = cwd => git(cwd, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all');

async function abortLanding(cwd, { head, hasMerge, ignored, diagnostics, writes }, error) {
  const cleanupFailures = [];
  const attempt = async action => {
    try { return await action(); }
    catch (failure) { cleanupFailures.push(failure); }
  };
  const active = await attempt(hasMerge);
  const owned = path => writes.paths.has(path) ||
    (writes.generated && generatedCarrier(path) && !ownerOutputCarrier?.(path));
  // Restore landing's writes from the merge index so they cannot obstruct abort.
  const cleanUntracked = async () => {
    const untracked = pathsFrom(await git(cwd, 'ls-files', '--others', '--exclude-standard', '-z')).filter(path => {
      if (!owned(path)) return false;
      // A merged ignore rule can expose pre-existing local files or directories.
      for (let entry = path; entry !== '.'; entry = dirname(entry)) {
        if (ignored.has(entry) || ignored.has(`${entry}/`)) return false;
      }
      return true;
    });
    if (untracked.length) await git(cwd, '--literal-pathspecs', 'clean', '-f', '--', ...untracked);
  };
  await attempt(cleanUntracked);
  await attempt(async () => {
    const modified = pathsFrom(await git(cwd, 'diff', '--name-only', '--no-renames', '-z')).filter(owned);
    if (modified.length) await git(cwd, '--literal-pathspecs', 'restore', '--worktree', '--ignore-unmerged', '--', ...new Set(modified));
  });
  if (active) await attempt(async () => {
    await git(cwd, 'merge', '--abort');
    await cleanUntracked();
  });
  await attempt(async () => {
    const actualHead = (await git(cwd, 'rev-parse', 'HEAD')).trim();
    const merging = hasMerge();
    const status = (await checkoutStatus(cwd)).trimEnd();
    if (actualHead === head && !merging && !status) return;
    throw new Error(`landing: expected clean HEAD ${head}, found HEAD ${actualHead}, MERGE_HEAD ${merging ? 'present' : 'absent'}, porcelain status ${JSON.stringify(status)}`);
  });
  const diagnostic = diagnostics.toolchain ?? commandDiagnostic(error);
  if (cleanupFailures.length) {
    throw new AggregateError([error, ...cleanupFailures], `${diagnostic}\nOPENLUP_E_LANDING_ABORT_FAILED: ${cleanupFailures.map(commandDiagnostic).join('\n')}`, { cause: error });
  }
  const restored = active ? 'merge aborted; the checkout is back at HEAD' : 'the checkout is still at the original clean HEAD';
  diagnostics.aborted = `${diagnostic}\nOPENLUP_E_LANDING_ABORTED: ${restored}`;
  throw error;
}

function checkLandingToolchain(run, env, merged = false) {
  const check = 'console.log(assertCarrierToolchain(process.cwd()));';
  const script = merged ? `try { ${check} } catch (error) { console.error(error.message); process.exitCode = 1; }` : check;
  const options = merged ? { env, stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' } : { env };
  run(process.execPath, ['--input-type=module', '-e', `import { assertCarrierToolchain } from './scripts/agent-review-landing.mjs'; ${script}`], options);
}

async function landingPreflight(cwd) {
  if ((await checkoutStatus(cwd)).trim()) throw new Error('landing: clean committed checkout required');
  const mergeHead = resolve(cwd, (await git(cwd, 'rev-parse', '--git-path', 'MERGE_HEAD')).trimEnd());
  const hasMerge = () => lstatSync(mergeHead, { throwIfNoEntry: false }) !== undefined;
  const requireNoMerge = () => {
    if (hasMerge()) throw new Error('landing: a merge is already in progress; finish or abort it before retrying');
  };
  requireNoMerge();
  return { hasMerge, requireNoMerge };
}

async function mergeWithRollback(cwd, { hasMerge, requireNoMerge, ...context }) {
  const { head, main, diagnostics } = context;
  const ignored = new Set(pathsFrom(await git(cwd, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z')));
  requireNoMerge();
  const writes = { paths: new Set(), generated: false };
  let inventoryRefreshed;
  try {
    try { await git(cwd, '-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '--no-commit', '--no-overwrite-ignore', main); }
    catch (error) { if (error.code !== 1 || !hasMerge()) throw error; }
    inventoryRefreshed = await landMergedCheckout(cwd, { ...context, writes });
  } catch (error) {
    if (error instanceof LandingConflict) throw error;
    return abortLanding(cwd, { head, hasMerge, ignored, diagnostics, writes }, error);
  }
  return { head: (await git(cwd, 'rev-parse', 'HEAD')).trim(), main, inventoryRefreshed };
}

async function checkMergedLandingToolchain(cwd, head, run, carrierEnv, diagnostics) {
  const toolchainInputs = ['.nvmrc', '.npmrc', 'package.json', 'package-lock.json', 'config/openlup-packages.json', 'scripts/agent-review-landing.mjs',
    ...DEFAULT_INCREMENTAL_PACKAGES.map(directory => `${directory}/package.json`)];
  if (await git(cwd, '--literal-pathspecs', 'diff', '--name-only', '-z', head, '--', ...toolchainInputs)) {
    const install = [process.execPath, carrierNpmCli(), 'ci'];
    const [command, ...args] = Object.hasOwn(carrierEnv, 'AI_RESOURCE_GATE_ACTIVE') ? install
      : ['ai-resource-gate', 'run', '--wait', 'openlup:landing-build', '--', ...install];
    run(command, args, { env: carrierEnv });
    try { checkLandingToolchain(run, carrierEnv, true); }
    catch (error) {
      diagnostics.toolchain = `OPENLUP_E_LANDING_TOOLCHAIN: ${commandDiagnostic(error)}\nafter npm ci from the merged lock`;
      throw error;
    }
  }
}

function checkLandingSqlReference(runGenerators) {
  try { runGenerators('owners.syncSqlReference(process.cwd());'); }
  catch (error) {
    if (error.message !== `landing: authored conflicts remain: ${SQL_REFERENCE}`) throw error;
    refuseAuthoredConflicts([SQL_REFERENCE]);
  }
}

function runLandingCli() {
  const diagnostics = {};
  runLanding(process.cwd(), undefined, diagnostics, process.argv.includes('--re-slot')).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(diagnostics.aborted ?? error.message);
    process.exitCode = 1;
  });
}

export async function assertCarrierBuildOutputs(cwd, directories, incremental = false) {
  const paths = directories.flatMap(directory => incremental
    ? [`${directory}/dist`, `${directory}/${TSBUILDINFO_FILENAME}`] : [`${directory}/dist`]);
  const [tracked] = pathsFrom(await git(cwd, '--literal-pathspecs', 'ls-files', '-z', '--', ...paths));
  if (tracked) throw new Error(`carrier build would overwrite or remove tracked path ${tracked}; remove it from the index with git rm --cached -- <path>`);
}

export function readReportOwners(cwd) {
  const workspace = readJson(cwd, 'config/openlup-packages.json');
  return DEFAULT_INCREMENTAL_PACKAGES.map(directory => {
    const { name } = workspace.packages.find(owner => owner.directory === directory);
    const manifest = readJson(cwd, `${directory}/package.json`);
    const gates = readJson(cwd, `${directory}/release-gates.json`);
    const reports = Object.values(gates.packageSurface).map(({ snapshot }) => {
      if (typeof snapshot !== 'string' || !snapshot.startsWith('api/') || !safeRelativePath(snapshot)) {
        throw new Error(`landing: unsafe API snapshot path ${directory}/${snapshot}`);
      }
      return `${directory}/${snapshot}`;
    });
    const dependencies = Object.assign({}, manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies, manifest.devDependencies);
    return { directory, name, reports, dependencies };
  });
}

function ownerOutputs(owners, publicPaths) {
  const registered = new Set(publicPaths.filter(row => row.class === 'public-output').map(row => row.path));
  const admitted = new Set([...registered, ...SETTINGS_OUTPUTS.filter(path => path === SETTINGS_GUIDE && isGuidePage(path))]);
  return { admitted, replaceable: new Set([...owners.flatMap(owner => owner.reports), ...SETTINGS_OUTPUTS].filter(path => admitted.has(path))) };
}

export function carrierPlan(owners, paths) {
  const shared = /^(?:package(?:-lock)?\.json|\.nvmrc|\.npmrc|config\/openlup-packages\.json|tsconfig[^/]*\.json|scripts\/(?:build-packages-incremental\.mjs|packages\/package-build\.ts))$/u;
  const inputs = /^(?:src\/|scripts\/|(?:package|release-gates|tsconfig[^/]*)\.json$)/u;
  const settingsData = /^packages\/platform\/src\/[^/]+\/settings-data\.json$/u;
  const selected = new Set(owners.filter(({ directory, reports }) => paths.some(path => shared.test(path) ||
    (path.startsWith(`${directory}/`) && inputs.test(path.slice(directory.length + 1)) && !settingsData.test(path))) ||
    reports.some(path => paths.includes(path))).map(({ name }) => name));
  for (const owner of owners) {
    if (Object.keys(owner.dependencies).some(name => selected.has(name))) selected.add(owner.name);
  }
  const settings = selected.has('@openlup/platform') || paths.some(path =>
    settingsData.test(path) || path === 'scripts/settings-catalogue.ts' || SETTINGS_OUTPUTS.includes(path));
  const needed = new Set(selected);
  if (settings) needed.add('@openlup/platform');
  for (const owner of [...owners].reverse()) {
    if (needed.has(owner.name)) for (const dependency of Object.keys(owner.dependencies)) needed.add(dependency);
  }
  return { reports: owners.filter(({ name }) => selected.has(name)), builds: owners.filter(({ name }) => needed.has(name)), settings };
}

function safeRelativePath(path) {
  return !/[:\\\x00-\x1f\x7f]/u.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

function safeOutput(cwd, path, index) {
  if (!safeRelativePath(path) || (index.get(path) ?? []).some(stage => !stage.startsWith('100644 '))) return false;
  const parts = path.split('/');
  let target = cwd;
  for (const [position, part] of parts.entries()) {
    target = resolve(target, part);
    const file = lstatSync(target, { throwIfNoEntry: false });
    if (!file) return true;
    if (position === parts.length - 1) return file.isFile() && (file.mode & 0o111) === 0;
    if (!file.isDirectory()) return false;
  }
  return false;
}

async function trackedIndex(cwd) {
  const index = new Map();
  for (const row of pathsFrom(await git(cwd, 'ls-files', '--stage', '-z'))) {
    const tab = row.indexOf('\t'), path = row.slice(tab + 1);
    if (!index.has(path)) index.set(path, []);
    index.get(path).push(row.slice(0, tab));
  }
  return index;
}

async function trackedBuildState(cwd, outputs) {
  const state = new Map();
  for (const [path, stages] of await trackedIndex(cwd)) {
    if (outputs.has(path)) continue;
    const target = resolve(cwd, path);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    const bytes = stat?.isFile() ? readFileSync(target) : stat?.isSymbolicLink() ? readlinkSync(target, { encoding: 'buffer' }) : undefined;
    state.set(path, [stages, stat?.mode, bytes && createHash('sha256').update(bytes).digest('hex')]);
  }
  return state;
}

export async function runUnselectedBuild(cwd, owner, outputs, build) {
  const before = await trackedBuildState(cwd, outputs);
  await build();
  const after = await trackedBuildState(cwd, outputs);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => !isDeepStrictEqual(before.get(path), after.get(path)));
  if (changed.length) throw new Error(`landing: unselected build ${owner} changed tracked paths: ${changed.join(', ')}`);
}

const INVENTORY_INPUT_PATHS = new Set([
  ...MIGRATION_REGISTRIES,
  INVENTORY_PATH,
  'config/ci-images.json',
  'scripts/ci-image-pull.mjs',
  'scripts/ci-image-mirror.mjs',
  'scripts/platform-migration-manifest.ts',
  'scripts/installation-inventory-refresh.ts',
  'server/adapters/postgres/migrationRunner.ts',
  'server/adapters/postgres/qualifiedInstall.ts',
  'server/adapters/postgres/selectedCatalogProjection.ts',
  'server/adapters/postgres/connectedStoreCapture.ts',
  'tests/helpers/postgresContainer.ts',
]);

export function isInventoryInputPath(path) {
  return INVENTORY_INPUT_PATHS.has(path) ||
    /^(?:db|supabase)\/.*\.sql$/u.test(path) ||
    /^packages\/[^/]+\/sql\//u.test(path) ||
    /^packages\/platform\/src\/migrations\//u.test(path);
}

const MIGRATION_FORWARD = /^(?:db\/platform|supabase)\/migrations\/(?:(?:q2|qa|qb)_)?(\d{14})_[A-Za-z0-9_-]+\.sql$/u;
const MIGRATION_RAILS = ['db/platform/migrations/', 'supabase/migrations/'];

export function nextFreeMigrationSlot(slot) {
  const year = Number(slot.slice(0, 4)), month = Number(slot.slice(4, 6)) - 1, day = Number(slot.slice(6, 8));
  const hour = Number(slot.slice(8, 10)), minute = Number(slot.slice(10, 12)), second = Number(slot.slice(12, 14));
  const date = new Date(Date.UTC(year, month, day, hour, minute + 1, second));
  if (Number.isNaN(date.valueOf())) throw new Error(`landing: invalid migration slot ${slot}`);
  return date.toISOString().replace(/[-:T]/gu, '').slice(0, 14);
}

export function landingSlotPlan(prAddedPaths, mainMigrationPaths) {
  const mainSlots = mainMigrationPaths.map(path => MIGRATION_FORWARD.exec(path)?.[1]).filter(Boolean);
  const maxMainSlot = mainSlots.sort().at(-1) ?? '00000000000000';
  let next = maxMainSlot === '00000000000000' ? '19700101000000' : nextFreeMigrationSlot(maxMainSlot);
  const occupied = new Set(mainMigrationPaths);
  const usedSlots = new Set(mainSlots);
  const additions = prAddedPaths.filter(path => MIGRATION_FORWARD.test(path)).sort();
  for (const path of additions) {
    const slot = MIGRATION_FORWARD.exec(path)[1];
    if (slot > maxMainSlot) usedSlots.add(slot);
  }
  while (usedSlots.has(next)) next = nextFreeMigrationSlot(next);
  const nextFreeSlot = next;
  const changes = [];
  const seen = new Set();
  for (const path of additions) {
    const slot = MIGRATION_FORWARD.exec(path)[1];
    if (slot > maxMainSlot && !occupied.has(path) && !seen.has(slot)) { seen.add(slot); continue; }
    let target;
    do {
      target = path.replace(slot, next);
      next = nextFreeMigrationSlot(next);
    } while (occupied.has(target) || prAddedPaths.includes(target) || usedSlots.has(MIGRATION_FORWARD.exec(target)[1]));
    changes.push({ path, target });
    occupied.add(target);
    usedSlots.add(MIGRATION_FORWARD.exec(target)[1]);
  }
  return { maxMainSlot, nextFreeSlot, changes };
}

export function assertAppendOnlyLandingSlots(prAddedPaths, mainMigrationPaths) {
  const plan = landingSlotPlan(prAddedPaths, mainMigrationPaths);
  if (plan.changes.length) throw new Error(`landing: migration slot is not strictly later than origin/main: ${plan.changes[0].path}; maxMainSlot ${plan.maxMainSlot}; nextFreeSlot ${plan.nextFreeSlot}; run npm run landing:merge -- --re-slot`);
}

const RESLOT_REGISTRIES = new Set([...REGISTRY_PATHS, ...MIGRATION_REGISTRIES, INVENTORY_PATH]);
export async function assertNoAuthoredSlotReferences(cwd, base, head, changes) {
  const paths = pathsFrom(await git(cwd, 'diff', '--name-only', '--no-renames', '-z', base, head));
  const hits = [];
  for (const path of paths) {
    if (RESLOT_REGISTRIES.has(path) || generatedCarrier(path)) continue;
    let content;
    try { content = await git(cwd, 'show', `${head}:${path}`); }
    catch (error) { if (error.code === 128) continue; throw error; }
    for (const [index, line] of content.split('\n').entries()) {
      if (changes.some(({ path: oldPath }) => oldPath !== path && line.includes(oldPath.split('/').at(-1)))) hits.push(`${path}:${index + 1}`);
    }
  }
  if (hits.length) throw new Error(`landing: --re-slot refuses authored migration references: ${hits.join(', ')}`);
}

function reslotRegistryContents(cwd, path, source, changes, remapPaths = true) {
  const targets = new Set(changes.map(({ target }) => target));
  const replace = (value, reorderRows = true) => {
    if (typeof value === 'string') return changes.reduce((text, { path, target }) => text === path ? target : text, value);
    if (Array.isArray(value)) {
      const items = value.map(item => replace(item, reorderRows));
      if (!reorderRows) return items;
      const key = entry => entry && typeof entry === 'object' ? entry.file ?? entry.path : undefined;
      const order = entry => MIGRATION_FORWARD.exec(key(entry) ?? '')?.[1] ?? key(entry);
      const moved = items.filter(entry => targets.has(key(entry)));
      if (!moved.length) return items;
      const ordered = items.filter(entry => !targets.has(key(entry)));
      for (const entry of moved.sort((left, right) => order(left) < order(right) ? -1 : order(left) > order(right) ? 1 : 0)) {
        const index = ordered.findIndex(other => typeof order(other) === 'string' && order(other) > order(entry));
        ordered.splice(index < 0 ? ordered.length : index, 0, entry);
      }
      return ordered;
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item, reorderRows)]));
    return value;
  };
    const updated = remapPaths ? replace(JSON.parse(source), path !== PUBLICATION_CATALOGUE) : JSON.parse(source);
    if (path === PUBLICATION_CATALOGUE) updated.publicPaths.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    if (path === 'config/reviewed-platform-forwards.json') {
      const directory = 'supabase/migrations/';
      const sql = readdirSync(resolve(cwd, directory)).filter(name => name.endsWith('.sql'))
        .map(name => `${directory}${name}`).sort();
      for (const pin of updated.managedExactForwards ?? []) {
        if (!changes.some(({ path: oldPath, target }) => oldPath.startsWith(directory) && (pin.path >= target || pin.path >= oldPath))) continue;
        const prefix = sql.filter(name => name < pin.path).map(name =>
          [name, createHash('sha256').update(readFileSync(resolve(cwd, name))).digest('hex')]);
        pin.prefixSha256 = createHash('sha256').update(JSON.stringify(prefix)).digest('hex');
      }
    }
    return `${JSON.stringify(updated, null, 2)}\n`;
}

export function applyMigrationReslot(cwd, changes, moveFiles = true, remapPaths = true) {
  if (moveFiles) for (const { path, target } of changes) {
    renameSync(resolve(cwd, path), resolve(cwd, target));
    if (path.startsWith('db/platform/migrations/')) {
      const mirror = resolve(cwd, `packages/platform/sql/${path.split('/').at(-1)}`);
      if (existsSync(mirror)) unlinkSync(mirror);
    }
  }
  for (const path of [...MIGRATION_REGISTRIES, PUBLICATION_CATALOGUE]) {
    const file = resolve(cwd, path);
    writeFileSync(file, reslotRegistryContents(cwd, path, readFileSync(file, 'utf8'), changes, remapPaths));
  }
}

export async function landingMerge(cwd = process.cwd(), { runCommand, reSlot = false } = {}) {
  return runLanding(cwd, runCommand, {}, reSlot);
}

async function runLanding(cwd, runCommand, diagnostics, reSlot) {
  const mergeState = await landingPreflight(cwd);
  for (const key of ['user.name', 'user.email']) {
    let configured;
    try { configured = (await git(cwd, 'config', '--get', key)).trim(); }
    catch (error) { if (error.code !== 1) throw error; }
    if (!configured) throw new Error(`landing: configure Git ${key} before making a personal DCO sign-off`);
  }
  const head = (await git(cwd, 'rev-parse', 'HEAD')).trim();
  const main = (await git(cwd, 'rev-parse', 'origin/main')).trim();
  const base = (await git(cwd, 'merge-base', head, main)).trim();
  if (head === main) throw new Error('landing: already at origin/main');
  const prAdded = pathsFrom(await git(cwd, 'diff', '--name-only', '--diff-filter=A', '--no-renames', '-z', base, head));
  let slotChanges = [];
  let mainMigrations = [];
  if (prAdded.some(path => MIGRATION_RAILS.some(rail => path.startsWith(rail)))) {
    // Skip migrations already present byte-for-byte identically on origin/main (stacked PRs whose predecessor squash-merged).
    const differingFromMain = new Set(pathsFrom(await git(cwd, 'diff', '--name-only', '--no-renames', '-z', main, head, '--', 'db/platform/migrations', 'supabase/migrations')));
    const netAdded = prAdded.filter(path => differingFromMain.has(path));
    if (netAdded.length > 0) {
      mainMigrations = pathsFrom(await git(cwd, 'ls-tree', '-r', '--name-only', '-z', main, '--', 'db/platform/migrations', 'supabase/migrations'));
      const plan = landingSlotPlan(netAdded, mainMigrations);
      if (plan.changes.length && !reSlot) assertAppendOnlyLandingSlots(netAdded, mainMigrations);
      slotChanges = plan.changes;
      if (slotChanges.length) await assertNoAuthoredSlotReferences(cwd, base, head, slotChanges);
    }
  }
  const carrierEnv = { ...processEnvironment, ...carrierLocale };
  const run = runCommand ?? ((command, args, options) => execFileSync(command, args, { cwd, stdio: 'inherit', timeout: 900000, ...options }));
  checkLandingToolchain(run, carrierEnv);
  return mergeWithRollback(cwd, { head, main, base, run, carrierEnv, diagnostics, slotChanges, mainMigrations, ...mergeState });
}

async function reconcileReslotMirror(cwd, { mirror, targetMirror, head, main, collision, writes, stagedReslot }) {
  for (const candidate of [mirror, targetMirror]) {
    if (lstatSync(resolve(cwd, candidate), { throwIfNoEntry: false }) &&
        !(await git(cwd, '--literal-pathspecs', 'ls-files', '--', candidate))) {
      throw new Error(`landing: re-slot refuses to overwrite untracked mirror: ${candidate}`);
    }
  }
  let ignored;
  try { ignored = await git(cwd, 'check-ignore', '--', targetMirror); }
  catch (error) { if (error.code !== 1) throw error; }
  if (ignored) throw new Error(`landing: re-slot destination mirror is ignored: ${targetMirror}`);
  const tracked = async revision => (await git(cwd, '--literal-pathspecs', 'ls-tree', revision, '--', mirror)).trim();
  const [onHead, onMain] = await Promise.all([tracked(head), tracked(main)]);
  if (!(collision && onMain) && !(onHead && !onMain)) return;
  writes.paths.add(mirror);
  stagedReslot.add(mirror);
  if (onMain) writeFileSync(resolve(cwd, mirror), await git(cwd, 'show', `${main}:${mirror}`));
  else if (existsSync(resolve(cwd, mirror))) unlinkSync(resolve(cwd, mirror));
}

async function landMergedCheckout(cwd, { head, main, base, run, carrierEnv, diagnostics, writes, slotChanges, mainMigrations }) {
  if ((await git(cwd, 'rev-parse', '--verify', 'MERGE_HEAD')).trim() !== main) throw new Error('landing: exact main merge required');
  if (slotChanges.length) {
    const unresolved = new Set(pathsFrom(await git(cwd, 'diff', '--name-only', '--diff-filter=U', '-z')));
    const stagedReslot = new Set();
    for (const { path, target } of slotChanges) {
      if (lstatSync(resolve(cwd, target), { throwIfNoEntry: false })) throw new Error(`landing: re-slot destination already exists: ${target}`);
      const collision = mainMigrations.includes(path);
      if (collision && unresolved.has(path)) await git(cwd, 'checkout', '--ours', '--', path);
      writes.paths.add(path);
      writes.paths.add(target);
      stagedReslot.add(path);
      stagedReslot.add(target);
      renameSync(resolve(cwd, path), resolve(cwd, target));
      if (collision) await git(cwd, 'checkout', '--theirs', '--', path);
      if (path.startsWith('db/platform/migrations/')) {
        const mirror = `packages/platform/sql/${path.split('/').at(-1)}`;
        const targetMirror = `packages/platform/sql/${target.split('/').at(-1)}`;
        await reconcileReslotMirror(cwd, { mirror, targetMirror, head, main, collision, writes, stagedReslot });
      }
    }
    await git(cwd, '--literal-pathspecs', 'add', '-A', '--', ...stagedReslot);
  }
  const conflicts = pathsFrom(await git(cwd, 'diff', '--name-only', '--diff-filter=U', '-z'));
  const read = (revision, path) => git(cwd, 'show', `${revision}:${path}`);
  const reslotsCatalogue = slotChanges.some(({ path }) => path.startsWith('supabase/migrations/'));
  const reslottedHead = new Map();
  for (const path of [...MIGRATION_REGISTRIES, ...(reslotsCatalogue ? [PUBLICATION_CATALOGUE] : [])]) {
    if (slotChanges.length) reslottedHead.set(path, reslotRegistryContents(cwd, path, await read(head, path), slotChanges));
  }
  const registryConflicts = conflicts.filter(path => REGISTRY_PATHS.includes(path));
  if (registryConflicts.length && (await git(cwd, 'merge-base', '--all', head, main)).trim() !== base) {
    refuseAuthoredConflicts(registryConflicts);
  }
  const readUnion = async path => registryUnion(path, await read(base, path), reslottedHead.get(path) ?? await read(head, path), await read(main, path));
  const index = await trackedIndex(cwd);
  const legacyConflict = path => [...REGISTRY_PATHS, ...MIGRATION_REGISTRIES, INVENTORY_PATH].includes(path) ||
    (generatedCarrier(path) && !path.endsWith('.sql') && !/^packages\/[^/]+\/api\/[^/]+\.api\.md$/u.test(path));
  const authoredInputs = conflicts.filter(path => /^(?:config\/openlup-packages\.json|packages\/[^/]+\/(?:package|release-gates)\.json)$/u.test(path));
  refuseAuthoredConflicts(authoredInputs);
  const catalogueUnion = conflicts.includes(PUBLICATION_CATALOGUE) || reslotsCatalogue ? await readUnion(PUBLICATION_CATALOGUE) : undefined;
  const catalogue = catalogueUnion === undefined ? readJson(cwd, PUBLICATION_CATALOGUE) : JSON.parse(catalogueUnion);
  const owners = readReportOwners(cwd);
  const { admitted, replaceable } = ownerOutputs(owners, catalogue.publicPaths);
  const other = conflicts.filter(path => !legacyConflict(path) && !(replaceable.has(path) && safeOutput(cwd, path, index)));
  refuseAuthoredConflicts(other);
  const mergedModule = path => JSON.stringify(pathToFileURL(resolve(cwd, path)).href);
  const generators = mergedModule('scripts/agent-review-generators.mjs');
  // Load the merged owners in a fresh process, including the early authored-conflict check.
  const runGenerators = (script, input = '') => {
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', `import { readFileSync } from 'node:fs';
        const owners = await import(${generators});
        try { ${script} } catch (error) { console.error(error.message); process.exitCode = 1; }`],
      { cwd, input, encoding: 'utf8', stdio: ['pipe', 'inherit', 'pipe'], timeout: 900000, env: carrierEnv });
    } catch (error) { throw new Error(error.stderr?.trim() || error.message, { cause: error }); }
  };
  const prPaths = pathsFrom(await git(cwd, 'diff', '--name-only', '--no-renames', '-z', base, head));
  const needsInventoryRefresh = prPaths.some(isInventoryInputPath) || conflicts.some(isInventoryInputPath);
  const inputs = [...prPaths, ...conflicts];
  // Resolve envelopes before any generator or database work; historical conflict stops.
  const inventories = await Promise.all([base, head, main].map(revision => read(revision, INVENTORY_PATH)));
  const envelopes = inventories.map(inventoryEnvelope);
  if (needsInventoryRefresh && !envelopes.every(value => value.before === envelopes[0].before && value.after === envelopes[0].after)) throw new Error('landing: historical inventory conflict');
  // Main can change the requirements after the initial checkout passes validation.
  await checkMergedLandingToolchain(cwd, head, run, carrierEnv, diagnostics);
  if (needsInventoryRefresh) await assertCarrierBuildOutputs(cwd, DEFAULT_INCREMENTAL_PACKAGES, true);
  const preliminary = carrierPlan(owners, inputs);
  if (preliminary.builds.length) {
    await assertCarrierBuildOutputs(cwd, preliminary.builds.map(({ directory }) => directory));
  }
  if (conflicts.includes(SQL_REFERENCE)) checkLandingSqlReference(runGenerators);
  for (const path of new Set([...registryConflicts, ...(reslotsCatalogue ? [PUBLICATION_CATALOGUE] : [])])) {
    writes.paths.add(path);
    writeFileSync(resolve(cwd, path), path === PUBLICATION_CATALOGUE ? catalogueUnion : await readUnion(path));
    await git(cwd, 'add', '--', path);
  }
  // Keep Git's merged prose in the SQL reference; discard conflicts in other generated carriers.
  for (const path of conflicts.filter(path => generatedCarrier(path) && (legacyConflict(path) || (replaceable.has(path) && safeOutput(cwd, path, index))))) {
    if (path !== SQL_REFERENCE && !REGISTRY_PATHS.includes(path)) await git(cwd, 'checkout', '--ours', '--', path);
  }
  writes.paths.add(INVENTORY_PATH);
  if (needsInventoryRefresh) {
    writeFileSync(resolve(cwd, INVENTORY_PATH), inventories[1]);
    for (const path of MIGRATION_REGISTRIES) {
      const inputs = await Promise.all([base, head, main].map(revision => read(revision, path)));
      if (reslottedHead.has(path)) inputs[1] = reslottedHead.get(path);
      writes.paths.add(path);
      writeFileSync(resolve(cwd, path), migrationRegistryUnion(path, ...inputs, inventories[1]));
      await git(cwd, 'add', '--', path);
    }
    // Owners load from the merged tree; this process still holds pre-merge modules.
    run(process.execPath, [resolve(cwd, BUILD_SCRIPT)], { env: carrierEnv });
    run(process.execPath, ['--import', 'tsx', resolve(cwd, 'scripts/installation-inventory-refresh.ts')]);
    const inventory = readFileSync(resolve(cwd, INVENTORY_PATH), 'utf8');
    for (const path of MIGRATION_REGISTRIES) {
      const inputs = await Promise.all([base, head, main].map(revision => read(revision, path)));
      if (reslottedHead.has(path)) inputs[1] = reslottedHead.get(path);
      writeFileSync(resolve(cwd, path), migrationRegistryUnion(path, ...inputs, inventory));
    }
    if (slotChanges.length) applyMigrationReslot(cwd, slotChanges, false, false);
  } else {
    writeFileSync(resolve(cwd, INVENTORY_PATH), inventories[2]);
  }
  const projection = 'packages/platform/src/migrations/catalog.ts';
  const projectionBefore = readFileSync(resolve(cwd, projection), 'utf8');
  // Only the migration projection feeds compilation. Validate selectors after the reports exist.
  writes.generated = true;
  runGenerators(`const { checkPlatformMigrationProjection } = await import(${mergedModule('scripts/packages/platform-migration-projection.ts')});
    const errors = checkPlatformMigrationProjection(process.cwd(), true);
    if (errors.length) throw new Error(errors.join('; '));`);
  if (readFileSync(resolve(cwd, projection), 'utf8') !== projectionBefore) inputs.push(projection);
  const { reports, builds, settings } = carrierPlan(owners, inputs);
  const outputs = [...new Set([...reports.flatMap(owner => owner.reports), ...(settings ? SETTINGS_OUTPUTS : [])])];
  if (outputs.length) {
    for (const path of outputs) {
      if (!admitted.has(path)) throw new Error(`landing: ${path} needs a reviewed public-output classification in ${PUBLICATION_CATALOGUE}`);
      if (!safeOutput(cwd, path, index)) throw new Error(`landing: ${path} must be a regular non-executable owner output`);
    }
    const extraBuilds = builds.filter(owner => !preliminary.builds.includes(owner));
    if (extraBuilds.length) await assertCarrierBuildOutputs(cwd, extraBuilds.map(({ directory }) => directory));
    const npmCli = carrierNpmCli();
    const selectedOutputs = new Set(outputs);
    for (const path of selectedOutputs) writes.paths.add(path);
    for (const owner of builds) {
      const build = () => run(process.execPath, [npmCli, 'run', 'build', `--workspace=${owner.name}`], { env: carrierEnv });
      if (reports.includes(owner)) build();
      else await runUnselectedBuild(cwd, owner.name, selectedOutputs, build);
    }
    for (const { directory, name } of reports) {
      const mergeContext = name === '@openlup/platform' ? [] : [`--landing=${head},${main}`];
      run(process.execPath, [resolve(cwd, directory, 'scripts/api-contract.ts'), '--update', ...mergeContext], { env: carrierEnv });
    }
    if (settings) run(process.execPath, [resolve(cwd, 'scripts/settings-catalogue.ts'), '--write'], { env: carrierEnv });
  }
  const tracked = pathsFrom(await git(cwd, 'ls-files', '-z'));
  const generated = pathsFrom(await git(cwd, 'ls-files', '--others', '--exclude-standard', '-z'))
    .filter(path => generatedCarrier(path) || outputs.includes(path));
  const paths = [...new Set([...tracked, ...generated])];
  runGenerators("owners.runLandingGenerators(process.cwd(), readFileSync(0, 'utf8').split('\\0').filter(Boolean));", paths.join('\0'));
  const staged = [...new Set([...MIGRATION_REGISTRIES, INVENTORY_PATH, ...paths.filter(generatedCarrier), ...outputs])];
  await git(cwd, '--literal-pathspecs', 'add', '--', ...staged);
  if ((await git(cwd, 'diff', '--name-only', '--diff-filter=U')).trim()) throw new LandingConflict('landing: unresolved conflicts remain');
  await git(cwd, 'commit', '-s', '-m', 'Merge origin/main and refresh derived carriers');
  return needsInventoryRefresh;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runLandingCli();
