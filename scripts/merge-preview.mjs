// Local prediction, never a hosted receipt: check the actual combined tree
// before spending build/coverage/DB time. No generator registry or result cache.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';

const SHA = /^[a-f0-9]{40}$/u;
function git(cwd, args) {
  return execFileSync('/usr/bin/git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: 30000,
    env: { PATH: processEnvironment.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null', GIT_SHALLOW_FILE: '/dev/null',
      GIT_AUTHOR_NAME: 'Local merge preview', GIT_AUTHOR_EMAIL: 'preview@example.invalid', GIT_COMMITTER_NAME: 'Local merge preview', GIT_COMMITTER_EMAIL: 'preview@example.invalid' },
  }).trim();
}
export function checkMergePreview({ cwd, target = 'origin/main', checks = [
  [process.execPath, '--experimental-strip-types', 'scripts/oss-published-tree-check.ts', '--policy'],
  [process.execPath, '--experimental-strip-types', 'scripts/oss-published-tree-check.ts', '--inventory'],
] }) {
  const base = git(cwd, ['rev-parse', '--verify', `${target}^{commit}`]);
  const head = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const sourceTree = git(cwd, ['rev-parse', '--verify', 'HEAD^{tree}']);
  if (![base, head, sourceTree].every(value => SHA.test(value))) throw new Error('merge-preview: invalid comparison identity');
  const objects = join(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'objects');
  if (/[\r\n]/u.test(objects)) throw new Error('merge-preview: object store path cannot be represented safely');
  const directory = mkdtempSync(join(tmpdir(), 'openlup-merge-preview-'));
  try {
    git(directory, ['init', '-q']);
    mkdirSync(join(directory, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(join(directory, '.git', 'objects', 'info', 'alternates'), `${resolve(objects)}\n`);
    let tree;
    try { tree = git(directory, ['-c', 'merge.renames=false', '-c', 'merge.directoryRenames=false', 'merge-tree', '--write-tree', base, head]); }
    catch (error) {
      const conflicts = String(error.stdout ?? '').split('\n').filter(line => /^CONFLICT /u.test(line));
      throw new Error(`merge-preview: cannot merge ${base} and ${head}; merge main into this branch, resolve and regenerate, then obtain the required fresh review. ${conflicts.join(' ')}`);
    }
    if (!SHA.test(tree)) throw new Error('merge-preview: prediction did not produce one tree');
    if (tree === sourceTree) return { base, head, tree, basis: 'unchanged tree' };
    const merged = git(directory, ['commit-tree', tree, '-p', base, '-p', head, '-m', 'Local merge preview; not for publication']);
    git(directory, ['checkout', '-q', '--detach', merged]);
    const env = { ...processEnvironment };
    for (const name of Object.keys(env)) if (/^(?:GITHUB_|GIT_|GH_)/u.test(name) || name === 'OPENLUP_STACK_BASE') delete env[name];
    for (const [command, ...args] of checks) {
      const run = spawnSync(command, [...args, '--docs-base', base], { cwd: directory, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
      if (run.error || run.status !== 0) throw new Error(`merge-preview: combined tree failed ${args.join(' ')}\n${run.error?.message ?? run.stderr ?? ''}\n${run.stdout ?? ''}`);
    }
    return { base, head, tree, basis: 'combined policy and inventory passed' };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
