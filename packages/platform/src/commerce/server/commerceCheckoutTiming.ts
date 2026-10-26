export type CheckoutStage = "quote" | "order_draft" | "start_runtime" | "account_link" | "apply_payment_result";
export type CheckoutStageRecorder = <T>(stage: CheckoutStage, operation: () => Promise<T>) => Promise<T>;

export type CheckoutTimingStage =
  | CheckoutStage
  | "rate_limit"
  | "risk_blocklist"
  | "persist_intent"
  | "payment_method_ref"
  | "customer_defaults"
  | "total";

export type CheckoutTimingOutcome = "success" | "error" | "rejected";

export function createCheckoutTimingLogger(requestId: string, route: string): {
  record: CheckoutStageRecorder & (<T>(stage: CheckoutTimingStage, operation: () => Promise<T>) => Promise<T>);
  log: (stage: CheckoutTimingStage, outcome: CheckoutTimingOutcome) => void;
} {
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
      route,
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
