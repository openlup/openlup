import { chmod, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

/** Run this file from an exact downloaded source archive, not from an installed package. */
const source = dirname(fileURLToPath(import.meta.url));
const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length) throw new Error('starter_extract_requires_empty_directory');
const target = resolve(directory);
if (target === source) throw new Error('starter_extract_independent_directory_required');
await mkdir(target, { recursive: true });
if ((await readdir(target)).length > 0) throw new Error('starter_extract_directory_not_empty');
const ownership = JSON.parse(await readFile(resolve(source, 'ownership.json'), 'utf8'));
const files = [...ownership.owned, ...ownership.managed];
if (new Set(files).size !== files.length) throw new Error('starter_ownership_duplicate');
if (ownership.sourceOnly.some(path => files.includes(path))) throw new Error('starter_ownership_scope_overlap');
function validPath(path) {
  return typeof path === 'string' && !path.includes('\\') && !path.startsWith('/')
    && !path.split('/').some(part => part === '..' || part === '.' || part === '');
}
for (const path of files) {
  const sourcePath = ownership.sourceMappings?.[path] ?? path;
  if (!validPath(path) || !validPath(sourcePath)) throw new Error('starter_ownership_path_invalid');
  const origin = resolve(source, sourcePath);
  const destination = resolve(target, path);
  // Archive inputs must be regular files through regular directories, not links out of the archive.
  let parent = dirname(origin);
  while (parent !== source && parent.startsWith(source + sep)) {
    if (!(await lstat(parent)).isDirectory()) throw new Error('starter_extract_directory_required');
    parent = dirname(parent);
  }
  const info = await lstat(origin);
  if (!info.isFile()) throw new Error('starter_extract_file_required');
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(origin, destination);
  await chmod(destination, info.mode & 0o777);
}
// This is an independent application repository, not a worktree of the archive.
execFileSync('git', ['init', '--initial-branch=main'], { cwd: target, stdio: 'ignore' });
const provenance = JSON.parse(await readFile(resolve(source, 'starter-release.json'), 'utf8'));
await writeFile(resolve(target, '.starter-origin.json'), JSON.stringify({
  schemaVersion: 1, kind: provenance.kind, setVersion: provenance.setVersion,
  sourceRevision: provenance.sourceRevision,
}, null, 2) + '\n');
process.stdout.write(`Created independent application: ${relative(process.cwd(), target) || '.'}\n`);
process.stdout.write('Read README.md before installing. Local candidates are not published releases.\n');
