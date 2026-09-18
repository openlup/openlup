/**
 * The operator-facing text for a failed BFF call. It unwraps
 * `details.supportCode`, the code an operator quotes to the provider.
 */
export function bffErrorMessage(err: unknown): string {
  const message = baseErrorMessage(err);
  const details = err && typeof err === "object" && "details" in err
    ? (err as { details?: unknown }).details
    : null;
  const supportCode = details && typeof details === "object" && "supportCode" in details
    ? (details as { supportCode?: unknown }).supportCode
    : null;
  return typeof supportCode === "string" && supportCode
    ? `${message} (${supportCode})`
    : message;
}

function baseErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const maybeError = err as { message?: unknown };
    if (typeof maybeError.message === "string") return maybeError.message;
  }
  return String(err);
}
