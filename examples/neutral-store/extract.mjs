import { chmod, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Run this file from an exact downloaded source archive, not from an installed package. */
const options = new Map();
const [directory, ...extra] = process.argv.slice(2);
for (let i = 0; i < extra.length; i += 2) {
  const flag = extra[i], value = extra[i + 1];
  if (!['--mode', '--set-version', '--source-revision', '--manifest', '--lockfile', '--source', '--reason'].includes(flag)
    || !value || value.startsWith('--') || options.has(flag)) throw new Error('starter_extract_arguments_invalid');
  options.set(flag, value);
}
const mode = options.get('--mode');
if (!directory || (extra.length && !['released', 'reconstructed'].includes(mode))) throw new Error('starter_extract_requires_empty_directory');
const source = options.has('--source') ? resolve(options.get('--source')) : dirname(fileURLToPath(import.meta.url));
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
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const provenance = await json(resolve(source, 'starter-release.json'));
let identity;
let lockBytes;
let application;
if (mode) {
  const refuse = (code, detail = '') => { throw new Error(`starter_release_${code}${detail ? ': ' + detail : ''}`); };
  const version = options.get('--set-version'), revision = options.get('--source-revision');
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) refuse('set_version_required');
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) refuse('source_revision_required');
  if (!options.has('--manifest') || !options.has('--lockfile')) refuse('inputs_required');
  if (mode === 'reconstructed' && !options.get('--reason')?.trim()) refuse('reconstruction_reason_required');
  if (mode === 'released' && provenance.releasedExtractionSchemaVersion !== 2) refuse('reconstruction_required');
  const tree = resolve(source, '../..');
  let verification = 'supplied';
  try { await lstat(resolve(tree, '.git')); verification = 'verified'; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (verification === 'verified' && execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tree, encoding: 'utf8' }).trim() !== revision) refuse('source_revision_mismatch');
  const inventory = await json(resolve(tree, 'config/openlup-packages.json'));
  const expected = new Map();
  for (const item of inventory.packages.filter(item => item.publish)) {
    const pkg = await json(resolve(tree, item.directory, 'package.json'));
    if (pkg.name !== item.name || pkg.version !== version) refuse('source_package_version_mismatch', item.name);
    expected.set(pkg.name, null);
  }
  if (!expected.size) refuse('source_package_set_empty');
  const manifest = await json(resolve(options.get('--manifest')));
  if (manifest.schemaVersion !== 2 || manifest.commit !== revision || !Array.isArray(manifest.packages)) refuse('manifest_identity_mismatch');
  const seen = new Set();
  for (const pkg of manifest.packages) {
    if (!expected.has(pkg.name)) refuse('manifest_package_extra', pkg.name);
    if (seen.has(pkg.name)) refuse('manifest_package_duplicate', pkg.name);
    if (pkg.version !== version || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity ?? '')) refuse('manifest_package_mismatch', pkg.name);
    expected.set(pkg.name, pkg.integrity);
    seen.add(pkg.name);
  }
  for (const name of expected.keys()) if (!seen.has(name)) refuse('manifest_package_missing', name);
  application = await json(resolve(source, 'package.json'));
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(application[section] ?? {})) if (name.startsWith('@openlup/')) {
      if (!expected.has(name)) refuse('application_package_extra', name);
      application[section][name] = version;
    }
  }
  lockBytes = await readFile(resolve(options.get('--lockfile')));
  const lock = JSON.parse(lockBytes);
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) refuse('lock_format_invalid');
  for (const key of ['name', 'version', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const canonical = value => JSON.stringify(value && typeof value === 'object' ? Object.entries(value).sort() : value);
    if (canonical(lock.packages[''][key]) !== canonical(application[key])) refuse('lock_root_mismatch', key);
  }
  seen.clear();
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (!path) continue;
    let url;
    try { url = new URL(pkg.resolved); } catch { refuse('lock_non_registry', path); }
    if (pkg.link || url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash) refuse('lock_non_registry', path);
    const name = path.match(/(?:^|\/)node_modules\/(@openlup\/[^/]+)$/)?.[1];
    if (pkg.name?.startsWith('@openlup/') && pkg.name !== name) refuse('lock_package_mismatch', pkg.name);
    if (!name) continue;
    if (!expected.has(name)) refuse('lock_package_extra', name);
    if (seen.has(name)) refuse('lock_package_duplicate', name);
    if (pkg.version !== version || pkg.integrity !== expected.get(name)) refuse('lock_package_mismatch', name);
    if (pkg.resolved !== `https://registry.npmjs.org/${name}/-/${name.slice(9)}-${version}.tgz`) refuse('lock_non_registry', name);
    seen.add(name);
  }
  for (const name of expected.keys()) if (!seen.has(name)) refuse('lock_package_missing', name);
  identity = { schemaVersion: 2, mode, setVersion: version, sourceRevision: revision, sourceRevisionVerification: verification,
    ...(mode === 'reconstructed' ? { reason: options.get('--reason') } : {}), lockfileSha256: hash(lockBytes) };
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
if (mode) {
  await writeFile(resolve(target, 'package.json'), JSON.stringify(application, null, 2) + '\n');
  await writeFile(resolve(target, '.gitignore'), (await readFile(resolve(target, '.gitignore'), 'utf8')).replace(/^package-lock\.json\r?\n/gm, ''));
  // Both are generated identities, excluded from upgrade snapshots; retain them in Git.
  await writeFile(resolve(target, 'package-lock.json'), lockBytes);
  const content = [];
  for (const path of [...files].sort()) if (!['package-lock.json', '.starter-origin.json'].includes(path)) content.push([path, hash(await readFile(resolve(target, path)))]);
  identity.contentSha256 = hash(JSON.stringify(content));
}
await writeFile(resolve(target, '.starter-origin.json'), JSON.stringify(identity ?? {
  schemaVersion: 1, kind: provenance.kind, setVersion: provenance.setVersion,
  sourceRevision: provenance.sourceRevision,
}, null, 2) + '\n');
if (mode) {
  execFileSync('git', ['add', '.'], { cwd: target, stdio: 'pipe' });
  execFileSync('git', ['add', '--force', 'package-lock.json', '.starter-origin.json'], { cwd: target, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Starter extraction', '-c', 'user.email=starter@localhost', '-c', 'commit.gpgsign=false',
    'commit', '-m', `Extract ${mode} starter ${identity.setVersion}`], { cwd: target, stdio: 'pipe' });
}
process.stdout.write(`Created independent application: ${relative(process.cwd(), target) || '.'}\n`);
process.stdout.write(mode ? 'Read README.md before installing. Artifact qualification requires separate evidence.\n'
  : 'Read README.md before installing. Local candidates are not published releases.\n');
