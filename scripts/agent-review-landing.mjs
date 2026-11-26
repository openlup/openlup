// Local landing helper: merge main, stop on authored conflicts, never push.
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { git as ordinaryGit } from './agent-review-session.mjs';
import { REGISTRY_PATHS, SHARD_WEIGHTS_PATH, registryUnion } from './agent-review-registry.mjs';
import { INVENTORY_PATH, MIGRATION_REGISTRIES, inventoryEnvelope, migrationRegistryUnion } from './agent-review-derived.mjs';
import * as carrierGenerators from './agent-review-generators.mjs';
import { DEFAULT_INCREMENTAL_PACKAGES, TSBUILDINFO_FILENAME } from './build-packages-incremental.mjs';
import { MIGRATION_RAILS, migrationIdentity, planMigrationSlots } from './migration-slots.mjs';
export { nextFreeMigrationSlot } from './migration-slots.mjs';
import { resolveResourceGateInvocation } from './resource-gate.mjs';
import { documentationGit } from './documentation-routing.ts';
import { isGuidePage } from './oss-publication-policy.ts';

const finalizationEnvironment = new AsyncLocalStorage();
const execGit = promisify(execFile);
async function git(cwd, ...args) {
  const env = finalizationEnvironment.getStore();
  if (!env) return ordinaryGit(cwd, ...args);
  const result = await execGit('git', ['--no-replace-objects', '-C', cwd, '-c', 'core.fsmonitor=false',
    '-c', 'merge.renames=false', '-c', 'merge.directoryRenames=false', '-c', 'merge.conflictStyle=merge', ...args],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env });
  return result.stdout;
}

