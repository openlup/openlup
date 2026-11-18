/** @experimental Informational catalogue entries owned by inventory. */
export const inventorySettingBoundaries: readonly (readonly [key: string, kind: "cap" | "invariant", goal: string, reason: string])[] = [
  ["safetyStock", "cap", "Set safety stock and channel exposure in available-to-promise calculations.", "Native available-to-promise currently uses zero safety stock and no channel allocation."],
  ["reservationReplayExpiry", "invariant", "Preserve the original reservation expiry on replay.", "A replay returns the existing hold without changing stock allocation or expiry."],
];
