import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import type {
  CommerceEngagementEmailContent,
  CommerceRecoveryEmailContent,
} from "./commerceEngagementEmailContent.js";

export interface OrderDraftEmailCopy {
  subject: (orderId: string) => string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
  intro: (orderId: string) => string;
  itemsLabel: string;
  noItems: string;
  subtotalLabel: string;
  discountRowLabel: string;
  totalLabel: string;
  cta: string;
  outro: string;
  personalizedClosing: (name: string) => string;
}

export interface OrderPaidEmailCopy {
  subject: (orderId: string) => string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
  introOneTime: (orderId: string) => string;
  introSubscription: (orderId: string) => string;
  noItems: string;
  subtotalLabel: string;
  catalogProductsLabel: string;
  discountRowLabel: string;
  firstSubscriptionDiscountRowLabel: string;
  productPayableLabel: string;
  shippingLabel: string;
  shippingFree: string;
  totalLabel: string;
  finalPaidLabel: string;
  cta: string;
  receiptNote: (name: string | null) => string;
  outro: string;
  withdrawalNotice: string;
  withdrawalLinkLabel: string;
}

export interface OrderCanceledEmailCopy {
  subject: (orderId: string) => string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
  intro: (orderId: string) => string;
  detailsLabel: string;
  details: (amountLabel: string | null) => string[];
  returnNote: (name: string | null) => string;
  cta: string;
  outro: string;
}

export interface OrderRefundedEmailCopy {
  subject: (orderId: string) => string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
  intro: (orderId: string) => string;
  detailsLabel: string;
  details: (amountLabel: string | null) => string[];
  returnNote: (brandName: string) => string;
  cta: string;
  outro: string;
}

export interface PaymentFailedEmailCopy {
  subject: (orderId: string) => string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
  intro: (orderId: string) => string;
  detailsLabel: string;
  details: (amountLabel: string | null, mode: "subscription_cycle" | "one_time") => string[];
  cta: string;
  outro: string;
}

/**
 * A guide the mail points the customer at: a document the deployment hosts
 * under its own site origin, so `path` is site-relative and the content
 * module joins it with the origin the sender passes in.
 */
export interface EmailGuideCardCopy {
  eyebrow: string;
  title: string;
  text: (contextName: string | null) => string;
  cta: string;
  /** Site-relative path of the document (leading slash). */
  path: string;
  /** Optional illustration, also site-relative. */
  image?: { path: string; alt: string; widthPx: number; heightPx: number };
}

export interface ShipmentDispatchedEmailCopy {
  subject: (orderRef: string) => string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
  intro: (orderRef: string) => string;
  trackingLabel: string;
  trackParcel: string;
  noTracking: string[];
  noTrackingLabel: string;
  /** The account guide the customer can read while the parcel travels. */
  accountGuide: EmailGuideCardCopy;
  outro: (contextName: string | null) => string;
}

export interface ShipmentDeliveredEmailCopy {
  subject: (orderRef: string) => string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
  intro: (orderRef: string, contextName: string | null) => string;
  /** The getting-started guide to read before the first serving. */
  startGuide: EmailGuideCardCopy;
  outro: string;
}

export interface ShipmentExceptionEmailCopy {
  subject: (orderRef: string) => string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
  intro: (orderRef: string) => string;
  reassuranceLabel: string;
  reassurance: string[];
  cta: string;
  outro: string;
}

export interface ReturnApprovedEmailCopy {
  subject: (orderRef: string) => string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
  intro: (orderRef: string) => string;
  returnAddressNotice: string;
  cta: string;
}

export interface ReturnRejectedEmailCopy {
  subject: (orderRef: string) => string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
  intro: (orderRef: string) => string;
  cta: string;
}

export interface ReturnRefundedEmailCopy {
  subject: (orderRef: string) => string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
  amountKnown: (amountLabel: string, orderRef: string) => string;
  amountUnknown: (orderRef: string) => string;
  returnNote: string;
  cta: string;
}

/** Build-time selected transactional-copy owner for commerce mail. */
export interface CommerceEmailContent extends CommerceRecoveryEmailContent, CommerceEngagementEmailContent {
  readonly id: string;
  readonly orderRefPrefix: string;
  readonly orderDraft: Record<Locale, OrderDraftEmailCopy>;
  readonly orderPaid: Record<Locale, OrderPaidEmailCopy>;
  readonly orderCanceled: Record<Locale, OrderCanceledEmailCopy>;
  readonly orderRefunded: Record<Locale, OrderRefundedEmailCopy>;
  readonly paymentFailed: Record<Locale, PaymentFailedEmailCopy>;
  readonly shipmentDispatched: Record<Locale, ShipmentDispatchedEmailCopy>;
  readonly shipmentDelivered: Record<Locale, ShipmentDeliveredEmailCopy>;
  readonly shipmentException: Record<Locale, ShipmentExceptionEmailCopy>;
  readonly returns: {
    readonly approved: Record<Locale, ReturnApprovedEmailCopy>;
    readonly rejected: Record<Locale, ReturnRejectedEmailCopy>;
    readonly refunded: Record<Locale, ReturnRefundedEmailCopy>;
  };
}

export type CommerceFulfillmentEmailContent = Pick<
  CommerceEmailContent,
  "shipmentDispatched" | "shipmentDelivered" | "shipmentException" | "returns"
>;
