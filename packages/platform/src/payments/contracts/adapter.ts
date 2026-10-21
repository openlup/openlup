import type {
  PaymentExecutionAttemptStatus,
  PaymentFailureClass,
  PaymentFailureHint,
  PaymentProviderCapabilityDescriptor,
  PaymentRetryAdviceCode,
  StoredMandateSnapshot,
} from "@openlup/core/payment";
import type { PaymentAbsencePort, PaymentReadbackPort, PaymentVerifyNormalizePort } from "./evidence.js";

declare const transientSecret: unique symbol;

/**
 * One-time customer authorization or opaque client handoff, held only in memory.
 * Never persist, log, fingerprint, or include in request/response diagnostics.
 * The host brands a value only at the transient client/server input boundary.
 */
export type TransientSecret = string & { readonly [transientSecret]: true };

/** Hosted navigation or client confirmation; opaque payloads are transient only. */
export type PaymentMethodHandoff =
  | { kind: "redirect"; url: string }
  | { kind: "client-confirmed"; payload: TransientSecret };

/** Only core neutral taxonomy crosses the adapter boundary; no provider prose. */
export interface PaymentRefusalEnvelope {
  code: PaymentFailureClass;
  hints: readonly PaymentFailureHint[];
  adviceCode?: PaymentRetryAdviceCode;
}

/**
 * A non-terminal attempt or synchronous decline; terminal money is evidence-owned.
 * Diagnostics must exclude transient secrets, handoff payloads, raw bodies and
 * provider prose. Persist only explicitly redacted request/response diagnostics.
 */
export interface PaymentExecutionEnvelope {
  outcome:
    | { kind: "attempt"; status: PaymentExecutionAttemptStatus }
    | { kind: "decline"; refusal: PaymentRefusalEnvelope };
  dispatch:
    | { kind: "dispatched"; providerPaymentRef: string }
    | { kind: "notDispatched"; evidence: { exact: true; phase: "before-dispatch"; reason: PaymentRefusalEnvelope } }
    | { kind: "unknown" };
  handoff?: PaymentMethodHandoff;
  diagnostics: Readonly<Record<string, string | number | boolean | null>>;
}

/** Host identity/key/fingerprint and configured integer-minor money pass verbatim.
 * Missing adapter-required input must refuse before dispatch with exact
 * notDispatched evidence (phase before-dispatch), never unknown or dispatched.
 */
export interface PaymentAttemptPort {
  validateInput(input: {
    attemptRef: string;
    intentRef: string;
    fingerprint: string;
    providerIdempotencyKey: string;
    money: { amountMinor: number; currency: string };
    mode: "live" | "test";
    purpose: "initial" | "renewal-unattended" | "recovery";
    methodSelection?: { family: "card" | "wallet" | "bank-redirect" | "one-time-code"; channelRef?: string };
    /** Transient dispatch input only; never persist, audit, log or diagnose. */
    payer?: { email: string; name?: string };
    storedMethod?: { reference: string; mandate: StoredMandateSnapshot };
    /** Client-entered, server-submitted authorization; never persisted or echoed. */
    customerAuthorization?: TransientSecret;
  }): void;
  execute(input: Parameters<PaymentAttemptPort["validateInput"]>[0]): Promise<PaymentExecutionEnvelope>;
}

/** Platform overlay; the shared core descriptor remains unchanged. */
export interface PaymentAdapterCapabilities extends Omit<PaymentProviderCapabilityDescriptor, "captureFlows"> {
  captureFlows: readonly {
    kind: string;
    handoff: PaymentMethodHandoff["kind"] | "customer-authorization";
    methodFamilies: readonly ("card" | "wallet" | "bank-redirect" | "one-time-code")[];
  }[];
  supportedCurrencies: readonly string[];
  unattended: "supported" | "unsupported";
  readback: "supported" | "unsupported";
  close: "supported" | "unsupported";
  exactAbsence: "supported" | "unsupported";
  refundObservation: "supported" | "unsupported";
  refundCreate: "unsupported";
  authorizationCaptureSplit: "unsupported";
}

/** The neutral bundle an adapter factory returns; optional ports match declared capabilities. */
export interface PaymentAdapter {
  capabilities: PaymentAdapterCapabilities;
  attemptPort: PaymentAttemptPort;
  verifyPort: PaymentVerifyNormalizePort;
  readbackPort: PaymentReadbackPort;
  absencePort?: PaymentAbsencePort;
}
