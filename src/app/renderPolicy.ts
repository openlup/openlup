import type { AppRenderMode } from "./renderMode";

export function shouldRenderBelowFold(
  mode: AppRenderMode,
  environmentMode = import.meta.env.MODE,
): boolean {
  return mode === "ssg" || environmentMode === "test";
}
