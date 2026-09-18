import type {
  CommunicationPermissionState,
  CommunicationPurpose,
} from "./types.js";

export type CommunicationRecipientKind =
  | "external_contact"
  | "tester"
  | "customer"
  | "lead"
  | "admin_internal";

export interface CommunicationPermissionSnapshot {
  state: CommunicationPermissionState | null;
  source?: string | null;
  legacySequencePaused?: boolean | null;
}

export interface CommunicationPolicyInput {
  purpose: CommunicationPurpose;
  recipientKind: CommunicationRecipientKind;
  permission: CommunicationPermissionSnapshot | null;
}

export interface CommunicationPolicyResult {
  decision: "allowed" | "blocked";
  reason: string;
}

const MARKETING_PURPOSES = new Set<CommunicationPurpose>([
  "marketing_launch_offer",
  "marketing_newsletter",
]);

export function evaluateCommunicationPolicy(
  input: CommunicationPolicyInput,
): CommunicationPolicyResult {
  const state = input.permission?.state ?? "unknown";

  if (input.purpose === "admin_notification") {
    return { decision: "allowed", reason: "admin_notification" };
  }

  if (input.purpose === "transactional" || input.purpose === "subscription_dunning") {
    return { decision: "allowed", reason: "purpose_allowed_without_marketing_consent" };
  }

  if (input.purpose === "tester_program") {
    if (input.permission?.legacySequencePaused) {
      return { decision: "blocked", reason: "sequence_paused" };
    }
    if (state === "denied" || state === "suppressed") {
      return { decision: "blocked", reason: `permission_${state}` };
    }
    if (state !== "granted") {
      return { decision: "blocked", reason: "missing_tester_program_permission" };
    }
    return { decision: "allowed", reason: "tester_program_granted" };
  }

  if (MARKETING_PURPOSES.has(input.purpose)) {
    if (state === "suppressed") {
      return { decision: "blocked", reason: "permission_suppressed" };
    }
    if (state !== "granted") {
      return { decision: "blocked", reason: "missing_marketing_permission" };
    }
    return { decision: "allowed", reason: "marketing_permission_granted" };
  }

  return { decision: "blocked", reason: "unsupported_purpose" };
}

export function consentStateFromBoolean(value: boolean | null | undefined): CommunicationPermissionState {
  return value === true ? "granted" : "denied";
}
