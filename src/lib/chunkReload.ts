/**
 * Deploy-neutral recovery for stale lazy-route chunks.
 *
 * Routes are code-split, so each deploy ships fresh hashed chunk files. A tab
 * opened before a deploy can fail to fetch a now-removed chunk when the user
 * navigates, surfacing as a `vite:preloadError`. We reload once so the client
 * picks up the new build. Persisted commerce state is restored after the reload
 * (see `persistentCommerceState`), so this stays neutral for in-progress forms.
 *
 * The reload is loop-guarded: if a fresh build still can't load (e.g. CDN
 * propagation), we don't reload again until the cooldown passes.
 *
 * Not every stale-chunk failure arrives as a `vite:preloadError` event, though.
 * A lazy chunk that rejects while fetching or evaluating surfaces as a thrown
 * render error, which only a React error boundary can catch. `RouteErrorBoundary`
 * reuses {@link triggerGuardedReload} + {@link isTransientModuleError} here so both
 * recovery paths share one loop guard and one classifier.
 *
 * Classification is evidence, not a guess about a message. `lazyRoute` records
 * loader failures through {@link markModuleFailure}; the message patterns below
 * remain only for narrow browser/Vite failures outside that wrapper. An ordinary
 * named-property read from `undefined` is an application bug and must reach the
 * visible fallback rather than disappear behind a reload.
 */

const CHUNK_RELOAD_KEY = "openlup:chunk-reload-at";
const RELOAD_COOLDOWN_MS = 10_000;

/** Module-load failures observed directly by `lazyRoute`. */
const MODULE_FAILURES = new WeakSet<object>();

/** Record a module-load failure without mutating the rejected value. */
export function markModuleFailure<T extends object>(value: T): T;
export function markModuleFailure(value: unknown): object;
export function markModuleFailure(value: unknown): object {
  const failure =
    (typeof value === "object" && value !== null) || typeof value === "function"
      ? value
      : new Error(typeof value === "string" && value ? value : "Lazy route module failed to load");
  MODULE_FAILURES.add(failure);
  return failure;
}

/** True when this exact error object was observed at the module-load boundary. */
export function isTaggedModuleFailure(error: unknown): boolean {
  return (
    ((typeof error === "object" && error !== null) || typeof error === "function") &&
    MODULE_FAILURES.has(error)
  );
}

/** True when we have not already reloaded within the cooldown window. */
export function shouldReloadForChunkError(now: number, lastReloadAt: number | null): boolean {
  if (lastReloadAt === null || Number.isNaN(lastReloadAt)) return true;
  return now - lastReloadAt >= RELOAD_COOLDOWN_MS;
}

/**
 * Does this error carry direct module-load evidence or one of the narrow
 * browser/Vite signatures that a fresh full-page load can recover from?
 */
export function isTransientModuleError(error: unknown): boolean {
  if (isTaggedModuleFailure(error)) return true;
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : "";
  if (!message) return false;
  return (
    /ChunkLoadError/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /importing a module script failed/i.test(message)
  );
}

function readLastReloadAt(): number | null {
  try {
    const raw = window.sessionStorage.getItem(CHUNK_RELOAD_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Reload once to recover from a stale/partial chunk, respecting the shared loop
 * guard. Returns true if a reload was triggered, false if suppressed by the
 * cooldown (so the caller can fall back to a manual recovery affordance).
 */
export function triggerGuardedReload(): boolean {
  if (typeof window === "undefined") return false;
  if (!shouldReloadForChunkError(Date.now(), readLastReloadAt())) return false;
  try {
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    // best-effort loop guard; reload regardless
  }
  window.location.reload();
  return true;
}

export function installChunkReloadHandler(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("vite:preloadError", (event) => {
    // Suppress Vite's rethrow only when recovery actually started. If cooldown
    // blocks the reload, propagation lets the boundary show the recovery card.
    if (triggerGuardedReload()) event.preventDefault();
  });
}
