/** Session subset consumed by the admin shell, independent of any provider SDK. */
export interface AdminSession {
  access_token: string;
  user: { id: string; email?: string | null };
}
export function isDirectOperatorAuth(kind: string | undefined): boolean {
  if (kind && kind !== 'direct') throw new Error('operator_auth_provider_unknown');
  return kind === 'direct';
}
