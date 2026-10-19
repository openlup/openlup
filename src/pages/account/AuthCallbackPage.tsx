import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useCustomerAuth } from '@/lib/customerAuthContext';
import { consumeCustomerReturnTo } from '@/lib/customerRecoverySession';
import { readLoginHint, writeLoginHint } from '@/lib/customerLoginHint';
import { customerRoutes, referenceAccountReturnTo } from './login/referenceRoutes';

export default function AuthCallbackPage() {
  const { t, i18n } = useTranslation('account');
  const { loading, session, profile, callbackOutcome } = useCustomerAuth();
  const routes = customerRoutes(i18n.language);
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && callbackOutcome === 'succeeded' && session && profile) {
      writeLoginHint({ method: readLoginHint()?.method ?? 'email' });
      navigate(referenceAccountReturnTo(consumeCustomerReturnTo(), routes.account), { replace: true });
    }
  }, [loading, callbackOutcome, session, profile, navigate, routes.account]);
  const outcome = loading ? 'loading'
    : callbackOutcome === 'succeeded' && !profile ? 'accountUnavailable'
    : callbackOutcome ?? 'unknown';
  return <main><h1>{t('callback.title')}</h1><p role="status">{t(`callback.${outcome}`)}</p><Link to={routes.login}>{t('callback.retry')}</Link></main>;
}
