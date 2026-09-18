import { createContext, type PropsWithChildren, useContext, useEffect, useMemo, useRef } from "react";

export type AppRenderMode = "csr" | "ssg";

interface RenderRuntime {
  mode: AppRenderMode;
  isInitialSsgHydrationPending: () => boolean;
}

// Standalone component tests and legacy consumers behave like the existing CSR
// app unless they are explicitly wrapped by AppProviders.
const RenderRuntimeContext = createContext<RenderRuntime>({
  mode: "csr",
  isInitialSsgHydrationPending: () => false,
});

export function RenderRuntimeProvider({
  mode,
  children,
}: PropsWithChildren<{ mode: AppRenderMode }>) {
  const initialSsgHydrationPending = useRef(
    mode === "ssg" && typeof window !== "undefined",
  );

  useEffect(() => {
    initialSsgHydrationPending.current = false;
  }, []);

  const value = useMemo<RenderRuntime>(() => ({
    mode,
    isInitialSsgHydrationPending: () => initialSsgHydrationPending.current,
  }), [mode]);

  return <RenderRuntimeContext.Provider value={value}>{children}</RenderRuntimeContext.Provider>;
}

// Provider and hook intentionally share one private context.
// eslint-disable-next-line react-refresh/only-export-components
export function useRenderRuntime(): RenderRuntime {
  return useContext(RenderRuntimeContext);
}
