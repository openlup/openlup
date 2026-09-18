import { Suspense, useEffect, useState } from "react";

import { lazyRoute } from "@/lib/lazyRoute";

const AppRuntimeEffects = lazyRoute(() => import("@/routes/AppRuntimeEffects"));
const CookieBanner = lazyRoute(() => import("@/components/CookieBanner"));

/** Browser-only global effects stay outside the deterministic static tree. */
export function DeferredAppEffects() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const load = () => setEnabled(true);
    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(load, { timeout: 2000 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timeoutId = globalThis.setTimeout(load, 1200);
    return () => globalThis.clearTimeout(timeoutId);
  }, []);

  if (!enabled) return null;

  return (
    <Suspense fallback={null}>
      <AppRuntimeEffects />
      <CookieBanner />
    </Suspense>
  );
}
