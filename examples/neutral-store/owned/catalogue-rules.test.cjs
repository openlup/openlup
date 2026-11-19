const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('draft titles are required', async () => {
  const { loadCatalogRules } = await import('@openlup/platform/catalog');
  const rules = loadCatalogRules(readFileSync(join(__dirname, 'catalogue-rules.cjs')));
  assert.deepEqual(rules.validateContent({ title: 'Fictional item' }), []);
  assert.deepEqual(rules.validateContent({ title: '' }), [{ path: 'title', code: 'title_required' }]);
  assert.deepEqual(rules.validateContent({ schemaVersion: 1, presentation: { title: 'Fictional item' } }), []);
  assert.deepEqual(rules.validateContent({ schemaVersion: 1, presentation: {} }), [{ path: 'presentation.title', code: 'title_required' }]);
});
