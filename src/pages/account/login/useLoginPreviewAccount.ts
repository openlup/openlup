import { useMemo } from 'react';
import { readLoginHint } from '@/lib/customerLoginHint';

export type LoginViewStatus = 'idle' | 'sending' | 'sent' | 'error';

// Demo data mirrors the design screenshots so `?previewMode=returning` renders
// 1:1 with the handoff. DEV-only — never reachable in a production build.
const PREVIEW_ACCOUNT = {
  firstName: 'Maja',
  petName: 'Burek',
  email: 'maja.kowalska@gmail.com',
  method: 'google' as const,
};

/**
 * Resolves the returning-customer hint (or the DEV-only `?previewMode=`
 * screenshot escape hatch) into the account details + initial view state the
 * login page renders around.
 */
export function useLoginPreviewAccount() {
  const hint = useMemo(() => readLoginHint(), []);

  const dev = import.meta.env.DEV;
  const params = useMemo(
    () => new URLSearchParams(typeof window !== 'undefined' ? window.location.search : ''),
    [],
  );
  const forcedMode = dev ? params.get('previewMode') : null;
  const forcedStatus = dev ? (params.get('previewState') as LoginViewStatus | null) : null;

  const initialReturning =
    forcedMode === 'returning' || (forcedMode !== 'new' && Boolean(hint?.firstName));

  const usePreviewAccount = dev && forcedMode === 'returning' && !hint?.firstName;
  const account = {
    firstName: (usePreviewAccount ? PREVIEW_ACCOUNT.firstName : hint?.firstName) ?? '',
    petName: (usePreviewAccount ? PREVIEW_ACCOUNT.petName : hint?.petName) ?? null,
    email: (usePreviewAccount ? PREVIEW_ACCOUNT.email : hint?.email) ?? '',
    method: usePreviewAccount ? PREVIEW_ACCOUNT.method : hint?.method,
  };

  return { account, initialReturning, forcedStatus };
}
