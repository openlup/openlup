export type OssReadinessPolicyEvent = {
  kind: "oss_readiness_policy_failure";
  code: string;
  family: string;
  category?: string;
  baseline?: number;
  current?: number;
  headroom?: number;
  /**
   * Which ceiling the breach was judged against. Absent means the pinned baseline, which
   * is the only reference that existed before W-P2a. Deliberately a FIELD rather than a
   * second `code`: the fact is the same — a ceiling was exceeded — and every consumer
   * that greps for `semantic_headroom_exceeded` keeps working. The scheduled ratchet
   * sweep is one such consumer, and a new code would have demoted a real breach there to
   * "could not produce a safe patch".
   */
  reference?: "pinned-baseline" | "merge-base-measurement";
  offenders?: string[];
  message: string;
};

export function ossReadinessPolicyEvent(error: string): OssReadinessPolicyEvent | null {
  let match = error.match(/^([^:]+): (brand|country|currency|timezone|product-category|provider) current count (\d+) exceeds baseline (\d+) plus headroom (\d+)$/);
  if (match) {
    return {
      kind: "oss_readiness_policy_failure", code: "semantic_headroom_exceeded",
      family: match[1], category: match[2], current: Number(match[3]),
      baseline: Number(match[4]), headroom: Number(match[5]), message: error,
    };
  }
  match = error.match(/^([^:]+): (brand|country|currency|timezone|product-category|provider) current count (\d+) exceeds merge-base measurement (\d+) plus headroom (\d+); the pinned baseline (\d+) is stale above the tree and buys no room$/);
  if (match) {
    return {
      kind: "oss_readiness_policy_failure", code: "semantic_headroom_exceeded",
      family: match[1], category: match[2], current: Number(match[3]),
      baseline: Number(match[4]), headroom: Number(match[5]),
      reference: "merge-base-measurement", message: error,
    };
  }
  match = error.match(/^([^:]+): (brand|country|currency|timezone|product-category|provider) baseline (\d+) is stale above current count (\d+); re-pin the baseline down to \d+$/);
  if (match) {
    return {
      kind: "oss_readiness_policy_failure", code: "semantic_baseline_stale",
      family: match[1], category: match[2], baseline: Number(match[3]),
      current: Number(match[4]), message: error,
    };
  }
  match = error.match(/^([^:]+): (?:tracked|selected) path count (\d+) differs from frozen (\d+)$/);
  if (match) {
    return {
      kind: "oss_readiness_policy_failure", code: "frozen_inventory_count_mismatch",
      family: match[1], current: Number(match[2]), baseline: Number(match[3]), message: error,
    };
  }
  match = error.match(/^([^:]+): (?:tracked|selected) path digest differs from frozen inventory$/);
  if (match) {
    return {
      kind: "oss_readiness_policy_failure", code: "frozen_inventory_digest_mismatch",
      family: match[1], message: error,
    };
  }
  match = error.match(/^(.+): unknown (?:root file|top-level root|file kind)$/);
  if (match) {
    return {
      kind: "oss_readiness_policy_failure", code: "unclassified_path",
      family: "surfaceFamilies", offenders: [match[1]], message: error,
    };
  }
  match = error.match(/^([^:]+): (?:stale (?:selector|exclusion|root-file selector|generic-shell selector|allowance)|generic platform shell|production path is not in a surface family|overlapping surface families)/);
  if (match) {
    return {
      kind: "oss_readiness_policy_failure", code: "surface_policy_mismatch",
      family: match[1], message: error,
    };
  }
  if (/^surfaceFamilies: production\/closed partition does not equal tracked files$/.test(error)) {
    return {
      kind: "oss_readiness_policy_failure", code: "surface_partition_mismatch",
      family: "surfaceFamilies", message: error,
    };
  }
  return null;
}
