import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareDigests, edgeFindings, parseArguments, rollbackDecision, hostHeaders, commandReference, replayReference, compareDataSnapshots } from './prove.mjs';

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


test('data rollback parses only the two required application and scratch arguments', () => {
  assert.deepEqual(parseArguments(['data-rollback', '/app', '/scratch']), { command: 'data-rollback', values: ['/app', '/scratch'] });
  for (const args of [['data-rollback'], ['data-rollback', '/app'], ['data-rollback', '/app', '/scratch', '/extra']]) {
    assert.throws(() => parseArguments(args), /usage:/u);
  }
});

test('configured Host construction preserves authority, including a loopback transport with another authority', () => {
  assert.deepEqual(hostHeaders('http://localhost:49321'), { Host: 'localhost:49321' });
  assert.deepEqual(hostHeaders('https://store.example.test'), { Host: 'store.example.test' });
  assert.deepEqual(hostHeaders('http://[::1]:49321'), { Host: '[::1]:49321' });
  for (const origin of ['bad', 'ftp://localhost:49321', 'http://user@localhost:49321',
    'http://localhost:49321/path', 'http://localhost:49321?x', 'http://localhost:49321#x', 'http://LOCALHOST:49321']) {
    assert.throws(() => hostHeaders(origin), /public_origin_invalid/u);
  }
});

test('command replay requires a successful original reference and explicit replay evidence', () => {
  const reference = 'acquisition-case:00000000-0000-4000-8000-000000000001';
  const response = { ok: true, value: { caseRef: reference }, replayed: true };
  assert.equal(commandReference(response), reference);
  assert.equal(replayReference(reference, response), reference);
  for (const bad of [{ ...response, ok: false }, {}, { ok: true, value: { caseRef: '' } },
    { ok: true, value: { caseRef: 1 } }, { ok: true, value: { caseRef: 'other' } }]) {
    assert.throws(() => replayReference(reference, bad), /command_reference_invalid/u);
  }
  assert.throws(() => replayReference(reference + 'x', response), /command_replay_mismatch/u);
  assert.throws(() => replayReference(undefined, response), /command_replay_mismatch/u);
  assert.throws(() => replayReference(reference, { ...response, replayed: false }), /command_replay_mismatch/u);
  assert.throws(() => replayReference(reference, { ...response, replayed: undefined }), /command_replay_mismatch/u);
});

test('data snapshots refuse every ledger, catalogue and record-count mismatch', () => {
  const original = { ledgerCount: 95, ledgerHash: 'a'.repeat(64), catalogue: { products: 3, skus: 3, priceLists: 1, prices: 3 }, records: 1 };
  assert.equal(compareDataSnapshots(original, { ...original, records: 2 }, 2), true);
  for (const field of ['ledgerCount', 'ledgerHash']) {
    const changed = { ...original, [field]: field === 'ledgerCount' ? 96 : 'b'.repeat(64) };
    assert.throws(() => compareDataSnapshots(original, changed, 1), /migration_ledger_changed/u);
  }
  for (const field of Object.keys(original.catalogue)) {
    assert.throws(() => compareDataSnapshots(original, { ...original, catalogue: { ...original.catalogue, [field]: 4 } }, 1), /catalogue_count_changed/u);
  }
  assert.throws(() => compareDataSnapshots(original, { ...original, records: 2 }, 1), /record_count_mismatch/u);
  for (const bad of [null, {}, { ...original, ledgerCount: 0 }, { ...original, ledgerCount: 1.5 },
    { ...original, ledgerHash: 'bad' }, { ...original, records: -1 }, { ...original, records: 1.5 },
    { ...original, catalogue: {} }, { ...original, catalogue: { ...original.catalogue, prices: 0 } },
    { ...original, catalogue: { ...original.catalogue, extra: 1 } }]) {
    assert.throws(() => compareDataSnapshots(original, bad, 1), /data_snapshot_invalid/u);
    assert.throws(() => compareDataSnapshots(bad, original, 1), /data_snapshot_invalid/u);
  }
  for (const expected of [-1, 0.5, undefined]) assert.throws(() => compareDataSnapshots(original, original, expected), /record_count_mismatch/u);
});
