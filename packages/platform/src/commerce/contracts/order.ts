import type { CartStatus, CheckoutStatus, OrderDraftStatus, OrderStatus, PaymentStatus } from "./state.js";

export interface CartDraft<Line, Currency> {
  id: string;
  status: CartStatus;
  lines: Line[];
  currency: Currency;
}

export interface CheckoutSessionPlaceholder {
  id: string;
  cartId: string;
  status: CheckoutStatus;
  redirectUrl: string | null;
  paymentProviderSessionId: string | null;
}

export interface OrderDraftSummary<Quote, Version extends string> {
  orderId: string;
  status: OrderDraftStatus;
  paymentStatus: "not_started";
  idempotencyKey: string;
  quoteSnapshot: {
    contractVersion: Version;
    quote: Quote;
  };
  replayed: boolean;
}

export interface OrderSummary<Line, Money> {
  id: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  total: Money | null;
  lines: Line[];
}

export interface PaymentSummary<Money> {
  id: string;
  orderId: string;
  status: PaymentStatus;
  amount: Money | null;
  providerReference: string | null;
}
