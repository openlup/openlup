import { useMemo } from "react";

import type { ConfiguratorFormData } from "./configuratorFormStore";
import {
  resolveConfiguratorPackageQuantities,
  type ConfiguratorPackageQuantityOptions,
} from "./configuratorPackageQuantities";

/** Referentially stable effective package for quote-driven React surfaces. */
export function useEffectiveConfiguratorPackage(
  data: ConfiguratorFormData,
  _subscription = data.subscription,
) {
  const baselineSnapshot = data.recommendationSnapshot;
  const stockBounded = true;
  const quantityOptions = useMemo<ConfiguratorPackageQuantityOptions>(
    () => ({
      stockBounded,
    }),
    [stockBounded],
  );
  const quantityState = useMemo(
    () => baselineSnapshot
      ? resolveConfiguratorPackageQuantities(
          baselineSnapshot,
          data.packageQuantityOverrides,
          quantityOptions,
        )
      : null,
    [baselineSnapshot, data.packageQuantityOverrides, quantityOptions],
  );

  return {
    baselineSnapshot,
    quantityOptions,
    quantityState,
    snapshot: quantityState?.snapshot ?? null,
  };
}
