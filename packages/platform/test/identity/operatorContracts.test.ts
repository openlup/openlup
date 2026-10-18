import { expect, it } from 'vitest';
import { operatorChallengeRequestSchema, operatorChallengeVerificationSchema, operatorSessionSchema } from '../../src/identity/contracts/operatorAuth.js';
it('strict challenge contracts normalize email and reject extra fields or malformed tokens', () => {
  expect(operatorChallengeRequestSchema.parse({ email: ' ADMIN@EXAMPLE.INVALID ' })).toEqual({ email: 'admin@example.invalid' });
  for (const bad of [{ email: 'admin@example.invalid', role: 'admin' }, { email: 'invalid' }, [], null]) expect(operatorChallengeRequestSchema.safeParse(bad).success).toBe(false);
  expect(operatorChallengeVerificationSchema.parse({ token: 'a'.repeat(43) })).toEqual({ token: 'a'.repeat(43) });
  for (const bad of [{ token: '123456' }, { token: 'a'.repeat(43), email: 'admin@example.invalid' }, { token: 1 }]) expect(operatorChallengeVerificationSchema.safeParse(bad).success).toBe(false);
});
it('strict session schema rejects extra claims, invalid identity and missing expiry', () => {
  const session = { accessToken: 'signed', expiresAt: '2026-10-18T12:15:00Z', user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid' } };
  expect(operatorSessionSchema.parse(session)).toEqual(session);
  for (const bad of [{ ...session, role: 'admin' }, { ...session, expiresAt: '' }, { ...session, expiresAt: '2026-02-30T12:15:00Z' }, { ...session, user: { ...session.user, role: 'admin' } }, { ...session, user: { ...session.user, id: 'bad' } }, { ...session, accessToken: '' }]) expect(operatorSessionSchema.safeParse(bad).success).toBe(false);
});
