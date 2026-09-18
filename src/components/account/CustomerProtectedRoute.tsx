import { Navigate, useLocation } from 'react-router-dom';
import { useCustomerAuth } from '@/lib/customerAuthContext';
import { saveCustomerReturnTo } from '@/lib/customerRecoverySession';
import { useLocalizedPath, type RouteKey } from '@/lib/i18nRoutes';
import { normalizeCustomerReturnTo } from '@/domains/customers/contracts';

// Faza A W12.1 — gate for hidden customer account pages. Mirrors the admin
// ProtectedRoute but checks the customer (magic-link) session. Unauthenticated
// visitors are bounced to the passwordless login.
export default function CustomerProtectedRoute({
  children,
  returnTo,
  loginRouteKey = "customerLogin",
}: {
  children: React.ReactNode;
  returnTo?: string;
  loginRouteKey?: RouteKey;
}) {
  const { user, session, profile, loading } = useCustomerAuth();
  const localizedPath = useLocalizedPath();
  const location = useLocation();

  if (loading) {
    return (
      <div className="account-light flex h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-teal border-t-transparent" />
      </div>
    );
  }

  // Require an authenticated session token AND a linked client profile. A bare
  // auth session with no `clients.auth_user_id` link (profile === null) is NOT a
  // customer account, so it is bounced rather than shown an empty dashboard.
  if (!user || !session?.accessToken || !profile) {
    const currentPath = `${location.pathname}${location.search}${location.hash}`;
    const safeReturnTo = normalizeCustomerReturnTo(returnTo) ?? normalizeCustomerReturnTo(currentPath);
    if (safeReturnTo) saveCustomerReturnTo(safeReturnTo);
    const search = safeReturnTo
      ? `?${new URLSearchParams({ returnTo: safeReturnTo }).toString()}`
      : '';
    return <Navigate to={`${localizedPath(loginRouteKey)}${search}`} replace />;
  }

  return <>{children}</>;
}
