import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { env as processEnvironment } from 'node:process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { excludedToolingTests, scopeFromEvent, scopeFromLocal, TOOLING_INPUTS, writeTestScope } from './ci-test-scope.mjs';

const base = 'a'.repeat(40);
const all = Object.keys(TOOLING_INPUTS).sort();
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function scratch() { const path = mkdtempSync(join(tmpdir(), 'ci-test-scope-')); directories.push(path); return path; }

describe('conservative tooling scope', () => {
  it('excludes only declared fixtures on a product change, retaining tree scanners and lint inputs', () => {
    const excluded = excludedToolingTests(['src/pages/account/example.tsx']);
    expect(excluded).toEqual(all.filter(test => !test.endsWith('eslint-import-map.test.ts')));
    for (const file of ['agent-review-session', 'source-preview-release', 'public-ci-neutrality', 'oss-published-tree-check']) {
      expect(excluded).not.toContain(`scripts/${file}.test.ts`);
    }
    expect(excludedToolingTests(['server/runtime/outbox/candidateAdmission.ts']))
      .toEqual(all.filter(test => !test.endsWith('outbox-consumer-proof.test.ts') && !test.endsWith('eslint-import-map.test.ts')));
    expect(excludedToolingTests(['packages/core/src/index.ts']))
      .toEqual(Object.entries(TOOLING_INPUTS).filter(([, inputs]) => !inputs.includes('packages/')).map(([test]) => test).sort());
  });
  it.each(['package.json', 'package-lock.json', 'vitest.config.ts', 'scripts/run-vitest.mjs',
    'scripts/ci-test-scope.mjs', 'scripts/ci-test-scope.test.ts', '.github/workflows/any.yml',
    '.github/actions/example/action.yml',
    'eslint.config.js', '.nvmrc', 'scripts/packages/new-helper.ts', 'tests/setup/scrub-git-env.ts',
    'src/test/setup.ts', 'src/checkout/machine/commerceRequestCache.ts',
    // Dot segments anywhere and hidden root folders: glob '*'/'**' would skip them.
    '.husky/pre-commit', 'scripts/.x', 'tests/setup/.env', 'src/test/.x', 'packages/core/.gitignore',
    'packages/platform/src/.npmignore', 'packages/core/.github/workflows/ci.yml'])(
    'runs everything for shared input %s', path => { expect(excludedToolingTests([path])).toEqual([]); },
  );
  it('excludes bounded tooling tests for docs and unrelated config changes', () => {
    expect(excludedToolingTests(['docs/platform/README.md'])).toEqual(all);
    expect(excludedToolingTests(['config/doc-routing.json'])).toEqual(all);
    expect(excludedToolingTests(['config/openlup-packages.json'])).toEqual(all.filter(test =>
      !['outbox-consumer-proof', 'package-manifest-policy', 'package-size-policy', 'packages-check'].some(name => test.endsWith(`${name}.test.ts`))));
  });
  it.each(Object.entries(TOOLING_INPUTS).flatMap(([test, inputs]) => inputs.map(input => [test, input] as const)))(
    'runs %s when its declared input %s changes', (test, input) => {
      expect(excludedToolingTests([input.endsWith('/') ? `${input}scope-witness.ts` : input])).not.toContain(test);
    },
  );
  it.each(['push', 'workflow_dispatch', 'unknown', undefined])('runs everything for event %s', eventName => {
    expect(scopeFromEvent({ eventName, event: { pull_request: { base: { sha: base } } }, git: () => { throw new Error('must not run'); } })).toEqual([]);
  });
  it('runs everything for git failure, missing or malformed base and malformed output', () => {
    const event = { pull_request: { base: { sha: base } } };
    expect(scopeFromEvent({ eventName: 'pull_request', event, git: () => { throw new Error('missing history'); } })).toEqual([]);
    for (const value of [undefined, '', '--help', 'main']) {
      expect(scopeFromEvent({ eventName: 'pull_request', event: { pull_request: { base: { sha: value } } } })).toEqual([]);
    }
    expect(scopeFromEvent({ eventName: 'pull_request', event, git: () => 'invalid' })).toEqual([]);
    expect(scopeFromEvent({ eventName: 'pull_request', event, git: args => args[0] === 'merge-base' ? base : 'src/a.ts' })).toEqual([]);
  });
  it('uses the event merge-base, includes deletions and both rename paths, and produces identical shard input', () => {
    const cwd = scratch();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
    git('init', '-q'); writeFileSync(join(cwd, 'source.ts'), 'before'); git('add', '.'); git('commit', '-qm', 'base');
    const before = git('rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'source.ts'), 'base moves ahead'); git('add', '.'); git('commit', '-qm', 'base ahead');
    const ahead = git('rev-parse', 'HEAD'); git('checkout', '-q', '--detach', before);
    // Product-only candidate. Base-only root changes must not trigger everything.
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src/product.ts'), 'product'); git('add', '.'); git('commit', '-qm', 'product');
    const pr = { eventName: 'pull_request', event: { pull_request: { base: { sha: ahead } } }, cwd };
    const selected = scopeFromEvent(pr);
    expect(selected).toEqual(excludedToolingTests(['src/product.ts']));
    expect(selected.length).toBeGreaterThan(0);
    for (let shard = 1; shard <= 4; shard++) expect(scopeFromEvent(pr)).toEqual(selected);
    expect(scopeFromEvent({ eventName: 'merge_group', event: { merge_group: { base_sha: ahead } }, cwd })).toEqual(selected);
    git('mv', 'source.ts', 'src/moved.ts'); git('commit', '-qm', 'rename root trigger');
    expect(scopeFromEvent(pr)).toEqual([]);
    git('reset', '--hard', 'HEAD~1'); git('rm', 'source.ts'); git('commit', '-qm', 'delete root trigger');
    expect(scopeFromEvent(pr)).toEqual([]);
  });
  it('clears stale exclusions on unreadable or unknown events and actual git failure', () => {
    const cwd = scratch(), output = join(cwd, 'exclude.txt'), eventPath = join(cwd, 'event.json');
    for (const eventName of ['pull_request', 'workflow_dispatch']) {
      writeFileSync(output, 'stale.test.ts\n');
      writeTestScope({ output, eventName, eventPath, cwd }); expect(readFileSync(output, 'utf8')).toBe('');
      writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: base } } }));
      writeFileSync(output, 'stale.test.ts\n');
      writeTestScope({ output, eventName, eventPath, cwd }); expect(readFileSync(output, 'utf8')).toBe('');
      rmSync(eventPath);
    }
  });
});

