import { useEffect, useState } from "react";

import { getCustomerAuthPort } from "@/lib/auth/customerAuthPortFactory";
import { isCustomerAccountSurfaceAllowed } from "@/lib/hiddenSurfaceAccess";

/**
 * Lightweight "is a customer signed in?" probe for PUBLIC surfaces (the V2
 * header). Reads only the session presence via the auth port; deliberately no
 * profile fetch and no context so it stays mountable outside the /konto shell
 * (`CustomerAuthProvider` is route-scoped there and must stay that way).
 *
 * Returns `null` while unknown (first paint), then `true`/`false` and keeps
 * following auth-state changes (sign-in in another tab, sign-out).
 */
export function useCustomerSessionPresence(): boolean | null {
  const enabled = isCustomerAccountSurfaceAllowed();
  const [present, setPresent] = useState<boolean | null>(enabled ? null : false);

  useEffect(() => {
    if (!enabled) return;

    // The port owns browser storage. Creating it during SSR makes the static
    // renderer reach for localStorage, so defer it until after hydration.
    const authPort = getCustomerAuthPort();
    let cancelled = false;

    authPort
      .getSession()
      .then((session) => {
        if (!cancelled) setPresent(Boolean(session));
      })
      .catch(() => {
        if (!cancelled) setPresent(false);
      });

    const unsubscribe = authPort.onAuthStateChange((session) => {
      if (!cancelled) setPresent(Boolean(session));
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);

  return present;
}
