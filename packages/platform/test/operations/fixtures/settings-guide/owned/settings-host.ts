// The relative import resolves after you create the application file above.
import type { SettingsFileEntry } from "@openlup/platform/operations/server";
import { gift } from "./gift.config.ts";

const entries = {
  "gift.wrapFeeMinor": {
    value: gift.wrapFeeMinor,
    location: { file: "owned/gift.config.ts", symbol: "gift.wrapFeeMinor" },
    descriptor: {
      domain: "gift", goal: "Set the gift wrapping fee in minor units.",
      effect: { appliesTo: "New gift quotes use this fee after deployment.", impact: "money", frozenOn: [] },
    },
  } satisfies SettingsFileEntry,
};

export function createSettingsBindings(): import("@openlup/platform/operations/server").SettingsAppBindings {
  return { file: { configuration: "sample", entries } };
}