describe('local scope', () => {
  function fixture() {
    const cwd = scratch();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
    git('init', '-q');
    for (const directory of ['docs', 'src', 'packages/core']) mkdirSync(join(cwd, directory), { recursive: true });
    writeFileSync(join(cwd, 'docs/guide.md'), 'base');
    writeFileSync(join(cwd, 'packages/core/input.ts'), 'base');
    git('add', '.'); git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    return { cwd, git };
  }
  it('defaults to origin/main, includes committed changes from the merge-base, and writes the exclusion file', () => {
    const { cwd, git } = fixture(), output = join(scratch(), 'exclude.txt');
    expect(scopeFromLocal({ cwd })).toEqual(all);
    writeFileSync(join(cwd, 'src/product.ts'), 'product'); git('add', '.'); git('commit', '-qm', 'product');
    expect(scopeFromLocal({ cwd })).toEqual(excludedToolingTests(['src/product.ts']));
    expect(writeTestScope({ cwd, output })).toEqual(excludedToolingTests(['src/product.ts']));
    expect(readFileSync(output, 'utf8')).toBe(`${excludedToolingTests(['src/product.ts']).join('\n')}\n`);
    // Explicit --base selects local mode even in a GitHub environment.
    expect(writeTestScope({ cwd, output, base: 'HEAD', eventName: 'push' })).toEqual(all);
  });
  it('includes unstaged, staged, cancelled working-file edits, deletion and rename paths', () => {
    const { cwd, git } = fixture();
    writeFileSync(join(cwd, 'packages/core/input.ts'), 'dirty');
    const expected = excludedToolingTests(['packages/core/input.ts']);
    expect(scopeFromLocal({ cwd })).toEqual(expected);
    git('add', '.'); expect(scopeFromLocal({ cwd })).toEqual(expected);
    writeFileSync(join(cwd, 'packages/core/input.ts'), 'base');
    expect(scopeFromLocal({ cwd })).toEqual(expected);
    git('reset', '--hard', 'HEAD'); git('mv', 'packages/core/input.ts', 'docs/moved.md');
    expect(scopeFromLocal({ cwd })).toEqual(expected);
    git('reset', '--hard', 'HEAD'); rmSync(join(cwd, 'packages/core/input.ts'));
    expect(scopeFromLocal({ cwd })).toEqual(expected);
  });
  it('includes untracked inputs and refuses to scope on every Git error or malformed output', () => {
    const { cwd } = fixture();
    writeFileSync(join(cwd, 'packages/core/new.ts'), 'untracked');
    expect(scopeFromLocal({ cwd })).toEqual(excludedToolingTests(['packages/core/new.ts']));
    expect(scopeFromLocal({ cwd, base: 'missing-ref' })).toEqual([]);
    for (let fail = 0; fail < 5; fail++) {
      let call = 0;
      expect(scopeFromLocal({ git: () => { if (call++ === fail) throw new Error('git failed'); return call === 1 ? base : ''; } })).toEqual([]);
    }
    expect(scopeFromLocal({ git: () => 'malformed' })).toEqual([]);
    expect(scopeFromLocal({ git: args => args[0] === 'merge-base' ? base : 'src/missing-nul.ts' })).toEqual([]);
    const output = join(scratch(), 'exclude.txt'); writeFileSync(output, 'stale.test.ts');
    expect(writeTestScope({ cwd, output, base: 'missing-ref' })).toEqual([]);
    expect(readFileSync(output, 'utf8')).toBe('');
  });
  it('accepts --base through the CLI and uses local defaults without GitHub event env', () => {
    const { cwd } = fixture(), output = join(scratch(), 'exclude.txt');
    const env = { ...processEnvironment, OPENLUP_VITEST_EXCLUDE_FILE: output };
    delete env.GITHUB_EVENT_NAME; delete env.GITHUB_EVENT_PATH;
    const script = join(process.cwd(), 'scripts/ci-test-scope.mjs');
    for (const args of [[], ['--base', 'HEAD']]) {
      execFileSync(process.execPath, [script, ...args], { cwd, env });
      expect(readFileSync(output, 'utf8')).toBe(`${all.join('\n')}\n`);
    }
  });
});
