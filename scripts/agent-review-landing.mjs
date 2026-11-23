// Local landing helper: merge main, stop on authored conflicts, never push.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { collectRelocationPlan, git } from './agent-review-session.mjs';
import { REGISTRY_PATHS, registryUnion } from './agent-review-registry.mjs';
import { INVENTORY_PATH, MIGRATION_REGISTRIES, inventoryEnvelope, migrationRegistryUnion, rewriteCatalogForRelocation, rewriteMigrationRegistryForRelocation } from './agent-review-derived.mjs';
import { generatedCarrier, SQL_REFERENCE } from './agent-review-generators.mjs';
import { DEFAULT_INCREMENTAL_PACKAGES, TSBUILDINFO_FILENAME } from './build-packages-incremental.mjs';
import { isGuidePage } from './oss-publication-policy.ts';
import { isQualifiedPlatformMigrationPath } from './platform-migration-manifest.ts';

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

const MIGRATION_FORWARD = /^(?:db\/platform|supabase)\/migrations\/(\d{14})_[A-Za-z0-9_-]+\.sql$/u;
const MIGRATION_RAILS = ['db/platform/migrations/', 'supabase/migrations/'];

export function assertAppendOnlyLandingSlots(prAddedPaths, mainMigrationPaths) {
  for (const rail of MIGRATION_RAILS) {
    let version = '';
    for (const path of mainMigrationPaths) {
      if (!path.startsWith(rail) || isQualifiedPlatformMigrationPath(path)) continue;
      const slot = MIGRATION_FORWARD.exec(path)?.[1];
      if (slot && slot > version) version = slot;
    }
    const additions = prAddedPaths
      .filter(path => path.startsWith(rail) && !isQualifiedPlatformMigrationPath(path) && MIGRATION_FORWARD.test(path))
      .sort();
    for (const path of additions) {
      const next = MIGRATION_FORWARD.exec(path)[1];
      if (next <= version) {
        throw new Error('landing: migration slot is not strictly later than origin/main; rename the new migration to a later UTC timestamp and refresh derived files');
      }
      version = next;
    }
  }
}

