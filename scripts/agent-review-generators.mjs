// Import the trusted owners here, never the predicted tree's executable files.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
// eslint-disable-next-line no-restricted-imports -- landing needs the trusted SQL inventory owner before workspace packages are installed
import { renderSqlInventory } from '../packages/core/scripts/documentation-sql-inventory.ts';
import { checkPlatformMigrationProjection } from './packages/platform-migration-projection.ts';
import { assertDocumentationPath, documentationGit, readDocumentationState } from './documentation-routing.ts';
import { renderDocumentationSourceMap } from './documentation-navigation.ts';
import { createPublicPublicationCatalog, isManifestPinnedSqlArea } from './oss-publication-policy.ts';
import { buildPackagesIncremental } from './build-packages-incremental.mjs';

export const SQL_REFERENCE = 'packages/core/docs/guide/reference/sql.md';
const PUBLICATION_OWNER = 'scripts/oss-publication-policy.ts';
const trustedPublicationOwner = readFileSync(new URL('./oss-publication-policy.ts', import.meta.url), 'utf8');

export function syncSqlReference(root) {
  const source = readFileSync(join(root, SQL_REFERENCE), 'utf8');
  let opened = 0;
  for (const [, closing, name] of source.matchAll(/<!-- (\/?)generated:(.*?) -->/gu)) {
    if (!/^sql:[a-z]+$/u.test(name)) throw new Error(`${SQL_REFERENCE}: unknown generated region ${name}`);
    if (!closing) opened++;
  }
  let closed = 0;
  const result = source.replace(/(<!-- generated:(sql:[a-z]+) -->\n)[\s\S]*?(<!-- \/generated:\2 -->)/gu, (_, start, name, end) => {
    const body = renderSqlInventory(name, root);
    if (body === undefined) throw new Error(`${SQL_REFERENCE}: unknown generated region ${name}`);
    closed++;
    return start + body + end;
  });
  if (/^(?:<<<<<<< |\|{7} |>>>>>>> |=======$)/mu.test(result)) {
    throw new Error(`landing: authored conflicts remain: ${SQL_REFERENCE}`);
  }
  if (opened !== closed) {
    throw new Error(`${SQL_REFERENCE}: a generated region is not closed by its matching marker`);
  }
  return result;
}

export function generatedCarrier(path) {
  return ['packages/platform/sql/manifest.json', 'packages/platform/src/migrations/catalog.ts',
    'config/openlup-publication-catalog.json', 'docs/platform/SOURCE_MAP.md', SQL_REFERENCE,
    'packages/platform/settings-catalog.json', 'packages/platform/settings-refusals.json',
    'packages/core/docs/guide/how-to/operate/settings-catalogue.md'].includes(path) ||
    /^packages\/[^/]+\/api\/[^/]+\.api\.md$/u.test(path) ||
    /^packages\/platform\/sql\/[A-Za-z0-9_-]+\.sql$/u.test(path);
}

export const ownerOutputCarrier = path => /^packages\/[^/]+\/api\/[^/]+\.api\.md$/u.test(path) ||
  ['packages/platform/settings-catalog.json', 'packages/platform/settings-refusals.json',
    'packages/core/docs/guide/how-to/operate/settings-catalogue.md'].includes(path);
