export interface StarterTermsDecision {
    intervalDays: number;
    steadyCadenceDays: number;
    steadyUnits: number;
    graduationSizeConstraint?: Record<string, unknown>;
}

export type StarterTermsRefusal = "basket_too_small" | "basket_not_admitted" | "demand_unknown";

export type StarterTermsResolution =
  | { kind: "terms"; terms: StarterTermsDecision }
  | { kind: "refused"; reason: StarterTermsRefusal };

export interface StarterTermsInput<Intent, Snapshot> {
  intent: Intent;
    authoritativeQuote: Snapshot;
    offerVersion?: string;
}

export interface StarterTermsPort<Intent, Snapshot> {
  resolve(input: StarterTermsInput<Intent, Snapshot>): Promise<StarterTermsResolution>;
}
