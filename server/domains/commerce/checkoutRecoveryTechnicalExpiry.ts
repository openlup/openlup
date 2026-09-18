import { classifyExpiredRecovery } from "./checkoutExpiredRecoveryPolicy.js";
import type { ExpiredCheckoutRecoveryService } from "./expiredCheckoutRecoveryService.js";
import type {
  CheckoutRecoveryTokenContext,
  CheckoutRecoveryTokenInspection,
  CheckoutRecoveryTokenPort,
} from "./checkoutRecoveryToken.js";
import type {
  CheckoutRecoveryOrderReadPort,
  CheckoutRecoveryOrderSnapshot,
} from "./checkoutRecoveryOrderPort.js";

export type TechnicalExpiryRedeemOutcome = {
  kind: "retry_existing" | "recreate_expired" | "paid" | "cancelled" | "order_changed";
  inspection: CheckoutRecoveryTokenInspection;
  snapshot: CheckoutRecoveryOrderSnapshot | null;
};

export async function classifyTechnicalExpiryForRedeem(input: {
  rawToken: string;
  context: CheckoutRecoveryTokenContext;
  tokenPort: CheckoutRecoveryTokenPort;
  orderPort: CheckoutRecoveryOrderReadPort;
  expiredRecoveryService: ExpiredCheckoutRecoveryService;
  now: Date;
}): Promise<TechnicalExpiryRedeemOutcome> {
  const inspected = await input.tokenPort.inspect(input.rawToken);
  const inspection: CheckoutRecoveryTokenInspection = inspected ?? {
    tokenId: input.context.tokenId,
    orderId: input.context.orderId,
    clientId: input.context.clientId,
    mode: input.context.mode,
    status: input.context.status,
    subscriptionId: null,
    tokenState: "active",
  };
  const snapshot = await latestRecoveryOrder(input.orderPort, inspection.orderId);

  if (
    snapshot?.status === "pending_payment" &&
    snapshot.paymentIntentId &&
    snapshot.clientId === inspection.clientId &&
    snapshot.technicallyExpired !== true
  ) {
    return { kind: "retry_existing", inspection, snapshot };
  }

  const eligibility = classifyExpiredRecovery({ inspection, order: snapshot, now: input.now });
  if (eligibility.kind === "eligible") {
    if (snapshot) {
      const unchanged = await input.expiredRecoveryService.validate(snapshot);
      if (unchanged) return { kind: "recreate_expired", inspection, snapshot };
    }
    return { kind: "order_changed", inspection, snapshot };
  }
  const kind = eligibility.kind === "unavailable" ? "order_changed" : eligibility.kind;
  return { kind, inspection, snapshot };
}

export function latestRecoveryOrder(
  orderPort: CheckoutRecoveryOrderReadPort,
  orderId: string,
): Promise<CheckoutRecoveryOrderSnapshot | null> {
  return orderPort.getLatestRecoveryOrder
    ? orderPort.getLatestRecoveryOrder({ orderId })
    : orderPort.getRecoveryOrder({ orderId });
}
