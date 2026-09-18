/**
 * Fixed-footprint placeholders for the wallet express row. The wallet's
 * availability resolves asynchronously (live quote, then Stripe
 * canMakePayment) — reserving the space kills the layout shift on the money
 * step; the row collapses only on a CONFIRMED "no wallet on this device".
 */

/** Reserved space for the wallet button while Stripe resolves availability. */
export function WalletButtonSkeleton() {
  return (
    <div
      data-testid="wallet-express-skeleton"
      className="h-11 rounded-xl bg-cfg-ink/8 animate-pulse"
      aria-hidden
    />
  );
}

/** Quote still loading: hold the full row footprint (button + divider). */
export function WalletRowPlaceholder() {
  return (
    <div data-testid="wallet-express" aria-hidden>
      <div className="mb-4">
        <WalletButtonSkeleton />
        <div className="mt-4 flex items-center gap-3">
          <span className="h-px flex-1 bg-cfg-ink/12" />
          <span className="h-3 w-40 rounded bg-cfg-ink/8 animate-pulse" />
          <span className="h-px flex-1 bg-cfg-ink/12" />
        </div>
      </div>
    </div>
  );
}
