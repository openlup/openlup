import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useCustomerAuth } from '@/lib/customerAuthContext';
import { writeLoginHint } from '@/lib/customerLoginHint';
import { saveCustomerReturnTo } from '@/lib/customerRecoverySession';
import { useLoginHint } from './login/useLoginPreviewAccount';
import { CodeFallbackForm } from './login/CodeFallbackForm';
import { SocialSignInButton } from './login/loginAtoms';
import { useOtpCodeFallback } from './login/useOtpCodeFallback';
import { customerRoutes, referenceAccountReturnTo } from './login/referenceRoutes';

export default function LoginPage() {
  const { t, i18n } = useTranslation('account');
  const auth = useCustomerAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const routes = customerRoutes(i18n.language);
  const target = referenceAccountReturnTo(params.get('returnTo'), routes.account);
  const [email, setEmail] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const { hint, forget } = useLoginHint();
  const format = auth.signInOptions?.codeFormat ?? 'numeric';
  const code = useOtpCodeFallback(auth.signInWithOtpCode, () => writeLoginHint({ method: 'email' }), format);
  useEffect(() => {
    if (!auth.loading && auth.session && auth.profile) navigate(target, { replace: true });
  }, [auth.loading, auth.session, auth.profile, navigate, target]);

  function prepareReturnTo() {
    saveCustomerReturnTo(target);
    const url = new URL(window.location.href);
    url.searchParams.set('returnTo', target);
    window.history.replaceState(window.history.state, '', url);
  }

  async function request(event?: FormEvent) {
    event?.preventDefault();
    if (pending.current || !auth.signInOptions) return;
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 160) {
      setError(t('login.emailInvalid')); return;
    }
    pending.current = true;
    setBusy(true); setError('');
    try {
      prepareReturnTo();
      const result = await auth.signInWithOtp(normalized);
      if (result.error) setError(t('login.sendError'));
      else { writeLoginHint({ method: 'email' }); setEmail(normalized); setAccepted(true); }
    } catch { setError(t('login.sendError')); }
    finally { pending.current = false; setBusy(false); }
  }

  async function social(kind: Parameters<typeof auth.signInWithOAuth>[0]) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      prepareReturnTo();
      writeLoginHint({ method: 'social' });
      const result = await auth.signInWithOAuth(kind, new URL(routes.callback, window.location.origin).href);
      if (result.error) setError(t('login.social.error'));
    } catch { setError(t('login.social.error')); }
    finally { pending.current = false; setBusy(false); }
  }

  return <main>
    <h1>{t('login.title')}</h1>
    {hint ? <p>{t('login.returning')} <button onClick={forget}>{t('login.forget')}</button></p> : null}
    <form onSubmit={(event) => void request(event)}>
      <label>{t('login.email')} <input type="email" autoComplete="email" required maxLength={160} value={email} disabled={accepted || busy} onChange={(event) => setEmail(event.target.value)} /></label>
      {!accepted ? <button disabled={auth.loading || !auth.signInOptions || busy || code.loading}>{t(busy ? 'login.sending' : 'login.send')}</button> : null}
    </form>
    {accepted ? <section>
      <p role="status">{t(format === 'opaque' ? 'login.acceptedOpaque' : 'login.accepted')}</p>
      <button disabled={busy || code.loading} onClick={() => void request()}>{t('login.requestAgain')}</button>
      <button disabled={busy || code.loading} onClick={() => { setAccepted(false); setError(''); code.reset(); }}>{t('login.changeAddress')}</button>
      <CodeFallbackForm codeFormat={format} sectionLabel={t('login.fallback')} label={t('login.code')} placeholder={t(format === 'opaque' ? 'login.opaquePlaceholder' : 'login.numericPlaceholder')}
        value={code.code} error={code.error} loading={code.loading || busy} submitLabel={t('login.verify')} loadingLabel={t('login.verifying')}
        onChange={code.setCode} onSubmit={() => void code.submit(email)} />
    </section> : null}
    {auth.signInOptions?.socialProviders.map((provider) => <SocialSignInButton key={provider.kind} label={t('login.social.continue', { provider: provider.displayName })} disabled={auth.loading || busy || code.loading} onClick={() => void social(provider.kind)} />)}
    {error ? <p role="alert">{error}</p> : null}
    {!auth.loading && !auth.signInOptions ? <p role="alert">{t('login.sendError')}</p> : null}
    {!auth.loading && auth.session && !auth.profile ? <p role="alert">{t('callback.accountUnavailable')}</p> : null}
    <Link to={routes.account}>{t('login.account')}</Link>
  </main>;
}
