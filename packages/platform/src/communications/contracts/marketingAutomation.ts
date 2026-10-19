/** Scope is selected by the host. Remote account state is never local consent authority. */
export interface MarketingAutomationScope {
  readonly bindingId: string;
  readonly accountReference: string;
  readonly audienceReference: string;
}
export interface MarketingAutomationClaim {
  readonly scope: MarketingAutomationScope;
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly claimToken: string;
  readonly generation: number;
  readonly deadlineMs: number;
  readonly attempt: number;
  /** Opaque host reference; no email, profile attributes, tokens or payload bodies. */
  readonly subjectReference: string;
}
export type MarketingAutomationObservation = {
  readonly effectId: string;
  readonly generation: number;
  readonly observedAtMs: number;
} & (
  | { readonly status: "accepted"; readonly remoteReference: string }
  | { readonly status: "ambiguous"; readonly retryAfterMs: number }
  | { readonly status: "throttled"; readonly retryAfterMs: number }
  | { readonly status: "refused"; readonly reason: "restricted" | "unsupported" | "deadline" | "scope" }
);
export interface MarketingAutomationProviderPort {
  readonly scope: MarketingAutomationScope;
  /** Admission is explicit and short lived; scope, deadline and idempotency fences apply at effect time too. */
  admit(claim: MarketingAutomationClaim, nowMs: number): Promise<"admitted" | "refused">;
  /** Acknowledgement needs an observation; acceptance does not mean delivery or grant consent. */
  apply(claim: MarketingAutomationClaim, nowMs: number): Promise<MarketingAutomationObservation>;
  /** Reconcile ambiguity before retrying an effect that might already have been accepted. */
  observe(claim: MarketingAutomationClaim, nowMs: number): Promise<MarketingAutomationObservation | null>;
}
export interface MarketingAutomationStorePort {
  /** Unsupported/no-trigger work is not claimed. No runner or schedule is installed by this contract. */
  claim(scope: MarketingAutomationScope, nowMs: number): Promise<MarketingAutomationClaim | null>;
  /** Atomic scope + current token + generation + deadline check before provider admission. */
  isCurrent(claim: MarketingAutomationClaim, nowMs: number): Promise<boolean>;
  /** Persist observation/history with the same fences; stale workers cannot settle newer work. */
  settle(claim: MarketingAutomationClaim, observation: MarketingAutomationObservation, nowMs: number): Promise<boolean>;
  history(scope: MarketingAutomationScope, effectId: string): Promise<readonly MarketingAutomationObservation[]>;
}
