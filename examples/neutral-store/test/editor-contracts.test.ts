import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

test('starter editor host and browser consumers fit the selected public package contracts', () => {
  const root = fileURLToPath(new URL('../',import.meta.url));
  const configuration = ts.readConfigFile(root+'tsconfig.json',ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configuration.config,ts.sys,root);
  const files = ['host/subscription-editors.ts','host/editor-ports.ts','host/editor-mail.ts','installation/install.ts','owned/store.config.ts',
    'client/pages/classic-editor.ts','client/pages/sized-editor.ts','client/editors/entries.ts',
    'browser/editor-components.spec.ts','browser/subscription-journeys.spec.ts','browser/subscription-api.spec.ts',
    'playwright.editors.config.ts','playwright.database.config.ts'].map(path => root+path);
  const program = ts.createProgram(files,parsed.options);
  const errors = ts.getPreEmitDiagnostics(program);
  assert.equal(errors.length,0,ts.formatDiagnosticsWithColorAndContext(errors,{ getCurrentDirectory: () => root,getCanonicalFileName: path => path,getNewLine: () => '\n' }));
});
