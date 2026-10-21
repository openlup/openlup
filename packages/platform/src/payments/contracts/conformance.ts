import type { PaymentAdapter, PaymentAttemptPort, PaymentExecutionEnvelope } from "./adapter.js";
import type { PaymentAbsenceEnvelope, PaymentAbsencePort, PaymentReadbackEnvelope, PaymentReadbackPort } from "./evidence.js";

/** A fixture binds its own identity, adapter ports and inputs; scenarios accept multiple subjects. */
export interface PaymentAdapterConformanceSubject {
  subjectId: string;
  adapter: PaymentAdapter;
  executionInput: Parameters<PaymentAttemptPort["execute"]>[0];
  readbackInput: Parameters<PaymentReadbackPort["readPayment"]>[0];
  /** Required when the adapter supplies an absence port. */
  absenceInput?: Parameters<PaymentAbsencePort["proveAbsence"]>[0];
}

/** Runner-independent observations; never include transient input or raw diagnostics. */
export interface PaymentAdapterConformanceEvidence {
  subjects: readonly {
    subjectId: string;
    execution: Omit<PaymentExecutionEnvelope, "handoff">;
    readback: PaymentReadbackEnvelope & { handoff?: never };
    absence?: PaymentAbsenceEnvelope;
  }[];
  cases: readonly { subjectIds: readonly string[]; name: string; passed: boolean }[];
}
