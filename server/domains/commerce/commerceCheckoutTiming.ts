import type { VercelRequest } from "../../_lib/types/vercel.js";
import { readOrCreateObservedRequestContext } from "../../_lib/observability/requestContext.js";
import type {
  CheckoutStage,
  CheckoutStageRecorder,
} from "./commerceCheckoutOrchestration.js";

const CHECKOUT_ROUTE = "/api/bff/commerce/checkout";

export type CheckoutTimingStage =
  | CheckoutStage
  | "rate_limit"
  | "risk_blocklist"
  | "persist_intent"
  | "payment_method_ref"
  | "customer_defaults"
  | "total";

export type CheckoutTimingOutcome = "success" | "error" | "rejected";

export function createCheckoutTimingLogger(req: VercelRequest): {
  record: CheckoutStageRecorder & (<T>(stage: CheckoutTimingStage, operation: () => Promise<T>) => Promise<T>);
  log: (stage: CheckoutTimingStage, outcome: CheckoutTimingOutcome) => void;
} {
  const requestId = readCheckoutRequestId(req);
  const totalStartedAt = Date.now();

  const write = (
    stage: CheckoutTimingStage,
    startedAt: number,
    outcome: CheckoutTimingOutcome,
  ): void => {
    console.log(JSON.stringify({
      level: "info",
      event: "checkout_stage",
      request_id: requestId,
      route: CHECKOUT_ROUTE,
      stage,
      duration_ms: Math.max(0, Date.now() - startedAt),
      outcome,
    }));
  };

  return {
    async record<T>(stage: CheckoutTimingStage, operation: () => Promise<T>): Promise<T> {
      const startedAt = Date.now();
      try {
        const result = await operation();
        write(stage, startedAt, "success");
        return result;
      } catch (error) {
        write(stage, startedAt, "error");
        throw error;
      }
    },
    log(stage: CheckoutTimingStage, outcome: CheckoutTimingOutcome): void {
      write(stage, totalStartedAt, outcome);
    },
  };
}

function readCheckoutRequestId(req: VercelRequest): string {
  return readOrCreateObservedRequestContext(req).requestId;
}
