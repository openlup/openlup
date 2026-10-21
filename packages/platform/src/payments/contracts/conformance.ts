import type { PaymentAdapterCapabilities, PaymentAttemptPort, PaymentExecutionEnvelope } from "./adapter.js";
import type { PaymentAbsenceEnvelope, PaymentReadbackEnvelope, PaymentVerifyNormalizePort } from "./evidence.js";

/** A fixture binds its own identity, adapter and inputs; scenarios accept multiple subjects. */
export interface PaymentAdapterConformanceSubject {
  subjectId: string;
  capabilities: PaymentAdapterCapabilities;
  attemptPort: PaymentAttemptPort;
  verifyPort: PaymentVerifyNormalizePort;
  executionInput: Parameters<PaymentAttemptPort["execute"]>[0];
  readback(): Promise<PaymentReadbackEnvelope>;
  absence(): Promise<PaymentAbsenceEnvelope>;
}

/** Runner-independent observations; never include transient input or raw diagnostics. */
export interface PaymentAdapterConformanceEvidence {
  subjects: readonly {
    subjectId: string;
    execution: Omit<PaymentExecutionEnvelope, "handoff">;
    readback: PaymentReadbackEnvelope & { handoff?: never };
    absence: PaymentAbsenceEnvelope;
  }[];
  cases: readonly { subjectIds: readonly string[]; name: string; passed: boolean }[];
}
