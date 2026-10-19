import type { AuthEmailTransportPort, AuthEmailTransportResult } from "./contracts/authEmail.js";
import type { EmailMessage, EmailSendResult, EmailTransport } from "./emailTransport.js";

export interface EmailEgressContext {
  mode: "production" | "sandbox_direct" | "sandbox_sink";
  reason: string;
  intendedRecipient: string;
  recipient: string;
  /** Selected by the host; consumed only by its concrete sender, never logged. */
  credential: string;
  environmentTag: "production" | "non_production";
}

export type EmailEgressDecision = EmailEgressContext | { mode: "drop"; reason: string } | { mode: "blocked"; reason: string };
export type EmailEgressPolicy = (intendedRecipient: string) => EmailEgressDecision | Promise<EmailEgressDecision>;

const admitted = new WeakSet<EmailTransport>();
const admittedAuth = new WeakSet<AuthEmailTransportPort>();

/**
 * Host composition bridge for an implementation that already enforces egress
 * internally. This is a trust boundary: its sender must itself refuse unknown
 * policy before effects. New network adapters should use createGuardedEmailTransport.
 * Neither a provider name nor an object property establishes admission.
 */
export function admitPolicyEnforcedEmailTransport<T extends EmailTransport>(transport: T): T {
  admitted.add(transport);
  return transport;
}

/** Mandatory boundary for supported injected transports; raw objects fail closed. */
export function guardEmailTransport(transport: EmailTransport): EmailTransport {
  if (admitted.has(transport)) return transport;
  return { providerKind: transport.providerKind, send: async () => refused("email_egress_unadmitted") };
}

/** Construct a network adapter whose sender sees only a validated host decision. */
export function createGuardedEmailTransport(input: {
  providerKind: string;
  policy: EmailEgressPolicy;
  send: (message: EmailMessage, context: Readonly<EmailEgressContext>) => Promise<EmailSendResult>;
}): EmailTransport {
  return admitPolicyEnforcedEmailTransport({
    providerKind: input.providerKind,
    async send(message) {
      let decision: unknown;
      try { decision = await input.policy(message.to); }
      catch { return refused("email_egress_policy_unavailable"); }
      if (!validDecision(decision, message.to)) return refused("email_egress_policy_invalid");
      if (decision.mode === "blocked") return refused("email_egress_blocked", decision.reason);
      if (decision.mode === "drop") return {
        outcome: { ok: true, resendId: null, httpStatus: 0, providerError: null, aborted: false,
          suppressed: "drop", egressMode: "drop", egressReason: decision.reason },
        providerResponse: { suppressed: "drop", egress_reason: decision.reason },
      };
      const context = Object.freeze({ ...decision });
      const result = await input.send({ ...message, to: context.recipient }, context);
      return { ...result, outcome: { ...result.outcome, egressMode: context.mode, egressReason: context.reason } };
    },
  });
}

function validDecision(value: unknown, intended: string): value is EmailEgressDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  // Policy diagnostics are bounded codes, never arbitrary exception/secret text.
  if (typeof d.reason !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(d.reason)) return false;
  if (d.mode === "drop" || d.mode === "blocked") return Object.keys(d).every((key) => key === "mode" || key === "reason");
  if (d.mode !== "production" && d.mode !== "sandbox_direct" && d.mode !== "sandbox_sink") return false;
  if (!Object.keys(d).every((key) => ["mode", "reason", "intendedRecipient", "recipient", "credential", "environmentTag"].includes(key))) return false;
  if (!mailbox(intended) || d.intendedRecipient !== intended || !mailbox(d.recipient)) return false;
  if (d.mode !== "sandbox_sink" && d.recipient !== intended) return false;
  if (typeof d.credential !== "string" || !d.credential.trim()) return false;
  return d.environmentTag === (d.mode === "production" ? "production" : "non_production");
}

function mailbox(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value);
}

function refused(code: string, reason?: string): EmailSendResult {
  return { outcome: { ok: false, resendId: null, httpStatus: 0, providerError: code, aborted: false,
    ...(reason ? { egressReason: reason } : {}) }, providerResponse: { egress_reason: code } };
}

/** Preserve the Auth envelope/result mapping while retaining package admission. */
export function createAuthEmailTransport(transport: EmailTransport): AuthEmailTransportPort {
  const guarded = guardEmailTransport(transport);
  const auth: AuthEmailTransportPort = {
    providerKind: transport.providerKind,
    async send(message) {
      const result = await guarded.send({ from: message.sender, to: message.recipient,
        subject: message.subject, html: message.html, text: message.text });
      return { outcome: { ...result.outcome, messageId: result.outcome.resendId }, providerResponse: result.providerResponse };
    },
  };
  admittedAuth.add(auth);
  return auth;
}

/** Raw Auth closures must compose through the admitted email transport bridge. */
export function guardAuthEmailTransport(transport: AuthEmailTransportPort): AuthEmailTransportPort {
  if (admittedAuth.has(transport)) return transport;
  return {
    providerKind: transport.providerKind,
    async send(): Promise<AuthEmailTransportResult> {
      const result = refused("email_egress_unadmitted");
      return { outcome: { ...result.outcome, messageId: null }, providerResponse: result.providerResponse };
    },
  };
}
