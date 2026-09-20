// Platform-runtime shared contracts.
// Provider-neutral types only: no I/O, no concrete host/provider presets. Host
// composition and bundle catalogs stay downstream.

/** @beta */
export type PlatformBundleId = string;

/** Capability surfaces a runtime bundle can bind. */
/** @beta */
export type PlatformCapability =
  | "http"
  | "scheduler"
  | "blob"
  | "data"
  | "migrations"
  | "analytics"
  | "transactional";

/** @beta */
export type PlatformBundleIdGuard<TId extends string = PlatformBundleId> = (value: unknown) => value is TId;

/** @beta */
export function createPlatformBundleIdGuard<const TIds extends readonly string[]>(
  ids: TIds,
): PlatformBundleIdGuard<TIds[number]> {
  for (const id of ids) {
    if (!id || id.trim() !== id) {
      throw new Error("Platform bundle ids must be non-empty and trimmed");
    }
  }
  const allowed = new Set<string>(ids);
  return (value: unknown): value is TIds[number] => typeof value === "string" && allowed.has(value);
}
