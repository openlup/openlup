import CustomerProtectedRoute from './CustomerProtectedRoute';
import {
  capturePaymentRecoveryTokenFromUrl,
} from '@/lib/customerRecoverySession';
import { useLocalizedPath } from '@/lib/i18nRoutes';

/**
 * Session gate for the dunning recovery landing, plus the one thing the gate
 * cannot do for itself: keep the recovery token alive across the login trip.
 *
 * The token arrives in the URL of a page that REQUIRES a session, so the common
 * case is a logged-out customer who is bounced to the magic-link login before
 * the page ever mounts. `returnTo` cannot carry the token — `normalizeCustomerReturnTo`
 * strips it from any recovery path on purpose, so it never reaches a login URL,
 * a magic-link email, or a referrer. The token therefore has to move to the
 * storage carrier BEFORE the bounce, and it does so here.
 *
 * ⛔ `capturePaymentRecoveryTokenFromUrl()` must stay in this render body. That
 * placement is the whole guarantee: React cannot render the child
 * `CustomerProtectedRoute` — and so cannot reach its `<Navigate>` — until this
 * function has returned, so the write provably precedes any redirect. Moving it
 * into a `useEffect` for tidiness would silently break every dunning recovery
 * link: effects run children-first, so the redirect would fire before the
 * capture, and the customer would land on the page token-less and be told the
 * link is invalid. Pinned in CustomerPaymentRecoveryRoute.test.tsx.
 */
export default function CustomerPaymentRecoveryRoute({
  children,
}: {
  children: React.ReactNode;
}) {
  const localizedPath = useLocalizedPath();
  const returnTo = capturePaymentRecoveryTokenFromUrl()
    ?? localizedPath("customerPaymentRecovery");

  return (
    <CustomerProtectedRoute returnTo={returnTo}>
      {children}
    </CustomerProtectedRoute>
  );
}