export async function landingMerge(cwd = process.cwd(), { runCommand, relocateSlots = false } = {}) {
  if ((await git(cwd, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all')).trim()) throw new Error('landing: clean committed checkout required');
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
  let relocations = [];
  if (prAdded.some(path => MIGRATION_RAILS.some(rail => path.startsWith(rail)))) {
    // Skip migrations already present byte-for-byte identically on origin/main (stacked PRs whose predecessor squash-merged).
    const differingFromMain = new Set(pathsFrom(await git(cwd, 'diff', '--name-only', '--no-renames', '-z', main, head, '--', 'db/platform/migrations', 'supabase/migrations')));
    const netAdded = prAdded.filter(path => differingFromMain.has(path));
    if (netAdded.length > 0) {
      if (relocateSlots) {
        relocations = await collectRelocationPlan(cwd, base, head, main);
      }
      if (relocations.length === 0) {
        const mainMigrations = pathsFrom(await git(cwd, 'ls-tree', '-r', '--name-only', '-z', main, '--', 'db/platform/migrations', 'supabase/migrations'));
        assertAppendOnlyLandingSlots(netAdded, mainMigrations);
      }
    }
  }
  const carrierEnv = { ...processEnvironment, ...carrierLocale };
  const run = runCommand ?? ((command, args, options) => execFileSync(command, args, { cwd, stdio: 'inherit', timeout: 900000, ...options }));
  const checkToolchain = () => run(process.execPath, ['--input-type=module', '-e',
    `import { assertCarrierToolchain } from './scripts/agent-review-landing.mjs'; console.log(assertCarrierToolchain(process.cwd()));`], { env: carrierEnv });
  checkToolchain();
  try { await git(cwd, '-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '--no-commit', main); }
  catch (error) { if (error.code !== 1) throw error; }
  if ((await git(cwd, 'rev-parse', '--verify', 'MERGE_HEAD')).trim() !== main) throw new Error('landing: exact main merge required');
  const conflicts = pathsFrom(await git(cwd, 'diff', '--name-only', '--diff-filter=U', '-z'));
  const read = (revision, path) => git(cwd, 'show', `${revision}:${path}`);
  const readUnion = async path => {
    const [baseSrc, headSrc, mainSrc] = await Promise.all([base, head, main].map(revision => read(revision, path)));
    const rewrittenHead = relocations.length && path === PUBLICATION_CATALOGUE
      ? rewriteCatalogForRelocation(headSrc, relocations)
      : headSrc;
    return registryUnion(path, baseSrc, rewrittenHead, mainSrc);
  };
  const readMigrationUnion = async (path, inventorySource) => {
    const [baseSrc, headSrc, mainSrc] = await Promise.all([base, head, main].map(revision => read(revision, path)));
    const rewrittenHead = relocations.length
      ? rewriteMigrationRegistryForRelocation(path, headSrc, relocations)
      : headSrc;
    return migrationRegistryUnion(path, baseSrc, rewrittenHead, mainSrc, inventorySource);
  };
  const index = await trackedIndex(cwd);
  const legacyConflict = path => [...REGISTRY_PATHS, ...MIGRATION_REGISTRIES, INVENTORY_PATH].includes(path) || (generatedCarrier(path) && !path.endsWith('.sql'));
  const authoredInputs = conflicts.filter(path => /^(?:config\/openlup-packages\.json|packages\/[^/]+\/(?:package|release-gates)\.json)$/u.test(path));
  if (authoredInputs.length) throw new Error(`landing: authored conflicts remain: ${authoredInputs.join(', ')}`);
  let catalogueUnion;
  if (conflicts.includes(PUBLICATION_CATALOGUE)) {
    catalogueUnion = await readUnion(PUBLICATION_CATALOGUE);
  } else if (relocations.length) {
    const headCat = await read(head, PUBLICATION_CATALOGUE);
    if (rewriteCatalogForRelocation(headCat, relocations) !== headCat) {
      catalogueUnion = await readUnion(PUBLICATION_CATALOGUE);
    }
  }
  const catalogue = catalogueUnion === undefined ? readJson(cwd, PUBLICATION_CATALOGUE) : JSON.parse(catalogueUnion);
  const owners = readReportOwners(cwd);
  const { admitted, replaceable } = ownerOutputs(owners, catalogue.publicPaths);
  const other = conflicts.filter(path => !legacyConflict(path) && !(replaceable.has(path) && safeOutput(cwd, path, index)));
  if (other.length) throw new Error(`landing: authored conflicts remain: ${other.join(', ')}`);
  if (relocations.length) {
    for (const item of relocations) {
      const sqlBytes = await read(head, item.oldPath);
      writeFileSync(resolve(cwd, item.newPath), sqlBytes);
      writeFileSync(resolve(cwd, item.newMirror), sqlBytes);
      await git(cwd, 'rm', '-f', '--', item.oldPath, item.oldMirror);
      await git(cwd, 'add', '--', item.newPath, item.newMirror);
    }
  }
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
  const needsInventoryRefresh = prPaths.some(isInventoryInputPath) || conflicts.some(isInventoryInputPath) || relocations.length > 0;
  const inputs = [...prPaths, ...conflicts, ...relocations.flatMap(item => [item.newPath, item.newMirror])];
  // Resolve envelopes before any generator or database work; historical conflict stops.
  const inventories = await Promise.all([base, head, main].map(revision => read(revision, INVENTORY_PATH)));
  const envelopes = inventories.map(inventoryEnvelope);
  if (needsInventoryRefresh && !envelopes.every(value => value.before === envelopes[0].before && value.after === envelopes[0].after)) throw new Error('landing: historical inventory conflict');
  // Main can change the requirements after the initial checkout passes validation.
  const toolchainInputs = ['.nvmrc', 'package.json', 'package-lock.json', 'config/openlup-packages.json', 'scripts/agent-review-landing.mjs',
    ...DEFAULT_INCREMENTAL_PACKAGES.map(directory => `${directory}/package.json`)];
  if (await git(cwd, '--literal-pathspecs', 'diff', '--name-only', '-z', head, '--', ...toolchainInputs)) checkToolchain();
  if (needsInventoryRefresh) await assertCarrierBuildOutputs(cwd, DEFAULT_INCREMENTAL_PACKAGES, true);
  const preliminary = carrierPlan(owners, inputs);
  if (preliminary.builds.length) {
    await assertCarrierBuildOutputs(cwd, preliminary.builds.map(({ directory }) => directory));
  }
  if (conflicts.includes(SQL_REFERENCE)) runGenerators('owners.syncSqlReference(process.cwd());');
  for (const path of conflicts.filter(path => REGISTRY_PATHS.includes(path))) {
    writeFileSync(resolve(cwd, path), path === PUBLICATION_CATALOGUE ? catalogueUnion : await readUnion(path));
    await git(cwd, 'add', '--', path);
  }
  if (catalogueUnion !== undefined && !conflicts.includes(PUBLICATION_CATALOGUE)) {
    writeFileSync(resolve(cwd, PUBLICATION_CATALOGUE), catalogueUnion);
    await git(cwd, 'add', '--', PUBLICATION_CATALOGUE);
  }
  // Keep Git's merged prose in the SQL reference; discard conflicts in other generated carriers.
  for (const path of conflicts.filter(generatedCarrier)) {
    if (path !== SQL_REFERENCE && !REGISTRY_PATHS.includes(path)) await git(cwd, 'checkout', '--ours', '--', path);
  }
  if (needsInventoryRefresh) {
    writeFileSync(resolve(cwd, INVENTORY_PATH), inventories[1]);
    for (const path of MIGRATION_REGISTRIES) {
      writeFileSync(resolve(cwd, path), await readMigrationUnion(path, inventories[1]));
      await git(cwd, 'add', '--', path);
    }
    // Owners load from the merged tree; this process still holds pre-merge modules.
    run(process.execPath, [resolve(cwd, BUILD_SCRIPT)], { env: carrierEnv });
    run(process.execPath, ['--import', 'tsx', resolve(cwd, 'scripts/installation-inventory-refresh.ts')]);
    const inventory = readFileSync(resolve(cwd, INVENTORY_PATH), 'utf8');
    for (const path of MIGRATION_REGISTRIES) {
      writeFileSync(resolve(cwd, path), await readMigrationUnion(path, inventory));
    }
  } else {
    writeFileSync(resolve(cwd, INVENTORY_PATH), inventories[2]);
  }
  const projection = 'packages/platform/src/migrations/catalog.ts';
  const projectionBefore = readFileSync(resolve(cwd, projection), 'utf8');
  // Only the migration projection feeds compilation. Validate selectors after the reports exist.
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
  const staged = [...new Set([...MIGRATION_REGISTRIES, INVENTORY_PATH, ...paths.filter(generatedCarrier), ...outputs, ...relocations.flatMap(item => [item.newPath, item.newMirror])])];
  await git(cwd, '--literal-pathspecs', 'add', '--', ...staged);
  if ((await git(cwd, 'diff', '--name-only', '--diff-filter=U')).trim()) throw new Error('landing: unresolved conflicts remain');
  await git(cwd, 'commit', '-s', '-m', 'Merge origin/main and refresh derived carriers');
  return {
    head: (await git(cwd, 'rev-parse', 'HEAD')).trim(),
    main,
    inventoryRefreshed: needsInventoryRefresh,
    ...(relocations.length ? { relocated: relocations.map(({ oldPath, newPath }) => ({ from: oldPath, to: newPath })) } : {}),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliArgs = process.argv.slice(2);
  const relocateSlots = cliArgs.includes('--relocate-slots');
  const unknown = cliArgs.filter(arg => arg !== '--relocate-slots');
  if (unknown.length) {
    console.error(`landing: unknown argument(s): ${unknown.join(', ')}`);
    process.exitCode = 2;
  } else {
    landingMerge(process.cwd(), { relocateSlots })
      .then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
