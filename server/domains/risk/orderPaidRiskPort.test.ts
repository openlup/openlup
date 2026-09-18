import { describe, expect, it, vi } from "vitest";

import type {
  RiskAssessmentWritePort,
  RiskCheckoutBlocklistPort,
} from "../../../src/domains/risk/ports.js";
import {
  createOrderPaidRiskAssessmentPort,
  type RiskPaidOrderEvidencePort,
} from "./orderPaidRiskPort.js";

function dependencies() {
  const evidencePort: RiskPaidOrderEvidencePort = {
    readOrder: vi.fn(async () => null),
    readSucceededPaymentIntent: vi.fn(async () => null),
  };
  const assessmentPort: RiskAssessmentWritePort = {
    assessPaidOrder: vi.fn(),
  };
  const blocklistPort: RiskCheckoutBlocklistPort = {
    checkExactBlocklist: vi.fn(async () => ({ blocked: false, reasonCodes: [] })),
  };
  return { evidencePort, assessmentPort, blocklistPort };
}

describe("order-paid risk assessment", () => {
  it("returns retryable without touching dependencies when already aborted", async () => {
    const deps = dependencies();
    const port = createOrderPaidRiskAssessmentPort({ ...deps, mode: "shadow" });

    await expect(port.assessPaidOrder({
      orderUuid: "order-1",
      outboxEventId: "event-1",
      signal: AbortSignal.abort(),
    })).resolves.toEqual({ kind: "retryable", reason: "risk_assessment_timeout" });
    expect(deps.evidencePort.readOrder).not.toHaveBeenCalled();
    expect(deps.assessmentPort.assessPaidOrder).not.toHaveBeenCalled();
  });

  it("classifies a missing durable order as fatal and never persists", async () => {
    const deps = dependencies();
    const port = createOrderPaidRiskAssessmentPort({ ...deps, mode: "hold" });

    await expect(port.assessPaidOrder({
      orderUuid: "order-missing",
      outboxEventId: "event-2",
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: "fatal", reason: "risk_order_not_found" });
    expect(deps.evidencePort.readSucceededPaymentIntent).not.toHaveBeenCalled();
    expect(deps.assessmentPort.assessPaidOrder).not.toHaveBeenCalled();
  });
});