export function runDerivedOutputGenerators(root, source, installationRoot, carriers, trusted) {
  const reports = [...new Set(carriers.filter(path => /^packages\/[^/]+\/api\/[^/]+\.api\.md$/u.test(path))
    .map(path => path.split('/')[1]))];
  const settings = carriers.some(path => ['packages/platform/settings-catalog.json', 'packages/platform/settings-refusals.json',
    'packages/core/docs/guide/how-to/operate/settings-catalogue.md'].includes(path));
  if (!reports.length && !settings) return;
  if (!existsSync(join(source, 'scripts/build-packages-incremental.mjs'))) throw new Error('derived: package builder is absent');
  const catalog = JSON.parse(readFileSync(join(root, 'config/openlup-publication-catalog.json'), 'utf8'));
  for (const path of carriers.filter(path => /^packages\/[^/]+\/api\/[^/]+\.api\.md$/u.test(path))) {
    const owner = path.split('/')[1];
    const gates = JSON.parse(readFileSync(join(root, 'packages', owner, 'release-gates.json'), 'utf8'));
    if (!catalog.publicPaths.some(row => row.path === path && row.class === 'public-output') ||
      !Object.values(gates.packageSurface).some(surface => `packages/${owner}/${surface.snapshot}` === path)) {
      throw new Error(`derived: unregistered API output ${path}`);
    }
  }
  const installed = join(installationRoot, 'node_modules');
  if (!existsSync(join(installed, 'typescript/bin/tsc'))) throw new Error('derived: locked TypeScript is absent');
  const packages = JSON.parse(trusted['config/openlup-packages.json']).packages;
  const linkInstallation = tree => {
    const target = join(tree, 'node_modules');
    mkdirSync(join(target, '@openlup'), { recursive: true });
    for (const entry of readdirSync(installed)) {
      if (entry !== '@openlup') symlinkSync(join(installed, entry), join(target, entry));
    }
    for (const { name, directory } of packages) {
      if (!/^@openlup\/[a-z0-9-]+$/u.test(name) || !/^packages\/[a-z0-9-]+$/u.test(directory) ||
        name.slice(9) !== directory.slice(9)) throw new Error('derived: invalid trusted package inventory');
      symlinkSync(join(tree, directory), join(target, '@openlup', name.slice(9)), 'dir');
    }
  };
  // TypeScript reads the candidate as source data. No candidate package script
  // or settings function runs in the review process.
  if (reports.length) {
    linkInstallation(root);
    buildPackagesIncremental({ rootDir: root, tscBin: join(installed, 'typescript/bin/tsc'), stdio: 'pipe' });
    for (const owner of reports) {
      const script = `packages/${owner}/scripts/api-contract.ts`;
      if (trusted[script] !== readFileSync(join(root, script), 'utf8')) throw new Error(`derived: changed generator ${script}`);
      if (owner === 'core') {
        const helper = 'packages/core/scripts/public-api-config.ts';
        if (trusted[helper] !== readFileSync(join(root, helper), 'utf8')) throw new Error(`derived: changed generator ${helper}`);
      }
      execFileSync(process.execPath, [join(root, script), '--update', ...(owner === 'platform' ? [] : ['--derived-proof'])],
        { cwd: root, timeout: 120000, stdio: 'pipe' });
    }
  }
  if (settings) {
    linkInstallation(source);
    buildPackagesIncremental({ rootDir: source, tscBin: join(installed, 'typescript/bin/tsc'), stdio: 'pipe' });
    const renderer = pathToFileURL(join(source, 'scripts/settings-catalogue.ts')).href;
    const script = `import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { renderSettingsCatalogue } from ${JSON.stringify(renderer)};
      for (const [path, content] of Object.entries(renderSettingsCatalogue(${JSON.stringify(root)})))
        writeFileSync(join(${JSON.stringify(root)}, path), content);`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: source, timeout: 120000, stdio: 'pipe' });
  }
}
export function runLandingGenerators(root, paths) {
  const errors = checkPlatformMigrationProjection(root, true);
  if (errors.length) throw new Error(errors.join('; '));
  const catalogPath = join(root, 'config/openlup-publication-catalog.json');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const rows = catalog.publicPaths.filter(row => !isManifestPinnedSqlArea(row.path));
  rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const generated = createPublicPublicationCatalog(rows, catalog.guardViability).contents;
  if (existsSync(join(root, PUBLICATION_OWNER)) && readFileSync(join(root, PUBLICATION_OWNER), 'utf8') === trustedPublicationOwner) {
    writeFileSync(catalogPath, generated);
  } else {
    // Main may have changed this owner and already regenerated its policy metadata.
    // Compact replay trees may omit the owner. Keep their reviewed metadata while
    // this process strips any manifest-pinned SQL rows.
    const merged = JSON.parse(generated);
    merged.packageCommands = catalog.packageCommands;
    merged.packageExecutionSurfaces = catalog.packageExecutionSurfaces;
    writeFileSync(catalogPath, `${JSON.stringify(merged, null, 2)}\n`);
  }
  writeFileSync(join(root, 'docs/platform/SOURCE_MAP.md'), renderDocumentationSourceMap(readDocumentationState(root, paths)));
  writeFileSync(join(root, SQL_REFERENCE), syncSqlReference(root));
}
export function withPredictedTree(cwd, tree, action) {
  const rows = documentationGit(cwd, ['ls-tree', '-rz', '--full-tree', tree]).toString('utf8').split('\0').filter(Boolean);
  if (rows.some(row => !row.startsWith('100644 blob ') && !row.startsWith('100755 blob '))) throw new Error('derived: non-regular predicted tree');
  const paths = rows.map(row => row.slice(row.indexOf('\t') + 1));
  const root = mkdtempSync(join(tmpdir(), 'openlup-derived-tree-'));
  try {
    const ids = rows.map(row => row.split(' ')[2].split('\t')[0]);
    const blobs = documentationGit(cwd, ['cat-file', '--batch'], ids.join('\n') + '\n', 128 * 1024 * 1024);
    let offset = 0;
    for (let index = 0; index < paths.length; index++) {
      const newline = blobs.indexOf(10, offset);
      const header = blobs.subarray(offset, newline).toString('utf8').split(' ');
      if (header[0] !== ids[index] || header[1] !== 'blob' || !/^\d+$/u.test(header[2])) throw new Error('derived: unreadable blob');
      const size = Number(header[2]); offset = newline + 1;
      assertDocumentationPath(paths[index]);
      const target = join(root, paths[index]);
      if (paths[index].split('/').some(part => part.toLowerCase() === '.git') || !target.startsWith(root + '/')) throw new Error('derived: unsafe tree path');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, blobs.subarray(offset, offset + size)); offset += size + 1;
    }
    return action(root, paths);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
