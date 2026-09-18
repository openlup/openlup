/**
 * In-place error line for the wallet express row. Non-terminal wallet outcomes
 * (price changed, subscription unavailable, incomplete details) surface here
 * instead of routing to a page — a false thank-you would imply an order exists.
 * `alert` opts into `role="alert"` so blocking errors are announced; the
 * price-changed hint stays a plain paragraph (parity with the pre-extraction markup).
 */
export function WalletInlineError({ message, alert }: { message: string; alert?: boolean }) {
  return (
    <p
      {...(alert ? { role: "alert" as const } : {})}
      className="mt-3 font-body text-xs-plus text-destructive"
    >
      {message}
    </p>
  );
}
