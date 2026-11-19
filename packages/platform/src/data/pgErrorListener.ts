export type PgErrorHandler = (error: Error) => void;

const attached = new WeakSet<object>();

/**
 * Attach a non-throwing `'error'` listener once per pg Pool/Client EventEmitter.
 * Plain-object test stubs without `.on` are left untouched, and a throwing host
 * callback is caught so idle postgres errors never crash the Node.js process.
 */
export function attachPgErrorListener<T extends object>(
  target: T,
  scope: string,
  onError?: PgErrorHandler,
): T {
  if (attached.has(target)) return target;
  const emitter = target as { on?: (event: string, listener: (error: Error) => void) => unknown };
  if (typeof emitter.on !== "function") return target;
  attached.add(target);
  emitter.on("error", (error: Error) => {
    if (onError) {
      try {
        onError(error);
      } catch {
        // Never allow an error callback to turn an idle pg error into an uncaught exception.
      }
      return;
    }
    const rawCode = (error as { code?: unknown })?.code;
    const code = typeof rawCode === "string" ? ` (${rawCode})` : "";
    console.error(`[openlup/platform:${scope}] idle postgres error${code}: ${error instanceof Error ? error.message : String(error)}`);
  });
  return target;
}
