import { expect, it, vi } from 'vitest';
import { resolveAdminAuthBinding, preflightAdminBffRoute } from './adminAuthBinding.js';
import type { VercelRequest, VercelResponse } from '../../_lib/types/vercel.js';
const id = '11111111-1111-4111-8111-111111111111';
it('human login needs no machine credential and retains the verified human actor', async () => {
  const auth = { authorize: vi.fn(async () => ({ ok: true as const, principalId: id, role: 'distributor' as const, isMachineActor: false })), close: vi.fn(async () => {}) };
  const factory = vi.fn(() => auth);
  const binding = resolveAdminAuthBinding({ PLATFORM_BUNDLE: 'node-postgres', OPERATOR_IDENTITY_AUDIENCE: 'operator' }, { humanAuthFactory: factory }).binding!;
  expect(await binding.run('human', a => a.authorize('human'))).toEqual({ ok: true, principalId: id, role: 'distributor', isMachineActor: false });
  expect(factory).toHaveBeenCalledOnce(); expect(auth.close).toHaveBeenCalledOnce();
});
it('a revoked matching machine credential never falls through to human authority', async () => {
  const humanAuthFactory = vi.fn(); const token = 'm'.repeat(32);
  const binding = resolveAdminAuthBinding({ PLATFORM_BUNDLE: 'node-postgres', OPERATOR_IDENTITY_AUDIENCE: 'operator', PLATFORM_OPERATOR_TOKEN: token, PLATFORM_OPERATOR_ID: id }, {
    humanAuthFactory, checkerFactory: () => ({ isOperatorAllowed: async () => false, close: async () => {} }),
  }).binding!;
  expect(await binding.run(token, a => a.authorize(token))).toMatchObject({ code: 'FORBIDDEN' }); expect(humanAuthFactory).not.toHaveBeenCalled();
});
it('human database failure becomes unavailable without invoking a machine checker', async () => {
  const checkerFactory = vi.fn();
  const humanClose = vi.fn(async () => {});
  const humanAuthFactory = vi.fn(() => ({ authorize: async () => { throw new Error('db'); }, close: humanClose }));
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() }; res.status.mockReturnValue(res);
  expect(await preflightAdminBffRoute({ headers: { authorization: 'Bearer human' } } as VercelRequest, res as unknown as VercelResponse, '/api/bff/admin/platform/admin-users/invite', { PLATFORM_BUNDLE: 'node-postgres', OPERATOR_IDENTITY_AUDIENCE: 'operator' }, {
    checkerFactory, humanAuthFactory,
  })).toBe(false);
  expect(res.status).toHaveBeenCalledWith(503); expect(checkerFactory).not.toHaveBeenCalled(); expect(humanAuthFactory).toHaveBeenCalledOnce(); expect(humanClose).toHaveBeenCalledOnce();
});
