// Import the trusted owners here, never the predicted tree's executable files.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// eslint-disable-next-line no-restricted-imports -- landing needs the trusted SQL inventory owner before workspace packages are installed
import { renderSqlInventory } from '../packages/core/scripts/documentation-sql-inventory.ts';
import { checkPlatformMigrationProjection } from './packages/platform-migration-projection.ts';
import { readDocumentationState } from './documentation-routing.ts';
import { renderDocumentationSourceMap } from './documentation-navigation.ts';
import { createPublicPublicationCatalog } from './oss-publication-policy.ts';

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
    'config/openlup-publication-catalog.json', 'docs/platform/SOURCE_MAP.md', SQL_REFERENCE].includes(path) ||
    /^packages\/platform\/sql\/[A-Za-z0-9_-]+\.sql$/u.test(path);
}
const mirrorManifest = root => JSON.parse(readFileSync(join(root, 'packages/platform/sql/manifest.json'), 'utf8'))
  .migrations.map(({ file }) => {
    if (!/^(?:(?:q2|qa|qb)_)?\d{14}_[A-Za-z0-9_-]+\.sql$/u.test(file)) throw new Error(`invalid projected SQL mirror: ${file}`);
    return `packages/platform/sql/${file}`;
  });

export function runLandingGenerators(root, paths) {
  const errors = checkPlatformMigrationProjection(root, true);
  if (errors.length) throw new Error(errors.join('; '));
  const catalogPath = join(root, 'config/openlup-publication-catalog.json');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const mirrors = new Set(mirrorManifest(root));
  const mirrorShape = /^packages\/platform\/sql\/(?:(?:q2|qa|qb)_)?\d{14}_[A-Za-z0-9_-]+\.sql$/u;
  const rows = catalog.publicPaths.filter(row => !mirrorShape.test(row.path) || mirrors.has(row.path) || existsSync(join(root, row.path)));
  for (const path of mirrors) if (!rows.some(row => row.path === path)) rows.push({ path, class: 'public-output' });
  rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const generated = createPublicPublicationCatalog(rows, catalog.guardViability).contents;
  if (existsSync(join(root, PUBLICATION_OWNER)) && readFileSync(join(root, PUBLICATION_OWNER), 'utf8') === trustedPublicationOwner) {
    writeFileSync(catalogPath, generated);
  } else {
    // Main may have changed this owner and already regenerated its policy metadata.
    // Compact replay trees may omit the owner. Keep their reviewed metadata while
    // this process refreshes only the mirror rows.
    const merged = JSON.parse(generated);
    merged.packageCommands = catalog.packageCommands;
    merged.packageExecutionSurfaces = catalog.packageExecutionSurfaces;
    writeFileSync(catalogPath, `${JSON.stringify(merged, null, 2)}\n`);
  }
  writeFileSync(join(root, 'docs/platform/SOURCE_MAP.md'), renderDocumentationSourceMap(readDocumentationState(root, paths)));
  writeFileSync(join(root, SQL_REFERENCE), syncSqlReference(root));
}
export function withPredictedTree(cwd, tree, action) {
  const git = args => execFileSync('/usr/bin/git', ['--no-replace-objects', '-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024 * 1024, env: { PATH: '/usr/bin:/bin' } });
  const rows = git(['ls-tree', '-rz', '--full-tree', tree]).split('\0').filter(Boolean);
  if (rows.some(row => !row.startsWith('100644 blob ') && !row.startsWith('100755 blob '))) throw new Error('derived: non-regular predicted tree');
  const paths = rows.map(row => row.slice(row.indexOf('\t') + 1));
  mkdirSync(join(cwd, '.context/scratch'), { recursive: true });
  const root = mkdtempSync(join(cwd, '.context/scratch/derived-tree-'));
  try {
    const ids = rows.map(row => row.split(' ')[2].split('\t')[0]);
    const blobs = execFileSync('/usr/bin/git', ['--no-replace-objects', '-C', cwd, 'cat-file', '--batch'], {
      input: ids.join('\n') + '\n', timeout: 30000, maxBuffer: 128 * 1024 * 1024,
    });
    let offset = 0;
    for (let index = 0; index < paths.length; index++) {
      const newline = blobs.indexOf(10, offset);
      const header = blobs.subarray(offset, newline).toString('utf8').split(' ');
      if (header[0] !== ids[index] || header[1] !== 'blob' || !/^\d+$/u.test(header[2])) throw new Error('derived: unreadable blob');
      const size = Number(header[2]); offset = newline + 1;
      const target = join(root, paths[index]);
      if (paths[index].split('/').some(part => part === '..' || part === '.' || part === '.git') || !target.startsWith(root + '/')) throw new Error('derived: unsafe tree path');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, blobs.subarray(offset, offset + size)); offset += size + 1;
    }
    return action(root, paths);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
