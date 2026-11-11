// Import the trusted owners here, never the predicted tree's executable files.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkPlatformMigrationProjection } from './packages/platform-migration-projection.ts';
import { readDocumentationState } from './documentation-routing.ts';
import { renderDocumentationSourceMap } from './documentation-navigation.ts';
import { run as generateContext } from './agent-context/generate.mjs';
import { createPublicPublicationCatalog } from './oss-publication-policy.ts';

export function generatedCarrier(path) {
  return ['packages/platform/sql/manifest.json', 'packages/platform/src/migrations/catalog.ts',
    'config/openlup-publication-catalog.json', 'docs/platform/SOURCE_MAP.md',
    'packages/core/AGENT_CONTEXT.md', 'packages/outbox/AGENT_CONTEXT.md', 'packages/platform/AGENT_CONTEXT.md'].includes(path) ||
    /^packages\/platform\/sql\/[A-Za-z0-9_-]+\.sql$/u.test(path);
}
export function runLandingGenerators(root, paths) {
  const errors = checkPlatformMigrationProjection(root, true);
  if (errors.length) throw new Error(errors.join('; '));
  const catalogPath = join(root, 'config/openlup-publication-catalog.json');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  writeFileSync(catalogPath, createPublicPublicationCatalog(catalog.publicPaths, catalog.guardViability).contents);
  writeFileSync(join(root, 'docs/platform/SOURCE_MAP.md'), renderDocumentationSourceMap(readDocumentationState(root, paths)));
  generateContext(root);
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
