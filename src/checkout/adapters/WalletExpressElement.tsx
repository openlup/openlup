import type { ComponentProps } from "react";
import { ExpressCheckoutElement } from "@stripe/react-stripe-js";

import { WalletButtonSkeleton } from "./WalletExpressSkeleton";

type StripeExpressCheckoutProps = ComponentProps<typeof ExpressCheckoutElement>;

interface WalletExpressElementProps {
  available: boolean | null;
  dividerLabel: string;
  onClick: NonNullable<StripeExpressCheckoutProps["onClick"]>;
  onConfirm: NonNullable<StripeExpressCheckoutProps["onConfirm"]>;
  onReady: NonNullable<StripeExpressCheckoutProps["onReady"]>;
}

/**
 * Stripe's wallet surface and its layout-only state. Keeping it separate from
 * the order-mint/confirmation controller lets the controller focus on payment
 * outcomes while this component owns availability, the no-CLS skeleton, and
 * the provider's fixed wallet method policy.
 */
export function WalletExpressElement({
  available,
  dividerLabel,
  onClick,
  onConfirm,
  onReady,
}: WalletExpressElementProps) {
  return (
    <div
      data-testid="wallet-express"
      hidden={available === false}
      aria-hidden={available === false}
    >
      <div className="mb-4">
        {available === null && <WalletButtonSkeleton />}
        <div className={available ? undefined : "h-0 overflow-hidden"}>
          <ExpressCheckoutElement
            options={{
              paymentMethods: {
                applePay: "auto",
                googlePay: "auto",
                link: "never",
                paypal: "never",
                amazonPay: "never",
              },
            }}
            onClick={onClick}
            onReady={onReady}
            onConfirm={onConfirm}
          />
        </div>
        <div className="mt-4 flex items-center gap-3" aria-hidden>
          <span className="h-px flex-1 bg-cfg-ink/12" />
          <span className="font-body text-xs-plus uppercase tracking-wide text-cfg-ink/70">
            {dividerLabel}
          </span>
          <span className="h-px flex-1 bg-cfg-ink/12" />
        </div>
      </div>
    </div>
  );
}
