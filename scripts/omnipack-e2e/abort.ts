import {
  safeguardLifecycleCanary,
  type LifecycleEvidenceRpcAdmin,
} from "./lifecycleEvidence.ts";

export async function abortLifecycleCanaryBeforeDispatch(
  admin: LifecycleEvidenceRpcAdmin,
  input: {
    runId: string;
    caseId: string;
    failureCode: string;
    orderId: string | null;
    fulfillmentOrderId: string;
    extra?: Record<string, unknown>;
  },
  safeguard = safeguardLifecycleCanary,
): Promise<Record<string, unknown>> {
  const safeguarded = Boolean(input.orderId && input.fulfillmentOrderId);
  if (safeguarded) {
    await safeguard(admin, {
      runId: input.runId,
      orderId: input.orderId as string,
      fulfillmentOrderId: input.fulfillmentOrderId,
      reason: `e2e_${input.failureCode}`,
    });
  }
  return {
    ok: false,
    caseId: input.caseId,
    ...(input.orderId ? { orderId: input.orderId } : {}),
    ...input.extra,
    ...(safeguarded ? { canarySafeguarded: true } : {}),
    failureCodes: [input.failureCode],
  };
}
