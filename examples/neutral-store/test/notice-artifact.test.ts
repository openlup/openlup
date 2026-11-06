import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createPrivateCapture } from '../host/private-capture.ts';
import { createNoticeArtifacts, noticeKinds, type NoticeArtifactV1 } from '../host/notice-artifact.ts';

const application = fileURLToPath(new URL('../', import.meta.url));
async function fixture(work: (directory: string) => Promise<void>) {
  const scratch = join(application, '.context');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(scratch, 'notice-artifact-'));
  try {
    const ignored = spawnSync('git', ['check-ignore', directory], { cwd: application, encoding: 'utf8' });
    assert.equal(ignored.status, 0, 'the developer mailbox must be git ignored');
    await work(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function message(kind: NoticeArtifactV1['kind']): NoticeArtifactV1 {
  const token = ['payment_failed', 'payment_expired', 'payment_recovery'].includes(kind)
    ? randomBytes(32).toString('base64url') : null;
  const noticeId = randomUUID();
  return { schemaVersion: 1, kind, messageKey: `subscription-notice:dunning:${noticeId}`,
    noticeId, subscriptionId: randomUUID(), clientId: randomUUID(),
    caseId: token ? randomUUID() : null, orderId: token ? randomUUID() : null,
    operationId: token ? randomUUID() : null, obligationId: token ? randomUUID() : null,
    token, recoveryUrl: token ? `http://localhost:4319/account/payment/recover?token=${token}` : null,
    expiresAt: token ? '2030-01-01T00:00:00.000000Z' : null,
    recipient: 'mailbox@example.test', recipientReference: 'client:example', templateReference: 'template:example:en',
    subject: 'Example notice', body: 'Private rendered message', locale: 'en' };
}

test('every notice kind round trips through one private schema without replacing existing content', async () => {
  await fixture(async directory => {
    const capture = createNoticeArtifacts(createPrivateCapture(directory));
    for (const kind of noticeKinds) {
      const record = message(kind), key = record.messageKey;
      await capture.writeOnce(key, record);
      assert.equal(isDeepStrictEqual(await capture.read(key), record), true);
      const path = join(directory, createHash('sha256').update(key).digest('hex') + '.json');
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      const bytes = await readFile(path);
      await capture.writeOnce(key, record);
      await assert.rejects(capture.writeOnce(key, { ...record, clientId: randomUUID() }), /starter_private_capture_unavailable/);
      assert.equal((await readFile(path)).equals(bytes), true, 'changed context must never replace the artifact');
    }
    assert.equal(await capture.read('missing-artifact'), null);
  });
});

test('unknown kinds, versions and message identities refuse on both write and read', async () => {
  await fixture(async directory => {
    const privateCapture = createPrivateCapture(directory), capture = createNoticeArtifacts(privateCapture);
    for (const delta of [{ kind: 'unknown' }, { schemaVersion: 2 }, { messageKey: 'different' }]) {
      const record = message('payment_recovery'), invalid = { ...record, ...delta };
      await assert.rejects(capture.writeOnce(record.messageKey, invalid as NoticeArtifactV1), /starter_notice_identity_unavailable/);
      await privateCapture.writeOnce(record.messageKey, invalid);
      await assert.rejects(capture.read(record.messageKey), /starter_notice_identity_unavailable/);
    }
  });
});

test('restart and refusal output contains no captured URL, token or email', async () => {
  await fixture(async directory => {
    const record = message('payment_recovery');
    await createNoticeArtifacts(createPrivateCapture(directory)).writeOnce(record.messageKey, record);
    const script = `
      import {readFileSync} from 'node:fs';
      import {createPrivateCapture} from ${JSON.stringify(new URL('../host/private-capture.ts', import.meta.url).href)};
      import {createNoticeArtifacts} from ${JSON.stringify(new URL('../host/notice-artifact.ts', import.meta.url).href)};
      const input=JSON.parse(readFileSync(0,'utf8'));
      const capture=createNoticeArtifacts(createPrivateCapture(input.directory));
      if (!(await capture.read(input.record.messageKey))) throw new Error('readback_required');
      for (const delta of [{body:'different'},{kind:'unknown'},{schemaVersion:2}]) {
        try {await capture.writeOnce(input.record.messageKey,{...input.record,...delta});}
        catch(error) {process.stderr.write(error.message+'\\n');}
      }
    `;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script],
      { encoding: 'utf8', input: JSON.stringify({ directory, record }) });
    const output = child.stdout + child.stderr;
    assert.equal(child.status, 0, 'process restart must read the original artifact');
    for (const value of [record.token!, record.recoveryUrl!, record.recipient, record.body]) {
      assert.equal(output.includes(value), false, 'captured material must stay out of process output');
    }
  });
});