const { generatedCarrier, ownerOutputCarrier, MATURITY_REFERENCE, SQL_REFERENCE } = carrierGenerators;
const PUBLICATION_CATALOGUE = REGISTRY_PATHS[0];
const SETTINGS_GUIDE = 'packages/core/docs/guide/how-to/operate/settings-catalogue.md';
const SETTINGS_OUTPUTS = ['packages/platform/settings-catalog.json', 'packages/platform/settings-refusals.json', SETTINGS_GUIDE];
const BUILD_SCRIPT = 'scripts/build-packages-incremental.mjs';
const TYPECHECK_SCRIPT = 'scripts/oss-published-tree-check.ts';
export function landingGitDirectory(cwd) {
  const root = realpathSync(documentationGit(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trimEnd());
  if (root !== realpathSync(cwd)) throw new Error('landing: use the dedicated worktree root');
  const gitDir = realpathSync(documentationGit(cwd, ['rev-parse', '--absolute-git-dir']).toString('utf8').trimEnd());
  const directory = lstatSync(gitDir);
  if (!directory.isDirectory() || (directory.mode & 0o022) !== 0 ||
      (process.getuid && directory.uid !== process.getuid())) {
    throw new Error('landing: worktree Git metadata must be owned and writable only by the current user');
  }
  return gitDir;
}
export const isolatedInventoryDirectory = cwd =>
  resolve(landingGitDirectory(cwd), 'openlup-finalization-inventory');
export function isolatedInventoryFile(cwd) {
  const scratch = isolatedInventoryDirectory(cwd);
  const directory = lstatSync(scratch, { throwIfNoEntry: false });
  if (!directory?.isDirectory() || (directory.mode & 0o777) !== 0o700 ||
      (process.getuid && directory.uid !== process.getuid())) {
    throw new Error('landing: isolated inventory requires the private worktree scratch directory');
  }
  return resolve(scratch, 'inventory.json');
}

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

async function abortLanding(cwd, { head, hasMerge, ignored, diagnostics, writes, finalizing, bystanders, captureBystanders }, error) {
  const cleanupFailures = [];
  const attempt = async action => {
    try { return await action(); }
    catch (failure) { cleanupFailures.push(failure); }
  };
  const active = await attempt(hasMerge);
  if (captureBystanders) await attempt(() => captureBystanders(active));
  const owned = path => bystanders?.get(path)?.owned || writes.paths.has(path) ||
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
  if (finalizing && !active) await attempt(async () => {
    const modified = pathsFrom(await git(cwd, 'diff', 'HEAD', '--name-only', '--no-renames', '-z')).filter(owned);
    if (modified.length) await git(cwd, '--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...modified);
  });
  if (bystanders?.size) await attempt(async () => {
    for (const [path, { entry, bytes, link, mode }] of bystanders) {
      if (entry) await git(cwd, 'update-index', '--add', '--cacheinfo', `${entry.mode},${entry.blobOid},${path}`);
      else await git(cwd, 'update-index', '--force-remove', '--', path);
      const file = resolve(cwd, path);
      if (bytes) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes, { mode });
        if (bystanders.get(path).owned) chmodSync(file, mode & 0o777);
      } else if (link !== undefined) {
        if (lstatSync(file, { throwIfNoEntry: false })) unlinkSync(file);
        symlinkSync(link, file);
      } else if (mode === undefined && lstatSync(file, { throwIfNoEntry: false })) unlinkSync(file);
    }
  });
  await attempt(async () => {
    const actualHead = (await git(cwd, 'rev-parse', 'HEAD')).trim();
    const merging = hasMerge();
    const status = bystanders?.size
      ? pathsFrom(await git(cwd, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all', '--no-renames', '-z'))
        .filter(row => !bystanders.has(row.slice(3))).join('\n')
      : (await checkoutStatus(cwd)).trimEnd();
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
  const { head, main, base, diagnostics, finalization } = context;
  const ignored = new Set(pathsFrom(await git(cwd, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z')));
  requireNoMerge();
  const writes = { paths: new Set(), generated: false };
  let inventoryRefreshed;
  try {
    const merge = async () => {
      try { await git(cwd, '-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '--no-commit', '--no-overwrite-ignore', main); }
      catch (error) { if (error.code !== 1 || !hasMerge()) throw error; }
    };
    if (!finalization) await merge();
    else if (base !== main) await finalization.guard({ files: finalization.mergePaths, index: finalization.mergePaths }, merge);
    inventoryRefreshed = await landMergedCheckout(cwd, { ...context, writes });
  } catch (error) {
    if (finalization?.committedHead) {
      throw new Error(`landing: finalized ${finalization.committedHead}, but merge-state cleanup failed; run git merge --quit on the finalized checkout`, { cause: error });
    }
    if (error instanceof LandingConflict && !finalization) throw error;
    return abortLanding(cwd, { head, hasMerge, ignored, diagnostics, writes, finalizing: Boolean(finalization), bystanders: finalization?.bystanders, captureBystanders: finalization?.captureBystanders }, error);
  }
  return { head: (await git(cwd, 'rev-parse', 'HEAD')).trim(), main, inventoryRefreshed };
}

async function checkMergedLandingToolchain(cwd, head, run, carrierEnv, diagnostics) {
  const toolchainInputs = ['.nvmrc', '.npmrc', 'package.json', 'package-lock.json', 'config/openlup-packages.json', 'scripts/agent-review-landing.mjs',
    ...DEFAULT_INCREMENTAL_PACKAGES.map(directory => `${directory}/package.json`)];
  if (await git(cwd, '--literal-pathspecs', 'diff', '--name-only', '-z', head, '--', ...toolchainInputs)) {
    const install = [process.execPath, carrierNpmCli(), 'ci'];
    const gated = resolveResourceGateInvocation({
      cwd,
      profile: 'openlup:landing-build',
      command: install[0],
      args: install.slice(1),
      env: carrierEnv,
    });
    const [command, ...args] = gated ? [gated.command, ...gated.args] : install;
    run(command, args, { env: carrierEnv });
    try { checkLandingToolchain(run, carrierEnv, true); }
    catch (error) {
      diagnostics.toolchain = `OPENLUP_E_LANDING_TOOLCHAIN: ${commandDiagnostic(error)}\nafter npm ci from the merged lock`;
      throw error;
    }
  }
}

function verifyMergedLanding(cwd, run, carrierEnv, committedHead) {
  try {
    run(process.execPath, [resolve(cwd, BUILD_SCRIPT)], { env: carrierEnv });
    run(process.execPath, ['--experimental-strip-types', resolve(cwd, TYPECHECK_SCRIPT), '--typecheck'], { env: carrierEnv });
  } catch (error) {
    throw new Error(
      `OPENLUP_E_LANDING_VERIFY_FAILED: merge commit ${committedHead} was preserved (not rolled back), ${commandDiagnostic(error)}`,
      { cause: error },
    );
  }
}

// A conflict inside the maturity reference's generated regions is resolved by regenerating them; one in its prose is authored.
function checkLandingMaturityReference(runGenerators) {
  try { runGenerators('owners.syncMaturityReference(process.cwd());'); }
  catch (error) {
    if (error.message !== `landing: authored conflicts remain: ${MATURITY_REFERENCE}`) throw error;
    refuseAuthoredConflicts([MATURITY_REFERENCE]);
  }
}

function checkLandingSqlReference(runGenerators) {
  try { runGenerators('owners.syncSqlReference(process.cwd());'); }
  catch (error) {
    if (error.message !== `landing: authored conflicts remain: ${SQL_REFERENCE}`) throw error;
    refuseAuthoredConflicts([SQL_REFERENCE]);
  }
}

export function parseLandingCliOptions(argv = []) {
  return {
    reSlot: argv.includes('--re-slot'),
    verify: !argv.includes('--no-verify'),
  };
}

function runLandingCli() {
  const diagnostics = {};
  const { reSlot, verify } = parseLandingCliOptions(process.argv.slice(2));
  runLanding(process.cwd(), undefined, diagnostics, reSlot, verify).then(result => console.log(JSON.stringify(result))).catch(error => {
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
  const admitted = new Set([...registered, ...[SETTINGS_GUIDE, MATURITY_REFERENCE].filter(isGuidePage)]);
  return { admitted, replaceable: new Set([...owners.flatMap(owner => owner.reports), ...SETTINGS_OUTPUTS, MATURITY_REFERENCE].filter(path => admitted.has(path))) };
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
  // The maturity reference is read from the API reports: any owner whose reports are regenerated can change it.
  const maturity = selected.size > 0 || paths.includes(MATURITY_REFERENCE);
  return { reports: owners.filter(({ name }) => selected.has(name)), builds: owners.filter(({ name }) => needed.has(name)), settings, maturity };
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
    /^packages\/platform\/src\/migrations\//u.test(path) ||
    /^server\/adapters\/postgres\/connectedStoreDomains\//u.test(path);
}

export function landingSlotPlan(prAddedPaths, mainMigrationPaths) {
  const { floor, moves, next } = planMigrationSlots(prAddedPaths, mainMigrationPaths);
  const changes = moves.filter(move => move.sourcePath !== move.targetPath)
    .map(move => ({ path: move.sourcePath, target: move.targetPath }));
  return { maxMainSlot: floor, nextFreeSlot: changes.length ? migrationIdentity(changes[0].target).version : moves.length ? moves.at(-1).targetVersion : next(), changes };
}

export function assertAppendOnlyLandingSlots(prAddedPaths, mainMigrationPaths) {
  const plan = landingSlotPlan(prAddedPaths, mainMigrationPaths);
  if (plan.changes.length) throw new Error(`landing: migration slot is not strictly later than origin/main: ${plan.changes[0].path}; maxMainSlot ${plan.maxMainSlot}; nextFreeSlot ${plan.nextFreeSlot}; run npm run landing:merge -- --re-slot`);
}

const RESLOT_REGISTRIES = new Set([...REGISTRY_PATHS, ...MIGRATION_REGISTRIES, INVENTORY_PATH]);
export async function assertNoAuthoredSlotReferences(cwd, base, head, changes) {
  if (!changes.length) return;
  const read = path => documentationGit(cwd, ['show', `${head}:${path}`]).toString('utf8');
  const paths = pathsFrom(documentationGit(cwd, ['diff', '--name-only', '--diff-filter=AMT', '--no-renames', '-z', base, head]).toString('utf8'));
  const packageManifest = 'packages/platform/sql/manifest.json';
  const projected = new Set(JSON.parse(read(packageManifest)).migrations.map(({ file }) => `packages/platform/sql/${file}`));
  const hits = [];
  const references = changes.map(({ path }) => {
    const version = migrationIdentity(path)?.version;
    return { basename: path.split('/').at(-1), version, bare: new RegExp(`(?<![0-9])${version}(?![0-9])`, 'u') };
  });
  for (const path of paths) {
    if (RESLOT_REGISTRIES.has(path) || (path !== SQL_REFERENCE && generatedCarrier(path) &&
        (!path.endsWith('.sql') || projected.has(path)))) continue;
    let content = read(path);
    if (path === SQL_REFERENCE) {
      content = content.replace(/<!-- generated:(sql:[a-z]+) -->\n[\s\S]*?<!-- \/generated:\1 -->/gu, region => region.replace(/[^\n]/gu, ''));
    }
    for (const [index, line] of content.split('\n').entries()) {
      const match = references.find(({ basename, bare }) => line.includes(basename) || bare.test(line));
      if (match) hits.push(`${path}:${index + 1} (${match.version})`);
    }
  }
  if (hits.length) throw new Error(`landing: --re-slot refuses authored migration references: ${hits.join(', ')}`);
}

export function reslotRegistryContents(cwd, path, source, changes, remapPaths = true, refreshManagedPrefix = true) {
  const targets = new Set(changes.map(({ target }) => target));
  const replace = (value, reorderRows = true) => {
    if (typeof value === 'string') return changes.reduce((text, { path, target }) => text === path ? target : text, value);
    if (Array.isArray(value)) {
      const items = value.map(item => replace(item, reorderRows));
      if (!reorderRows) return items;
      const key = entry => entry && typeof entry === 'object' ? entry.file ?? entry.path : undefined;
      const order = entry => migrationIdentity(key(entry) ?? '')?.version ?? key(entry);
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
    if (refreshManagedPrefix && path === 'config/reviewed-platform-forwards.json') {
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

export function fillDraftManifest(source, moves, sourceBytes) {
  const draft = JSON.parse(source);
  for (const plan of [draft, draft.qualified, draft.qualifiedAdmin]) {
    for (const move of moves) {
      if (!move.sourcePath.startsWith(MIGRATION_RAILS[0]) || plan.forward.some(({ file }) => file === move.sourcePath)) continue;
      const sha256 = createHash('sha256').update(sourceBytes(move)).digest('hex');
      const index = plan.forward.findIndex(({ file }) => file > move.sourcePath && moves.some(({ sourcePath }) => sourcePath === file));
      plan.forward.splice(index < 0 ? plan.forward.length : index, 0, { file: move.sourcePath, sha256 });
    }
  }
  return JSON.stringify(draft);
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

export async function landingMerge(cwd = process.cwd(), { runCommand, reSlot = false, verify = false } = {}) {
  return runLanding(cwd, runCommand, {}, reSlot, verify);
}

export async function finalizeLanding(cwd, { head, main, base, ref, moves, checkpoint, guard, trackOwned, mergePaths, verifyIndex, sourceBytes, runCommand, bystanders, captureBystanders }) {
  const attribution = /^(?:GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE)|GIT_(?:ASKPASS|TERMINAL_PROMPT))$/u;
  const env = Object.fromEntries(Object.entries(processEnvironment).filter(([key]) => !key.startsWith('GIT_') || attribution.test(key)));
  const carrierEnv = { ...env, ...carrierLocale };
  return finalizationEnvironment.run(carrierEnv, async () => {
    const mergeState = await landingPreflight(cwd);
    const run = runCommand ?? ((command, args, options) => execFileSync(command, args, {
      cwd, stdio: 'inherit', timeout: 900000, env: carrierEnv, ...options,
    }));
    const slotChanges = moves.filter(({ sourcePath, targetPath }) => sourcePath !== targetPath)
      .map(({ sourcePath, targetPath }) => ({ path: sourcePath, target: targetPath }));
    const mainMigrations = pathsFrom(await git(cwd, 'ls-tree', '-r', '--name-only', '-z', main, '--', ...MIGRATION_RAILS));
    await guard({}, () => checkLandingToolchain(run, carrierEnv));
    await checkpoint();
    return mergeWithRollback(cwd, { head, main, base, run, carrierEnv, diagnostics: {}, slotChanges,
      mainMigrations, finalization: { ref, moves, checkpoint, guard, trackOwned, mergePaths, verifyIndex, sourceBytes, bystanders, captureBystanders }, ...mergeState });
  });
}

async function runLanding(cwd, runCommand, diagnostics, reSlot, verify = false) {
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
  const landed = await mergeWithRollback(cwd, { head, main, base, run, carrierEnv, diagnostics, slotChanges, mainMigrations, ...mergeState });
  if (!verify) return landed;
  verifyMergedLanding(cwd, run, carrierEnv, landed.head);
  return { ...landed, verified: true };
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
  if (onMain) writeFileSync(resolve(cwd, mirror), documentationGit(cwd, ['show', `${main}:${mirror}`]));
  else if (existsSync(resolve(cwd, mirror))) unlinkSync(resolve(cwd, mirror));
}

async function landMergedCheckout(cwd, { head, main, base, run, carrierEnv, diagnostics, writes, slotChanges, mainMigrations, finalization }) {
  if ((!finalization || base !== main) && (await git(cwd, 'rev-parse', '--verify', 'MERGE_HEAD')).trim() !== main) throw new Error('landing: exact main merge required');
  await finalization?.checkpoint();
  const guarded = (changes, action) => finalization ? finalization.guard(changes, action) : action();
  if (finalization) {
    const conflicts = pathsFrom(await git(cwd, 'diff', '--name-only', '--diff-filter=U', '-z'));
    const sql = slotChanges.flatMap(({ path }) => [path, `packages/platform/sql/${path.split('/').at(-1)}`]);
    refuseAuthoredConflicts(conflicts.filter(path => !sql.includes(path) &&
      ![...MIGRATION_REGISTRIES, ...REGISTRY_PATHS, INVENTORY_PATH, SQL_REFERENCE, 'packages/platform/sql/manifest.json'].includes(path)));
  }
  if (slotChanges.length) {
    const affected = slotChanges.flatMap(({ path, target }) => [path, target,
      ...(path.startsWith(MIGRATION_RAILS[0]) ? [path, target].map(sql => `packages/platform/sql/${sql.split('/').at(-1)}`) : [])]);
    await guarded({ files: affected, index: affected }, async () => {
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
    });
  }
  const conflicts = pathsFrom(await git(cwd, 'diff', '--name-only', '--diff-filter=U', '-z'));
  const read = (revision, path) => git(cwd, 'show', `${revision}:${path}`);
  const reslotsCatalogue = slotChanges.some(({ path }) => path.startsWith('supabase/migrations/'));
  const reslottedHead = new Map();
  for (const path of [...MIGRATION_REGISTRIES, ...(reslotsCatalogue ? [PUBLICATION_CATALOGUE] : [])]) {
    const fillsDraftManifest = finalization && path === MIGRATION_REGISTRIES[0];
    if (!slotChanges.length && !fillsDraftManifest) continue;
    const source = await read(head, path);
    const contents = fillsDraftManifest
      ? fillDraftManifest(source, finalization.moves, finalization.sourceBytes)
      : source;
    reslottedHead.set(path, reslotRegistryContents(cwd, path, contents, slotChanges, true, !finalization));
  }
  const registryConflicts = conflicts.filter(path => REGISTRY_PATHS.includes(path));
  if (registryConflicts.length && (await git(cwd, 'merge-base', '--all', head, main)).trim() !== base) {
    refuseAuthoredConflicts(registryConflicts);
  }
  const readUnion = async path => registryUnion(path, await read(base, path), reslottedHead.get(path) ?? await read(head, path), await read(main, path));
  // A refused shard-weights union stays an authored conflict: a branch edit of a base weight changes its timeout.
  const weightsUnion = registryConflicts.includes(SHARD_WEIGHTS_PATH) ? await readUnion(SHARD_WEIGHTS_PATH).catch(error => {
    if (!error.message.startsWith('registry: ')) throw error;
    refuseAuthoredConflicts([SHARD_WEIGHTS_PATH]);
  }) : undefined;
  const index = await trackedIndex(cwd);
  const legacyConflict = path => [...REGISTRY_PATHS, ...MIGRATION_REGISTRIES, INVENTORY_PATH].includes(path) ||
    (generatedCarrier(path) && !path.endsWith('.sql') && !/^packages\/[^/]+\/api\/[^/]+\.api\.md$/u.test(path));
  const authoredInputs = conflicts.filter(path => /^(?:config\/openlup-packages\.json|packages\/[^/]+\/(?:package|release-gates)\.json)$/u.test(path));
  refuseAuthoredConflicts(authoredInputs);
  const catalogueUnion = conflicts.includes(PUBLICATION_CATALOGUE) || reslotsCatalogue ? await readUnion(PUBLICATION_CATALOGUE) : undefined;
  const catalogue = catalogueUnion === undefined ? readJson(cwd, PUBLICATION_CATALOGUE) : JSON.parse(catalogueUnion);
  const owners = readReportOwners(cwd);
  const { admitted, replaceable } = ownerOutputs(owners, catalogue.publicPaths);
  finalization?.trackOwned(replaceable);
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
  const needsInventoryRefresh = Boolean(finalization) || prPaths.some(isInventoryInputPath) || conflicts.some(isInventoryInputPath);
  const inputs = [...prPaths, ...conflicts];
  // Resolve envelopes before any generator or database work; historical conflict stops.
  const inventories = await Promise.all([base, head, main].map(revision => read(revision, INVENTORY_PATH)));
  const envelopes = inventories.map(inventoryEnvelope);
  if (needsInventoryRefresh && !envelopes.every(value => value.before === envelopes[0].before && value.after === envelopes[0].after)) throw new Error('landing: historical inventory conflict');
  // Main can change the requirements after the initial checkout passes validation.
  await guarded({}, () => checkMergedLandingToolchain(cwd, head, run, carrierEnv, diagnostics));
  if (needsInventoryRefresh) await assertCarrierBuildOutputs(cwd, DEFAULT_INCREMENTAL_PACKAGES, true);
  const preliminary = carrierPlan(owners, inputs);
  if (preliminary.builds.length) {
    await assertCarrierBuildOutputs(cwd, preliminary.builds.map(({ directory }) => directory));
  }
  await finalization?.checkpoint();
  if (conflicts.includes(SQL_REFERENCE)) await guarded({}, () => checkLandingSqlReference(runGenerators));
  if (conflicts.includes(MATURITY_REFERENCE)) await guarded({}, () => checkLandingMaturityReference(runGenerators));
  for (const path of new Set([...registryConflicts, ...(reslotsCatalogue ? [PUBLICATION_CATALOGUE] : [])])) {
    writes.paths.add(path);
    const contents = path === PUBLICATION_CATALOGUE ? catalogueUnion : path === SHARD_WEIGHTS_PATH ? weightsUnion : await readUnion(path);
    await guarded({ files: [path], index: [path] }, async () => {
      writeFileSync(resolve(cwd, path), contents);
      await git(cwd, 'add', '--', path);
    });
  }
  // Keep Git's merged prose in the SQL reference; discard conflicts in other generated carriers.
  for (const path of conflicts.filter(path => generatedCarrier(path) && (legacyConflict(path) || (replaceable.has(path) && safeOutput(cwd, path, index))))) {
    if (path !== SQL_REFERENCE && path !== MATURITY_REFERENCE && !REGISTRY_PATHS.includes(path)) {
      await guarded({ files: [path] }, () => git(cwd, 'checkout', '--ours', '--', path));
    }
  }
  writes.paths.add(INVENTORY_PATH);
  let measuredInventory;
  if (needsInventoryRefresh) {
    await guarded({ files: [INVENTORY_PATH] }, () => writeFileSync(resolve(cwd, INVENTORY_PATH), inventories[1]));
    for (const path of MIGRATION_REGISTRIES) {
      const inputs = await Promise.all([base, head, main].map(revision => read(revision, path)));
      if (reslottedHead.has(path)) inputs[1] = reslottedHead.get(path);
      writes.paths.add(path);
      await guarded({ files: [path], index: [path] }, async () => {
        writeFileSync(resolve(cwd, path), migrationRegistryUnion(path, ...inputs, inventories[1]));
        await git(cwd, 'add', '--', path);
      });
    }
    // Owners load from the merged tree; this process still holds pre-merge modules.
    await finalization?.checkpoint();
    await guarded({}, () => run(process.execPath, [resolve(cwd, BUILD_SCRIPT)], { env: carrierEnv }));
    const inventoryArgs = ['--import', 'tsx', resolve(cwd, 'scripts/installation-inventory-refresh.ts')];
    const inventoryPath = resolve(cwd, INVENTORY_PATH);
    if (finalization) {
      const scratch = isolatedInventoryDirectory(cwd);
      try { mkdirSync(scratch, { mode: 0o700 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        throw new Error('landing: inventory scratch already exists; inspect it before retrying');
      }
      const identity = lstatSync(scratch);
      const ownsScratch = () => {
        const current = lstatSync(scratch, { throwIfNoEntry: false });
        return current?.isDirectory() && current.dev === identity.dev && current.ino === identity.ino;
      };
      try {
        await guarded({}, () => run(process.execPath, [...inventoryArgs, '--isolated']));
        if (!ownsScratch()) throw new Error('landing: isolated inventory scratch changed during measurement');
        const output = isolatedInventoryFile(cwd);
        const file = lstatSync(output, { throwIfNoEntry: false });
        if (!file?.isFile() || file.nlink !== 1) throw new Error('landing: inventory refresh did not produce an isolated measurement');
        measuredInventory = readFileSync(output);
        await guarded({ files: [INVENTORY_PATH] }, () => writeFileSync(inventoryPath, measuredInventory));
      } finally {
        if (ownsScratch()) {
          rmSync(resolve(scratch, 'inventory.json'), { force: true });
          rmdirSync(scratch);
        }
      }
    } else {
      run(process.execPath, inventoryArgs);
    }
    const inventory = readFileSync(inventoryPath, 'utf8');
    for (const path of MIGRATION_REGISTRIES) {
      const inputs = await Promise.all([base, head, main].map(revision => read(revision, path)));
      if (reslottedHead.has(path)) inputs[1] = reslottedHead.get(path);
      await guarded({ files: [path] }, () => writeFileSync(resolve(cwd, path), migrationRegistryUnion(path, ...inputs, inventory)));
    }
    if (slotChanges.length && !finalization) applyMigrationReslot(cwd, slotChanges, false, false);
  } else {
    writeFileSync(resolve(cwd, INVENTORY_PATH), inventories[2]);
  }
  await finalization?.checkpoint();
  const projection = 'packages/platform/src/migrations/catalog.ts';
  const projectionBefore = readFileSync(resolve(cwd, projection), 'utf8');
  // Only the migration projection feeds compilation. Validate selectors after the reports exist.
  writes.generated = true;
  const packageOutputs = [projection, 'packages/platform/sql/manifest.json',
    ...(finalization?.moves ?? []).map(({ targetPath }) => `packages/platform/sql/${targetPath.split('/').at(-1)}`)];
  await guarded({ files: packageOutputs }, () => runGenerators(`const { checkPlatformMigrationProjection } = await import(${mergedModule('scripts/packages/platform-migration-projection.ts')});
    const errors = checkPlatformMigrationProjection(process.cwd(), true);
    if (errors.length) throw new Error(errors.join('; '));`));
  if (readFileSync(resolve(cwd, projection), 'utf8') !== projectionBefore) inputs.push(projection);
  const { reports, builds, settings, maturity } = carrierPlan(owners, inputs);
  const outputs = [...new Set([...reports.flatMap(owner => owner.reports), ...(settings ? SETTINGS_OUTPUTS : []), ...(maturity ? [MATURITY_REFERENCE] : [])])];
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
      await guarded({ files: owner.reports }, () => reports.includes(owner) ? build() :
        runUnselectedBuild(cwd, owner.name, selectedOutputs, build));
    }
    for (const { directory, name, reports: reportPaths } of reports) {
      const mergeContext = name === '@openlup/platform' ? [] : [`--landing=${head},${main}`];
      await guarded({ files: reportPaths }, () =>
        run(process.execPath, [resolve(cwd, directory, 'scripts/api-contract.ts'), '--update', ...mergeContext], { env: carrierEnv }));
    }
    if (settings) await guarded({ files: SETTINGS_OUTPUTS }, () =>
      run(process.execPath, [resolve(cwd, 'scripts/settings-catalogue.ts'), '--write'], { env: carrierEnv }));
    // The regions read the reports regenerated above.
    if (maturity) await guarded({ files: [MATURITY_REFERENCE] }, () => runGenerators('owners.refreshMaturityReference(process.cwd());'));
  }
  const tracked = pathsFrom(await git(cwd, 'ls-files', '-z'));
  const generated = pathsFrom(await git(cwd, 'ls-files', '--others', '--exclude-standard', '-z'))
    .filter(path => generatedCarrier(path) || outputs.includes(path));
  const paths = [...new Set([...tracked, ...generated])];
  await guarded({ files: [...packageOutputs, PUBLICATION_CATALOGUE, 'docs/platform/SOURCE_MAP.md', SQL_REFERENCE] }, () =>
    runGenerators("owners.runLandingGenerators(process.cwd(), readFileSync(0, 'utf8').split('\\0').filter(Boolean));", paths.join('\0')));
  const staged = [...new Set([...MIGRATION_REGISTRIES, INVENTORY_PATH, ...paths.filter(generatedCarrier), ...outputs])];
  await guarded({ index: staged }, () => git(cwd, '--literal-pathspecs', 'add', '--', ...staged));
  if ((await git(cwd, 'diff', '--name-only', '--diff-filter=U')).trim()) throw new LandingConflict('landing: unresolved conflicts remain');
  if (finalization) {
    const tree = await guarded({}, () => finalization.verifyIndex(measuredInventory));
    await finalization.checkpoint();
    if (tree !== (await git(cwd, 'write-tree')).trim()) throw new Error('landing: Git index changed during finalization proof');
    if (tree === (await guarded({}, () => git(cwd, 'rev-parse', `${head}^{tree}`))).trim() && base === main) return needsInventoryRefresh;
    const identity = (await git(cwd, 'var', 'GIT_COMMITTER_IDENT')).trim().replace(/ [0-9]+ [+-][0-9]{4}$/u, '');
    const message = `Finalize migration versions\n\nSigned-off-by: ${identity}`;
    const parents = base === main ? ['-p', head] : ['-p', head, '-p', main];
    await finalization.checkpoint();
    const next = (await guarded({}, () => git(cwd, 'commit-tree', tree, ...parents, '-m', message))).trim();
    await finalization.checkpoint();
    await git(cwd, '-c', 'core.hooksPath=/dev/null', 'update-ref', '-m', 'finalize migration versions', finalization.ref, next, head);
    finalization.committedHead = next;
    if (base !== main) await git(cwd, 'merge', '--quit');
  } else {
    await git(cwd, 'commit', '-s', '-m', 'Merge origin/main and refresh derived carriers');
  }
  return needsInventoryRefresh;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runLandingCli();
