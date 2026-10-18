import { beforeEach, expect, it, vi } from 'vitest';
const { store, create } = vi.hoisted(() => {
  const store = { bootstrapFirstAdministrator: vi.fn(async () => ({ principalId: '11111111-1111-4111-8111-111111111111', membershipState: 'invited' })), pruneChallenges: vi.fn(async () => ({ deleted: 1 })), close: vi.fn(async () => {}) };
  return { store, create: vi.fn(() => store) };
});
vi.mock('@openlup/platform/identity', () => ({ createPostgresOperatorIdentityStore: create, createPostgresCustomerChallengeStore: create }));
import { runOperatorIdentityCommand } from './operatorIdentityCommand.js';
const env = { PLATFORM_BUNDLE: 'node-postgres', DATABASE_URL: 'postgresql://unused.invalid/test' };
beforeEach(() => vi.clearAllMocks());
it('refuses wrong bundles, missing credentials and invalid commands before persistence', async () => {
  await expect(runOperatorIdentityCommand(['prune-challenges'], {})).rejects.toThrow('database_required');
  await expect(runOperatorIdentityCommand(['unknown'], env)).rejects.toThrow('command_invalid');
  await expect(runOperatorIdentityCommand(['bootstrap-first-administrator', '--email', 'admin@example.invalid', 'extra'], env)).rejects.toThrow('command_invalid');
  expect(create).not.toHaveBeenCalled();
});
it('bootstrap delegates only the explicit email and closes the store', async () => {
  expect(await runOperatorIdentityCommand(['bootstrap-first-administrator', '--email', 'admin@example.invalid'], env)).toMatchObject({ membershipState: 'invited' });
  expect(store.bootstrapFirstAdministrator).toHaveBeenCalledExactlyOnceWith({ email: 'admin@example.invalid' });
  expect(store.pruneChallenges).not.toHaveBeenCalled(); expect(store.close).toHaveBeenCalledOnce();
});
it('prune is a single bounded batch and command failure closes the store', async () => {
  expect(await runOperatorIdentityCommand(['prune-challenges'], env)).toEqual({ operator: { deleted: 1 }, customer: { deleted: 1 } });
  expect(store.pruneChallenges).toHaveBeenCalledTimes(2);
  expect(store.pruneChallenges).toHaveBeenNthCalledWith(1, { limit: 500 });
  expect(store.pruneChallenges).toHaveBeenNthCalledWith(2, { limit: 500 });
  store.bootstrapFirstAdministrator.mockRejectedValueOnce(new Error('OPERATOR_BOOTSTRAP_ALREADY_INITIALIZED'));
  await expect(runOperatorIdentityCommand(['bootstrap-first-administrator', '--email', 'admin@example.invalid'], env)).rejects.toThrow('OPERATOR_BOOTSTRAP_ALREADY_INITIALIZED');
  expect(store.close).toHaveBeenCalledTimes(3);
});
