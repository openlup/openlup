import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { beforeAll, expect, it, vi } from 'vitest';
import { postgresSetupTimeoutMs, runPostgresContainer } from '../helpers/postgresContainer.js';
import { pullWithRetry, readCiImage } from '../../scripts/ci-image-pull.mjs';

type Mount = { Type: string; Name?: string; Destination: string };
const observation = vi.hoisted(() => ({ runs: 0, volumes: [] as string[], failure: '' }));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execute = promisify(actual.execFile);
  const wrapped = vi.fn(actual.execFile);
  Object.defineProperty(wrapped, promisify.custom, {
    value: (file: string, args: string[], options: import('node:child_process').ExecFileOptions = {}) => {
      const pending = execute(file, args, { ...options, encoding: 'utf8' });
      return Object.assign(pending.then(async result => {
        if (file === 'docker' && args[0] === 'run') {
          const name = args[args.indexOf('--name') + 1];
          const inspected = await execute(file, ['inspect', name, '--format', '{{json .Mounts}}']);
          const mounts = JSON.parse(inspected.stdout) as Mount[];
          observation.volumes.push(...mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name!));
          observation.runs++;
          // Real daemon state, with only the client outcome injected: a failed
          // run can leave a created container and volume for cleanup to remove.
          if (observation.runs === 1 && observation.failure) throw new Error(observation.failure);
        }
        return result;
      }), { child: pending.child });
    },
  });
  return { ...actual, execFile: wrapped };
});

const { execFile: realExecFile } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const execute = promisify(realExecFile);
const docker = (...args: string[]) => execute('docker', args, { timeout: 30_000 });
async function mounts(name: string): Promise<Mount[]> {
  return JSON.parse((await docker('inspect', name, '--format', '{{json .Mounts}}')).stdout);
}

let fixtureImage: string;
beforeAll(async () => {
  fixtureImage = await pullWithRetry(readCiImage('test-postgres'));
}, postgresSetupTimeoutMs);

it.each(['normal', 'bind conflict', 'other error'] as const)(
  'cleans only its anonymous volumes through %s cleanup', async mode => {
    const name = `openlup-cleanup-${randomUUID()}`;
    const retained = `${name}-named`;
    const other = `${name}-control`;
    const anonymous = new Set<string>();
    observation.runs = 0;
    observation.volumes = [];
    observation.failure = mode === 'normal' ? '' : mode === 'bind conflict'
      ? 'port is already allocated' : 'synthetic non-bind run failure';
    try {
      // All resources, including the pre-start collision, belong to this test.
      await docker('volume', 'create', retained);
      await docker('create', '--name', name, '-v', `${retained}:/retained`, fixtureImage);
      const image = (await docker('inspect', name, '--format', '{{.Image}}')).stdout.trim();
      for (const mount of await mounts(name)) {
        if (mount.Type === 'volume' && mount.Name !== retained) anonymous.add(mount.Name!);
      }
      expect(anonymous.size).toBe(1);
      await docker('create', '--name', other, image);
      const otherMounts = await mounts(other);

      const pending = runPostgresContainer({ name, image, password: 'synthetic-cleanup-only' });
      if (mode === 'other error') await expect(pending).rejects.toMatchObject({
        cause: expect.objectContaining({ message: 'synthetic non-bind run failure' }),
      });
      else await (await pending).remove();

      expect(observation.runs).toBe(mode === 'bind conflict' ? 2 : 1);
      for (const volume of observation.volumes) anonymous.add(volume);
      for (const volume of anonymous) await expect(docker('volume', 'inspect', volume)).rejects.toThrow();
      await expect(docker('inspect', name)).rejects.toThrow();
      await expect(docker('volume', 'inspect', retained)).resolves.toBeDefined();
      expect(await mounts(other)).toEqual(otherMounts);
    } finally {
      // Explicit recovery also makes a predecessor's failing witness residue-free.
      for (const volume of observation.volumes) anonymous.add(volume);
      for (const container of [name, other]) await docker('rm', '-f', '-v', container).catch(() => {});
      for (const volume of [...anonymous, retained]) await docker('volume', 'rm', volume).catch(() => {});
    }
  }, 90_000,
);
