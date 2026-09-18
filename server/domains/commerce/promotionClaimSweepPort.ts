export interface PromotionClaimSweepCounts {
  checked: number;
  cancelled: number;
  skipped: number;
}

export interface PromotionClaimSweepPort {
  sweep(input: {
    now: string;
    limit: number;
    claimLeaseMinutes: number;
    graceMinutes: number;
  }): Promise<PromotionClaimSweepCounts>;
}

export function parsePromotionClaimSweepCounts(value: unknown): PromotionClaimSweepCounts {
  const result = value as Partial<PromotionClaimSweepCounts> | null;
  if (!result || !Number.isInteger(result.checked) || !Number.isInteger(result.cancelled)
    || !Number.isInteger(result.skipped)) {
    throw new Error("promotion_claim_sweep_invalid_response");
  }
  return result as PromotionClaimSweepCounts;
}
