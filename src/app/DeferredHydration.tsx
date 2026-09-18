import { startTransition, type PropsWithChildren, Suspense, useEffect, useRef, useState } from "react";

import { useRenderRuntime } from "./renderMode";

const pendingHydration = new Promise<never>(() => undefined);

/**
 * Keeps server-rendered, non-critical content visible while deferring its React
 * hydration until the user is approaching it. This is deliberately a narrow
 * SSG optimisation: the server and a JavaScript-free browser still receive the
 * complete document; only below-the-fold interactivity is delayed.
 */
export function DeferredHydration({ children }: PropsWithChildren) {
  const { isInitialSsgHydrationPending } = useRenderRuntime();
  const [ready, setReady] = useState(
    () => typeof window === "undefined" || !isInitialSsgHydrationPending(),
  );
  const boundaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ready) return;

    const boundary = boundaryRef.current;
    if (!boundary || !("IntersectionObserver" in window)) {
      startTransition(() => setReady(true));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        startTransition(() => setReady(true));
        observer.disconnect();
      },
      // Do not wake up merely because the boundary touches the bottom edge of
      // the hero. The user has to begin scrolling towards the content first.
      { rootMargin: "0px 0px -25% 0px" },
    );
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [ready]);

  return (
    <div ref={boundaryRef} data-deferred-hydration="below-fold">
      <Suspense fallback={null}>
        <HydrationGate ready={ready}>{children}</HydrationGate>
      </Suspense>
    </div>
  );
}

function HydrationGate({ ready, children }: PropsWithChildren<{ ready: boolean }>) {
  // Suspending a server-rendered boundary preserves its static DOM until the
  // parent observer makes it interactive. Unlike rendering a different client
  // tree, this does not hide or replace SSG content during hydration.
  if (!ready && typeof window !== "undefined") throw pendingHydration;
  return children;
}
