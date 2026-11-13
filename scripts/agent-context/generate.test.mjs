import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { extractSection, generateCorpus, routes, run } from './generate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('section extraction preserves nested headings and ignores fenced headings', () => {
  const source = '# Owner\n\n## Task\n\n```md\n## Fake boundary\n```\n### Detail\nText\n\n## Next\nOther\n';
  assert.deepEqual(extractSection(source, 'Task'), {
    excerpt: '## Task\n\n```md\n## Fake boundary\n```\n### Detail\nText\n\n', startLine: 3, endLine: 10,
  });
  assert.equal(extractSection('## Task\nNo final newline', 'Task').excerpt, '## Task\nNo final newline');
  assert.throws(() => extractSection('## Task\n## Task\n', 'Task'), /found 2/u);
  assert.throws(() => extractSection('## Other\n', 'Task'), /found 0/u);
  assert.deepEqual(extractSection('## Task\nKeep.\n\nOmit this paragraph.\n', 'Task', 'Omit this'), {
    excerpt: '## Task\nKeep.\n\n', startLine: 1, endLine: 3,
  });
  assert.throws(() => extractSection('## Task\nKeep.\n', 'Task', 'Missing'), /paragraph boundary/u);
});

test('all checked-in corpora are current and every citation binds exact source bytes', () => {
  run(root, true);
  for (const packageName of Object.keys(routes)) {
    const corpus = generateCorpus(root, packageName);
    const records = [...corpus.matchAll(/<!-- openlup-context (.+) -->\n([\s\S]*?)<!-- \/openlup-context -->/gu)];
    assert.equal(records.length, routes[packageName].length);
    const inventory = JSON.parse(corpus.match(/<!-- openlup-context-inventory (.+) -->/u)[1]);
    assert.deepEqual(inventory, records.map((record) => JSON.parse(record[1])));
    assert.equal(new Set(inventory.map((entry) => entry.id)).size, inventory.length);
    for (const [, json, excerpt] of records) {
      const metadata = JSON.parse(json);
      const originalSource = routes[packageName].find((route) => route[0] === metadata.id)[2];
      const localPrefix = `packages/${packageName}/`;
      const version = JSON.parse(readFileSync(resolve(root, `packages/${packageName}/package.json`), 'utf8')).version;
      const expected = originalSource.startsWith(localPrefix) ? originalSource.slice(localPrefix.length)
        : `https://github.com/openlup/openlup/blob/openlup-${packageName}-v${version}/${originalSource}`;
      assert.equal(metadata.source, expected);
      const target = expected.startsWith('https:') ? `${expected}#L${metadata.startLine}-L${metadata.endLine}` : expected;
      assert.ok(corpus.includes(`](${target})`));
      const lines = readFileSync(resolve(root, originalSource), 'utf8').split('\n');
      assert.equal(excerpt, lines.slice(metadata.startLine - 1, metadata.endLine).join('\n') + '\n');
      assert.equal(createHash('sha256').update(excerpt).digest('hex'), metadata.sha256);
    }
  }
});

test('freshness check refuses source drift and missing corpus without writing', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'openlup-agent-corpus-'));
  try {
    const owners = new Set(Object.values(routes).flat().map((route) => route[2]));
    for (const source of owners) {
      mkdirSync(dirname(resolve(temporary, source)), { recursive: true });
      writeFileSync(resolve(temporary, source), readFileSync(resolve(root, source)));
    }
    for (const packageName of Object.keys(routes)) {
      mkdirSync(resolve(temporary, 'packages', packageName), { recursive: true });
      writeFileSync(resolve(temporary, `packages/${packageName}/package.json`), readFileSync(resolve(root, `packages/${packageName}/package.json`)));
    }
    assert.throws(() => run(temporary, true), /Stale agent context/u);
    run(temporary);
    run(temporary, true);
    const corpusPath = resolve(temporary, 'packages/core/AGENT_CONTEXT.md');
    const before = readFileSync(corpusPath, 'utf8');
    const [, , source, heading] = routes.core[0];
    const owner = resolve(temporary, source);
    const original = readFileSync(owner, 'utf8');
    const ownerHeading = original.split('\n').find((line) => /^#{1,6} /u.test(line) && line.slice(line.indexOf(' ') + 1) === heading);
    assert.ok(ownerHeading);
    writeFileSync(owner, original.replace(`${ownerHeading}\n`, `${ownerHeading}\nChanged owner guidance.\n`));
    assert.throws(() => run(temporary, true), /packages\/core\/AGENT_CONTEXT.md/u);
    assert.equal(readFileSync(corpusPath, 'utf8'), before);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('unshipped package owners use release links and version changes stale the corpus', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'openlup-agent-source-'));
  try {
    for (const source of new Set(routes.core.map(route => route[2]))) {
      mkdirSync(dirname(resolve(temporary, source)), { recursive: true });
      writeFileSync(resolve(temporary, source), readFileSync(resolve(root, source)));
    }
    const manifest = resolve(temporary, 'packages/core/package.json');
    writeFileSync(manifest, JSON.stringify({ version: '0.99.0', files: ['README.md'] }));
    const corpus = generateCorpus(temporary, 'core');
    assert.match(corpus, /https:\/\/github.com\/openlup\/openlup\/blob\/openlup-core-v0\.99\.0\/packages\/core\/docs\/guide\/concepts\/subscription-engine\.md/u);
    assert.match(corpus, /not required application files or aliases/u);
    writeFileSync(manifest, JSON.stringify({ version: '0.99.1', files: ['README.md'] }));
    assert.notEqual(generateCorpus(temporary, 'core'), corpus);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
