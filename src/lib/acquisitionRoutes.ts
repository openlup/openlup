import { isHiddenSurfaceAccessAllowed } from "@/lib/hiddenSurfaceAccess";
import {
  localizedPath,
  type Lang,
  type RouteKey,
  useLocalizedPath,
} from "@/lib/i18nRoutes";

type AcquisitionRouteEnv = Parameters<typeof isHiddenSurfaceAccessAllowed>[0];

export function publicAcquisitionRouteKey(env?: AcquisitionRouteEnv): RouteKey {
  // Free-samples campaign retired (2026-07) — public acquisition CTAs now route
  // to the waitlist. Hidden preview still exercises the real configurator flow.
  return isHiddenSurfaceAccessAllowed(env) ? "configurator" : "waitlist";
}

export function publicAcquisitionPath(lang: Lang, env?: AcquisitionRouteEnv): string {
  return localizedPath(publicAcquisitionRouteKey(env), lang) ?? localizedPath("waitlist", lang)!;
}

export function usePublicAcquisitionPath(): string {
  const lp = useLocalizedPath();
  return lp(publicAcquisitionRouteKey());
}
