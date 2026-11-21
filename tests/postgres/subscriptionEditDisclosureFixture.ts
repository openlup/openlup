import type { SubscriptionEditDisclosure, SubscriptionEditRecurringTerms } from "@openlup/platform/subscriptions/contracts";

const evidence = { owner: "fixture-terms", version: "1", digest: "a".repeat(64) };
export const disclosurePresentation: SubscriptionEditDisclosure["presentation"] = {
  version: "1", locale: "en-US", labels: { title: "Review changes", agreed: "Agreed terms", proposed: "Proposed terms",
    effectiveCycle: "Effective cycle", cadence: "Billing frequency", confirmation: "Accept changes" },
};
export function disclosureOwner(days: number, agreedMinor: number, proposedMinor: number) {
  function terms(amountMinor: number): SubscriptionEditRecurringTerms {
    return {
      cadence: { days, evidence },
      payment: { kind: "payable", label: "Recurring payment", amount: { amountMinor, currency: "XXX", basis: "tax_inclusive" }, evidence },
    };
  }
  return { agreedUnitBasis: () => ({ basis: "tax_inclusive" as const, evidence }), agreed: terms(agreedMinor), proposed: terms(proposedMinor),
    cycleNumber: 2, cycleEvidence: evidence, labelLine: ({ isAddon }: { isAddon: boolean }) => isAddon ? "Extra refill" : "Refill" };
}
