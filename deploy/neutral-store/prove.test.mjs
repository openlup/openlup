import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareDigests, edgeFindings, parseArguments, rollbackDecision } from './prove.mjs';

const a = 'sha256:' + 'a'.repeat(64);
const b = 'sha256:' + 'b'.repeat(64);
const c = 'sha256:' + 'c'.repeat(64);

test('digest comparison requires an actual changed image and exact original return', () => {
  assert.equal(compareDigests(a, b, a).equalToOriginal, true);
  assert.throws(() => compareDigests(a, a, a), /image_change_not_observed/u);
  assert.throws(() => compareDigests(a, b, c), /original_image_not_restored/u);
  for (const value of ['latest', a.toUpperCase(), a.slice(0, -1), undefined, 1]) {
    assert.throws(() => compareDigests(value, b, a), /image_digest_invalid/u);
  }
});

test('argument parsing refuses missing, extra and unknown command arguments', () => {
  assert.deepEqual(parseArguments(['digest', a, b, a]), { command: 'digest', values: [a, b, a] });
  assert.deepEqual(parseArguments(['edge', '/checkout']), { command: 'edge', values: ['/checkout'] });
  assert.deepEqual(parseArguments(['rollback', '/app', '/scratch']), { command: 'rollback', values: ['/app', '/scratch'] });
  for (const args of [[], ['unknown'], ['edge'], ['edge', '/a', '/b'], ['rollback', '/a'], ['digest', a, b], ['digest', a, b, a, c]]) {
    assert.throws(() => parseArguments(args), /usage:/u);
  }
});

test('rollback decision refuses unhealthy, missing, reordered or wrong-image observations', () => {
  const rows = [{ phase: 'A', image: a, healthy: true }, { phase: 'B', image: b, healthy: true },
    { phase: 'A-restored', image: a, healthy: true }];
  assert.match(rollbackDecision(rows).limitation, /Image rollback only/u);
  for (const index of [0, 1, 2]) {
    assert.throws(() => rollbackDecision(rows.map((row, i) => i === index ? { ...row, healthy: false } : row)), /image_health_or_sequence_invalid/u);
  }
  assert.throws(() => rollbackDecision(rows.slice(1)), /image_health_or_sequence_invalid/u);
  assert.throws(() => rollbackDecision([rows[1], rows[0], rows[2]]), /image_health_or_sequence_invalid/u);
  assert.throws(() => rollbackDecision([...rows.slice(0, 2), { ...rows[2], image: c }]), /original_image_not_restored/u);
});

test('Edge scan requires zero matches and refuses planted imports and hooks', () => {
  assert.deepEqual(edgeFindings([{ path: 'host.ts', contents: "import { createServer } from 'node:http';" }]), []);
  const planted = [
    ["import { next } from '@vercel/edge';", 'edge-import'],
    ["export * from 'edge-runtime';", 'edge-import'],
    ["const ready = true; import 'edge-runtime';", 'edge-import'],
    ['export const config = { "runtime": "nodejs" };', 'function-config'],
    ['const config = { crons: [] };', 'function-hook'],
    ["import {\n  EdgeVM\n} from '@edge-runtime/vm';", 'edge-import'],
    ['{"runtime": "edge"}', 'edge-runtime'],
    ['{"functions": {}}', 'function-hook'],
    ["const x = require('@scope/edge-runtime');", 'edge-import'],
    ["await import('@vercel/edge/config');", 'edge-import'],
    ['export const runtime = "edge";', 'edge-runtime'],
    ['export const config = { runtime: "nodejs" };', 'function-config'],
    ['export const config = {\n  runtime: "edge"\n};', 'function-config'],
    ['export function onSchedule() {}', 'function-hook'],
    ['const deployHooks = [];', 'function-hook'],
    ['{"crons": []}', 'function-hook'],
  ];
  for (const [contents, rule] of planted) {
    const findings = edgeFindings([{ path: 'planted.ts', contents }]);
    assert.ok(findings.some(row => row.path === 'planted.ts' && row.rule === rule), contents);
  }
});
